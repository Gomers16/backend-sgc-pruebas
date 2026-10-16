import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'
import Ticket from '#models/ticket'

/**
 * Fase 1 de Tickets — seguridad y robustez:
 *  - visibilidad de GET /tickets, GET /tickets/:id y POST /tickets/comentarios
 *  - doble aprobación concurrente (FOR UPDATE sobre el ticket)
 *  - crear() solo con turno de hoy, activo/finalizado
 *  - validaciones: convenio, evidencias, estado, override de ventana
 */

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10, COMERCIAL: 11 } as const
const ZONA = 'America/Bogota'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const P = {
  VISIBILIDAD: 'TKSG01',
  CONCURRENTE: 'TKSG02',
  OTRO_DIA: 'TKSG03',
  CANCELADO: 'TKSG04',
  VALIDACIONES: 'TKSG05',
  CREAR_CONCURRENTE: 'TKSG06',
  RECHAZO_CONCURRENTE: 'TKSG07',
} as const

test.group('Tickets · Fase 1 seguridad y robustez', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  const ids: Record<string, Usuario> = {}
  const subidas: string[] = []
  let agenteA: AgenteCaptacion
  let agenteB: AgenteCaptacion
  let convenioInactivo: Convenio
  let imagenPath: string
  let numero = 0

  const ahora = () => DateTime.now().setZone(ZONA)
  const bearer = (clave: string) => ({ Authorization: `Bearer ${tokens[clave]}` })

  async function crearUsuario(clave: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TK-SEG-${clave}`,
      correo: `test.tk.seg.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    ids[clave] = u
    tokens[clave] = tokenObj.value!.release()
  }

  /** Turno directo en BD (números negativos: no ocupan slots reales). */
  async function turnoDirecto(placa: string, o: { fecha?: DateTime; estado?: string } = {}) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: ids.ADMIN.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: o.fecha ?? ahora(),
      horaIngreso: '06:00',
      horaSalida: null,
      tieneFacturacion: false,
      turnoNumero: -(9700 + numero),
      turnoNumeroServicio: -(9700 + numero),
      turnoCodigo: `TST-TKSEG-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: o.estado ?? 'activo',
      esSegundaVez: false,
    } as any)
  }

  async function subirEvidencia(client: any): Promise<string> {
    const res = await client.post('/api/media/upload').headers(bearer('ADMIN')).file('file', imagenPath)
    res.assertStatus(201)
    subidas.push(res.body().url)
    return res.body().url
  }

  async function evidencias(client: any) {
    return {
      evidencia_chat_url: await subirEvidencia(client),
      evidencia_grupo_whatsapp_url: await subirEvidencia(client),
      evidencia_bloqueo_url: await subirEvidencia(client),
    }
  }

  async function crearTicket(client: any, turnoId: number, comercialId: number, extra = {}) {
    return client
      .post('/api/tickets-excepcion-dateo')
      .headers(bearer('ADMIN'))
      .json({
        turno_id: turnoId,
        comercial_id: comercialId,
        observacion: 'Prueba Fase 1 tickets',
        ...(await evidencias(client)),
        ...extra,
      })
  }

  group.setup(async () => {
    await crearUsuario('ADMIN', ROL.SUPER_ADMIN)
    await crearUsuario('GERENCIA', ROL.GERENCIA)
    await crearUsuario('COMERCIAL_A', ROL.COMERCIAL)
    await crearUsuario('COMERCIAL_B', ROL.COMERCIAL)

    agenteA = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: 'TEST TK SEG COMERCIAL A',
      usuarioId: ids.COMERCIAL_A.id,
    } as any)
    agenteB = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: 'TEST TK SEG COMERCIAL B',
      usuarioId: ids.COMERCIAL_B.id,
    } as any)
    convenioInactivo = await Convenio.create({
      tipo: 'PERSONA',
      nombre: 'TEST TK SEG CONVENIO INACTIVO',
      activo: false,
    } as any)

    imagenPath = app.tmpPath(`tst_tk_seg_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const marks = placas.map(() => '?').join(',')
    const filas = await Database.from('turnos_rtms').whereIn('placa', placas).select('id')
    const turnoIds = filas.map((r: any) => r.id)
    if (turnoIds.length) {
      const detalles = await Database.from('tickets_detalle_excepcion_dateo')
        .whereIn('turno_id', turnoIds)
        .select('ticket_id')
      const ticketIds = detalles.map((d: any) => d.ticket_id)
      await Database.from('tickets_detalle_excepcion_dateo').whereIn('turno_id', turnoIds).delete()
      if (ticketIds.length) {
        await Database.from('tickets_comentarios').whereIn('ticket_id', ticketIds).delete()
        await Database.from('tickets').whereIn('id', ticketIds).delete()
      }
    }
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${marks}))`,
      placas
    )
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    await Database.from('configuracion_ventana_ticket_asesores')
      .whereIn('asesor_id', [agenteA.id, agenteB.id])
      .delete()
    for (const url of subidas) {
      await fs.unlink(app.makePath(url.replace(/^\/api\//, ''))).catch(() => {})
    }
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    await agenteA.delete()
    await agenteB.delete()
    await convenioInactivo.delete()
    for (const u of usuarios) await u.delete()
  })

  test('visibilidad: creador, comercial del ticket y gerencia ven; otro comercial recibe 403', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.VISIBILIDAD)
    // Creado por SUPER_ADMIN a nombre del comercial A.
    const res = await crearTicket(client, turno.id, agenteA.id)
    res.assertStatus(201)
    const ticketId = res.body().ticket.id as number

    for (const clave of ['ADMIN', 'GERENCIA', 'COMERCIAL_A']) {
      const r = await client.get(`/api/tickets/${ticketId}`).headers(bearer(clave))
      r.assertStatus(200)
    }
    const otro = await client.get(`/api/tickets/${ticketId}`).headers(bearer('COMERCIAL_B'))
    otro.assertStatus(403)

    // Bandeja: el comercial A lo ve aunque no lo creó; el B no.
    const bandejaA = await client.get('/api/tickets').headers(bearer('COMERCIAL_A'))
    bandejaA.assertStatus(200)
    assert.isTrue(bandejaA.body().data.some((t: any) => t.id === ticketId))
    const bandejaB = await client.get('/api/tickets').headers(bearer('COMERCIAL_B'))
    bandejaB.assertStatus(200)
    assert.isFalse(bandejaB.body().data.some((t: any) => t.id === ticketId))

    // Comentarios: mismo acceso.
    const comB = await client
      .post('/api/tickets/comentarios')
      .headers(bearer('COMERCIAL_B'))
      .json({ ticket_id: ticketId, mensaje: 'no debería poder' })
    comB.assertStatus(403)
    const comA = await client
      .post('/api/tickets/comentarios')
      .headers(bearer('COMERCIAL_A'))
      .json({ ticket_id: ticketId, mensaje: 'comentario del comercial' })
    comA.assertStatus(201)
  })

  test('doble aprobación concurrente: una 200, la otra 409 TICKET_YA_RESUELTO, un solo dateo', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CONCURRENTE)
    const res = await crearTicket(client, turno.id, agenteA.id)
    res.assertStatus(201)
    const ticketId = res.body().ticket.id as number
    const body = res.body().detalle.dentroVentana ? {} : { con_comision: true }

    const [r1, r2] = await Promise.all([
      client.patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`).headers(bearer('ADMIN')).json(body),
      client.patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`).headers(bearer('GERENCIA')).json(body),
    ])
    const estados = [r1.status(), r2.status()].sort()
    assert.deepEqual(estados, [200, 409])
    const conflicto = r1.status() === 409 ? r1 : r2
    assert.equal(conflicto.body().code, 'TICKET_YA_RESUELTO')

    const dateos = await CaptacionDateo.query().where('placa', P.CONCURRENTE)
    assert.lengthOf(dateos, 1)
  })

  test('aprobar y rechazar a la vez: solo uno resuelve el ticket', async ({ client, assert }) => {
    const turno = await turnoDirecto(P.RECHAZO_CONCURRENTE)
    const res = await crearTicket(client, turno.id, agenteA.id)
    res.assertStatus(201)
    const ticketId = res.body().ticket.id as number
    const body = res.body().detalle.dentroVentana ? {} : { con_comision: true }

    const [ra, rr] = await Promise.all([
      client.patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`).headers(bearer('ADMIN')).json(body),
      client
        .patch(`/api/tickets-excepcion-dateo/${ticketId}/rechazar`)
        .headers(bearer('GERENCIA'))
        .json({ motivo: 'rechazo concurrente' }),
    ])
    assert.deepEqual([ra.status(), rr.status()].sort(), [200, 409])

    const ticket = await Ticket.findOrFail(ticketId)
    const dateos = await CaptacionDateo.query().where('placa', P.RECHAZO_CONCURRENTE)
    if (ra.status() === 200) {
      assert.equal(ticket.estado, 'APROBADO')
      assert.lengthOf(dateos, 1)
    } else {
      assert.equal(ticket.estado, 'RECHAZADO')
      assert.lengthOf(dateos, 0)
    }
  })

  test('crear() concurrente sobre el mismo turno: un 201 y un 409 TICKET_PENDIENTE_EXISTENTE', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CREAR_CONCURRENTE)
    const ev1 = await evidencias(client)
    const ev2 = await evidencias(client)
    const payload = (ev: Record<string, string>) => ({
      turno_id: turno.id,
      comercial_id: agenteA.id,
      observacion: 'crear concurrente',
      ...ev,
    })
    const [r1, r2] = await Promise.all([
      client.post('/api/tickets-excepcion-dateo').headers(bearer('ADMIN')).json(payload(ev1)),
      client.post('/api/tickets-excepcion-dateo').headers(bearer('GERENCIA')).json(payload(ev2)),
    ])
    assert.deepEqual([r1.status(), r2.status()].sort(), [201, 409])
    const conflicto = r1.status() === 409 ? r1 : r2
    assert.equal(conflicto.body().code, 'TICKET_PENDIENTE_EXISTENTE')
  })

  test('turno de otro día → 409 TICKET_TURNO_OTRO_DIA; turno cancelado → 409 TICKET_TURNO_ESTADO_INVALIDO', async ({
    client,
    assert,
  }) => {
    const ayer = await turnoDirecto(P.OTRO_DIA, { fecha: ahora().minus({ days: 1 }) })
    const r1 = await crearTicket(client, ayer.id, agenteA.id)
    r1.assertStatus(409)
    assert.equal(r1.body().code, 'TICKET_TURNO_OTRO_DIA')

    const cancelado = await turnoDirecto(P.CANCELADO, { estado: 'cancelado' })
    const r2 = await crearTicket(client, cancelado.id, agenteA.id)
    r2.assertStatus(409)
    assert.equal(r2.body().code, 'TICKET_TURNO_ESTADO_INVALIDO')

    // finalizado sí se acepta
    cancelado.estado = 'finalizado'
    await cancelado.save()
    const r3 = await crearTicket(client, cancelado.id, agenteA.id)
    r3.assertStatus(201)
  })

  test('validaciones: convenio, evidencias, estado de la bandeja y override de ventana', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.VALIDACIONES)

    const sinConvenio = await crearTicket(client, turno.id, agenteA.id, { convenio_id: 999999999 })
    sinConvenio.assertStatus(400)
    const inactivo = await crearTicket(client, turno.id, agenteA.id, { convenio_id: convenioInactivo.id })
    inactivo.assertStatus(400)

    const urlInventada = await crearTicket(client, turno.id, agenteA.id, {
      evidencia_bloqueo_url: 'https://evil.example.com/x.png',
    })
    urlInventada.assertStatus(400)
    assert.equal(urlInventada.body().code, 'EVIDENCIA_INVALIDA')
    const noExiste = await crearTicket(client, turno.id, agenteA.id, {
      evidencia_chat_url: '/api/uploads/dateos/2026/10/noexisteestearchivo.png',
    })
    noExiste.assertStatus(400)
    assert.equal(noExiste.body().code, 'EVIDENCIA_INVALIDA')
    const calamidadMala = await crearTicket(client, turno.id, agenteA.id, {
      evidencia_calamidad_url: '../../etc/passwd',
    })
    calamidadMala.assertStatus(400)

    const estadoMalo = await client.get('/api/tickets?estado=CUALQUIERA').headers(bearer('ADMIN'))
    estadoMalo.assertStatus(400)
    const estadoBueno = await client.get('/api/tickets?estado=pendiente').headers(bearer('ADMIN'))
    estadoBueno.assertStatus(200)

    const overrideMalo = await client
      .post('/api/tickets/config/ventana/asesores')
      .headers(bearer('ADMIN'))
      .json({ asesor_id: 999999999, minutos_ventana: 30 })
    overrideMalo.assertStatus(400)
    const overrideBueno = await client
      .post('/api/tickets/config/ventana/asesores')
      .headers(bearer('ADMIN'))
      .json({ asesor_id: agenteB.id, minutos_ventana: 30 })
    overrideBueno.assertStatus(200)

    // GET de la ventana global es solo lectura.
    const antes = await Database.from('configuracion_ventana_ticket_global').count('* as n')
    const ventana = await client.get('/api/tickets/config/ventana').headers(bearer('ADMIN'))
    ventana.assertStatus(200)
    assert.isNumber(ventana.body().minutos_ventana)
    const despues = await Database.from('configuracion_ventana_ticket_global').count('* as n')
    assert.equal(Number(despues[0].n), Number(antes[0].n))

    // Con todo válido sí crea.
    const ok = await crearTicket(client, turno.id, agenteA.id)
    ok.assertStatus(201)
  })
})
