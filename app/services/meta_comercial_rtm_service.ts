// app/services/meta_comercial_rtm_service.ts
import Database from '@adonisjs/lucid/services/db'

export type ConteoRtmAsesor = { rtmMotos: number; rtmVehiculos: number }

/**
 * Conteo de unidades RTM logradas por asesor, contando FILAS de `comisiones`
 * (1 fila = 1 unidad). Única fuente de verdad compartida por
 * ComisionesController.metasMensuales() (Ficha Comercial → modal "Metas
 * mensuales RTM", validada contra los Excel oficiales de la empresa) y
 * ReportesAdministrativosController.computeMetaComercialSuperInforme()
 * (Súper Informe → sección "Meta Comercial por Asesor"). No usar
 * facturacion_tickets para esto — ver diagnóstico en
 * MAPA_DEL_SISTEMA_BACKEND.md y el comentario en
 * computeMetaComercialSuperInforme().
 */
export async function contarUnidadesRtmPorAsesor(opts: {
  /** 'YYYY-MM-DD'. Filtra por DATE(fecha_calculo). Requiere ambos o ninguno. */
  fechaInicio?: string | null
  fechaFin?: string | null
  /** Un solo asesor (uso de Ficha Comercial). */
  asesorId?: number
  /** Universo de asesores permitidos (uso de Súper Informe). */
  asesorIds?: number[]
}): Promise<Map<number, ConteoRtmAsesor>> {
  const baseQ = Database.from('comisiones')
    .where((q) => {
      q.where('es_config', false).orWhereNull('es_config')
    })
    .andWhere('tipo_servicio', 'RTM')
    .whereIn('estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
    .whereNotNull('asesor_id')

  if (opts.fechaInicio && opts.fechaFin) {
    baseQ.whereRaw('DATE(fecha_calculo) BETWEEN ? AND ?', [opts.fechaInicio, opts.fechaFin])
  }
  if (opts.asesorId) baseQ.andWhere('asesor_id', opts.asesorId)
  if (opts.asesorIds && opts.asesorIds.length > 0) baseQ.whereIn('asesor_id', opts.asesorIds)

  const rows = (await baseQ
    .select('asesor_id')
    .select(Database.raw("SUM(CASE WHEN tipo_vehiculo = 'MOTO' THEN 1 ELSE 0 END) AS rtm_motos"))
    .select(
      Database.raw(
        "SUM(CASE WHEN tipo_vehiculo = 'VEHICULO' OR tipo_vehiculo IS NULL THEN 1 ELSE 0 END) AS rtm_vehiculos"
      )
    )
    .groupBy('asesor_id')) as {
    asesor_id: number
    rtm_motos: string | number
    rtm_vehiculos: string | number
  }[]

  const result = new Map<number, ConteoRtmAsesor>()
  for (const row of rows) {
    const id = Number(row.asesor_id)
    if (!Number.isFinite(id)) continue
    result.set(id, {
      rtmMotos: Number(row.rtm_motos || 0),
      rtmVehiculos: Number(row.rtm_vehiculos || 0),
    })
  }
  return result
}
