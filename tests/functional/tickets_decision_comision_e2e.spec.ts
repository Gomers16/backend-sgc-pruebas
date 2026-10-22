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
import { debeRespetarSinComision } from '#services/reserva_dateo_service'
import { sqlCopiaConComision } from '#database/migrations/1797000000000_add_con_comision_asesor_convenio_to_tickets_detalle_excepcion_dateo'

/**
 * Fase 4 de Tickets — decisión de comisión separada (asesor / convenio):
 *  - Caso 3: con / sin asesor / sin convenio / ninguno, en camino directo,
 *    diferido (Facturación se confirma después) y recálculo del Rep General
 *  - Caso 2: solo con/sin (flags iguales)
 *  - combinaciones imposibles → 400 COMBINACION_COMISION_INVALIDA
 *  - con_comision se sigue escribiendo (= flag del asesor) y leyendo
 *  - aprobar() pasa descuento de caja y avance al cálculo
 */

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN = 9
const ZONA = 'America/Bogota'
const DESCUENTO = { AVANCE: 2, INFORMATIVO_POLICIA: 4 } as const
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

// Placas con el formato que exige confirmar() (placaValida: AAA999).
const P = {
  DIR_CONTROL: 'TKD401',
  DIR_SIN_ASESOR: 'TKD402',
  DIR_SIN_CONVENIO: 'TKD403',
  DIR_NINGUNO: 'TKD404',
  DIF_SIN_ASESOR: 'TKD405',
  DIF_SIN_CONVENIO: 'TKD406',
  DIF_NINGUNO: 'TKD407',
  REP_SIN_ASESOR: 'TKD408',
  REP_SIN_CONVENIO: 'TKD409',
  REP_NINGUNO: 'TKD410',
  CASO2_SIN: 'TKD411',
  CASO2_LEGACY: 'TKD412',
  MAL_CASO1: 'TKD413',
  MAL_CASO2: 'TKD414',
  MAL_CASO3: 'TKD415',
  CAJA_DESCUENTO: 'TKD416',
  AVANCE: 'TKD417',
  AVANCE_SIN_DESCUENTO: 'TKD422',
  PROD_LOCAL: 'TKD418',
  COPIA_1: 'TKD419',
  COPIA_0: 'TKD420',
  COPIA_NULL: 'TKD421',
} as const

type Flags = { asesor: boolean; convenio: boolean }

test.group('Tickets · Fase 4 decisión de comisión separada', (group) => {
  group.each.timeout(60_000)

  let usuario: Usuario
  let token: string
  let comercial: AgenteCaptacion
  let comercialSinConvenio: AgenteCaptacion
  let asesorConvenio: AgenteCaptacion
  let convenio: Convenio
  let asignacion: AsesorConvenioAsignacion
  let configIncentivo: Comision
  let imagenPath: string
  const subidas: string[] = []
  const factIds: number[] = []
  let numero = 0
  // Montos del Caso 3 con comisión completa (control), para comparar.
  const completo = { monto: 0, asesor: 0, convenio: 0 }

  const ahora = () => DateTime.now().setZone(ZONA)
  const auth = () => ({ Authorization: `Bearer ${token}` })

  /** Turno de hoy fuera de ventana; número positivo porque Facturación lo copia a una columna UNSIGNED. */
  async function turnoDirecto(placa: string) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuario.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: ahora(),
      horaIngreso: '00:01',
      horaSalida: null,
      tieneFacturacion: false,
      turnoNumero: 981000 + numero,
      turnoNumeroServicio: 981000 + numero,
      turnoCodigo: `TST-TKDC-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      esSegundaVez: false,
    } as any)
  }

  async function facturacion(turnoId: number, placa: string, estado: string, extra = {}) {
    const f = await FacturacionTicket.create({
      hash: `TEST-HASH-TKDC-${placa}-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado,
      turnoId,
      placa,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      total: 50000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      ...extra,
    } as any)
    factIds.push(f.id)
    return f
  }

  async function subir(client: any) {
    const r = await client.post('/api/media/upload').headers(auth()).file('file', imagenPath)
    r.assertStatus(201)
    subidas.push(r.body().url)
    return r.body().url as string
  }

  async function crearTicket(client: any, turnoId: number, agenteId: number, intento: any = {}) {
    const r = await client
      .post('/api/tickets-excepcion-dateo')
      .headers(auth())
      .json({
        turno_id: turnoId,
        comercial_id: agenteId,
        observacion: 'Prueba Fase 4 tickets',
        evidencia_chat_url: await subir(client),
        evidencia_grupo_whatsapp_url: await subir(client),
        evidencia_bloqueo_url: await subir(client),
        ...intento,
      })
    r.assertStatus(201)
    return r.body().ticket.id as number
  }

  const conConvenio = () => ({ canal: 'ASESOR_COMERCIAL', convenio_id: convenio.id })

  const aprobar = (client: any, ticketId: number, body: Record<string, unknown>) =>
    client.patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`).headers(auth()).json(body)

  const flagsBody = (f: Flags) => ({
    con_comision_asesor: f.asesor,
    con_comision_convenio: f.convenio,
  })

  /** Caso 3 con facturación ya confirmada: la comisión nace en aprobar(). */
  async function caso3Directo(client: any, placa: string, f: Flags) {
    const turno = await turnoDirecto(placa)
    await facturacion(turno.id, placa, 'CONFIRMADA')
    const ticketId = await crearTicket(client, turno.id, comercial.id, conConvenio())
    const r = await aprobar(client, ticketId, flagsBody(f))
    r.assertStatus(200)
    return {
      turno,
      ticketId,
      body: r.body(),
      comision: await Comision.findOrFail(r.body().comisionId),
    }
  }

  async function assertMontos(assert: any, c: Comision, f: Flags) {
    assert.equal(Number(c.monto), completo.monto, 'monto queda con el valor del motor')
    assert.equal(Number(c.montoAsesor), f.asesor ? completo.asesor : 0)
    assert.equal(Number(c.montoConvenio), f.convenio ? completo.convenio : 0)
  }

  /** Foto del valor calculado (antes de forzar a $0): solo si hubo algún "sin comisión". */
  async function assertFoto(assert: any, ticketId: number, esperada: boolean) {
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    if (!esperada) {
      assert.isNull(d.montoAsesorCalculado)
      assert.isNull(d.montoConvenioCalculado)
      return
    }
    assert.equal(Number(d.montoAsesorCalculado), completo.asesor)
    assert.equal(Number(d.montoConvenioCalculado), completo.convenio)
  }

  async function assertFlagsGuardados(assert: any, ticketId: number, f: Flags) {
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    assert.equal(Boolean(d.conComisionAsesor), f.asesor)
    assert.equal(Boolean(d.conComisionConvenio), f.convenio)
    // Transición: con_comision = flag del asesor (producción local la lee).
    assert.equal(Boolean(d.conComision), f.asesor)
    assert.isNotNull(d.conComision)
  }

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'TK-DECISION',
      correo: `test.tk.decision.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuario)
    token = tokenObj.value!.release()

    const sufijo = Date.now().toString(36).toUpperCase()
    comercial = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKDC COMERCIAL ${sufijo}`,
    } as any)
    comercialSinConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKDC DIRECTO ${sufijo}`,
    } as any)
    asesorConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKDC CONVENIO ${sufijo}`,
    } as any)
    convenio = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKDC CONVENIO ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    asignacion = await AsesorConvenioAsignacion.create({
      asesorId: comercial.id,
      convenioId: convenio.id,
      activo: true,
      fechaFin: null,
    } as any)

    // Incentivo propio del asesor convenio (Caso 2 paga `base`), para que el
    // forzado a $0 se note: sin esto el global de la BD puede ser $0.
    configIncentivo = await Comision.create({
      esConfig: true,
      asesorId: asesorConvenio.id,
      tipoVehiculo: null,
      base: '15000',
      estado: 'PENDIENTE',
    } as any)

    imagenPath = app.tmpPath(`tst_tk_decision_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    const placas = Object.values(P)
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
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${marks}))`,
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
    await comercialSinConvenio.delete()
    await asesorConvenio.delete()
    await usuario.delete()
  })

  // ───────────── Camino directo (Facturación ya confirmada) ─────────────
  test('directo · Caso 3 con comisión completa (control)', async ({ client, assert }) => {
    const f = { asesor: true, convenio: true }
    const { ticketId, body, comision } = await caso3Directo(client, P.DIR_CONTROL, f)
    assert.equal(body.caso, 'CONVENIO_COMERCIAL')
    completo.monto = Number(comision.monto)
    completo.asesor = Number(comision.montoAsesor)
    completo.convenio = Number(comision.montoConvenio)
    assert.isAbove(completo.asesor, 0)
    assert.isAbove(completo.convenio, 0)
    await assertFlagsGuardados(assert, ticketId, f)
    await assertFoto(assert, ticketId, false)
  })

  for (const [nombre, placa, f] of [
    ['sin comisión asesor', P.DIR_SIN_ASESOR, { asesor: false, convenio: true }],
    ['sin comisión convenio', P.DIR_SIN_CONVENIO, { asesor: true, convenio: false }],
    ['sin comisión para ninguno', P.DIR_NINGUNO, { asesor: false, convenio: false }],
  ] as const) {
    test(`directo · Caso 3 ${nombre}`, async ({ client, assert }) => {
      const { turno, ticketId, body, comision } = await caso3Directo(client, placa, f)
      assert.equal(body.conComisionAsesor, f.asesor)
      assert.equal(body.conComisionConvenio, f.convenio)
      await assertMontos(assert, comision, f)
      await assertFlagsGuardados(assert, ticketId, f)
      await assertFoto(assert, ticketId, true)
      assert.deepEqual(await debeRespetarSinComision(turno.id), {
        asesor: !f.asesor,
        convenio: !f.convenio,
      })
    })
  }

  // ───────────── Camino diferido (Facturación se confirma después) ─────────────
  for (const [nombre, placa, f] of [
    ['sin comisión asesor', P.DIF_SIN_ASESOR, { asesor: false, convenio: true }],
    ['sin comisión convenio', P.DIF_SIN_CONVENIO, { asesor: true, convenio: false }],
    ['sin comisión para ninguno', P.DIF_NINGUNO, { asesor: false, convenio: false }],
  ] as const) {
    test(`diferido · Caso 3 ${nombre}`, async ({ client, assert }) => {
      const turno = await turnoDirecto(placa)
      const fact = await facturacion(turno.id, placa, 'LISTA_CONFIRMAR')
      const ticketId = await crearTicket(client, turno.id, comercial.id, conConvenio())
      const r = await aprobar(client, ticketId, flagsBody(f))
      r.assertStatus(200)
      assert.isNull(r.body().comisionId, 'sin facturación confirmada todavía no hay comisión')

      const rConfirmar = await client
        .post(`/api/facturacion/tickets/${fact.id}/confirmar`)
        .headers(auth())
        .json({})
      rConfirmar.assertStatus(200)

      const c = await Comision.query().where('captacion_dateo_id', r.body().dateoId).firstOrFail()
      assert.match(String(c.reglaAplicada), /^Caso 3/)
      await assertMontos(assert, c, f)
      // Camino diferido: la foto la escribe applyCommissionHook() al confirmar.
      await assertFoto(assert, ticketId, true)
    })
  }

  // ───────────── Recálculo del Rep General ─────────────
  for (const [nombre, placa, f] of [
    ['sin comisión asesor', P.REP_SIN_ASESOR, { asesor: false, convenio: true }],
    ['sin comisión convenio', P.REP_SIN_CONVENIO, { asesor: true, convenio: false }],
    ['sin comisión para ninguno', P.REP_NINGUNO, { asesor: false, convenio: false }],
  ] as const) {
    test(`Rep General · Caso 3 ${nombre} → la reclasificación no revierte la decisión`, async ({
      client,
      assert,
    }) => {
      const { turno, comision } = await caso3Directo(client, placa, f)
      const t = await TurnoRtm.findOrFail(turno.id)
      await (new RepGeneralImportController() as any).recalcularComisionSiExiste(
        t.captacionDateoId,
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
      await comision.refresh()
      const turnoTras = await TurnoRtm.findOrFail(turno.id)
      assert.isTrue(Boolean(turnoTras.esRecurrente))
      await assertMontos(assert, comision, f)
    })
  }

  // ───────────── Caso 2: el asesor ES el convenio ─────────────
  test('Caso 2 · sin comisión: ambos flags en false y monto_asesor en 0', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CASO2_SIN)
    await facturacion(turno.id, P.CASO2_SIN, 'CONFIRMADA')
    const ticketId = await crearTicket(client, turno.id, asesorConvenio.id)
    const r = await aprobar(client, ticketId, {
      con_comision_asesor: false,
      con_comision_convenio: false,
    })
    r.assertStatus(200)
    assert.equal(r.body().caso, 'CONVENIO_SELF')
    const c = await Comision.findOrFail(r.body().comisionId)
    assert.equal(Number(c.montoAsesor), 0)
    assert.equal(Number(c.montoConvenio), 0)
    assert.match(String(c.reglaAplicada), /^Caso 2/)
    assert.equal(
      Number(c.monto),
      15000,
      'el motor calculó el incentivo; solo se forzó monto_asesor'
    )
    await assertFlagsGuardados(assert, ticketId, { asesor: false, convenio: false })
  })

  test('Caso 2 · formato anterior (solo con_comision=false) vale para ambos', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CASO2_LEGACY)
    await facturacion(turno.id, P.CASO2_LEGACY, 'CONFIRMADA')
    const ticketId = await crearTicket(client, turno.id, asesorConvenio.id)
    const r = await aprobar(client, ticketId, { con_comision: false })
    r.assertStatus(200)
    assert.equal(r.body().conComisionAsesor, false)
    assert.equal(r.body().conComisionConvenio, false)
    const c = await Comision.findOrFail(r.body().comisionId)
    assert.equal(Number(c.montoAsesor), 0)
  })

  // ───────────── Combinaciones imposibles → 400 ─────────────
  test('400 · flag de convenio en un ticket sin convenio (Caso 1)', async ({ client, assert }) => {
    const turno = await turnoDirecto(P.MAL_CASO1)
    const ticketId = await crearTicket(client, turno.id, comercialSinConvenio.id)
    const r = await aprobar(client, ticketId, {
      con_comision_asesor: true,
      con_comision_convenio: false,
    })
    r.assertStatus(400)
    assert.equal(r.body().code, 'COMBINACION_COMISION_INVALIDA')
    assert.equal(r.body().caso, 'SIN_CONVENIO')
    // Nada quedó escrito: sigue PENDIENTE y el turno sin dateo.
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    assert.isNull(d.conComisionAsesor)
    const turnoTras = await TurnoRtm.findOrFail(turno.id)
    assert.isNull(turnoTras.captacionDateoId)
    // Con solo el flag del asesor sí aprueba.
    const ok = await aprobar(client, ticketId, { con_comision_asesor: false })
    ok.assertStatus(200)
    assert.isNull(ok.body().conComisionConvenio)
  })

  test('400 · Caso 2 con flags distintos', async ({ client, assert }) => {
    const turno = await turnoDirecto(P.MAL_CASO2)
    const ticketId = await crearTicket(client, turno.id, asesorConvenio.id)
    const r = await aprobar(client, ticketId, {
      con_comision_asesor: true,
      con_comision_convenio: false,
    })
    r.assertStatus(400)
    assert.equal(r.body().code, 'COMBINACION_COMISION_INVALIDA')
    assert.equal(r.body().caso, 'CONVENIO_SELF')
  })

  test('400 · Caso 3 sin flag de convenio', async ({ client, assert }) => {
    const turno = await turnoDirecto(P.MAL_CASO3)
    const ticketId = await crearTicket(client, turno.id, comercial.id, conConvenio())
    const r = await aprobar(client, ticketId, { con_comision_asesor: true })
    r.assertStatus(400)
    assert.equal(r.body().code, 'COMBINACION_COMISION_INVALIDA')
    const sinNada = await aprobar(client, ticketId, {})
    sinNada.assertStatus(400)
  })

  // ───────────── Descuento y avance en aprobar() ─────────────
  test('aprobar() con descuento de caja: llega al cálculo (Caso 1 nuevo + informativo)', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CAJA_DESCUENTO)
    await facturacion(turno.id, P.CAJA_DESCUENTO, 'CONFIRMADA', {
      descuentoId: DESCUENTO.INFORMATIVO_POLICIA,
      descuentoObservacion: 'policía en caja',
    })
    const ticketId = await crearTicket(client, turno.id, comercialSinConvenio.id)
    const r = await aprobar(client, ticketId, { con_comision_asesor: true })
    r.assertStatus(200)
    const c = await Comision.findOrFail(r.body().comisionId)
    assert.equal(c.descuentoCodigoAplicado, 'INFORMATIVO_POLICIA')
    assert.equal(c.descuentoObservacionCaja, 'policía en caja')
    assert.match(String(c.reglaAplicada), /Nuevo \+ informativo \(INFORMATIVO_POLICIA\)/)
  })

  test('aprobar() con Avance en la factura confirmada: Caso 3 Nuevo + Avance, convenio en $0', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.AVANCE)
    await facturacion(turno.id, P.AVANCE, 'CONFIRMADA', { descuentoId: DESCUENTO.AVANCE })
    const ticketId = await crearTicket(client, turno.id, comercial.id, {
      ...conConvenio(),
      descuento_id: DESCUENTO.AVANCE,
      es_avance: true,
      comprobante_avance_url: await subir(client),
    })
    const r = await aprobar(client, ticketId, flagsBody({ asesor: true, convenio: true }))
    r.assertStatus(200)
    const c = await Comision.findOrFail(r.body().comisionId)
    assert.isTrue(Boolean(c.esAvance))
    assert.equal(c.descuentoCodigoAplicado, 'AVANCE')
    assert.match(String(c.reglaAplicada), /Caso 3 .*Nuevo \+ Avance/)
    assert.equal(Number(c.montoConvenio), 0)
    // Sin monto explícito en caja: el avance sale del valor del descuento (carro).
    assert.equal(Number(c.descuentoMontoAplicado), 75000)
  })

  test('aprobar() con Avance en el intento pero la factura confirmada sin descuento: manda la factura, el convenio cobra', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.AVANCE_SIN_DESCUENTO)
    await facturacion(turno.id, P.AVANCE_SIN_DESCUENTO, 'CONFIRMADA')
    const ticketId = await crearTicket(client, turno.id, comercial.id, {
      ...conConvenio(),
      descuento_id: DESCUENTO.AVANCE,
      es_avance: true,
      comprobante_avance_url: await subir(client),
    })
    const r = await aprobar(client, ticketId, flagsBody({ asesor: true, convenio: true }))
    r.assertStatus(200)
    const c = await Comision.findOrFail(r.body().comisionId)
    assert.isFalse(Boolean(c.esAvance))
    assert.notMatch(String(c.reglaAplicada), /Avance/)
    assert.isAbove(Number(c.montoConvenio), 0)
  })

  // ───────────── Transición con producción local ─────────────
  test('ticket aprobado solo con con_comision (como lo deja producción local) se sigue respetando', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.PROD_LOCAL)
    const ticketId = await crearTicket(client, turno.id, comercial.id, conConvenio())
    const r = await aprobar(client, ticketId, flagsBody({ asesor: false, convenio: true }))
    r.assertStatus(200)
    await Database.from('tickets_detalle_excepcion_dateo').where('ticket_id', ticketId).update({
      con_comision: 0,
      con_comision_asesor: null,
      con_comision_convenio: null,
      monto_asesor_calculado: null,
      monto_convenio_calculado: null,
    })
    assert.deepEqual(await debeRespetarSinComision(turno.id), { asesor: true, convenio: false })
  })

  // ───────────── Migración 1797: copia de con_comision ─────────────
  test('migración 1797: con_comision 1 → ambos 1; 0 → asesor 0 y convenio 1; NULL → ambos NULL', async ({
    client,
    assert,
  }) => {
    const casos = [
      { placa: P.COPIA_1, valor: 1, asesor: 1, convenio: 1 },
      { placa: P.COPIA_0, valor: 0, asesor: 0, convenio: 1 },
      { placa: P.COPIA_NULL, valor: null, asesor: null, convenio: null },
    ]
    const ids: number[] = []
    for (const c of casos) {
      const turno = await turnoDirecto(c.placa)
      const ticketId = await crearTicket(client, turno.id, comercial.id, conConvenio())
      ids.push(ticketId)
      // Como quedaría un ticket de antes de la migración (o de producción local).
      await Database.from('tickets_detalle_excepcion_dateo')
        .where('ticket_id', ticketId)
        .update({ con_comision: c.valor, con_comision_asesor: null, con_comision_convenio: null })
    }

    await Database.rawQuery(sqlCopiaConComision(ids))

    for (const [i, c] of casos.entries()) {
      const fila = await Database.from('tickets_detalle_excepcion_dateo')
        .where('ticket_id', ids[i])
        .first()
      assert.strictEqual(fila.con_comision, c.valor, 'con_comision queda intacta')
      assert.strictEqual(fila.con_comision_asesor, c.asesor)
      assert.strictEqual(fila.con_comision_convenio, c.convenio)
    }
  })
})
