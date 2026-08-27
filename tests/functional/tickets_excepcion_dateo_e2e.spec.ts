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
import SaldoPenalizacion from '#models/saldo_penalizacion'
import MovimientoPenalizacion from '#models/movimiento_penalizacion'
import Ticket from '#models/ticket'
import Database from '@adonisjs/lucid/services/db'

const PLACA = 'TSTTKE2E'
// 🆕 Placa dedicada al caso "dentro de ventana, sin penalización" — turno
// separado del anterior para no interferir con su ventana de exclusividad.
const PLACA_DENTRO_VENTANA = 'TSTTKW2E'
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
    const placas = [PLACA, PLACA_DENTRO_VENTANA]
    await Database.rawQuery('DELETE FROM movimientos_penalizacion WHERE asesor_id = ?', [agenteTest.id])
    await Database.rawQuery('DELETE FROM saldo_penalizaciones WHERE asesor_id = ?', [agenteTest.id])
    await Database.rawQuery(
      'DELETE FROM tickets_detalle_excepcion_dateo WHERE comercial_id = ?',
      [agenteTest.id]
    )
    await Database.rawQuery(
      "DELETE FROM tickets WHERE titulo LIKE ? OR titulo LIKE ?",
      placas.map((p) => `%${p}%`)
    )
    await Database.rawQuery(
      'DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (?, ?))',
      placas
    )
    await Database.rawQuery('DELETE FROM facturacion_tickets WHERE placa IN (?, ?)', placas)
    await Database.rawQuery('DELETE FROM turnos_rtms WHERE placa IN (?, ?)', placas)
    await Database.rawQuery('DELETE FROM captacion_dateos WHERE placa IN (?, ?)', placas)
    await agenteTest.delete()
    await usuarioTest.delete()
    try {
      fs.unlinkSync(EVIDENCIA_PATH)
    } catch {
      // no-op: no pasa nada si ya no existe
    }
    console.log('--- TEARDOWN: completo ---')
  })

  test('flujo completo: turno -> REQUIERE_TICKET_DATEO (fuera de ventana) -> ticket -> aprobar con penalización -> comision -> saldo -> cobrar', async ({
    client,
    assert,
  }) => {
    const hoy = DateTime.local().setZone('America/Bogota')

    // ===== PASO 1: crear turno RTM de prueba con horaIngreso muy temprano
    // (00:05) para garantizar que ya pasaron los 40 min, sin depender de la
    // hora real a la que corra este test ni tocar reserva_dateo_service.ts. =====
    const resTurno = await client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa: PLACA,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarioTest.id,
        fecha: hoy.toISODate(),
        horaIngreso: '00:05',
        servicioId: SERVICIO_RTM_ID,
      })
    console.log('--- PASO 1: crear turno ---', resTurno.status(), JSON.stringify(resTurno.body()))
    resTurno.assertStatus(201)
    const turnoId = resTurno.body().id as number
    assert.exists(turnoId)
    assert.isNull(resTurno.body().captacionDateoId)

    const resSalida = await client
      .put(`/api/turnos-rtm/${turnoId}/salida`)
      .header('Authorization', `Bearer ${token}`)
      .json({ usuarioId: usuarioTest.id })
    console.log('--- PASO 1b: finalizar turno (salida) ---', resSalida.status(), JSON.stringify(resSalida.body()))
    resSalida.assertStatus(200)

    const turnoFinalizado = await TurnoRtm.findOrFail(turnoId)
    assert.equal(turnoFinalizado.estado, 'finalizado')
    console.log('--- PASO 1c: turno confirmado finalizado en BD ---', {
      id: turnoFinalizado.id,
      estado: turnoFinalizado.estado,
      horaIngreso: turnoFinalizado.horaIngreso,
      captacionDateoId: turnoFinalizado.captacionDateoId,
    })

    // ===== PASO 2/3: intentar datear esa placa -> debe rechazar SIEMPRE con
    // REQUIERE_TICKET_DATEO (ya no hay "dateo automático dentro de ventana").
    // horaIngreso=00:05 garantiza que ya pasó la ventana configurada
    // (default global 60 min), así que dentroVentana debe venir false. =====
    const resDateoRechazado = await client
      .post('/api/captacion-dateos')
      .header('Authorization', `Bearer ${token}`)
      .json({
        canal: 'ASESOR',
        agente_id: agenteTest.id,
        placa: PLACA,
        servicio_id: SERVICIO_RTM_ID,
        origen: 'UI',
      })
    console.log(
      '--- PASO 2/3: intento de dateo directo (debe fallar REQUIERE_TICKET_DATEO) ---',
      resDateoRechazado.status(),
      JSON.stringify(resDateoRechazado.body())
    )
    resDateoRechazado.assertStatus(409)
    const bodyVentana = resDateoRechazado.body()
    assert.equal(bodyVentana.code, 'REQUIERE_TICKET_DATEO')
    assert.equal(bodyVentana.turnoId, turnoId)
    assert.isFalse(bodyVentana.dentroVentana)
    assert.isTrue(bodyVentana.minutosTranscurridos > bodyVentana.minutosVentana)
    assert.isTrue(bodyVentana.minutosExceso > 0)
    assert.exists(bodyVentana.horaIngreso)
    assert.exists(bodyVentana.minutosVentana)

    // ===== Fixture: turno ya facturado y confirmado (para probar la rama
    // que SÍ genera comisión en el paso de aprobar) =====
    const facturacion = await FacturacionTicket.create({
      hash: `TEST-HASH-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa: PLACA,
      servicioCodigo: 'RTM',
    } as any)
    console.log('--- Fixture: facturacion_ticket CONFIRMADA creado ---', {
      id: facturacion.id,
      turnoId: facturacion.turnoId,
      estado: facturacion.estado,
    })

    // ===== PASO 4: crear el ticket de excepción con las 4 evidencias =====
    async function subirEvidencia() {
      const res = await client
        .post('/api/media/upload')
        .header('Authorization', `Bearer ${token}`)
        .file('file', EVIDENCIA_PATH)
      res.assertStatus(201)
      return res.body().url as string
    }
    const urlChat = await subirEvidencia()
    const urlWhatsapp = await subirEvidencia()
    const urlBloqueo = await subirEvidencia()
    const urlCalamidad = await subirEvidencia()
    console.log('--- PASO 4a: 4 evidencias subidas ---', { urlChat, urlWhatsapp, urlBloqueo, urlCalamidad })

    const resTicket = await client
      .post('/api/tickets-excepcion-dateo')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turnoId,
        comercial_id: agenteTest.id, // ruta de respaldo SUPER_ADMIN/GERENCIA
        observacion: 'Prueba E2E: cliente llegó por fachada, comercial no alcanzó a datear a tiempo.',
        evidencia_chat_url: urlChat,
        evidencia_grupo_whatsapp_url: urlWhatsapp,
        evidencia_bloqueo_url: urlBloqueo,
        evidencia_calamidad_url: urlCalamidad,
      })
    console.log('--- PASO 4b: crear ticket excepcion dateo ---', resTicket.status(), JSON.stringify(resTicket.body()))
    resTicket.assertStatus(201)
    const ticketId = resTicket.body().ticket.id as number
    assert.equal(resTicket.body().ticket.estado, 'PENDIENTE')
    assert.equal(resTicket.body().detalle.comercialId, agenteTest.id)
    assert.equal(resTicket.body().detalle.turnoId, turnoId)
    assert.isTrue(resTicket.body().detalle.minutosExceso > 0)
    assert.isFalse(resTicket.body().detalle.dentroVentana, 'Fuera de ventana: dentroVentana debe quedar false')

    // Duplicado: debe rechazar con 409 mientras siga PENDIENTE
    const resDup = await client
      .post('/api/tickets-excepcion-dateo')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turnoId,
        comercial_id: agenteTest.id,
        observacion: 'Duplicado de prueba',
        evidencia_chat_url: urlChat,
        evidencia_grupo_whatsapp_url: urlWhatsapp,
        evidencia_bloqueo_url: urlBloqueo,
      })
    console.log('--- PASO 4c: ticket duplicado (debe ser 409) ---', resDup.status(), JSON.stringify(resDup.body()))
    resDup.assertStatus(409)

    // ===== PASO 5/6: aprobar con 15% de penalización =====
    const resAprobar = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({ porcentaje_penalizacion: 15 })
    console.log('--- PASO 5: aprobar ticket (15%) ---', resAprobar.status(), JSON.stringify(resAprobar.body()))
    resAprobar.assertStatus(200)
    const aprobarBody = resAprobar.body()
    assert.equal(aprobarBody.ticket.estado, 'APROBADO')
    assert.exists(aprobarBody.dateoId)
    assert.exists(aprobarBody.comisionId, 'Debe generar comisión porque hay facturación CONFIRMADA')
    assert.isFalse(aprobarBody.dentroVentana)
    assert.exists(aprobarBody.detalle.porcentajePenalizacion, 'Fuera de ventana: sí debe quedar porcentaje')

    const dateoCreado = await CaptacionDateo.findOrFail(aprobarBody.dateoId)
    const turnoTrasAprobar = await TurnoRtm.findOrFail(turnoId)
    const comisionCreada = await Comision.findOrFail(aprobarBody.comisionId)
    console.log('--- PASO 6a: verificación en BD tras aprobar ---', {
      dateo: { id: dateoCreado.id, resultado: dateoCreado.resultado, servicioId: dateoCreado.servicioId },
      turno: { id: turnoTrasAprobar.id, captacionDateoId: turnoTrasAprobar.captacionDateoId },
      comision: {
        id: comisionCreada.id,
        asesorId: comisionCreada.asesorId,
        montoAsesor: comisionCreada.montoAsesor,
        estado: comisionCreada.estado,
        reglaAplicada: comisionCreada.reglaAplicada,
      },
    })
    assert.equal(turnoTrasAprobar.captacionDateoId, dateoCreado.id, 'El turno debe quedar vinculado al dateo')
    assert.equal(dateoCreado.resultado, 'EXITOSO')
    assert.equal(comisionCreada.estado, 'PENDIENTE')
    assert.equal(comisionCreada.asesorId, agenteTest.id)

    const montoEsperadoCargo = Math.round((Number(comisionCreada.montoAsesor) * 15) / 100)
    assert.equal(
      aprobarBody.montoCargoPenalizacion,
      montoEsperadoCargo,
      'El cargo debe ser 15% de comision.montoAsesor (nunca montoConvenio)'
    )

    const movCargo = await MovimientoPenalizacion.query()
      .where('ticket_id', ticketId)
      .where('tipo', 'CARGO')
      .first()
    console.log('--- PASO 6b: movimiento CARGO en BD ---', movCargo?.serialize())
    assert.exists(movCargo, 'Debe existir un movimiento CARGO ligado a este ticket')
    assert.equal(Number(movCargo!.monto), montoEsperadoCargo)

    const ticketFinal = await Ticket.findOrFail(ticketId)
    assert.equal(ticketFinal.estado, 'APROBADO')

    // Ticket ya resuelto: un segundo intento de aprobar/rechazar debe fallar
    const resAprobarOtraVez = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({ porcentaje_penalizacion: 50 })
    console.log(
      '--- PASO 6c: reintento de aprobar sobre ticket ya resuelto (debe ser 400) ---',
      resAprobarOtraVez.status(),
      JSON.stringify(resAprobarOtraVez.body())
    )
    resAprobarOtraVez.assertStatus(400)

    // ===== PASO 7: ficha comercial / saldo de penalizaciones =====
    const resSaldo = await client
      .get(`/api/saldo-penalizaciones/${agenteTest.id}`)
      .header('Authorization', `Bearer ${token}`)
    console.log('--- PASO 7: GET saldo-penalizaciones ---', resSaldo.status(), JSON.stringify(resSaldo.body()))
    resSaldo.assertStatus(200)
    assert.equal(resSaldo.body().saldoActual, montoEsperadoCargo)
    assert.isTrue(
      resSaldo.body().movimientos.some((m: any) => m.ticketId === ticketId && m.tipo === 'CARGO')
    )

    const saldoEnBD = await SaldoPenalizacion.findByOrFail('asesorId', agenteTest.id)
    assert.equal(Number(saldoEnBD.saldoActual), montoEsperadoCargo)

    // ===== PASO 8: cobrar saldo por NOMINA (parcial, para verificar el resto pendiente) =====
    const montoACobrar = Math.max(1, Math.floor(montoEsperadoCargo / 2))
    const resCobrar = await client
      .post(`/api/saldo-penalizaciones/${agenteTest.id}/cobrar`)
      .header('Authorization', `Bearer ${token}`)
      .json({ monto: montoACobrar, origen: 'NOMINA', observacion: 'Prueba E2E cobro por nómina' })
    console.log('--- PASO 8: cobrar saldo (NOMINA) ---', resCobrar.status(), JSON.stringify(resCobrar.body()))
    resCobrar.assertStatus(200)
    assert.equal(resCobrar.body().montoCobrado, montoACobrar)
    assert.equal(resCobrar.body().saldoActual, montoEsperadoCargo - montoACobrar)

    const movAbono = await MovimientoPenalizacion.query()
      .where('asesor_id', agenteTest.id)
      .where('tipo', 'ABONO')
      .first()
    console.log('--- PASO 8b: movimiento ABONO en BD ---', movAbono?.serialize())
    assert.exists(movAbono)
    assert.equal(movAbono!.origenCobro, 'NOMINA')
    assert.equal(Number(movAbono!.monto), montoACobrar)

    const saldoFinalBD = await SaldoPenalizacion.findByOrFail('asesorId', agenteTest.id)
    console.log('--- PASO 8c: saldo final en BD ---', saldoFinalBD.saldoActual)
    assert.equal(Number(saldoFinalBD.saldoActual), montoEsperadoCargo - montoACobrar)
  }).timeout(60000)

  // 🆕 Caso "dentro de ventana, sin penalización": el turno entró hace pocos
  // minutos (dentro de la ventana global default de 60 min), así que el
  // ticket queda dentroVentana=true y aprobar() no debe pedir porcentaje ni
  // generar ningún movimiento de penalización.
  test('flujo dentro de ventana: turno -> REQUIERE_TICKET_DATEO (dentroVentana=true) -> ticket -> aprobar sin penalización', async ({
    client,
    assert,
  }) => {
    const hoy = DateTime.local().setZone('America/Bogota')
    // horaIngreso 5 minutos atrás — bien dentro de la ventana global default
    // (60 min), sin depender de mockear el reloj.
    const horaIngresoReciente = hoy.minus({ minutes: 5 }).toFormat('HH:mm')

    const resTurno = await client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa: PLACA_DENTRO_VENTANA,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarioTest.id,
        fecha: hoy.toISODate(),
        horaIngreso: horaIngresoReciente,
        servicioId: SERVICIO_RTM_ID,
      })
    console.log('--- [DENTRO VENTANA] PASO 1: crear turno ---', resTurno.status(), JSON.stringify(resTurno.body()))
    resTurno.assertStatus(201)
    const turnoId = resTurno.body().id as number

    const resSalida = await client
      .put(`/api/turnos-rtm/${turnoId}/salida`)
      .header('Authorization', `Bearer ${token}`)
      .json({ usuarioId: usuarioTest.id })
    resSalida.assertStatus(200)

    // Intento de dateo directo: debe rechazar con REQUIERE_TICKET_DATEO pero
    // dentroVentana=true (a diferencia del flujo anterior).
    const resDateoRechazado = await client
      .post('/api/captacion-dateos')
      .header('Authorization', `Bearer ${token}`)
      .json({
        canal: 'ASESOR',
        agente_id: agenteTest.id,
        placa: PLACA_DENTRO_VENTANA,
        servicio_id: SERVICIO_RTM_ID,
        origen: 'UI',
      })
    console.log(
      '--- [DENTRO VENTANA] intento de dateo directo (debe fallar REQUIERE_TICKET_DATEO, dentroVentana=true) ---',
      resDateoRechazado.status(),
      JSON.stringify(resDateoRechazado.body())
    )
    resDateoRechazado.assertStatus(409)
    const bodyVentana = resDateoRechazado.body()
    assert.equal(bodyVentana.code, 'REQUIERE_TICKET_DATEO')
    assert.isTrue(bodyVentana.dentroVentana, 'Turno reciente: debe quedar dentro de ventana')

    // Fixture: turno ya facturado y confirmado (para probar que sí genera
    // comisión aunque no haya penalización).
    const facturacion = await FacturacionTicket.create({
      hash: `TEST-HASH-DENTRO-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa: PLACA_DENTRO_VENTANA,
      servicioCodigo: 'RTM',
    } as any)
    console.log('--- [DENTRO VENTANA] Fixture: facturacion_ticket CONFIRMADA creado ---', facturacion.id)

    async function subirEvidencia() {
      const res = await client
        .post('/api/media/upload')
        .header('Authorization', `Bearer ${token}`)
        .file('file', EVIDENCIA_PATH)
      res.assertStatus(201)
      return res.body().url as string
    }
    const urlChat = await subirEvidencia()
    const urlWhatsapp = await subirEvidencia()
    const urlBloqueo = await subirEvidencia()

    const resTicket = await client
      .post('/api/tickets-excepcion-dateo')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turnoId,
        comercial_id: agenteTest.id,
        observacion: 'Prueba E2E: turno reciente, comercial todavía dentro de la ventana permitida.',
        evidencia_chat_url: urlChat,
        evidencia_grupo_whatsapp_url: urlWhatsapp,
        evidencia_bloqueo_url: urlBloqueo,
      })
    console.log(
      '--- [DENTRO VENTANA] crear ticket excepcion dateo ---',
      resTicket.status(),
      JSON.stringify(resTicket.body())
    )
    resTicket.assertStatus(201)
    const ticketId = resTicket.body().ticket.id as number
    assert.isTrue(
      resTicket.body().detalle.dentroVentana,
      'Snapshot al crear el ticket debe quedar dentroVentana=true'
    )

    // Saldo ANTES de aprobar — debe quedar exactamente igual después, sin
    // ningún movimiento CARGO nuevo.
    const saldoAntes = await SaldoPenalizacion.query().where('asesor_id', agenteTest.id).first()
    const saldoAntesValor = saldoAntes ? Number(saldoAntes.saldoActual) : 0

    // Aprobar SIN porcentaje_penalizacion en el body — el backend debe
    // ignorarlo/no exigirlo porque detalle.dentroVentana === true.
    const resAprobar = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})
    console.log(
      '--- [DENTRO VENTANA] aprobar ticket sin porcentaje ---',
      resAprobar.status(),
      JSON.stringify(resAprobar.body())
    )
    resAprobar.assertStatus(200)
    const aprobarBody = resAprobar.body()
    assert.equal(aprobarBody.ticket.estado, 'APROBADO')
    assert.isTrue(aprobarBody.dentroVentana)
    assert.exists(aprobarBody.dateoId)
    assert.exists(aprobarBody.comisionId, 'Debe generar comisión aunque no haya penalización')
    assert.equal(aprobarBody.montoCargoPenalizacion, 0, 'Sin penalización: el cargo debe ser 0')
    assert.isNull(
      aprobarBody.detalle.porcentajePenalizacion,
      'Sin penalización: porcentaje_penalizacion debe quedar null'
    )

    const dateoCreado = await CaptacionDateo.findOrFail(aprobarBody.dateoId)
    const turnoTrasAprobar = await TurnoRtm.findOrFail(turnoId)
    assert.equal(turnoTrasAprobar.captacionDateoId, dateoCreado.id, 'El turno debe quedar vinculado al dateo')
    assert.equal(dateoCreado.resultado, 'EXITOSO')

    const movCargo = await MovimientoPenalizacion.query()
      .where('ticket_id', ticketId)
      .where('tipo', 'CARGO')
      .first()
    assert.isNull(movCargo, 'No debe crearse ningún movimiento CARGO para un ticket dentro de ventana')

    const saldoDespues = await SaldoPenalizacion.query().where('asesor_id', agenteTest.id).first()
    const saldoDespuesValor = saldoDespues ? Number(saldoDespues.saldoActual) : 0
    assert.equal(saldoDespuesValor, saldoAntesValor, 'El saldo de penalizaciones no debe moverse')
  }).timeout(60000)
})
