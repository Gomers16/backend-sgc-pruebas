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
import CaptacionDateo from '#models/captacion_dateo'
import Comision from '#models/comision'
import FacturacionTicket from '#models/facturacion_ticket'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'

/**
 * Corrección del convenio de un ticket de Excepción de Dateo YA APROBADO
 * (PATCH /tickets-excepcion-dateo/:id/convenio, Etapa 2):
 *  - solo con la comisión PENDIENTE; APROBADA/PAGADA → 409 sin cambios
 *  - recalcula con el motor de aprobar() en la misma fila (fecha_calculo igual)
 *  - Cobra/No cobra (guardado o del body), dentro y fuera de ventana
 *  - avance: convenio en $0 por el descuento final (regla del motor, informada)
 *  - sin comisión todavía: el hook la calcula con el convenio corregido
 *  - evento CONVENIO_CORREGIDO momento POST_APROBACION con montos y motivo
 *  - /simular no guarda nada
 */

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ZONA = 'America/Bogota'
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10, COMERCIAL: 11 } as const
const DESCUENTO = { AVANCE: 2, INFORMATIVO_POLICIA: 4 } as const
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const P = {
  FUERA_C1_C3: 'TKCC01',
  NO_COBRA_CONV: 'TKCC02',
  NO_COBRA_ASESOR: 'TKCC03',
  DENTRO: 'TKCC04',
  AVANCE: 'TKCC05',
  C3_A_SIN: 'TKCC06',
  DIFERIDO: 'TKCC07',
  APROBADA: 'TKCC08',
  PAGADA: 'TKCC09',
  INFORMATIVO: 'TKCC10',
  GUARDAS: 'TKCC11',
  PENDIENTE: 'TKCC12',
  ASESOR_CONV: 'TKCC13',
  SIMULAR: 'TKCC14',
  NO_ASIGNADO: 'TKCC15',
} as const
const PLACA_FACT_DIFERIDA = 'TKF907'

test.group('Tickets · corrección del convenio después de aprobar', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  const subidas: string[] = []
  const factIds: number[] = []
  let admin: Usuario
  let comercial: AgenteCaptacion
  let asesorConvenio: AgenteCaptacion
  let convenioA: Convenio
  let convenioB: Convenio
  let convenioAsesor: Convenio
  let convenioNoAsignado: Convenio
  const asignaciones: AsesorConvenioAsignacion[] = []
  let imagenPath: string
  let numero = 0

  const ahora = () => DateTime.now().setZone(ZONA)
  const bearer = (clave: string) => ({ Authorization: `Bearer ${tokens[clave]}` })

  async function crearUsuario(clave: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TK-CORR-${clave}`,
      correo: `test.tk.corr.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    tokens[clave] = tokenObj.value!.release()
    return u
  }

  /** dentro: entró hace 5 min; fuera: a las 00:01. numeroPositivo: para confirmar Facturación. */
  async function turno(placa: string, o: { dentro?: boolean; numeroPositivo?: boolean } = {}) {
    numero++
    const n = o.numeroPositivo ? 988000 + numero : -(9050 + numero)
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: ahora(),
      horaIngreso: o.dentro ? ahora().minus({ minutes: 5 }).toFormat('HH:mm') : '00:01',
      horaSalida: null,
      tieneFacturacion: false,
      turnoNumero: n,
      turnoNumeroServicio: n,
      turnoCodigo: `TST-TKCC-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      esSegundaVez: false,
    } as any)
  }

  async function facturar(turnoId: number, placa: string, extra: Record<string, unknown> = {}) {
    const f = await FacturacionTicket.create({
      hash: `TEST-HASH-TKCC-${placa}-${Date.now()}-${Math.random()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
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
    const r = await client
      .post('/api/media/upload')
      .headers(bearer('ADMIN'))
      .file('file', imagenPath)
    r.assertStatus(201)
    subidas.push(r.body().url)
    return r.body().url as string
  }

  async function crear(client: any, turnoId: number, body: Record<string, unknown>) {
    const r = await client
      .post('/api/tickets-excepcion-dateo')
      .headers(bearer('ADMIN'))
      .json({
        turno_id: turnoId,
        comercial_id: comercial.id,
        observacion: 'Prueba corrección de convenio',
        evidencia_chat_url: await subir(client),
        evidencia_grupo_whatsapp_url: await subir(client),
        evidencia_bloqueo_url: await subir(client),
        canal: 'ASESOR_COMERCIAL',
        ...body,
      })
    r.assertStatus(201)
    return r.body().ticket.id as number
  }

  async function aprobar(client: any, ticketId: number, body: Record<string, unknown>) {
    const r = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .headers(bearer('GERENCIA'))
      .json(body)
    r.assertStatus(200)
    return r.body() as { comisionId: number | null; dateoId: number; caso: string }
  }

  const corregir = (
    client: any,
    ticketId: number,
    body: Record<string, unknown>,
    quien = 'GERENCIA'
  ) =>
    client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/convenio`)
      .headers(bearer(quien))
      .json({ motivo: 'La observación decía convenio', ...body })

  const eventosCorreccion = (ticketId: number) =>
    Database.from('ticket_eventos').where('ticket_id', ticketId).where('tipo', 'CONVENIO_CORREGIDO')

  const datosDe = (fila: any) =>
    typeof fila.datos === 'string' ? JSON.parse(fila.datos) : fila.datos

  /** Ticket Caso 1 aprobado (fuera de ventana) con factura confirmada → comisión PENDIENTE. */
  async function caso1Aprobado(
    client: any,
    placa: string,
    o: { conAsesor?: boolean; dentro?: boolean; factura?: Record<string, unknown> } = {}
  ) {
    const t = await turno(placa, { dentro: o.dentro })
    await facturar(t.id, placa, o.factura ?? {})
    const ticketId = await crear(client, t.id, { sin_convenio: true })
    const body = o.dentro ? {} : { con_comision_asesor: o.conAsesor ?? true }
    const ap = await aprobar(client, ticketId, body)
    assert(ap.comisionId, 'la factura confirmada crea la comisión al aprobar')
    return { turno: t, ticketId, comisionId: ap.comisionId!, dateoId: ap.dateoId }
  }

  function assert(v: unknown, msg: string): asserts v {
    if (!v) throw new Error(msg)
  }

  group.setup(async () => {
    admin = await crearUsuario('ADMIN', ROL.SUPER_ADMIN)
    await crearUsuario('GERENCIA', ROL.GERENCIA)
    await crearUsuario('COMERCIAL', ROL.COMERCIAL)

    const sufijo = Date.now().toString(36).toUpperCase()
    comercial = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKCC COMERCIAL ${sufijo}`,
    } as any)
    asesorConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKCC ASESORCONV ${sufijo}`,
    } as any)
    convenioAsesor = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKCC ASESORCONV ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    const nuevoConvenio = (nombre: string) =>
      Convenio.create({
        tipo: 'PERSONA',
        nombre: `TEST TKCC ${nombre} ${sufijo}`,
        activo: true,
        asesorConvenioId: asesorConvenio.id,
      } as any)
    convenioA = await nuevoConvenio('A')
    convenioB = await nuevoConvenio('B')
    convenioNoAsignado = await nuevoConvenio('OTRO')
    for (const c of [convenioA, convenioB]) {
      asignaciones.push(
        await AsesorConvenioAsignacion.create({
          asesorId: comercial.id,
          convenioId: c.id,
          activo: true,
          fechaFin: null,
        } as any)
      )
    }

    imagenPath = app.tmpPath(`tst_tk_corr_${Date.now()}.png`)
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
    for (const a of asignaciones) await a.delete()
    for (const c of [convenioA, convenioB, convenioNoAsignado, convenioAsesor]) await c.delete()
    await comercial.delete()
    await asesorConvenio.delete()
    for (const u of usuarios) await u.delete()
  })

  test('fuera de ventana Caso 1 → 3: exige la decisión del convenio; recalcula la misma comisión sin tocar fecha_calculo', async ({
    client,
    assert: a,
  }) => {
    const { ticketId, comisionId, dateoId } = await caso1Aprobado(client, P.FUERA_C1_C3)
    const antes = await Comision.findOrFail(comisionId)
    a.isNull(antes.convenioId)

    const rSinFlag = await corregir(client, ticketId, { convenio_id: convenioA.id })
    rSinFlag.assertStatus(400)
    a.equal(rSinFlag.body().code, 'COMBINACION_COMISION_INVALIDA')

    const r = await corregir(client, ticketId, {
      convenio_id: convenioA.id,
      con_comision_convenio: true,
    })
    r.assertStatus(200)
    a.equal(r.body().caso_anterior, 'SIN_CONVENIO')
    a.equal(r.body().caso_nuevo, 'CONVENIO_COMERCIAL')
    a.isFalse(r.body().simulado)

    const c = await Comision.findOrFail(comisionId)
    a.equal(c.estado, 'PENDIENTE')
    a.equal(c.convenioId, convenioA.id)
    a.equal(c.asesorId, comercial.id)
    a.equal(c.asesorSecundarioId, asesorConvenio.id)
    a.match(String(c.reglaAplicada), /^Caso 3/)
    a.isAbove(Number(c.montoConvenio), 0)
    a.equal(c.fechaCalculo.toISO(), antes.fechaCalculo.toISO())
    a.equal(c.calculadoPor, antes.calculadoPor)
    const nComisiones = await Comision.query().where('captacion_dateo_id', dateoId)
    a.lengthOf(nComisiones, 1)

    const dateo = await CaptacionDateo.findOrFail(dateoId)
    a.equal(dateo.convenioId, convenioA.id)
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    a.equal(d.convenioId, convenioA.id)
    a.isNull(d.convenioIdOriginal)
    a.isFalse(Boolean(d.sinConvenioExplicito))
    a.isTrue(Boolean(d.conComisionAsesor))
    a.isTrue(Boolean(d.conComisionConvenio))

    const [ev] = await eventosCorreccion(ticketId)
    const datos = datosDe(ev)
    a.equal(datos.momento, 'POST_APROBACION')
    a.equal(datos.motivo, 'La observación decía convenio')
    a.isNull(datos.convenio_anterior_id)
    a.equal(datos.convenio_nuevo_id, convenioA.id)
    a.equal(datos.comision_id, comisionId)
    a.isNull(datos.montos_antes.convenio_id)
    a.equal(datos.montos_despues.convenio_id, convenioA.id)
    a.equal(datos.montos_antes.monto_asesor, Number(antes.montoAsesor))
    a.equal(datos.montos_despues.monto_convenio, Number(c.montoConvenio))

    // La línea de tiempo y el detalle lo muestran.
    const rGet = await client.get(`/api/tickets/${ticketId}`).headers(bearer('GERENCIA'))
    a.equal(rGet.body().caso_comision, 'CONVENIO_COMERCIAL')
    a.equal(rGet.body().comision_ticket.estado, 'PENDIENTE')
    a.include(
      rGet.body().eventos.map((e: any) => e.tipo),
      'CONVENIO_CORREGIDO'
    )
  })

  test('"No cobra" del convenio: queda en $0 con la foto del valor calculado', async ({
    client,
    assert: a,
  }) => {
    const { ticketId, comisionId } = await caso1Aprobado(client, P.NO_COBRA_CONV)
    const r = await corregir(client, ticketId, {
      convenio_id: convenioA.id,
      con_comision_convenio: false,
    })
    r.assertStatus(200)
    const c = await Comision.findOrFail(comisionId)
    a.equal(Number(c.montoConvenio), 0)
    a.isAbove(Number(c.montoAsesor), 0)
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    a.isFalse(Boolean(d.conComisionConvenio))
    a.isAbove(Number(d.montoConvenioCalculado), 0)
  })

  test('"No cobra" del asesor guardado al aprobar se respeta al corregir', async ({
    client,
    assert: a,
  }) => {
    const { ticketId, comisionId } = await caso1Aprobado(client, P.NO_COBRA_ASESOR, {
      conAsesor: false,
    })
    const r = await corregir(client, ticketId, {
      convenio_id: convenioA.id,
      con_comision_convenio: true,
    })
    r.assertStatus(200)
    a.isFalse(r.body().con_comision_asesor)
    const c = await Comision.findOrFail(comisionId)
    a.equal(Number(c.montoAsesor), 0)
    a.isAbove(Number(c.montoConvenio), 0)
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    a.isAbove(Number(d.montoAsesorCalculado), 0)
  })

  test('dentro de ventana Caso 1 → 3 sin flags: el convenio cobra', async ({
    client,
    assert: a,
  }) => {
    const { ticketId, comisionId } = await caso1Aprobado(client, P.DENTRO, { dentro: true })
    const d0 = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    a.isTrue(Boolean(d0.dentroVentana))

    const r = await corregir(client, ticketId, { convenio_id: convenioA.id })
    r.assertStatus(200)
    a.isTrue(r.body().con_comision_asesor)
    a.isTrue(r.body().con_comision_convenio)
    const c = await Comision.findOrFail(comisionId)
    a.isAbove(Number(c.montoConvenio), 0)
    a.isAbove(Number(c.montoAsesor), 0)
  })

  test('avance: factura con Avance, Caso 1 → 3 deja el convenio en $0 por la regla del motor', async ({
    client,
    assert: a,
  }) => {
    const t = await turno(P.AVANCE)
    await facturar(t.id, P.AVANCE, { descuentoId: DESCUENTO.AVANCE })
    const ticketId = await crear(client, t.id, {
      sin_convenio: true,
      descuento_id: DESCUENTO.AVANCE,
      es_avance: true,
      comprobante_avance_url: await subir(client),
    })
    const ap = await aprobar(client, ticketId, { con_comision_asesor: true })
    const antes = await Comision.findOrFail(ap.comisionId!)
    a.isFalse(Boolean(antes.esAvance), 'en Caso 1 el avance no aplica')

    const r = await corregir(client, ticketId, {
      convenio_id: convenioA.id,
      con_comision_convenio: true,
    })
    r.assertStatus(200)
    a.isTrue(r.body().convenio_en_cero_por_descuento)
    const c = await Comision.findOrFail(ap.comisionId!)
    a.isTrue(Boolean(c.esAvance))
    a.equal(c.descuentoCodigoAplicado, 'AVANCE')
    a.equal(Number(c.montoConvenio), 0)
    a.equal(Number(c.descuentoMontoAplicado), 75000)
    a.match(String(c.reglaAplicada), /Caso 3 .*AVANCE/)
    // "Cobra" se respetó: el $0 es del motor, no de la decisión (sin foto).
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    a.isTrue(Boolean(d.conComisionConvenio))
    a.isNull(d.montoConvenioCalculado)
  })

  test('Caso 3 → sin convenio: todo al asesor y el flag del convenio queda null', async ({
    client,
    assert: a,
  }) => {
    const t = await turno(P.C3_A_SIN)
    await facturar(t.id, P.C3_A_SIN)
    const ticketId = await crear(client, t.id, { convenio_id: convenioA.id })
    const ap = await aprobar(client, ticketId, {
      con_comision_asesor: true,
      con_comision_convenio: true,
    })
    const r = await corregir(client, ticketId, { convenio_id: null })
    r.assertStatus(200)
    a.equal(r.body().caso_nuevo, 'SIN_CONVENIO')
    a.isNull(r.body().con_comision_convenio)
    const c = await Comision.findOrFail(ap.comisionId!)
    a.isNull(c.convenioId)
    a.isNull(c.asesorSecundarioId)
    a.match(String(c.reglaAplicada), /^Caso 1/)
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    a.isNull(d.convenioId)
    a.equal(d.convenioIdOriginal, convenioA.id)
    a.isTrue(Boolean(d.sinConvenioExplicito))
  })

  test('sin comisión todavía: corrige dateo y ticket; el hook paga Caso 3 al confirmar la factura', async ({
    client,
    assert: a,
  }) => {
    const t = await turno(P.DIFERIDO, { numeroPositivo: true })
    const ticketId = await crear(client, t.id, { sin_convenio: true })
    const ap = await aprobar(client, ticketId, { con_comision_asesor: true })
    a.isNull(ap.comisionId)

    const r = await corregir(client, ticketId, {
      convenio_id: convenioA.id,
      con_comision_convenio: false,
    })
    r.assertStatus(200)
    a.isNull(r.body().comision_id)
    a.isNull(r.body().montos_antes)

    const fact = await FacturacionTicket.create({
      hash: `TEST-HASH-TKCC-DIF-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'LISTA_CONFIRMAR',
      turnoId: t.id,
      placa: PLACA_FACT_DIFERIDA,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      total: 50000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
    } as any)
    factIds.push(fact.id)
    const rConf = await client
      .post(`/api/facturacion/tickets/${fact.id}/confirmar`)
      .headers(bearer('ADMIN'))
      .json({})
    rConf.assertStatus(200)

    const c = await Comision.query().where('captacion_dateo_id', ap.dateoId).firstOrFail()
    a.equal(c.convenioId, convenioA.id)
    a.match(String(c.reglaAplicada), /^Caso 3/)
    a.equal(Number(c.montoConvenio), 0, '"No cobra" del convenio también en el camino diferido')
    a.isAbove(Number(c.montoAsesor), 0)
  })

  for (const estado of ['APROBADA', 'PAGADA'] as const) {
    test(`comisión ${estado} → 409 COMISION_NO_EDITABLE sin cambiar nada`, async ({
      client,
      assert: a,
    }) => {
      const placa = estado === 'APROBADA' ? P.APROBADA : P.PAGADA
      const { ticketId, comisionId, dateoId } = await caso1Aprobado(client, placa)
      await Database.from('comisiones').where('id', comisionId).update({ estado })
      const antes = await Comision.findOrFail(comisionId)

      const r = await corregir(client, ticketId, {
        convenio_id: convenioA.id,
        con_comision_convenio: true,
      })
      r.assertStatus(409)
      a.equal(r.body().code, 'COMISION_NO_EDITABLE')
      a.equal(r.body().estado, estado)

      const c = await Comision.findOrFail(comisionId)
      a.equal(c.estado, estado)
      a.isNull(c.convenioId)
      a.equal(c.montoAsesor, antes.montoAsesor)
      a.equal(c.reglaAplicada, antes.reglaAplicada)
      const dateo = await CaptacionDateo.findOrFail(dateoId)
      a.isNull(dateo.convenioId)
      const detalle = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
      a.isNull(detalle.convenioId)
      a.lengthOf(await eventosCorreccion(ticketId), 0)

      const rGet = await client.get(`/api/tickets/${ticketId}`).headers(bearer('GERENCIA'))
      a.equal(rGet.body().comision_ticket.estado, estado)
    })
  }

  test('descuento informativo + convenio: 400 (un comercial con convenio solo marca Avance)', async ({
    client,
    assert: a,
  }) => {
    const t = await turno(P.INFORMATIVO)
    const ticketId = await crear(client, t.id, {
      sin_convenio: true,
      descuento_id: DESCUENTO.INFORMATIVO_POLICIA,
    })
    await aprobar(client, ticketId, { con_comision_asesor: true })
    const r = await corregir(client, ticketId, {
      convenio_id: convenioA.id,
      con_comision_convenio: true,
    })
    r.assertStatus(400)
    a.equal(r.body().code, 'INTENTO_DATEO_INVALIDO')
    a.lengthOf(await eventosCorreccion(ticketId), 0)
  })

  test('guardas: motivo, mismo convenio, rol, ticket pendiente y asesor convenio', async ({
    client,
    assert: a,
  }) => {
    const { ticketId } = await caso1Aprobado(client, P.GUARDAS)
    const rSinMotivo = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/convenio`)
      .headers(bearer('GERENCIA'))
      .json({ convenio_id: convenioA.id, con_comision_convenio: true })
    rSinMotivo.assertStatus(400)
    const rMismo = await corregir(client, ticketId, { convenio_id: null })
    rMismo.assertStatus(400)
    a.equal(rMismo.body().code, 'CONVENIO_SIN_CAMBIO')
    const rRol = await corregir(client, ticketId, { convenio_id: convenioA.id }, 'COMERCIAL')
    rRol.assertStatus(403)

    const tPend = await turno(P.PENDIENTE)
    const pendiente = await crear(client, tPend.id, { sin_convenio: true })
    const rPend = await corregir(client, pendiente, { convenio_id: convenioA.id })
    rPend.assertStatus(409)
    a.equal(rPend.body().code, 'TICKET_NO_APROBADO')

    const tAc = await turno(P.ASESOR_CONV)
    await facturar(tAc.id, P.ASESOR_CONV)
    const rAc = await client
      .post('/api/tickets-excepcion-dateo')
      .headers(bearer('ADMIN'))
      .json({
        turno_id: tAc.id,
        comercial_id: asesorConvenio.id,
        observacion: 'asesor convenio',
        evidencia_chat_url: await subir(client),
        evidencia_grupo_whatsapp_url: await subir(client),
        evidencia_bloqueo_url: await subir(client),
      })
    rAc.assertStatus(201)
    await aprobar(client, rAc.body().ticket.id, { con_comision_asesor: true })
    const rCorrAc = await corregir(client, rAc.body().ticket.id, { convenio_id: convenioA.id })
    rCorrAc.assertStatus(409)
    a.equal(rCorrAc.body().code, 'CONVENIO_ASESOR_CONVENIO')
  })

  test('/simular devuelve los montos de después y no guarda nada', async ({
    client,
    assert: a,
  }) => {
    const { ticketId, comisionId, dateoId } = await caso1Aprobado(client, P.SIMULAR)
    const antes = await Comision.findOrFail(comisionId)
    const r = await client
      .post(`/api/tickets-excepcion-dateo/${ticketId}/convenio/simular`)
      .headers(bearer('GERENCIA'))
      .json({ convenio_id: convenioB.id, con_comision_asesor: true, con_comision_convenio: true })
    r.assertStatus(200)
    a.isTrue(r.body().simulado)
    a.equal(r.body().caso_nuevo, 'CONVENIO_COMERCIAL')
    a.equal(r.body().montos_despues.convenio_id, convenioB.id)
    a.isAbove(r.body().montos_despues.monto_convenio, 0)

    const c = await Comision.findOrFail(comisionId)
    a.isNull(c.convenioId)
    a.equal(c.montoAsesor, antes.montoAsesor)
    const dateo = await CaptacionDateo.findOrFail(dateoId)
    a.isNull(dateo.convenioId)
    a.lengthOf(await eventosCorreccion(ticketId), 0)
  })

  test('gerencia corrige a un convenio no asignado: se permite y queda registrado', async ({
    client,
    assert: a,
  }) => {
    const { ticketId, comisionId } = await caso1Aprobado(client, P.NO_ASIGNADO)
    const r = await corregir(client, ticketId, {
      convenio_id: convenioNoAsignado.id,
      con_comision_convenio: true,
    })
    r.assertStatus(200)
    a.isTrue(r.body().convenio_no_asignado)
    const c = await Comision.findOrFail(comisionId)
    a.equal(c.convenioId, convenioNoAsignado.id)
    const [ev] = await eventosCorreccion(ticketId)
    a.isTrue(datosDe(ev).convenio_no_asignado)
  })
})
