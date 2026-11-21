// app/services/telemercadeo_resumen_service.ts
//
// Métricas de Telemercadeo (gestiones, embudo, procedencia) y metas por
// asesor. Solo lectura salvo guardar/copiar metas. No toca comisiones.
//
// Definición única de las métricas (cohorte por fecha de la gestión, en
// America/Bogota): de las gestiones registradas en el periodo,
//  - dateos   = las que tienen dateo vinculado (captacion_dateo_id);
//  - exitosos = las que tienen dateo con resultado EXITOSO;
//  - turnos   = las que tienen dateo consumido por un turno.
// Así el embudo, la tabla por asesor y el avance de meta cuadran entre sí.
//
// Meta del periodo = suma de las metas de cada mes tocado; si a algún mes le
// falta la meta de esa métrica, la meta queda en null (sin semáforo, nunca 0%).
// Semáforo por ritmo: el avance se compara contra la meta prorrateada a los
// días transcurridos del periodo (un mes en curso no aparece en rojo el día 3).

import { aplicarSede } from '#services/sede_scope'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import { mesesEnRango } from '#services/meta_asesor_service'
import { calcularPct, calcularSemaforo, type SemaforoColor } from '#services/semaforo_service'
import { TIPO_AGENTE_TELE, ZONA_TELE } from '#services/telemercadeo_gestion_service'

export const METRICAS_META = ['gestiones', 'dateos', 'exitosos'] as const
export type MetricaMeta = (typeof METRICAS_META)[number]

/* ───────────────────────── Fechas ───────────────────────── */

export interface Rango {
  desde: string
  hasta: string
  /** [inicio, fin) en hora de Bogotá (la conexión guarda hora de Bogotá). */
  inicioSql: string
  finSql: string
}

export function parseRango(desdeRaw: unknown, hastaRaw: unknown): Rango | { error: string } {
  const hoy = DateTime.now().setZone(ZONA_TELE)
  const desde = desdeRaw
    ? DateTime.fromISO(String(desdeRaw).substring(0, 10), { zone: ZONA_TELE })
    : hoy.startOf('month')
  const hasta = hastaRaw
    ? DateTime.fromISO(String(hastaRaw).substring(0, 10), { zone: ZONA_TELE })
    : hoy
  if (!desde.isValid || !hasta.isValid) return { error: 'desde/hasta deben ser AAAA-MM-DD' }
  if (hasta < desde) return { error: 'hasta no puede ser anterior a desde' }
  if (hasta.diff(desde, 'days').days > 731) return { error: 'El rango máximo es de 2 años' }
  return {
    desde: desde.toISODate()!,
    hasta: hasta.toISODate()!,
    inicioSql: `${desde.toISODate()} 00:00:00`,
    finSql: `${hasta.plus({ days: 1 }).toISODate()} 00:00:00`,
  }
}

export function rangoDeMes(mes: number, anio: number): Rango {
  const d = DateTime.fromObject({ year: anio, month: mes, day: 1 }, { zone: ZONA_TELE })
  return parseRango(d.toISODate(), d.endOf('month').toISODate()) as Rango
}

/**
 * Fracción del periodo ya transcurrida (mínimo 1 día). 1 si terminó o si aún
 * no empieza (sin ritmo que prorratear: se compara contra la meta completa).
 */
export function fraccionTranscurrida(r: Rango, ahora: DateTime = DateTime.now()): number {
  const hoy = ahora.setZone(ZONA_TELE).startOf('day')
  const ini = DateTime.fromISO(r.desde, { zone: ZONA_TELE })
  const fin = DateTime.fromISO(r.hasta, { zone: ZONA_TELE })
  const total = fin.diff(ini, 'days').days + 1
  if (hoy >= fin || hoy < ini) return 1
  const transcurridos = Math.max(1, hoy.diff(ini, 'days').days + 1)
  return Math.min(1, transcurridos / total)
}

/* ───────────────────────── Semáforo de meta ───────────────────────── */

export interface AvanceMeta {
  meta: number | null
  avance: number
  faltante: number | null
  pct: number | null
  /** % contra la meta prorrateada a hoy; decide el semáforo. */
  pct_ritmo: number | null
  semaforo: SemaforoColor
}

export function avanceMeta(avance: number, meta: number | null, fraccion: number): AvanceMeta {
  if (meta === null || meta <= 0) {
    return { meta, avance, faltante: null, pct: null, pct_ritmo: null, semaforo: 'SIN_META' }
  }
  const pct = calcularPct(avance, meta)
  const pctRitmo = fraccion < 1 ? calcularPct(avance, meta * fraccion) : pct
  return {
    meta,
    avance,
    faltante: Math.max(0, meta - avance),
    pct,
    pct_ritmo: pctRitmo,
    semaforo: calcularSemaforo(pctRitmo),
  }
}

/* ───────────────────────── Agregados ───────────────────────── */

interface Conteos {
  gestiones: number
  dateos: number
  exitosos: number
  turnos: number
}

const SUMAS = `COUNT(*) AS gestiones,
  SUM(g.captacion_dateo_id IS NOT NULL) AS dateos,
  SUM(d.resultado = 'EXITOSO') AS exitosos,
  SUM(d.consumido_turno_id IS NOT NULL) AS turnos`

const aConteos = (r: any): Conteos => ({
  gestiones: Number(r?.gestiones ?? 0),
  dateos: Number(r?.dateos ?? 0),
  exitosos: Number(r?.exitosos ?? 0),
  turnos: Number(r?.turnos ?? 0),
})

function base(r: Rango, agenteId: number | null) {
  // sede: aplicarSede en el return
  const q = Database.from('telemercadeo_gestiones as g')
    .leftJoin('captacion_dateos as d', 'd.id', 'g.captacion_dateo_id')
    .where('g.created_at', '>=', r.inicioSql)
    .where('g.created_at', '<', r.finSql)
  if (agenteId !== null) q.where('g.agente_id', agenteId)
  // Multi-sede: solo gestiones de la sede activa.
  return aplicarSede(q, 'g.sede_id')
}

const tasa = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)

export function embudo(c: Conteos) {
  return {
    ...c,
    tasa_dateo: tasa(c.dateos, c.gestiones),
    tasa_exito_sobre_dateos: tasa(c.exitosos, c.dateos),
    tasa_exito_sobre_gestiones: tasa(c.exitosos, c.gestiones),
    tasa_turno_sobre_gestiones: tasa(c.turnos, c.gestiones),
  }
}

/** Metas del periodo por asesor y métrica (null si falta algún mes). */
async function metasPeriodo(asesorIds: number[], r: Rango) {
  const meses = mesesEnRango(r.desde, r.hasta)
  const res = new Map<number, Record<MetricaMeta, number | null>>()
  if (!asesorIds.length) return res
  const filas = await Database.from('meta_telemercadeo_asesor') // sede: metas de asesores ya resueltos en la sede
    .whereIn('asesor_id', asesorIds)
    .where((q) => {
      for (const { mes, anio } of meses) q.orWhere((w) => w.where({ mes, anio }))
    })
    .select('asesor_id', 'mes', 'anio', 'meta_gestiones', 'meta_dateos', 'meta_exitosos')
  for (const id of asesorIds) {
    const delAsesor = filas.filter((f: any) => Number(f.asesor_id) === id)
    const suma = (col: string): number | null => {
      if (delAsesor.length !== meses.length) return null
      if (delAsesor.some((f: any) => f[col] === null || f[col] === undefined)) return null
      return delAsesor.reduce((acc: number, f: any) => acc + Number(f[col]), 0)
    }
    res.set(id, {
      gestiones: suma('meta_gestiones'),
      dateos: suma('meta_dateos'),
      exitosos: suma('meta_exitosos'),
    })
  }
  return res
}

function metasDeAsesor(
  c: Conteos,
  metas: Record<MetricaMeta, number | null> | undefined,
  fraccion: number
): Record<MetricaMeta, AvanceMeta> {
  return {
    gestiones: avanceMeta(c.gestiones, metas?.gestiones ?? null, fraccion),
    dateos: avanceMeta(c.dateos, metas?.dateos ?? null, fraccion),
    exitosos: avanceMeta(c.exitosos, metas?.exitosos ?? null, fraccion),
  }
}

/** Resumen general o de un asesor. */
export async function resumenTelemercadeo(r: Rango, agenteId: number | null) {
  const [tot] = await base(r, agenteId).select(Database.raw(SUMAS))

  const porMedio = await base(r, agenteId)
    .groupBy('g.medio')
    .select('g.medio')
    .select(Database.raw(SUMAS))
  const porResultado = await base(r, agenteId)
    .groupBy('g.resultado')
    .select('g.resultado')
    .count('* as gestiones')
  const porOrigen = await base(r, agenteId)
    .groupBy('g.origen_id')
    .select('g.origen_id')
    .select(Database.raw(SUMAS))
  const origenes = await Database.from('telemercadeo_origenes')
    .orderBy('orden')
    .select('id', 'codigo', 'nombre')

  const porAgente = await base(r, agenteId)
    .groupBy('g.agente_id')
    .select('g.agente_id')
    .select(Database.raw(SUMAS))
  const conteoPorAgente = new Map<number, Conteos>(
    porAgente.map((x: any) => [Number(x.agente_id), aConteos(x)])
  )

  // sede: aplicarSede(agentesQ) antes de ejecutar (abajo)
  const agentesQ = Database.from('agentes_captacions')
    .where((q) => {
      q.where('tipo', TIPO_AGENTE_TELE)
      if (conteoPorAgente.size) q.orWhereIn('id', [...conteoPorAgente.keys()])
    })
    .select('id', 'nombre', 'activo')
    .orderBy('nombre')
  if (agenteId !== null) agentesQ.where('id', agenteId)
  // Multi-sede: asesores de la sede activa (al final: agrupa el OR de arriba).
  aplicarSede(agentesQ, 'agentes_captacions.sede_id')
  const agentes = await agentesQ

  const fraccion = fraccionTranscurrida(r)
  const metas = await metasPeriodo(
    agentes.map((a: any) => Number(a.id)),
    r
  )

  const porAsesor = agentes.map((a: any) => {
    const c = conteoPorAgente.get(Number(a.id)) ?? aConteos(null)
    const m = metasDeAsesor(c, metas.get(Number(a.id)), fraccion)
    return {
      agente_id: Number(a.id),
      nombre: a.nombre,
      activo: Boolean(a.activo),
      ...embudo(c),
      metas: m,
      semaforo: m.exitosos.semaforo,
    }
  })

  return {
    rango: { desde: r.desde, hasta: r.hasta, fraccion_transcurrida: fraccion },
    totales: embudo(aConteos(tot)),
    por_medio: porMedio.map((x: any) => ({ medio: x.medio, ...embudo(aConteos(x)) })),
    por_resultado: porResultado.map((x: any) => ({
      resultado: x.resultado,
      gestiones: Number(x.gestiones),
    })),
    por_origen: origenes.map((o: any) => {
      const x = porOrigen.find((p: any) => Number(p.origen_id) === Number(o.id))
      return { origen_id: Number(o.id), codigo: o.codigo, nombre: o.nombre, ...embudo(aConteos(x)) }
    }),
    por_asesor: porAsesor,
  }
}

/** Meta del mes del propio asesor ("Mi gestión"). */
export async function miResumen(agenteId: number, mes: number, anio: number) {
  const r = rangoDeMes(mes, anio)
  const [tot] = await base(r, agenteId).select(Database.raw(SUMAS))
  const c = aConteos(tot)
  const metas = await metasPeriodo([agenteId], r)
  const fraccion = fraccionTranscurrida(r)
  const m = metasDeAsesor(c, metas.get(agenteId), fraccion)

  const hoy = DateTime.now().setZone(ZONA_TELE)
  const [h] = await base(rangoDeMes(hoy.month, hoy.year), agenteId)
    .where('g.created_at', '>=', `${hoy.toISODate()} 00:00:00`)
    .count('* as n')

  return {
    mes,
    anio,
    fraccion_transcurrida: fraccion,
    gestiones_hoy: Number(h?.n ?? 0),
    ...embudo(c),
    metas: m,
    semaforo: m.exitosos.semaforo,
  }
}

/* ───────────────────────── Metas ───────────────────────── */

const metaNum = (v: unknown): number | null | 'invalido' => {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n >= 0 && n <= 1_000_000 ? n : 'invalido'
}

export async function listarMetas(mes: number, anio: number) {
  const agentes = await Database.from('agentes_captacions')
    .where((q) => aplicarSede(q, 'agentes_captacions.sede_id'))
    .where('tipo', TIPO_AGENTE_TELE)
    .select('id', 'nombre', 'activo')
    .orderBy('nombre')
  // sede: metas de los asesores listados arriba (de la sede activa)
  const filas = await Database.from('meta_telemercadeo_asesor').where({ mes, anio })
  return agentes.map((a: any) => {
    const f = filas.find((x: any) => Number(x.asesor_id) === Number(a.id))
    return {
      asesor_id: Number(a.id),
      nombre: a.nombre,
      activo: Boolean(a.activo),
      meta_gestiones: f?.meta_gestiones ?? null,
      meta_dateos: f?.meta_dateos ?? null,
      meta_exitosos: f?.meta_exitosos ?? null,
    }
  })
}

/**
 * Upsert por lote. Fila con las tres metas en null = se borra (sin meta).
 * Solo agentes ASESOR_TELEMERCADEO.
 */
export async function guardarMetas(mes: number, anio: number, filasRaw: unknown) {
  if (!Array.isArray(filasRaw) || !filasRaw.length) {
    return { error: 'metas debe ser una lista con al menos una fila' }
  }
  const filas: Array<{ asesorId: number } & Record<'g' | 'd' | 'e', number | null>> = []
  for (const f of filasRaw as any[]) {
    const asesorId = Number(f?.asesor_id)
    const g = metaNum(f?.meta_gestiones)
    const d = metaNum(f?.meta_dateos)
    const e = metaNum(f?.meta_exitosos)
    if (!Number.isInteger(asesorId) || g === 'invalido' || d === 'invalido' || e === 'invalido') {
      return { error: 'Cada meta debe ser un entero >= 0 o vacía' }
    }
    filas.push({ asesorId, g, d, e })
  }
  const ids = [...new Set(filas.map((f) => f.asesorId))]
  // Multi-sede: solo asesores de la sede activa (uno de otra sede → error).
  const validos = await Database.from('agentes_captacions')
    .where((q) => aplicarSede(q, 'agentes_captacions.sede_id'))
    .whereIn('id', ids)
    .where('tipo', TIPO_AGENTE_TELE)
    .select('id')
  if (validos.length !== ids.length) {
    return { error: 'Todas las metas deben ser de asesores de Telemercadeo' }
  }

  await Database.transaction(async (trx) => {
    for (const f of filas) {
      if (f.g === null && f.d === null && f.e === null) {
        await trx // sede: asesores validados con aplicarSede arriba
          .from('meta_telemercadeo_asesor')
          .where({ asesor_id: f.asesorId, mes, anio })
          .delete()
        continue
      }
      await trx.rawQuery(
        `INSERT INTO meta_telemercadeo_asesor
           (asesor_id, mes, anio, meta_gestiones, meta_dateos, meta_exitosos, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           meta_gestiones = VALUES(meta_gestiones),
           meta_dateos = VALUES(meta_dateos),
           meta_exitosos = VALUES(meta_exitosos),
           updated_at = NOW()`,
        [f.asesorId, mes, anio, f.g, f.d, f.e] as any[]
      )
    }
  })
  return { ok: true as const, data: await listarMetas(mes, anio) }
}

/** Copia las metas de un mes a otro. Sin sobrescribir, respeta las que ya existen. */
export async function copiarMetas(
  desde: { mes: number; anio: number },
  hacia: { mes: number; anio: number },
  sobrescribir: boolean
) {
  if (desde.mes === hacia.mes && desde.anio === hacia.anio) {
    return { error: 'El mes de origen y el de destino son el mismo' }
  }
  // Multi-sede: copia solo las metas de los asesores de la sede activa.
  const origen = await Database.from('meta_telemercadeo_asesor')
    .join('agentes_captacions as a', 'a.id', 'meta_telemercadeo_asesor.asesor_id')
    .where((q) => aplicarSede(q, 'a.sede_id'))
    .where('a.tipo', TIPO_AGENTE_TELE)
    .where({ mes: desde.mes, anio: desde.anio })
    .select('meta_telemercadeo_asesor.*')
  const existentes = new Set(
    // sede: solo importa contra las de origen (de la sede activa)
    (
      await Database.from('meta_telemercadeo_asesor')
        .where({ mes: hacia.mes, anio: hacia.anio })
        .select('asesor_id')
    ).map((x: any) => Number(x.asesor_id))
  )
  let copiadas = 0
  let omitidas = 0
  await Database.transaction(async (trx) => {
    for (const f of origen as any[]) {
      if (existentes.has(Number(f.asesor_id)) && !sobrescribir) {
        omitidas++
        continue
      }
      await trx.rawQuery(
        `INSERT INTO meta_telemercadeo_asesor
           (asesor_id, mes, anio, meta_gestiones, meta_dateos, meta_exitosos, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())
         ON DUPLICATE KEY UPDATE
           meta_gestiones = VALUES(meta_gestiones),
           meta_dateos = VALUES(meta_dateos),
           meta_exitosos = VALUES(meta_exitosos),
           updated_at = NOW()`,
        [f.asesor_id, hacia.mes, hacia.anio, f.meta_gestiones, f.meta_dateos, f.meta_exitosos]
      )
      copiadas++
    }
  })
  return { ok: true as const, copiadas, omitidas, data: await listarMetas(hacia.mes, hacia.anio) }
}
