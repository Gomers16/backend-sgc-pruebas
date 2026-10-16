// app/services/consecutivo_descuento_service.ts
//
// Consecutivo del descuento (facturacion_tickets.consecutivo_descuento) para
// pantallas y reportes que NO parten del ticket (comisiones, dateos, ficha
// del asesor, Liquidación RTM). No se copia a comisiones/dateos/turnos: se
// lee siempre del ticket.
//
// Vínculo: ticket.turno_id = turno del dateo (captacion_dateos.consumido_turno_id).
// facturacion_tickets.dateo_id casi nunca se llena, así que no se usa.
//
// Regla única (la misma en SQL y en memoria): el ticket CONFIRMADA más
// reciente (mayor id) de ese turno que tenga consecutivo. Sin ticket
// confirmado o sin consecutivo (tickets anteriores a la función) → null, y
// la pantalla muestra "—".
//
// La versión SQL es una subconsulta escalar (LIMIT 1): nunca agrega filas,
// así que no cambia totales ni conteos de la consulta donde se use.

import Database from '@adonisjs/lucid/services/db'

const COLUMNA_SQL_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/

/**
 * Subconsulta escalar con el consecutivo del descuento del turno.
 * `turnoIdCol` es la columna (alias.columna) con el id del turno, ej. 't.id'
 * o 'cd.consumido_turno_id'. Solo se aceptan identificadores fijos del código.
 */
export function sqlConsecutivoDescuentoDelTurno(turnoIdCol: string): string {
  if (!COLUMNA_SQL_RE.test(turnoIdCol)) {
    throw new Error(`Columna inválida para consecutivo del descuento: ${turnoIdCol}`)
  }
  return `(SELECT ftcd.consecutivo_descuento FROM facturacion_tickets ftcd
    WHERE ftcd.turno_id = ${turnoIdCol}
      AND ftcd.estado = 'CONFIRMADA'
      AND ftcd.consecutivo_descuento IS NOT NULL
    ORDER BY ftcd.id DESC LIMIT 1)`
}

/** Consecutivo del descuento por id de turno (solo los que tienen uno). */
export async function consecutivosDescuentoPorTurno(
  turnoIds: Array<number | null | undefined>
): Promise<Map<number, string>> {
  const ids = Array.from(new Set(turnoIds.filter((id): id is number => Number(id) > 0)))
  const out = new Map<number, string>()
  if (!ids.length) return out

  const rows = (await Database.from('facturacion_tickets')
    .whereIn('turno_id', ids)
    .where('estado', 'CONFIRMADA')
    .whereNotNull('consecutivo_descuento')
    .select('turno_id', 'consecutivo_descuento')
    .orderBy('id', 'desc')) as { turno_id: number; consecutivo_descuento: string }[]

  for (const r of rows) {
    const turnoId = Number(r.turno_id)
    if (!out.has(turnoId)) out.set(turnoId, r.consecutivo_descuento)
  }
  return out
}

/** Misma regla sobre tickets ya cargados en memoria (preload). */
export function consecutivoDescuentoDeTickets(
  tickets: Array<{ id: number; estado: string; consecutivoDescuento?: string | null }>
): string | null {
  let elegido: { id: number; consecutivoDescuento?: string | null } | null = null
  for (const t of tickets) {
    if (t.estado !== 'CONFIRMADA' || !t.consecutivoDescuento) continue
    if (!elegido || t.id > elegido.id) elegido = t
  }
  return elegido?.consecutivoDescuento ?? null
}
