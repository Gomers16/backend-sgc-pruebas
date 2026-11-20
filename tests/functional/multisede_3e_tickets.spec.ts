import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Ticket from '#models/ticket'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'

// Multi-sede 3e — tickets de Excepción de Dateo aislados por sede.
// Sede A = Ibagué (1), sede B = PRUEBAS QA (3). Turnos MS3E* (fecha 2031) y
// tickets con título "MS3E"; todo se borra al final (también las evidencias
// subidas, asesores y usuarios test.ms3e.*).

const IBAGUE = 1
const QA = 3
const RTM = 1
const MARCA = 'test.ms3e.'
const TITULO = 'MS3E ticket de prueba'
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS3E ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } }
}
type Actor = Awaited<ReturnType<typeof actor>>

const subidas: string[] = []

async function limpiar() {
  const ts = await Database.from('tickets').where('titulo', TITULO).select('id')
  const tIds = ts.map((t: any) => t.id)
  if (tIds.length) {
    await Database.from('ticket_eventos').whereIn('ticket_id', tIds).delete()
    await Database.from('tickets_comentarios').whereIn('ticket_id', tIds).delete()
    await Database.from('tickets_detalle_excepcion_dateo').whereIn('ticket_id', tIds).delete()
    await Database.from('tickets').whereIn('id', tIds).delete()
  }
  await Database.from('turnos_rtms').where('placa', 'like', 'MS3E%').delete()
  await Database.from('agentes_captacions').where('nombre', 'like', 'TEST MS3E %').delete()
  for (const url of subidas.splice(0)) {
    const rel = url.replace(/^\/api\//, '')
    await fs.unlink(app.makePath(rel)).catch(() => {})
  }
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  if (ids.length) {
    await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
    await Database.from('usuario_preferencia_modulo').whereIn('usuario_id', ids).delete()
    await Database.from('usuarios').whereIn('id', ids).delete()
  }
}

let seq = 0
async function turno(sedeId: number, funcionarioId: number) {
  seq++
  return TurnoRtm.create({
    sedeId,
    funcionarioId,
    servicioId: RTM,
    fecha: DateTime.fromISO('2031-02-10'),
    horaIngreso: '08:00:00',
    placa: `MS3E${sedeId}${seq}`,
    tipoVehiculo: 'Liviano Particular',
    turnoNumero: -9300 - seq,
    turnoNumeroServicio: -9300 - seq,
    turnoCodigo: `MS3E-${sedeId}-${seq}-${Date.now()}`,
    estado: 'activo',
  } as any)
}

async function ticket(sedeId: number, turnoId: number, creadoPorId: number, comercialId: number) {
  const tt = await Database.from('tipos_ticket').where('codigo', 'EXCEPCION_DATEO').first()
  const t = await Ticket.create({
    sedeId,
    tipoTicketId: tt.id,
    titulo: TITULO,
    estado: 'PENDIENTE',
    creadoPorId,
  } as any)
  await TicketDetalleExcepcionDateo.create({
    ticketId: t.id,
    turnoId,
    comercialId,
    placa: 'MS3E',
    observacion: 'prueba',
    horaIngreso: '08:00:00',
    horaIntentoDateo: DateTime.fromISO('2031-02-10T08:00:00'),
    minutosTotales: 0,
    minutosExceso: 0,
    evidenciaChatUrl: 'x',
    evidenciaGrupoWhatsappUrl: 'x',
    evidenciaBloqueoUrl: 'x',
  } as any)
  return t
}

test.group('Multi-sede 3e · tickets de Excepción de Dateo', (group) => {
  group.each.timeout(90_000)
  let gerA: Actor
  let gerB: Actor
  let comB: Actor
  let comercialB = 0

  group.setup(async () => {
    await limpiar()
    gerA = await actor('GERENCIA', IBAGUE)
    gerB = await actor('GERENCIA', QA)
    comB = await actor('COMERCIAL', QA)
    ;[comercialB] = await Database.table('agentes_captacions').insert({
      nombre: `TEST MS3E COMERCIAL ${Date.now()}`,
      tipo: 'ASESOR_COMERCIAL',
      activo: true,
      sede_id: QA,
      usuario_id: comB.id,
    })
  })
  group.teardown(limpiar)

  test('listar, ver, comentar, aprobar y rechazar de otra sede → vacío o 404', async ({
    client,
    assert,
  }) => {
    const tA = await ticket(IBAGUE, (await turno(IBAGUE, gerA.id)).id, gerA.id, comercialB)
    const tB = await ticket(QA, (await turno(QA, gerB.id)).id, gerB.id, comercialB)

    const lista = await client.get('/api/tickets').qs({ per_page: 100 }).headers(gerB.h)
    assert.equal(lista.status(), 200)
    const ids = (lista.body().data as any[]).map((t) => t.id)
    assert.include(ids, tB.id)
    assert.notInclude(ids, tA.id)

    assert.equal((await client.get(`/api/tickets/${tA.id}`).headers(gerB.h)).status(), 404)
    assert.equal((await client.get(`/api/tickets/${tB.id}`).headers(gerA.h)).status(), 404)
    const com = await client
      .post('/api/tickets/comentarios')
      .headers(gerB.h)
      .json({ ticket_id: tA.id, mensaje: 'no' })
    assert.equal(com.status(), 404)
    const rech = await client
      .patch(`/api/tickets-excepcion-dateo/${tA.id}/rechazar`)
      .headers(gerB.h)
      .json({ motivo: 'no' })
    assert.equal(rech.status(), 404)
    const apr = await client
      .patch(`/api/tickets-excepcion-dateo/${tA.id}/aprobar`)
      .headers(gerB.h)
      .json({ con_comision: true })
    assert.equal(apr.status(), 404)
    assert.equal((await Database.from('tickets').where('id', tA.id).first()).estado, 'PENDIENTE')
    assert.lengthOf(await Database.from('tickets_comentarios').where('ticket_id', tA.id), 0)
  })

  test('exportar, estadísticas y contador de pendientes por sede', async ({ client, assert }) => {
    await ticket(IBAGUE, (await turno(IBAGUE, gerA.id)).id, gerA.id, comercialB)
    const contador = await client.get('/api/tickets/pendientes/contador').headers(gerB.h)
    assert.equal(contador.status(), 200)
    const sql = await Database.from('tickets')
      .where('sede_id', QA)
      .where('estado', 'PENDIENTE')
      .count('* as n')
      .first()
    assert.equal(contador.body().pendientes, Number(sql.n))

    const est = await client.get('/api/tickets/estadisticas').headers(gerB.h)
    assert.equal(est.status(), 200)
    const sqlCreados = await Database.from('tickets').where('sede_id', QA).count('* as n').first()
    assert.equal(est.body().totales.creados, Number(sqlCreados.n))

    const exp = await client.get('/api/tickets/exportar').headers(gerB.h)
    assert.equal(exp.status(), 200)
  })

  test('crear con turno de otra sede → 404; ticket con turno de otra sede → 409', async ({
    client,
    assert,
  }) => {
    const archivo = app.tmpPath(`ms3e_${Date.now()}.png`)
    await fs.mkdir(path.dirname(archivo), { recursive: true })
    await fs.writeFile(archivo, PNG)
    const subir = async () => {
      const r = await client.post('/api/media/upload').headers(comB.h).file('file', archivo)
      assert.equal(r.status(), 201, JSON.stringify(r.body()))
      subidas.push(r.body().url)
      return r.body().url as string
    }
    const turnoA = await turno(IBAGUE, gerA.id)
    const crear = await client
      .post('/api/tickets-excepcion-dateo')
      .headers(comB.h)
      .json({
        turno_id: turnoA.id,
        comercial_id: comercialB,
        sin_convenio: true,
        observacion: 'MS3E',
        evidencia_chat_url: await subir(),
        evidencia_grupo_whatsapp_url: await subir(),
        evidencia_bloqueo_url: await subir(),
      })
    assert.equal(crear.status(), 404, JSON.stringify(crear.body()))
    await fs.unlink(archivo).catch(() => {})

    // Dato inconsistente: ticket de QA apuntando a un turno de Ibagué.
    const malo = await ticket(QA, turnoA.id, gerB.id, comercialB)
    const apr = await client
      .patch(`/api/tickets-excepcion-dateo/${malo.id}/aprobar`)
      .headers(gerB.h)
      .json({ con_comision: true })
    assert.equal(apr.status(), 409, JSON.stringify(apr.body()))
    assert.equal(apr.body().code, 'TICKET_OTRA_SEDE')
    assert.equal((await Database.from('tickets').where('id', malo.id).first()).estado, 'PENDIENTE')
  })

  test('"todas" es solo lectura: escrituras de tickets → 400', async ({ client, assert }) => {
    const tB = await ticket(QA, (await turno(QA, gerB.id)).id, gerB.id, comercialB)
    const todas = { ...gerB.h, 'X-Sede-Id': 'todas' }
    assert.equal((await client.get('/api/tickets').headers(todas)).status(), 200)
    const escrituras = [
      client
        .post('/api/tickets/comentarios')
        .headers(todas)
        .json({ ticket_id: tB.id, mensaje: 'x' }),
      client
        .patch(`/api/tickets-excepcion-dateo/${tB.id}/rechazar`)
        .headers(todas)
        .json({ motivo: 'x' }),
      client
        .patch(`/api/tickets-excepcion-dateo/${tB.id}/aprobar`)
        .headers(todas)
        .json({ con_comision: true }),
      client.patch(`/api/tickets-excepcion-dateo/${tB.id}/convenio`).headers(todas).json({
        convenio_id: null,
        motivo: 'x',
      }),
      client.post('/api/tickets-excepcion-dateo').headers(todas).json({ turno_id: 1 }),
    ]
    for (const req of escrituras) {
      const r = await req
      assert.equal(r.status(), 400, JSON.stringify(r.body()))
    }
    assert.equal((await Database.from('tickets').where('id', tB.id).first()).estado, 'PENDIENTE')
  })
})
