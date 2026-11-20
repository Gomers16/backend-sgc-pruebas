import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import { conSede } from '#services/sede_scope'
import { obtenerResumenContable } from '#services/resumen_contable_service'
import { invalidarCacheSedes } from '#middleware/sede_activa_middleware'

// Multi-sede Fase 4 — una prueba por familia de reportes: otra sede no ve,
// la sede propia queda igual y "todas" suma las sedes permitidas.
// Ibagué (1) contra PRUEBAS QA (3), con datos de enero de 2032 (sin datos
// reales). QA está inactiva: para probar "todas" se ACTIVA durante el test y
// se restaura al final (no se crean datos de Bogotá).

const IBAGUE = 1
const QA = 3
const RTM = 1
const MARCA = 'test.ms4.'
const FECHA = '2032-01-10'
const R = { fecha_inicio: '2032-01-01', fecha_fin: '2032-01-31' }

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS4 ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } }
}

async function limpiar() {
  const ts = await Database.from('turnos_rtms').where('placa', 'like', 'MS4%').select('id')
  const ids = ts.map((t: any) => t.id)
  if (ids.length) await Database.from('facturacion_tickets').whereIn('turno_id', ids).delete()
  await Database.from('turnos_rtms').where('placa', 'like', 'MS4%').delete()
  await Database.from('configuracion_meta_mensual').where({ mes: 1, anio: 2032 }).delete()
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const uIds = us.map((u: any) => u.id)
  if (uIds.length) {
    await Database.from('auth_access_tokens').whereIn('tokenable_id', uIds).delete()
    await Database.from('usuarios').whereIn('id', uIds).delete()
  }
}

let seq = 0
async function turnoFacturado(
  sedeId: number,
  funcionarioId: number,
  total: number,
  estado = 'finalizado'
) {
  seq++
  const t = await TurnoRtm.create({
    sedeId,
    funcionarioId,
    servicioId: RTM,
    fecha: DateTime.fromISO(FECHA),
    horaIngreso: '08:00:00',
    placa: `MS4${sedeId}${String(seq).padStart(3, '0')}`,
    tipoVehiculo: 'Liviano Particular',
    turnoNumero: -9400 - seq,
    turnoNumeroServicio: -9400 - seq,
    turnoCodigo: `MS4-${sedeId}-${seq}-${Date.now()}`,
    estado,
  } as any)
  if (estado === 'finalizado') {
    await Database.table('facturacion_tickets').insert({
      sede_id: sedeId,
      hash: `MS4-${t.id}`,
      file_path: 'x',
      estado: 'CONFIRMADA',
      servicio_codigo: 'RTM',
      turno_id: t.id,
      placa: t.placa,
      total,
      subtotal: total,
      created_at: `${FECHA} 09:00:00`,
      updated_at: `${FECHA} 09:00:00`,
    })
  }
}

test.group('Multi-sede Fase 4 · reportes por familia', (group) => {
  group.each.timeout(120_000)
  let gerA: Awaited<ReturnType<typeof actor>>
  let gerB: Awaited<ReturnType<typeof actor>>
  let activoQaOriginal: number

  group.setup(async () => {
    await limpiar()
    activoQaOriginal = Number((await Database.from('sedes').where('id', QA).first()).activo)
    gerA = await actor('GERENCIA', IBAGUE)
    gerB = await actor('GERENCIA', QA)
    for (const total of [100000, 100000]) await turnoFacturado(IBAGUE, gerA.id, total)
    for (const total of [50000, 50000, 50000]) await turnoFacturado(QA, gerB.id, total)
    await turnoFacturado(IBAGUE, gerA.id, 0, 'activo')
    for (let i = 0; i < 2; i++) await turnoFacturado(QA, gerB.id, 0, 'activo')
    await Database.table('configuracion_meta_mensual').multiInsert([
      {
        sede_id: IBAGUE,
        mes: 1,
        anio: 2032,
        meta_livianos: 10,
        meta_motos: 5,
        pct_crecimiento_referencia: 4,
      },
      {
        sede_id: QA,
        mes: 1,
        anio: 2032,
        meta_livianos: 3,
        meta_motos: 2,
        pct_crecimiento_referencia: 2,
      },
    ])
  })
  group.teardown(async () => {
    await Database.from('sedes').where('id', QA).update({ activo: activoQaOriginal })
    invalidarCacheSedes()
    await limpiar()
  })

  const sumaPorSede = (body: any) =>
    (body.por_sede as any[]).reduce(
      (a, s) => ({ vehiculos: a.vehiculos + s.vehiculos, total: a.total + s.total_bruto }),
      { vehiculos: 0, total: 0 }
    )

  test('producción por sede (facturación + turnos): aislada y "todas" suma', async ({
    client,
    assert,
  }) => {
    const ib = await client
      .get('/api/reportes-admin/produccion-lider')
      .qs(R)
      .headers({ ...gerA.h })
    const qa = await client.get('/api/reportes-admin/produccion-lider').qs(R).headers(gerB.h)
    assert.equal(ib.status(), 200, JSON.stringify(ib.body()))
    assert.deepEqual(sumaPorSede(ib.body()), { vehiculos: 2, total: 200000 })
    assert.deepEqual(sumaPorSede(qa.body()), { vehiculos: 3, total: 150000 })

    await Database.from('sedes').where('id', QA).update({ activo: 1 })
    invalidarCacheSedes()
    const todas = await client
      .get('/api/reportes-admin/produccion-lider')
      .qs(R)
      .headers({ ...gerA.h, 'X-Sede-Id': 'todas' })
    await Database.from('sedes').where('id', QA).update({ activo: activoQaOriginal })
    invalidarCacheSedes()
    assert.deepEqual(sumaPorSede(todas.body()), { vehiculos: 5, total: 350000 })
  })

  test('metas mensuales: la de cada sede; "todas" suma metas sin crear filas', async ({
    client,
    assert,
  }) => {
    const cfg = (h: Record<string, string>) =>
      client.get('/api/reportes-admin/meta-mensual/config').qs({ mes: 1, anio: 2032 }).headers(h)
    assert.equal((await cfg(gerA.h)).body().meta_total, 15)
    assert.equal((await cfg(gerB.h)).body().meta_total, 5)

    await Database.from('sedes').where('id', QA).update({ activo: 1 })
    invalidarCacheSedes()
    const todas = await cfg({ ...gerA.h, 'X-Sede-Id': 'todas' })
    await Database.from('sedes').where('id', QA).update({ activo: activoQaOriginal })
    invalidarCacheSedes()
    assert.equal(todas.body().meta_total, 20)
    assert.equal(todas.body().pct_crecimiento_referencia, 3)
    const filas = await Database.from('configuracion_meta_mensual').where({ mes: 1, anio: 2032 })
    assert.lengthOf(filas, 2, '"todas" no crea filas')

    const escribir = await client
      .post('/api/reportes-admin/meta-mensual/config')
      .headers({ ...gerA.h, 'X-Sede-Id': 'todas' })
      .json({ mes: 1, anio: 2032, meta_livianos: 1, meta_motos: 1 })
    assert.equal(escribir.status(), 400)
  })

  test('resumen contable (servicio): por sede y "todas" suma', async ({ assert }) => {
    const sinFinalizar = async (sedes: number[]) =>
      (await conSede(sedes, async () => obtenerResumenContable(R.fecha_inicio, R.fecha_fin)))
        .sin_finalizar
    assert.equal(await sinFinalizar([IBAGUE]), 1)
    assert.equal(await sinFinalizar([QA]), 2)
    assert.equal(await sinFinalizar([IBAGUE, QA]), 3)
  })
})
