import { test } from '@japa/runner'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Multi-sede 3g — agentes, convenios, prospectos y telemercadeo por sede.
// Sede A = Ibagué (1), sede B = PRUEBAS QA (3). Agentes "TEST MS3G *",
// convenios "TEST MS3G *", prospectos y gestiones con placa MS3G*. Todo se
// borra al final.

const IBAGUE = 1
const QA = 3
const RTM = 1
const MARCA = 'test.ms3g.'

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS3G ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } }
}
type Actor = Awaited<ReturnType<typeof actor>>

async function limpiar() {
  const ags = await Database.from('agentes_captacions')
    .where('nombre', 'like', 'TEST MS3G%')
    .select('id')
  const agIds = ags.map((a: any) => a.id)
  await Database.from('telemercadeo_gestiones').where('placa', 'like', 'MS3G%').delete()
  await Database.from('telemercadeo_ciclos').where('placa', 'like', 'MS3G%').delete()
  await Database.from('captacion_dateos').where('placa', 'like', 'MS3G%').delete()
  const ps = await Database.from('prospectos').where('placa', 'like', 'MS3G%').select('id')
  const pIds = ps.map((p: any) => p.id)
  if (pIds.length) {
    await Database.from('asesor_prospecto_asignaciones').whereIn('prospecto_id', pIds).delete()
    await Database.from('prospectos').whereIn('id', pIds).delete()
  }
  const cs = await Database.from('convenios').where('nombre', 'like', 'TEST MS3G%').select('id')
  const cIds = cs.map((c: any) => c.id)
  if (cIds.length) {
    await Database.from('asesor_convenio_asignaciones').whereIn('convenio_id', cIds).delete()
    await Database.from('convenios').whereIn('id', cIds).delete()
  }
  if (agIds.length) {
    await Database.from('asesor_convenio_asignaciones').whereIn('asesor_id', agIds).delete()
    await Database.from('configuracion_ventana_ticket_asesores')
      .whereIn('asesor_id', agIds)
      .delete()
    await Database.from('agentes_captacions').whereIn('id', agIds).delete()
  }
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  if (ids.length) {
    await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
    await Database.from('usuario_preferencia_modulo').whereIn('usuario_id', ids).delete()
    await Database.from('usuarios').whereIn('id', ids).delete()
  }
}

async function agente(sedeId: number, tipo = 'ASESOR_COMERCIAL', usuarioId: number | null = null) {
  const [id] = await Database.table('agentes_captacions').insert({
    nombre: `TEST MS3G ${tipo} ${sedeId} ${Date.now()}${Math.random().toString(36).slice(2, 5)}`,
    tipo,
    activo: true,
    sede_id: sedeId,
    usuario_id: usuarioId,
  })
  return id as number
}

async function convenio(sedeId: number) {
  const [id] = await Database.table('convenios').insert({
    nombre: `TEST MS3G CONVENIO ${sedeId} ${Date.now()}`,
    tipo: 'TALLER',
    activo: true,
    sede_id: sedeId,
  })
  return id as number
}

const ids = (body: any) => ((body?.data ?? body) as any[]).map((r) => Number(r.id))

test.group('Multi-sede 3g · agentes, convenios, prospectos y telemercadeo', (group) => {
  group.each.timeout(90_000)
  let gerA: Actor
  let gerB: Actor
  let comB: Actor
  let agA = 0
  let agB = 0

  group.setup(async () => {
    await limpiar()
    gerA = await actor('GERENCIA', IBAGUE)
    gerB = await actor('GERENCIA', QA)
    comB = await actor('COMERCIAL', QA)
    agA = await agente(IBAGUE)
    agB = await agente(QA)
  })
  group.teardown(limpiar)

  test('agentes: listar, ver, editar y borrar de otra sede → vacío o 404', async ({
    client,
    assert,
  }) => {
    const lista = await client.get('/api/agentes-captacion').qs({ perPage: 500 }).headers(gerB.h)
    assert.equal(lista.status(), 200)
    assert.include(ids(lista.body()), agB)
    assert.notInclude(ids(lista.body()), agA)
    const light = await client
      .get('/api/agentes-captacion/light')
      .qs({ activos: 0 })
      .headers(gerB.h)
    assert.notInclude(ids(light.body()), agA)
    assert.equal((await client.get(`/api/agentes-captacion/${agA}`).headers(gerB.h)).status(), 404)
    const upd = await client
      .put(`/api/agentes-captacion/${agA}`)
      .headers(gerB.h)
      .json({ nombre: 'X' })
    assert.equal(upd.status(), 404)
    assert.equal(
      (await client.delete(`/api/agentes-captacion/${agA}`).headers(gerB.h)).status(),
      404
    )
    assert.exists(await Database.from('agentes_captacions').where('id', agA).first())

    // Crear: nace en la sede activa; con un usuario de otra sede → 409.
    const nuevo = await client
      .post('/api/agentes-captacion')
      .headers(gerB.h)
      .json({ tipo: 'ASESOR_COMERCIAL', nombre: `TEST MS3G NUEVO ${Date.now()}`, sede_id: IBAGUE })
    assert.equal(nuevo.status(), 201, JSON.stringify(nuevo.body()))
    assert.equal(
      (await Database.from('agentes_captacions').where('id', nuevo.body().id).first()).sede_id,
      QA
    )
    const ajeno = await client
      .post('/api/agentes-captacion')
      .headers(gerB.h)
      .json({
        tipo: 'ASESOR_COMERCIAL',
        nombre: `TEST MS3G USR ${Date.now()}`,
        usuario_id: gerA.id,
      })
    assert.equal(ajeno.status(), 409, JSON.stringify(ajeno.body()))
  })

  test('convenios del asesor: una asignación que cruza sedes no muestra el convenio ajeno', async ({
    client,
    assert,
  }) => {
    // Dato inconsistente a propósito (el código ya no lo permite crear):
    // asesor de QA asignado a un convenio de Ibagué y a uno de QA.
    const cA = await convenio(IBAGUE)
    const cB = await convenio(QA)
    for (const convenioId of [cA, cB]) {
      await Database.table('asesor_convenio_asignaciones').insert({
        convenio_id: convenioId,
        asesor_id: agB,
        activo: true,
      })
    }
    for (const light of ['0', '1']) {
      const r = await client
        .get(`/api/agentes-captacion/${agB}/convenios`)
        .qs({ light })
        .headers(gerB.h)
      assert.equal(r.status(), 200, JSON.stringify(r.body()))
      assert.include(ids(r.body()), cB)
      assert.notInclude(ids(r.body()), cA)
    }
  })

  test('convenios y prospectos: de otra sede → 404; asignar asesor ajeno → 409', async ({
    client,
    assert,
  }) => {
    const cA = await convenio(IBAGUE)
    const cB = await convenio(QA)
    const lista = await client.get('/api/convenios/light').headers(gerB.h)
    assert.include(ids(lista.body()), cB)
    assert.notInclude(ids(lista.body()), cA)
    assert.equal((await client.get(`/api/convenios/${cA}`).headers(gerB.h)).status(), 404)
    const asig = await client
      .post(`/api/convenios/${cB}/asignar`)
      .headers(gerB.h)
      .json({ asesor_id: agA })
    assert.equal(asig.status(), 409, JSON.stringify(asig.body()))

    const [pA] = await Database.table('prospectos').insert({ placa: 'MS3GPA', sede_id: IBAGUE })
    const [pB] = await Database.table('prospectos').insert({ placa: 'MS3GPB', sede_id: QA })
    assert.equal((await client.get(`/api/prospectos/${pA}`).headers(gerB.h)).status(), 404)
    const asigP = await client
      .post(`/api/prospectos/${pB}/asignar`)
      .headers(gerB.h)
      .json({ asesor_id: agA })
    assert.equal(asigP.status(), 409, JSON.stringify(asigP.body()))
  })

  test('dateo con asesor o convenio de otra sede → 409', async ({ client, assert }) => {
    const r = await client
      .post('/api/captacion-dateos')
      .headers(comB.h)
      .json({ placa: 'MS3GD1', canal: 'ASESOR', agente_id: agA, origen: 'UI', servicio_id: RTM })
    assert.equal(r.status(), 409, JSON.stringify(r.body()))
    const cA = await convenio(IBAGUE)
    const r2 = await client.post('/api/captacion-dateos').headers(comB.h).json({
      placa: 'MS3GD2',
      canal: 'ASESOR',
      agente_id: agB,
      convenio_id: cA,
      origen: 'UI',
      servicio_id: RTM,
    })
    assert.equal(r2.status(), 409, JSON.stringify(r2.body()))
    assert.lengthOf(await Database.from('captacion_dateos').where('placa', 'like', 'MS3GD%'), 0)
  })

  test('telemercadeo: gestiones de otra sede no se ven; asesores por sede', async ({
    client,
    assert,
  }) => {
    const teleA = await agente(IBAGUE, 'ASESOR_TELEMERCADEO')
    const [cicloA] = await Database.table('telemercadeo_ciclos').insert({
      placa: 'MS3GT1',
      servicio_id: RTM,
      sede_id: IBAGUE,
      numero_gestiones: 1,
      abierto_key: 1,
    })
    const [gA] = await Database.table('telemercadeo_gestiones').insert({
      sede_id: IBAGUE,
      agente_id: teleA,
      usuario_id: gerA.id,
      ciclo_id: cicloA,
      numero_en_ciclo: 1,
      placa: 'MS3GT1',
      servicio_id: RTM,
      medio: 'LLAMADA',
      origen_id: 1,
      resultado: 'SIN_RESPUESTA',
      evidencia_ruta: 'x',
      idempotency_key: `ms3g-${Date.now()}`,
    })
    const lista = await client.get('/api/telemercadeo/gestiones').headers(gerB.h)
    assert.equal(lista.status(), 200)
    assert.notInclude(ids(lista.body()), gA)
    const listaA = await client.get('/api/telemercadeo/gestiones').headers(gerA.h)
    assert.include(ids(listaA.body()), gA)
    assert.equal(
      (await client.get(`/api/telemercadeo/gestiones/${gA}`).headers(gerB.h)).status(),
      404
    )
    const asesores = await client.get('/api/telemercadeo/asesores').headers(gerB.h)
    assert.notInclude(ids(asesores.body()), teleA)
  })

  test('config por asesor: asesor de otra sede → 409; listados por sede', async ({
    client,
    assert,
  }) => {
    const up = await client
      .post('/api/tickets/config/ventana/asesores')
      .headers(gerB.h)
      .json({ asesor_id: agA, minutos_ventana: 5 })
    assert.equal(up.status(), 409, JSON.stringify(up.body()))
    const okB = await client
      .post('/api/tickets/config/ventana/asesores')
      .headers(gerB.h)
      .json({ asesor_id: agB, minutos_ventana: 5 })
    assert.include([200, 201], okB.status(), JSON.stringify(okB.body()))
    const listaA = await client.get('/api/tickets/config/ventana/asesores').headers(gerA.h)
    assert.notInclude(JSON.stringify(listaA.body()), `"asesor_id":${agB}`)
  })

  test('"todas" es solo lectura: escrituras de la 3g → 400', async ({ client, assert }) => {
    const todas = { ...gerB.h, 'X-Sede-Id': 'todas' }
    const cB = await convenio(QA)
    const escrituras = [
      client
        .post('/api/agentes-captacion')
        .headers(todas)
        .json({ tipo: 'ASESOR_COMERCIAL', nombre: 'X' }),
      client.put(`/api/agentes-captacion/${agB}`).headers(todas).json({ nombre: 'X' }),
      client.post(`/api/convenios/${cB}/asignar`).headers(todas).json({ asesor_id: agB }),
      client.post('/api/prospectos').headers(todas).json({ placa: 'MS3GX1' }),
      client.post('/api/telemercadeo/config/max-seguimientos').headers(todas).json({ max: 3 }),
      client
        .post('/api/tickets/config/ventana/asesores')
        .headers(todas)
        .json({ asesor_id: agB, minutos_ventana: 9 }),
    ]
    for (const req of escrituras) {
      const r = await req
      assert.equal(r.status(), 400, JSON.stringify(r.body()))
    }
  })
})
