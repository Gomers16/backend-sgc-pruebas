// app/services/telemercadeo_cola_service.ts
//
// Cola de trabajo de Telemercadeo (solo lectura): a quién llamar.
//  - POR_VENCER: por PLACA. Último RTM que da vigencia (whereTurnoDaVigencia)
//    + 12 meses, mismo cálculo que RTM_VIGENTE en captacion_dateos_controller.
//    Se arma con consultas agregadas y se pagina en memoria (es una ventana
//    de ~90 días de RTM, no toda la base).
//  - CLIENTES: TODOS los clientes con su "última visita real" (la fecha más
//    reciente entre turno por cliente_id, turno sin cliente ligado por placa
//    y ticket CONFIRMADA cuyo turno ya no existe). Todo en SQL: filtro,
//    contadores, orden y LIMIT/OFFSET.
// Ambas excluyen placas/clientes con turno hoy o con dateo RTM vigente (mismo
// criterio que store() de dateos: el último dateo liberado=0 por
// placa/teléfono + servicio, con la vigencia de buildReserva()).

import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import CaptacionDateo from '#models/captacion_dateo'
import {
  buildReserva,
  getHorasExclusividad,
  ttlPostConsumoDiasPorServicio,
} from '#services/reserva_dateo_service'
import { excluirSegundaVezSql, whereTurnoDaVigencia } from '#services/segunda_vez_service'

const ZONA = 'America/Bogota'

/** Vigencia del RTM (igual que captacion_dateos_controller.ts y WINDOW_BLOCK). */
export const MESES_VIGENCIA_RTM = 12
/** Ventana previa de referencia visual (DIAS_VENTANA_PRE de turnos_rtms_controller.ts). */
export const DIAS_VENTANA_PREVIA = 16
/** POR_VENCER: vencen en los próximos N días… */
export const DIAS_POR_VENCER = 30
/** …o vencieron hace a lo sumo N días. */
export const DIAS_VENCIDAS_RECIENTES = 60

export const LISTAS = ['POR_VENCER', 'CLIENTES'] as const
export type ListaCola = (typeof LISTAS)[number]

export const RANGOS_POR_VENCER = ['PROXIMAS', 'VENCIDAS'] as const
export type RangoPorVencer = (typeof RANGOS_POR_VENCER)[number]

/**
 * "Tiempo sin venir" de CLIENTES, en meses completos: [desde, hasta).
 * 0_1 no tiene filtro propio (solo cuenta en "Todos").
 */
export const RANGOS_CLIENTES = {
  '0_1': [0, 2],
  '2_5': [2, 6],
  '6_11': [6, 12],
  '12_23': [12, 24],
  '24_MAS': [24, null],
} as const satisfies Record<string, readonly [number, number | null]>
export const RANGO_SIN_FECHA = 'SIN_FECHA'
export type RangoClientes = keyof typeof RANGOS_CLIENTES | typeof RANGO_SIN_FECHA
/** Rangos que se pueden pedir como filtro. */
export const FILTROS_CLIENTES = ['2_5', '6_11', '12_23', '24_MAS', RANGO_SIN_FECHA] as const

export const ORDENES_CLIENTES = ['ANTIGUEDAD', 'RECIENTE', 'NOMBRE'] as const
export type OrdenClientes = (typeof ORDENES_CLIENTES)[number]

export type FuenteVisita = 'TURNO_CLIENTE' | 'TURNO_PLACA' | 'TICKET'

export interface FilaCola {
  clave: string
  cliente_id: number | null
  cliente_nombre: string | null
  telefono: string | null
  documento: string | null
  placa: string
  placas: string[]
  n_vehiculos: number | null
  ultima_visita: string | null
  fuente_ultima_visita: FuenteVisita | null
  servicio_ultima_visita: string | null
  meses_transcurridos: number | null
  rango: string | null
  // Solo POR_VENCER
  vence_el: string | null
  puede_datear_desde: string | null
  dias_para_vencer: number | null
}

export interface ParametrosCola {
  lista: ListaCola
  rango: string | null
  q: string | null
  orden: OrdenClientes
  page: number
  perPage: number
}

export interface ResultadoCola {
  data: FilaCola[]
  meta: {
    total: number
    current_page: number
    per_page: number
    last_page: number
    hoy: string
    contadores: {
      POR_VENCER: Record<RangoPorVencer | 'total', number>
      CLIENTES: Record<RangoClientes | 'total', number>
    }
    parametros: {
      meses_vigencia_rtm: number
      dias_ventana_previa: number
      dias_por_vencer: number
      dias_vencidas_recientes: number
    }
  }
}

const soloDigitos = (v: unknown) => String(v ?? '').replace(/\D/g, '')
const normPlaca = (v: unknown) =>
  String(v ?? '')
    .replace(/[\s-]/g, '')
    .toUpperCase()

const aFechaISO = (v: unknown): string =>
  v instanceof Date
    ? DateTime.fromJSDate(v).toISODate()!
    : DateTime.fromISO(String(v).substring(0, 10)).toISODate()!

const listaCsv = (v: unknown): string[] =>
  String(v ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)

/** Meses completos entre dos fechas, igual que turnos_rtms_controller.ts. */
function mesesEntre(desdeISO: string, hoyISO: string): number {
  const desde = DateTime.fromISO(desdeISO, { zone: ZONA })
  const hoy = DateTime.fromISO(hoyISO, { zone: ZONA })
  return Math.floor(hoy.diff(desde, 'months').months)
}

async function servicioRtmId(): Promise<number | null> {
  const row = await Database.from('servicios').where('codigo_servicio', 'RTM').select('id').first()
  return row?.id ?? null
}

/* ───────────────────── Vigencia de dateo en SQL ───────────────────── */

/** Teléfono solo dígitos en SQL (sin REGEXP_REPLACE, para MySQL < 8). */
const telefonoSql = (col: string) =>
  `NULLIF(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(TRIM(${col}), ' ', ''), '-', ''), '(', ''), ')', ''), '+', ''), '.', ''), '')`

/**
 * Mismo criterio que buildReserva() para un dateo RTM, como expresión SQL
 * (1 = vigente). Consumido → consumido_at + TTL post-consumo (días); si no →
 * (redateado_at ?? created_at) + horas de exclusividad. Los parámetros salen
 * de las mismas funciones de reserva_dateo_service. "Ahora" va como
 * parámetro (Date de Node), igual que el DateTime.now() de buildReserva().
 */
export async function vigenciaDateoRtmSql(alias: string, ahora: Date) {
  const horas = await getHorasExclusividad()
  const ttlDias = ttlPostConsumoDiasPorServicio('RTM')
  return {
    sql: `(CASE
      WHEN ${alias}.consumido_turno_id IS NOT NULL AND ${alias}.consumido_at IS NOT NULL
        THEN ${alias}.consumido_at + INTERVAL ? DAY > ?
      WHEN COALESCE(${alias}.redateado_at, ${alias}.created_at) IS NULL THEN 0
      ELSE COALESCE(${alias}.redateado_at, ${alias}.created_at) + INTERVAL ? HOUR > ?
    END)`,
    bindings: [ttlDias, ahora, horas, ahora] as unknown[],
  }
}

/* ───────────────────────── POR_VENCER ───────────────────────── */

async function candidatosPorVencer(hoyISO: string, rtmId: number): Promise<FilaCola[]> {
  const hoy = DateTime.fromISO(hoyISO, { zone: ZONA })
  // Prefiltro amplio en SQL; el corte exacto se hace con Luxon abajo.
  const fechaDesde = hoy
    .minus({ months: MESES_VIGENCIA_RTM, days: DIAS_VENCIDAS_RECIENTES + 3 })
    .toISODate()!
  const fechaHasta = hoy
    .minus({ months: MESES_VIGENCIA_RTM })
    .plus({ days: DIAS_POR_VENCER + 3 })
    .toISODate()!

  const ultimoRtm = whereTurnoDaVigencia(
    Database.from('turnos_rtms').where('turnos_rtms.servicio_id', rtmId)
  )
    .select('turnos_rtms.placa')
    .max('turnos_rtms.fecha as fecha')
    .groupBy('turnos_rtms.placa')

  // Cliente: dueño actual del vehículo; si no tiene, el del último RTM.
  const rows = await Database.from(ultimoRtm.as('r'))
    .leftJoin('turnos_rtms as t', (j) => {
      j.on('t.placa', 'r.placa').andOn('t.fecha', 'r.fecha').andOnVal('t.servicio_id', rtmId)
    })
    .leftJoin('vehiculos as v', 'v.placa', 'r.placa')
    .joinRaw('LEFT JOIN clientes AS c ON c.id = COALESCE(v.cliente_id, t.cliente_id)')
    .whereBetween('r.fecha', [fechaDesde, fechaHasta])
    .groupBy('r.placa', 'r.fecha')
    .select('r.placa', 'r.fecha')
    .select(Database.raw('MAX(c.id) as cliente_id'))
    .select(Database.raw('MAX(c.nombre) as cliente_nombre'))
    .select(Database.raw('MAX(c.telefono) as telefono'))

  const filas: FilaCola[] = []
  for (const r of rows) {
    const ultimaISO = aFechaISO(r.fecha)
    const vence = DateTime.fromISO(ultimaISO, { zone: ZONA })
      .plus({ months: MESES_VIGENCIA_RTM })
      .startOf('day')
    const dias = Math.round(vence.diff(hoy.startOf('day'), 'days').days)
    if (dias > DIAS_POR_VENCER || dias < -DIAS_VENCIDAS_RECIENTES) continue

    filas.push({
      clave: `P:${r.placa}`,
      cliente_id: r.cliente_id ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      telefono: r.telefono ?? null,
      documento: null,
      placa: r.placa,
      placas: [r.placa],
      n_vehiculos: null,
      ultima_visita: ultimaISO,
      fuente_ultima_visita: null,
      servicio_ultima_visita: 'RTM',
      meses_transcurridos: mesesEntre(ultimaISO, hoyISO),
      rango: dias < 0 ? 'VENCIDAS' : 'PROXIMAS',
      vence_el: vence.toISODate(),
      puede_datear_desde: vence.minus({ days: DIAS_VENTANA_PREVIA }).toISODate(),
      dias_para_vencer: dias,
    })
  }
  return filas.sort((a, b) => a.dias_para_vencer! - b.dias_para_vencer!)
}

interface Exclusiones {
  placas: Set<string>
  clientes: Set<number>
}

/** Turno hoy (activo o finalizado, cualquier servicio): el vehículo ya está en la sede. */
async function exclusionTurnoHoy(hoyISO: string, ex: Exclusiones) {
  const rows = await Database.from('turnos_rtms')
    .where('fecha', hoyISO)
    .whereIn('estado', ['activo', 'finalizado'])
    .select('placa', 'cliente_id')
  for (const r of rows) {
    ex.placas.add(normPlaca(r.placa))
    if (r.cliente_id) ex.clientes.add(Number(r.cliente_id))
  }
}

/**
 * Dateo RTM vigente para las filas de POR_VENCER (pocas): último dateo
 * liberado=0 por placa O teléfono + servicio, evaluado con buildReserva().
 */
async function exclusionDateoVigente(filas: FilaCola[], rtmId: number, ex: Exclusiones) {
  const placas = [...new Set(filas.flatMap((f) => f.placas.map(normPlaca)).filter(Boolean))]
  const telefonos = [...new Set(filas.map((f) => soloDigitos(f.telefono)).filter(Boolean))]
  if (!placas.length && !telefonos.length) return

  const dateos = await CaptacionDateo.query()
    .where('liberado', false)
    .where('servicio_id', rtmId)
    .where((q) => {
      if (placas.length) q.orWhereIn('placa', placas)
      if (telefonos.length) q.orWhereIn('telefono', telefonos)
    })
    .orderBy('created_at', 'desc')

  // Último dateo por placa y por teléfono (vienen ordenados por created_at desc).
  const ultimoPorPlaca = new Map<string, CaptacionDateo>()
  const ultimoPorTelefono = new Map<string, CaptacionDateo>()
  for (const d of dateos) {
    const p = normPlaca(d.placa)
    const t = soloDigitos(d.telefono)
    if (p && !ultimoPorPlaca.has(p)) ultimoPorPlaca.set(p, d)
    if (t && !ultimoPorTelefono.has(t)) ultimoPorTelefono.set(t, d)
  }

  const vigentes = new Set<number>()
  for (const d of new Set([...ultimoPorPlaca.values(), ...ultimoPorTelefono.values()])) {
    const reserva = await buildReserva(d)
    if (reserva.vigente) vigentes.add(d.id)
  }

  // store() toma el más reciente entre "misma placa" o "mismo teléfono".
  for (const f of filas) {
    const tel = soloDigitos(f.telefono)
    const porTel = tel ? ultimoPorTelefono.get(tel) : undefined
    for (const p of f.placas.map(normPlaca)) {
      const ultimo = [ultimoPorPlaca.get(p), porTel]
        .filter((d): d is CaptacionDateo => !!d)
        .sort((a, b) => b.createdAt.toMillis() - a.createdAt.toMillis())[0]
      if (ultimo && vigentes.has(ultimo.id)) ex.placas.add(p)
    }
  }
}

function coincideBusqueda(f: FilaCola, q: string | null): boolean {
  if (!q) return true
  const texto = q.trim().toUpperCase()
  if (!texto) return true
  if (f.placas.some((p) => normPlaca(p).includes(normPlaca(texto)))) return true
  if ((f.cliente_nombre ?? '').toUpperCase().includes(texto)) return true
  const dig = soloDigitos(texto)
  return dig.length >= 3 && soloDigitos(f.telefono).includes(dig)
}

async function filasPorVencer(
  hoyISO: string,
  rtmId: number | null,
  q: string | null
): Promise<FilaCola[]> {
  if (!rtmId) return []
  const candidatos = await candidatosPorVencer(hoyISO, rtmId)
  const ex: Exclusiones = { placas: new Set(), clientes: new Set() }
  await exclusionTurnoHoy(hoyISO, ex)
  await exclusionDateoVigente(candidatos, rtmId, ex)
  return candidatos.filter(
    (f) =>
      !(f.cliente_id && ex.clientes.has(f.cliente_id)) &&
      !f.placas.some((p) => ex.placas.has(normPlaca(p))) &&
      coincideBusqueda(f, q)
  )
}

/* ───────────────────────── CLIENTES (SQL) ───────────────────────── */

const escaparLike = (v: string) => v.replace(/[\\%_]/g, (c) => `\\${c}`)

/**
 * SELECT de todos los clientes visibles (sin exclusiones y con la búsqueda
 * aplicada) con su última visita real (u_f), la fuente y los meses. Lo usan
 * la página y los contadores.
 */
async function baseClientesSql(hoyISO: string, rtmId: number | null, q: string | null) {
  const bindings: unknown[] = [hoyISO]
  const sv = (t: string) => excluirSegundaVezSql(t)

  // (a) Turno finalizado por cliente_id.
  const porCliente = `SELECT t.cliente_id, MAX(t.fecha) AS f
    FROM turnos_rtms t
    WHERE t.estado = 'finalizado' AND ${sv('t')} AND t.cliente_id IS NOT NULL AND t.fecha < ?
    GROUP BY t.cliente_id`
  // (b) Turno finalizado sin cliente_id, ligado por placa al dueño actual.
  const porPlaca = `SELECT v.cliente_id, MAX(t.fecha) AS f
    FROM turnos_rtms t
    JOIN vehiculos v ON v.placa = t.placa
    WHERE t.estado = 'finalizado' AND ${sv('t')} AND t.cliente_id IS NULL
      AND v.cliente_id IS NOT NULL AND t.fecha < ?
    GROUP BY v.cliente_id`
  // (c) Ticket CONFIRMADA cuyo turno ya no existe (turno_id queda NULL por
  // ON DELETE SET NULL), por cliente_id o por documento.
  const turnoNoExiste = `NOT EXISTS (SELECT 1 FROM turnos_rtms tx WHERE tx.id = f.turno_id)`
  const porTicket = `SELECT x.cliente_id, MAX(x.f) AS f FROM (
      SELECT f.cliente_id, DATE(f.fecha_pago) AS f
      FROM facturacion_tickets f
      WHERE f.estado = 'CONFIRMADA' AND f.cliente_id IS NOT NULL AND ${turnoNoExiste}
        AND DATE(f.fecha_pago) < ?
      UNION ALL
      SELECT c2.id, DATE(f.fecha_pago)
      FROM facturacion_tickets f
      JOIN clientes c2 ON c2.doc_numero = f.doc_numero
      WHERE f.estado = 'CONFIRMADA' AND f.doc_numero <> '' AND ${turnoNoExiste}
        AND DATE(f.fecha_pago) < ?
    ) x GROUP BY x.cliente_id`
  bindings.push(hoyISO, hoyISO, hoyISO, hoyISO)

  // Exclusión 1 — turno hoy (activo o finalizado, cualquier servicio) del
  // cliente o de cualquiera de sus placas.
  const turnoHoy = `SELECT t.cliente_id FROM turnos_rtms t
      WHERE t.fecha = ? AND t.estado IN ('activo', 'finalizado') AND t.cliente_id IS NOT NULL
    UNION
    SELECT v.cliente_id FROM turnos_rtms t JOIN vehiculos v ON v.placa = t.placa
      WHERE t.fecha = ? AND t.estado IN ('activo', 'finalizado') AND v.cliente_id IS NOT NULL`
  bindings.push(hoyISO, hoyISO)

  // Exclusión 2 — dateo RTM vigente. Como store(): por cada placa del
  // cliente, el último dateo liberado=0 que coincide por placa O por
  // teléfono; si ese último está vigente (buildReserva en SQL), se excluye.
  // Sin vehículos: solo por teléfono.
  let dateoVigente = ''
  if (rtmId) {
    const vig = await vigenciaDateoRtmSql('d', new Date())
    const ultimoPor = (col: 'placa' | 'telefono') => `SELECT d.${col} AS k, d.created_at AS ca,
        MAX(${vig.sql}) AS vig
      FROM captacion_dateos d
      JOIN (SELECT ${col} AS k, MAX(created_at) AS ca FROM captacion_dateos
            WHERE liberado = 0 AND servicio_id = ? AND ${col} IS NOT NULL AND ${col} <> ''
            GROUP BY ${col}) m ON m.k = d.${col} AND m.ca = d.created_at
      WHERE d.liberado = 0 AND d.servicio_id = ?
      GROUP BY d.${col}, d.created_at`
    const ultimoBindings = [...vig.bindings, rtmId, rtmId]
    const tel = telefonoSql('c.telefono')
    dateoVigente = `
    UNION
    SELECT v.cliente_id
      FROM vehiculos v
      JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN (${ultimoPor('placa')}) lp ON lp.k = v.placa
      LEFT JOIN (${ultimoPor('telefono')}) lt ON lt.k = ${tel}
      WHERE (CASE
        WHEN lp.ca IS NOT NULL AND (lt.ca IS NULL OR lp.ca >= lt.ca) THEN lp.vig
        WHEN lt.ca IS NOT NULL THEN lt.vig
        ELSE 0 END) = 1
    UNION
    SELECT c.id
      FROM clientes c
      JOIN (${ultimoPor('telefono')}) lt ON lt.k = ${tel}
      WHERE lt.vig = 1 AND NOT EXISTS (SELECT 1 FROM vehiculos v2 WHERE v2.cliente_id = c.id)`
    bindings.push(...ultimoBindings, ...ultimoBindings, ...ultimoBindings)
  }

  // Búsqueda: nombre, documento, teléfono (dígitos) o placa.
  let filtroQ = ''
  const texto = (q ?? '').trim()
  if (texto) {
    const like = `%${escaparLike(texto)}%`
    const partes = ['c.nombre LIKE ?', 'c.doc_numero LIKE ?']
    bindings.push(like, like)
    const dig = soloDigitos(texto)
    if (dig.length >= 3) {
      partes.push(`${telefonoSql('c.telefono')} LIKE ?`)
      bindings.push(`%${dig}%`)
    }
    const placa = normPlaca(texto)
    if (placa) {
      partes.push(
        'EXISTS (SELECT 1 FROM vehiculos vq WHERE vq.cliente_id = c.id AND vq.placa LIKE ?)'
      )
      bindings.push(`%${escaparLike(placa)}%`)
    }
    filtroQ = `AND (${partes.join(' OR ')})`
  }

  const piso = `DATE('1900-01-01')`
  const sql = `
    SELECT c.id, c.nombre, c.doc_tipo, c.doc_numero, c.telefono,
      u.f AS u_f, DATE_FORMAT(u.f, '%Y-%m-%d') AS u_f_iso, u.fuente,
      TIMESTAMPDIFF(MONTH, u.f, ?) AS meses
    FROM clientes c
    JOIN (
      SELECT c0.id,
        NULLIF(GREATEST(COALESCE(a.f, ${piso}), COALESCE(b.f, ${piso}), COALESCE(k.f, ${piso})), ${piso}) AS f,
        CASE
          WHEN a.f IS NOT NULL AND a.f >= COALESCE(b.f, ${piso}) AND a.f >= COALESCE(k.f, ${piso}) THEN 'TURNO_CLIENTE'
          WHEN b.f IS NOT NULL AND b.f >= COALESCE(k.f, ${piso}) THEN 'TURNO_PLACA'
          WHEN k.f IS NOT NULL THEN 'TICKET'
        END AS fuente
      FROM clientes c0
      LEFT JOIN (${porCliente}) a ON a.cliente_id = c0.id
      LEFT JOIN (${porPlaca}) b ON b.cliente_id = c0.id
      LEFT JOIN (${porTicket}) k ON k.cliente_id = c0.id
    ) u ON u.id = c.id
    LEFT JOIN (
      SELECT DISTINCT e.cliente_id FROM (${turnoHoy}${dateoVigente}) e
    ) ex ON ex.cliente_id = c.id
    WHERE ex.cliente_id IS NULL ${filtroQ}`

  return { sql, bindings }
}

const rangoSql = (meses: string, f: string) => `CASE
    WHEN ${f} IS NULL THEN '${RANGO_SIN_FECHA}'
    ${Object.entries(RANGOS_CLIENTES)
      .filter(([, [, hasta]]) => hasta !== null)
      .map(([k, [, hasta]]) => `WHEN ${meses} < ${hasta} THEN '${k}'`)
      .join('\n    ')}
    ELSE '24_MAS' END`

const ORDEN_SQL: Record<OrdenClientes, string> = {
  // Más tiempo sin venir primero; sin fecha al final (no se sabe cuánto).
  ANTIGUEDAD: 'b.u_f IS NULL, b.u_f ASC, b.id ASC',
  RECIENTE: 'b.u_f IS NULL, b.u_f DESC, b.id ASC',
  NOMBRE: 'b.nombre IS NULL, b.nombre ASC, b.id ASC',
}

async function paginaClientes(
  hoyISO: string,
  rtmId: number | null,
  p: Pick<ParametrosCola, 'rango' | 'q' | 'orden' | 'page' | 'perPage'>
): Promise<{ data: FilaCola[]; total: number; contadores: Record<string, number> }> {
  const base = await baseClientesSql(hoyISO, rtmId, p.q)
  const rango = rangoSql('b.meses', 'b.u_f')

  const [conteo] = await Database.rawQuery(
    `SELECT ${rango} AS rango, COUNT(*) AS n FROM (${base.sql}) b GROUP BY rango`,
    base.bindings
  )
  const contadores: Record<string, number> = {
    total: 0,
    ...Object.fromEntries([...Object.keys(RANGOS_CLIENTES), RANGO_SIN_FECHA].map((k) => [k, 0])),
  }
  for (const r of conteo as Array<{ rango: string; n: number }>) {
    contadores[r.rango] = Number(r.n)
    contadores.total += Number(r.n)
  }

  const total = p.rango ? (contadores[p.rango] ?? 0) : contadores.total
  const filtroRango = p.rango ? `WHERE ${rango} = ?` : ''
  const [rows] = await Database.rawQuery(
    `SELECT b.*, ${rango} AS rango FROM (${base.sql}) b ${filtroRango}
     ORDER BY ${ORDEN_SQL[p.orden]} LIMIT ? OFFSET ?`,
    [...base.bindings, ...(p.rango ? [p.rango] : []), p.perPage, (p.page - 1) * p.perPage]
  )

  // Placas solo de los clientes de la página (≤ per_page ids).
  const ids = (rows as any[]).map((r) => r.id)
  const placasPorCliente = new Map<number, string[]>()
  if (ids.length) {
    const vp = await Database.from('vehiculos')
      .whereIn('cliente_id', ids)
      .groupBy('cliente_id')
      .select('cliente_id')
      .select(Database.raw('GROUP_CONCAT(placa ORDER BY placa) as placas'))
    for (const r of vp) placasPorCliente.set(r.cliente_id, listaCsv(r.placas))
  }

  const data: FilaCola[] = (rows as any[]).map((r) => {
    const placas = placasPorCliente.get(r.id) ?? []
    return {
      clave: `C:${r.id}`,
      cliente_id: r.id,
      cliente_nombre: r.nombre ?? null,
      telefono: r.telefono || null,
      documento: r.doc_numero ? [r.doc_tipo, r.doc_numero].filter(Boolean).join(' ') : null,
      placa: placas[0] ?? '',
      placas,
      n_vehiculos: placas.length,
      ultima_visita: r.u_f_iso ?? null,
      fuente_ultima_visita: r.fuente ?? null,
      servicio_ultima_visita: null,
      meses_transcurridos: r.meses === null || r.meses === undefined ? null : Number(r.meses),
      rango: r.rango,
      vence_el: null,
      puede_datear_desde: null,
      dias_para_vencer: null,
    }
  })

  return { data, total, contadores }
}

/* ───────────────────────── Entrada ───────────────────────── */

export async function obtenerColaTelemercadeo(p: ParametrosCola): Promise<ResultadoCola> {
  const hoyISO = DateTime.now().setZone(ZONA).toISODate()!
  const rtmId = await servicioRtmId()

  // CLIENTES siempre se consulta (sus contadores van en la pestaña); su
  // página solo importa si es la lista pedida.
  const [pv, clientes] = await Promise.all([
    filasPorVencer(hoyISO, rtmId, p.q),
    paginaClientes(
      hoyISO,
      rtmId,
      p.lista === 'CLIENTES' ? p : { ...p, rango: null, page: 1, perPage: 1 }
    ),
  ])

  const contadoresPv = { total: pv.length } as Record<RangoPorVencer | 'total', number>
  for (const k of RANGOS_POR_VENCER) contadoresPv[k] = pv.filter((f) => f.rango === k).length

  let data: FilaCola[]
  let total: number
  if (p.lista === 'POR_VENCER') {
    const filtradas = p.rango ? pv.filter((f) => f.rango === p.rango) : pv
    total = filtradas.length
    const desde = (p.page - 1) * p.perPage
    data = filtradas.slice(desde, desde + p.perPage)
  } else {
    data = clientes.data
    total = clientes.total
  }

  return {
    data,
    meta: {
      total,
      current_page: p.page,
      per_page: p.perPage,
      last_page: Math.max(1, Math.ceil(total / p.perPage)),
      hoy: hoyISO,
      contadores: {
        POR_VENCER: contadoresPv,
        CLIENTES: clientes.contadores as Record<RangoClientes | 'total', number>,
      },
      parametros: {
        meses_vigencia_rtm: MESES_VIGENCIA_RTM,
        dias_ventana_previa: DIAS_VENTANA_PREVIA,
        dias_por_vencer: DIAS_POR_VENCER,
        dias_vencidas_recientes: DIAS_VENCIDAS_RECIENTES,
      },
    },
  }
}
