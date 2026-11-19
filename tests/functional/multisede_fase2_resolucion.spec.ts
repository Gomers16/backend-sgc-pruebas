import { test } from '@japa/runner'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Multi-sede Fase 2 — resolución de la sede activa por HTTP.
// /auth/me devuelve sedeActiva leída por AsyncLocalStorage (el mismo camino
// que usarán las consultas), así que esto prueba middleware + ALS de punta a
// punta. Usuarios test.ms2.*@test.local en la sede QA (3) o sin sede.

const SEDE_QA = 3
const IBAGUE = 1
const BOGOTA = 2
const MARCA = 'test.ms2.'

async function limpiar() {
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  if (!ids.length) return
  await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
  await Database.from('agentes_captacions').whereIn('usuario_id', ids).delete()
  await Database.from('usuarios').whereIn('id', ids).delete()
}

async function actor(rol: string, sedeId: number | null) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS2 ${rol}`,
    correo: `${MARCA}${rol.toLowerCase()}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { Authorization: `Bearer ${token}` }
}

test.group('Multi-sede Fase 2 · resolución de la sede activa', (group) => {
  group.each.timeout(60_000)
  group.setup(limpiar)
  group.teardown(limpiar)

  for (const rol of ['SUPER_ADMIN', 'GERENCIA']) {
    test(`${rol}: sin cabecera su sede; con X-Sede-Id la elegida; "todas" = activas`, async ({
      client,
      assert,
    }) => {
      const h = await actor(rol, SEDE_QA)
      const a = await client.get('/api/auth/me').headers(h)
      assert.equal(a.status(), 200)
      assert.deepEqual(a.body().sedeActiva, { sedeIds: [SEDE_QA], todas: false })
      assert.isTrue(a.body().puedeCambiarSede)
      assert.deepEqual(a.body().sede, { id: SEDE_QA, nombre: 'PRUEBAS QA' })
      const permitidas = a.body().sedesPermitidas.map((s: any) => s.id)
      assert.includeMembers(permitidas, [IBAGUE, BOGOTA])
      assert.notInclude(permitidas, SEDE_QA) // inactiva

      const b = await client.get('/api/auth/me').headers({ ...h, 'X-Sede-Id': String(BOGOTA) })
      assert.deepEqual(b.body().sedeActiva, { sedeIds: [BOGOTA], todas: false })

      const c = await client.get('/api/auth/me').headers({ ...h, 'X-Sede-Id': 'todas' })
      assert.isTrue(c.body().sedeActiva.todas)
      assert.includeMembers(c.body().sedeActiva.sedeIds, [IBAGUE, BOGOTA])
      assert.notInclude(c.body().sedeActiva.sedeIds, SEDE_QA)
    })

    test(`${rol}: X-Sede-Id inválida o de sede inactiva → 400`, async ({ client, assert }) => {
      const h = await actor(rol, SEDE_QA)
      for (const cab of ['99999', 'abc', String(SEDE_QA)]) {
        const r = await client.get('/api/clientes').headers({ ...h, 'X-Sede-Id': cab })
        assert.equal(r.status(), 400, cab)
      }
    })

    test(`${rol}: "todas" deja leer pero no escribir (400)`, async ({ client, assert }) => {
      const h = { ...(await actor(rol, SEDE_QA)), 'X-Sede-Id': 'todas' }
      const lectura = await client.get('/api/clases-vehiculo').headers(h)
      assert.equal(lectura.status(), 200)
      const escritura = await client
        .post('/api/clases-vehiculo')
        .headers(h)
        .json({ codigo: 'TST_MS2', nombre: 'NO SE CREA' })
      assert.equal(escritura.status(), 400)
      const fila = await Database.from('clases_vehiculos').where('codigo', 'TST_MS2').first()
      assert.isNull(fila)
    })
  }

  for (const rol of [
    'COMERCIAL',
    'OPERATIVO_TURNOS',
    'CONTABILIDAD',
    'TALENTO_HUMANO',
    'TRAMITADOR',
    'TURNERO',
  ]) {
    test(`${rol}: la cabecera se ignora (otra sede, "todas" o basura)`, async ({
      client,
      assert,
    }) => {
      const h = await actor(rol, SEDE_QA)
      for (const cab of [String(IBAGUE), 'todas', 'basura']) {
        const r = await client.get('/api/auth/me').headers({ ...h, 'X-Sede-Id': cab })
        assert.equal(r.status(), 200, cab)
        assert.deepEqual(r.body().sedeActiva, { sedeIds: [SEDE_QA], todas: false }, cab)
        assert.isFalse(r.body().puedeCambiarSede)
        assert.deepEqual(
          r.body().sedesPermitidas.map((s: any) => s.id),
          [SEDE_QA]
        )
      }
    })
  }

  test('usuario sin sede: /auth/me responde (sede null) y el resto → 403', async ({
    client,
    assert,
  }) => {
    for (const rol of ['COMERCIAL', 'GERENCIA']) {
      const h = await actor(rol, null)
      const me = await client.get('/api/auth/me').headers(h)
      assert.equal(me.status(), 200, rol)
      assert.isNull(me.body().sede)
      assert.isNull(me.body().sedeActiva)
      const r = await client.get('/api/clases-vehiculo').headers(h)
      assert.equal(r.status(), 403, rol)
      assert.equal(r.body().code, 'E_SEDE_SCOPE')
    }
  })

  test('sin token: 401 antes que cualquier regla de sede', async ({ client, assert }) => {
    const r = await client.get('/api/clases-vehiculo').headers({ 'X-Sede-Id': 'todas' })
    assert.equal(r.status(), 401)
  })
})
