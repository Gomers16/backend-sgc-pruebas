import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import TurnoRtm from '#models/turno_rtm'
import FacturacionTicket from '#models/facturacion_ticket'
import CaptacionDateo from '#models/captacion_dateo'
import Comision from '#models/comision'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'
import Ticket from '#models/ticket'
import Database from '@adonisjs/lucid/services/db'

const PLACA = 'TSTTKE2E'
// 🆕 Placa dedicada al caso "dentro de ventana" — turno separado del
// anterior para no interferir con su ventana de exclusividad.
const PLACA_DENTRO_VENTANA = 'TSTTKW2E'
// 🆕 Placa dedicada al caso "fuera de ventana, aprobar SIN comisión" con
// facturación YA confirmada al momento de aprobar.
const PLACA_SIN_COMISION = 'TSTTKS2E'
// 🆕 Placa dedicada al caso "fuera de ventana, aprobar SIN comisión ANTES
// de que facturación se confirme" — comisión DIFERIDA vía
// facturacion_tickets_controller.ts::applyCommissionHook().
const PLACA_DIFERIDA = 'TSTTKD2E'
const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const SERVICIO_RTM_ID = 1

// Fixture generada en el temp dir del SO en cada corrida (no depende de
// ninguna ruta de sesión) — 1x1 PNG válido, suficiente para exercitar
// POST /api/media/upload de punta a punta.
const EVIDENCIA_PATH = path.join(os.tmpdir(), 'tickets-e2e-evidencia.png')
const EVIDENCIA_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test.group('E2E manual - flujo completo Tickets Internos / Excepción de Dateo', (group) => {
  let usuarioTest: Usuario
  let agenteTest: AgenteCaptacion
  let token: string

  group.setup(async () => {
    fs.writeFileSync(EVIDENCIA_PATH, Buffer.from(EVIDENCIA_PNG_BASE64, 'base64'))

    usuarioTest = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'TICKETS-E2E',
      correo: `test.tickets.e2e.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuarioTest)
    token = tokenObj.value!.release()

    agenteTest = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: 'TEST TICKET E2E COMERCIAL',
    } as any)

    console.log('--- SETUP: usuario', usuarioTest.id, 'agente', agenteTest.id, '---')
  })

  group.teardown(async () => {
    console.log('--- TEARDOWN: limpiando datos de prueba ---')
    const placas = [PLACA, PLACA_DENTRO_VENTANA, PLACA_SIN_COMISION, PLACA_DIFERIDA]
    const placeholders = placas.map(() => '?').join(', ')
    await Database.rawQuery(
      `DELETE FROM tickets_detalle_excepcion_dateo WHERE comercial_id = ?`,
      [agenteTest.id]
    )
    await Database.rawQuery(
      `DELETE FROM tickets WHERE ${placas.map(() => 'titulo LIKE ?').join(' OR ')}`,
      placas.map((p) => `%${p}%`)
    )
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${placeholders}))`,
      placas
    )
    await Database.rawQuery(`DELETE FROM facturacion_tickets WHERE placa IN (${placeholders})`, placas)
    // El fixture del caso DIFERIDO usa una placa distinta ('TST111') a
    // propósito — ver comentario en el test — así que no cae en el IN(...)
    // de arriba.
    await Database.rawQuery(`DELETE FROM facturacion_tickets WHERE hash LIKE ?`, ['TEST-HASH-DIFERIDA-%'])
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${placeholders})`, placas)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${placeholders})`, placas)
    await agenteTest.delete()
    await usuarioTest.delete()
    try {
      fs.unlinkSync(EVIDENCIA_PATH)
    } catch {
      // no-op: no pasa nada si ya no existe
    }
    console.log('--- TEARDOWN: completo ---')
  })

  async function crearTurnoYRechazo(
    client: any,
    assert: any,
    placa: string,
    horaIngreso: string
  ): Promise<{ turnoId: number; bodyVentana: any }> {
    // 🆕 turno_codigo tiene precisión de segundo con índice único (ver
    // "RACE CONDITION CONFIRMADA" en MAPA_DEL_SISTEMA_BACKEND.md,
    // turnos_rtms_controller.ts::store() línea ~793) — con 4 tests creando
    // turnos del mismo servicio en rápida sucesión, dos pueden caer en el
    // mismo segundo de reloj y el segundo INSERT revienta con
    // ER_DUP_ENTRY. Mitigación solo de este archivo de test (no toca la
    // condición de carrera real, documentada como deuda técnica separada):
    // forzar que cada turno nuevo caiga en un segundo de reloj distinto.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const hoy = DateTime.local().setZone('America/Bogota')
    const resTurno = await client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarioTest.id,
        fecha: hoy.toISODate(),
        horaIngreso,
        servicioId: SERVICIO_RTM_ID,
      })
    resTurno.assertStatus(201)
    const turnoId = resTurno.body().id as number
    assert.exists(turnoId)
    assert.isNull(resTurno.body().captacionDateoId)

    const resSalida = await client
      .put(`/api/turnos-rtm/${turnoId}/salida`)
      .header('Authorization', `Bearer ${token}`)
      .json({ usuarioId: usuarioTest.id })
    resSalida.assertStatus(200)

    const resDateoRechazado = await client
      .post('/api/captacion-dateos')
      .header('Authorization', `Bearer ${token}`)
      .json({
        canal: 'ASESOR',
        agente_id: agenteTest.id,
        placa,
        servicio_id: SERVICIO_RTM_ID,
        origen: 'UI',
      })
    resDateoRechazado.assertStatus(409)
    const bodyVentana = resDateoRechazado.body()
    assert.equal(bodyVentana.code, 'REQUIERE_TICKET_DATEO')

    return { turnoId, bodyVentana }
  }

  async function subirEvidencias(client: any) {
    async function subirUna() {
      const res = await client
        .post('/api/media/upload')
        .header('Authorization', `Bearer ${token}`)
        .file('file', EVIDENCIA_PATH)
      res.assertStatus(201)
      return res.body().url as string
    }
    return {
      chat: await subirUna(),
      whatsapp: await subirUna(),
      bloqueo: await subirUna(),
    }
  }

  test('flujo completo: turno -> REQUIERE_TICKET_DATEO (fuera de ventana) -> ticket -> aprobar CON comisión -> comision completa', async ({
    client,
    assert,
  }) => {
    // horaIngreso 00:05 garantiza que ya pasaron los 60 min de la ventana
    // global default, sin depender de la hora real a la que corra el test.
    const { turnoId } = await crearTurnoYRechazo(client, assert, PLACA, '00:05')

    // Fixture: turno ya facturado y confirmado (para probar la rama que SÍ
    // genera comisión en el paso de aprobar).
    const facturacion = await FacturacionTicket.create({
      hash: `TEST-HASH-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa: PLACA,
      servicioCodigo: 'RTM',
    } as any)
    console.log('--- Fixture: facturacion_ticket CONFIRMADA creado ---', facturacion.id)

    const ev = await subirEvidencias(client)
    const resTicket = await client
      .post('/api/tickets-excepcion-dateo')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turnoId,
        comercial_id: agenteTest.id,
        observacion: 'Prueba E2E: cliente llegó por fachada, comercial no alcanzó a datear a tiempo.',
        evidencia_chat_url: ev.chat,
        evidencia_grupo_whatsapp_url: ev.whatsapp,
        evidencia_bloqueo_url: ev.bloqueo,
      })
    resTicket.assertStatus(201)
    const ticketId = resTicket.body().ticket.id as number
    assert.equal(resTicket.body().ticket.estado, 'PENDIENTE')
    assert.isFalse(resTicket.body().detalle.dentroVentana, 'Fuera de ventana: dentroVentana debe quedar false')

    // Duplicado: debe rechazar con 409 mientras siga PENDIENTE
    const resDup = await client
      .post('/api/tickets-excepcion-dateo')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turnoId,
        comercial_id: agenteTest.id,
        observacion: 'Duplicado de prueba',
        evidencia_chat_url: ev.chat,
        evidencia_grupo_whatsapp_url: ev.whatsapp,
        evidencia_bloqueo_url: ev.bloqueo,
      })
    resDup.assertStatus(409)

    // Sin con_comision en el body, fuera de ventana: debe rechazar 400
    const resSinBody = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})
    resSinBody.assertStatus(400)

    // Aprobar CON comisión — comisión completa, sin ningún override.
    const resAprobar = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({ con_comision: true })
    console.log('--- aprobar CON comisión ---', resAprobar.status(), JSON.stringify(resAprobar.body()))
    resAprobar.assertStatus(200)
    const aprobarBody = resAprobar.body()
    assert.equal(aprobarBody.ticket.estado, 'APROBADO')
    assert.exists(aprobarBody.dateoId)
    assert.exists(aprobarBody.comisionId, 'Debe generar comisión porque hay facturación CONFIRMADA')
    assert.isFalse(aprobarBody.dentroVentana)
    assert.isTrue(aprobarBody.conComision)
    assert.isTrue(aprobarBody.detalle.conComision)

    const dateoCreado = await CaptacionDateo.findOrFail(aprobarBody.dateoId)
    const turnoTrasAprobar = await TurnoRtm.findOrFail(turnoId)
    const comisionCreada = await Comision.findOrFail(aprobarBody.comisionId)
    assert.equal(turnoTrasAprobar.captacionDateoId, dateoCreado.id, 'El turno debe quedar vinculado al dateo')
    assert.equal(dateoCreado.resultado, 'EXITOSO')
    assert.equal(comisionCreada.estado, 'PENDIENTE')
    assert.equal(comisionCreada.asesorId, agenteTest.id)
    assert.isTrue(Number(comisionCreada.montoAsesor) > 0, 'Con comisión: montoAsesor debe ser el monto completo, no 0')

    const ticketFinal = await Ticket.findOrFail(ticketId)
    assert.equal(ticketFinal.estado, 'APROBADO')

    // Ticket ya resuelto: un segundo intento de aprobar/rechazar debe fallar
    const resAprobarOtraVez = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({ con_comision: true })
    resAprobarOtraVez.assertStatus(400)
  }).timeout(60000)

  // 🆕 Caso "dentro de ventana": el turno entró hace pocos minutos (dentro
  // de la ventana global default de 60 min), así que el ticket queda
  // dentroVentana=true y aprobar() no debe pedir con_comision ni permitir
  // elegir — siempre comisión completa, sin decisión de gerencia.
  test('flujo dentro de ventana: turno -> REQUIERE_TICKET_DATEO (dentroVentana=true) -> ticket -> aprobar sin elegir nada', async ({
    client,
    assert,
  }) => {
    const hoy = DateTime.local().setZone('America/Bogota')
    // horaIngreso 5 minutos atrás — bien dentro de la ventana global default
    // (60 min), sin depender de mockear el reloj.
    const horaIngresoReciente = hoy.minus({ minutes: 5 }).toFormat('HH:mm')
    const { turnoId, bodyVentana } = await crearTurnoYRechazo(
      client,
      assert,
      PLACA_DENTRO_VENTANA,
      horaIngresoReciente
    )
    assert.isTrue(bodyVentana.dentroVentana, 'Turno reciente: debe quedar dentro de ventana')

    const facturacion = await FacturacionTicket.create({
      hash: `TEST-HASH-DENTRO-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa: PLACA_DENTRO_VENTANA,
      servicioCodigo: 'RTM',
    } as any)
    console.log('--- [DENTRO VENTANA] Fixture: facturacion_ticket CONFIRMADA creado ---', facturacion.id)

    const ev = await subirEvidencias(client)
    const resTicket = await client
      .post('/api/tickets-excepcion-dateo')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turnoId,
        comercial_id: agenteTest.id,
        observacion: 'Prueba E2E: turno reciente, comercial todavía dentro de la ventana permitida.',
        evidencia_chat_url: ev.chat,
        evidencia_grupo_whatsapp_url: ev.whatsapp,
        evidencia_bloqueo_url: ev.bloqueo,
      })
    resTicket.assertStatus(201)
    const ticketId = resTicket.body().ticket.id as number
    assert.isTrue(
      resTicket.body().detalle.dentroVentana,
      'Snapshot al crear el ticket debe quedar dentroVentana=true'
    )

    // Aprobar SIN con_comision en el body — el backend debe ignorarlo/no
    // exigirlo porque detalle.dentroVentana === true.
    const resAprobar = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})
    console.log('--- [DENTRO VENTANA] aprobar sin body ---', resAprobar.status(), JSON.stringify(resAprobar.body()))
    resAprobar.assertStatus(200)
    const aprobarBody = resAprobar.body()
    assert.equal(aprobarBody.ticket.estado, 'APROBADO')
    assert.isTrue(aprobarBody.dentroVentana)
    assert.exists(aprobarBody.dateoId)
    assert.exists(aprobarBody.comisionId, 'Debe generar comisión completa aunque no haya decisión de gerencia')
    assert.isNull(aprobarBody.conComision, 'Dentro de ventana: conComision debe quedar null')
    assert.isNull(aprobarBody.detalle.conComision, 'Dentro de ventana: detalle.conComision debe quedar null')

    const dateoCreado = await CaptacionDateo.findOrFail(aprobarBody.dateoId)
    const turnoTrasAprobar = await TurnoRtm.findOrFail(turnoId)
    const comisionCreada = await Comision.findOrFail(aprobarBody.comisionId)
    assert.equal(turnoTrasAprobar.captacionDateoId, dateoCreado.id, 'El turno debe quedar vinculado al dateo')
    assert.equal(dateoCreado.resultado, 'EXITOSO')
    assert.isTrue(Number(comisionCreada.montoAsesor) > 0, 'Dentro de ventana: comisión completa, no 0')
  }).timeout(60000)

  // 🆕 Caso nuevo: fuera de ventana, gerencia elige "Aprobar sin comisión"
  // con facturación YA confirmada al momento de aprobar (camino directo,
  // no diferido). montoAsesor debe forzarse a 0, montoConvenio (0 en este
  // caso porque el ticket no trae convenio_id) queda intacto — el motor lo
  // calcula igual que siempre, solo montoAsesor se pisa después.
  test('flujo fuera de ventana: aprobar SIN comisión -> montoAsesor=0, montoConvenio intacto', async ({
    client,
    assert,
  }) => {
    const { turnoId } = await crearTurnoYRechazo(client, assert, PLACA_SIN_COMISION, '00:05')

    const facturacion = await FacturacionTicket.create({
      hash: `TEST-HASH-SINCOM-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa: PLACA_SIN_COMISION,
      servicioCodigo: 'RTM',
    } as any)
    console.log('--- [SIN COMISION] Fixture: facturacion_ticket CONFIRMADA creado ---', facturacion.id)

    const ev = await subirEvidencias(client)
    const resTicket = await client
      .post('/api/tickets-excepcion-dateo')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turnoId,
        comercial_id: agenteTest.id,
        observacion: 'Prueba E2E: fuera de ventana, gerencia aprueba sin comisión.',
        evidencia_chat_url: ev.chat,
        evidencia_grupo_whatsapp_url: ev.whatsapp,
        evidencia_bloqueo_url: ev.bloqueo,
      })
    resTicket.assertStatus(201)
    const ticketId = resTicket.body().ticket.id as number

    const resAprobar = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({ con_comision: false })
    console.log('--- [SIN COMISION] aprobar ---', resAprobar.status(), JSON.stringify(resAprobar.body()))
    resAprobar.assertStatus(200)
    const aprobarBody = resAprobar.body()
    assert.equal(aprobarBody.ticket.estado, 'APROBADO')
    assert.exists(aprobarBody.comisionId, 'Debe crear la comisión igual — solo con montoAsesor forzado a 0')
    assert.isFalse(aprobarBody.conComision)
    assert.isFalse(aprobarBody.detalle.conComision)

    const comisionCreada = await Comision.findOrFail(aprobarBody.comisionId)
    assert.equal(Number(comisionCreada.montoAsesor), 0, 'Sin comisión: montoAsesor debe quedar en 0')
    assert.equal(
      Number(comisionCreada.montoConvenio),
      0,
      'Sin convenio en este ticket: montoConvenio ya era 0 de por sí — debe seguir en 0, no otro valor'
    )
    assert.isTrue(
      Number(comisionCreada.monto) > 0,
      'El motor sí calculó una comisión real antes del override (monto/base no son 0) — el override solo tocó montoAsesor'
    )

    // mysql2 devuelve TINYINT(1) como 0/1 (no boolean real) al leer un
    // modelo directo — Boolean() en vez de isFalse estricto, mismo criterio
    // ya documentado para dentroVentana en tickets_excepcion_dateo_controller.ts.
    const detalleEnBD = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    assert.isFalse(Boolean(detalleEnBD.conComision))
  }).timeout(60000)

  // 🆕 Caso nuevo: fuera de ventana, "Aprobar sin comisión" ANTES de que
  // Facturación confirme el ticket — la comisión se crea DESPUÉS por el
  // camino diferido (facturacion_tickets_controller.ts::applyCommissionHook()).
  // Sin el fix de forzarSinComisionPorTicket, este camino pagaría comisión
  // completa ignorando la decisión de gerencia — esto es exactamente lo que
  // este test verifica que NO pase.
  test('flujo DIFERIDO: aprobar SIN comisión ANTES de confirmar Facturación -> comisión diferida también respeta montoAsesor=0', async ({
    client,
    assert,
  }) => {
    const { turnoId } = await crearTurnoYRechazo(client, assert, PLACA_DIFERIDA, '00:05')

    // Facturación todavía NO confirmada al momento de aprobar el ticket —
    // creada en LISTA_CONFIRMAR, no CONFIRMADA.
    const facturacion = await FacturacionTicket.create({
      hash: `TEST-HASH-DIFERIDA-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'LISTA_CONFIRMAR',
      turnoId,
      // 🆕 canConfirm() (facturacion_tickets_controller.ts) exige que
      // ticket.placa matchee el regex estricto de placa colombiana — corre
      // ANTES de fillSnapshotsFromTurno(), así que el placa "TSTxxxx" de 8
      // caracteres usado en el resto de este archivo (válido para
      // turnos-rtm/captacion-dateos, que no son tan estrictos) lo rechazaría
      // acá. Placa distinta a propósito, solo para este fixture — el turno
      // real sigue siendo PLACA_DIFERIDA.
      placa: 'TST111',
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      total: 50000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
    } as any)
    console.log('--- [DIFERIDA] Fixture: facturacion_ticket LISTA_CONFIRMAR creado (aún NO confirmada) ---', facturacion.id)

    const ev = await subirEvidencias(client)
    const resTicket = await client
      .post('/api/tickets-excepcion-dateo')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turnoId,
        comercial_id: agenteTest.id,
        observacion: 'Prueba E2E: fuera de ventana, sin comisión, facturación se confirma después.',
        evidencia_chat_url: ev.chat,
        evidencia_grupo_whatsapp_url: ev.whatsapp,
        evidencia_bloqueo_url: ev.bloqueo,
      })
    resTicket.assertStatus(201)
    const ticketId = resTicket.body().ticket.id as number

    const resAprobar = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({ con_comision: false })
    console.log('--- [DIFERIDA] aprobar (sin facturación confirmada todavía) ---', resAprobar.status(), JSON.stringify(resAprobar.body()))
    resAprobar.assertStatus(200)
    const aprobarBody = resAprobar.body()
    assert.equal(aprobarBody.ticket.estado, 'APROBADO')
    assert.isNull(
      aprobarBody.comisionId,
      'Sin facturación CONFIRMADA todavía: NO debe crearse comisión en este paso'
    )
    assert.isFalse(aprobarBody.conComision)

    const dateoTrasAprobar = await CaptacionDateo.findOrFail(aprobarBody.dateoId)
    assert.notEqual(dateoTrasAprobar.resultado, 'EXITOSO', 'Sin facturación confirmada: el dateo sigue EN_PROCESO')
    const turnoTrasAprobar = await TurnoRtm.findOrFail(turnoId)
    assert.equal(
      turnoTrasAprobar.captacionDateoId,
      dateoTrasAprobar.id,
      'El turno debe quedar vinculado al dateo aunque la comisión todavía no exista'
    )

    // Ahora SÍ se confirma Facturación — dispara applyCommissionHook() por
    // el camino diferido, que debe leer tickets_detalle_excepcion_dateo y
    // respetar con_comision=false igual que el camino directo.
    const resConfirmar = await client
      .post(`/api/facturacion/tickets/${facturacion.id}/confirmar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})
    console.log('--- [DIFERIDA] confirmar facturación ---', resConfirmar.status(), JSON.stringify(resConfirmar.body()))
    resConfirmar.assertStatus(200)

    const comisionDiferida = await Comision.query()
      .where('captacion_dateo_id', dateoTrasAprobar.id)
      .first()
    console.log('--- [DIFERIDA] comisión creada por el camino diferido ---', comisionDiferida?.serialize())
    assert.exists(comisionDiferida, 'applyCommissionHook() debe crear la comisión al confirmarse Facturación')
    assert.equal(
      Number(comisionDiferida!.montoAsesor),
      0,
      'Camino DIFERIDO: montoAsesor debe seguir en 0 — la decisión de gerencia no debe perderse'
    )
    assert.isTrue(
      Number(comisionDiferida!.monto) > 0,
      'El motor sí calculó una comisión real por el camino diferido — el override solo tocó montoAsesor'
    )

    const dateoTrasConfirmar = await CaptacionDateo.findOrFail(dateoTrasAprobar.id)
    assert.equal(dateoTrasConfirmar.resultado, 'EXITOSO', 'Al confirmarse Facturación, el dateo pasa a EXITOSO')
  }).timeout(60000)
})
