import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Database from '@adonisjs/lucid/services/db'

// Bug 1062 en POST /turnos-rtm: un turno cancelado que conservó su número
// POSITIVO (cancelado por PUT/estado, no por /cancelar) sigue ocupando
// uq_turno_numero_activo_por_dia_sede, pero el MAX de store() solo contaba
// activo/finalizado y volvía a proponer ese mismo número para todas las
// placas del día (caso real: turno 62252, turno_numero=23).

const PLACA_CANCELADO = 'TST931'
const PLACA_NUEVO = 'TST932'
const PLACA_CONC_A = 'TST933'
const PLACA_CONC_B = 'TST934'
const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN_ID = 9

test.group('POST /turnos-rtm: número de un cancelado con turno_numero positivo', (group) => {
  let usuarioTest: Usuario
  let token: string
  let hoy: DateTime
  let hoyISO: string
  let numeroQuemado: number
  let numeroSvcQuemado: number

  const crear = (client: any, placa: string) =>
    client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarioTest.id,
        fecha: hoyISO,
        horaIngreso: hoy.toFormat('HH:mm:ss'),
        servicioId: SERVICIO_RTM_ID,
      })

  group.setup(async () => {
    usuarioTest = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'NUMERO-QUEMADO',
      correo: `test.numero.quemado.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuarioTest)
    token = tokenObj.value!.release()
    hoy = DateTime.local().setZone('America/Bogota')
    hoyISO = hoy.toISODate()!

    // El cancelado ocupa justo el número que el código viejo proponía
    // (siguiente al máximo del día).
    const [rows] = await Database.rawQuery(
      `SELECT COALESCE(MAX(turno_numero), 0) AS g,
              COALESCE(MAX(CASE WHEN servicio_id = ? THEN turno_numero_servicio END), 0) AS s
       FROM turnos_rtms WHERE sede_id = ? AND fecha = ? AND turno_numero > 0`,
      [SERVICIO_RTM_ID, SEDE_ID, hoyISO]
    )
    numeroQuemado = Number(rows[0].g) + 1
    numeroSvcQuemado = Number(rows[0].s) + 1

    await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuarioTest.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: hoy,
      horaIngreso: '08:00',
      tieneFacturacion: false,
      turnoNumero: numeroQuemado,
      turnoNumeroServicio: numeroSvcQuemado,
      turnoCodigo: `TST-NUM-QUEMADO-${Date.now()}`,
      placa: PLACA_CANCELADO,
      tipoVehiculo: 'Liviano Particular',
      estado: 'cancelado',
    } as any)
  })

  group.teardown(async () => {
    await Database.rawQuery('DELETE FROM turnos_rtms WHERE placa IN (?, ?, ?, ?)', [
      PLACA_CANCELADO,
      PLACA_NUEVO,
      PLACA_CONC_A,
      PLACA_CONC_B,
    ])
    if (usuarioTest) await usuarioTest.delete()
  })

  test('crear después de un cancelado con número positivo no da ER_DUP_ENTRY', async ({
    client,
    assert,
  }) => {
    const res = await crear(client, PLACA_NUEVO)
    res.assertStatus(201)

    const nuevo = await TurnoRtm.findOrFail(res.body().id)
    assert.notEqual(nuevo.turnoNumero, numeroQuemado)
    assert.notEqual(nuevo.turnoNumeroServicio, numeroSvcQuemado)
  })

  test('dos creaciones concurrentes no duplican número', async ({ client, assert }) => {
    const [resA, resB] = await Promise.all([
      crear(client, PLACA_CONC_A),
      crear(client, PLACA_CONC_B),
    ])
    resA.assertStatus(201)
    resB.assertStatus(201)

    const a = await TurnoRtm.findOrFail(resA.body().id)
    const b = await TurnoRtm.findOrFail(resB.body().id)
    assert.notEqual(a.turnoNumero, b.turnoNumero)
    assert.notEqual(a.turnoNumeroServicio, b.turnoNumeroServicio)
  })
})
