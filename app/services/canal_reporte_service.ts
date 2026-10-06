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
// Asesor se desglosa en Asesor comercial / Asesor convenio por el tipo del
// dateo del ticket o, si no lo hay, por el tipo del agente del turno; si
// ninguno, "sin detalle". Debajo de Asesor comercial va la línea INFORMATIVA
// "de los cuales, por convenio" (comercial cuyo dateo trae convenio): misma
// regla que la sección Convenios de la Liquidación RTM (asesor comercial +
// convenio_id; los asesores convenio ya tienen su fila). No suma a ningún
// total (es_informativa).
//
// Solo cambia el REPARTO: comisiones, metas y los reportes de asesores y
// convenios siguen leyendo captacion_canal / el dateo, sin cambios.

import env from '#start/env'

export const ASESOR_SUBCANALES = [
  'ASESOR_COMERCIAL',
  'ASESOR_CONVENIO',
  'ASESOR_SIN_DETALLE',
] as const

/** Subgrupo de la línea informativa (dentro de ASESOR_COMERCIAL). */
export const COMERCIAL_POR_CONVENIO = 'ASESOR_COMERCIAL_CONVENIO'

/** Subgrupos (subgrupoCanalSql) que abarca cada fila; el resto es 1 a 1. */
const SUBGRUPOS_DE: Record<string, string[]> = {
  ASESOR: ['ASESOR_COMERCIAL', COMERCIAL_POR_CONVENIO, 'ASESOR_CONVENIO', 'ASESOR_SIN_DETALLE'],
  ASESOR_COMERCIAL: ['ASESOR_COMERCIAL', COMERCIAL_POR_CONVENIO],
}

/** Filas en orden fijo; Asesor lleva debajo sus subcanales. */
export const CANALES_REPORTE = ['FACHADA', 'REDES', 'TELE', 'ASESOR', 'GOOGLE_ADS'] as const

export const NOMBRE_CANAL_REPORTE: Record<string, string> = {
  FACHADA: 'Fachada',
  REDES: 'Redes Sociales',
  TELE: 'Call Center',
  ASESOR: 'Asesor',
  ASESOR_COMERCIAL: 'Asesor comercial',
  [COMERCIAL_POR_CONVENIO]: 'de los cuales, por convenio',
  ASESOR_CONVENIO: 'Asesor convenio',
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

/**
 * ¿El dateo del ticket trae convenio? Dateo del turno; si no, el del ticket;
 * respaldo: el nombre del convenio que se copió al ticket al facturar.
 */
export function convenioSql(ft = 'ft', dt = 'crd_t', dk = 'crd_k'): string {
  return `(COALESCE(${dt}.convenio_id, ${dk}.convenio_id) IS NOT NULL OR NULLIF(TRIM(${ft}.convenio_nombre), '') IS NOT NULL)`
}

/**
 * Como grupoCanalSql() pero separando ASESOR_COMERCIAL con convenio como
 * ASESOR_COMERCIAL_CONVENIO (la línea informativa). Es la columna por la que
 * agrupan y filtran los reportes. Requiere joinCanalReporte().
 */
export function subgrupoCanalSql(): string {
  const g = grupoCanalSql()
  return `(CASE WHEN ${g} = 'ASESOR_COMERCIAL' AND ${convenioSql()} THEN '${COMERCIAL_POR_CONVENIO}' ELSE ${g} END)`
}

type Joinable = {
  leftJoin: (...args: any[]) => any
  whereRaw: (...args: any[]) => any
}

/**
 * LEFT JOIN al agente del turno (y al turno, si la consulta no lo tiene ya),
 * a los dateos del turno y del ticket (alias crd_t / crd_k, para el convenio)
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
  query.leftJoin('captacion_dateos as crd_t', 'crd_t.id', `${t}.captacion_dateo_id`)
  query.leftJoin('captacion_dateos as crd_k', 'crd_k.id', `${ft}.dateo_id`)
  query.whereRaw(`(${t}.id IS NULL OR ${t}.es_segunda_vez = 0)`)
  return query
}

/**
 * Filtro de detalle por fila: 'ASESOR' abarca sus subcanales, 'ASESOR_COMERCIAL'
 * incluye su parte por convenio y la línea informativa se filtra sola: cada
 * detalle suma lo mismo que su fila. Códigos viejos se traducen.
 */
export function whereCanalReporte<Q extends { whereRaw: (...args: any[]) => any }>(
  query: Q,
  canal: string
): Q {
  const c = normalizarCanalReporte(canal)
  const subgrupos = SUBGRUPOS_DE[c] ?? [c]
  query.whereRaw(
    `${subgrupoCanalSql()} IN (${subgrupos.map(() => '?').join(', ')})`,
    subgrupos
  )
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

export type FilaCanal<M> = Omit<M, 'porcentaje'> & {
  canal: string
  nombre: string
  es_subcanal: boolean
  /** Línea "de los cuales, por convenio": ya está dentro de Asesor comercial, NO suma. */
  es_informativa: boolean
  /** % del total; null en la línea informativa (se muestra "—"). */
  porcentaje?: number | null
  /** Solo en la línea informativa: su % sobre Asesor comercial. */
  porcentaje_sobre_asesor_comercial?: number
}

/**
 * Arma las filas en el orden fijo, con ceros donde no hay datos: los 5
 * canales y, debajo de Asesor, Asesor comercial (con su línea informativa
 * "de los cuales, por convenio"), Asesor convenio y "sin detalle" (solo si
 * tiene datos). `porSubgrupo` viene agrupado por subgrupoCanalSql().
 * `sumar` combina métricas (totales de Asesor y de Asesor comercial),
 * `finalizar` recalcula lo derivado de cada fila y `campoPorcentaje` es la
 * métrica del % de la línea informativa sobre Asesor comercial.
 */
export function armarFilasCanal<M extends Record<string, number>>(
  porSubgrupo: Map<string, M>,
  vacia: () => M,
  sumar: (a: M, b: M) => M,
  finalizar: (m: M, canal: string) => M = (m) => m,
  campoPorcentaje?: keyof M
): FilaCanal<M>[] {
  const get = (k: string) => porSubgrupo.get(k) ?? vacia()
  const fila = (canal: string, m: M, esSub = false, esInf = false): FilaCanal<M> => ({
    canal,
    nombre: nombreCanalReporte(canal),
    es_subcanal: esSub,
    es_informativa: esInf,
    ...finalizar(m, canal),
  })
  const porConvenio = get(COMERCIAL_POR_CONVENIO)
  const comercial = sumar(get('ASESOR_COMERCIAL'), porConvenio)
  const convenio = get('ASESOR_CONVENIO')
  const sinDetalle = get('ASESOR_SIN_DETALLE')

  const filas: FilaCanal<M>[] = []
  for (const canal of CANALES_REPORTE) {
    if (canal !== 'ASESOR') {
      filas.push(fila(canal, get(canal)))
      continue
    }
    filas.push(fila('ASESOR', sumar(sumar(comercial, convenio), sinDetalle)))
    filas.push(fila('ASESOR_COMERCIAL', comercial, true))
    const inf = fila(COMERCIAL_POR_CONVENIO, porConvenio, true, true)
    if ('porcentaje' in inf) inf.porcentaje = null
    if (campoPorcentaje) {
      const base = Number(comercial[campoPorcentaje]) || 0
      inf.porcentaje_sobre_asesor_comercial = base
        ? Math.round((Number(porConvenio[campoPorcentaje]) / base) * 10000) / 100
        : 0
    }
    filas.push(inf)
    filas.push(fila('ASESOR_CONVENIO', convenio, true))
    if (Object.values(sinDetalle).some((v) => Number(v) !== 0)) {
      filas.push(fila('ASESOR_SIN_DETALLE', sinDetalle, true))
    }
  }
  return filas
}

/** Filas que suman a los totales (sin subcanales ni la línea informativa). */
export const filasQueSuman = <T extends { es_subcanal: boolean }>(filas: T[]) =>
  filas.filter((f) => !f.es_subcanal)

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
