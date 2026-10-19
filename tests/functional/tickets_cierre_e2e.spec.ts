import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'
import Comision from '#models/comision'
import FacturacionTicket from '#models/facturacion_ticket'
import Ticket from '#models/ticket'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'

/**
 * Fase 7 de Tickets — lo que faltaba cubrir end-to-end:
 *  - rechazar: motivo obligatorio, evento RECHAZADO, sin dateo ni comisión
 *  - comentarios: visibilidad por rol y evento COMENTARIO
 *  - configuración de ventana (global y por asesor) y que GET no escriba
 *  - bandeja por rol, con el número visible del turno y su filtro
 *  - doble aprobación concurrente con la decisión separada asesor/convenio
 *  - convenio corregido por gerencia: CONVENIO_CORREGIDO, convenio_id_original
 *    y el caso nuevo manda en la validación de la decisión
 */

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10, COMERCIAL: 11, CONTABILIDAD: 12 } as const
const ZONA = 'America/Bogota'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const P = {
  RECHAZO: 'TKC701',
  COMENTARIOS: 'TKC702',
  VENTANA_DENTRO: 'TKC703',
  VENTANA_FUERA: 'TKC704',
  BANDEJA_A: 'TKC705',
  BANDEJA_B: 'TKC706',
  CONCURRENTE: 'TKC707',
  CORRIGE_A_CONVENIO: 'TKC708',
  CORRIGE_MISMO: 'TKC709',
} as const

test.group('Tickets · Fase 7 cierre', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  const ids: Record<string, Usuario> = {}
  const subidas: string[] = []
  const factIds: number[] = []
  let agenteA: AgenteCaptacion
  let agenteB: AgenteCaptacion
  let agenteVentana: AgenteCaptacion
  let asesorConvenio: AgenteCaptacion
  let convenio: Convenio
  let asignacion: AsesorConvenioAsignacion
  let imagenPath: string
  let numero = 0

  const ahora = () => DateTime.now().setZone(ZONA)
  const bearer = (clave: string) => ({ Authorization: `Bearer ${tokens[clave]}` })

  async function crearUsuario(clave: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TK-CIERRE-${clave}`,
      correo: `test.tk.cierre.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    ids[clave] = u
    tokens[clave] = tokenObj.value!.release()
  }

  /** Turno de hoy fuera de ventana (entró a las 00:01). Número positivo: Facturación lo copia a una columna UNSIGNED. */
  async function turnoDirecto(placa: string) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: ids.ADMIN.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: ahora(),
      horaIngreso: '00:01',
      horaSalida: null,
      tieneFacturacion: false,
      turnoNumero: 982000 + numero,
      turnoNumeroServicio: 982000 + numero,
      turnoCodigo: `TST-TKCI-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      esSegundaVez: false,
    } as any)
  }

  async function facturacionConfirmada(turnoId: number, placa: string) {
    const f = await FacturacionTicket.create({
      hash: `TEST-HASH-TKCI-${placa}-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      total: 50000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
    } as any)
    factIds.push(f.id)
  }

  /** Espera la respuesta y verifica el status. */
  async function esperar(peticion: Promise<any>, status: number) {
    const r = await peticion
    r.assertStatus(status)
    return r
  }

  async function subir(client: any) {
    const r = await esperar(
      client.post('/api/media/upload').headers(bearer('ADMIN')).file('file', imagenPath),
      201
    )
    subidas.push(r.body().url)
    return r.body().url as string
  }

  /** Crea el ticket como `quien`; SUPER_ADMIN/GERENCIA mandan comercial_id, el COMERCIAL no. */
  async function crearTicket(
    client: any,
    turnoId: number,
    o: { quien?: string; comercialId?: number; intento?: Record<string, unknown> } = {}
  ) {
    const r = await esperar(
      client
        .post('/api/tickets-excepcion-dateo')
        .headers(bearer(o.quien ?? 'ADMIN'))
        .json({
          turno_id: turnoId,
          ...(o.comercialId ? { comercial_id: o.comercialId } : {}),
          observacion: 'Prueba Fase 7 tickets',
          evidencia_chat_url: await subir(client),
          evidencia_grupo_whatsapp_url: await subir(client),
          evidencia_bloqueo_url: await subir(client),
          ...o.intento,
        }),
      201
    )
    return r.body() as { ticket: { id: number }; detalle: { dentroVentana: unknown } }
  }

  const aprobar = (client: any, ticketId: number, body: object, quien = 'ADMIN') =>
    client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .headers(bearer(quien))
      .json(body)

  async function eventosDe(ticketId: number) {
    const filas = await Database.from('ticket_eventos').where('ticket_id', ticketId).orderBy('id')
    return filas.map((e: any) => ({
      ...e,
      datos: typeof e.datos === 'string' ? JSON.parse(e.datos) : e.datos,
    }))
  }

  async function tiposDeEventos(ticketId: number) {
    const eventos = await eventosDe(ticketId)
    return eventos.map((e: any) => e.tipo)
  }

  async function estadoDe(ticketId: number) {
    const t = await Ticket.findOrFail(ticketId)
    return t.estado
  }

  async function detalleDe(ticketId: number) {
    return TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
  }

  group.setup(async () => {
    await crearUsuario('ADMIN', ROL.SUPER_ADMIN)
    await crearUsuario('GERENCIA', ROL.GERENCIA)
    await crearUsuario('COMERCIAL_A', ROL.COMERCIAL)
    await crearUsuario('COMERCIAL_B', ROL.COMERCIAL)
    await crearUsuario('CONTABILIDAD', ROL.CONTABILIDAD)

    const sufijo = Date.now().toString(36).toUpperCase()
    agenteA = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKCI COMERCIAL A ${sufijo}`,
      usuarioId: ids.COMERCIAL_A.id,
    } as any)
    agenteB = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKCI COMERCIAL B ${sufijo}`,
      usuarioId: ids.COMERCIAL_B.id,
    } as any)
    agenteVentana = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKCI VENTANA ${sufijo}`,
    } as any)
    asesorConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKCI ASESOR CONVENIO ${sufijo}`,
    } as any)
    convenio = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKCI CONVENIO ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    asignacion = await AsesorConvenioAsignacion.create({
      asesorId: agenteA.id,
      convenioId: convenio.id,
      activo: true,
      fechaFin: null,
    } as any)

    imagenPath = app.tmpPath(`tst_tk_cierre_${Date.now()}.png`)
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
      // tickets_comentarios y ticket_eventos caen por ON DELETE CASCADE.
      if (ticketIds.length) await Database.from('tickets').whereIn('id', ticketIds).delete()
    }
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${marks}))`,
      placas
    )
    if (factIds.length) await Database.from('facturacion_tickets').whereIn('id', factIds).delete()
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    await Database.from('configuracion_ventana_ticket_asesores')
      .whereIn('asesor_id', [agenteA.id, agenteB.id, agenteVentana.id])
      .delete()
    for (const url of subidas) {
      await fs.unlink(app.makePath(url.replace(/^\/api\//, ''))).catch(() => {})
    }
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    await asignacion.delete()
    await convenio.delete()
    for (const a of [agenteA, agenteB, agenteVentana, asesorConvenio]) await a.delete()
    for (const u of usuarios) await u.delete()
  })

  // ───────────── Rechazar ─────────────
  test('rechazar: motivo obligatorio, evento RECHAZADO y sin dateo ni comisión', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.RECHAZO)
    // Con Facturación confirmada: si rechazar creara algo, aquí aparecería la comisión.
    await facturacionConfirmada(turno.id, P.RECHAZO)
    const { ticket } = await crearTicket(client, turno.id, { comercialId: agenteA.id })
    const rechazar = (body: object, quien = 'GERENCIA') =>
      client
        .patch(`/api/tickets-excepcion-dateo/${ticket.id}/rechazar`)
        .headers(bearer(quien))
        .json(body)

    for (const body of [{}, { motivo: '' }, { motivo: '   ' }]) {
      await esperar(rechazar(body), 400)
    }
    // El comercial del ticket no puede resolverlo.
    await esperar(rechazar({ motivo: 'yo mismo' }, 'COMERCIAL_A'), 403)
    assert.equal(await estadoDe(ticket.id), 'PENDIENTE')

    await esperar(rechazar({ motivo: '  evidencia insuficiente  ' }), 200)

    const t = await Ticket.findOrFail(ticket.id)
    assert.equal(t.estado, 'RECHAZADO')
    assert.isNotNull(t.resueltoAt)
    const d = await detalleDe(ticket.id)
    assert.equal(d.motivoRechazo, 'evidencia insuficiente')
    assert.equal(d.rechazadoPorId, ids.GERENCIA.id)
    assert.isNotNull(d.rechazadoAt)
    assert.isNull(d.aprobadoPorId)
    assert.isNull(d.conComisionAsesor)
    assert.isNull(d.conComision)

    const eventos = await eventosDe(ticket.id)
    assert.deepEqual(
      eventos.map((e: any) => e.tipo),
      ['CREADO', 'RECHAZADO']
    )
    assert.equal(eventos[1].usuario_id, ids.GERENCIA.id)
    assert.equal(eventos[1].datos.motivo, 'evidencia insuficiente')

    // Ni dateo, ni vínculo en el turno, ni comisión.
    assert.lengthOf(await CaptacionDateo.query().where('placa', P.RECHAZO), 0)
    const turnoDespues = await TurnoRtm.findOrFail(turno.id)
    assert.isNull(turnoDespues.captacionDateoId)
    const comisiones = await Database.from('comisiones as c')
      .join('captacion_dateos as cd', 'cd.id', 'c.captacion_dateo_id')
      .where('cd.placa', P.RECHAZO)
    assert.lengthOf(comisiones, 0)

    // Ya resuelto: ni otro rechazo ni aprobación.
    const otra = await esperar(rechazar({ motivo: 'otra vez' }), 409)
    assert.equal(otra.body().code, 'TICKET_YA_RESUELTO')
    await esperar(aprobar(client, ticket.id, { con_comision_asesor: true }), 409)
    assert.lengthOf(await eventosDe(ticket.id), 2)
  })

  // ───────────── Comentarios ─────────────
  test('comentarios: creador, comercial del ticket y gerencia comentan (con evento); el resto 403', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.COMENTARIOS)
    const { ticket } = await crearTicket(client, turno.id, { comercialId: agenteA.id })
    const comentar = (quien: string, body: object) =>
      client.post('/api/tickets/comentarios').headers(bearer(quien)).json(body)

    await esperar(comentar('ADMIN', { ticket_id: ticket.id, mensaje: '   ' }), 400)
    await esperar(comentar('ADMIN', { mensaje: 'sin ticket' }), 400)
    await esperar(comentar('ADMIN', { ticket_id: 999999999, mensaje: 'no existe' }), 404)
    await esperar(comentar('COMERCIAL_B', { ticket_id: ticket.id, mensaje: 'ajeno' }), 403)
    await esperar(comentar('CONTABILIDAD', { ticket_id: ticket.id, mensaje: 'ajeno' }), 403)

    const creados: number[] = []
    for (const quien of ['ADMIN', 'COMERCIAL_A', 'GERENCIA']) {
      const r = await esperar(
        comentar(quien, { ticket_id: ticket.id, mensaje: `hola de ${quien}` }),
        201
      )
      assert.equal(r.body().usuarioId, ids[quien].id)
      creados.push(r.body().id)
    }

    const guardados = await Database.from('tickets_comentarios').where('ticket_id', ticket.id)
    assert.lengthOf(guardados, 3, 'los rechazados no dejan comentario')

    const todos = await eventosDe(ticket.id)
    const eventos = todos.filter((e: any) => e.tipo === 'COMENTARIO')
    assert.deepEqual(
      eventos.map((e: any) => Number(e.datos.comentario_id)),
      creados
    )
    assert.deepEqual(
      eventos.map((e: any) => e.usuario_id),
      [ids.ADMIN.id, ids.COMERCIAL_A.id, ids.GERENCIA.id]
    )

    // El comercial del ticket ve los comentarios y la línea de tiempo; el otro no ve nada.
    const r = await esperar(
      client.get(`/api/tickets/${ticket.id}`).headers(bearer('COMERCIAL_A')),
      200
    )
    assert.lengthOf(r.body().comentarios, 3)
    assert.equal(r.body().eventos.filter((e: any) => e.tipo === 'COMENTARIO').length, 3)
    assert.isTrue(r.body().eventos.every((e: any) => e.sintetico === false))
    await esperar(client.get(`/api/tickets/${ticket.id}`).headers(bearer('COMERCIAL_B')), 403)
  })

  // ───────────── Configuración de ventana ─────────────
  test('ventana global: valida, solo gerencia escribe y GET no crea filas', async ({
    client,
    assert,
  }) => {
    const contar = async () => {
      const filas = await Database.from('configuracion_ventana_ticket_global').count('* as n')
      return Number(filas[0].n)
    }
    const antes = await contar()

    const g = await esperar(
      client.get('/api/tickets/config/ventana').headers(bearer('COMERCIAL_A')),
      200
    )
    const actual = g.body().minutos_ventana as number
    assert.isAbove(actual, 0)
    assert.equal(await contar(), antes, 'GET no escribe')

    const guardar = (quien: string, minutos: unknown) =>
      client
        .post('/api/tickets/config/ventana')
        .headers(bearer(quien))
        .json({ minutos_ventana: minutos })
    for (const minutos of [0, -5, 'abc', null]) await esperar(guardar('ADMIN', minutos), 400)
    for (const quien of ['COMERCIAL_A', 'CONTABILIDAD']) await esperar(guardar(quien, actual), 403)

    // BD compartida con producción local: se reescribe el mismo valor, sin cambiarlo.
    const ok = await esperar(guardar('GERENCIA', actual), 200)
    assert.equal(ok.body().minutos_ventana, actual)
    assert.isAtMost(await contar(), 1)
  })

  test('ventana por asesor: crear, actualizar, null, borrar, inexistente → 400; el override decide dentro/fuera', async ({
    client,
    assert,
  }) => {
    const url = '/api/tickets/config/ventana/asesores'
    const contar = async () => {
      const filas = await Database.from('configuracion_ventana_ticket_asesores')
        .where('asesor_id', agenteVentana.id)
        .count('* as n')
      return Number(filas[0].n)
    }
    const upsert = (body: object, quien = 'ADMIN') =>
      client.post(url).headers(bearer(quien)).json(body)

    await esperar(upsert({ asesor_id: 999999999, minutos_ventana: 30 }), 400)
    await esperar(upsert({ minutos_ventana: 30 }), 400)
    await esperar(upsert({ asesor_id: agenteVentana.id, minutos_ventana: 0 }), 400)
    await esperar(upsert({ asesor_id: agenteVentana.id, minutos_ventana: 30 }, 'COMERCIAL_A'), 403)
    assert.equal(await contar(), 0)

    // Crear (ventana enorme: cualquier turno de hoy queda dentro).
    const creado = await esperar(
      upsert({ asesor_id: agenteVentana.id, minutos_ventana: 100000 }),
      200
    )
    const configId = creado.body().id as number
    assert.equal(creado.body().minutos_ventana, 100000)

    const lista = await esperar(
      client.get(`${url}?asesorId=${agenteVentana.id}`).headers(bearer('ADMIN')),
      200
    )
    assert.deepEqual(lista.body().data, [
      {
        id: configId,
        asesor_id: agenteVentana.id,
        asesor_nombre: agenteVentana.nombre,
        minutos_ventana: 100000,
      },
    ])
    assert.equal(await contar(), 1, 'GET no escribe')

    const turnoDentro = await turnoDirecto(P.VENTANA_DENTRO)
    const dentro = await crearTicket(client, turnoDentro.id, { comercialId: agenteVentana.id })
    assert.isTrue(Boolean(dentro.detalle.dentroVentana))

    // Actualizar: misma fila. null = vuelve a usar el global, sin borrar la fila.
    const actualizado = await esperar(
      upsert({ asesor_id: agenteVentana.id, minutos_ventana: 45 }),
      200
    )
    assert.equal(actualizado.body().id, configId)
    assert.equal(actualizado.body().minutos_ventana, 45)
    const aNull = await esperar(upsert({ asesor_id: agenteVentana.id, minutos_ventana: null }), 200)
    assert.isNull(aNull.body().minutos_ventana)
    assert.equal(await contar(), 1)

    // Borrar.
    await esperar(client.delete(`${url}/${configId}`).headers(bearer('GERENCIA')), 200)
    assert.equal(await contar(), 0)
    await esperar(client.delete(`${url}/${configId}`).headers(bearer('GERENCIA')), 404)

    // Sin override manda el global (60 por defecto): el turno de las 00:01 queda fuera.
    const turnoFuera = await turnoDirecto(P.VENTANA_FUERA)
    const fuera = await crearTicket(client, turnoFuera.id, { comercialId: agenteVentana.id })
    assert.isFalse(Boolean(fuera.detalle.dentroVentana))

    // El ticket ya creado no cambia con la configuración posterior.
    const d = await detalleDe(dentro.ticket.id)
    assert.isTrue(Boolean(d.dentroVentana))
  })

  // ───────────── Bandeja por rol + turno visible ─────────────
  test('bandeja por rol y número visible del turno (resumen y filtro turno_numero)', async ({
    client,
    assert,
  }) => {
    const turnoA = await turnoDirecto(P.BANDEJA_A)
    const turnoB = await turnoDirecto(P.BANDEJA_B)
    const creadoA = await crearTicket(client, turnoA.id, { comercialId: agenteA.id })
    // Creado por el propio comercial B (sin comercial_id: se resuelve de su usuario).
    const creadoB = await crearTicket(client, turnoB.id, { quien: 'COMERCIAL_B' })
    const tA = creadoA.ticket.id
    const tB = creadoB.ticket.id

    const bandeja = async (quien: string, qs = '') => {
      const r = await esperar(
        client.get(`/api/tickets?placa=TKC70&per_page=100${qs}`).headers(bearer(quien)),
        200
      )
      return r.body() as { data: any[]; meta: { total: number } }
    }
    const idsEnBandeja = async (quien: string, qs = '') => {
      const body = await bandeja(quien, qs)
      const vistos = body.data.map((t) => t.id)
      return [tA, tB].filter((id) => vistos.includes(id))
    }

    assert.deepEqual(await idsEnBandeja('ADMIN'), [tA, tB])
    assert.deepEqual(await idsEnBandeja('GERENCIA'), [tA, tB])
    assert.deepEqual(await idsEnBandeja('COMERCIAL_A'), [tA], 'comercial del ticket')
    assert.deepEqual(await idsEnBandeja('COMERCIAL_B'), [tB], 'creador')
    const contab = await bandeja('CONTABILIDAD')
    assert.lengthOf(contab.data, 0)
    assert.equal(contab.meta.total, 0, 'el total también respeta la visibilidad')
    // Un filtro no abre lo que el rol no puede ver.
    assert.deepEqual(await idsEnBandeja('COMERCIAL_A', `&comercial_id=${agenteB.id}`), [])

    // Número visible del turno (el del día), fecha y servicio en el resumen.
    const gerencia = await bandeja('GERENCIA')
    const fila = gerencia.data.find((t) => t.id === tA)
    assert.equal(fila.resumen.turnoId, turnoA.id)
    assert.equal(fila.resumen.turnoNumero, turnoA.turnoNumero)
    assert.equal(fila.resumen.turnoFecha, ahora().toISODate())
    assert.equal(fila.resumen.servicioCodigo, 'RTM')
    assert.notProperty(fila, 'asignadoA')
    assert.notProperty(fila, 'cerradoAt')

    // Filtro por número visible (+ fecha, porque el número se repite cada día).
    const hoy = ahora().toISODate()
    assert.deepEqual(
      await idsEnBandeja(
        'GERENCIA',
        `&turno_numero=${turnoB.turnoNumero}&fecha_desde=${hoy}&fecha_hasta=${hoy}`
      ),
      [tB]
    )
    await esperar(client.get('/api/tickets?turno_numero=abc').headers(bearer('GERENCIA')), 400)

    // El detalle trae el turno con su servicio.
    const det = await esperar(client.get(`/api/tickets/${tA}`).headers(bearer('COMERCIAL_A')), 200)
    assert.equal(det.body().detalle.turno.turnoNumero, turnoA.turnoNumero)
    assert.equal(det.body().detalle.turno.servicio.codigoServicio, 'RTM')
    await esperar(client.get(`/api/tickets/${tA}`).headers(bearer('CONTABILIDAD')), 403)
  })

  // ───────────── Concurrencia con la decisión nueva ─────────────
  test('doble aprobación concurrente con decisiones distintas: gana una entera, la otra 409', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CONCURRENTE)
    await facturacionConfirmada(turno.id, P.CONCURRENTE)
    const { ticket, detalle } = await crearTicket(client, turno.id, {
      comercialId: agenteA.id,
      intento: { canal: 'ASESOR_COMERCIAL', convenio_id: convenio.id },
    })
    assert.isFalse(Boolean(detalle.dentroVentana))

    const decisionAdmin = { con_comision_asesor: false, con_comision_convenio: true }
    const decisionGerencia = { con_comision_asesor: true, con_comision_convenio: false }
    const [rAdmin, rGerencia] = await Promise.all([
      aprobar(client, ticket.id, decisionAdmin, 'ADMIN'),
      aprobar(client, ticket.id, decisionGerencia, 'GERENCIA'),
    ])
    assert.deepEqual([rAdmin.status(), rGerencia.status()].sort(), [200, 409])
    const ganador = rAdmin.status() === 200 ? rAdmin : rGerencia
    const perdedor = ganador === rAdmin ? rGerencia : rAdmin
    assert.equal(perdedor.body().code, 'TICKET_YA_RESUELTO')
    const decision = ganador === rAdmin ? decisionAdmin : decisionGerencia
    assert.equal(ganador.body().caso, 'CONVENIO_COMERCIAL')

    const dateos = await CaptacionDateo.query().where('placa', P.CONCURRENTE)
    assert.lengthOf(dateos, 1)
    const comisiones = await Comision.query()
      .where('captacion_dateo_id', dateos[0].id)
      .where('es_config', false)
    assert.lengthOf(comisiones, 1)
    assert.equal(comisiones[0].id, ganador.body().comisionId)

    // Lo guardado es la decisión del que ganó, entera (no una mezcla).
    const d = await detalleDe(ticket.id)
    assert.equal(Boolean(d.conComisionAsesor), decision.con_comision_asesor)
    assert.equal(Boolean(d.conComisionConvenio), decision.con_comision_convenio)
    assert.equal(Boolean(d.conComision), decision.con_comision_asesor)
    assert.equal(Number(comisiones[0].montoAsesor) === 0, !decision.con_comision_asesor)
    assert.equal(Number(comisiones[0].montoConvenio) === 0, !decision.con_comision_convenio)
    assert.isNotNull(d.montoAsesorCalculado, 'hubo "sin comisión": queda la foto')

    const todos = await eventosDe(ticket.id)
    const aprobados = todos.filter((e: any) => e.tipo === 'APROBADO')
    assert.lengthOf(aprobados, 1)
    assert.equal(aprobados[0].datos.con_comision_asesor, decision.con_comision_asesor)
  })

  // ───────────── Convenio corregido por gerencia ─────────────
  test('convenio corregido: sin convenio → Caso 3, exige los dos flags y deja CONVENIO_CORREGIDO', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CORRIGE_A_CONVENIO)
    await facturacionConfirmada(turno.id, P.CORRIGE_A_CONVENIO)
    const { ticket } = await crearTicket(client, turno.id, {
      comercialId: agenteA.id,
      intento: { canal: 'ASESOR_COMERCIAL' },
    })
    const verComoGerencia = () =>
      esperar(client.get(`/api/tickets/${ticket.id}`).headers(bearer('GERENCIA')), 200)
    const antes = await verComoGerencia()
    assert.equal(antes.body().caso_comision, 'SIN_CONVENIO')
    assert.isNull(antes.body().detalle.convenioIdOriginal)

    // Con el convenio corregido el caso es 3: el flag solo del asesor (Caso 1) ya no alcanza.
    const rMal = await esperar(
      aprobar(
        client,
        ticket.id,
        { convenio_id: convenio.id, con_comision_asesor: true },
        'GERENCIA'
      ),
      400
    )
    assert.equal(rMal.body().code, 'COMBINACION_COMISION_INVALIDA')
    assert.equal(rMal.body().caso, 'CONVENIO_COMERCIAL')
    // El 400 deshace todo: sigue pendiente, sin dateo y sin convenio cambiado.
    assert.equal(await estadoDe(ticket.id), 'PENDIENTE')
    assert.lengthOf(await CaptacionDateo.query().where('placa', P.CORRIGE_A_CONVENIO), 0)
    const sinCambios = await detalleDe(ticket.id)
    assert.isNull(sinCambios.convenioId)

    const r = await esperar(
      aprobar(
        client,
        ticket.id,
        { convenio_id: convenio.id, con_comision_asesor: true, con_comision_convenio: false },
        'GERENCIA'
      ),
      200
    )
    assert.equal(r.body().caso, 'CONVENIO_COMERCIAL')
    assert.isTrue(r.body().convenioCorregido)

    const d = await detalleDe(ticket.id)
    assert.equal(d.convenioId, convenio.id)
    assert.isNull(d.convenioIdOriginal, 'el original (sin convenio) queda registrado')
    assert.equal(Boolean(d.conComisionConvenio), false)
    const dateo = await CaptacionDateo.findOrFail(r.body().dateoId)
    assert.equal(dateo.convenioId, convenio.id)
    const comision = await Comision.findOrFail(r.body().comisionId)
    assert.equal(comision.convenioId, convenio.id)
    assert.equal(Number(comision.montoConvenio), 0)

    const eventos = await eventosDe(ticket.id)
    assert.deepEqual(
      eventos.map((e: any) => e.tipo),
      ['CREADO', 'CONVENIO_CORREGIDO', 'APROBADO']
    )
    assert.isNull(eventos[1].datos.convenio_anterior_id)
    assert.equal(eventos[1].datos.convenio_nuevo_id, convenio.id)
    assert.equal(eventos[1].usuario_id, ids.GERENCIA.id)
    assert.equal(eventos[2].datos.caso, 'CONVENIO_COMERCIAL')

    const despues = await verComoGerencia()
    assert.equal(despues.body().caso_comision, 'CONVENIO_COMERCIAL')
  })

  test('convenio "corregido" al mismo convenio: sin evento; el comercial no puede aprobar', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CORRIGE_MISMO)
    const { ticket } = await crearTicket(client, turno.id, {
      comercialId: agenteA.id,
      intento: { canal: 'ASESOR_COMERCIAL', convenio_id: convenio.id },
    })
    const flags = { con_comision_asesor: true, con_comision_convenio: true }

    await esperar(aprobar(client, ticket.id, { convenio_id: null, ...flags }, 'COMERCIAL_A'), 403)

    const r = await esperar(
      aprobar(client, ticket.id, { convenio_id: convenio.id, ...flags }, 'GERENCIA'),
      200
    )
    assert.isFalse(r.body().convenioCorregido)
    const d = await detalleDe(ticket.id)
    assert.equal(d.convenioId, convenio.id)
    assert.equal(d.convenioIdOriginal, convenio.id)
    assert.deepEqual(await tiposDeEventos(ticket.id), ['CREADO', 'APROBADO'])
  })
})
