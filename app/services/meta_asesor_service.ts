// app/services/meta_asesor_service.ts
//
// Meta del mes de un asesor: sale SOLO de meta_comercial_asesor (asesor + mes
// + año), la que se configura en "Meta Comercial por Asesor". Sin fila no hay
// meta — no se usa comisiones.meta_rtm como respaldo (esa se captura como
// cantidad de RTM, no en pesos).

import Database from '@adonisjs/lucid/services/db'

export interface MetaAsesorMes {
  metaPesos: number
  metaVehiculos: number | null
  fuente: 'meta_comercial'
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
