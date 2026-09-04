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

/**
 * Variante de contarUnidadesRtmPorAsesor() con bucketing por día
 * (DATE(fecha_calculo)) en una sola query — usada por
 * ReportesAdministrativosController.calcularIngresoRtmGeneradoPorAsesorPorDia()
 * para metaComercialDiario()/metaComercialSemanal()/metaComercialProyectado()
 * (antes contaban facturacion_tickets por ft.created_at, mismo bug de
 * sobreconteo ya corregido en computeMetaComercialSuperInforme() — ver
 * MAPA_DEL_SISTEMA_BACKEND.md). `asesorIds` null/vacío → sin whereIn, agrega
 * TODOS los agente_id que aparezcan en el rango.
 */
export async function contarUnidadesRtmPorAsesorPorDia(opts: {
  fechaInicio: string
  fechaFin: string
  asesorIds?: number[] | null
}): Promise<Map<string, Map<number, ConteoRtmAsesor>>> {
  const baseQ = Database.from('comisiones')
    .where((q) => {
      q.where('es_config', false).orWhereNull('es_config')
    })
    .andWhere('tipo_servicio', 'RTM')
    .whereIn('estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
    .whereNotNull('asesor_id')
    .whereRaw('DATE(fecha_calculo) BETWEEN ? AND ?', [opts.fechaInicio, opts.fechaFin])

  if (opts.asesorIds && opts.asesorIds.length > 0) baseQ.whereIn('asesor_id', opts.asesorIds)

  const rows = (await baseQ
    .select(Database.raw("DATE_FORMAT(fecha_calculo, '%Y-%m-%d') as dia"))
    .select('asesor_id')
    .select(Database.raw("SUM(CASE WHEN tipo_vehiculo = 'MOTO' THEN 1 ELSE 0 END) AS rtm_motos"))
    .select(
      Database.raw(
        "SUM(CASE WHEN tipo_vehiculo = 'VEHICULO' OR tipo_vehiculo IS NULL THEN 1 ELSE 0 END) AS rtm_vehiculos"
      )
    )
    .groupBy('dia', 'asesor_id')) as {
    dia: string
    asesor_id: number
    rtm_motos: string | number
    rtm_vehiculos: string | number
  }[]

  const result = new Map<string, Map<number, ConteoRtmAsesor>>()
  for (const row of rows) {
    const id = Number(row.asesor_id)
    if (!Number.isFinite(id)) continue
    if (!result.has(row.dia)) result.set(row.dia, new Map())
    result.get(row.dia)!.set(id, {
      rtmMotos: Number(row.rtm_motos || 0),
      rtmVehiculos: Number(row.rtm_vehiculos || 0),
    })
  }
  return result
}

export type ConteoRtmAsesorConvenio = { directos: number; convenio: number }

/**
 * Igual que contarUnidadesRtmPorAsesor() pero desglosa por `convenio_id`
 * (NULL → venta directa del asesor, NOT NULL → venta a través de un
 * convenio) en vez de por tipo_vehiculo. Usada solo por
 * ReportesAdministrativosController.reporteAsesores() para reemplazar
 * vehiculos_directos/vehiculos_convenio (antes contados sobre
 * facturacion_tickets.convenio_nombre — mismo bug de sobreconteo que el ya
 * corregido en Meta Comercial, ver MAPA_DEL_SISTEMA_BACKEND.md).
 */
export async function contarUnidadesRtmPorAsesorConDesgloseConvenio(opts: {
  fechaInicio?: string | null
  fechaFin?: string | null
  asesorIds?: number[]
}): Promise<Map<number, ConteoRtmAsesorConvenio>> {
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
  if (opts.asesorIds && opts.asesorIds.length > 0) baseQ.whereIn('asesor_id', opts.asesorIds)

  const rows = (await baseQ
    .select('asesor_id')
    .select(Database.raw('SUM(CASE WHEN convenio_id IS NULL THEN 1 ELSE 0 END) AS directos'))
    .select(Database.raw('SUM(CASE WHEN convenio_id IS NOT NULL THEN 1 ELSE 0 END) AS convenio'))
    .groupBy('asesor_id')) as {
    asesor_id: number
    directos: string | number
    convenio: string | number
  }[]

  const result = new Map<number, ConteoRtmAsesorConvenio>()
  for (const row of rows) {
    const id = Number(row.asesor_id)
    if (!Number.isFinite(id)) continue
    result.set(id, {
      directos: Number(row.directos || 0),
      convenio: Number(row.convenio || 0),
    })
  }
  return result
}

/**
 * Unidades RTM logradas por convenio (comisiones.convenio_id → convenios),
 * SOLO para asesores tipo ASESOR_COMERCIAL — mismo universo que el bloque
 * `convenios` de ReportesAdministrativosController.reporteAsesores() (los
 * convenios captados vía ASESOR_CONVENIO ya están contados en el segmento
 * "Asesor Convenio", no se duplican acá).
 *
 * Se agrupa por `convenios.nombre` (no por id) porque
 * facturacion_tickets.convenio_nombre —la fuente de dinero real
 * (total_bruto/total_neto), intencionalmente sin tocar— es texto libre sin
 * FK a `convenios`; no hay otra columna en común para cruzar ambas fuentes.
 * Confirmado con datos reales que ese cruce por nombre es consistente
 * (141/142 casos en producción).
 *
 * Nota sobre cobertura: esto asume que toda comisión real tiene un ticket
 * de facturación de respaldo (aunque haya llegado después, vía comisión
 * manual — comisiones_controller.ts::store()) — confirmado con 0/64 casos
 * reales en contrario en la BD local al 2026-09-04. Esa garantía es "de
 * facto" (convención operativa del negocio), NO impuesta por el sistema:
 * store() no valida que exista un ticket CONFIRMADA antes de crear la
 * comisión. Si algún día se crea una comisión manual sin ticket asociado,
 * ese convenio no aparecerá en este reporte (el listado lo conduce la
 * query de facturación, no comisiones) — mismo límite ya aceptado del lado
 * de `contarUnidadesRtmPorAsesorConDesgloseConvenio()`.
 */
export async function contarUnidadesRtmPorConvenio(opts: {
  fechaInicio?: string | null
  fechaFin?: string | null
}): Promise<Map<string, number>> {
  const baseQ = Database.from('comisiones as c')
    .join('convenios as conv', 'conv.id', 'c.convenio_id')
    .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
    .where((q) => {
      q.where('c.es_config', false).orWhereNull('c.es_config')
    })
    .andWhere('c.tipo_servicio', 'RTM')
    .whereIn('c.estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
    .where('a.tipo', 'ASESOR_COMERCIAL')

  if (opts.fechaInicio && opts.fechaFin) {
    baseQ.whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [opts.fechaInicio, opts.fechaFin])
  }

  const rows = (await baseQ
    .select('conv.nombre as convenio_nombre')
    .count('* as total_vehiculos')
    .groupBy('conv.nombre')) as { convenio_nombre: string; total_vehiculos: string | number }[]

  const result = new Map<string, number>()
  for (const row of rows) {
    result.set(row.convenio_nombre, Number(row.total_vehiculos || 0))
  }
  return result
}
