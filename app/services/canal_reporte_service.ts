// app/services/canal_reporte_service.ts
//
// Canal de captación de los reportes "por canal" (Ingresos, Retención,
// Descuentos, Liquidación/Trazabilidad y sus detalles): sale de lo que el
// operador eligió en "¿Cómo se enteró de nosotros?" (turnos_rtms.canal_atribucion,
// vía facturacion_tickets.turno_id), no del canal del dateo copiado al ticket.
//
// Respaldo (el pasado no cambia): si el turno no tiene canal o el ticket no
// tiene turno, se traduce el canal del dateo del ticket (captacion_canal) a
// los mismos grupos; sin dateo, Fachada — igual que antes.
//
// Asesor se desglosa en Comercial / Convenio por el tipo del dateo del ticket
// o, si no lo hay, por el tipo del agente del turno; si ninguno, "sin detalle".
//
// Solo cambia el REPARTO: comisiones, metas y los reportes de asesores y
// convenios siguen leyendo captacion_canal / el dateo, sin cambios.

import env from '#start/env'

export const ASESOR_SUBCANALES = [
  'ASESOR_COMERCIAL',
  'ASESOR_CONVENIO',
  'ASESOR_SIN_DETALLE',
] as const

/** Filas en orden fijo; Asesor lleva debajo sus subcanales. */
export const CANALES_REPORTE = ['FACHADA', 'REDES', 'TELE', 'ASESOR', 'GOOGLE_ADS'] as const

export const NOMBRE_CANAL_REPORTE: Record<string, string> = {
  FACHADA: 'Fachada',
  REDES: 'Redes Sociales',
  TELE: 'Call Center',
  ASESOR: 'Asesor',
  ASESOR_COMERCIAL: 'Comercial',
  ASESOR_CONVENIO: 'Convenio',
  ASESOR_SIN_DETALLE: 'Asesor (sin detalle)',
  GOOGLE_ADS: 'Google ADS',
}

export const nombreCanalReporte = (canal: string) => NOMBRE_CANAL_REPORTE[canal] ?? canal

/**
 * Grupo del ticket (nivel subcanal): FACHADA, REDES, TELE, GOOGLE_ADS,
 * ASESOR_COMERCIAL, ASESOR_CONVENIO o ASESOR_SIN_DETALLE.
 * Requiere los alias `ft` (facturacion_tickets), `t` (turnos_rtms, LEFT JOIN)
 * y `ag` (agentes_captacions del turno, LEFT JOIN) — ver joinCanalReporte().
 */
export function grupoCanalSql(ft = 'ft', t = 't', ag = 'ag'): string {
  return `(CASE
    WHEN ${t}.canal_atribucion = 'ASESOR'
      OR (${t}.canal_atribucion IS NULL AND ${ft}.captacion_canal IN ('ASESOR_COMERCIAL', 'ASESOR_CONVENIO'))
    THEN CASE
      WHEN ${ft}.captacion_canal IN ('ASESOR_COMERCIAL', 'ASESOR_CONVENIO') THEN ${ft}.captacion_canal
      WHEN ${ag}.tipo IN ('ASESOR_COMERCIAL', 'ASESOR_CONVENIO') THEN ${ag}.tipo
      ELSE 'ASESOR_SIN_DETALLE'
    END
    WHEN ${t}.canal_atribucion IS NOT NULL THEN ${t}.canal_atribucion
    WHEN ${ft}.captacion_canal IN ('TELE', 'TELEMERCADEO') THEN 'TELE'
    WHEN ${ft}.captacion_canal = 'REDES' THEN 'REDES'
    ELSE 'FACHADA'
  END)`
}

type Joinable = {
  leftJoin: (...args: any[]) => any
  whereRaw: (...args: any[]) => any
}

/**
 * LEFT JOIN al agente del turno (y al turno, si la consulta no lo tiene ya)
 * + exclusión de segunda vez. Una segunda vez no se factura (guards de
 * facturación), así que en la práctica no quita filas: es un seguro.
 */
export function joinCanalReporte<Q extends Joinable>(
  query: Q,
  opts: { ft?: string; t?: string; ag?: string; unirTurno?: boolean } = {}
): Q {
  const ft = opts.ft ?? 'ft'
  const t = opts.t ?? 't'
  const ag = opts.ag ?? 'ag'
  if (opts.unirTurno !== false) query.leftJoin(`turnos_rtms as ${t}`, `${t}.id`, `${ft}.turno_id`)
  query.leftJoin(`agentes_captacions as ${ag}`, `${ag}.id`, `${t}.agente_captacion_id`)
  query.whereRaw(`(${t}.id IS NULL OR ${t}.es_segunda_vez = 0)`)
  return query
}

/** Filtro de detalle: 'ASESOR' abarca sus subcanales; códigos viejos se traducen. */
export function whereCanalReporte<Q extends { whereRaw: (...args: any[]) => any }>(
  query: Q,
  canal: string,
  opts: { ft?: string; t?: string; ag?: string } = {}
): Q {
  const grupo = grupoCanalSql(opts.ft, opts.t, opts.ag)
  const c = normalizarCanalReporte(canal)
  if (c === 'ASESOR') {
    query.whereRaw(`${grupo} IN (${ASESOR_SUBCANALES.map(() => '?').join(', ')})`, [
      ...ASESOR_SUBCANALES,
    ])
  } else {
    query.whereRaw(`${grupo} = ?`, [c])
  }
  return query
}

/** Acepta los códigos que mandaban las pantallas antes (TELEMERCADEO…). */
export function normalizarCanalReporte(canal: string): string {
  const c = String(canal || '')
    .toUpperCase()
    .trim()
  if (c === 'TELEMERCADEO') return 'TELE'
  return c
}

export type FilaCanal<M> = M & { canal: string; nombre: string; es_subcanal: boolean }

/**
 * Arma las filas en el orden fijo, con ceros donde no hay datos: los 5
 * canales y, debajo de Asesor, Comercial y Convenio (y "sin detalle" solo si
 * tiene datos). `sumar` combina dos métricas (para el total de Asesor) y
 * `finalizar` recalcula lo derivado (promedios, porcentajes) de cada fila.
 */
export function armarFilasCanal<M extends Record<string, number>>(
  porGrupo: Map<string, M>,
  vacia: () => M,
  sumar: (a: M, b: M) => M,
  finalizar: (m: M, canal: string) => M = (m) => m
): FilaCanal<M>[] {
  const fila = (canal: string, m: M, esSub: boolean): FilaCanal<M> => ({
    canal,
    nombre: nombreCanalReporte(canal),
    es_subcanal: esSub,
    ...finalizar(m, canal),
  })
  const filas: FilaCanal<M>[] = []
  for (const canal of CANALES_REPORTE) {
    if (canal !== 'ASESOR') {
      filas.push(fila(canal, porGrupo.get(canal) ?? vacia(), false))
      continue
    }
    const subs = ASESOR_SUBCANALES.map((s) => [s, porGrupo.get(s) ?? vacia()] as const)
    const total = subs.reduce((acc, [, m]) => sumar(acc, m), vacia())
    filas.push(fila('ASESOR', total, false))
    for (const [s, m] of subs) {
      const tieneDatos = Object.values(m).some((v) => Number(v) !== 0)
      if (s === 'ASESOR_SIN_DETALLE' && !tieneDatos) continue
      filas.push(fila(s, m, true))
    }
  }
  return filas
}

/** Suma campo a campo (para métricas aditivas). */
export function sumarMetricas<M extends Record<string, number>>(a: M, b: M): M {
  const out = { ...a }
  for (const k of Object.keys(b) as (keyof M)[])
    out[k] = ((Number(a[k]) || 0) + (Number(b[k]) || 0)) as M[keyof M]
  return out
}

// ───────────────────────── Fecha confiable ─────────────────────────

/**
 * Antes de CANAL_CONFIABLE_DESDE el turno guardaba la sugerencia del sistema
 * y no lo que eligió el operador (el desplegable no obedecía): el desglose
 * por canal de esos días no es confiable. Sin la variable se avisa siempre.
 */
export function canalConfiableDesde(): string | null {
  const v = env.get('CANAL_CONFIABLE_DESDE')
  return v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null
}

export type AvisoCanal = { confiable_desde: string | null; aplica: boolean; mensaje: string | null }

export function avisoCanal(
  fechaInicio: string,
  desde: string | null = canalConfiableDesde()
): AvisoCanal {
  const aplica = !desde || fechaInicio < desde
  if (!aplica) return { confiable_desde: desde, aplica, mensaje: null }
  const fecha = desde ? desde.split('-').reverse().join('/') : null
  return {
    confiable_desde: desde,
    aplica,
    mensaje: fecha
      ? `El desglose por "¿Cómo se enteró de nosotros?" es confiable desde el ${fecha}; antes refleja la sugerencia automática del sistema.`
      : 'El desglose por "¿Cómo se enteró de nosotros?" todavía no tiene fecha confiable configurada (CANAL_CONFIABLE_DESDE): refleja la sugerencia automática del sistema.',
  }
}
