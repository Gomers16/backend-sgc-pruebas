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
const PLACA_TURNO_SIN_DATEO_HOY = 'TST986'
const PLACA_SIN_TURNO_HOY_CONTROL = 'TST987'
const PLACA_TURNO_OTRO_SERVICIO = 'TST988'
const AGENTE_ID = 1
const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const SERVICIO_RTM_ID = 1
const SERVICIO_SOAT_ID = 4

const PLACAS = [
  PLACA_SIN_TURNO,
  PLACA_TURNO_ACTIVO,
  PLACA_TURNO_CANCELADO,
  PLACA_VENCIDOS_ACTIVO,
  PLACA_TURNO_SIN_DATEO_HOY,
  PLACA_SIN_TURNO_HOY_CONTROL,
  PLACA_TURNO_OTRO_SERVICIO,
]

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
    const placeholders = PLACAS.map(() => '?').join(', ')
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${placeholders})`, PLACAS)
    await Database.rawQuery(
      `DELETE FROM captacion_dateos WHERE placa IN (${placeholders})`,
      PLACAS
    )
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

  // Turno de HOY sin vincular a ningún dateo (captacion_dateo_id NULL) — el
  // caso real del bug GAY96H: el vehículo ya está en sede pero el turno no
  // quedó anexado a ESTE dateo, así que el guard de turnoVinculado no lo ve.
  async function crearTurnoSinDateo(
    placa: string,
    estado: TurnoRtm['estado'],
    servicioId: number = SERVICIO_RTM_ID
  ) {
    turnoNumeroSeq += 1
    return TurnoRtm.create({
      funcionarioId: usuarioTest.id,
      sedeId: SEDE_ID,
      servicioId,
      fecha: DateTime.local().setZone('America/Bogota'),
      horaIngreso: DateTime.local().setZone('America/Bogota').toFormat('HH:mm:ss'),
      turnoNumero: turnoNumeroSeq,
      turnoNumeroServicio: turnoNumeroSeq,
      turnoCodigo: nextTurnoCodigo(),
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado,
      captacionDateoId: null,
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

  // Regresión del bug GAY96H (2026-09-04): redatear() no repetía el chequeo
  // turnoSinDateoHoy que sí tiene store(), permitiendo re-datear un dateo
  // viejo aunque ya existiera un turno de hoy en sede sin vincular. Fix:
  // buscarTurnoSinDateoHoy() (reserva_dateo_service.ts), reutilizada en
  // ambos endpoints.

  test('(e) turno de HOY sin dateo vinculado, misma placa/servicio -> rechaza 409 REQUIERE_TICKET_DATEO', async ({
    client,
    assert,
  }) => {
    const dateo = await crearDateoEnRedatear(PLACA_TURNO_SIN_DATEO_HOY)
    const turno = await crearTurnoSinDateo(PLACA_TURNO_SIN_DATEO_HOY, 'activo')

    const res = await client
      .post(`/api/captacion-dateos/${dateo.id}/redatear`)
      .header('Authorization', `Bearer ${token}`)
      .json({ evidencia_url: '/uploads/dateos/test-evidencia-e.jpg' })

    console.log('--- (e) turno de hoy sin dateo vinculado ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(409)
    assert.equal(res.body().code, 'REQUIERE_TICKET_DATEO')
    assert.equal(res.body().turnoId, turno.id)

    const dateoDespues = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(
      dateoDespues.resultado,
      'RE_DATEAR',
      '(e) FALLO: el dateo cambió de estado pese al rechazo'
    )
    assert.equal(dateoDespues.numeroRedateosUsados, 0, '(e) FALLO: incrementó el contador igual')
  })

  test('(f) control: sin ningún turno de hoy para la placa/servicio -> permite re-datear normalmente', async ({
    client,
    assert,
  }) => {
    const dateo = await crearDateoEnRedatear(PLACA_SIN_TURNO_HOY_CONTROL)

    const res = await client
      .post(`/api/captacion-dateos/${dateo.id}/redatear`)
      .header('Authorization', `Bearer ${token}`)
      .json({ evidencia_url: '/uploads/dateos/test-evidencia-f.jpg' })

    console.log('--- (f) control sin turno de hoy ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(200)

    const dateoDespues = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(dateoDespues.resultado, 'PENDIENTE', '(f) FALLO: no volvió a PENDIENTE')
    assert.equal(dateoDespues.numeroRedateosUsados, 1, '(f) FALLO: no incrementó el contador')
  })

  test('(g) control: turno de hoy pero de OTRO servicio -> permite re-datear (filtro por servicio funciona)', async ({
    client,
    assert,
  }) => {
    const dateo = await crearDateoEnRedatear(PLACA_TURNO_OTRO_SERVICIO)
    await crearTurnoSinDateo(PLACA_TURNO_OTRO_SERVICIO, 'activo', SERVICIO_SOAT_ID)

    const res = await client
      .post(`/api/captacion-dateos/${dateo.id}/redatear`)
      .header('Authorization', `Bearer ${token}`)
      .json({ evidencia_url: '/uploads/dateos/test-evidencia-g.jpg' })

    console.log('--- (g) control turno de hoy otro servicio ---', res.status(), JSON.stringify(res.body()))
    res.assertStatus(200)

    const dateoDespues = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(dateoDespues.resultado, 'PENDIENTE', '(g) FALLO: no volvió a PENDIENTE')
    assert.equal(dateoDespues.numeroRedateosUsados, 1, '(g) FALLO: no incrementó el contador')
  })
})
