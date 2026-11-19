import { test } from '@japa/runner'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Multi-sede Fase 0:
//  1) Rutas que eran públicas exigen sesión (401 sin token, no-401 con token).
//  2) Guard de usuarios por API (decisión 9): GERENCIA no crea SUPER_ADMIN;
//     TALENTO_HUMANO solo su sede y sin SA/GER; alta TH sin sede → la suya.
//  3) Contratos: TALENTO_HUMANO no mueve un usuario a otra sede vía contrato.
// Escribe en la BD compartida: usuarios test.ms0.*@test.local (sede QA = 3).
// Limpieza total al inicio y al final.

const SEDE_QA = 3
const SEDE_OTRA = 1
const MARCA = 'test.ms0.'
const PASSWORD = 'Test1234!Aa'

async function rolId(nombre: string): Promise<number> {
  const r = await Database.from('roles').where('nombre', nombre).first()
  if (!r) throw new Error(`No existe el rol ${nombre}`)
  return Number(r.id)
}

async function limpiar() {
  const usuarios = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = usuarios.map((u: any) => u.id)
  if (!ids.length) return
  await Database.from('contratos').whereIn('usuario_id', ids).delete()
  await Database.from('agentes_captacions').whereIn('usuario_id', ids).delete()
  await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
  await Database.from('usuarios').whereIn('id', ids).delete()
}

async function crearActor(rol: string, sedeId: number | null) {
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS0 ${rol}`,
    correo: `${MARCA}${rol.toLowerCase()}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@test.local`,
    password: PASSWORD,
    rolId: await rolId(rol),
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { usuario: u, bearer: { Authorization: `Bearer ${token}` } }
}

test.group('Multi-sede Fase 0 · rutas cerradas', (group) => {
  group.each.timeout(60_000)
  let bearer: Record<string, string> = {}

  group.setup(async () => {
    await limpiar()
    bearer = (await crearActor('SUPER_ADMIN', SEDE_QA)).bearer
  })
  group.teardown(limpiar)

  const cerradas: Array<[string, string]> = [
    ['GET', '/api/buscar?placa=ZZZ999'],
    ['GET', '/api/clientes'],
    ['GET', '/api/clientes/1'],
    ['POST', '/api/clientes'],
    ['PUT', '/api/clientes/1'],
    ['DELETE', '/api/clientes/999999999'],
    ['GET', '/api/clientes/1/detalle'],
    ['GET', '/api/clientes/1/historial'],
    ['GET', '/api/vehiculos'],
    ['GET', '/api/vehiculos/1'],
    ['POST', '/api/vehiculos'],
    ['PUT', '/api/vehiculos/1'],
    ['DELETE', '/api/vehiculos/999999999'],
    ['GET', '/api/clases-vehiculo'],
    ['GET', '/api/clases-vehiculo/1'],
    ['POST', '/api/clases-vehiculo'],
    ['PUT', '/api/clases-vehiculo/1'],
    ['DELETE', '/api/clases-vehiculo/999999999'],
    ['POST', '/api/ocr/parse-ticket'],
    ['GET', '/api/razones-sociales/1/usuarios'],
    // Selectores (cerrados después de aprobar la Fase 0).
    ['GET', '/api/sedes'],
    ['GET', '/api/roles'],
    ['GET', '/api/cargos'],
    ['GET', '/api/servicios'],
    ['GET', '/api/ciudades'],
    ['GET', '/api/ciudades/1'],
    ['GET', '/api/entidades-saluds'],
    ['GET', '/api/entidades-salud/1'],
    ['GET', '/api/razones-sociales'],
  ]

  for (const [metodo, ruta] of cerradas) {
    test(`${metodo} ${ruta} sin token → 401`, async ({ client, assert }) => {
      const verbo = metodo.toLowerCase() as 'get' | 'post' | 'put' | 'delete'
      const res = await client[verbo](ruta)
      assert.equal(res.status(), 401)
    })
  }

  // Solo lecturas con token (no escribir en catálogos reales).
  for (const ruta of [
    '/api/buscar?placa=ZZZ999',
    '/api/clientes',
    '/api/razones-sociales/1/usuarios',
    '/api/clases-vehiculo',
    '/api/sedes',
    '/api/roles',
    '/api/cargos',
    '/api/servicios',
    '/api/ciudades',
    '/api/entidades-saluds',
    '/api/razones-sociales',
  ]) {
    test(`GET ${ruta} con token → no 401`, async ({ client, assert }) => {
      const res = await client.get(ruta).headers(bearer)
      assert.notEqual(res.status(), 401)
      assert.isBelow(res.status(), 500, JSON.stringify(res.body()).slice(0, 400))
    })
  }

  // BUG PREEXISTENTE: vehiculos_controller importa 'app/models/...' y da 500
  // en runtime. Se arregla en la Fase 3c junto con el filtro por sede; aquí
  // solo se verifica que pasa auth.
  test('GET /api/vehiculos con token → pasa auth (no 401)', async ({ client, assert }) => {
    const res = await client.get('/api/vehiculos').headers(bearer)
    assert.notEqual(res.status(), 401)
  })

  test('clases-vehiculo: escribir solo SUPER_ADMIN y GERENCIA', async ({ client, assert }) => {
    const comercial = await crearActor('COMERCIAL', SEDE_QA)
    const r1 = await client
      .post('/api/clases-vehiculo')
      .headers(comercial.bearer)
      .json({ codigo: 'TST_MS0', nombre: 'TEST MS0' })
    assert.equal(r1.status(), 403)
    const r2 = await client
      .put('/api/clases-vehiculo/1')
      .headers(comercial.bearer)
      .json({ nombre: 'HACK' })
    assert.equal(r2.status(), 403)
    const r3 = await client.delete('/api/clases-vehiculo/999999999').headers(comercial.bearer)
    assert.equal(r3.status(), 403)
    // SUPER_ADMIN pasa el rol (id inexistente → 404, sin tocar datos reales).
    const r4 = await client.delete('/api/clases-vehiculo/999999999').headers(bearer)
    assert.equal(r4.status(), 404)
    const lectura = await client.get('/api/clases-vehiculo').headers(comercial.bearer)
    assert.equal(lectura.status(), 200)
  })
})

test.group('Multi-sede Fase 0 · guard de usuarios por API', (group) => {
  group.each.timeout(60_000)
  let razonSocialId = 0
  let rolSA = 0
  let rolGER = 0
  let rolCOM = 0

  group.setup(async () => {
    await limpiar()
    razonSocialId = (await Database.from('razon_social').orderBy('id').first()).id
    rolSA = await rolId('SUPER_ADMIN')
    rolGER = await rolId('GERENCIA')
    rolCOM = await rolId('COMERCIAL')
  })
  group.teardown(limpiar)

  function nuevo(rol: number, sedeId?: number | null) {
    const sello = `${Date.now()}.${Math.random().toString(36).slice(2, 7)}`
    return {
      nombres: 'TEST',
      apellidos: `MS0 NUEVO ${sello}`,
      correo: `${MARCA}nuevo.${sello}@test.local`,
      password: PASSWORD,
      rolId: rol,
      razonSocialId,
      ...(sedeId === undefined ? {} : { sedeId }),
    }
  }

  test('SUPER_ADMIN crea SUPER_ADMIN en cualquier sede', async ({ client, assert }) => {
    const { bearer } = await crearActor('SUPER_ADMIN', SEDE_QA)
    const res = await client.post('/api/usuarios').headers(bearer).json(nuevo(rolSA, SEDE_OTRA))
    assert.equal(res.status(), 201)
    assert.equal(res.body().sedeId, SEDE_OTRA)
  })

  test('GERENCIA: crea COMERCIAL en otra sede, no crea SUPER_ADMIN', async ({ client, assert }) => {
    const { bearer } = await crearActor('GERENCIA', SEDE_QA)
    const ok = await client.post('/api/usuarios').headers(bearer).json(nuevo(rolCOM, SEDE_OTRA))
    assert.equal(ok.status(), 201)
    const cuerpo = nuevo(rolSA, SEDE_QA)
    const no = await client.post('/api/usuarios').headers(bearer).json(cuerpo)
    assert.equal(no.status(), 403)
    const cuenta = await Database.from('usuarios')
      .where('correo', cuerpo.correo)
      .count('* as n')
      .first()
    assert.equal(Number(cuenta?.n ?? 0), 0)
  })

  test('GERENCIA no edita a un SUPER_ADMIN ni se promueve', async ({ client, assert }) => {
    const ger = await crearActor('GERENCIA', SEDE_QA)
    const sa = await crearActor('SUPER_ADMIN', SEDE_QA)
    const r1 = await client
      .put(`/api/usuarios/${sa.usuario.id}`)
      .headers(ger.bearer)
      .json({ nombres: 'HACK' })
    assert.equal(r1.status(), 403)
    const r2 = await client
      .put(`/api/usuarios/${ger.usuario.id}`)
      .headers(ger.bearer)
      .json({ rolId: rolSA })
    assert.equal(r2.status(), 403)
    const r3 = await client.delete(`/api/usuarios/${sa.usuario.id}`).headers(ger.bearer)
    assert.equal(r3.status(), 403)
    const sigue = await Usuario.find(sa.usuario.id)
    assert.equal(sigue?.nombres, 'TEST')
  })

  test('TALENTO_HUMANO: alta sin sede → su sede; otra sede o rol reservado → 403', async ({
    client,
    assert,
  }) => {
    const { bearer } = await crearActor('TALENTO_HUMANO', SEDE_QA)
    const sinSede = await client.post('/api/usuarios').headers(bearer).json(nuevo(rolCOM))
    assert.equal(sinSede.status(), 201)
    assert.equal(sinSede.body().sedeId, SEDE_QA)

    const otra = await client.post('/api/usuarios').headers(bearer).json(nuevo(rolCOM, SEDE_OTRA))
    assert.equal(otra.status(), 403)
    const ger = await client.post('/api/usuarios').headers(bearer).json(nuevo(rolGER, SEDE_QA))
    assert.equal(ger.status(), 403)
    const sa = await client.post('/api/usuarios').headers(bearer).json(nuevo(rolSA, SEDE_QA))
    assert.equal(sa.status(), 403)
  })

  test('TALENTO_HUMANO no edita usuarios de otra sede ni los mueve', async ({ client, assert }) => {
    const th = await crearActor('TALENTO_HUMANO', SEDE_QA)
    const deOtra = await crearActor('COMERCIAL', SEDE_OTRA)
    const propio = await crearActor('COMERCIAL', SEDE_QA)

    const r1 = await client
      .put(`/api/usuarios/${deOtra.usuario.id}`)
      .headers(th.bearer)
      .json({ nombres: 'HACK' })
    assert.equal(r1.status(), 403)

    const r2 = await client
      .put(`/api/usuarios/${propio.usuario.id}`)
      .headers(th.bearer)
      .json({ sedeId: SEDE_OTRA })
    assert.equal(r2.status(), 403)
    assert.equal((await Usuario.find(propio.usuario.id))?.sedeId, SEDE_QA)

    const r3 = await client
      .put(`/api/usuarios/${propio.usuario.id}`)
      .headers(th.bearer)
      .json({ celularPersonal: '3000000000' })
    assert.equal(r3.status(), 200)
  })

  test('rolId o sedeId inexistente → 422', async ({ client, assert }) => {
    const { bearer } = await crearActor('SUPER_ADMIN', SEDE_QA)
    const r1 = await client.post('/api/usuarios').headers(bearer).json(nuevo(999999, SEDE_QA))
    assert.equal(r1.status(), 422)
    const r2 = await client.post('/api/usuarios').headers(bearer).json(nuevo(rolCOM, 999999))
    assert.equal(r2.status(), 422)
  })

  test('TALENTO_HUMANO no mueve a un usuario a otra sede vía contrato', async ({
    client,
    assert,
  }) => {
    const th = await crearActor('TALENTO_HUMANO', SEDE_QA)
    const propio = await crearActor('COMERCIAL', SEDE_QA)
    const res = await client.post('/api/contratos').headers(th.bearer).json({
      usuarioId: propio.usuario.id,
      razonSocialId,
      sedeId: SEDE_OTRA,
      tipoContrato: 'prestacion',
      salarioBasico: 1000000,
      fechaInicio: '2026-11-01',
    })
    assert.equal(res.status(), 403)
    assert.equal((await Usuario.find(propio.usuario.id))?.sedeId, SEDE_QA)
    const contratos = await Database.from('contratos')
      .where('usuario_id', propio.usuario.id)
      .count('* as n')
      .first()
    assert.equal(Number(contratos?.n ?? 0), 0)
  })
})
