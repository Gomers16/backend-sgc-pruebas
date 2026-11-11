import { test } from '@japa/runner'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import { resolverMetaAsesoresPeriodo } from '#services/meta_asesor_service'

// Meta por asesor en el Súper Informe y su coherencia con el resto de
// consumidores (Ficha / metas-mensuales, Meta Comercial resumen, diario,
// config). Todos leen meta_comercial_asesor vía meta_asesor_service.
// Meses aislados (2031, y 2020 como mes cerrado/histórico) para no chocar con
// datos reales. Escribe asesores TEST y sus filas de meta; limpieza completa.
//
//   A: 2031-03 = 40M / 10 veh · 2031-04 = 60M / sin veh · 2020-01 = 15M
//   B: 2031-03 = 20M / 5 veh  (sin fila en 2031-04)

const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9

test.group('Súper Informe · meta comercial por asesor', (group) => {
  group.each.timeout(60_000)

  let usuario: Usuario
  let token = ''
  let a: AgenteCaptacion
  let b: AgenteCaptacion
  let sinFila: AgenteCaptacion
  const auth = () => ({ Authorization: `Bearer ${token}` })

  function superInforme(client: any, fechaInicio: string, fechaFin: string) {
    return client
      .get('/api/reportes-admin/super-informe/meta-comercial')
      .headers(auth())
      .qs({ fecha_inicio: fechaInicio, fecha_fin: fechaFin })
  }
  const filaDe = (res: any, id: number) =>
    (res.body().asesores as any[]).find((x) => x.asesor_id === id)

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'SUPER-INFORME-META',
      correo: `test.si.meta.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const accessToken = await Usuario.accessTokens.create(usuario)
    token = accessToken.value!.release()

    const crear = (sufijo: string) =>
      AgenteCaptacion.create({
        tipo: 'ASESOR_COMERCIAL',
        nombre: `TEST SI META ${sufijo} ${Date.now()}`,
        activo: true,
      } as any)
    a = await crear('A')
    b = await crear('B')
    sinFila = await crear('C')

    await Database.table('meta_comercial_asesor').multiInsert([
      { asesor_id: a.id, mes: 3, anio: 2031, meta_pesos: 40000000, meta_vehiculos: 10 },
      { asesor_id: a.id, mes: 4, anio: 2031, meta_pesos: 60000000, meta_vehiculos: null },
      { asesor_id: a.id, mes: 1, anio: 2020, meta_pesos: 15000000, meta_vehiculos: null },
      { asesor_id: b.id, mes: 3, anio: 2031, meta_pesos: 20000000, meta_vehiculos: 5 },
    ])
  })

  group.teardown(async () => {
    const ids = [a?.id, b?.id, sinFila?.id].filter(Boolean) as number[]
    if (ids.length) await Database.from('meta_comercial_asesor').whereIn('asesor_id', ids).delete()
    for (const x of [a, b, sinFila]) if (x) await x.delete()
    if (usuario) await usuario.delete()
  })

  test('servicio: un mes → meta del mes; asesor sin fila no aparece', async ({ assert }) => {
    const metas = await resolverMetaAsesoresPeriodo(
      [a.id, b.id, sinFila.id],
      '2031-03-01',
      '2031-03-31'
    )
    assert.deepEqual(metas.get(a.id), {
      metaPesos: 40000000,
      metaVehiculos: 10,
      completa: true,
      mesesConMeta: 1,
      mesesTotales: 1,
    })
    assert.equal(metas.get(b.id)?.metaPesos, 20000000)
    assert.isFalse(metas.has(sinFila.id))
  })

  test('servicio: dos meses → suma solo si todos tienen fila, nunca parcial', async ({
    assert,
  }) => {
    const metas = await resolverMetaAsesoresPeriodo([a.id, b.id], '2031-03-15', '2031-04-10')
    // A: fila en ambos meses → suma en $; unidades null porque abril no tiene.
    assert.deepEqual(metas.get(a.id), {
      metaPesos: 100000000,
      metaVehiculos: null,
      completa: true,
      mesesConMeta: 2,
      mesesTotales: 2,
    })
    // B: sin fila en abril → nada sumado.
    assert.deepEqual(metas.get(b.id), {
      metaPesos: null,
      metaVehiculos: null,
      completa: false,
      mesesConMeta: 1,
      mesesTotales: 2,
    })
  })

  test('Súper Informe: fila con $ y unidades → ambas metas y columnas visibles', async ({
    client,
    assert,
  }) => {
    const res = await superInforme(client, '2031-03-01', '2031-03-31')
    res.assertStatus(200)
    const fa = filaDe(res, a.id)
    assert.equal(fa.meta_pesos, 40000000)
    assert.equal(fa.meta_vehiculos, 10)
    assert.isTrue(fa.tiene_meta)
    assert.isTrue(fa.meta_completa)
    assert.equal(fa.faltante_vehiculos, 10)
    assert.isTrue(res.body().hay_meta_vehiculos)
  })

  test('Súper Informe: fila con $ y sin unidades → meta $ sí, meta_vehiculos null y columnas ocultas', async ({
    client,
    assert,
  }) => {
    const res = await superInforme(client, '2031-04-01', '2031-04-30')
    res.assertStatus(200)
    const fa = filaDe(res, a.id)
    assert.equal(fa.meta_pesos, 60000000)
    assert.isNull(fa.meta_vehiculos)
    assert.isNull(fa.faltante_vehiculos)
    assert.isTrue(fa.tiene_meta)
    assert.isFalse(res.body().hay_meta_vehiculos)
    // B no tiene fila en abril ni actividad: no aparece.
    assert.isUndefined(filaDe(res, b.id))
  })

  test('Súper Informe: rango con un mes sin fila → meta null e incompleta, sin suma parcial', async ({
    client,
    assert,
  }) => {
    const res = await superInforme(client, '2031-03-01', '2031-04-30')
    res.assertStatus(200)
    const fb = filaDe(res, b.id)
    assert.isNull(fb.meta_pesos)
    assert.isNull(fb.meta_vehiculos)
    assert.isNull(fb.pct_avance)
    assert.isNull(fb.faltante)
    assert.isTrue(fb.tiene_meta)
    assert.isFalse(fb.meta_completa)
    const fa = filaDe(res, a.id)
    assert.equal(fa.meta_pesos, 100000000)
    assert.isTrue(fa.meta_completa)
    assert.isNull(fa.meta_vehiculos)
  })

  test('mes cerrado (histórico): la meta sigue saliendo de meta_comercial_asesor', async ({
    client,
    assert,
  }) => {
    const res = await superInforme(client, '2020-01-01', '2020-01-31')
    res.assertStatus(200)
    assert.equal(filaDe(res, a.id)?.meta_pesos, 15000000)

    const resumen = await client
      .get('/api/reportes-admin/meta-comercial/resumen')
      .headers(auth())
      .qs({ mes: 1, anio: 2020 })
    resumen.assertStatus(200)
    assert.equal(filaDe(resumen, a.id)?.meta_pesos, 15000000)
  })

  test('mismo valor en Súper Informe, metas-mensuales, resumen, diario y config', async ({
    client,
    assert,
  }) => {
    const si = await superInforme(client, '2031-03-01', '2031-03-31')
    const metasMensuales = await client
      .get('/api/comisiones/metas-mensuales')
      .headers(auth())
      .qs({ mes: '2031-03', asesorId: a.id })
    const resumen = await client
      .get('/api/reportes-admin/meta-comercial/resumen')
      .headers(auth())
      .qs({ mes: 3, anio: 2031 })
    const diario = await client
      .get('/api/reportes-admin/meta-comercial/diario')
      .headers(auth())
      .qs({ mes: 3, anio: 2031, asesor_id: a.id })
    const config = await client
      .get('/api/reportes-admin/meta-comercial/config')
      .headers(auth())
      .qs({ mes: 3, anio: 2031, asesor_id: a.id })
    const configTodos = await client
      .get('/api/reportes-admin/meta-comercial/config')
      .headers(auth())
      .qs({ mes: 3, anio: 2031 })

    for (const r of [si, metasMensuales, resumen, diario, config, configTodos]) r.assertStatus(200)

    const esperado = 40000000
    assert.equal(filaDe(si, a.id).meta_pesos, esperado)
    assert.equal(
      (metasMensuales.body().data as any[]).find((x) => x.asesor_id === a.id).meta_global_rtm,
      esperado
    )
    assert.equal(filaDe(resumen, a.id).meta_pesos, esperado)
    assert.equal(diario.body().meta_pesos, esperado)
    assert.equal(config.body().meta_pesos, esperado)
    assert.equal(config.body().meta_vehiculos, 10)
    const filaConfig = (configTodos.body().metas as any[]).find((x) => x.asesor_id === a.id)
    assert.deepEqual(filaConfig, { asesor_id: a.id, meta_pesos: esperado, meta_vehiculos: 10 })

    // Unidades: Súper Informe y resumen leen la misma columna.
    assert.equal(filaDe(si, a.id).meta_vehiculos, filaDe(resumen, a.id).meta_vehiculos)
  })

  test('asesor sin fila: null en todos los consumidores', async ({ client, assert }) => {
    const metasMensuales = await client
      .get('/api/comisiones/metas-mensuales')
      .headers(auth())
      .qs({ mes: '2031-03', asesorId: sinFila.id })
    const config = await client
      .get('/api/reportes-admin/meta-comercial/config')
      .headers(auth())
      .qs({ mes: 3, anio: 2031, asesor_id: sinFila.id })
    const diario = await client
      .get('/api/reportes-admin/meta-comercial/diario')
      .headers(auth())
      .qs({ mes: 3, anio: 2031, asesor_id: sinFila.id })
    assert.isNull(
      (metasMensuales.body().data as any[]).find((x) => x.asesor_id === sinFila.id).meta_global_rtm
    )
    assert.isNull(config.body().meta_pesos)
    assert.isNull(config.body().meta_vehiculos)
    assert.isNull(diario.body().meta_pesos)
  })

  test('PDF del Súper Informe se genera con y sin columnas de meta en unidades', async ({
    assert,
  }) => {
    for (const [ini, fin] of [
      ['2031-03-01', '2031-03-31'],
      ['2031-04-01', '2031-04-30'],
    ]) {
      const qs = new URLSearchParams({ fecha_inicio: ini, fecha_fin: fin })
      const r = await fetch(
        `http://${process.env.HOST}:${process.env.PORT}/api/reportes-admin/super-informe/pdf?${qs}`,
        { headers: auth() }
      )
      assert.equal(r.status, 200)
      const buf = Buffer.from(await r.arrayBuffer())
      assert.equal(buf.subarray(0, 4).toString(), '%PDF')
    }
  })
})
