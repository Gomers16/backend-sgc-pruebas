import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import ExcelJS from 'exceljs'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import CaptacionDateo from '#models/captacion_dateo'
import { evaluarCierreCiclo } from '#services/telemercadeo_gestion_service'
import { avanceMeta, fraccionTranscurrida, parseRango } from '#services/telemercadeo_resumen_service'

// Gestión de Telemercadeo (gestiones, seguimiento, evidencias privadas,
// metas, resumen). Escribe en la BD compartida: placas TLG*, teléfonos
// 39911*, agentes/usuarios "TEST TLG", evidencias en uploads/telemercadeo.
// Limpieza al inicio (restos de una corrida fallida) y al final.

const SEDE_ID = 2
const SERVICIO_RTM = 1
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10, COMERCIAL: 11, OPERATIVO_TURNOS: 14 }
const ZONA = 'America/Bogota'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

async function limpiarDatos() {
  const gestiones = await Database.from('telemercadeo_gestiones')
    .where('placa', 'like', 'TLG%')
    .select('ciclo_id', 'evidencia_ruta')
  for (const g of gestiones) {
    await fs.unlink(app.makePath('uploads', ...String(g.evidencia_ruta).split('/'))).catch(() => {})
  }
  await Database.from('telemercadeo_gestiones').where('placa', 'like', 'TLG%').delete()
  await Database.from('telemercadeo_ciclos').where('placa', 'like', 'TLG%').delete()
  await Database.from('captacion_dateos').where('placa', 'like', 'TLG%').delete()
  await Database.from('turnos_rtms').where('placa', 'like', 'TLG%').delete()
  await Database.from('vehiculos').where('placa', 'like', 'TLG%').delete()
  await Database.from('clientes').where('doc_numero', 'like', 'TLG-%').delete()
}

test.group('Telemercadeo · gestiones', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const agentes: AgenteCaptacion[] = []
  const tokens: Record<string, string> = {}
  const subidas: string[] = []
  let teleA: AgenteCaptacion
  let teleB: AgenteCaptacion
  let comercial: AgenteCaptacion
  let imagenPath = ''
  let origenId = 0
  let seq = 0

  const bearer = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` })
  const key = () => `tlg-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`

  async function usuario(k: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TLG-${k}`,
      correo: `test.tlg.${k.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    usuarios.push(u)
    tokens[k] = (await Usuario.accessTokens.create(u)).value!.release()
    return u
  }

  async function agente(tipo: string, nombre: string, usuarioId: number | null) {
    const a = await AgenteCaptacion.create({ tipo, nombre, usuarioId } as any)
    agentes.push(a)
    return a
  }

  async function subir(client: any, k = 'TELE_A', carpeta = 'telemercadeo') {
    const r = await client
      .post('/api/media/upload')
      .headers(bearer(k))
      .field('carpeta', carpeta)
      .file('file', imagenPath)
    r.assertStatus(201)
    if (r.body().ruta) subidas.push(r.body().ruta)
    return r.body()
  }

  async function gestionar(client: any, body: Record<string, unknown> = {}, k = 'TELE_A') {
    const evidencia = body.evidencia_ruta ?? (await subir(client, k)).ruta
    return client
      .post('/api/telemercadeo/gestiones')
      .headers(bearer(k))
      .json({
        medio: 'LLAMADA',
        origen_id: origenId,
        resultado: 'SIN_RESPUESTA',
        idempotency_key: key(),
        ...body,
        evidencia_ruta: evidencia,
      })
  }

  async function turno(placa: string, fecha: DateTime, estado = 'finalizado') {
    seq++
    const [id] = await Database.table('turnos_rtms').insert({
      funcionario_id: usuarios[0].id,
      sede_id: SEDE_ID,
      servicio_id: SERVICIO_RTM,
      fecha: fecha.toISODate(),
      hora_ingreso: '08:00:00',
      placa,
      tipo_vehiculo: 'Liviano Particular',
      turno_codigo: `TLG-${Date.now()}-${seq}`,
      turno_numero: 0,
      turno_numero_servicio: 0,
      estado,
      es_segunda_vez: 0,
    })
    return id
  }

  group.setup(async () => {
    await limpiarDatos()
    await usuario('ADMIN', ROL.SUPER_ADMIN)
    await usuario('GERENCIA', ROL.GERENCIA)
    await usuario('OPERATIVO', ROL.OPERATIVO_TURNOS)
    const uA = await usuario('TELE_A', ROL.COMERCIAL)
    const uB = await usuario('TELE_B', ROL.COMERCIAL)
    const uC = await usuario('COMERCIAL', ROL.COMERCIAL)
    const s = Date.now()
    teleA = await agente('ASESOR_TELEMERCADEO', `TEST TLG TELE A ${s}`, uA.id)
    teleB = await agente('ASESOR_TELEMERCADEO', `TEST TLG TELE B ${s}`, uB.id)
    comercial = await agente('ASESOR_COMERCIAL', `TEST TLG COMERCIAL ${s}`, uC.id)

    const origen = await Database.from('telemercadeo_origenes').where('codigo', 'GOOGLE_ADS').first()
    origenId = origen.id

    imagenPath = app.tmpPath(`tst_tlg_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)

    // Cliente + vehículo para el autocompletado y la cola.
    const [clienteId] = await Database.table('clientes').insert({
      nombre: 'TLG Cliente Uno',
      doc_tipo: 'CC',
      doc_numero: 'TLG-001',
      telefono: '3991100001',
    })
    await Database.table('vehiculos').insert({
      placa: 'TLG001',
      clase_vehiculo_id: 1,
      cliente_id: clienteId,
    })
  })

  group.teardown(async () => {
    await limpiarDatos()
    for (const r of subidas) {
      await fs.unlink(app.makePath('uploads', ...r.split('/'))).catch(() => {})
    }
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    const ids = agentes.map((a) => a.id)
    await Database.from('meta_telemercadeo_asesor').whereIn('asesor_id', ids).delete()
    await Database.from('configuracion_seguimiento_tele_asesores').whereIn('asesor_id', ids).delete()
    for (const a of agentes) await a.delete()
    for (const u of usuarios) await u.delete()
  })

  /* ═══════════ Reglas puras ═══════════ */

  test('evaluarCierreCiclo: TURNO gana; VENCIDO por días sin gestión; si no, abierto', ({
    assert,
  }) => {
    const ahora = DateTime.fromISO('2026-11-18T10:00:00', { zone: ZONA })
    const apertura = ahora.minus({ days: 5 })
    const base = { aperturaAt: apertura, diasVigenciaCiclo: 30, ahora }
    assert.equal(
      evaluarCierreCiclo({ ...base, ultimaGestionAt: null, turnoFinalizadoDesdeApertura: true }),
      'TURNO'
    )
    assert.isNull(
      evaluarCierreCiclo({ ...base, ultimaGestionAt: ahora.minus({ days: 29 }), turnoFinalizadoDesdeApertura: false })
    )
    assert.equal(
      evaluarCierreCiclo({ ...base, ultimaGestionAt: ahora.minus({ days: 30 }), turnoFinalizadoDesdeApertura: false }),
      'VENCIDO'
    )
  })

  test('avanceMeta: sin meta → SIN_META sin % (nunca 0%); con meta usa ritmo', ({ assert }) => {
    const sin = avanceMeta(5, null, 0.5)
    assert.equal(sin.semaforo, 'SIN_META')
    assert.isNull(sin.pct)
    assert.isNull(sin.faltante)
    const cero = avanceMeta(5, 0, 1)
    assert.equal(cero.semaforo, 'SIN_META')

    // Mitad del mes: 5 de 10 = 50% de la meta, 100% del ritmo → verde.
    const mitad = avanceMeta(5, 10, 0.5)
    assert.equal(mitad.pct, 50)
    assert.equal(mitad.pct_ritmo, 100)
    assert.equal(mitad.semaforo, 'VERDE')
    assert.equal(mitad.faltante, 5)
    assert.equal(avanceMeta(8, 10, 1).semaforo, 'ROJO')
    assert.equal(avanceMeta(9, 10, 1).semaforo, 'AMARILLO')
  })

  test('parseRango / fraccionTranscurrida en America/Bogota', ({ assert }) => {
    const r = parseRango('2026-11-01', '2026-11-30') as any
    assert.equal(r.inicioSql, '2026-11-01 00:00:00')
    assert.equal(r.finSql, '2026-12-01 00:00:00')
    assert.property(parseRango('2026-11-30', '2026-11-01'), 'error')
    const hoy = DateTime.fromISO('2026-11-15T12:00:00', { zone: ZONA })
    assert.closeTo(fraccionTranscurrida(r, hoy), 15 / 30, 0.0001)
    assert.equal(fraccionTranscurrida(parseRango('2026-10-01', '2026-10-31') as any, hoy), 1)
    assert.equal(fraccionTranscurrida(parseRango('2026-12-01', '2026-12-31') as any, hoy), 1)
  })

  /* ═══════════ Permisos ═══════════ */

  test('permisos: sin sesión 401, OPERATIVO 403, comercial no-tele 403, gerencia no registra', async ({
    client,
    assert,
  }) => {
    ;(await client.get('/api/telemercadeo/gestiones')).assertStatus(401)
    ;(await client.get('/api/telemercadeo/gestiones').headers(bearer('OPERATIVO'))).assertStatus(403)

    const rc = await gestionar(client, { placa: 'TLG900' }, 'COMERCIAL')
    rc.assertStatus(403)
    assert.equal(rc.body().code, 'NO_ES_ASESOR_TELEMERCADEO')

    // SUPER_ADMIN/GERENCIA no registran (la ruta es solo COMERCIAL).
    const ra = await client
      .post('/api/telemercadeo/gestiones')
      .headers(bearer('GERENCIA'))
      .json({ placa: 'TLG900' })
    ra.assertStatus(403)

    // Un comercial no-tele tampoco ve historial.
    ;(await client.get('/api/telemercadeo/gestiones').headers(bearer('COMERCIAL'))).assertStatus(403)
    // Control solo SUPER_ADMIN/GERENCIA.
    ;(await client.get('/api/telemercadeo/resumen').headers(bearer('TELE_A'))).assertStatus(403)
    ;(await client.get('/api/telemercadeo/metas').headers(bearer('TELE_A'))).assertStatus(403)
    ;(await client.get('/api/telemercadeo/resumen').headers(bearer('GERENCIA'))).assertStatus(200)
    // mi-resumen: solo el asesor.
    ;(await client.get('/api/telemercadeo/mi-resumen').headers(bearer('ADMIN'))).assertStatus(403)
    ;(await client.get('/api/telemercadeo/mi-resumen').headers(bearer('COMERCIAL'))).assertStatus(403)
    ;(await client.get('/api/telemercadeo/mi-resumen').headers(bearer('TELE_A'))).assertStatus(200)
  })

  /* ═══════════ Evidencias privadas ═══════════ */

  test('evidencia: se sube a la carpeta privada y GET /uploads/* no la sirve (ni con ../ ni en mayúsculas)', async ({
    client,
    assert,
  }) => {
    const sub = await subir(client)
    assert.isNull(sub.url)
    assert.match(sub.ruta, /^telemercadeo\/\d{4}\/\d{2}\/[a-z0-9]+\.png$/)
    assert.isTrue(fsSync.existsSync(app.makePath('uploads', ...sub.ruta.split('/'))))

    const [, y, m, f] = sub.ruta.split('/')
    const intentos = [
      `/api/uploads/${sub.ruta}`,
      `/api/uploads/TELEMERCADEO/${y}/${m}/${f}`,
      `/api/uploads/dateos/../telemercadeo/${y}/${m}/${f}`,
      `/api/uploads/dateos/%2e%2e/telemercadeo/${y}/${m}/${f}`,
      `/api/uploads/dateos/..%2ftelemercadeo%2f${y}%2f${m}%2f${f}`,
      `/api/uploads/../uploads/telemercadeo/${y}/${m}/${f}`,
    ]
    for (const url of intentos) {
      const r = await client.get(url)
      assert.equal(r.status(), 404, `GET ${url} debía dar 404`)
      assert.notInclude(String(r.header('content-type') ?? ''), 'image', url)
    }

    // Una carpeta pública sigue funcionando igual.
    const publica = await subir(client, 'TELE_A', '')
    assert.match(publica.url, /^\/api\/uploads\/dateos\//)
    ;(await client.get(publica.url)).assertStatus(200)
    await fs.unlink(app.makePath(publica.url.replace(/^\/api\//, ''))).catch(() => {})

    // carpeta desconocida → 400
    const mala = await client
      .post('/api/media/upload')
      .headers(bearer('TELE_A'))
      .field('carpeta', 'certificaciones')
      .file('file', imagenPath)
    mala.assertStatus(400)
  })

  test('evidencia: DELETE /uploads/* no puede borrarla (ruta directa, ../ ni mayúsculas)', async ({
    client,
    assert,
  }) => {
    const sub = await subir(client)
    const abs = app.makePath('uploads', ...sub.ruta.split('/'))
    const [, y, m, f] = sub.ruta.split('/')
    const intentos = [
      `/api/uploads/${sub.ruta}`,
      `/api/uploads/TELEMERCADEO/${y}/${m}/${f}`,
      `/api/uploads/dateos/../telemercadeo/${y}/${m}/${f}`,
      `/api/uploads/dateos/%2e%2e/telemercadeo/${y}/${m}/${f}`,
      `/api/uploads/dateos/..%2ftelemercadeo%2f${y}%2f${m}%2f${f}`,
    ]
    for (const url of intentos) {
      const r = await client.delete(url).headers(bearer('ADMIN'))
      assert.oneOf(r.status(), [403, 404], `DELETE ${url}`)
      assert.isTrue(fsSync.existsSync(abs), `la evidencia debe seguir existiendo tras DELETE ${url}`)
    }
  })

  test('evidencia: endpoint autenticado solo para el dueño o gerencia', async ({ client, assert }) => {
    const r = await gestionar(client, { placa: 'TLG002' })
    r.assertStatus(201)
    const id = r.body().gestion.id
    assert.equal(r.body().gestion.evidencia_url, `/api/telemercadeo/gestiones/${id}/evidencia`)

    ;(await client.get(`/api/telemercadeo/gestiones/${id}/evidencia`)).assertStatus(401)
    const own = await client.get(`/api/telemercadeo/gestiones/${id}/evidencia`).headers(bearer('TELE_A'))
    own.assertStatus(200)
    assert.include(String(own.header('cache-control')), 'no-store')
    ;(await client.get(`/api/telemercadeo/gestiones/${id}/evidencia`).headers(bearer('TELE_B'))).assertStatus(403)
    ;(await client.get(`/api/telemercadeo/gestiones/${id}/evidencia`).headers(bearer('GERENCIA'))).assertStatus(200)
  })

  /* ═══════════ Registrar: validaciones, idempotencia, alcance ═══════════ */

  test('registrar: validaciones (evidencia, DATEADO manual, medio, origen, placa)', async ({
    client,
    assert,
  }) => {
    const casos: Array<[Record<string, unknown>, string]> = [
      [{ placa: 'TLG003', evidencia_ruta: 'dateos/2026/11/x.png' }, 'EVIDENCIA_INVALIDA'],
      [{ placa: 'TLG003', evidencia_ruta: 'telemercadeo/2026/11/noexiste.png' }, 'EVIDENCIA_NO_EXISTE'],
      [{ placa: 'TLG003', resultado: 'DATEADO' }, 'RESULTADO_INVALIDO'],
      [{ placa: 'TLG003', medio: 'FAX' }, 'MEDIO_INVALIDO'],
      [{ placa: 'TLG003', origen_id: 999999 }, 'ORIGEN_INVALIDO'],
      [{ placa: '!!' }, 'PLACA_INVALIDA'],
      [{ placa: 'TLG003', idempotency_key: 'x' }, 'IDEMPOTENCIA_INVALIDA'],
    ]
    for (const [body, code] of casos) {
      const r = await gestionar(client, body)
      r.assertStatus(400)
      assert.equal(r.body().code, code)
    }
    const n = await Database.from('telemercadeo_gestiones').where('placa', 'TLG003').count('* as n')
    assert.equal(Number(n[0].n), 0)
  })

  test('registrar: autocompleta cliente/teléfono, normaliza placa e ignora agente_id del body', async ({
    client,
    assert,
  }) => {
    const r = await gestionar(client, {
      placa: 'tlg-001',
      agente_id: teleB.id,
      observacion: '  Cliente pide llamar mañana  ',
      proximo_contacto_at: '2026-12-01',
    })
    r.assertStatus(201)
    const g = r.body().gestion
    assert.equal(g.placa, 'TLG001')
    assert.equal(g.agente_id, teleA.id)
    assert.equal(g.telefono, '3991100001')
    assert.equal(g.cliente_nombre, 'TLG Cliente Uno')
    assert.equal(g.observacion, 'Cliente pide llamar mañana')
    assert.equal(g.proximo_contacto_at, '2026-12-01')
    assert.equal(g.seguimiento.numero_en_ciclo, 1)
    assert.deepInclude(r.body().seguimiento, { n: 1, max: 3, limite: 3, puede_registrar: true })
  })

  test('idempotencia: mismo idempotency_key → misma gestión (200), también en paralelo', async ({
    client,
    assert,
  }) => {
    const ev = (await subir(client)).ruta
    const k = key()
    const body = { placa: 'TLG004', idempotency_key: k, evidencia_ruta: ev }
    const r1 = await gestionar(client, body)
    r1.assertStatus(201)
    const r2 = await gestionar(client, body)
    r2.assertStatus(200)
    assert.isTrue(r2.body().repetida)
    assert.equal(r2.body().gestion.id, r1.body().gestion.id)

    // Doble clic simultáneo con otra clave.
    const k2 = key()
    const [a, b] = await Promise.all([
      gestionar(client, { placa: 'TLG004', idempotency_key: k2, evidencia_ruta: ev }),
      gestionar(client, { placa: 'TLG004', idempotency_key: k2, evidencia_ruta: ev }),
    ])
    assert.sameMembers([a.status(), b.status()], [200, 201])
    assert.equal(a.body().gestion.id, b.body().gestion.id)
    const filas = await Database.from('telemercadeo_gestiones').where('placa', 'TLG004')
    assert.lengthOf(filas, 2)
  })

  test('alcance: cada asesor ve solo sus gestiones; gerencia ve todas y filtra por asesor', async ({
    client,
    assert,
  }) => {
    const rb = await gestionar(client, { placa: 'TLG005' }, 'TELE_B')
    rb.assertStatus(201)
    const idB = rb.body().gestion.id

    const listaA = await client
      .get('/api/telemercadeo/gestiones')
      .headers(bearer('TELE_A'))
      .qs({ agente_id: teleB.id, per_page: 100 })
    listaA.assertStatus(200)
    assert.isTrue(listaA.body().data.every((g: any) => g.agente_id === teleA.id))
    assert.notInclude(listaA.body().data.map((g: any) => g.id), idB)
    ;(await client.get(`/api/telemercadeo/gestiones/${idB}`).headers(bearer('TELE_A'))).assertStatus(403)
    ;(await client.get(`/api/telemercadeo/gestiones/${idB}`).headers(bearer('TELE_B'))).assertStatus(200)

    const listaG = await client
      .get('/api/telemercadeo/gestiones')
      .headers(bearer('GERENCIA'))
      .qs({ agente_id: teleB.id, per_page: 100 })
    listaG.assertStatus(200)
    assert.include(listaG.body().data.map((g: any) => g.id), idB)
    assert.isTrue(listaG.body().data.every((g: any) => g.agente_id === teleB.id))
    assert.properties(listaG.body().meta, ['total', 'current_page', 'per_page', 'last_page'])
  })

  /* ═══════════ Límite de seguimientos ═══════════ */

  test('límite: 3 por cliente sumando asesores; la 4ª → 409 SEGUIMIENTO_LIMITE', async ({
    client,
    assert,
  }) => {
    ;(await gestionar(client, { placa: 'TLG010' }, 'TELE_A')).assertStatus(201)
    const r2 = await gestionar(client, { placa: 'TLG010' }, 'TELE_B')
    r2.assertStatus(201)
    assert.equal(r2.body().seguimiento.n, 2)
    const r3 = await gestionar(client, { placa: 'TLG010' }, 'TELE_A')
    r3.assertStatus(201)
    assert.equal(r3.body().gestion.seguimiento.numero_en_ciclo, 3)
    assert.isFalse(r3.body().seguimiento.puede_registrar)

    const r4 = await gestionar(client, { placa: 'TLG010' }, 'TELE_B')
    r4.assertStatus(409)
    assert.equal(r4.body().code, 'SEGUIMIENTO_LIMITE')
    assert.deepInclude(r4.body(), { n: 3, max: 3, limite: 3 })

    // El ciclo es por placa + servicio: otro servicio abre su propio ciclo.
    const soat = await Database.from('servicios').where('codigo_servicio', 'SOAT').first()
    ;(await gestionar(client, { placa: 'TLG010', servicio_id: soat.id })).assertStatus(201)
  })

  test('límite en paralelo: con 2 de 3, dos envíos simultáneos → solo uno pasa', async ({
    client,
    assert,
  }) => {
    ;(await gestionar(client, { placa: 'TLG011' })).assertStatus(201)
    ;(await gestionar(client, { placa: 'TLG011' })).assertStatus(201)
    const [a, b] = await Promise.all([
      gestionar(client, { placa: 'TLG011' }, 'TELE_A'),
      gestionar(client, { placa: 'TLG011' }, 'TELE_B'),
    ])
    assert.sameMembers([a.status(), b.status()], [201, 409])
    const ciclo = await Database.from('telemercadeo_ciclos').where('placa', 'TLG011').first()
    assert.equal(Number(ciclo.numero_gestiones), 3)
    const n = await Database.from('telemercadeo_gestiones').where('placa', 'TLG011').count('* as n')
    assert.equal(Number(n[0].n), 3)
  })

  test('extra: gerencia autoriza con motivo obligatorio (quién y cuándo) y habilita una gestión más', async ({
    client,
    assert,
  }) => {
    for (let i = 0; i < 3; i++) (await gestionar(client, { placa: 'TLG012' })).assertStatus(201)
    const r4 = await gestionar(client, { placa: 'TLG012' })
    r4.assertStatus(409)
    const cicloId = r4.body().ciclo_id

    ;(await client
      .post(`/api/telemercadeo/ciclos/${cicloId}/autorizar-extra`)
      .headers(bearer('TELE_A'))
      .json({ motivo: 'quiero otra' })).assertStatus(403)
    const sinMotivo = await client
      .post(`/api/telemercadeo/ciclos/${cicloId}/autorizar-extra`)
      .headers(bearer('GERENCIA'))
      .json({ motivo: '  ' })
    sinMotivo.assertStatus(400)
    assert.equal(sinMotivo.body().code, 'MOTIVO_INVALIDO')

    const ok = await client
      .post(`/api/telemercadeo/ciclos/${cicloId}/autorizar-extra`)
      .headers(bearer('GERENCIA'))
      .json({ motivo: 'Cliente pidió que lo llamen el viernes' })
    ok.assertStatus(200)
    assert.equal(ok.body().extras_autorizados, 1)
    assert.lengthOf(ok.body().autorizaciones, 1)
    const aut = ok.body().autorizaciones[0]
    assert.equal(aut.motivo, 'Cliente pidió que lo llamen el viernes')
    assert.equal(aut.usuario_id, usuarios.find((u) => u.apellidos === 'TLG-GERENCIA')!.id)
    assert.isString(aut.created_at)

    const r5 = await gestionar(client, { placa: 'TLG012' })
    r5.assertStatus(201)
    assert.deepInclude(r5.body().seguimiento, { n: 4, limite: 4 })
    ;(await gestionar(client, { placa: 'TLG012' })).assertStatus(409)
  })

  test('configuración: override por asesor (patrón max-redateos) cambia su límite', async ({
    client,
    assert,
  }) => {
    const g = await client.get('/api/telemercadeo/config/max-seguimientos').headers(bearer('TELE_A'))
    g.assertStatus(200)
    assert.equal(g.body().max_seguimientos, 3)
    ;(await client
      .post('/api/telemercadeo/config/max-seguimientos/asesores')
      .headers(bearer('TELE_A'))
      .json({ asesor_id: teleA.id, max_seguimientos: 1 })).assertStatus(403)
    ;(await client
      .post('/api/telemercadeo/config/max-seguimientos/asesores')
      .headers(bearer('GERENCIA'))
      .json({ asesor_id: comercial.id, max_seguimientos: 1 })).assertStatus(400)

    const up = await client
      .post('/api/telemercadeo/config/max-seguimientos/asesores')
      .headers(bearer('GERENCIA'))
      .json({ asesor_id: teleA.id, max_seguimientos: 1 })
    up.assertStatus(200)

    ;(await gestionar(client, { placa: 'TLG013' })).assertStatus(201)
    const r2 = await gestionar(client, { placa: 'TLG013' })
    r2.assertStatus(409)
    assert.equal(r2.body().max, 1)
    // B no tiene override: su límite sigue siendo 3 sobre el mismo ciclo.
    ;(await gestionar(client, { placa: 'TLG013' }, 'TELE_B')).assertStatus(201)

    ;(await client
      .delete(`/api/telemercadeo/config/max-seguimientos/asesores/${up.body().id}`)
      .headers(bearer('GERENCIA'))).assertStatus(200)
  })

  /* ═══════════ Cierre del ciclo ═══════════ */

  test('ciclo: VENCIDO tras días sin gestión y TURNO tras un turno finalizado → ciclo nuevo', async ({
    client,
    assert,
  }) => {
    for (let i = 0; i < 3; i++) (await gestionar(client, { placa: 'TLG014' })).assertStatus(201)
    const viejo = DateTime.now().minus({ days: 40 }).toFormat('yyyy-LL-dd HH:mm:ss')
    await Database.from('telemercadeo_ciclos')
      .where('placa', 'TLG014')
      .update({ created_at: viejo, ultima_gestion_at: viejo })
    const r = await gestionar(client, { placa: 'TLG014' })
    r.assertStatus(201)
    assert.equal(r.body().seguimiento.n, 1)
    const ciclos = await Database.from('telemercadeo_ciclos').where('placa', 'TLG014').orderBy('id')
    assert.lengthOf(ciclos, 2)
    assert.equal(ciclos[0].cerrado_motivo, 'VENCIDO')
    assert.isNull(ciclos[0].abierto_key)

    for (let i = 0; i < 2; i++) (await gestionar(client, { placa: 'TLG015' })).assertStatus(201)
    await turno('TLG015', DateTime.now().setZone(ZONA))
    const rt = await gestionar(client, { placa: 'TLG015' })
    rt.assertStatus(201)
    assert.equal(rt.body().seguimiento.n, 1)
    const c15 = await Database.from('telemercadeo_ciclos').where('placa', 'TLG015').orderBy('id')
    assert.equal(c15[0].cerrado_motivo, 'TURNO')
  })

  test('avisos: dateo activo de otro asesor no bloquea la gestión, solo avisa', async ({
    client,
    assert,
  }) => {
    const d = await CaptacionDateo.create({
      canal: 'ASESOR_COMERCIAL',
      origen: 'UI',
      placa: 'TLG016',
      agenteId: comercial.id,
      servicioId: SERVICIO_RTM,
      resultado: 'PENDIENTE',
      liberado: false,
    } as any)
    const r = await gestionar(client, { placa: 'TLG016' })
    r.assertStatus(201)
    assert.equal(r.body().avisos.dateo_activo.dateo_id, d.id)
    assert.isFalse(r.body().avisos.dateo_activo.es_propio)

    const s = await client
      .get('/api/telemercadeo/seguimiento')
      .headers(bearer('TELE_A'))
      .qs({ placa: 'TLG016' })
    s.assertStatus(200)
    assert.equal(s.body().avisos.dateo_activo.dateo_id, d.id)
    assert.equal(s.body().seguimiento.n, 1)
    assert.lengthOf(s.body().gestiones_ciclo, 1)
  })

  test('seguimiento: solo ASESOR_TELEMERCADEO, SUPER_ADMIN y GERENCIA; COMERCIAL → 403', async ({
    client,
    assert,
  }) => {
    const pedir = (k?: string) => {
      const req = client.get('/api/telemercadeo/seguimiento').qs({ placa: 'TLG016' })
      return k ? req.headers(bearer(k)) : req
    }
    ;(await pedir()).assertStatus(401)
    ;(await pedir('OPERATIVO')).assertStatus(403)
    const c = await pedir('COMERCIAL')
    c.assertStatus(403)
    assert.equal(c.body().code, 'NO_ES_ASESOR_TELEMERCADEO')
    for (const k of ['TELE_A', 'TELE_B', 'ADMIN', 'GERENCIA']) {
      const r = await pedir(k)
      r.assertStatus(200)
      assert.equal(r.body().seguimiento.n, 1)
    }
  })

  test('avisos: RTM vigente con la ventana compartida (DIAS_VENTANA_PRE_RTM)', async ({ client, assert }) => {
    const fecha = DateTime.now().setZone(ZONA).minus({ months: 2 })
    await turno('TLG017', fecha)
    const s = await client
      .get('/api/telemercadeo/seguimiento')
      .headers(bearer('TELE_A'))
      .qs({ placa: 'TLG017' })
    s.assertStatus(200)
    const vence = fecha.plus({ months: 12 }).startOf('day')
    const dias = Number(process.env.DIAS_VENTANA_PRE_RTM ?? 10)
    assert.equal(s.body().avisos.rtm_vigente.vence_el, vence.toISODate())
    assert.equal(s.body().avisos.rtm_vigente.puede_datear_desde, vence.minus({ days: dias }).toISODate())
  })

  /* ═══════════ Cola ═══════════ */

  test('cola: CLIENTES marca RTM vigente con fecha y muestra el seguimiento de la placa', async ({
    client,
    assert,
  }) => {
    await turno('TLG001', DateTime.now().setZone(ZONA).minus({ months: 3 }))
    const r = await client
      .get('/api/telemercadeo/cola')
      .headers(bearer('TELE_A'))
      .qs({ lista: 'CLIENTES', q: 'TLG Cliente Uno', per_page: 10 })
    r.assertStatus(200)
    const fila = r.body().data.find((f: any) => f.placas.includes('TLG001'))
    assert.exists(fila)
    assert.lengthOf(fila.rtm_vigentes, 1)
    assert.equal(fila.rtm_vigentes[0].placa, 'TLG001')
    assert.isString(fila.rtm_vigentes[0].puede_datear_desde)
    assert.exists(fila.seguimiento)
    assert.equal(fila.seguimiento.placa, 'TLG001')
    assert.isAtLeast(fila.seguimiento.n, 1)
    assert.equal(fila.seguimiento.limite, 3)
    assert.equal(r.body().meta.parametros.dias_ventana_previa, Number(process.env.DIAS_VENTANA_PRE_RTM ?? 10))
  })

  /* ═══════════ Metas ═══════════ */

  test('metas: guardar, leer, borrar con todo vacío y validar asesor de Telemercadeo', async ({
    client,
    assert,
  }) => {
    const put = await client
      .put('/api/telemercadeo/metas')
      .headers(bearer('GERENCIA'))
      .json({
        mes: 1,
        anio: 2031,
        metas: [
          { asesor_id: teleA.id, meta_gestiones: 100, meta_dateos: 20, meta_exitosos: 10 },
          { asesor_id: teleB.id, meta_gestiones: null, meta_dateos: '', meta_exitosos: 5 },
        ],
      })
    put.assertStatus(200)
    const a = put.body().data.find((x: any) => x.asesor_id === teleA.id)
    assert.deepInclude(a, { meta_gestiones: 100, meta_dateos: 20, meta_exitosos: 10 })
    const b = put.body().data.find((x: any) => x.asesor_id === teleB.id)
    assert.deepInclude(b, { meta_gestiones: null, meta_dateos: null, meta_exitosos: 5 })

    ;(await client
      .put('/api/telemercadeo/metas')
      .headers(bearer('GERENCIA'))
      .json({ mes: 1, anio: 2031, metas: [{ asesor_id: comercial.id, meta_exitosos: 1 }] })).assertStatus(400)
    ;(await client
      .put('/api/telemercadeo/metas')
      .headers(bearer('GERENCIA'))
      .json({ mes: 1, anio: 2031, metas: [{ asesor_id: teleA.id, meta_exitosos: -1 }] })).assertStatus(400)

    const borrar = await client
      .put('/api/telemercadeo/metas')
      .headers(bearer('GERENCIA'))
      .json({ mes: 1, anio: 2031, metas: [{ asesor_id: teleB.id }] })
    borrar.assertStatus(200)
    const filasB = await Database.from('meta_telemercadeo_asesor').where({ asesor_id: teleB.id, mes: 1, anio: 2031 })
    assert.lengthOf(filasB, 0)
  })

  test('metas: copiar del mes anterior sin sobrescribir las existentes', async ({ client, assert }) => {
    await client
      .put('/api/telemercadeo/metas')
      .headers(bearer('GERENCIA'))
      .json({
        mes: 2,
        anio: 2031,
        metas: [
          { asesor_id: teleA.id, meta_exitosos: 7 },
          { asesor_id: teleB.id, meta_exitosos: 8 },
        ],
      })
    await client
      .put('/api/telemercadeo/metas')
      .headers(bearer('GERENCIA'))
      .json({ mes: 3, anio: 2031, metas: [{ asesor_id: teleB.id, meta_exitosos: 99 }] })

    const c = await client
      .post('/api/telemercadeo/metas/copiar')
      .headers(bearer('GERENCIA'))
      .json({ desde_mes: 2, desde_anio: 2031, hacia_mes: 3, hacia_anio: 2031 })
    c.assertStatus(200)
    assert.equal(c.body().copiadas, 1)
    assert.equal(c.body().omitidas, 1)
    assert.equal(c.body().data.find((x: any) => x.asesor_id === teleA.id).meta_exitosos, 7)
    assert.equal(c.body().data.find((x: any) => x.asesor_id === teleB.id).meta_exitosos, 99)

    const s = await client
      .post('/api/telemercadeo/metas/copiar')
      .headers(bearer('GERENCIA'))
      .json({ desde_mes: 2, desde_anio: 2031, hacia_mes: 3, hacia_anio: 2031, sobrescribir: true })
    s.assertStatus(200)
    assert.equal(s.body().data.find((x: any) => x.asesor_id === teleB.id).meta_exitosos, 8)
  })

  /* ═══════════ Resumen ═══════════ */

  test('resumen: totales, por medio/origen/resultado, embudo y tabla por asesor con datos controlados', async ({
    client,
    assert,
  }) => {
    // Rango futuro aislado: se mueven a 2031-04 las gestiones de TLG02x.
    const g1 = await gestionar(client, { placa: 'TLG020', medio: 'WHATSAPP', resultado: 'INTERESADO' })
    const g2 = await gestionar(client, { placa: 'TLG021', medio: 'LLAMADA' })
    const g3 = await gestionar(client, { placa: 'TLG022', medio: 'CORREO' }, 'TELE_B')
    for (const r of [g1, g2, g3]) r.assertStatus(201)

    const d = await CaptacionDateo.create({
      canal: 'TELE',
      origen: 'UI',
      placa: 'TLG020',
      agenteId: teleA.id,
      servicioId: SERVICIO_RTM,
      resultado: 'EXITOSO',
      liberado: true,
    } as any)
    await Database.from('telemercadeo_gestiones')
      .where('id', g1.body().gestion.id)
      .update({ captacion_dateo_id: d.id, resultado: 'DATEADO' })
    await Database.from('telemercadeo_gestiones')
      .whereIn('placa', ['TLG020', 'TLG021', 'TLG022'])
      .update({ created_at: '2031-04-10 09:00:00' })
    await client
      .put('/api/telemercadeo/metas')
      .headers(bearer('GERENCIA'))
      .json({ mes: 4, anio: 2031, metas: [{ asesor_id: teleA.id, meta_exitosos: 2 }] })

    const r = await client
      .get('/api/telemercadeo/resumen')
      .headers(bearer('GERENCIA'))
      .qs({ desde: '2031-04-01', hasta: '2031-04-30' })
    r.assertStatus(200)
    const b = r.body()
    assert.deepInclude(b.totales, { gestiones: 3, dateos: 1, exitosos: 1, tasa_dateo: 33.3 })
    assert.equal(b.por_medio.find((m: any) => m.medio === 'WHATSAPP').gestiones, 1)
    assert.equal(b.por_origen.find((o: any) => o.codigo === 'GOOGLE_ADS').gestiones, 3)
    assert.equal(b.por_origen.find((o: any) => o.codigo === 'REDES').gestiones, 0)
    assert.equal(b.por_resultado.find((x: any) => x.resultado === 'DATEADO').gestiones, 1)

    const a = b.por_asesor.find((x: any) => x.agente_id === teleA.id)
    assert.deepInclude(a, { gestiones: 2, dateos: 1, exitosos: 1 })
    assert.deepInclude(a.metas.exitosos, { meta: 2, avance: 1, faltante: 1, pct: 50 })
    // Periodo que aún no empieza: sin prorrateo, 50% de la meta completa → rojo.
    assert.equal(a.metas.exitosos.pct_ritmo, 50)
    assert.equal(a.semaforo, 'ROJO')
    const bb = b.por_asesor.find((x: any) => x.agente_id === teleB.id)
    assert.equal(bb.metas.exitosos.semaforo, 'SIN_META')
    assert.isNull(bb.metas.exitosos.pct)

    const solo = await client
      .get('/api/telemercadeo/resumen')
      .headers(bearer('GERENCIA'))
      .qs({ desde: '2031-04-01', hasta: '2031-04-30', agente_id: teleB.id })
    solo.assertStatus(200)
    assert.equal(solo.body().totales.gestiones, 1)
    assert.lengthOf(solo.body().por_asesor, 1)

    const x = await client
      .get('/api/telemercadeo/resumen/excel')
      .headers(bearer('GERENCIA'))
      .qs({ desde: '2031-04-01', hasta: '2031-04-30' })
    x.assertStatus(200)
    assert.include(String(x.header('content-type')), 'spreadsheetml')
    assert.include(String(x.header('content-disposition')), 'Telemercadeo_20310401_a_20310430.xlsx')
    assert.isUndefined(x.header('x-detalle-truncado'))
  })

  test('resumen/excel: si el detalle supera el tope se avisa (cabecera y aviso en las hojas), nunca en silencio', async ({
    assert,
  }) => {
    // Mismo rango aislado 2031-04 que el test anterior (3 gestiones TLG02x).
    const hoja = async () => {
      // El cliente de Japa no expone el cuerpo binario: fetch al mismo servidor.
      const r = await fetch(
        `http://${process.env.HOST}:${process.env.PORT}/api/telemercadeo/resumen/excel?desde=2031-04-01&hasta=2031-04-30`,
        { headers: bearer('GERENCIA') }
      )
      assert.equal(r.status, 200)
      const wb = new ExcelJS.Workbook()
      await wb.xlsx.load((await r.arrayBuffer()) as any)
      const filas = (nombre: string) => {
        const out: string[] = []
        wb.getWorksheet(nombre)!.eachRow((row) => out.push(String(row.getCell(1).value ?? '')))
        return out
      }
      return { truncado: r.headers.get('x-detalle-truncado'), gestiones: filas('Gestiones'), resumen: filas('Resumen') }
    }

    const completo = await hoja()
    assert.isNull(completo.truncado)
    assert.lengthOf(completo.gestiones, 4) // encabezado + 3
    assert.notInclude(completo.gestiones.join('|'), '⚠️')

    const previo = process.env.TELE_EXCEL_MAX_DETALLE
    process.env.TELE_EXCEL_MAX_DETALLE = '1'
    try {
      const corto = await hoja()
      assert.equal(corto.truncado, '1')
      assert.lengthOf(corto.gestiones, 3) // aviso + encabezado + 1
      assert.include(corto.gestiones[0], 'solo las primeras 1 gestiones de 3')
      assert.isTrue(corto.resumen.some((f) => f.includes('solo las primeras 1 gestiones de 3')))
    } finally {
      if (previo === undefined) delete process.env.TELE_EXCEL_MAX_DETALLE
      else process.env.TELE_EXCEL_MAX_DETALLE = previo
    }
  })

  test('mi-resumen: sin meta → SIN_META y sin %; KPIs del propio asesor', async ({ client, assert }) => {
    const hoy = DateTime.now().setZone(ZONA)
    const r = await client
      .get('/api/telemercadeo/mi-resumen')
      .headers(bearer('TELE_B'))
      .qs({ mes: hoy.month, anio: hoy.year })
    r.assertStatus(200)
    assert.equal(r.body().agente.id, teleB.id)
    assert.equal(r.body().semaforo, 'SIN_META')
    assert.isNull(r.body().metas.exitosos.pct)
    assert.isNull(r.body().metas.gestiones.meta)
    assert.isAtLeast(r.body().gestiones, 1)
    assert.isAtLeast(r.body().gestiones_hoy, 1)
  })
})
