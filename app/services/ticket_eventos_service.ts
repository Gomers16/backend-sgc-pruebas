// app/services/ticket_eventos_service.ts
//
// Escritura y lectura de la línea de tiempo de un ticket (ticket_eventos).
// Solo historial: los números de estadísticas salen de tickets/detalle.

import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import Database from '@adonisjs/lucid/services/db'
import TicketEvento, { type TipoTicketEvento } from '#models/ticket_evento'

export async function registrarEventoTicket(
  trx: TransactionClientContract,
  e: {
    ticketId: number
    tipo: TipoTicketEvento
    usuarioId: number | null
    datos?: Record<string, unknown> | null
  }
): Promise<TicketEvento> {
  return TicketEvento.create(
    { ticketId: e.ticketId, tipo: e.tipo, usuarioId: e.usuarioId, datos: e.datos ?? null },
    { client: trx }
  )
}

export interface EventoLineaTiempo {
  id: number | null
  tipo: TipoTicketEvento
  usuarioId: number | null
  usuarioNombre: string | null
  fecha: string | null
  datos: Record<string, unknown> | null
  /** true = no estaba en ticket_eventos; se armó desde el ticket (p. ej. lo resolvió producción local). */
  sintetico: boolean
}

const parseDatos = (v: unknown): Record<string, unknown> | null =>
  v === null || v === undefined ? null : typeof v === 'string' ? JSON.parse(v) : (v as any)

const nombre = (row: any) => (row?.nombres ? `${row.nombres} ${row.apellidos ?? ''}`.trim() : null)

const fechaSql = (v: unknown) => (v instanceof Date ? v.toISOString() : v ? String(v) : null)

/**
 * Eventos guardados + los que falten, armados desde el ticket: CREADO, la
 * resolución y los comentarios sin evento (tickets que creó o resolvió
 * código que no escribe eventos, como producción local sobre la misma BD).
 */
export async function lineaDeTiempoTicket(ticketId: number): Promise<EventoLineaTiempo[]> {
  const guardados = await Database.from('ticket_eventos as e')
    .leftJoin('usuarios as u', 'u.id', 'e.usuario_id')
    .where('e.ticket_id', ticketId)
    .select('e.id', 'e.tipo', 'e.usuario_id', 'e.created_at', 'e.datos', 'u.nombres', 'u.apellidos')

  const eventos: EventoLineaTiempo[] = guardados.map((r: any) => ({
    id: r.id,
    tipo: r.tipo,
    usuarioId: r.usuario_id,
    usuarioNombre: nombre(r),
    fecha: fechaSql(r.created_at),
    datos: parseDatos(r.datos),
    sintetico: false,
  }))
  const tiene = (tipo: TipoTicketEvento) => eventos.some((e) => e.tipo === tipo)

  const t = await Database.from('tickets as t')
    .leftJoin('tickets_detalle_excepcion_dateo as d', 'd.ticket_id', 't.id')
    .leftJoin('usuarios as uc', 'uc.id', 't.creado_por_id')
    .leftJoin('usuarios as ua', 'ua.id', 'd.aprobado_por_id')
    .leftJoin('usuarios as ur', 'ur.id', 'd.rechazado_por_id')
    .where('t.id', ticketId)
    .select(
      't.estado',
      't.creado_por_id',
      't.created_at',
      't.resuelto_at',
      'd.aprobado_por_id',
      'd.aprobado_at',
      'd.rechazado_por_id',
      'd.rechazado_at',
      'd.motivo_rechazo',
      'd.con_comision',
      'd.con_comision_asesor',
      'd.con_comision_convenio',
      'd.dentro_ventana',
      'uc.nombres as c_nombres',
      'uc.apellidos as c_apellidos',
      'ua.nombres as a_nombres',
      'ua.apellidos as a_apellidos',
      'ur.nombres as r_nombres',
      'ur.apellidos as r_apellidos'
    )
    .first()
  if (!t) return eventos

  const sint = (
    tipo: TipoTicketEvento,
    usuarioId: number | null,
    n: string | null,
    fecha: unknown,
    datos: any
  ) =>
    eventos.push({
      id: null,
      tipo,
      usuarioId,
      usuarioNombre: n,
      fecha: fechaSql(fecha),
      datos,
      sintetico: true,
    })

  if (!tiene('CREADO')) {
    sint(
      'CREADO',
      t.creado_por_id,
      nombre({ nombres: t.c_nombres, apellidos: t.c_apellidos }),
      t.created_at,
      null
    )
  }
  if (t.estado === 'APROBADO' && !tiene('APROBADO')) {
    sint(
      'APROBADO',
      t.aprobado_por_id,
      nombre({ nombres: t.a_nombres, apellidos: t.a_apellidos }),
      t.aprobado_at ?? t.resuelto_at,
      {
        con_comision_asesor: t.con_comision_asesor ?? t.con_comision,
        con_comision_convenio: t.con_comision_convenio,
        dentro_ventana: Boolean(t.dentro_ventana),
      }
    )
  }
  if (t.estado === 'RECHAZADO' && !tiene('RECHAZADO')) {
    sint(
      'RECHAZADO',
      t.rechazado_por_id,
      nombre({ nombres: t.r_nombres, apellidos: t.r_apellidos }),
      t.rechazado_at ?? t.resuelto_at,
      {
        motivo: t.motivo_rechazo,
      }
    )
  }

  const conEvento = new Set(
    eventos.filter((e) => e.tipo === 'COMENTARIO').map((e) => Number(e.datos?.comentario_id))
  )
  const comentarios = await Database.from('tickets_comentarios as c')
    .leftJoin('usuarios as u', 'u.id', 'c.usuario_id')
    .where('c.ticket_id', ticketId)
    .select('c.id', 'c.usuario_id', 'c.created_at', 'u.nombres', 'u.apellidos')
  for (const c of comentarios as any[]) {
    if (!conEvento.has(Number(c.id))) {
      sint('COMENTARIO', c.usuario_id, nombre(c), c.created_at, { comentario_id: c.id })
    }
  }

  // Mismo segundo (pasa en datos de prueba y en el backfill): orden lógico.
  const orden: Record<TipoTicketEvento, number> = {
    CREADO: 0,
    COMENTARIO: 1,
    CONVENIO_CORREGIDO: 2,
    APROBADO: 3,
    RECHAZADO: 3,
  }
  return eventos.sort(
    (a, b) =>
      String(a.fecha).localeCompare(String(b.fecha)) ||
      orden[a.tipo] - orden[b.tipo] ||
      (a.id ?? 0) - (b.id ?? 0)
  )
}
