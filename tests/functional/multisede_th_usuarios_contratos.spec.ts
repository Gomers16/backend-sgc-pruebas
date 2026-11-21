import { test } from '@japa/runner'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Multi-sede — Talento Humano por sede: usuarios y contratos.
// Listados filtrados por las sedes visibles; por id, otra sede → 404; el
// propio usuario (y sus contratos) siempre visible. Solo lecturas: no se
// toca ningún registro de Ibagué.

const IBAGUE = 1
const QA = 3
const MARCA = 'test.msth.'

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MSTH ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } as Record<string, string> }
}

async function limpiar() {
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  if (!ids.length) return
  await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
  await Database.from('usuarios').whereIn('id', ids).delete()
}

const idsDe = (body: any) => ((body?.data ?? body) as any[]).map((r) => Number(r.id))

test.group('Multi-sede · usuarios y contratos por sede (Talento Humano)', (group) => {
  group.each.timeout(120_000)
  let thQa: Awaited<ReturnType<typeof actor>>
  let gerQa: Awaited<ReturnType<typeof actor>>
  let usuarioIbague = 0
  let contratoIbague = 0

  group.setup(async () => {
    await limpiar()
    thQa = await actor('TALENTO_HUMANO', QA)
    gerQa = await actor('GERENCIA', QA)
    const u = await Database.from('usuarios').where('sede_id', IBAGUE).orderBy('id').first()
    usuarioIbague = Number(u.id)
    const c = await Database.from('contratos').where('sede_id', IBAGUE).orderBy('id').first()
    contratoIbague = Number(c.id)
  })
  group.teardown(limpiar)

  test('TH de QA: no lista ni abre usuarios de Ibagué; se ve a sí mismo', async ({
    client,
    assert,
  }) => {
    const lista = await client.get('/api/usuarios').headers(thQa.h)
    assert.equal(lista.status(), 200)
    const ids = idsDe(lista.body())
    assert.include(ids, thQa.id)
    assert.notInclude(ids, usuarioIbague)
    assert.isTrue((lista.body() as any[]).every((u) => u.sedeId === QA || u.id === thQa.id))

    assert.equal((await client.get(`/api/usuarios/${usuarioIbague}`).headers(thQa.h)).status(), 404)
    assert.equal((await client.get(`/api/usuarios/${thQa.id}`).headers(thQa.h)).status(), 200)
    const editar = await client
      .put(`/api/usuarios/${usuarioIbague}`)
      .headers(thQa.h)
      .json({ nombres: 'NO' })
    assert.equal(editar.status(), 404)
    assert.equal(
      (await client.get(`/api/usuarios/${usuarioIbague}/contratos`).headers(thQa.h)).status(),
      404
    )
  })

  test('TH de QA: no lista ni abre contratos de Ibagué (ni sus archivos ni salarios)', async ({
    client,
    assert,
  }) => {
    const lista = await client.get('/api/contratos').headers(thQa.h)
    assert.equal(lista.status(), 200)
    assert.notInclude(idsDe(lista.body()), contratoIbague)
    for (const url of [
      `/api/contratos/${contratoIbague}`,
      `/api/contratos/${contratoIbague}/archivo/meta`,
      `/api/contratos/${contratoIbague}/salarios`,
      `/api/contratos/${contratoIbague}/pasos`,
      `/api/contratos/${contratoIbague}/eventos`,
      `/api/contratos/${contratoIbague}/cambios`,
    ]) {
      assert.equal((await client.get(url).headers(thQa.h)).status(), 404, url)
    }
  })

  test('GERENCIA: ve la sede elegida; "todas" suma Ibagué y Bogotá', async ({ client, assert }) => {
    const enIbague = await client.get('/api/usuarios').headers({ ...gerQa.h, 'X-Sede-Id': '1' })
    assert.equal(enIbague.status(), 200)
    const ids1 = idsDe(enIbague.body())
    assert.include(ids1, usuarioIbague)
    assert.include(ids1, gerQa.id) // el propio siempre
    const ajenos = (enIbague.body() as any[]).filter(
      (u) => u.sedeId !== IBAGUE && u.id !== gerQa.id
    )
    assert.lengthOf(ajenos, 0)
    const [{ n }] = await Database.from('usuarios').where('sede_id', IBAGUE).count('* as n')
    assert.equal(ids1.length - 1, Number(n))

    const enQa = await client.get('/api/usuarios').headers(gerQa.h)
    assert.notInclude(idsDe(enQa.body()), usuarioIbague)
    assert.equal(
      (
        await client
          .get(`/api/contratos/${contratoIbague}`)
          .headers({ ...gerQa.h, 'X-Sede-Id': '1' })
      ).status(),
      200
    )
    assert.equal(
      (await client.get(`/api/contratos/${contratoIbague}`).headers(gerQa.h)).status(),
      404
    )

    const todas = await client.get('/api/usuarios').headers({ ...gerQa.h, 'X-Sede-Id': 'todas' })
    const [{ n: n12 }] = await Database.from('usuarios').whereIn('sede_id', [1, 2]).count('* as n')
    assert.equal(idsDe(todas.body()).length - 1, Number(n12))
  })
})
