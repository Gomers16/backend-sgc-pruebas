import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Usuario from '#models/usuario'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import Comision from '#models/comision'
import Database from '@adonisjs/lucid/services/db'

const PLACA_1 = 'TST997'
const PLACA_2 = 'TST996'
const AGENTE_ID = 1
const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const SERVICIO_RTM_ID = 1
const SERVICIO_SOAT_ID = 4

test.group('E2E manual - fix mismatch servicio dateo<->turno', (group) => {
  let usuarioTest: Usuario
  let token: string

  group.setup(async () => {
    usuarioTest = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'E2E-SCRIPT',
      correo: `test.e2e.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuarioTest)
    token = tokenObj.value!.release()
    console.log('--- SETUP: usuario de prueba creado id=', usuarioTest.id, 'token generado ---')
  })

  group.teardown(async () => {
    console.log('--- TEARDOWN: limpiando datos de prueba ---')
    await Database.rawQuery(
      "DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (?, ?))",
      [PLACA_1, PLACA_2]
    )
    await Database.rawQuery('DELETE FROM turnos_rtms WHERE placa IN (?, ?)', [PLACA_1, PLACA_2])
    await Database.rawQuery('DELETE FROM captacion_dateos WHERE placa IN (?, ?)', [PLACA_1, PLACA_2])
    await Database.rawQuery('DELETE FROM vehiculos WHERE placa IN (?, ?)', [PLACA_1, PLACA_2])
    if (usuarioTest) await usuarioTest.delete()
    console.log('--- TEARDOWN: completo ---')
  })

  test('PRUEBA 1 y 2: dateo RTM no se consume por turno SOAT, pero SI por turno RTM', async ({
    client,
    assert,
  }) => {
    // ===== PRUEBA 1, paso 1: crear dateo RTM =====
    const resDateo = await client
      .post('/api/captacion-dateos')
      .header('Authorization', `Bearer ${token}`)
      .json({
        canal: 'ASESOR',
        agente_id: AGENTE_ID,
        placa: PLACA_1,
        servicio_id: SERVICIO_RTM_ID,
        origen: 'UI',
      })

    console.log('--- PRUEBA 1: respuesta creación dateo ---', resDateo.status(), JSON.stringify(resDateo.body()))
    resDateo.assertStatus(201)
    const dateoId = resDateo.body().id
    assert.exists(dateoId)

    const dateoAntes = await CaptacionDateo.query().where('id', dateoId).firstOrFail()
    console.log('--- PRUEBA 1: dateo recien creado (ANTES de crear turno SOAT) ---', JSON.stringify({
      id: dateoAntes.id,
      resultado: dateoAntes.resultado,
      servicioId: dateoAntes.servicioId,
      consumidoTurnoId: dateoAntes.consumidoTurnoId,
    }))
    assert.equal(dateoAntes.resultado, 'PENDIENTE')

    // ===== PRUEBA 1, paso 2: crear turno SOAT para la misma placa =====
    const hoy = DateTime.local().setZone('America/Bogota')
    const resTurnoSoat = await client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa: PLACA_1,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarioTest.id,
        fecha: hoy.toISODate(),
        horaIngreso: hoy.toFormat('HH:mm:ss'),
        servicioId: SERVICIO_SOAT_ID,
      })

    console.log('--- PRUEBA 1: respuesta creación turno SOAT ---', resTurnoSoat.status(), JSON.stringify(resTurnoSoat.body()))
    resTurnoSoat.assertStatus(201)
    const turnoSoatId = resTurnoSoat.body().id ?? resTurnoSoat.body().turno?.id
    assert.exists(turnoSoatId)

    const turnoSoat = await TurnoRtm.query().where('id', turnoSoatId).firstOrFail()
    const dateoDespuesSoat = await CaptacionDateo.query().where('id', dateoId).firstOrFail()

    console.log('--- PRUEBA 1: ESTADO DESPUES DEL TURNO SOAT ---')
    console.log('turno SOAT:', JSON.stringify({
      id: turnoSoat.id,
      servicioId: turnoSoat.servicioId,
      captacionDateoId: turnoSoat.captacionDateoId,
      agenteCaptacionId: turnoSoat.agenteCaptacionId,
      canalAtribucion: turnoSoat.canalAtribucion,
      estado: turnoSoat.estado,
    }))
    console.log('dateo (debe seguir igual que antes):', JSON.stringify({
      id: dateoDespuesSoat.id,
      resultado: dateoDespuesSoat.resultado,
      consumidoTurnoId: dateoDespuesSoat.consumidoTurnoId,
      consumidoAt: dateoDespuesSoat.consumidoAt,
    }))

    // Aserciones PRUEBA 1
    assert.equal(dateoDespuesSoat.resultado, 'PENDIENTE', 'PRUEBA 1 FALLO: el dateo dejo de estar PENDIENTE')
    assert.isNull(dateoDespuesSoat.consumidoTurnoId, 'PRUEBA 1 FALLO: el dateo quedo con consumidoTurnoId seteado')
    assert.isNull(turnoSoat.captacionDateoId, 'PRUEBA 1 FALLO: el turno SOAT quedo vinculado al dateo RTM')
    assert.notEqual(
      turnoSoat.agenteCaptacionId,
      AGENTE_ID,
      'PRUEBA 1 FALLO: el turno heredo agenteCaptacionId del dateo'
    )

    // ===== PRUEBA 2: crear turno RTM (mismo servicio que el dateo) para la misma placa =====
    const resTurnoRtm = await client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa: PLACA_1,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarioTest.id,
        fecha: hoy.toISODate(),
        horaIngreso: hoy.toFormat('HH:mm:ss'),
        servicioId: SERVICIO_RTM_ID,
      })

    console.log('--- PRUEBA 2: respuesta creacion turno RTM ---', resTurnoRtm.status(), JSON.stringify(resTurnoRtm.body()))
    resTurnoRtm.assertStatus(201)
    const turnoRtmId = resTurnoRtm.body().id ?? resTurnoRtm.body().turno?.id
    assert.exists(turnoRtmId)

    const turnoRtm = await TurnoRtm.query().where('id', turnoRtmId).firstOrFail()
    const dateoDespuesRtm = await CaptacionDateo.query().where('id', dateoId).firstOrFail()

    console.log('--- PRUEBA 2: ESTADO DESPUES DEL TURNO RTM ---')
    console.log('turno RTM:', JSON.stringify({
      id: turnoRtm.id,
      servicioId: turnoRtm.servicioId,
      captacionDateoId: turnoRtm.captacionDateoId,
      agenteCaptacionId: turnoRtm.agenteCaptacionId,
      canalAtribucion: turnoRtm.canalAtribucion,
      estado: turnoRtm.estado,
    }))
    console.log('dateo (debe quedar vinculado, EN_PROCESO/consumido):', JSON.stringify({
      id: dateoDespuesRtm.id,
      resultado: dateoDespuesRtm.resultado,
      consumidoTurnoId: dateoDespuesRtm.consumidoTurnoId,
      consumidoAt: dateoDespuesRtm.consumidoAt,
    }))

    // Aserciones PRUEBA 2 (caso feliz: el turno del MISMO servicio SI debe vincularse)
    assert.equal(
      turnoRtm.captacionDateoId,
      dateoId,
      'PRUEBA 2 FALLO: el turno RTM no quedo vinculado al dateo (regresion en el caso feliz)'
    )
    assert.equal(
      dateoDespuesRtm.consumidoTurnoId,
      turnoRtmId,
      'PRUEBA 2 FALLO: el dateo no quedo marcado como consumido por el turno RTM'
    )
    assert.equal(
      dateoDespuesRtm.resultado,
      'EN_PROCESO',
      'PRUEBA 2: resultado tras la creacion del turno (EXITOSO requiere un paso de negocio adicional, ver reporte)'
    )

    // Buscar si ya existe alguna comision (no deberia haberla todavia, EXITOSO no se dispara en la creacion)
    const comisionesTrasCreacion = await Comision.query().where('captacion_dateo_id', dateoId)
    console.log('--- PRUEBA 2: comisiones existentes tras solo crear el turno (esperado: 0) ---', comisionesTrasCreacion.length)
  })

  test('PRUEBA 3: exclusividad de POST /captacion-dateos es por placa+servicio', async ({
    client,
    assert,
  }) => {
    // Paso 1: crear dateo RTM para PLACA_2
    const res1 = await client
      .post('/api/captacion-dateos')
      .header('Authorization', `Bearer ${token}`)
      .json({
        canal: 'ASESOR',
        agente_id: AGENTE_ID,
        placa: PLACA_2,
        servicio_id: SERVICIO_RTM_ID,
        origen: 'UI',
      })
    console.log('--- PRUEBA 3, paso 1 (dateo RTM #1) ---', res1.status(), JSON.stringify(res1.body()))
    res1.assertStatus(201)
    const dateo1Id = res1.body().id

    // Paso 2: segundo dateo, MISMA placa, servicio SOAT -> debe permitirse (sin 409)
    const res2 = await client
      .post('/api/captacion-dateos')
      .header('Authorization', `Bearer ${token}`)
      .json({
        canal: 'ASESOR',
        agente_id: AGENTE_ID,
        placa: PLACA_2,
        servicio_id: SERVICIO_SOAT_ID,
        origen: 'UI',
      })
    console.log('--- PRUEBA 3, paso 2 (dateo SOAT, control POSITIVO, debe ser 201) ---', res2.status(), JSON.stringify(res2.body()))

    // Paso 3 (control negativo): tercer dateo, MISMA placa, MISMO servicio RTM -> debe fallar 409
    const res3 = await client
      .post('/api/captacion-dateos')
      .header('Authorization', `Bearer ${token}`)
      .json({
        canal: 'ASESOR',
        agente_id: AGENTE_ID,
        placa: PLACA_2,
        servicio_id: SERVICIO_RTM_ID,
        origen: 'UI',
      })
    console.log('--- PRUEBA 3, paso 3 (dateo RTM #2 duplicado, control NEGATIVO, debe ser 409) ---', res3.status(), JSON.stringify(res3.body()))

    const dateosFinal = await CaptacionDateo.query().where('placa', PLACA_2)
    console.log('--- PRUEBA 3: estado final de dateos con placa', PLACA_2, '---', JSON.stringify(
      dateosFinal.map((d) => ({ id: d.id, servicioId: d.servicioId, resultado: d.resultado }))
    ))

    assert.equal(res2.status(), 201, 'PRUEBA 3 (control positivo) FALLO: SOAT fue bloqueado por el RTM existente')
    assert.equal(res3.status(), 409, 'PRUEBA 3 (control negativo) FALLO: el segundo RTM NO fue bloqueado (se rompio el bloqueo legitimo)')
    assert.equal(
      res3.body().dateoId,
      dateo1Id,
      'PRUEBA 3 (control negativo) FALLO: el 409 no apunta al dateo RTM #1 (bloqueo por razon distinta a la esperada)'
    )
    assert.equal(dateosFinal.length, 2, 'Deberian existir exactamente 2 dateos para la placa (RTM + SOAT), el tercer intento no debio crear nada')
  })
})
