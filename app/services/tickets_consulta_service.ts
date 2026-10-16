// app/services/tickets_consulta_service.ts
//
// Filtros de tickets compartidos por la bandeja (GET /tickets), las
// estadísticas y la exportación. Todo sale de tickets +
// tickets_detalle_excepcion_dateo (nunca de ticket_eventos), y la decisión de
// comisión se lee con la misma regla de debeRespetarSinComision(): producción
// local (misma BD) solo escribe con_comision, así que el flag del asesor es
// COALESCE(con_comision_asesor, con_comision) y, si las columnas nuevas están
// en NULL, el convenio cobra (salvo que el ticket no tenga convenio).

import { DateTime } from 'luxon'

export const ESTADOS_TICKET = ['PENDIENTE', 'APROBADO', 'RECHAZADO', 'RESUELTO', 'CERRADO'] as const
export const DECISIONES_COMISION = [
  'con',
  'sin_asesor',
  'sin_convenio',
  'sin_ninguno',
  'regimen_anterior',
] as const
export type DecisionComision = (typeof DECISIONES_COMISION)[number]

export interface FiltrosTickets {
  /** YYYY-MM-DD, día completo en America/Bogota (created_at del ticket). */
  desde: string | null
  hasta: string | null
  comercialId: number | null
  convenioId: number | null
  estado: (typeof ESTADOS_TICKET)[number] | null
  ventana: 'dentro' | 'fuera' | null
  placa: string | null
  turnoId: number | null
  decision: DecisionComision | null
  tipoTicketId: number | null
  creadoPorId: number | null
}

const num = (v: unknown): number | null => {
  if (v === undefined || v === null || String(v).trim() === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? Math.trunc(n) : Number.NaN
}

/** Valida los query params. Mensaje de error listo para un 400. */
export function parseFiltrosTickets(
  input: Record<string, unknown>
): { ok: true; filtros: FiltrosTickets } | { ok: false; message: string } {
  const fecha = (k: string) => {
    const v = String(input[k] ?? '').trim()
    if (!v) return null
    const d = DateTime.fromISO(v, { zone: 'America/Bogota' })
    return d.isValid && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : undefined
  }
  const desde = fecha('fecha_desde')
  const hasta = fecha('fecha_hasta')
  if (desde === undefined || hasta === undefined) {
    return { ok: false, message: 'fecha_desde/fecha_hasta deben ser YYYY-MM-DD' }
  }
  if (desde && hasta && desde > hasta) {
    return { ok: false, message: 'fecha_desde no puede ser posterior a fecha_hasta' }
  }

  const ids: Record<string, number | null> = {}
  for (const k of ['comercial_id', 'convenio_id', 'turno_id', 'tipo_ticket_id', 'creado_por_id']) {
    const n = num(input[k])
    if (Number.isNaN(n)) return { ok: false, message: `${k} debe ser numérico` }
    ids[k] = n
  }

  const estado =
    String(input.estado ?? '')
      .trim()
      .toUpperCase() || null
  if (estado && !(ESTADOS_TICKET as readonly string[]).includes(estado)) {
    return { ok: false, message: `estado inválido (${ESTADOS_TICKET.join(' | ')})` }
  }
  const ventana =
    String(input.ventana ?? '')
      .trim()
      .toLowerCase() || null
  if (ventana && ventana !== 'dentro' && ventana !== 'fuera') {
    return { ok: false, message: 'ventana inválida (dentro | fuera)' }
  }
  const decision =
    String(input.decision ?? '')
      .trim()
      .toLowerCase() || null
  if (decision && !(DECISIONES_COMISION as readonly string[]).includes(decision)) {
    return { ok: false, message: `decision inválida (${DECISIONES_COMISION.join(' | ')})` }
  }
  const placa =
    String(input.placa ?? '')
      .trim()
      .toUpperCase() || null

  return {
    ok: true,
    filtros: {
      desde,
      hasta,
      comercialId: ids.comercial_id,
      convenioId: ids.convenio_id,
      estado: estado as FiltrosTickets['estado'],
      ventana: ventana as FiltrosTickets['ventana'],
      placa,
      turnoId: ids.turno_id,
      decision: decision as DecisionComision | null,
      tipoTicketId: ids.tipo_ticket_id,
      creadoPorId: ids.creado_por_id,
    },
  }
}

/** Flag del asesor (1/0/NULL) con compatibilidad con producción local. */
export const sqlFlagAsesor = (d = 'd') => `COALESCE(${d}.con_comision_asesor, ${d}.con_comision)`

/** Flag del convenio (1/0/NULL); NULL también si el ticket no tiene convenio. */
export const sqlFlagConvenio = (d = 'd') =>
  `(CASE WHEN ${d}.con_comision_asesor IS NULL AND ${d}.con_comision_convenio IS NULL` +
  ` THEN (CASE WHEN ${d}.con_comision IS NULL OR ${d}.convenio_id IS NULL THEN NULL ELSE 1 END)` +
  ` ELSE ${d}.con_comision_convenio END)`

/**
 * Decisión de comisión de un ticket APROBADO (NULL si no está aprobado):
 *  - con: dentro de ventana, o asesor y convenio (si aplica) cobran
 *  - sin_asesor / sin_convenio / sin_ninguno
 *  - regimen_anterior: fuera de ventana sin decisión guardada (antes de que
 *    existiera la decisión de gerencia)
 */
export const sqlDecisionComision = (t = 't', d = 'd') => {
  const a = sqlFlagAsesor(d)
  const c = sqlFlagConvenio(d)
  return (
    `(CASE WHEN ${t}.estado <> 'APROBADO' THEN NULL` +
    ` WHEN ${d}.dentro_ventana = 1 THEN 'con'` +
    ` WHEN ${a} IS NULL THEN 'regimen_anterior'` +
    ` WHEN ${a} = 0 AND ${c} = 0 THEN 'sin_ninguno'` +
    ` WHEN ${a} = 0 THEN 'sin_asesor'` +
    ` WHEN ${c} = 0 THEN 'sin_convenio'` +
    ` ELSE 'con' END)`
  )
}

/**
 * Aplica los filtros a un query builder que ya tiene `tickets` (alias t) y
 * `tickets_detalle_excepcion_dateo` (alias d, left join).
 */
export function aplicarFiltrosTickets(q: any, f: FiltrosTickets, t = 't', d = 'd') {
  if (f.desde) q.where(`${t}.created_at`, '>=', `${f.desde} 00:00:00`)
  if (f.hasta) {
    const siguiente = DateTime.fromISO(f.hasta).plus({ days: 1 }).toISODate()
    q.where(`${t}.created_at`, '<', `${siguiente} 00:00:00`)
  }
  if (f.comercialId !== null) q.where(`${d}.comercial_id`, f.comercialId)
  if (f.convenioId !== null) q.where(`${d}.convenio_id`, f.convenioId)
  if (f.estado) q.where(`${t}.estado`, f.estado)
  if (f.ventana) q.where(`${d}.dentro_ventana`, f.ventana === 'dentro' ? 1 : 0)
  if (f.placa) q.where(`${d}.placa`, 'like', `%${f.placa}%`)
  if (f.turnoId !== null) q.where(`${d}.turno_id`, f.turnoId)
  if (f.decision) q.whereRaw(`${sqlDecisionComision(t, d)} = ?`, [f.decision])
  if (f.tipoTicketId !== null) q.where(`${t}.tipo_ticket_id`, f.tipoTicketId)
  if (f.creadoPorId !== null) q.where(`${t}.creado_por_id`, f.creadoPorId)
  return q
}
