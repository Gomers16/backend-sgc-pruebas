import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Comision from '#models/comision'

// GET /api/comisiones/metas-mensuales (Ficha Comercial y Comisiones → Metas):
// con `mes`, la meta sale de meta_comercial_asesor (asesor + mes + año), sin
// respaldo a comisiones.meta_rtm; sin `mes`, la respuesta queda como antes.
// Escribe en la BD compartida: asesor TEST, su config de comisión y sus filas
// de meta_comercial_asesor; limpieza completa al final.

const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const META_RTM_CONFIG = 7

test.group('Metas mensuales · meta del mes desde meta_comercial_asesor', (group) => {
  let usuario: Usuario
  let token: string
  let asesor: AgenteCaptacion
  let config: Comision

  function metasMensuales(client: any, query: Record<string, string | number>) {
    return client
      .get('/api/comisiones/metas-mensuales')
      .qs(query)
      .header('Authorization', `Bearer ${token}`)
  }

  function filaDe(res: any) {
    const rows = res.body().data as any[]
    return rows.find((r) => r.asesor_id === asesor.id)
  }

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'METAS-MENSUALES',
      correo: `test.metas.mensuales.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    token = (await Usuario.accessTokens.create(usuario)).value!.release()

    asesor = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST METAS MENSUALES ${Date.now()}`,
      activo: true,
    } as any)
    // Meta vieja de comisiones: no debe usarse como respaldo con `mes`.
    config = await Comision.create({
      esConfig: true,
      asesorId: asesor.id,
      tipoVehiculo: null,
      base: '0',
      estado: 'PENDIENTE',
      metaRtm: META_RTM_CONFIG,
      porcentajeComisionMeta: '3',
    } as any)

    await Database.table('meta_comercial_asesor').multiInsert([
      { asesor_id: asesor.id, mes: 9, anio: 2026, meta_pesos: 30000000, meta_vehiculos: 12 },
      { asesor_id: asesor.id, mes: 10, anio: 2026, meta_pesos: 50000000, meta_vehiculos: null },
    ])
  })

  group.teardown(async () => {
    if (asesor) {
      await Database.from('meta_comercial_asesor').where('asesor_id', asesor.id).delete()
    }
    if (config) await config.delete()
    if (asesor) await asesor.delete()
    if (usuario) await usuario.delete()
  })

  test('con fila del mes → meta en pesos de meta_comercial_asesor', async ({ client, assert }) => {
    const res = await metasMensuales(client, { mes: '2026-10', asesorId: asesor.id })
    res.assertStatus(200)
    const fila = filaDe(res)
    assert.equal(fila.meta_global_rtm, 50000000)
    assert.equal(fila.meta_fuente, 'meta_comercial')
    // El % y los valores RTM siguen saliendo de comisiones.
    assert.equal(fila.porcentaje_comision_meta, 3)

    // Sin asesorId, el asesor con meta del mes aparece en el listado.
    const todos = await metasMensuales(client, { mes: '2026-10' })
    todos.assertStatus(200)
    assert.equal(filaDe(todos)?.meta_global_rtm, 50000000)
  })

  test('sin fila del mes → meta null, sin respaldo a meta_rtm', async ({ client, assert }) => {
    const res = await metasMensuales(client, { mes: '2026-11', asesorId: asesor.id })
    res.assertStatus(200)
    const fila = filaDe(res)
    assert.isNull(fila.meta_global_rtm)
    assert.isNull(fila.meta_fuente)
  })

  test('sin mes → igual que antes (meta_rtm de comisiones)', async ({ client, assert }) => {
    const res = await metasMensuales(client, { asesorId: asesor.id })
    res.assertStatus(200)
    const fila = filaDe(res)
    assert.equal(fila.meta_global_rtm, META_RTM_CONFIG)
    assert.notProperty(fila, 'meta_fuente')
  })

  test('mes o año distinto no mezcla filas', async ({ client, assert }) => {
    const septiembre = await metasMensuales(client, { mes: '2026-09', asesorId: asesor.id })
    assert.equal(filaDe(septiembre).meta_global_rtm, 30000000)

    const octubre = await metasMensuales(client, { mes: '2026-10', asesorId: asesor.id })
    assert.equal(filaDe(octubre).meta_global_rtm, 50000000)

    const otroAnio = await metasMensuales(client, { mes: '2025-10', asesorId: asesor.id })
    assert.isNull(filaDe(otroAnio).meta_global_rtm)
  })
})

// GET /api/comisiones/metas (ComisionesConfig → Metas mensuales): cada fila
// trae, solo lectura, la meta en pesos del mes en curso (America/Bogota) de
// meta_comercial_asesor. El filtro y el resto de la respuesta no cambian.
test.group('Metas configuradas · meta del mes en curso (solo lectura)', (group) => {
  let usuario: Usuario
  let token: string
  let conMeta: AgenteCaptacion
  let sinMeta: AgenteCaptacion
  const configs: Comision[] = []
  const hoy = DateTime.now().setZone('America/Bogota')
  const LABEL = hoy.toFormat('yyyy-MM')

  async function configDe(asesor: AgenteCaptacion) {
    const c = await Comision.create({
      esConfig: true,
      asesorId: asesor.id,
      tipoVehiculo: 'MOTO',
      base: '0',
      estado: 'PENDIENTE',
      metaRtm: 0,
      porcentajeComisionMeta: '2.5',
      valorRtmMoto: 126100,
      valorRtmVehiculo: 208738,
    } as any)
    configs.push(c)
    return c
  }

  function metasConfig(client: any, asesorId: number) {
    return client
      .get('/api/comisiones/metas')
      .qs({ asesorId })
      .header('Authorization', `Bearer ${token}`)
  }

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'METAS-CONFIG',
      correo: `test.metas.config.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    token = (await Usuario.accessTokens.create(usuario)).value!.release()

    conMeta = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST METAS CONFIG CON META ${Date.now()}`,
      activo: true,
    } as any)
    sinMeta = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST METAS CONFIG SIN META ${Date.now()}`,
      activo: true,
    } as any)
    await configDe(conMeta)
    await configDe(sinMeta)

    await Database.table('meta_comercial_asesor').multiInsert([
      { asesor_id: conMeta.id, mes: hoy.month, anio: hoy.year, meta_pesos: 45000000 },
      // Otro mes del mismo asesor: no debe colarse.
      { asesor_id: conMeta.id, mes: hoy.minus({ months: 1 }).month, anio: hoy.minus({ months: 1 }).year, meta_pesos: 1 },
    ])
  })

  group.teardown(async () => {
    const ids = [conMeta?.id, sinMeta?.id].filter(Boolean) as number[]
    if (ids.length) await Database.from('meta_comercial_asesor').whereIn('asesor_id', ids).delete()
    for (const c of configs) await c.delete()
    if (conMeta) await conMeta.delete()
    if (sinMeta) await sinMeta.delete()
    if (usuario) await usuario.delete()
  })

  test('con fila del mes en curso → trae la meta en pesos', async ({ client, assert }) => {
    const res = await metasConfig(client, conMeta.id)
    res.assertStatus(200)
    const [fila] = res.body().data
    assert.equal(fila.meta_mes_pesos, 45000000)
    assert.equal(fila.meta_mes_label, LABEL)
  })

  test('sin fila del mes → meta_mes_pesos null', async ({ client, assert }) => {
    const res = await metasConfig(client, sinMeta.id)
    res.assertStatus(200)
    const [fila] = res.body().data
    assert.isNull(fila.meta_mes_pesos)
    assert.equal(fila.meta_mes_label, LABEL)
  })

  test('el resto de la respuesta queda igual', async ({ client, assert }) => {
    const res = await metasConfig(client, conMeta.id)
    const [fila] = res.body().data
    const config = await Comision.findOrFail(configs[0].id)
    const { meta_mes_pesos: _p, meta_mes_label: _l, ...resto } = fila
    assert.deepEqual(resto, {
      id: config.id,
      asesor_id: conMeta.id,
      tipo_vehiculo: 'MOTO',
      meta_mensual: 0,
      porcentaje_extra: 2.5,
      valor_rtm_moto: config.valorRtmMoto,
      valor_rtm_vehiculo: config.valorRtmVehiculo,
      fecha_actualizacion: config.updatedAt?.toISO() ?? config.createdAt?.toISO() ?? null,
    })
  })
})
