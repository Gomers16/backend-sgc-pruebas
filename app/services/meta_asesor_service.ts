// app/services/meta_asesor_service.ts
//
// Meta del mes de un asesor: sale SOLO de meta_comercial_asesor (asesor + mes
// + año), la que se configura en "Meta Comercial por Asesor". Sin fila no hay
// meta — no se usa comisiones.meta_rtm como respaldo (esa se captura como
// cantidad de RTM, no en pesos).

import Database from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

export interface MetaAsesorMes {
  metaPesos: number
  metaVehiculos: number | null
  fuente: 'meta_comercial'
}

export interface MetaAsesorPeriodo {
  /** Suma de los meses del periodo; null si algún mes no tiene fila. */
  metaPesos: number | null
  /** Suma de los meses; null si algún mes no tiene fila o no tiene meta_vehiculos. */
  metaVehiculos: number | null
  /** Todos los meses del periodo tienen fila. */
  completa: boolean
  mesesConMeta: number
  mesesTotales: number
}

/** Lista de {mes, anio} (orden cronológico) tocados por [fechaInicio, fechaFin]. */
export function mesesEnRango(
  fechaInicio: string,
  fechaFin: string
): { mes: number; anio: number }[] {
  const meses: { mes: number; anio: number }[] = []
  let cursor = DateTime.fromISO(fechaInicio).startOf('month')
  const finMes = DateTime.fromISO(fechaFin).startOf('month')
  while (cursor <= finMes) {
    meses.push({ mes: cursor.month, anio: cursor.year })
    cursor = cursor.plus({ months: 1 })
  }
  return meses
}

/**
 * Metas configuradas para el mes/año. Con asesorIds: solo esos asesores (los
 * que no tienen fila no aparecen en el Map). Con null: todos los asesores con
 * fila ese mes.
 */
export async function resolverMetasAsesores(
  asesorIds: number[] | null,
  mes: number,
  anio: number
): Promise<Map<number, MetaAsesorMes>> {
  const metas = new Map<number, MetaAsesorMes>()
  if (asesorIds !== null && asesorIds.length === 0) return metas

  const query = Database.from('meta_comercial_asesor').where({ mes, anio })
  if (asesorIds !== null) query.whereIn('asesor_id', asesorIds)
  const rows = (await query.select('asesor_id', 'meta_pesos', 'meta_vehiculos')) as {
    asesor_id: number
    meta_pesos: string
    meta_vehiculos: number | null
  }[]

  for (const r of rows) {
    metas.set(Number(r.asesor_id), {
      metaPesos: Number(r.meta_pesos),
      metaVehiculos: r.meta_vehiculos === null ? null : Number(r.meta_vehiculos),
      fuente: 'meta_comercial',
    })
  }
  return metas
}

/**
 * Meta de cada asesor para un rango de fechas: una fila de
 * meta_comercial_asesor por cada mes tocado. Nunca suma parcialmente: si a un
 * asesor le falta la fila de algún mes, metaPesos y metaVehiculos quedan en
 * null y completa=false. Solo aparecen en el Map los asesores con fila en al
 * menos un mes del rango (los demás no tienen meta).
 */
export async function resolverMetaAsesoresPeriodo(
  asesorIds: number[] | null,
  fechaInicio: string,
  fechaFin: string
): Promise<Map<number, MetaAsesorPeriodo>> {
  const meses = mesesEnRango(fechaInicio, fechaFin)
  const porMes = await Promise.all(
    meses.map(({ mes, anio }) => resolverMetasAsesores(asesorIds, mes, anio))
  )

  const ids = new Set<number>()
  for (const m of porMes) m.forEach((_v, id) => ids.add(id))

  const resultado = new Map<number, MetaAsesorPeriodo>()
  for (const id of ids) {
    const filas = porMes.map((m) => m.get(id) ?? null)
    const mesesConMeta = filas.filter((f) => f !== null).length
    const completa = mesesConMeta === meses.length
    const vehiculosCompletos = completa && filas.every((f) => f!.metaVehiculos !== null)
    resultado.set(id, {
      metaPesos: completa ? filas.reduce((acc, f) => acc + f!.metaPesos, 0) : null,
      metaVehiculos: vehiculosCompletos
        ? filas.reduce((acc, f) => acc + f!.metaVehiculos!, 0)
        : null,
      completa,
      mesesConMeta,
      mesesTotales: meses.length,
    })
  }
  return resultado
}
