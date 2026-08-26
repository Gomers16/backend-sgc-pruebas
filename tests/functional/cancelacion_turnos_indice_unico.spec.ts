import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Database from '@adonisjs/lucid/services/db'

// Verificación manual del fix de la migración
// 1787000000007_add_turno_numero_activo_unique_to_turnos_rtms_table.
// Reproduce el caso real (turnos 59489/59531): dos turnos que en momentos
// distintos ocuparon el mismo turno_numero positivo, ambos cancelados,
// compitiendo por el mismo valor negativo.

const PLACA_CANCELADO_PREVIO = 'TST925'
const PLACA_A_CANCELAR = 'TST926'
const PLACA_NUEVO_TURNO = 'TST927'
const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN_ID = 9
const NUMERO_COMPARTIDO = 25
const NUMERO_SERVICIO_COMPARTIDO = 21

test.group('Verificación fix cancelación turnos_rtms (colisión índice único)', (group) => {
  let usuarioTest: Usuario
  let token: string
  let hoy: DateTime
  let hoyISO: string
  let turnoCanceladoPrevioId: number
  let turnoACancelarId: number

  group.setup(async () => {
    usuarioTest = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'CANCELAR-FIX',
      correo: `test.cancelar.fix.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuarioTest)
    token = tokenObj.value!.release()
    hoy = DateTime.local().setZone('America/Bogota')
    hoyISO = hoy.toISODate()!
    console.log('--- SETUP: usuario de prueba id=', usuarioTest.id, 'fecha=', hoyISO, '---')

    // Turno A: ya cancelado, ocupando el slot -25 / -21 (simula un turno
    // previo, distinto del que vamos a cancelar en el test, que ya se
    // quedó con ese negativo)
    const turnoCanceladoPrevio = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuarioTest.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: hoy,
      horaIngreso: '08:00',
      tieneFacturacion: false,
      turnoNumero: -NUMERO_COMPARTIDO,
      turnoNumeroServicio: -NUMERO_SERVICIO_COMPARTIDO,
      turnoCodigo: 'TST-CANCEL-FIX-PREVIO',
      placa: PLACA_CANCELADO_PREVIO,
      tipoVehiculo: 'Liviano Particular',
      estado: 'cancelado',
      motivoCancelacion: 'Cancelado previamente en prueba automatizada',
      canceladoPorId: usuarioTest.id,
      canceladoAt: DateTime.local().setZone('America/Bogota'),
    } as any)
    turnoCanceladoPrevioId = turnoCanceladoPrevio.id

    // Turno B: activo, con el MISMO número (25/21) que el turno A tuvo
    // alguna vez antes de cancelarse — es el que vamos a cancelar en el
    // test para reproducir el choque.
    const turnoACancelar = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuarioTest.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: hoy,
      horaIngreso: '09:00',
      tieneFacturacion: false,
      turnoNumero: NUMERO_COMPARTIDO,
      turnoNumeroServicio: NUMERO_SERVICIO_COMPARTIDO,
      turnoCodigo: 'TST-CANCEL-FIX-ACTIVO',
      placa: PLACA_A_CANCELAR,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
    } as any)
    turnoACancelarId = turnoACancelar.id

    console.log('--- SETUP: turno previo cancelado id=', turnoCanceladoPrevioId,
      'turno a cancelar id=', turnoACancelarId, '---')
  })

  group.teardown(async () => {
    console.log('--- TEARDOWN: limpiando datos de prueba ---')
    await Database.rawQuery('DELETE FROM turnos_rtms WHERE placa IN (?, ?, ?)', [
      PLACA_CANCELADO_PREVIO,
      PLACA_A_CANCELAR,
      PLACA_NUEVO_TURNO,
    ])
    if (usuarioTest) await usuarioTest.delete()
    console.log('--- TEARDOWN: completo ---')
  })

  test('PASO 3: cancelar un turno cuyo slot ya fue usado por otro cancelado no debe dar 500', async ({
    client,
    assert,
  }) => {
    const resCancelar = await client
      .patch(`/api/turnos-rtm/${turnoACancelarId}/cancelar`)
      .header('Authorization', `Bearer ${token}`)
      .json({
        usuarioId: usuarioTest.id,
        motivoCancelacion: 'Prueba automatizada de fix de colisión de índice único',
      })

    console.log('--- PASO 3: respuesta PATCH /cancelar ---', resCancelar.status(), JSON.stringify(resCancelar.body()))
    resCancelar.assertStatus(200)

    const turnoCancelado = await TurnoRtm.query().where('id', turnoACancelarId).firstOrFail()
    const turnoPrevio = await TurnoRtm.query().where('id', turnoCanceladoPrevioId).firstOrFail()

    console.log('--- PASO 3: estado final en BD ---', JSON.stringify({
      turnoRecienCancelado: {
        id: turnoCancelado.id,
        estado: turnoCancelado.estado,
        turnoNumero: turnoCancelado.turnoNumero,
        turnoNumeroServicio: turnoCancelado.turnoNumeroServicio,
      },
      turnoPreviamenteCancelado: {
        id: turnoPrevio.id,
        estado: turnoPrevio.estado,
        turnoNumero: turnoPrevio.turnoNumero,
        turnoNumeroServicio: turnoPrevio.turnoNumeroServicio,
      },
    }))

    assert.equal(turnoCancelado.estado, 'cancelado')
    assert.equal(turnoCancelado.turnoNumero, -NUMERO_COMPARTIDO)
    assert.equal(turnoCancelado.turnoNumeroServicio, -NUMERO_SERVICIO_COMPARTIDO)
    // Ambos turnos cancelados AHORA comparten el mismo turno_numero negativo
    // -25 en la misma sede+fecha. Antes del fix esto era imposible (violaba
    // uq_turno_por_dia_y_sede); con el fix conviven sin error porque la
    // columna generada turno_numero_activo es NULL para ambos.
    assert.equal(turnoPrevio.turnoNumero, turnoCancelado.turnoNumero)
  })

  test('PASO 4.1: GET /siguiente-turno sigue calculando el hueco liberado', async ({
    client,
    assert,
  }) => {
    const res = await client
      .get('/api/turnos-rtm/siguiente-turno')
      .header('Authorization', `Bearer ${token}`)
      .qs({ usuarioId: usuarioTest.id, servicioId: SERVICIO_RTM_ID })

    console.log('--- PASO 4.1: respuesta GET /siguiente-turno ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(200)
    assert.equal(res.body().siguiente, NUMERO_COMPARTIDO)
    assert.equal(res.body().siguientePorServicio, NUMERO_SERVICIO_COMPARTIDO)
  })

  test('PASO 4.2: POST /turnos-rtm reutiliza el hueco liberado al crear un turno nuevo', async ({
    client,
    assert,
  }) => {
    const res = await client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa: PLACA_NUEVO_TURNO,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarioTest.id,
        fecha: hoyISO,
        horaIngreso: hoy.toFormat('HH:mm:ss'),
        servicioId: SERVICIO_RTM_ID,
      })

    console.log('--- PASO 4.2: respuesta POST /turnos-rtm ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(201)

    const nuevoId = res.body().id ?? res.body().turno?.id
    const nuevoTurno = await TurnoRtm.query().where('id', nuevoId).firstOrFail()
    console.log('--- PASO 4.2: turno nuevo creado ---', JSON.stringify({
      id: nuevoTurno.id,
      turnoNumero: nuevoTurno.turnoNumero,
      turnoNumeroServicio: nuevoTurno.turnoNumeroServicio,
      reasignadoDeTurnoId: (nuevoTurno as any).reasignadoDeTurnoId,
    }))

    assert.equal(nuevoTurno.turnoNumero, NUMERO_COMPARTIDO, 'debió reutilizar el hueco global liberado (25)')
    assert.equal(
      nuevoTurno.turnoNumeroServicio,
      NUMERO_SERVICIO_COMPARTIDO,
      'debió reutilizar el hueco por servicio liberado (21)'
    )
  })
})
