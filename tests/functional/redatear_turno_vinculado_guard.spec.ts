import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Usuario from '#models/usuario'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import Database from '@adonisjs/lucid/services/db'

// Regresión: fuga de re-dateo cuando el dateo ya tiene un turno vinculado
// (guard nuevo en captacion_dateos_controller.ts::redatear() y
// verificarVencidos()). Ver MAPA_DEL_SISTEMA_BACKEND.md para el reporte
// original del bug (comercial re-dateó y el dateo quedó anexado en
// silencio al turno que ya existía).

const PLACA_SIN_TURNO = 'TST981'
const PLACA_TURNO_ACTIVO = 'TST982'
const PLACA_TURNO_CANCELADO = 'TST983'
const PLACA_VENCIDOS_ACTIVO = 'TST984'
const AGENTE_ID = 1
const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const SERVICIO_RTM_ID = 1

const PLACAS = [PLACA_SIN_TURNO, PLACA_TURNO_ACTIVO, PLACA_TURNO_CANCELADO, PLACA_VENCIDOS_ACTIVO]

let turnoCodigoSeq = 0
function nextTurnoCodigo() {
  turnoCodigoSeq += 1
  return `TST-GUARD-${Date.now()}-${turnoCodigoSeq}`
}

test.group('Guard: no permitir re-dateo si el dateo ya tiene un turno vinculado', (group) => {
  let usuarioTest: Usuario
  let token: string
  let turnoNumeroSeq = 900000

  group.setup(async () => {
    usuarioTest = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'GUARD-REDATEAR',
      correo: `test.guard.redatear.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuarioTest)
    token = tokenObj.value!.release()
  })

  group.teardown(async () => {
    await Database.rawQuery('DELETE FROM turnos_rtms WHERE placa IN (?, ?, ?, ?)', PLACAS)
    await Database.rawQuery('DELETE FROM captacion_dateos WHERE placa IN (?, ?, ?, ?)', PLACAS)
    if (usuarioTest) await usuarioTest.delete()
  })

  async function crearDateoEnRedatear(placa: string) {
    return CaptacionDateo.create({
      canal: 'ASESOR_COMERCIAL',
      origen: 'UI',
      agenteId: AGENTE_ID,
      servicioId: SERVICIO_RTM_ID,
      placa,
      resultado: 'RE_DATEAR',
      liberado: true,
      numeroRedateosUsados: 0,
      limiteAlcanzado: false,
    } as any)
  }

  async function crearTurnoVinculado(dateoId: number, placa: string, estado: TurnoRtm['estado']) {
    turnoNumeroSeq += 1
    return TurnoRtm.create({
      funcionarioId: usuarioTest.id,
      sedeId: SEDE_ID,
      servicioId: SERVICIO_RTM_ID,
      fecha: DateTime.local().setZone('America/Bogota'),
      horaIngreso: DateTime.local().setZone('America/Bogota').toFormat('HH:mm:ss'),
      turnoNumero: turnoNumeroSeq,
      turnoNumeroServicio: turnoNumeroSeq,
      turnoCodigo: nextTurnoCodigo(),
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado,
      captacionDateoId: dateoId,
    } as any)
  }

  test('(a) sin turno vinculado -> permite re-datear normalmente', async ({ client, assert }) => {
    const dateo = await crearDateoEnRedatear(PLACA_SIN_TURNO)

    const res = await client
      .post(`/api/captacion-dateos/${dateo.id}/redatear`)
      .header('Authorization', `Bearer ${token}`)
      .json({ evidencia_url: '/uploads/dateos/test-evidencia-a.jpg' })

    console.log('--- (a) sin turno vinculado ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(200)

    const dateoDespues = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(dateoDespues.resultado, 'PENDIENTE', '(a) FALLO: no volvió a PENDIENTE')
    assert.equal(dateoDespues.numeroRedateosUsados, 1, '(a) FALLO: no incrementó el contador')
  })

  test('(b) turno vinculado ACTIVO -> rechaza con 409 explícito', async ({ client, assert }) => {
    const dateo = await crearDateoEnRedatear(PLACA_TURNO_ACTIVO)
    const turno = await crearTurnoVinculado(dateo.id, PLACA_TURNO_ACTIVO, 'activo')

    const res = await client
      .post(`/api/captacion-dateos/${dateo.id}/redatear`)
      .header('Authorization', `Bearer ${token}`)
      .json({ evidencia_url: '/uploads/dateos/test-evidencia-b.jpg' })

    console.log('--- (b) turno vinculado ACTIVO ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(409)
    assert.include(res.body().message, 'ya tiene un turno vinculado')
    assert.equal(res.body().turnoId, turno.id)

    const dateoDespues = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(
      dateoDespues.resultado,
      'RE_DATEAR',
      '(b) FALLO: el dateo cambió de estado pese al rechazo'
    )
    assert.equal(dateoDespues.numeroRedateosUsados, 0, '(b) FALLO: incrementó el contador igual')
  })

  test('(b2) turno vinculado FINALIZADO -> rechaza con 409 explícito', async ({
    client,
    assert,
  }) => {
    const dateo = await crearDateoEnRedatear('TST985')
    await crearTurnoVinculado(dateo.id, 'TST985', 'finalizado')

    const res = await client
      .post(`/api/captacion-dateos/${dateo.id}/redatear`)
      .header('Authorization', `Bearer ${token}`)
      .json({ evidencia_url: '/uploads/dateos/test-evidencia-b2.jpg' })

    console.log('--- (b2) turno vinculado FINALIZADO ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(409)
    assert.include(res.body().message, 'ya tiene un turno vinculado')

    await Database.rawQuery('DELETE FROM turnos_rtms WHERE placa = ?', ['TST985'])
    await Database.rawQuery('DELETE FROM captacion_dateos WHERE placa = ?', ['TST985'])
  })

  test('(c) único turno vinculado CANCELADO -> permite re-datear (no romper flujo legítimo)', async ({
    client,
    assert,
  }) => {
    const dateo = await crearDateoEnRedatear(PLACA_TURNO_CANCELADO)
    await crearTurnoVinculado(dateo.id, PLACA_TURNO_CANCELADO, 'cancelado')

    const res = await client
      .post(`/api/captacion-dateos/${dateo.id}/redatear`)
      .header('Authorization', `Bearer ${token}`)
      .json({ evidencia_url: '/uploads/dateos/test-evidencia-c.jpg' })

    console.log('--- (c) turno vinculado CANCELADO ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(200)

    const dateoDespues = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(dateoDespues.resultado, 'PENDIENTE', '(c) FALLO: no volvió a PENDIENTE')
    assert.equal(dateoDespues.numeroRedateosUsados, 1, '(c) FALLO: no incrementó el contador')
  })

  test('(d) verificarVencidos() no flipa a RE_DATEAR un dateo con turno ACTIVO vinculado', async ({
    client,
    assert,
  }) => {
    // Dateo "huérfano en apariencia": PENDIENTE, sin consumidoTurnoId, pero
    // con un turno ACTIVO que ya lo referencia por captacion_dateo_id (el
    // escenario de carrera descrito en el reporte).
    const dateo = await CaptacionDateo.create({
      canal: 'ASESOR_COMERCIAL',
      origen: 'UI',
      agenteId: AGENTE_ID,
      servicioId: SERVICIO_RTM_ID,
      placa: PLACA_VENCIDOS_ACTIVO,
      resultado: 'PENDIENTE',
      liberado: false,
      // Vencido de sobra para cualquier horasExclusividad configurada.
      createdAt: DateTime.local().minus({ days: 30 }),
    } as any)
    await crearTurnoVinculado(dateo.id, PLACA_VENCIDOS_ACTIVO, 'activo')

    const res = await client
      .post('/api/captacion-dateos/verificar-vencidos')
      .header('Authorization', `Bearer ${token}`)

    console.log('--- (d) verificar-vencidos con turno ACTIVO vinculado ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(200)

    const dateoDespues = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(
      dateoDespues.resultado,
      'PENDIENTE',
      '(d) FALLO: verificarVencidos() flipó a RE_DATEAR un dateo con turno activo vinculado'
    )
    assert.equal(
      Boolean(dateoDespues.liberado),
      false,
      '(d) FALLO: se liberó pese al turno activo vinculado'
    )
  })
})
