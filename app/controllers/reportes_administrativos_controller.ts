// app/controllers/reportes_administrativos_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Database from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'

/**
 * `facturacion_tickets` no tiene columna `fecha`; el filtro de rango se
 * aplica sobre DATE(created_at), que es el campo siempre poblado.
 */
function parseRangoFechas(request: HttpContext['request']): {
  fechaInicio: string
  fechaFin: string
  error?: string
} {
  const fechaInicio = request.input('fecha_inicio') as string | undefined
  const fechaFin = request.input('fecha_fin') as string | undefined

  if (!fechaInicio || !fechaFin) {
    return {
      fechaInicio: '',
      fechaFin: '',
      error: 'fecha_inicio y fecha_fin son requeridos (formato YYYY-MM-DD)',
    }
  }

  const di = DateTime.fromISO(fechaInicio)
  const df = DateTime.fromISO(fechaFin)
  if (!di.isValid || !df.isValid) {
    return { fechaInicio: '', fechaFin: '', error: 'fecha_inicio o fecha_fin inválida' }
  }
  if (di > df) {
    return { fechaInicio: '', fechaFin: '', error: 'fecha_inicio no puede ser mayor que fecha_fin' }
  }

  return { fechaInicio, fechaFin }
}

export default class ReportesAdministrativosController {
  /**
   * GET /reportes-admin/ingresos-canal?fecha_inicio=&fecha_fin=
   * Ingresos por canal de captación (facturacion_tickets, estado CONFIRMADA).
   */
  public async ingresosPorCanal({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const rows = (await Database.from('facturacion_tickets')
      .where('estado', 'CONFIRMADA')
      .whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select(Database.raw("COALESCE(captacion_canal, 'FACHADA') as captacion_canal"))
      .count('* as cantidad')
      .sum('total as total_bruto')
      .sum('subtotal as total_neto')
      .avg('total as promedio_ticket')
      .groupByRaw("COALESCE(captacion_canal, 'FACHADA')")
      .orderBy('total_bruto', 'desc')) as any[]

    const porCanal = rows.map((r) => ({
      canal: r.captacion_canal,
      cantidad: Number(r.cantidad),
      total_bruto: Number(r.total_bruto) || 0,
      total_neto: Number(r.total_neto) || 0,
      promedio_ticket: Number(r.promedio_ticket) || 0,
    }))

    const totales = porCanal.reduce(
      (acc, r) => ({
        cantidad: acc.cantidad + r.cantidad,
        total_bruto: acc.total_bruto + r.total_bruto,
        total_neto: acc.total_neto + r.total_neto,
      }),
      { cantidad: 0, total_bruto: 0, total_neto: 0 }
    )

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_canal: porCanal,
      totales: {
        canal: 'TOTAL',
        cantidad: totales.cantidad,
        total_bruto: totales.total_bruto,
        total_neto: totales.total_neto,
        promedio_ticket: totales.cantidad
          ? Math.round((totales.total_bruto / totales.cantidad) * 100) / 100
          : 0,
      },
    }
  }

  /**
   * GET /reportes-admin/produccion-lider?fecha_inicio=&fecha_fin=
   * Producción por sede + líder de sede (usuarios.cargo.nombre = 'LIDER DE SEDE').
   */
  public async produccionPorLider({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const rows = (await Database.from('facturacion_tickets')
      .where('estado', 'CONFIRMADA')
      .whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('sede_id', 'sede_nombre')
      .count('* as vehiculos')
      .sum('total as total_bruto')
      .sum('subtotal as total_neto')
      .groupBy('sede_id', 'sede_nombre')
      .orderBy('total_bruto', 'desc')) as any[]

    const sedeIds = [...new Set(rows.map((r) => r.sede_id).filter((v) => v !== null))] as number[]

    const lideres = sedeIds.length
      ? await Usuario.query()
          .whereHas('cargo', (q) => q.where('nombre', 'LIDER DE SEDE'))
          .whereIn('sede_id', sedeIds)
          .where('estado', 'activo')
      : []

    const liderPorSede = new Map<number, string>()
    for (const u of lideres) {
      if (u.sedeId && !liderPorSede.has(u.sedeId)) {
        liderPorSede.set(u.sedeId, `${u.nombres} ${u.apellidos}`)
      }
    }

    const porSede = rows.map((r) => ({
      sede_nombre: r.sede_nombre,
      lider_nombre: r.sede_id
        ? (liderPorSede.get(Number(r.sede_id)) ?? 'Sin líder asignado')
        : 'Sin líder asignado',
      vehiculos: Number(r.vehiculos),
      total_bruto: Number(r.total_bruto) || 0,
      total_neto: Number(r.total_neto) || 0,
    }))

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_sede: porSede,
    }
  }

  /**
   * GET /reportes-admin/asesores?fecha_inicio=&fecha_fin=
   * Producción por asesor (comercial o convenio).
   * nombre = COALESCE(agente_comercial_nombre, asesor_convenio_nombre):
   * en facturacion_tickets, agente_comercial_nombre solo se llena para
   * canal ASESOR_COMERCIAL; para ASESOR_CONVENIO el nombre vive en
   * asesor_convenio_nombre.
   */
  public async reporteAsesores({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const rows = (await Database.from('facturacion_tickets')
      .whereIn('captacion_canal', ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'])
      .where('estado', 'CONFIRMADA')
      .whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .whereNotNull('agente_id')
      .select('agente_id', 'captacion_canal')
      .select(
        Database.raw(
          'COALESCE(MAX(agente_comercial_nombre), MAX(asesor_convenio_nombre)) as nombre'
        )
      )
      .select(
        Database.raw(
          'SUM(CASE WHEN convenio_nombre IS NULL THEN 1 ELSE 0 END) as vehiculos_directos'
        )
      )
      .select(
        Database.raw(
          'SUM(CASE WHEN convenio_nombre IS NOT NULL THEN 1 ELSE 0 END) as vehiculos_convenio'
        )
      )
      .count('* as total_vehiculos')
      .sum('total as total_bruto')
      .sum('subtotal as total_neto')
      .groupBy('agente_id', 'captacion_canal')
      .orderBy('total_vehiculos', 'desc')) as any[]

    const asesores = rows.map((r) => ({
      agente_id: Number(r.agente_id),
      nombre: r.nombre,
      canal: r.captacion_canal,
      vehiculos_directos: Number(r.vehiculos_directos) || 0,
      vehiculos_convenio: Number(r.vehiculos_convenio) || 0,
      total_vehiculos: Number(r.total_vehiculos),
      total_bruto: Number(r.total_bruto) || 0,
      total_neto: Number(r.total_neto) || 0,
    }))

    // ===== Convenio (solo tickets captados por ASESOR_COMERCIAL — los de
    // ASESOR_CONVENIO ya están en el segmento "Asesor Convenio", no se duplican) =====
    const convenioRows = (await Database.from('facturacion_tickets')
      .where('estado', 'CONFIRMADA')
      .whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .where('captacion_canal', 'ASESOR_COMERCIAL')
      .whereNotNull('convenio_nombre')
      .select('convenio_nombre')
      .select(
        Database.raw(
          "GROUP_CONCAT(DISTINCT agente_comercial_nombre ORDER BY agente_comercial_nombre SEPARATOR ', ') as asesores"
        )
      )
      .count('* as total_vehiculos')
      .sum('total as total_bruto')
      .sum('subtotal as total_neto')
      .groupBy('convenio_nombre')
      .orderBy('total_bruto', 'desc')) as any[]

    const convenios = convenioRows.map((r) => ({
      convenio_nombre: r.convenio_nombre,
      asesores: r.asesores ?? '',
      total_vehiculos: Number(r.total_vehiculos),
      total_bruto: Number(r.total_bruto) || 0,
      total_neto: Number(r.total_neto) || 0,
    }))

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      asesores,
      convenios,
    }
  }

  /**
   * GET /reportes-admin/detalle-asesor?fecha_inicio=&fecha_fin=&agente_id=&canal=
   * Placas facturadas por un asesor/canal puntual (drill-down de /asesores).
   */
  public async detallePorAsesor({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const agenteId = request.input('agente_id') as string | number | undefined
    const canal = request.input('canal') as string | undefined

    if (!agenteId || !canal) {
      return response.badRequest({ message: 'agente_id y canal son requeridos' })
    }

    const rows = (await Database.from('facturacion_tickets as ft')
      .leftJoin('turnos_rtms as t', 't.id', 'ft.turno_id')
      .leftJoin('clientes as c', 'c.id', 't.cliente_id')
      .where('ft.estado', 'CONFIRMADA')
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .where('ft.agente_id', agenteId)
      .where('ft.captacion_canal', canal)
      .select(
        'ft.placa',
        'ft.captacion_canal',
        'ft.agente_comercial_nombre',
        'ft.asesor_convenio_nombre',
        'ft.convenio_nombre',
        'ft.total',
        'ft.subtotal',
        Database.raw('DATE(ft.created_at) as fecha'),
        'ft.tipo_vehiculo',
        'ft.servicio_codigo',
        // Cliente — NULL si aún no se subió el RepGeneral (turno sin cliente_id o cliente sin nombre)
        'c.nombre as cliente_nombre',
        'c.doc_numero as cliente_documento'
      )
      .orderBy('ft.created_at', 'desc')) as any[]

    const agente = await AgenteCaptacion.find(Number(agenteId))
    const nombreDeTicket = rows[0]?.agente_comercial_nombre ?? rows[0]?.asesor_convenio_nombre ?? null
    const nombre = agente?.nombre ?? nombreDeTicket ?? '—'

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      total: Number(r.total) || 0,
      subtotal: Number(r.subtotal) || 0,
      tipo_vehiculo: r.tipo_vehiculo,
      convenio_nombre: r.convenio_nombre ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totalBruto = detalle.reduce((acc, d) => acc + d.total, 0)

    return {
      agente_id: Number(agenteId),
      nombre,
      canal,
      total_vehiculos: detalle.length,
      total_bruto: totalBruto,
      detalle,
    }
  }

  /**
   * GET /reportes-admin/detalle-canal?fecha_inicio=&fecha_fin=&canal=
   * Placas facturadas de un canal puntual (drill-down de /ingresos-canal).
   */
  public async detallePorCanal({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const canal = request.input('canal') as string | undefined
    if (!canal) return response.badRequest({ message: 'canal es requerido' })

    const rows = (await Database.from('facturacion_tickets as ft')
      .leftJoin('turnos_rtms as t', 't.id', 'ft.turno_id')
      .leftJoin('clientes as c', 'c.id', 't.cliente_id')
      .where('ft.estado', 'CONFIRMADA')
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .where((q) => {
        if (canal === 'FACHADA') {
          q.where('ft.captacion_canal', 'FACHADA').orWhereNull('ft.captacion_canal')
        } else {
          q.where('ft.captacion_canal', canal)
        }
      })
      .select(
        'ft.placa',
        'ft.captacion_canal',
        'ft.agente_comercial_nombre',
        'ft.asesor_convenio_nombre',
        'ft.convenio_nombre',
        'ft.total',
        'ft.subtotal',
        Database.raw('DATE(ft.created_at) as fecha'),
        'ft.tipo_vehiculo',
        // Cliente — NULL si aún no se subió el RepGeneral (turno sin cliente_id o cliente sin nombre)
        'c.nombre as cliente_nombre',
        'c.doc_numero as cliente_documento'
      )
      .orderBy('ft.created_at', 'desc')) as any[]

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      total: Number(r.total) || 0,
      subtotal: Number(r.subtotal) || 0,
      agente_comercial_nombre: r.agente_comercial_nombre ?? null,
      asesor_convenio_nombre: r.asesor_convenio_nombre ?? null,
      convenio_nombre: r.convenio_nombre ?? null,
      tipo_vehiculo: r.tipo_vehiculo,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totalBruto = detalle.reduce((acc, d) => acc + d.total, 0)

    return {
      canal,
      total_vehiculos: detalle.length,
      total_bruto: totalBruto,
      detalle,
    }
  }

  /**
   * GET /reportes-admin/retencion?fecha_inicio=&fecha_fin=
   * Clasifica los turnos facturados (CONFIRMADA) del rango en NUEVO / RECURRENTE /
   * RECUPERACION según las columnas de retención de turnos_rtms:
   *   - NUEVO: meses_desde_ultima_visita IS NULL
   *   - RECURRENTE: es_recurrente = 1
   *   - RECUPERACION: es_recuperacion = 1
   * El filtro de rango se aplica sobre turnos_rtms.fecha (fecha real del turno).
   */
  public async retencionClientes({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const configRecurrencia = await Database.from('configuracion_recurrencia_global')
      .select('meses_minimos')
      .first()
    const mesesMinimos = configRecurrencia ? Number(configRecurrencia.meses_minimos) : 24

    const CLASIFICACION_SQL = `
      CASE
        WHEN t.meses_desde_ultima_visita IS NULL THEN 'NUEVO'
        WHEN t.es_recurrente = 1 THEN 'RECURRENTE'
        WHEN t.es_recuperacion = 1 THEN 'RECUPERACION'
        ELSE 'NUEVO'
      END
    `

    const baseQuery = () =>
      Database.from('turnos_rtms as t')
        .innerJoin('facturacion_tickets as ft', 'ft.turno_id', 't.id')
        .where('ft.estado', 'CONFIRMADA')
        .whereBetween('t.fecha', [fechaInicio, fechaFin])

    // ----- Resumen general (NUEVO / RECURRENTE / RECUPERACION) -----
    const resumenRows = (await baseQuery()
      .select(Database.raw(`${CLASIFICACION_SQL} as categoria`))
      .count('* as cantidad')
      .sum('ft.total as total_bruto')
      .groupByRaw(CLASIFICACION_SQL)) as any[]

    const resumenBase = { NUEVO: 0, RECURRENTE: 0, RECUPERACION: 0 }
    const cantidadPorCategoria = { ...resumenBase }
    const brutoPorCategoria = { ...resumenBase }
    for (const r of resumenRows) {
      const categoria = r.categoria as 'NUEVO' | 'RECURRENTE' | 'RECUPERACION'
      cantidadPorCategoria[categoria] = Number(r.cantidad)
      brutoPorCategoria[categoria] = Number(r.total_bruto) || 0
    }

    const totalCantidad =
      cantidadPorCategoria.NUEVO + cantidadPorCategoria.RECURRENTE + cantidadPorCategoria.RECUPERACION
    const totalBruto =
      brutoPorCategoria.NUEVO + brutoPorCategoria.RECURRENTE + brutoPorCategoria.RECUPERACION

    const porcentaje = (cantidad: number) =>
      totalCantidad ? Math.round((cantidad / totalCantidad) * 10000) / 100 : 0

    const resumen = {
      nuevos: {
        cantidad: cantidadPorCategoria.NUEVO,
        total_bruto: brutoPorCategoria.NUEVO,
        porcentaje: porcentaje(cantidadPorCategoria.NUEVO),
      },
      recurrentes: {
        cantidad: cantidadPorCategoria.RECURRENTE,
        total_bruto: brutoPorCategoria.RECURRENTE,
        porcentaje: porcentaje(cantidadPorCategoria.RECURRENTE),
      },
      recuperaciones: {
        cantidad: cantidadPorCategoria.RECUPERACION,
        total_bruto: brutoPorCategoria.RECUPERACION,
        porcentaje: porcentaje(cantidadPorCategoria.RECUPERACION),
      },
      total: {
        cantidad: totalCantidad,
        total_bruto: totalBruto,
      },
    }

    // ----- Por canal -----
    const canalRows = (await baseQuery()
      .select(
        Database.raw("COALESCE(ft.captacion_canal, 'FACHADA') as canal"),
        Database.raw(`${CLASIFICACION_SQL} as categoria`)
      )
      .count('* as cantidad')
      .sum('ft.total as total_bruto')
      .groupByRaw("COALESCE(ft.captacion_canal, 'FACHADA')")
      .groupByRaw(CLASIFICACION_SQL)) as any[]

    const canalMap = new Map<
      string,
      { canal: string; nuevos: number; recurrentes: number; recuperaciones: number; total: number; total_bruto: number }
    >()
    for (const r of canalRows) {
      const canal = r.canal
      if (!canalMap.has(canal)) {
        canalMap.set(canal, {
          canal,
          nuevos: 0,
          recurrentes: 0,
          recuperaciones: 0,
          total: 0,
          total_bruto: 0,
        })
      }
      const entry = canalMap.get(canal)!
      const cantidad = Number(r.cantidad)
      const bruto = Number(r.total_bruto) || 0
      if (r.categoria === 'NUEVO') entry.nuevos += cantidad
      else if (r.categoria === 'RECURRENTE') entry.recurrentes += cantidad
      else if (r.categoria === 'RECUPERACION') entry.recuperaciones += cantidad
      entry.total += cantidad
      entry.total_bruto += bruto
    }

    const porCanal = [...canalMap.values()].sort((a, b) => b.total - a.total)

    // ----- Por mes -----
    const mesRows = (await baseQuery()
      .select(
        Database.raw(`DATE_FORMAT(t.fecha, '%Y-%m') as mes`),
        Database.raw(`${CLASIFICACION_SQL} as categoria`)
      )
      .count('* as cantidad')
      .groupByRaw(`DATE_FORMAT(t.fecha, '%Y-%m')`)
      .groupByRaw(CLASIFICACION_SQL)
      .orderByRaw(`DATE_FORMAT(t.fecha, '%Y-%m')`)) as any[]

    const mesMap = new Map<
      string,
      { mes: string; nuevos: number; recurrentes: number; recuperaciones: number; total: number }
    >()
    for (const r of mesRows) {
      const mes = r.mes as string
      if (!mesMap.has(mes)) {
        mesMap.set(mes, { mes, nuevos: 0, recurrentes: 0, recuperaciones: 0, total: 0 })
      }
      const entry = mesMap.get(mes)!
      const cantidad = Number(r.cantidad)
      if (r.categoria === 'NUEVO') entry.nuevos += cantidad
      else if (r.categoria === 'RECURRENTE') entry.recurrentes += cantidad
      else if (r.categoria === 'RECUPERACION') entry.recuperaciones += cantidad
      entry.total += cantidad
    }

    const porMes = [...mesMap.values()].sort((a, b) => a.mes.localeCompare(b.mes))

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      meses_minimos: mesesMinimos,
      resumen,
      por_canal: porCanal,
      por_mes: porMes,
    }
  }

  /**
   * GET /reportes-admin/detalle-retencion?fecha_inicio=&fecha_fin=&categoria=&canal=
   * Drill-down de /retencion: placas + clientes de una categoría (y opcionalmente
   * un canal) puntual.
   */
  public async detallePorRetencion({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const categoria = request.input('categoria') as string | undefined
    const canal = request.input('canal') as string | undefined

    const categoriasValidas = ['NUEVO', 'RECURRENTE', 'RECUPERACION']
    if (!categoria || !categoriasValidas.includes(categoria)) {
      return response.badRequest({
        message: 'categoria es requerida y debe ser NUEVO, RECURRENTE o RECUPERACION',
      })
    }

    const query = Database.from('facturacion_tickets as ft')
      .innerJoin('turnos_rtms as t', 't.id', 'ft.turno_id')
      .leftJoin('clientes as c', 'c.id', 't.cliente_id')
      .where('ft.estado', 'CONFIRMADA')
      .whereBetween('t.fecha', [fechaInicio, fechaFin])

    if (categoria === 'NUEVO') query.whereNull('t.meses_desde_ultima_visita')
    else if (categoria === 'RECURRENTE') query.where('t.es_recurrente', 1)
    else query.where('t.es_recuperacion', 1)

    if (canal === 'FACHADA') {
      query.where((q) => q.where('ft.captacion_canal', 'FACHADA').orWhereNull('ft.captacion_canal'))
    } else if (canal) {
      query.where('ft.captacion_canal', canal)
    }

    const rows = (await query
      .select(
        'ft.placa',
        Database.raw('DATE(t.fecha) as fecha'),
        Database.raw("COALESCE(ft.captacion_canal, 'FACHADA') as captacion_canal"),
        'ft.total',
        'ft.subtotal',
        'ft.tipo_vehiculo',
        'ft.agente_comercial_nombre',
        'ft.asesor_convenio_nombre',
        'ft.convenio_nombre',
        't.meses_desde_ultima_visita',
        't.fecha_ultima_visita',
        'c.nombre as cliente_nombre',
        'c.doc_numero as cliente_documento'
      )
      .orderBy('t.fecha', 'desc')) as any[]

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      tipo_vehiculo: r.tipo_vehiculo ?? null,
      total: Number(r.total) || 0,
      captacion_canal: r.captacion_canal,
      agente_comercial_nombre: r.agente_comercial_nombre ?? null,
      asesor_convenio_nombre: r.asesor_convenio_nombre ?? null,
      convenio_nombre: r.convenio_nombre ?? null,
      meses_desde_ultima_visita: r.meses_desde_ultima_visita ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totalBruto = detalle.reduce((acc, d) => acc + d.total, 0)

    return {
      categoria,
      canal: canal ?? 'TODOS',
      total_vehiculos: detalle.length,
      total_bruto: totalBruto,
      detalle,
    }
  }

  /**
   * GET /reportes-admin/servicios?fecha_inicio=&fecha_fin=
   * Cruza turnos_rtms (todos los servicios: RTM/SOAT/PREV/PERI) con tarifas_servicios
   * para estimar ingresos por servicio, sin depender de facturacion_tickets
   * (SOAT/PREV/PERI no generan ticket en este entorno).
   */
  public async reporteServicios({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const sql = `
      SELECT
        s.id as servicio_id,
        s.codigo_servicio,
        s.nombre_servicio,
        CASE
          WHEN LOWER(t.tipo_vehiculo) LIKE '%moto%' THEN 'MOTO'
          ELSE 'VEHICULO'
        END as tipo_vehiculo_clasificado,
        COUNT(*) as turnos,
        MAX(ts.valor_base) as valor_base,
        MAX(ts.valor_total) as valor_total
      FROM turnos_rtms t
      JOIN servicios s ON s.id = t.servicio_id
      INNER JOIN facturacion_tickets ft
        ON ft.turno_id = t.id
        AND ft.estado = 'CONFIRMADA'
      LEFT JOIN tarifas_servicios ts
        ON ts.servicio_id = t.servicio_id
        AND ts.tipo_vehiculo = CASE
          WHEN LOWER(t.tipo_vehiculo) LIKE '%moto%' THEN 'MOTO'
          ELSE 'VEHICULO'
        END
        AND ts.activo = 1
      WHERE DATE(t.fecha) BETWEEN ? AND ?
        AND t.placa NOT LIKE 'TST%'
      GROUP BY s.id, s.codigo_servicio, s.nombre_servicio, tipo_vehiculo_clasificado
      ORDER BY s.id ASC, tipo_vehiculo_clasificado ASC
    `

    const result = (await Database.rawQuery(sql, [fechaInicio, fechaFin])) as unknown as [any[]]
    const rows = result[0]

    const detalle = rows.map((r) => {
      const turnos = Number(r.turnos)
      const valorUnitario = Number(r.valor_total) || 0
      const valorBase = Number(r.valor_base) || 0
      return {
        codigo_servicio: r.codigo_servicio,
        nombre_servicio: r.nombre_servicio,
        tipo_vehiculo: r.tipo_vehiculo_clasificado,
        turnos,
        valor_unitario: valorUnitario,
        total_generado: turnos * valorUnitario,
        total_neto: turnos * valorBase,
      }
    })

    const totales = detalle.reduce(
      (acc, d) => ({
        turnos: acc.turnos + d.turnos,
        total_generado: acc.total_generado + d.total_generado,
        total_neto: acc.total_neto + d.total_neto,
      }),
      { turnos: 0, total_generado: 0, total_neto: 0 }
    )

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      detalle,
      totales,
    }
  }

  /**
   * GET /reportes-admin/descuentos-por-tipo?fecha_inicio=&fecha_fin=
   * Descuentos aplicados agrupados por tipo de descuento.
   */
  public async descuentosPorTipo({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const rows = (await Database.from('facturacion_tickets as ft')
      .join('descuentos as d', 'd.id', 'ft.descuento_id')
      .where('ft.estado', 'CONFIRMADA')
      .whereNotNull('ft.descuento_id')
      .where('ft.descuento_monto_aplicado', '>', 0)
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('d.codigo', 'd.nombre')
      .count('* as cantidad')
      .sum('ft.descuento_monto_aplicado as total_descuentos')
      .avg('ft.descuento_monto_aplicado as promedio')
      .groupBy('d.id', 'd.codigo', 'd.nombre')
      .orderBy('cantidad', 'desc')) as any[]

    const porTipo = rows.map((r) => ({
      codigo: r.codigo,
      nombre: r.nombre,
      cantidad: Number(r.cantidad),
      total_descuentos: Number(r.total_descuentos) || 0,
      promedio: Number(r.promedio) || 0,
    }))

    const totales = porTipo.reduce(
      (acc, r) => ({
        cantidad: acc.cantidad + r.cantidad,
        total_descuentos: acc.total_descuentos + r.total_descuentos,
      }),
      { cantidad: 0, total_descuentos: 0 }
    )

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_tipo: porTipo,
      totales,
    }
  }

  /**
   * GET /reportes-admin/descuentos-por-canal?fecha_inicio=&fecha_fin=
   * Descuentos aplicados agrupados por canal de captación.
   */
  public async descuentosPorCanal({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const rows = (await Database.from('facturacion_tickets as ft')
      .where('ft.estado', 'CONFIRMADA')
      .whereNotNull('ft.descuento_id')
      .where('ft.descuento_monto_aplicado', '>', 0)
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('ft.captacion_canal as canal')
      .count('* as cantidad')
      .sum('ft.descuento_monto_aplicado as total_descuentos')
      .countDistinct('ft.descuento_id as tipos_usados')
      .groupBy('ft.captacion_canal')
      .orderBy('cantidad', 'desc')) as any[]

    const porCanal = rows.map((r) => ({
      canal: r.canal,
      cantidad: Number(r.cantidad),
      total_descuentos: Number(r.total_descuentos) || 0,
      tipos_usados: Number(r.tipos_usados),
    }))

    const totales = porCanal.reduce(
      (acc, r) => ({
        cantidad: acc.cantidad + r.cantidad,
        total_descuentos: acc.total_descuentos + r.total_descuentos,
      }),
      { cantidad: 0, total_descuentos: 0 }
    )

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_canal: porCanal,
      totales,
    }
  }

  /**
   * GET /reportes-admin/descuentos-por-autorizador?fecha_inicio=&fecha_fin=
   * Descuentos aplicados agrupados por usuario que autorizó (caja).
   */
  public async descuentosPorAutorizador({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const rows = (await Database.from('facturacion_tickets as ft')
      .join('usuarios as u', 'u.id', 'ft.autorizado_por_id')
      .where('ft.estado', 'CONFIRMADA')
      .whereNotNull('ft.descuento_id')
      .where('ft.descuento_monto_aplicado', '>', 0)
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('u.id as usuario_id')
      .select(Database.raw(`CONCAT(u.nombres, ' ', u.apellidos) as nombre`))
      .count('* as cantidad')
      .sum('ft.descuento_monto_aplicado as total_descuentos')
      .groupBy('u.id', 'u.nombres', 'u.apellidos')
      .orderBy('cantidad', 'desc')) as any[]

    const porAutorizador = rows.map((r) => ({
      usuario_id: Number(r.usuario_id),
      nombre: r.nombre,
      cantidad: Number(r.cantidad),
      total_descuentos: Number(r.total_descuentos) || 0,
    }))

    const totales = porAutorizador.reduce(
      (acc, r) => ({
        cantidad: acc.cantidad + r.cantidad,
        total_descuentos: acc.total_descuentos + r.total_descuentos,
      }),
      { cantidad: 0, total_descuentos: 0 }
    )

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_autorizador: porAutorizador,
      totales,
    }
  }

  /**
   * GET /reportes-admin/detalle-descuentos?fecha_inicio=&fecha_fin=&tipo=&canal=
   * Drill-down de los 3 reportes de descuentos: placas con descuento aplicado,
   * filtrable opcionalmente por tipo (codigo del descuento) y/o canal.
   */
  public async detalleDescuentos({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const tipo = (request.input('tipo') as string | undefined) || null
    const canal = (request.input('canal') as string | undefined) || null

    const query = Database.from('facturacion_tickets as ft')
      .join('descuentos as d', 'd.id', 'ft.descuento_id')
      .leftJoin('usuarios as u', 'u.id', 'ft.autorizado_por_id')
      .leftJoin('turnos_rtms as t', 't.id', 'ft.turno_id')
      .leftJoin('clientes as c', 'c.id', 't.cliente_id')
      .where('ft.estado', 'CONFIRMADA')
      .whereNotNull('ft.descuento_id')
      .where('ft.descuento_monto_aplicado', '>', 0)
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])

    if (tipo) query.where('d.codigo', tipo)
    if (canal) query.where('ft.captacion_canal', canal)

    const rows = (await query
      .select(
        'ft.placa',
        Database.raw('DATE(ft.created_at) as fecha'),
        'ft.captacion_canal',
        'ft.tipo_vehiculo',
        'ft.total',
        'ft.total_sin_descuento',
        'ft.descuento_monto_aplicado',
        'd.codigo as descuento_codigo',
        'd.nombre as descuento_nombre',
        'ft.agente_comercial_nombre',
        'ft.asesor_convenio_nombre',
        'ft.convenio_nombre',
        Database.raw(`CONCAT(u.nombres, ' ', u.apellidos) as autorizador_nombre`),
        'c.nombre as cliente_nombre',
        'c.doc_numero as cliente_documento'
      )
      .orderBy('ft.created_at', 'desc')) as any[]

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      captacion_canal: r.captacion_canal,
      tipo_vehiculo: r.tipo_vehiculo ?? null,
      total: Number(r.total) || 0,
      total_sin_descuento: Number(r.total_sin_descuento) || 0,
      descuento_monto_aplicado: Number(r.descuento_monto_aplicado) || 0,
      descuento_codigo: r.descuento_codigo,
      descuento_nombre: r.descuento_nombre,
      agente_comercial_nombre: r.agente_comercial_nombre ?? null,
      asesor_convenio_nombre: r.asesor_convenio_nombre ?? null,
      convenio_nombre: r.convenio_nombre ?? null,
      autorizador_nombre: r.autorizador_nombre ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totalDescuentos = detalle.reduce((acc, d) => acc + d.descuento_monto_aplicado, 0)

    return {
      filtros: { tipo, canal },
      total_vehiculos: detalle.length,
      total_descuentos: totalDescuentos,
      detalle,
    }
  }

  /**
   * GET /reportes-admin/comisiones?fecha_inicio=&fecha_fin=&estado=
   * 3 tabs con datos ya agrupados por el tipo de fila que necesita cada uno:
   *  - comerciales: asesor tipo ASESOR_COMERCIAL, agrupado por asesor
   *  - asesores_convenio: asesor tipo ASESOR_CONVENIO, agrupado por asesor+convenio
   *  - convenios: agrupado por convenio+asesor, SOLO asesor comercial (los de
   *    ASESOR_CONVENIO ya están en asesores_convenio, no se duplican aquí)
   *
   * El `estado` filtra las 3 tablas de tabs, pero NUNCA el resumen/KPIs
   * (resumen.por_estado se calcula siempre sobre el rango completo, sin
   * filtrar por estado, para que los 4 KPIs se mantengan globales).
   */
  public async reporteComisiones({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const estado = (request.input('estado') as string | undefined) || null

    // ===== KPIs globales (siempre sin filtro de estado) =====
    const resumenRows = (await Database.from('comisiones')
      .where('es_config', false)
      .whereRaw('DATE(fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('estado')
      .count('* as cantidad')
      .sum('monto as monto')
      .groupBy('estado')) as any[]

    const porEstado: Record<string, { cantidad: number; monto: number }> = {
      PENDIENTE: { cantidad: 0, monto: 0 },
      APROBADA: { cantidad: 0, monto: 0 },
      PAGADA: { cantidad: 0, monto: 0 },
      ANULADA: { cantidad: 0, monto: 0 },
    }
    let totalComisiones = 0
    let totalMonto = 0
    for (const r of resumenRows) {
      const cantidad = Number(r.cantidad)
      const monto = Number(r.monto) || 0
      porEstado[r.estado] = { cantidad, monto }
      totalComisiones += cantidad
      totalMonto += monto
    }

    // ===== Tab 1: Asesor Comercial =====
    const qComerciales = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .where('c.es_config', false)
      .where('a.tipo', 'ASESOR_COMERCIAL')
      .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
    if (estado) qComerciales.where('c.estado', estado)

    const comercialesRows = (await qComerciales
      .select('a.id as asesor_id', 'a.nombre as asesor_nombre')
      .select(Database.raw('GROUP_CONCAT(DISTINCT c.estado) as estados'))
      .count('* as cantidad_vehiculos')
      .sum('c.monto_asesor as total_asesor')
      .groupBy('a.id', 'a.nombre')
      .orderBy('total_asesor', 'desc')) as any[]

    const comerciales = comercialesRows.map((r) => ({
      asesor_id: Number(r.asesor_id),
      asesor_nombre: r.asesor_nombre,
      cantidad_vehiculos: Number(r.cantidad_vehiculos),
      total_asesor: Number(r.total_asesor) || 0,
      estados: String(r.estados ?? ''),
    }))

    // ===== Tab 2: Asesor Convenio =====
    const qAsesoresConvenio = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .leftJoin('convenios as conv', 'conv.id', 'c.convenio_id')
      .where('c.es_config', false)
      .where('a.tipo', 'ASESOR_CONVENIO')
      .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
    if (estado) qAsesoresConvenio.where('c.estado', estado)

    const asesoresConvenioRows = (await qAsesoresConvenio
      .select('a.id as asesor_id', 'a.nombre as asesor_nombre', 'conv.nombre as convenio_nombre')
      .select(Database.raw('GROUP_CONCAT(DISTINCT c.estado) as estados'))
      .count('* as cantidad_vehiculos')
      .sum('c.monto_asesor as total_asesor')
      .sum('c.monto_convenio as total_convenio')
      .sum('c.monto as total_comision')
      .groupBy('a.id', 'a.nombre', 'conv.id', 'conv.nombre')
      .orderBy('total_comision', 'desc')) as any[]

    const asesoresConvenio = asesoresConvenioRows.map((r) => ({
      asesor_id: Number(r.asesor_id),
      asesor_nombre: r.asesor_nombre,
      convenio_nombre: r.convenio_nombre ?? null,
      cantidad_vehiculos: Number(r.cantidad_vehiculos),
      total_asesor: Number(r.total_asesor) || 0,
      total_convenio: Number(r.total_convenio) || 0,
      total_comision: Number(r.total_comision) || 0,
      estados: String(r.estados ?? ''),
    }))

    // ===== Tab 3: Convenio (solo asesor comercial referenciando un convenio —
    // los asesores tipo ASESOR_CONVENIO ya están en el Tab 2, no se duplican aquí) =====
    const qConvenios = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .join('convenios as conv', 'conv.id', 'c.convenio_id')
      .where('c.es_config', false)
      .where('a.tipo', 'ASESOR_COMERCIAL')
      .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
    if (estado) qConvenios.where('c.estado', estado)

    const conveniosRows = (await qConvenios
      .select(
        'conv.id as convenio_id',
        'conv.nombre as convenio_nombre',
        'a.nombre as asesor_comercial_nombre'
      )
      .select(Database.raw('GROUP_CONCAT(DISTINCT c.estado) as estados'))
      .count('* as cantidad_vehiculos')
      .sum('c.monto_convenio as total_convenio')
      .groupBy('conv.id', 'conv.nombre', 'a.id', 'a.nombre')
      .orderBy('total_convenio', 'desc')) as any[]

    const convenios = conveniosRows.map((r) => ({
      convenio_id: Number(r.convenio_id),
      convenio_nombre: r.convenio_nombre,
      asesor_comercial_nombre: r.asesor_comercial_nombre,
      cantidad_vehiculos: Number(r.cantidad_vehiculos),
      total_convenio: Number(r.total_convenio) || 0,
      estados: String(r.estados ?? ''),
    }))

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      resumen: {
        total_comisiones: totalComisiones,
        total_monto: totalMonto,
        por_estado: porEstado,
      },
      comerciales,
      asesores_convenio: asesoresConvenio,
      convenios,
    }
  }

  /**
   * GET /reportes-admin/detalle-comisiones?fecha_inicio=&fecha_fin=&asesor_id=|convenio_id=&estado=
   * Drill-down por placa. Acepta asesor_id (tabs Asesor Comercial / Asesor
   * Convenio) o convenio_id (tab Convenio) — se requiere al menos uno.
   * `estado` es opcional: si se omite (caso normal del drill-down) trae
   * todas las placas del rango sin filtrar, para que el usuario vea el
   * estado real de cada una (incluye filas "Mixto" en las tablas resumen).
   *
   * `tipo_cliente` no es una columna de `comisiones` — se deriva del turno
   * vinculado (mismo criterio que /reportes-admin/retencion). `tipo_comision`
   * no existe como columna en ningún lado del esquema ni se usa en el
   * frontend, así que no se agrega (evita inventar un dato falso).
   */
  public async detalleComisiones({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const asesorIdRaw = request.input('asesor_id') as string | number | undefined
    const convenioIdRaw = request.input('convenio_id') as string | number | undefined
    const asesorId = asesorIdRaw ? Number(asesorIdRaw) : null
    const convenioId = convenioIdRaw ? Number(convenioIdRaw) : null

    if (!asesorId && !convenioId) {
      return response.badRequest({ message: 'asesor_id o convenio_id es requerido' })
    }

    const estado = (request.input('estado') as string | undefined) || null

    const query = Database.from('comisiones as c')
      .join('captacion_dateos as cd', 'cd.id', 'c.captacion_dateo_id')
      .join('turnos_rtms as t', 't.id', 'cd.consumido_turno_id')
      .join('agentes_captacions as ag', 'ag.id', 'c.asesor_id')
      .leftJoin('convenios as conv', 'conv.id', 'c.convenio_id')
      .leftJoin('clientes as cl', 'cl.id', 't.cliente_id')
      .where('c.es_config', false)
      .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])

    if (asesorId) query.where('c.asesor_id', asesorId)
    if (convenioId) query.where('c.convenio_id', convenioId)
    if (estado) query.where('c.estado', estado)

    const rows = (await query
      .select(
        't.placa',
        Database.raw('DATE(c.fecha_calculo) as fecha'),
        'ag.nombre as asesor_nombre',
        'c.estado',
        'c.monto_asesor',
        'c.monto_convenio',
        'c.monto as total_comision',
        'conv.nombre as convenio_nombre',
        'c.pagado_at',
        Database.raw(`
          CASE
            WHEN t.meses_desde_ultima_visita IS NULL THEN 'NUEVO'
            WHEN t.es_recurrente = 1 THEN 'RECURRENTE'
            WHEN t.es_recuperacion = 1 THEN 'RECUPERACION'
            ELSE 'NUEVO'
          END as tipo_cliente
        `),
        'cl.nombre as cliente_nombre',
        'cl.doc_numero as cliente_documento'
      )
      .orderBy('c.fecha_calculo', 'desc')) as any[]

    const asesor = asesorId ? await AgenteCaptacion.find(asesorId) : null
    const convenio = convenioId ? await Convenio.find(convenioId) : null

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      asesor_nombre: r.asesor_nombre,
      estado: r.estado,
      monto_asesor: Number(r.monto_asesor) || 0,
      monto_convenio: Number(r.monto_convenio) || 0,
      total_comision: Number(r.total_comision) || 0,
      convenio_nombre: r.convenio_nombre ?? null,
      tipo_cliente: r.tipo_cliente ?? null,
      pagado_at: r.pagado_at ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totales = detalle.reduce(
      (acc, d) => ({
        total_asesor: acc.total_asesor + d.monto_asesor,
        total_convenio: acc.total_convenio + d.monto_convenio,
        total_comision: acc.total_comision + d.total_comision,
      }),
      { total_asesor: 0, total_convenio: 0, total_comision: 0 }
    )

    return {
      asesor_id: asesorId,
      asesor_nombre: asesor?.nombre ?? null,
      convenio_id: convenioId,
      convenio_nombre: convenio?.nombre ?? null,
      total_vehiculos: detalle.length,
      total_asesor: totales.total_asesor,
      total_convenio: totales.total_convenio,
      total_comision: totales.total_comision,
      detalle,
    }
  }
}
