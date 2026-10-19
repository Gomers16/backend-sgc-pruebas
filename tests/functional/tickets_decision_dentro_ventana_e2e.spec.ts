import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import TurnoRtm from '#models/turno_rtm'
import Comision from '#models/comision'
import FacturacionTicket from '#models/facturacion_ticket'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'
import RepGeneralImportController from '#controllers/rep_general_imports_controller'

/**
 * La decisión de comisión se toma SIEMPRE, también dentro de ventana:
 *  - Casos 1, 2 y 3 con "sin comisión" dentro de ventana, en camino directo
 *    (Facturación ya confirmada), diferido (se confirma después) y en el
 *    recálculo del Rep General
 *  - body vacío dentro de ventana (frontend anterior) = comisión completa
 *  - combinaciones imposibles → 400 también dentro de ventana
 *  - aprobados antes (dentro de ventana sin flags) siguen contando como "con"
 */

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN = 9
const ZONA = 'America/Bogota'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

type CasoTicket = 'SIN_CONVENIO' | 'CONVENIO_SELF' | 'CONVENIO_COMERCIAL'
type Camino = 'directo' | 'diferido' | 'rep_general'

// Placas AAA999 (confirmar() las valida).
const PLACAS: Record<string, string> = {
  'SIN_CONVENIO|directo': 'TKV501',
  'SIN_CONVENIO|diferido': 'TKV502',
  'SIN_CONVENIO|rep_general': 'TKV503',
  'CONVENIO_SELF|directo': 'TKV504',
  'CONVENIO_SELF|diferido': 'TKV505',
  'CONVENIO_SELF|rep_general': 'TKV506',
  'CONVENIO_COMERCIAL|directo': 'TKV507',
  'CONVENIO_COMERCIAL|diferido': 'TKV508',
  'CONVENIO_COMERCIAL|rep_general': 'TKV509',
  'VACIO|SIN_CONVENIO': 'TKV510',
  'VACIO|CONVENIO_SELF': 'TKV511',
  'VACIO|CONVENIO_COMERCIAL': 'TKV512',
  'MAL': 'TKV513',
  'MAL_CASO2': 'TKV516',
  'VIEJO': 'TKV514',
  'FUERA_VACIO': 'TKV515',
}

/** Decisión "sin comisión" que se prueba en cada caso. */
const SIN: Record<
  CasoTicket,
  { body: Record<string, boolean>; asesor: boolean; convenio: boolean | null }
> = {
  SIN_CONVENIO: { body: { con_comision_asesor: false }, asesor: false, convenio: null },
  CONVENIO_SELF: {
    body: { con_comision_asesor: false, con_comision_convenio: false },
    asesor: false,
    convenio: false,
  },
  CONVENIO_COMERCIAL: {
    body: { con_comision_asesor: true, con_comision_convenio: false },
    asesor: true,
    convenio: false,
  },
}

test.group('Tickets · decisión de comisión dentro de ventana', (group) => {
  group.each.timeout(60_000)

  let usuario: Usuario
  let token: string
  let comercial: AgenteCaptacion
  let asesorConvenio: AgenteCaptacion
  let convenio: Convenio
  let asignacion: AsesorConvenioAsignacion
  let configIncentivo: Comision
  let imagenPath: string
  const subidas: string[] = []
  const factIds: number[] = []
  let numero = 0

  const ahora = () => DateTime.now().setZone(ZONA)
  const auth = () => ({ Authorization: `Bearer ${token}` })

  async function esperar(peticion: Promise<any>, status: number) {
    const r = await peticion
    r.assertStatus(status)
    return r
  }

  /** Turno de hoy que entró hace 5 minutos (dentro de ventana) o a las 00:01 (fuera). */
  async function turno(placa: string, dentro = true) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuario.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: ahora(),
      horaIngreso: dentro ? ahora().minus({ minutes: 5 }).toFormat('HH:mm') : '00:01',
      horaSalida: null,
      tieneFacturacion: false,
      turnoNumero: 985000 + numero,
      turnoNumeroServicio: 985000 + numero,
      turnoCodigo: `TST-TKV-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      esSegundaVez: false,
    } as any)
  }

  async function facturacion(turnoId: number, placa: string, estado: string) {
    const f = await FacturacionTicket.create({
      hash: `TEST-HASH-TKV-${placa}-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado,
      turnoId,
      placa,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      total: 50000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
    } as any)
    factIds.push(f.id)
    return f
  }

  async function subir(client: any) {
    const r = await esperar(
      client.post('/api/media/upload').headers(auth()).file('file', imagenPath),
      201
    )
    subidas.push(r.body().url)
    return r.body().url as string
  }

  async function crearTicket(client: any, turnoId: number, caso: CasoTicket) {
    const agente = caso === 'CONVENIO_SELF' ? asesorConvenio : comercial
    const intento: Record<string, unknown> = {}
    if (caso === 'SIN_CONVENIO') intento.canal = 'ASESOR_COMERCIAL'
    if (caso === 'CONVENIO_COMERCIAL') {
      intento.canal = 'ASESOR_COMERCIAL'
      intento.convenio_id = convenio.id
    }
    const r = await esperar(
      client
        .post('/api/tickets-excepcion-dateo')
        .headers(auth())
        .json({
          turno_id: turnoId,
          comercial_id: agente.id,
          observacion: 'Decisión dentro de ventana',
          evidencia_chat_url: await subir(client),
          evidencia_grupo_whatsapp_url: await subir(client),
          evidencia_bloqueo_url: await subir(client),
          ...intento,
        }),
      201
    )
    return {
      ticketId: r.body().ticket.id as number,
      dentro: Boolean(r.body().detalle.dentroVentana),
    }
  }

  const aprobar = (client: any, ticketId: number, body: object) =>
    client.patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`).headers(auth()).json(body)

  async function decisionEnBandeja(client: any, placa: string) {
    const r = await esperar(client.get(`/api/tickets?placa=${placa}`).headers(auth()), 200)
    return r.body().data[0]?.resumen?.decisionComision as string | undefined
  }

  /** Montos forzados a $0 según la decisión, y foto del valor calculado guardada. */
  async function assertDecisionAplicada(
    assert: any,
    ticketId: number,
    c: Comision,
    caso: CasoTicket
  ) {
    const esperado = SIN[caso]
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    assert.equal(Boolean(d.conComisionAsesor), esperado.asesor)
    if (esperado.convenio === null) assert.isNull(d.conComisionConvenio)
    else assert.equal(Boolean(d.conComisionConvenio), esperado.convenio)
    assert.equal(Boolean(d.conComision), esperado.asesor, 'con_comision = flag del asesor')

    if (!esperado.asesor) assert.equal(Number(c.montoAsesor), 0, 'asesor en $0')
    if (esperado.convenio === false) assert.equal(Number(c.montoConvenio), 0, 'convenio en $0')
    // Foto: lo que se dejó de pagar (antes de forzar a $0).
    assert.isNotNull(d.montoAsesorCalculado)
    if (!esperado.asesor) assert.isAbove(Number(d.montoAsesorCalculado), 0)
    if (esperado.convenio === false && caso === 'CONVENIO_COMERCIAL') {
      assert.isAbove(Number(d.montoConvenioCalculado), 0)
    }
  }

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'TK-DENTRO-VENTANA',
      correo: `test.tk.dentro.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuario)
    token = tokenObj.value!.release()

    const sufijo = Date.now().toString(36).toUpperCase()
    comercial = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKV COMERCIAL ${sufijo}`,
    } as any)
    asesorConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKV CONVENIO ${sufijo}`,
    } as any)
    convenio = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKV CONVENIO ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    asignacion = await AsesorConvenioAsignacion.create({
      asesorId: comercial.id,
      convenioId: convenio.id,
      activo: true,
      fechaFin: null,
    } as any)
    // Caso 2 paga el `base` del asesor convenio: sin esto el global puede ser $0.
    configIncentivo = await Comision.create({
      esConfig: true,
      asesorId: asesorConvenio.id,
      tipoVehiculo: null,
      base: '15000',
      estado: 'PENDIENTE',
    } as any)

    imagenPath = app.tmpPath(`tst_tk_dentro_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    const placas = Object.values(PLACAS)
    const marks = placas.map(() => '?').join(',')
    const filas = await Database.from('turnos_rtms').whereIn('placa', placas).select('id')
    const turnoIds = filas.map((r: any) => r.id)
    if (turnoIds.length) {
      const detalles = await Database.from('tickets_detalle_excepcion_dateo')
        .whereIn('turno_id', turnoIds)
        .select('ticket_id')
      const ticketIds = detalles.map((d: any) => d.ticket_id)
      await Database.from('tickets_detalle_excepcion_dateo').whereIn('turno_id', turnoIds).delete()
      if (ticketIds.length) await Database.from('tickets').whereIn('id', ticketIds).delete()
    }
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE es_config = 0 AND captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${marks}))`,
      placas
    )
    if (factIds.length) await Database.from('facturacion_tickets').whereIn('id', factIds).delete()
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    for (const url of subidas) {
      await fs.unlink(app.makePath(url.replace(/^\/api\//, ''))).catch(() => {})
    }
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    await asignacion.delete()
    await configIncentivo.delete()
    await convenio.delete()
    await comercial.delete()
    await asesorConvenio.delete()
    await usuario.delete()
  })

  // ───────────── "Sin comisión" dentro de ventana: 3 casos × 3 caminos ─────────────
  for (const caso of ['SIN_CONVENIO', 'CONVENIO_SELF', 'CONVENIO_COMERCIAL'] as const) {
    for (const camino of ['directo', 'diferido', 'rep_general'] as Camino[]) {
      test(`${caso} · ${camino} · "sin comisión" dentro de ventana se aplica`, async ({
        client,
        assert,
      }) => {
        const placa = PLACAS[`${caso}|${camino}`]
        const t = await turno(placa)
        const fact = await facturacion(
          t.id,
          placa,
          camino === 'diferido' ? 'LISTA_CONFIRMAR' : 'CONFIRMADA'
        )
        const { ticketId, dentro } = await crearTicket(client, t.id, caso)
        assert.isTrue(dentro, 'el turno entró hace 5 minutos')

        const r = await esperar(aprobar(client, ticketId, SIN[caso].body), 200)
        assert.equal(r.body().caso, caso)
        assert.isTrue(r.body().dentroVentana)

        if (camino === 'diferido') {
          assert.isNull(r.body().comisionId, 'sin facturación confirmada todavía no hay comisión')
          await esperar(
            client.post(`/api/facturacion/tickets/${fact.id}/confirmar`).headers(auth()).json({}),
            200
          )
        }
        const c = await Comision.query()
          .where('captacion_dateo_id', r.body().dateoId)
          .where('es_config', false)
          .firstOrFail()

        if (camino === 'rep_general') {
          const turnoActual = await TurnoRtm.findOrFail(t.id)
          await (new RepGeneralImportController() as any).recalcularComisionSiExiste(
            turnoActual.captacionDateoId,
            {
              esRecurrente: true,
              esRecuperacion: false,
              mesesDesdeUltimaVisita: 3,
              ultimoTurnoId: null,
              fechaUltimaVisita: null,
              estadoContinuidad: null,
            },
            'Liviano Particular'
          )
          await c.refresh()
          const turnoTras = await TurnoRtm.findOrFail(t.id)
          assert.isTrue(Boolean(turnoTras.esRecurrente), 'la reclasificación sí se aplica')
        }

        await assertDecisionAplicada(assert, ticketId, c, caso)

        // La decisión manda sobre la ventana en la bandeja/estadísticas.
        const esperada =
          caso === 'CONVENIO_COMERCIAL'
            ? 'sin_convenio'
            : caso === 'SIN_CONVENIO'
              ? 'sin_asesor'
              : 'sin_ninguno'
        assert.equal(await decisionEnBandeja(client, placa), esperada)
      })
    }
  }

  // ───────────── Body vacío dentro de ventana (frontend anterior) ─────────────
  for (const caso of ['SIN_CONVENIO', 'CONVENIO_SELF', 'CONVENIO_COMERCIAL'] as const) {
    test(`${caso} · body vacío dentro de ventana = comisión completa, guardada como decisión`, async ({
      client,
      assert,
    }) => {
      const placa = PLACAS[`VACIO|${caso}`]
      const t = await turno(placa)
      await facturacion(t.id, placa, 'CONFIRMADA')
      const { ticketId } = await crearTicket(client, t.id, caso)
      const r = await esperar(aprobar(client, ticketId, {}), 200)

      const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
      assert.isTrue(Boolean(d.conComisionAsesor))
      assert.isTrue(Boolean(d.conComision))
      if (caso === 'SIN_CONVENIO') assert.isNull(d.conComisionConvenio)
      else assert.isTrue(Boolean(d.conComisionConvenio))
      assert.isNull(d.montoAsesorCalculado, 'sin "sin comisión" no hay foto')

      const c = await Comision.findOrFail(r.body().comisionId)
      assert.isAbove(Number(c.montoAsesor), 0)
      if (caso === 'CONVENIO_COMERCIAL') assert.isAbove(Number(c.montoConvenio), 0)
      assert.equal(await decisionEnBandeja(client, placa), 'con')
    })
  }

  test('fuera de ventana el body vacío sigue siendo 400', async ({ client, assert }) => {
    const t = await turno(PLACAS.FUERA_VACIO, false)
    const { ticketId, dentro } = await crearTicket(client, t.id, 'SIN_CONVENIO')
    assert.isFalse(dentro)
    const r = await esperar(aprobar(client, ticketId, {}), 400)
    assert.equal(r.body().code, 'COMBINACION_COMISION_INVALIDA')
  })

  // ───────────── Combinaciones imposibles dentro de ventana ─────────────
  test('dentro de ventana: combinaciones imposibles → 400 y no queda nada escrito', async ({
    client,
    assert,
  }) => {
    const t = await turno(PLACAS.MAL)
    const { ticketId } = await crearTicket(client, t.id, 'CONVENIO_COMERCIAL')
    for (const body of [
      { con_comision_asesor: true }, // Caso 3 sin flag de convenio
      { con_comision_convenio: false }, // falta el del asesor
      { con_comision_asesor: 'no', con_comision_convenio: true },
    ]) {
      const r = await esperar(aprobar(client, ticketId, body), 400)
      assert.equal(r.body().code, 'COMBINACION_COMISION_INVALIDA')
    }
    // Caso 1 (corrigiendo a sin convenio) con flag de convenio.
    const r1 = await esperar(
      aprobar(client, ticketId, {
        convenio_id: null,
        con_comision_asesor: true,
        con_comision_convenio: true,
      }),
      400
    )
    assert.equal(r1.body().caso, 'SIN_CONVENIO')

    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    assert.isNull(d.aprobadoPorId)
    assert.isNull(d.conComisionAsesor)
    assert.equal(d.convenioId, convenio.id, 'el rollback no deja el convenio corregido')
    const turnoTras = await TurnoRtm.findOrFail(t.id)
    assert.isNull(turnoTras.captacionDateoId, 'sin dateo')

    // Caso 2 con flags distintos.
    const t2 = await turno(PLACAS.MAL_CASO2)
    const { ticketId: t2Id } = await crearTicket(client, t2.id, 'CONVENIO_SELF')
    const r2 = await esperar(
      aprobar(client, t2Id, { con_comision_asesor: true, con_comision_convenio: false }),
      400
    )
    assert.equal(r2.body().caso, 'CONVENIO_SELF')
  })

  // ───────────── Aprobados antes del cambio ─────────────
  test('ticket aprobado antes, dentro de ventana y sin flags guardados, sigue contando "con"', async ({
    client,
    assert,
  }) => {
    const t = await turno(PLACAS.VIEJO)
    const { ticketId } = await crearTicket(client, t.id, 'SIN_CONVENIO')
    await esperar(aprobar(client, ticketId, {}), 200)
    // Así quedaban los aprobados dentro de ventana: las tres columnas en NULL.
    await Database.from('tickets_detalle_excepcion_dateo')
      .where('ticket_id', ticketId)
      .update({ con_comision: null, con_comision_asesor: null, con_comision_convenio: null })

    assert.equal(await decisionEnBandeja(client, PLACAS.VIEJO), 'con')
    const conFiltro = await esperar(
      client.get(`/api/tickets?placa=${PLACAS.VIEJO}&decision=con`).headers(auth()),
      200
    )
    assert.equal(conFiltro.body().meta.total, 1)
    const regimen = await esperar(
      client.get(`/api/tickets?placa=${PLACAS.VIEJO}&decision=regimen_anterior`).headers(auth()),
      200
    )
    assert.equal(regimen.body().meta.total, 0)
  })
})
