// app/controllers/tickets_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Ticket from '#models/ticket'
import TipoTicket from '#models/tipo_ticket'
import TicketComentario from '#models/ticket_comentario'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'
import Database from '@adonisjs/lucid/services/db'
import { puedeVerTicket, ROLES_RESOLUTORES_TICKET } from '#services/ticket_acceso_service'
import ExcelJS from 'exceljs'
import {
  aplicarFiltrosTickets,
  parseFiltrosTickets,
  sqlDecisionComision,
} from '#services/tickets_consulta_service'
import { estadisticasTickets } from '#services/tickets_estadisticas_service'

/** Tope de filas del Excel de tickets. */
const EXPORTAR_MAX_FILAS = 10000

const ETIQUETA_DECISION: Record<string, string> = {
  con: 'Con comisión',
  sin_asesor: 'Sin comisión asesor',
  sin_convenio: 'Sin comisión convenio',
  sin_ninguno: 'Sin comisión (ninguno)',
  regimen_anterior: 'Aprobado (régimen anterior)',
}
import { lineaDeTiempoTicket, registrarEventoTicket } from '#services/ticket_eventos_service'

const PER_PAGE_DEFAULT = 50
const PER_PAGE_MAX = 100

function readOptionalNumber(input: unknown): number | null {
  if (input === undefined || input === null) return null
  const s = String(input).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export default class TicketsController {
  /**
   * GET /tipos-ticket
   * Catálogo de tipos de ticket que el usuario autenticado puede CREAR —
   * filtrado server-side por roles_creador (mismo criterio de "el usuario
   * ve solo lo que puede hacer" que otros catálogos de este backend, ej.
   * roles_controller.ts). Sin checkRole en la ruta: el filtrado es interno,
   * según el rol de quien pregunta, no por rol fijo de la ruta.
   */
  public async tiposIndex({ response, auth }: HttpContext) {
    await auth.user!.load('rol')
    const rolNombre = auth.user!.rol?.nombre ?? ''

    const tipos = await TipoTicket.query()
      .whereRaw('JSON_CONTAINS(roles_creador, ?)', [JSON.stringify(rolNombre)])
      .orderBy('nombre', 'asc')

    return response.ok({
      data: tipos.map((t) => ({
        id: t.id,
        codigo: t.codigo,
        nombre: t.nombre,
        rolesCreador: t.rolesCreador,
      })),
    })
  }

  /**
   * GET /tickets
   * Filtros (tickets_consulta_service.ts::parseFiltrosTickets): fecha_desde,
   * fecha_hasta (YYYY-MM-DD, Bogotá), comercial_id, convenio_id, estado,
   * ventana (dentro|fuera), placa, turno_id, decision (con | sin_asesor |
   * sin_convenio | sin_ninguno | regimen_anterior), tipo_ticket_id,
   * creado_por_id. Paginación: page, per_page (máx. PER_PAGE_MAX).
   * Respuesta: { data, meta: { total, current_page, per_page, last_page } };
   * cada fila trae `resumen` (placa, turno, comercial, convenio, ventana,
   * decisión de comisión) para la bandeja.
   *
   * Visibilidad: si el rol del usuario NO está en tipo_ticket.roles_resuelve
   * (ni es SUPER_ADMIN/GERENCIA), solo ve los tickets que creó o donde es el
   * comercial del ticket — mismo criterio que puedeVerTicket() en show().
   */
  public async index({ request, response, auth }: HttpContext) {
    const parsed = parseFiltrosTickets(request.qs())
    if (!parsed.ok) return response.badRequest({ message: parsed.message })
    const page = Math.max(1, Math.trunc(Number(request.input('page', 1))) || 1)
    const perPage = Math.min(
      PER_PAGE_MAX,
      Math.max(
        1,
        Math.trunc(Number(request.input('per_page', PER_PAGE_DEFAULT))) || PER_PAGE_DEFAULT
      )
    )

    await auth.user!.load('rol')
    const rolNombre = auth.user!.rol?.nombre ?? ''
    const usuarioId = auth.user!.id
    const esResolutor = (ROLES_RESOLUTORES_TICKET as readonly string[]).includes(
      rolNombre.toUpperCase()
    )

    const query = Ticket.query()
      .join('tipos_ticket', 'tipos_ticket.id', 'tickets.tipo_ticket_id')
      .leftJoin('tickets_detalle_excepcion_dateo as d', 'd.ticket_id', 'tickets.id')
      .leftJoin('agentes_captacions as ac', 'ac.id', 'd.comercial_id')
      .leftJoin('convenios as cv', 'cv.id', 'd.convenio_id')
      .select(
        'tickets.*',
        'd.placa as r_placa',
        'd.turno_id as r_turno_id',
        'd.comercial_id as r_comercial_id',
        'ac.nombre as r_comercial_nombre',
        'd.convenio_id as r_convenio_id',
        'cv.nombre as r_convenio_nombre',
        'cv.establecimiento as r_convenio_establecimiento',
        'd.dentro_ventana as r_dentro_ventana',
        'd.minutos_exceso as r_minutos_exceso'
      )
      .select(Database.raw(`${sqlDecisionComision('tickets', 'd')} as r_decision_comision`))
      .preload('tipoTicket')
      .preload('creadoPor')
      .preload('asignadoA')
      .orderBy('tickets.created_at', 'desc')
      .orderBy('tickets.id', 'desc')

    if (!esResolutor) {
      query.where((qb) => {
        qb.where('tickets.creado_por_id', usuarioId)
          .orWhereRaw('JSON_CONTAINS(tipos_ticket.roles_resuelve, ?)', [JSON.stringify(rolNombre)])
          .orWhere('ac.usuario_id', usuarioId)
      })
    }
    aplicarFiltrosTickets(query, parsed.filtros, 'tickets', 'd')

    const pagina = await query.paginate(page, perPage)
    return response.ok({
      data: pagina.all().map((t) => ({
        ...t.serialize(),
        resumen: {
          placa: t.$extras.r_placa ?? null,
          turnoId: t.$extras.r_turno_id ?? null,
          comercialId: t.$extras.r_comercial_id ?? null,
          comercialNombre: t.$extras.r_comercial_nombre ?? null,
          convenioId: t.$extras.r_convenio_id ?? null,
          convenioNombre: t.$extras.r_convenio_nombre ?? null,
          convenioEstablecimiento: t.$extras.r_convenio_establecimiento ?? null,
          dentroVentana:
            t.$extras.r_dentro_ventana === null || t.$extras.r_dentro_ventana === undefined
              ? null
              : Boolean(t.$extras.r_dentro_ventana),
          minutosExceso: t.$extras.r_minutos_exceso ?? null,
          decisionComision: t.$extras.r_decision_comision ?? null,
        },
      })),
      meta: {
        total: pagina.total,
        current_page: pagina.currentPage,
        per_page: pagina.perPage,
        last_page: pagina.lastPage,
      },
    })
  }

  /**
   * GET /tickets/:id
   * Detalle + comentarios + detalle específico del tipo (join dinámico —
   * hoy solo EXCEPCION_DATEO, se extiende con más `if` por tipoTicket.codigo
   * cuando existan más tipos).
   * Solo creador, comercial del ticket y roles resolutores (puedeVerTicket);
   * los demás reciben 403.
   */
  public async show({ params, response, auth }: HttpContext) {
    const ticket = await Ticket.query()
      .where('id', params.id)
      .preload('tipoTicket')
      .preload('creadoPor')
      .preload('asignadoA')
      .preload('comentarios', (q) => {
        q.preload('usuario').orderBy('created_at', 'asc')
      })
      .first()

    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })
    if (!(await puedeVerTicket(ticket, auth.user!))) {
      return response.forbidden({ message: 'No tienes acceso a este ticket' })
    }

    const out = ticket.serialize() as Record<string, unknown>

    if (ticket.tipoTicket?.codigo === 'EXCEPCION_DATEO') {
      const detalle = await TicketDetalleExcepcionDateo.query()
        .where('ticket_id', ticket.id)
        .preload('turno')
        .preload('comercial')
        .preload('convenio')
        .preload('aprobadoPor')
        .preload('rechazadoPor')
        .first()
      out.detalle = detalle ? detalle.serialize() : null
    }

    // Línea de tiempo (ticket_eventos + lo que falte, armado desde el ticket).
    out.eventos = await lineaDeTiempoTicket(ticket.id)

    return response.ok(out)
  }

  /**
   * POST /tickets/comentarios
   * Body: { ticket_id, mensaje }
   * Mismo acceso que show(): creador, comercial del ticket o rol resolutor.
   */
  public async agregarComentario({ request, response, auth }: HttpContext) {
    const ticketId = readOptionalNumber(request.input('ticket_id'))
    const mensaje = (request.input('mensaje') as string | undefined)?.trim()

    if (ticketId === null) return response.badRequest({ message: 'ticket_id es requerido' })
    if (!mensaje) return response.badRequest({ message: 'mensaje es requerido' })

    const ticket = await Ticket.find(ticketId)
    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })
    if (!(await puedeVerTicket(ticket, auth.user!))) {
      return response.forbidden({ message: 'No tienes acceso a este ticket' })
    }

    const comentario = await Database.transaction(async (trx) => {
      const c = await TicketComentario.create(
        { ticketId, usuarioId: auth.user!.id, mensaje },
        { client: trx }
      )
      await registrarEventoTicket(trx, {
        ticketId,
        tipo: 'COMENTARIO',
        usuarioId: auth.user!.id,
        datos: { comentario_id: c.id },
      })
      return c
    })
    await comentario.load('usuario')

    return response.created(comentario.serialize())
  }

  /**
   * GET /tickets/estadisticas (SUPER_ADMIN, GERENCIA) — mismos filtros que
   * GET /tickets. Totales y desglose por asesor del ticket; definición del
   * dinero en tickets_estadisticas_service.ts.
   */
  public async estadisticas({ request, response }: HttpContext) {
    const parsed = parseFiltrosTickets(request.qs())
    if (!parsed.ok) return response.badRequest({ message: parsed.message })
    return response.ok(await estadisticasTickets(parsed.filtros))
  }

  /**
   * GET /tickets/exportar (SUPER_ADMIN, GERENCIA) — Excel con los mismos
   * filtros: hoja "Tickets" (una fila por ticket, con la comisión real si
   * existe) y hoja "Resumen por asesor" (GET /tickets/estadisticas).
   */
  public async exportar({ request, response }: HttpContext) {
    const parsed = parseFiltrosTickets(request.qs())
    if (!parsed.ok) return response.badRequest({ message: parsed.message })
    const f = parsed.filtros

    const q = Database.from('tickets as t')
      .join('tipos_ticket as tt', 'tt.id', 't.tipo_ticket_id')
      .join('tickets_detalle_excepcion_dateo as d', 'd.ticket_id', 't.id')
      .leftJoin('agentes_captacions as ac', 'ac.id', 'd.comercial_id')
      .leftJoin('convenios as cv', 'cv.id', 'd.convenio_id')
      .leftJoin('usuarios as uc', 'uc.id', 't.creado_por_id')
      .leftJoin('usuarios as ua', 'ua.id', 'd.aprobado_por_id')
      .leftJoin('usuarios as ur', 'ur.id', 'd.rechazado_por_id')
      .leftJoin('turnos_rtms as tr', 'tr.id', 'd.turno_id')
      .joinRaw(
        'LEFT JOIN comisiones c ON c.id = (SELECT MAX(c2.id) FROM comisiones c2 WHERE c2.captacion_dateo_id = tr.captacion_dateo_id AND c2.es_config = 0)'
      )
      .where('tt.codigo', 'EXCEPCION_DATEO')
    aplicarFiltrosTickets(q, f, 't', 'd')
    const filas = (await q
      .select(
        't.id',
        't.created_at',
        't.estado',
        't.resuelto_at',
        'd.placa',
        'd.turno_id',
        'tr.turno_numero',
        'ac.nombre as comercial',
        'cv.nombre as convenio',
        'cv.establecimiento as convenio_establecimiento',
        'd.dentro_ventana',
        'd.minutos_totales',
        'd.minutos_exceso',
        'd.motivo_rechazo',
        'uc.nombres as c_nombres',
        'uc.apellidos as c_apellidos',
        'ua.nombres as a_nombres',
        'ua.apellidos as a_apellidos',
        'ur.nombres as r_nombres',
        'ur.apellidos as r_apellidos',
        'c.id as comision_id',
        'c.estado as comision_estado',
        'c.monto_asesor',
        'c.monto_convenio'
      )
      .select(Database.raw(`${sqlDecisionComision('t', 'd')} as decision`))
      .orderBy('t.created_at', 'desc')
      .limit(EXPORTAR_MAX_FILAS)) as any[]

    const nombre = (a?: string | null, b?: string | null) => (a ? `${a} ${b ?? ''}`.trim() : '')
    const workbook = new ExcelJS.Workbook()
    const ws = workbook.addWorksheet('Tickets')
    ws.columns = [
      { header: 'Ticket', key: 'id', width: 9 },
      { header: 'Creado', key: 'creado', width: 19 },
      { header: 'Estado', key: 'estado', width: 12 },
      { header: 'Placa', key: 'placa', width: 10 },
      { header: 'Turno', key: 'turno', width: 9 },
      { header: 'Asesor', key: 'comercial', width: 28 },
      { header: 'Convenio', key: 'convenio', width: 32 },
      { header: 'Ventana', key: 'ventana', width: 10 },
      { header: 'Min. transcurridos', key: 'minutos', width: 10 },
      { header: 'Min. de exceso', key: 'exceso', width: 10 },
      { header: 'Decisión de comisión', key: 'decision', width: 26 },
      { header: 'Creado por', key: 'creado_por', width: 24 },
      { header: 'Resuelto por', key: 'resuelto_por', width: 24 },
      { header: 'Resuelto', key: 'resuelto', width: 19 },
      { header: 'Motivo rechazo', key: 'motivo', width: 30 },
      { header: 'Estado comisión', key: 'comision_estado', width: 14 },
      { header: 'Comisión asesor', key: 'monto_asesor', width: 14 },
      { header: 'Comisión convenio', key: 'monto_convenio', width: 14 },
    ]
    ws.getRow(1).font = { bold: true }
    for (const r of filas) {
      let resueltoPor = ''
      if (r.estado === 'APROBADO') resueltoPor = nombre(r.a_nombres, r.a_apellidos)
      if (r.estado === 'RECHAZADO') resueltoPor = nombre(r.r_nombres, r.r_apellidos)
      let estadoComision = ''
      if (r.comision_id) estadoComision = r.comision_estado
      else if (r.estado === 'APROBADO') estadoComision = 'En proceso'
      ws.addRow({
        id: r.id,
        creado: r.created_at,
        estado: r.estado,
        placa: r.placa,
        turno: r.turno_numero ?? r.turno_id,
        comercial: r.comercial ?? '',
        convenio: r.convenio
          ? [r.convenio, r.convenio_establecimiento].filter(Boolean).join(' · ')
          : 'Sin convenio',
        ventana: r.dentro_ventana ? 'Dentro' : 'Fuera',
        minutos: r.minutos_totales,
        exceso: r.minutos_exceso,
        decision: r.decision ? ETIQUETA_DECISION[r.decision] : '',
        creado_por: nombre(r.c_nombres, r.c_apellidos),
        resuelto_por: resueltoPor,
        resuelto: r.resuelto_at,
        motivo: r.motivo_rechazo ?? '',
        comision_estado: estadoComision,
        monto_asesor: r.comision_id ? Number(r.monto_asesor) : null,
        monto_convenio: r.comision_id ? Number(r.monto_convenio) : null,
      })
    }

    const est = await estadisticasTickets(f)
    const wr = workbook.addWorksheet('Resumen por asesor')
    wr.columns = [
      { header: 'Asesor', key: 'asesor', width: 28 },
      { header: 'Creados', key: 'creados', width: 9 },
      { header: 'Dentro ventana', key: 'dentro', width: 9 },
      { header: 'Fuera ventana', key: 'fuera', width: 9 },
      { header: 'Aprobados', key: 'aprobados', width: 10 },
      { header: 'Con comisión', key: 'con', width: 10 },
      { header: 'Sin comisión asesor', key: 'sin_asesor', width: 10 },
      { header: 'Sin comisión convenio', key: 'sin_convenio', width: 10 },
      { header: 'Sin ninguna', key: 'sin_ninguno', width: 10 },
      { header: 'Régimen anterior', key: 'regimen', width: 10 },
      { header: 'Rechazados', key: 'rechazados', width: 10 },
      { header: 'Pendientes', key: 'pendientes', width: 10 },
      { header: 'Tasa aprobación', key: 'tasa', width: 10 },
      { header: 'Resolución prom. (min)', key: 'resolucion', width: 12 },
      { header: 'Comisión real asesor', key: 'real_asesor', width: 14 },
      { header: 'Comisión real convenio', key: 'real_convenio', width: 14 },
      { header: 'En proceso asesor', key: 'ep_asesor', width: 14 },
      { header: 'En proceso convenio', key: 'ep_convenio', width: 14 },
      { header: 'Dejado de pagar asesor', key: 'dj_asesor', width: 14 },
      { header: 'Dejado de pagar convenio (est.)', key: 'dj_convenio', width: 16 },
    ]
    wr.getRow(1).font = { bold: true }
    const fila = (nombreAsesor: string, b: (typeof est)['totales']) => ({
      asesor: nombreAsesor,
      creados: b.creados,
      dentro: b.dentro_ventana,
      fuera: b.fuera_ventana,
      aprobados: b.aprobados.total,
      con: b.aprobados.con,
      sin_asesor: b.aprobados.sin_asesor,
      sin_convenio: b.aprobados.sin_convenio,
      sin_ninguno: b.aprobados.sin_ninguno,
      regimen: b.aprobados.regimen_anterior,
      rechazados: b.rechazados,
      pendientes: b.pendientes,
      tasa: b.tasa_aprobacion,
      resolucion: b.tiempo_promedio_resolucion_min,
      real_asesor: b.dinero.comision_real.asesor,
      real_convenio: b.dinero.comision_real.convenio,
      ep_asesor: b.dinero.en_proceso.asesor,
      ep_convenio: b.dinero.en_proceso.convenio,
      dj_asesor: b.dinero.dejado_de_pagar.asesor,
      dj_convenio: b.dinero.dejado_de_pagar.convenio,
    })
    for (const a of est.por_asesor) wr.addRow(fila(a.comercial_nombre ?? `#${a.comercial_id}`, a))
    wr.addRow(fila('TOTAL', est.totales)).font = { bold: true }

    const buffer = await workbook.xlsx.writeBuffer()
    const sufijo = [f.desde, f.hasta].filter(Boolean).join('_') || 'todos'
    response.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    response.header('Content-Disposition', `attachment; filename="Tickets_${sufijo}.xlsx"`)
    return response.send(buffer)
  }

  /**
   * GET /tickets/pendientes/contador (SUPER_ADMIN, GERENCIA) — liviano, para
   * el badge de la bandeja: { pendientes, por_tipo: { CODIGO: n } }.
   */
  public async contadorPendientes({ response }: HttpContext) {
    const filas = (await Database.from('tickets as t')
      .join('tipos_ticket as tt', 'tt.id', 't.tipo_ticket_id')
      .where('t.estado', 'PENDIENTE')
      .groupBy('tt.codigo')
      .select('tt.codigo')
      .count('* as n')) as any[]
    const porTipo = Object.fromEntries(filas.map((r) => [r.codigo, Number(r.n)]))
    const pendientes = filas.reduce((acc, r) => acc + Number(r.n), 0)
    return response.ok({ pendientes, por_tipo: porTipo })
  }
}
