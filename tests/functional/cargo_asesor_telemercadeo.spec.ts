import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Cargo "ASESOR TELEMERCADEO" (migración 1810000000000): camino por pantalla
// usuario → contrato. Crear el usuario con rol COMERCIAL deja un agente
// ASESOR_COMERCIAL (usuarios_controller::syncAgenteConUsuario, por ROL); un
// contrato con el cargo lo convierte en ASESOR_TELEMERCADEO
// (contratos_controller::ensureAgenteYConvenioParaContrato, por CARGO).
// Escribe en la BD compartida: usuarios test.cargotele.*@test.local y su
// agente y contrato. Limpieza total al inicio y al final.

const SEDE_ID = 3
const ROL = { SUPER_ADMIN: 9, COMERCIAL: 11 }
const MARCA = 'test.cargotele.'
const PASSWORD = 'Test1234!Aa'

async function limpiar() {
  const usuarios = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = usuarios.map((u: any) => u.id)
  if (!ids.length) return
  // contrato_* (salarios, pasos, historial, cambios, eventos) borran en cascada.
  await Database.from('contratos').whereIn('usuario_id', ids).delete()
  await Database.from('agentes_captacions').whereIn('usuario_id', ids).delete()
  await Database.from('usuarios').whereIn('id', ids).delete()
}

test.group('Cargo ASESOR TELEMERCADEO · usuario → contrato', (group) => {
  group.each.timeout(60_000)
  let tokenAdmin = ''
  let cargoId = 0
  let razonSocialId = 0

  group.setup(async () => {
    await limpiar()
    const admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'CARGOTELE ADMIN',
      correo: `${MARCA}admin.${Date.now()}@test.local`,
      password: PASSWORD,
      rolId: ROL.SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    tokenAdmin = (await Usuario.accessTokens.create(admin)).value!.release()
    razonSocialId = (await Database.from('razon_social').orderBy('id').first()).id
    // Siempre por nombre: el id cambia entre entornos.
    cargoId =
      (await Database.from('cargos').where('nombre', 'ASESOR TELEMERCADEO').first())?.id ?? 0
  })

  group.teardown(limpiar)

  test('el cargo existe una sola vez, por nombre exacto', async ({ assert }) => {
    const filas = await Database.from('cargos').where('nombre', 'like', '%TELEMERCADEO%')
    assert.lengthOf(filas, 1)
    assert.equal(filas[0].nombre, 'ASESOR TELEMERCADEO')
    assert.equal(filas[0].id, cargoId)
  })

  test('usuario COMERCIAL + contrato con el cargo → agente ASESOR_TELEMERCADEO, login/me y mi-resumen', async ({
    client,
    assert,
  }) => {
    const bearer = { Authorization: `Bearer ${tokenAdmin}` }
    const sello = Date.now()
    const correo = `${MARCA}asesor.${sello}@test.local`

    // 1) Usuario por la API (como Gestión Documental → Usuarios), rol COMERCIAL.
    const u = await client
      .post('/api/usuarios')
      .headers(bearer)
      .json({
        nombres: 'TEST',
        apellidos: `CARGOTELE ${sello}`, // nombre único: evita la rama de nombre duplicado
        correo,
        password: PASSWORD,
        rolId: ROL.COMERCIAL,
        razonSocialId,
        sedeId: SEDE_ID,
        estado: 'activo',
      })
    u.assertStatus(201)
    const usuarioId = u.body().id

    const agenteAntes = await Database.from('agentes_captacions')
      .where('usuario_id', usuarioId)
      .first()
    assert.equal(agenteAntes.tipo, 'ASESOR_COMERCIAL')
    const userAntes = await Database.from('usuarios').where('id', usuarioId).first()
    assert.equal(userAntes.agente_id, agenteAntes.id)

    // 2) Contrato por la API (como Gestión Documental → Contratos) con el cargo.
    const c = await client
      .post('/api/contratos')
      .headers(bearer)
      .json({
        usuarioId,
        razonSocialId,
        sedeId: SEDE_ID,
        cargoId,
        identificacion: `TCT-${sello}`,
        tipoContrato: 'laboral',
        terminoContrato: 'indefinido',
        salarioBasico: 1500000,
        fechaInicio: DateTime.now().setZone('America/Bogota').toISODate(),
      })
    c.assertStatus(201)

    const agente = await Database.from('agentes_captacions').where('usuario_id', usuarioId).first()
    assert.equal(agente.tipo, 'ASESOR_TELEMERCADEO')
    assert.equal(agente.id, agenteAntes.id, 'mismo agente (updateOrCreate por usuario_id)')
    const nAgentes = await Database.from('agentes_captacions')
      .where('usuario_id', usuarioId)
      .count('* as n')
    assert.equal(Number(nAgentes[0].n), 1)

    // Coherencia del vínculo en las dos direcciones y cargo copiado al usuario.
    const user = await Database.from('usuarios').where('id', usuarioId).first()
    assert.equal(user.agente_id, agente.id)
    assert.equal(user.cargo_id, cargoId)

    // 3) Login y /me con agenteTipo.
    const login = await client.post('/api/login').json({ correo, password: PASSWORD })
    login.assertStatus(200)
    assert.equal(login.body().user.agenteTipo, 'ASESOR_TELEMERCADEO')
    assert.equal(login.body().user.agenteId, agente.id)
    const token = login.body().token.token ?? login.body().token
    const me = await client.get('/api/auth/me').headers({ Authorization: `Bearer ${token}` })
    me.assertStatus(200)
    assert.equal(me.body().user.agenteTipo, 'ASESOR_TELEMERCADEO')

    // 4) Entra al módulo de Telemercadeo.
    const mr = await client
      .get('/api/telemercadeo/mi-resumen')
      .headers({ Authorization: `Bearer ${token}` })
    mr.assertStatus(200)
    assert.equal(mr.body().agente.id, agente.id)
  })

  test('caracteriza deuda conocida: sin agente previo, el contrato crea el agente pero no llena usuarios.agente_id', async ({
    client,
    assert,
  }) => {
    // Usuario con un rol que no crea agente (OPERATIVO_TURNOS): el contrato
    // crea el agente ASESOR_TELEMERCADEO, pero ensureAgenteYConvenioParaContrato
    // no escribe usuarios.agente_id. Login/me no se ven afectados (usan la
    // relación por agentes_captacions.usuario_id). Si se arregla, este test
    // debe pasar a esperar agente_id = agente.id.
    const bearer = { Authorization: `Bearer ${tokenAdmin}` }
    const sello = Date.now()
    const u = await client
      .post('/api/usuarios')
      .headers(bearer)
      .json({
        nombres: 'TEST',
        apellidos: `CARGOTELE OPER ${sello}`,
        correo: `${MARCA}oper.${sello}@test.local`,
        password: PASSWORD,
        rolId: 14,
        razonSocialId,
        sedeId: SEDE_ID,
        estado: 'activo',
      })
    u.assertStatus(201)
    const usuarioId = u.body().id
    assert.isNull(await Database.from('agentes_captacions').where('usuario_id', usuarioId).first())

    const c = await client
      .post('/api/contratos')
      .headers(bearer)
      .json({
        usuarioId,
        razonSocialId,
        sedeId: SEDE_ID,
        cargoId,
        identificacion: `TCO-${sello}`,
        tipoContrato: 'laboral',
        terminoContrato: 'indefinido',
        salarioBasico: 1500000,
        fechaInicio: DateTime.now().setZone('America/Bogota').toISODate(),
      })
    c.assertStatus(201)

    const agente = await Database.from('agentes_captacions').where('usuario_id', usuarioId).first()
    assert.equal(agente.tipo, 'ASESOR_TELEMERCADEO')
    const user = await Database.from('usuarios').where('id', usuarioId).first()
    assert.isNull(user.agente_id)
  })
})
