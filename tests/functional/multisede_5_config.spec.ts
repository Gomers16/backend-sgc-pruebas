import { test } from '@japa/runner'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Multi-sede Fase 5 — configuración global con override por sede: editar
// desde una sede crea/edita el override de ESA sede; la fila global (la que
// usa Ibagué mientras no tenga override) no cambia; "todas" → 400.
// Se prueba con la ventana de tickets; todo se restaura al final.

const IBAGUE = 1
const QA = 3
const MARCA = 'test.ms5.'
const TABLA = 'configuracion_ventana_ticket_global'

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS5 ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { h: { Authorization: `Bearer ${token}` } }
}

async function limpiar() {
  await Database.from(TABLA).where('sede_id', QA).delete()
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  if (ids.length) {
    await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
    await Database.from('usuarios').whereIn('id', ids).delete()
  }
}

test.group('Multi-sede Fase 5 · configuración por sede', (group) => {
  group.each.timeout(60_000)
  let gerA: Awaited<ReturnType<typeof actor>>
  let gerB: Awaited<ReturnType<typeof actor>>
  let globalAntes: any[]
  let ibagueAntes: any[]

  group.setup(async () => {
    await limpiar()
    globalAntes = await Database.from(TABLA).whereNull('sede_id')
    ibagueAntes = await Database.from(TABLA).where('sede_id', IBAGUE)
    gerA = await actor('GERENCIA', IBAGUE)
    gerB = await actor('GERENCIA', QA)
  })
  group.teardown(async () => {
    await limpiar()
  })

  test('editar desde QA crea su override; Ibagué y la global no cambian', async ({
    client,
    assert,
  }) => {
    const leer = async (h: Record<string, string>) =>
      (await client.get('/api/tickets/config/ventana').headers(h)).body().minutos_ventana
    const ibagueValor = await leer(gerA.h)
    const nuevo = Number(ibagueValor) + 17

    const r = await client
      .post('/api/tickets/config/ventana')
      .headers(gerB.h)
      .json({ minutos_ventana: nuevo })
    assert.equal(r.status(), 200, JSON.stringify(r.body()))
    assert.equal(r.body().minutos_ventana, nuevo)

    const override = await Database.from(TABLA).where('sede_id', QA)
    assert.lengthOf(override, 1)
    assert.equal(override[0].minutos_ventana, nuevo)
    assert.deepEqual(await Database.from(TABLA).whereNull('sede_id'), globalAntes, 'global igual')
    assert.deepEqual(await Database.from(TABLA).where('sede_id', IBAGUE), ibagueAntes)
    assert.equal(await leer(gerA.h), ibagueValor, 'Ibagué sigue leyendo lo mismo')

    // Segunda edición: actualiza el override (no crea otro).
    await client
      .post('/api/tickets/config/ventana')
      .headers(gerB.h)
      .json({ minutos_ventana: nuevo + 1 })
    const otra = await Database.from(TABLA).where('sede_id', QA)
    assert.lengthOf(otra, 1)
    assert.equal(otra[0].minutos_ventana, nuevo + 1)
  })

  test('"todas" no edita la configuración (400)', async ({ client, assert }) => {
    const r = await client
      .post('/api/tickets/config/ventana')
      .headers({ ...gerA.h, 'X-Sede-Id': 'todas' })
      .json({ minutos_ventana: 99 })
    assert.equal(r.status(), 400)
    assert.deepEqual(await Database.from(TABLA).whereNull('sede_id'), globalAntes)
  })
})
