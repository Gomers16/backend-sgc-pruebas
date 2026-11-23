import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import TurnoRtm from '#models/turno_rtm'
import { columnaOrigenDateo } from '#services/telemercadeo_origen_service'
import FacturacionTicket from '#models/facturacion_ticket'

// Ticket de Excepción de Dateo que nace de una gestión de Telemercadeo:
// 409 REQUIERE_TICKET_DATEO → crear() guarda tickets_detalle_excepcion_dateo
// .telemercadeo_gestion_id → aprobar() crea el dateo TELE y deja la gestión
// DATEADO. Necesita la migración 1819 (si la columna no existe, se omite: se
// corre contra una copia de la BD). Placas TLK1**, agentes "TEST TLK".

const SEDE_ID = 3
const ROL = { SUPER_ADMIN: 9, COMERCIAL: 11 }
const ZONA = 'America/Bogota'
const MOTIVO = 'migración 1819/1820 sin aplicar en esta BD'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

async function columnaAplicada() {
  const r = await Database.rawQuery(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'tickets_detalle_excepcion_dateo'
        AND column_name = 'telemercadeo_gestion_id'`
  )
  return Number(r[0][0].n) > 0 && (await columnaOrigenDateo())
}

async function limpiar() {
  const turnos = await Database.from('turnos_rtms').where('placa', 'like', 'TLK1%').select('id')
  const turnoIds = turnos.map((t: any) => t.id)
  if (turnoIds.length) {
    const det = await Database.from('tickets_detalle_excepcion_dateo')
      .whereIn('turno_id', turnoIds)
      .select('ticket_id')
    const ticketIds = det.map((d: any) => d.ticket_id)
    await Database.from('tickets_detalle_excepcion_dateo').whereIn('turno_id', turnoIds).delete()
    if (ticketIds.length) await Database.from('tickets').whereIn('id', ticketIds).delete()
  }
  const gestiones = await Database.from('telemercadeo_gestiones')
    .where('placa', 'like', 'TLK1%')
    .select('evidencia_ruta')
  for (const g of gestiones) {
    await fs.unlink(app.makePath('uploads', ...String(g.evidencia_ruta).split('/'))).catch(() => {})
  }
  await Database.from('telemercadeo_gestiones').where('placa', 'like', 'TLK1%').delete()
  await Database.from('telemercadeo_ciclos').where('placa', 'like', 'TLK1%').delete()
  await Database.rawQuery(
    `DELETE FROM comisiones WHERE captacion_dateo_id IN
       (SELECT id FROM captacion_dateos WHERE placa LIKE 'TLK1%')`
  )
  await Database.from('facturacion_tickets').where('placa', 'like', 'TLK1%').delete()
  await Database.from('turnos_rtms').where('placa', 'like', 'TLK1%').delete()
  await Database.from('captacion_dateos').where('placa', 'like', 'TLK1%').delete()
  await Database.from('prospectos').where('placa', 'like', 'TLK1%').delete()
}

test.group('Telemercadeo · ticket desde gestión', (group) => {
  group.each.timeout(60_000)

  let aplicada = false
  const usuarios: Usuario[] = []
  const agentes: AgenteCaptacion[] = []
  const tokens: Record<string, string> = {}
  const subidas: string[] = []
  let teleA: AgenteCaptacion
  let teleB: AgenteCaptacion
  let imagenPath = ''
  let origenId = 0
  let servicioRtm = 0
  let seq = 0

  const bearer = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` })

  async function usuario(k: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TLK-${k}`,
      correo: `test.tlk.${k.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    usuarios.push(u)
    tokens[k] = (await Usuario.accessTokens.create(u)).value!.release()
    return u
  }

  async function agenteTele(nombre: string, usuarioId: number) {
    const a = await AgenteCaptacion.create({
      sedeId: SEDE_ID,
      tipo: 'ASESOR_TELEMERCADEO',
      nombre,
      usuarioId,
    } as any)
    agentes.push(a)
    return a
  }

  async function gestion(client: any, placa: string, k = 'TELE_A') {
    const up = await client
      .post('/api/media/upload')
      .headers(bearer(k))
      .field('carpeta', 'telemercadeo')
      .file('file', imagenPath)
    up.assertStatus(201)
    subidas.push(up.body().ruta)
    const r = await client
      .post('/api/telemercadeo/gestiones')
      .headers(bearer(k))
      .json({
        placa,
        medio: 'LLAMADA',
        origen_id: origenId,
        resultado: 'INTERESADO',
        idempotency_key: `tlk-${Date.now()}-${++seq}`,
        evidencia_ruta: up.body().ruta,
      })
    r.assertStatus(201)
    return r.body().gestion.id as number
  }

  async function turno(placa: string) {
    seq++
    const n = 985000 + seq
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuarios[0].id,
      servicioId: servicioRtm,
      fecha: DateTime.now().setZone(ZONA),
      horaIngreso: '06:00',
      turnoNumero: n,
      turnoNumeroServicio: n,
      turnoCodigo: `TST-TLK-${placa}-${seq}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      tieneFacturacion: false,
      esSegundaVez: false,
    } as any)
  }

  async function crearTicket(
    client: any,
    k: string,
    turnoId: number,
    gestionId: number,
    extra: Record<string, unknown> = {}
  ) {
    const subir = async () => {
      const r = await client.post('/api/media/upload').headers(bearer(k)).file('file', imagenPath)
      r.assertStatus(201)
      subidas.push(String(r.body().url).replace(/^\/api\/uploads\//, ''))
      return r.body().url as string
    }
    return client
      .post('/api/tickets-excepcion-dateo')
      .headers(bearer(k))
      .json({
        turno_id: turnoId,
        observacion: 'Prueba ticket desde gestión',
        sin_convenio: true,
        telemercadeo_gestion_id: gestionId,
        evidencia_chat_url: await subir(),
        evidencia_grupo_whatsapp_url: await subir(),
        evidencia_bloqueo_url: await subir(),
        ...extra,
      })
  }

  const aprobar = (client: any, id: number, body: Record<string, unknown> = {}) =>
    client
      .patch(`/api/tickets-excepcion-dateo/${id}/aprobar`)
      .headers(bearer('ADMIN'))
      .json({ con_comision: true, ...body })
  const detalleDe = (turnoId: number) =>
    Database.from('tickets_detalle_excepcion_dateo').where('turno_id', turnoId).first()
  const gestionBd = (id: number) =>
    Database.from('telemercadeo_gestiones').where('id', id).firstOrFail()

  group.setup(async () => {
    aplicada = await columnaAplicada()
    if (!aplicada) return
    await limpiar()
    await usuario('ADMIN', ROL.SUPER_ADMIN)
    const uA = await usuario('TELE_A', ROL.COMERCIAL)
    const uB = await usuario('TELE_B', ROL.COMERCIAL)
    teleA = await agenteTele(`TEST TLK A ${Date.now()}`, uA.id)
    teleB = await agenteTele(`TEST TLK B ${Date.now()}`, uB.id)
    origenId = (await Database.from('telemercadeo_origenes').where('codigo', 'GOOGLE_ADS').first())
      .id
    servicioRtm = (await Database.from('servicios').where('codigo_servicio', 'RTM').first()).id
    imagenPath = app.tmpPath(`tst_tlk_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    if (!aplicada) return
    await limpiar()
    for (const r of subidas) {
      await fs.unlink(app.makePath('uploads', ...r.split('/'))).catch(() => {})
    }
    await fs.unlink(imagenPath).catch(() => {})
    for (const a of agentes) await a.delete()
    for (const u of usuarios) await u.delete()
  })

  const saltar = async () => !(await columnaAplicada())

  test('gestión → aviso → 409 → ticket → aprobar: dateo TELE, gestión DATEADO, sin comisión', async ({
    client,
    assert,
  }) => {
    const gId = await gestion(client, 'TLK101')
    const t = await turno('TLK101')

    const seg = await client
      .get('/api/telemercadeo/seguimiento')
      .headers(bearer('TELE_A'))
      .qs({ placa: 'TLK101' })
    seg.assertStatus(200)
    assert.equal(seg.body().avisos.turno_hoy_sin_dateo.turno_id, t.id)

    const r409 = await client.post('/api/captacion-dateos').headers(bearer('TELE_A')).json({
      origen: 'UI',
      placa: 'TLK101',
      telefono: '3991330001',
      telemercadeo_gestion_id: gId,
    })
    r409.assertStatus(409)
    assert.equal(r409.body().code, 'REQUIERE_TICKET_DATEO')
    assert.equal(r409.body().intento.canal, 'TELE')

    const c = await crearTicket(client, 'TELE_A', t.id, gId, { telefono: '3991330001' })
    c.assertStatus(201)
    const ticketId = c.body().ticket.id
    const d = await detalleDe(t.id)
    assert.equal(d.telemercadeo_gestion_id, gId)
    assert.equal(d.canal, 'TELE')
    assert.equal(d.servicio_id, servicioRtm)
    assert.isNull(d.convenio_id)
    assert.isNull(d.descuento_id)
    assert.equal((await gestionBd(gId)).resultado, 'INTERESADO')

    // El id de la gestión vive solo en la columna, no en el JSON de los eventos.
    const eventos = await Database.from('ticket_eventos').where('ticket_id', ticketId)
    assert.isNotEmpty(eventos)
    for (const e of eventos) assert.notInclude(JSON.stringify(e), 'gestion')

    await FacturacionTicket.create({
      sedeId: SEDE_ID,
      hash: `TEST-TLK-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId: t.id,
      placa: 'TLK101',
      servicioCodigo: 'RTM',
    } as any)
    const a = await aprobar(client, ticketId)
    a.assertStatus(200)

    const dateo = await Database.from('captacion_dateos').where('placa', 'TLK101').firstOrFail()
    assert.equal(dateo.canal, 'TELE')
    assert.equal(dateo.agente_id, teleA.id)
    assert.equal(dateo.resultado, 'EXITOSO')
    assert.isNull(dateo.convenio_id)
    const g = await gestionBd(gId)
    assert.equal(g.resultado, 'DATEADO')
    assert.equal(g.captacion_dateo_id, dateo.id)
    const ciclo = await Database.from('telemercadeo_ciclos').where('id', g.ciclo_id).firstOrFail()
    assert.isNull(ciclo.abierto_key)
    assert.equal(ciclo.cerrado_motivo, 'DATEADO')
    assert.lengthOf(await Database.from('comisiones').where('captacion_dateo_id', dateo.id), 0)
    const turnoBd = await Database.from('turnos_rtms').where('id', t.id).firstOrFail()
    assert.equal(turnoBd.captacion_dateo_id, dateo.id)
  }).skip(saltar, MOTIVO)

  test('convenio, descuento o avance → 400 y no se crea ticket', async ({ client, assert }) => {
    const gId = await gestion(client, 'TLK102')
    const t = await turno('TLK102')
    for (const extra of [{ convenio_id: 1 }, { descuento_id: 1 }, { es_avance: true }]) {
      const r = await crearTicket(client, 'TELE_A', t.id, gId, extra)
      r.assertStatus(400)
      assert.equal(r.body().code, 'TELE_SIN_CONVENIO_DESCUENTO')
    }
    assert.isNull(await detalleDe(t.id))
  }).skip(saltar, MOTIVO)

  test('gestión ajena, de otra placa o inexistente: no se crea ticket', async ({
    client,
    assert,
  }) => {
    const gId = await gestion(client, 'TLK103')
    const t = await turno('TLK103')
    const otro = await turno('TLK104')
    const ajena = await crearTicket(client, 'TELE_B', t.id, gId)
    ajena.assertStatus(403)
    assert.equal(ajena.body().code, 'GESTION_AJENA')
    const placa = await crearTicket(client, 'TELE_A', otro.id, gId)
    placa.assertStatus(400)
    const no = await crearTicket(client, 'TELE_A', t.id, 999999999)
    no.assertStatus(404)
    assert.isNull(await detalleDe(t.id))
    assert.isNull(await detalleDe(otro.id))
  }).skip(saltar, MOTIVO)

  test('gerencia lo crea a nombre del asesor; convenio al aprobar → 400 y no cambia nada', async ({
    client,
    assert,
  }) => {
    const gId = await gestion(client, 'TLK105')
    const t = await turno('TLK105')
    const c = await crearTicket(client, 'ADMIN', t.id, gId, { comercial_id: teleA.id })
    c.assertStatus(201)
    const conv = await aprobar(client, c.body().ticket.id, { convenio_id: 1 })
    conv.assertStatus(400)
    assert.equal(conv.body().code, 'TELE_SIN_CONVENIO_DESCUENTO')
    assert.equal((await gestionBd(gId)).resultado, 'INTERESADO')
    const ok = await aprobar(client, c.body().ticket.id)
    ok.assertStatus(200)
    assert.equal((await gestionBd(gId)).resultado, 'DATEADO')

    // A nombre de otro asesor no se puede usar la gestión.
    const g2 = await gestion(client, 'TLK106')
    const t2 = await turno('TLK106')
    const ajena = await crearTicket(client, 'ADMIN', t2.id, g2, { comercial_id: teleB.id })
    ajena.assertStatus(403)
  }).skip(saltar, MOTIVO)

  test('gestión dateada entre crear y aprobar → 409 GESTION_YA_DATEADA sin dateo nuevo', async ({
    client,
    assert,
  }) => {
    const gId = await gestion(client, 'TLK107')
    const t = await turno('TLK107')
    const c = await crearTicket(client, 'TELE_A', t.id, gId)
    c.assertStatus(201)
    // Otro dateo (cualquier placa) queda vinculado a la gestión.
    const d2 = await client.post('/api/captacion-dateos').headers(bearer('ADMIN')).json({
      origen: 'UI',
      placa: 'TLK109',
      telefono: '3991330009',
      canal: 'TELE',
      agente_id: teleA.id,
      telemercadeo_origen_id: origenId,
    })
    d2.assertStatus(201)
    await Database.from('telemercadeo_gestiones')
      .where('id', gId)
      .update({ captacion_dateo_id: d2.body().id })
    const a = await aprobar(client, c.body().ticket.id)
    a.assertStatus(409)
    assert.equal(a.body().code, 'GESTION_YA_DATEADA')
    assert.lengthOf(await Database.from('captacion_dateos').where('placa', 'TLK107'), 0)
  }).skip(saltar, MOTIVO)

  test('ON DELETE SET NULL: borrar la gestión no borra ni bloquea el ticket', async ({
    client,
    assert,
  }) => {
    const gId = await gestion(client, 'TLK108')
    const t = await turno('TLK108')
    const c = await crearTicket(client, 'TELE_A', t.id, gId)
    c.assertStatus(201)
    await Database.from('telemercadeo_gestiones').where('id', gId).delete()
    const d = await detalleDe(t.id)
    assert.exists(d)
    assert.isNull(d.telemercadeo_gestion_id)
  }).skip(saltar, MOTIVO)
})
