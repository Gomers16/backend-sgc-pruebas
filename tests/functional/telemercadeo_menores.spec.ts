import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import { columnaOrigenDateo } from '#services/telemercadeo_origen_service'

// Arreglos menores del recorrido de Telemercadeo en Bogotá (2026-11-23):
// búsqueda de CLIENTES, bloqueadoHasta real, canal en la ficha, límite de
// ciclos cerrados, extra con override mayor, razonSocialId, imagen_mime y
// nombre del Excel. Placas TLN1**, agentes y usuarios "TEST TLN".

const SEDE_ID = 3
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

async function limpiar() {
  const ciclos = await Database.from('telemercadeo_ciclos').where('placa', 'like', 'TLN1%')
  const ids = ciclos.map((c: any) => c.id)
  const gestiones = await Database.from('telemercadeo_gestiones').where('placa', 'like', 'TLN1%')
  for (const g of gestiones) {
    await fs.unlink(app.makePath('uploads', ...String(g.evidencia_ruta).split('/'))).catch(() => {})
  }
  await Database.from('telemercadeo_gestiones').where('placa', 'like', 'TLN1%').delete()
  if (ids.length) {
    await Database.from('telemercadeo_ciclo_autorizaciones').whereIn('ciclo_id', ids).delete()
    await Database.from('telemercadeo_ciclos').whereIn('id', ids).delete()
  }
  await Database.from('captacion_dateos').where('placa', 'like', 'TLN1%').delete()
  await Database.from('prospectos').where('placa', 'like', 'TLN1%').delete()
  await Database.from('vehiculos').where('placa', 'like', 'TLN1%').delete()
  await Database.from('clientes').where('nombre', 'like', 'TEST TLN%').delete()
}

const sin1820 = async () => !(await columnaOrigenDateo())

test.group('Telemercadeo · arreglos menores', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const agentes: AgenteCaptacion[] = []
  const tokens: Record<string, string> = {}
  const subidas: string[] = []
  let teleA: AgenteCaptacion
  let teleB: AgenteCaptacion
  let imagenPath = ''
  let origenId = 0
  let seq = 0
  const bearer = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` })

  async function usuario(k: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TLN-${k}`,
      correo: `test.tln.${k.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    usuarios.push(u)
    const t = await Usuario.accessTokens.create(u)
    tokens[k] = t.value!.release()
    return u
  }

  async function agente(nombre: string, usuarioId: number) {
    const a = await AgenteCaptacion.create({
      sedeId: SEDE_ID,
      tipo: 'ASESOR_TELEMERCADEO',
      nombre,
      usuarioId,
      activo: true,
    } as any)
    agentes.push(a)
    return a
  }

  async function gestionar(client: any, placa: string, k: string) {
    const up = await client
      .post('/api/media/upload')
      .headers(bearer(k))
      .field('carpeta', 'telemercadeo')
      .file('file', imagenPath)
    up.assertStatus(201)
    subidas.push(up.body().ruta)
    return client
      .post('/api/telemercadeo/gestiones')
      .headers(bearer(k))
      .json({
        placa,
        medio: 'LLAMADA',
        origen_id: origenId,
        resultado: 'INTERESADO',
        idempotency_key: `tln-${Date.now()}-${++seq}`,
        evidencia_ruta: up.body().ruta,
      })
  }

  group.setup(async () => {
    await limpiar()
    await usuario('ADMIN', 9)
    const uA = await usuario('A', 11)
    const uB = await usuario('B', 11)
    teleA = await agente(`TEST TLN A ${Date.now()}`, uA.id)
    teleB = await agente(`TEST TLN B ${Date.now()}`, uB.id)
    const o = await Database.from('telemercadeo_origenes').where('codigo', 'GOOGLE_ADS').first()
    origenId = o.id
    imagenPath = app.tmpPath(`tst_tln_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    await limpiar()
    for (const r of subidas) {
      await fs.unlink(app.makePath('uploads', ...r.split('/'))).catch(() => {})
    }
    await fs.unlink(imagenPath).catch(() => {})
    const ids = agentes.map((a) => a.id)
    await Database.from('configuracion_seguimiento_tele_asesores')
      .whereIn('asesor_id', ids)
      .delete()
    for (const a of agentes) await a.delete()
    for (const u of usuarios) await u.delete()
  })

  test('cola CLIENTES: una placa no se busca como teléfono por sus dígitos', async ({
    client,
    assert,
  }) => {
    const clase = await Database.from('clases_vehiculos').first()
    const crear = async (nombre: string, telefono: string, placa: string) => {
      const [id] = await Database.table('clientes').insert({ nombre, telefono })
      await Database.table('vehiculos').insert({
        placa,
        clase_vehiculo_id: clase.id,
        cliente_id: id,
        created_at: new Date(),
        updated_at: new Date(),
      })
      return Number(id)
    }
    const dueno = await crear('TEST TLN DUENO', '3990000000', 'TLN158')
    // Su teléfono contiene "158" (los dígitos de la placa).
    const ajeno = await crear('TEST TLN AJENO', '3991158158', 'TLN199')
    const buscar = async (q: string) => {
      const r = await client
        .get('/api/telemercadeo/cola')
        .headers(bearer('A'))
        .qs({ lista: 'CLIENTES', q, per_page: 100 })
      r.assertStatus(200)
      return r.body().data.map((f: any) => f.cliente_id)
    }
    const porPlaca = await buscar('TLN158')
    assert.include(porPlaca, dueno)
    assert.notInclude(porPlaca, ajeno)
    assert.include(await buscar('399 115-8158'), ajeno)
  })

  test('store(): bloqueadoHasta coincide con reserva.bloqueaHasta', async ({ client, assert }) => {
    const r = await client.post('/api/captacion-dateos').headers(bearer('ADMIN')).json({
      origen: 'UI',
      canal: 'TELE',
      agente_id: teleA.id,
      placa: 'TLN120',
      telemercadeo_origen_id: origenId,
      telefono: '3991550120',
    })
    r.assertStatus(201)
    const show = await client.get(`/api/captacion-dateos/${r.body().id}`).headers(bearer('ADMIN'))
    show.assertStatus(200)
    const ms = (v: string) => DateTime.fromISO(v).startOf('second').toMillis()
    assert.equal(ms(r.body().bloqueadoHasta), ms(show.body().reserva.bloqueaHasta))
    assert.equal(show.body().bloqueadoHasta, show.body().reserva.bloqueaHasta)
    assert.isTrue(r.body().bloqueado)

    // Ficha: el dateo TELE sale con su canal, no "ASESOR".
    const ficha = await client
      .get(`/api/agentes-captacion/${teleA.id}/dateos-comisiones`)
      .headers(bearer('ADMIN'))
    ficha.assertStatus(200)
    const fila = JSON.stringify(ficha.body())
    assert.include(fila, '"canal":"TELE"')
    assert.notInclude(fila, '"canal":"ASESOR"')
  }).skip(sin1820, 'migración 1820 sin aplicar en esta BD')

  test('extra: destraba a todos aunque otro con máximo propio mayor subiera el conteo', async ({
    client,
    assert,
  }) => {
    await Database.table('configuracion_seguimiento_tele_asesores').insert({
      asesor_id: teleA.id,
      max_seguimientos: 5,
      created_at: new Date(),
      updated_at: new Date(),
    })
    for (let i = 0; i < 5; i++) {
      const g = await gestionar(client, 'TLN130', 'A')
      g.assertStatus(201)
    }
    const bloqueadoB = await gestionar(client, 'TLN130', 'B')
    bloqueadoB.assertStatus(409)

    const lista = await client
      .get('/api/telemercadeo/gestiones')
      .headers(bearer('ADMIN'))
      .qs({ placa: 'TLN130', per_page: 100 })
    lista.assertStatus(200)
    assert.deepInclude(lista.body().data[0].seguimiento, { limite: 5, limite_minimo: 3 })

    const extra = await client
      .post(`/api/telemercadeo/ciclos/${bloqueadoB.body().ciclo_id}/autorizar-extra`)
      .headers(bearer('ADMIN'))
      .json({ motivo: 'Destrabar al otro asesor' })
    extra.assertStatus(200)
    const okB = await gestionar(client, 'TLN130', 'B')
    okB.assertStatus(201)
    // Una sola gestión extra para el ciclo: nadie puede la siguiente.
    const otraB = await gestionar(client, 'TLN130', 'B')
    otraB.assertStatus(409)
    const otraA = await gestionar(client, 'TLN130', 'A')
    otraA.assertStatus(409)
    assert.equal(teleB.id, okB.body().gestion.agente_id)
  })

  test('ciclo cerrado: la fila vieja no muestra el límite actual', async ({ client, assert }) => {
    const g = await gestionar(client, 'TLN140', 'B')
    g.assertStatus(201)
    const d = await client.post('/api/captacion-dateos').headers(bearer('B')).json({
      origen: 'UI',
      placa: 'TLN140',
      telefono: '3991550140',
      telemercadeo_gestion_id: g.body().gestion.id,
    })
    d.assertStatus(201)
    const lista = await client
      .get('/api/telemercadeo/gestiones')
      .headers(bearer('ADMIN'))
      .qs({ placa: 'TLN140' })
    const seg = lista.body().data[0].seguimiento
    assert.isFalse(seg.ciclo_abierto)
    assert.isNull(seg.limite)
    assert.equal(seg.numero_en_ciclo, 1)
  })

  test('POST /usuarios sin razonSocialId o inexistente → 400 y no crea nada', async ({
    client,
    assert,
  }) => {
    for (const razonSocialId of [undefined, null, 999999]) {
      const correo = `test.tln.nuevo.${Date.now()}.${++seq}@test.local`
      const r = await client.post('/api/usuarios').headers(bearer('ADMIN')).json({
        nombres: 'TEST',
        apellidos: 'TLN-NUEVO',
        correo,
        password: 'Test1234!Aa',
        rolId: 11,
        sedeId: SEDE_ID,
        razonSocialId,
      })
      r.assertStatus(400)
      assert.isNull(await Database.from('usuarios').where('correo', correo).first())
    }
  })

  test('upload: mime completo; Excel del resumen con la sede en el nombre', async ({
    client,
    assert,
  }) => {
    const up = await client.post('/api/media/upload').headers(bearer('A')).file('file', imagenPath)
    up.assertStatus(201)
    subidas.push(String(up.body().url).replace('/api/uploads/', ''))
    assert.equal(up.body().mime, 'image/png')

    const nombre = async (headers: Record<string, string>) => {
      const r = await client
        .get('/api/telemercadeo/resumen/excel')
        .headers({ ...bearer('ADMIN'), ...headers })
        .qs({ desde: '2031-05-01', hasta: '2031-05-31' })
      r.assertStatus(200)
      return r.header('content-disposition')
    }
    assert.include(await nombre({}), 'Telemercadeo_PRUEBAS_QA_20310501')
    assert.include(await nombre({ 'X-Sede-Id': '2' }), 'Telemercadeo_Bogota_')
    assert.include(await nombre({ 'X-Sede-Id': 'todas' }), 'Telemercadeo_Todas_')
  })
})
