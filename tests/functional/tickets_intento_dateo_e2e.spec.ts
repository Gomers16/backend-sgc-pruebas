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
 * Fase 3 de Tickets — el ticket lleva el intento de dateo:
 *  - el 409 REQUIERE_TICKET_DATEO devuelve el intento validado
 *  - crear() lo guarda (y lo valida con la regla de store())
 *  - aprobar() crea el dateo con él y calcula el caso correcto
 *  - asesor convenio → Caso 2 (antes caía en Caso 1), también en tickets
 *    viejos y en el camino diferido de Facturación
 *  - gerencia corrige el convenio al aprobar (queda el original)
 */

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN = 9
const ZONA = 'America/Bogota'
const DESCUENTO_INFORMATIVO_ID = 1
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const P = {
  CASO3: 'TKIN01',
  CASO1: 'TKIN02',
  CASO2: 'TKIN03',
  VIEJO: 'TKIN04',
  CORRIGE: 'TKIN05',
  NO_ASIGNADO: 'TKIN06',
  DIFERIDO: 'TKIN07',
  INFORMATIVO: 'TKIN08',
  CASO_GET_1: 'TKIN09',
  CASO_GET_2: 'TKIN10',
  CASO_GET_3: 'TKIN11',
} as const
const PLACA_FACT_DIFERIDA = 'TKF307'

test.group('Tickets · Fase 3 convenio desde el dateo', (group) => {
  group.each.timeout(60_000)

  let usuario: Usuario
  let token: string
  let comercial: AgenteCaptacion
  let asesorConvenio: AgenteCaptacion
  let convenio: Convenio
  let convenioNoAsignado: Convenio
  let asignacion: AsesorConvenioAsignacion
  let imagenPath: string
  const subidas: string[] = []
  const factIds: number[] = []
  let numero = 0

  const ahora = () => DateTime.now().setZone(ZONA)
  const auth = () => ({ Authorization: `Bearer ${token}` })

  /** numeroPositivo: Facturación copia el número a una columna UNSIGNED. */
  async function turnoDirecto(placa: string, numeroPositivo = false) {
    numero++
    const n = numeroPositivo ? 980000 + numero : -(9800 + numero)
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuario.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: ahora(),
      horaIngreso: '06:00',
      horaSalida: null,
      tieneFacturacion: false,
      turnoNumero: n,
      turnoNumeroServicio: n,
      turnoCodigo: `TST-TKIN-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      esSegundaVez: false,
    } as any)
  }

  async function facturacionConfirmada(turnoId: number, placa: string) {
    const f = await FacturacionTicket.create({
      hash: `TEST-HASH-TKIN-${placa}-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa,
      servicioCodigo: 'RTM',
    } as any)
    factIds.push(f.id)
    return f
  }

  async function evidencias(client: any) {
    const subir = async () => {
      const r = await client.post('/api/media/upload').headers(auth()).file('file', imagenPath)
      r.assertStatus(201)
      subidas.push(r.body().url)
      return r.body().url as string
    }
    return {
      evidencia_chat_url: await subir(),
      evidencia_grupo_whatsapp_url: await subir(),
      evidencia_bloqueo_url: await subir(),
    }
  }

  /** Intenta datear y devuelve el 409 REQUIERE_TICKET_DATEO. */
  async function intentoRechazado(client: any, assert: any, body: Record<string, unknown>) {
    const r = await client
      .post('/api/captacion-dateos')
      .headers(auth())
      .json({ canal: 'ASESOR', origen: 'UI', servicio_id: SERVICIO_RTM_ID, ...body })
    r.assertStatus(409)
    assert.equal(r.body().code, 'REQUIERE_TICKET_DATEO')
    return r.body()
  }

  /** Crea el ticket con el intento tal como lo manda DateoCreate.vue. */
  async function crearTicket(client: any, turnoId: number, comercialId: number, intento: any) {
    return client
      .post('/api/tickets-excepcion-dateo')
      .headers(auth())
      .json({
        turno_id: turnoId,
        comercial_id: comercialId,
        observacion: 'Prueba Fase 3 tickets',
        canal: intento?.canal,
        convenio_id: intento?.convenio_id,
        servicio_id: intento?.servicio_id,
        descuento_id: intento?.descuento_id,
        es_avance: intento?.es_avance,
        comprobante_avance_url: intento?.comprobante_avance_url,
        telefono: intento?.telefono,
        ...(await evidencias(client)),
      })
  }

  const aprobar = (client: any, ticketId: number, body: Record<string, unknown> = {}) =>
    client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .headers(auth())
      .json({ con_comision: true, ...body })

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'TK-INTENTO',
      correo: `test.tk.intento.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuario)
    token = tokenObj.value!.release()

    const sufijo = Date.now().toString(36).toUpperCase()
    comercial = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKIN COMERCIAL ${sufijo}`,
    } as any)
    asesorConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKIN CONVENIO ${sufijo}`,
    } as any)
    convenio = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKIN CONVENIO ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    convenioNoAsignado = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKIN OTRO ${sufijo}`,
      activo: true,
    } as any)
    asignacion = await AsesorConvenioAsignacion.create({
      asesorId: comercial.id,
      convenioId: convenio.id,
      activo: true,
      fechaFin: null,
    } as any)

    imagenPath = app.tmpPath(`tst_tk_intento_${Date.now()}.png`)
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
    await convenio.delete()
    await convenioNoAsignado.delete()
    await comercial.delete()
    await asesorConvenio.delete()
    await usuario.delete()
  })

  test('comercial con convenio: el intento viaja al ticket y aprobar() paga Caso 3', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CASO3)
    const r409 = await intentoRechazado(client, assert, {
      agente_id: comercial.id,
      convenio_id: convenio.id,
      placa: P.CASO3,
      telefono: '300 123 4567',
    })
    assert.equal(r409.intento.canal, 'ASESOR_COMERCIAL')
    assert.equal(r409.intento.convenio_id, convenio.id)
    assert.equal(r409.intento.convenio_nombre, convenio.nombre)
    assert.equal(r409.intento.agente_nombre, comercial.nombre)
    assert.equal(r409.intento.servicio_id, SERVICIO_RTM_ID)
    assert.equal(r409.intento.telefono, '3001234567')

    const rTicket = await crearTicket(client, turno.id, comercial.id, r409.intento)
    rTicket.assertStatus(201)
    const detalle = rTicket.body().detalle
    assert.equal(detalle.convenioId, convenio.id)
    assert.equal(detalle.convenioIdOriginal, convenio.id)
    assert.equal(detalle.canal, 'ASESOR_COMERCIAL')
    assert.equal(detalle.telefono, '3001234567')

    await facturacionConfirmada(turno.id, P.CASO3)
    const rAprobar = await aprobar(client, rTicket.body().ticket.id)
    rAprobar.assertStatus(200)
    assert.equal(rAprobar.body().caso, 'CONVENIO_COMERCIAL')

    const dateo = await CaptacionDateo.findOrFail(rAprobar.body().dateoId)
    assert.equal(dateo.convenioId, convenio.id)
    assert.equal(dateo.canal, 'ASESOR_COMERCIAL')
    assert.equal(dateo.telefono, '3001234567')
    const c = await Comision.findOrFail(rAprobar.body().comisionId)
    assert.equal(c.asesorId, comercial.id)
    assert.equal(c.convenioId, convenio.id)
    assert.equal(c.asesorSecundarioId, asesorConvenio.id)
    assert.match(String(c.reglaAplicada), /^Caso 3/)
  })

  test('comercial nuevo directo: SIN_CONVENIO (Caso 1)', async ({ client, assert }) => {
    const turno = await turnoDirecto(P.CASO1)
    const r409 = await intentoRechazado(client, assert, { agente_id: comercial.id, placa: P.CASO1 })
    assert.isNull(r409.intento.convenio_id)

    const rTicket = await crearTicket(client, turno.id, comercial.id, r409.intento)
    rTicket.assertStatus(201)
    await facturacionConfirmada(turno.id, P.CASO1)
    const rAprobar = await aprobar(client, rTicket.body().ticket.id)
    rAprobar.assertStatus(200)
    assert.equal(rAprobar.body().caso, 'SIN_CONVENIO')
    const c = await Comision.findOrFail(rAprobar.body().comisionId)
    assert.isNull(c.convenioId)
    assert.match(String(c.reglaAplicada), /^Caso 1 · Sin convenio · Nuevo directo/)
  })

  test('descuento informativo del intento llega a la comisión (Caso 1 nuevo + informativo)', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.INFORMATIVO)
    const r409 = await intentoRechazado(client, assert, {
      agente_id: comercial.id,
      placa: P.INFORMATIVO,
      descuento_id: DESCUENTO_INFORMATIVO_ID,
    })
    assert.equal(r409.intento.descuento_id, DESCUENTO_INFORMATIVO_ID)
    const rTicket = await crearTicket(client, turno.id, comercial.id, r409.intento)
    rTicket.assertStatus(201)
    assert.equal(rTicket.body().detalle.descuentoId, DESCUENTO_INFORMATIVO_ID)

    await facturacionConfirmada(turno.id, P.INFORMATIVO)
    const rAprobar = await aprobar(client, rTicket.body().ticket.id)
    rAprobar.assertStatus(200)
    const dateo = await CaptacionDateo.findOrFail(rAprobar.body().dateoId)
    assert.equal(dateo.descuentoId, DESCUENTO_INFORMATIVO_ID)
    const c = await Comision.findOrFail(rAprobar.body().comisionId)
    assert.equal(c.descuentoCodigoAplicado, 'INFORMATIVO')
    assert.match(String(c.reglaAplicada), /Nuevo \+ informativo/)
  })

  test('asesor convenio: crear() resuelve su convenio aunque no venga y aprobar() paga Caso 2', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CASO2)
    // Sin intento (p. ej. se recargó la vista del ticket): igual queda su convenio.
    const rTicket = await crearTicket(client, turno.id, asesorConvenio.id, null)
    rTicket.assertStatus(201)
    assert.equal(rTicket.body().detalle.canal, 'ASESOR_CONVENIO')
    assert.equal(rTicket.body().detalle.convenioId, convenio.id)

    await facturacionConfirmada(turno.id, P.CASO2)
    const rAprobar = await aprobar(client, rTicket.body().ticket.id)
    rAprobar.assertStatus(200)
    assert.equal(rAprobar.body().caso, 'CONVENIO_SELF')
    const c = await Comision.findOrFail(rAprobar.body().comisionId)
    assert.equal(c.asesorId, asesorConvenio.id)
    assert.equal(c.convenioId, convenio.id)
    assert.equal(Number(c.montoConvenio), 0)
    assert.match(String(c.reglaAplicada), /^Caso 2/)
    const dateo = await CaptacionDateo.findOrFail(rAprobar.body().dateoId)
    assert.equal(dateo.asesorConvenioId, asesorConvenio.id)
  })

  test('ticket viejo (sin intento) de asesor convenio: aprobar() también paga Caso 2', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.VIEJO)
    const rTicket = await crearTicket(client, turno.id, asesorConvenio.id, null)
    rTicket.assertStatus(201)
    // Simula un ticket anterior a la Fase 3: sin canal ni convenio.
    await Database.from('tickets_detalle_excepcion_dateo')
      .where('ticket_id', rTicket.body().ticket.id)
      .update({ canal: null, convenio_id: null, convenio_id_original: null, servicio_id: null })

    await facturacionConfirmada(turno.id, P.VIEJO)
    const rAprobar = await aprobar(client, rTicket.body().ticket.id)
    rAprobar.assertStatus(200)
    assert.equal(rAprobar.body().caso, 'CONVENIO_SELF')
    assert.isFalse(rAprobar.body().convenioCorregido)
    const c = await Comision.findOrFail(rAprobar.body().comisionId)
    assert.equal(c.asesorId, asesorConvenio.id)
    assert.match(String(c.reglaAplicada), /^Caso 2/)
  })

  test('gerencia corrige el convenio al aprobar: queda SIN_CONVENIO y el original registrado', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CORRIGE)
    const r409 = await intentoRechazado(client, assert, {
      agente_id: comercial.id,
      convenio_id: convenio.id,
      placa: P.CORRIGE,
    })
    const rTicket = await crearTicket(client, turno.id, comercial.id, r409.intento)
    rTicket.assertStatus(201)
    const ticketId = rTicket.body().ticket.id as number

    // Convenio no asignado al comercial → mismo 403 que store().
    const rMal = await aprobar(client, ticketId, { convenio_id: convenioNoAsignado.id })
    rMal.assertStatus(403)
    assert.equal(rMal.body().code, 'INTENTO_DATEO_INVALIDO')

    await facturacionConfirmada(turno.id, P.CORRIGE)
    const rAprobar = await aprobar(client, ticketId, { convenio_id: null })
    rAprobar.assertStatus(200)
    assert.equal(rAprobar.body().caso, 'SIN_CONVENIO')
    assert.isTrue(rAprobar.body().convenioCorregido)

    const detalle = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    assert.isNull(detalle.convenioId)
    assert.equal(detalle.convenioIdOriginal, convenio.id)
    const dateo = await CaptacionDateo.findOrFail(rAprobar.body().dateoId)
    assert.isNull(dateo.convenioId)
  })

  test('crear() valida el intento: convenio no asignado al comercial → 403', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.NO_ASIGNADO)
    const r = await crearTicket(client, turno.id, comercial.id, {
      canal: 'ASESOR_COMERCIAL',
      convenio_id: convenioNoAsignado.id,
    })
    r.assertStatus(403)
    assert.equal(r.body().code, 'INTENTO_DATEO_INVALIDO')
  })

  test('camino diferido: dateo de asesor convenio sin convenio se paga como Caso 2 al confirmar Facturación', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.DIFERIDO, true)
    // Dateo como los que dejaba aprobar() antes de la Fase 3.
    const dateo = await CaptacionDateo.create({
      canal: 'ASESOR_CONVENIO',
      agenteId: asesorConvenio.id,
      convenioId: null,
      placa: P.DIFERIDO,
      servicioId: SERVICIO_RTM_ID,
      origen: 'UI',
      resultado: 'EN_PROCESO',
      consumidoTurnoId: turno.id,
      consumidoAt: DateTime.now(),
    } as any)
    turno.captacionDateoId = dateo.id
    await turno.save()

    const fact = await FacturacionTicket.create({
      hash: `TEST-HASH-TKIN-DIF-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'LISTA_CONFIRMAR',
      turnoId: turno.id,
      placa: PLACA_FACT_DIFERIDA,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      total: 50000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
    } as any)
    factIds.push(fact.id)

    const rConfirmar = await client
      .post(`/api/facturacion/tickets/${fact.id}/confirmar`)
      .headers(auth())
      .json({})
    rConfirmar.assertStatus(200)

    const c = await Comision.query().where('captacion_dateo_id', dateo.id).firstOrFail()
    assert.equal(c.asesorId, asesorConvenio.id)
    assert.equal(c.convenioId, convenio.id)
    assert.match(String(c.reglaAplicada), /^Caso 2/)
    await dateo.refresh()
    assert.equal(dateo.convenioId, convenio.id)
  })

  test('GET /tickets/:id devuelve caso_comision con la misma regla que aprobar()', async ({
    client,
    assert,
  }) => {
    const caso = async (ticketId: number) => {
      const r = await client.get(`/api/tickets/${ticketId}`).headers(auth())
      r.assertStatus(200)
      return r.body().caso_comision
    }
    const t3 = await turnoDirecto(P.CASO_GET_3)
    const r3 = await crearTicket(client, t3.id, comercial.id, {
      canal: 'ASESOR_COMERCIAL',
      convenio_id: convenio.id,
    })
    assert.equal(await caso(r3.body().ticket.id), 'CONVENIO_COMERCIAL')

    const t1 = await turnoDirecto(P.CASO_GET_1)
    const r1 = await crearTicket(client, t1.id, comercial.id, { canal: 'ASESOR_COMERCIAL' })
    assert.equal(await caso(r1.body().ticket.id), 'SIN_CONVENIO')

    const t2 = await turnoDirecto(P.CASO_GET_2)
    const r2 = await crearTicket(client, t2.id, asesorConvenio.id, null)
    const id2 = r2.body().ticket.id
    assert.equal(await caso(id2), 'CONVENIO_SELF')
    // Ticket viejo (sin intento) de asesor convenio: se resuelve su convenio.
    await Database.from('tickets_detalle_excepcion_dateo')
      .where('ticket_id', id2)
      .update({ canal: null, convenio_id: null, convenio_id_original: null })
    assert.equal(await caso(id2), 'CONVENIO_SELF')
  })
})
