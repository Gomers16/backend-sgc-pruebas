// app/controllers/tickets_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Ticket from '#models/ticket'
import TipoTicket from '#models/tipo_ticket'
import TicketComentario from '#models/ticket_comentario'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'

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
   * GET /tickets?tipo_ticket_id=&estado=&creado_por_id=
   * Bandeja general. Si el rol del usuario actual NO está en
   * tipo_ticket.roles_resuelve del tipo del ticket, solo ve los tickets que
   * él mismo creó (creado_por_id = usuario actual) — chequeo por fila via
   * JSON_CONTAINS, porque la lista puede mezclar varios tipos de ticket con
   * roles_resuelve distintos.
   */
  public async index({ request, response, auth }: HttpContext) {
    const tipoTicketId = readOptionalNumber(request.input('tipo_ticket_id'))
    const estado = (request.input('estado') as string | undefined) || undefined
    const creadoPorIdFiltro = readOptionalNumber(request.input('creado_por_id'))

    await auth.user!.load('rol')
    const rolNombre = auth.user!.rol?.nombre ?? ''
    const usuarioId = auth.user!.id

    const query = Ticket.query()
      .join('tipos_ticket', 'tipos_ticket.id', 'tickets.tipo_ticket_id')
      .where((qb) => {
        qb.where('tickets.creado_por_id', usuarioId).orWhereRaw(
          'JSON_CONTAINS(tipos_ticket.roles_resuelve, ?)',
          [JSON.stringify(rolNombre)]
        )
      })
      .select('tickets.*')
      .preload('tipoTicket')
      .preload('creadoPor')
      .preload('asignadoA')
      .orderBy('tickets.created_at', 'desc')

    if (tipoTicketId !== null) query.where('tickets.tipo_ticket_id', tipoTicketId)
    if (estado) query.where('tickets.estado', estado)
    if (creadoPorIdFiltro !== null) query.where('tickets.creado_por_id', creadoPorIdFiltro)

    const tickets = await query
    return response.ok({ data: tickets.map((t) => t.serialize()) })
  }

  /**
   * GET /tickets/:id
   * Detalle + comentarios + detalle específico del tipo (join dinámico —
   * hoy solo EXCEPCION_DATEO, se extiende con más `if` por tipoTicket.codigo
   * cuando existan más tipos).
   */
  public async show({ params, response }: HttpContext) {
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

    return response.ok(out)
  }

  /**
   * POST /tickets/comentarios
   * Body: { ticket_id, mensaje }
   */
  public async agregarComentario({ request, response, auth }: HttpContext) {
    const ticketId = readOptionalNumber(request.input('ticket_id'))
    const mensaje = (request.input('mensaje') as string | undefined)?.trim()

    if (ticketId === null) return response.badRequest({ message: 'ticket_id es requerido' })
    if (!mensaje) return response.badRequest({ message: 'mensaje es requerido' })

    const ticket = await Ticket.find(ticketId)
    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })

    const comentario = await TicketComentario.create({
      ticketId,
      usuarioId: auth.user!.id,
      mensaje,
    })
    await comentario.load('usuario')

    return response.created(comentario.serialize())
  }
}
