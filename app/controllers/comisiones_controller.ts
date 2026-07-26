// app/controllers/comisiones_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'

import Comision from '#models/comision'
import AgenteCaptacion from '#models/agente_captacion'
import TurnoRtm from '#models/turno_rtm'
import Liquidacion, { type LiquidacionTipoOrigen, type LiquidacionTipoPeriodo } from '#models/liquidacion'
import LiquidacionDetalle from '#models/liquidacion_detalle'

/* ========= Helpers ========= */
function toNumber(v: any): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0
  if (typeof v === 'string') {
    const n = Number(v)
    return Number.isFinite(n) ? n : 0
  }
  return 0
}

function parseNullable(v: any): number | null {
  if (v === null || v === undefined || v === '') return null
  return Math.max(0, toNumber(v))
}

/**
 * Mapea una comision REAL (es_config = false) a DTO de lista/detalle
 */
function mapComisionToDto(c: Comision) {
  const anyC: any = c

  const dateo = anyC.$preloaded?.dateo || null
  const turno = dateo?.$preloaded?.turno || null
  const servicio = turno?.$preloaded?.servicio || null

  const montoAsesorRaw = c.montoAsesor !== null ? toNumber(c.montoAsesor) : null
  const montoConvenioRaw = c.montoConvenio !== null ? toNumber(c.montoConvenio) : null

  const valorAsesor = montoAsesorRaw !== null ? montoAsesorRaw : toNumber(c.monto)
  const valorCliente = montoConvenioRaw !== null ? montoConvenioRaw : toNumber(c.base)
  const valorTotal = valorAsesor + valorCliente

  const montoAsesorComercial = c.montoAsesor ? toNumber(c.montoAsesor) : null
  const montoConvenioPlaca = c.montoConvenio ? toNumber(c.montoConvenio) : null
  const asesorSecundario = anyC.$preloaded?.asesorSecundario || null

  const tieneDesglose = montoAsesorComercial !== null || montoConvenioPlaca !== null

  const numeroGlobal = turno?.numeroGlobal ?? turno?.turnoNumero ?? turno?.numero ?? turno?.id
  const numeroServicio =
    turno?.numeroServicio ??
    turno?.numero_servicio ??
    turno?.turnoNumeroServicio ??
    turno?.turno_numero_servicio ??
    turno?.numeroPorServicio ??
    null

  const fechaUltimaVisitaRaw = turno
    ? ((turno as any).fechaUltimaVisita ?? (turno as any).fecha_ultima_visita ?? null)
    : null
  const fechaUltimaVisitaISO = fechaUltimaVisitaRaw
    ? fechaUltimaVisitaRaw instanceof DateTime
      ? fechaUltimaVisitaRaw.toISODate()
      : String(fechaUltimaVisitaRaw).substring(0, 10)
    : null

  // Extraer descuento del ticket CONFIRMADO del turno
  const tickets: any[] = turno?.$preloaded?.facturacionTickets ?? []
  const ticket = tickets.find((t: any) => t.estado === 'CONFIRMADA') ?? tickets[0] ?? null

  // FIX: descuento puede venir del ticket (caja) o del dateo (pre-marcado)
  const descuentoRaw = ticket?.$preloaded?.descuento ?? dateo?.$preloaded?.descuento ?? null
  const confirmedByRaw = ticket?.$preloaded?.confirmedBy ?? null
  const autorizadoPorRaw = ticket?.$preloaded?.autorizadoPor ?? null

  const descuento = descuentoRaw
    ? {
        id: descuentoRaw.id,
        codigo: String(descuentoRaw.codigo ?? ''),
        nombre: String(descuentoRaw.nombre ?? ''),
      }
    : null

  const descuentoOrigen: 'dateo' | 'caja' | null = descuento
    ? ticket?.autorizadoPorId
      ? 'caja'
      : 'dateo'
    : null

  let descuentoAplicadoAt: string | null = null
  if (ticket?.confirmadoAt) {
    descuentoAplicadoAt =
      ticket.confirmadoAt instanceof DateTime
        ? ticket.confirmadoAt.toISO()
        : String(ticket.confirmadoAt)
  }

  const descuentoAplicadoPor = confirmedByRaw
    ? {
        id: confirmedByRaw.id,
        nombre:
          [confirmedByRaw.nombres, confirmedByRaw.apellidos].filter(Boolean).join(' ') ||
          confirmedByRaw.nombre ||
          null,
      }
    : null

  const descuentoAutorizadoPor = autorizadoPorRaw
    ? {
        id: autorizadoPorRaw.id,
        nombres: autorizadoPorRaw.nombres ?? autorizadoPorRaw.nombre ?? null,
        apellidos: autorizadoPorRaw.apellidos ?? null,
      }
    : null

  // es_avance viene de la comisión guardada
  const esAvance = Boolean(anyC.esAvance ?? (anyC as any).es_avance ?? false)

  // descuento_monto_aplicado: leer DIRECTO de la comisión (guardado por el hook).
  // Fallback al ticket por compatibilidad con registros anteriores al fix.
  const descuentoMontoAplicadoComision =
    c.descuentoMontoAplicado !== null ? Number(c.descuentoMontoAplicado) : null
  const descuentoMontoAplicadoTicket =
    ticket !== null &&
    ticket.descuentoMontoAplicado !== null &&
    ticket.descuentoMontoAplicado !== undefined
      ? Number(ticket.descuentoMontoAplicado)
      : null
  const descuentoMontoAplicado = descuentoMontoAplicadoComision ?? descuentoMontoAplicadoTicket

  // base = incentivo original antes del avance (guardado por el hook como valorIncentivoPorTipo).
  // Si base = 0 (registro viejo sin fix), reconstruir como monto_convenio + descuento_monto_aplicado.
  let baseIncentivo = c.base !== null ? toNumber(c.base) : null
  if (
    esAvance &&
    (baseIncentivo === null || baseIncentivo === 0) &&
    montoConvenioRaw !== null &&
    descuentoMontoAplicado !== null &&
    descuentoMontoAplicado > 0
  ) {
    baseIncentivo = montoConvenioRaw + descuentoMontoAplicado
  }

  return {
    id: c.id,
    // 🆕 tipo_vehiculo directo de la comisión para filtrado y comprobante
    tipo_vehiculo: (c as any).tipoVehiculo ?? null,
    dateo_id: c.captacionDateoId,
    estado: c.estado,
    cantidad: 1,

    valor_unitario: valorAsesor,
    valor_cliente: valorCliente,
    valor_total: valorTotal,
    generado_at: c.fechaCalculo ? c.fechaCalculo.toISO() : null,

    // campos de desglose correctos
    monto_asesor: montoAsesorRaw,
    monto_convenio: montoConvenioRaw,
    es_avance: esAvance,
    base: baseIncentivo,

    tiene_desglose: tieneDesglose,
    desglose: tieneDesglose
      ? {
          monto_asesor_comercial: montoAsesorComercial,
          monto_convenio_placa: montoConvenioPlaca,
          asesor_secundario: asesorSecundario
            ? {
                id: asesorSecundario.id,
                nombre: asesorSecundario.nombre,
                tipo: asesorSecundario.tipo,
              }
            : null,
        }
      : null,

    asesor: anyC.$preloaded?.asesor
      ? {
          id: anyC.$preloaded.asesor.id,
          nombre: anyC.$preloaded.asesor.nombre,
          tipo: anyC.$preloaded.asesor.tipo,
        }
      : null,

    convenio: anyC.$preloaded?.convenio
      ? {
          id: anyC.$preloaded.convenio.id,
          nombre: anyC.$preloaded.convenio.nombre,
          metodo_pago: anyC.$preloaded.convenio.metodoPago ?? null,
          numero_metodo_pago: anyC.$preloaded.convenio.numeroMetodoPago ?? null,
        }
      : null,

    turno: turno
      ? {
          id: turno.id,
          numero_global: numeroGlobal,
          numero_servicio: numeroServicio,
          fecha: (turno as any).fecha || turno.createdAt,
          placa: (turno as any).placa,
          servicio: servicio
            ? {
                id: servicio.id,
                codigo: (servicio as any).codigoServicio,
                nombre: (servicio as any).nombreServicio,
              }
            : null,
          es_recurrente: Boolean(
            (turno as any).esRecurrente ?? (turno as any).es_recurrente ?? false
          ),
          es_recuperacion: Boolean(
            (turno as any).esRecuperacion ?? (turno as any).es_recuperacion ?? false
          ),
          meses_desde_ultima_visita:
            (turno as any).mesesDesdeUltimaVisita ??
            (turno as any).meses_desde_ultima_visita ??
            null,
          ultimo_turno_id: (turno as any).ultimoTurnoId ?? (turno as any).ultimo_turno_id ?? null,
          fecha_ultima_visita: fechaUltimaVisitaISO,
          rep_general_verificado: Boolean(
            (turno as any).repGeneralVerificado ?? (turno as any).rep_general_verificado ?? false
          ),
          ultima_visita: null as {
            placa: string | null
            conductor_nombre: string | null
            vehiculo_descripcion: string | null
            fecha: string | null
          } | null,
        }
      : null,

    // Descuento informativo
    descuento,
    descuento_origen: descuentoOrigen,
    descuento_aplicado_at: descuentoAplicadoAt,
    descuento_aplicado_por: descuentoAplicadoPor,
    descuento_autorizado_por: descuentoAutorizadoPor,
    // monto del avance/descuento aplicado en caja
    descuento_monto_aplicado: descuentoMontoAplicado,
    dateo_observacion: dateo?.observacion ?? null,
  }
}

/**
 * Mapea una FILA DE CONFIGURACIÓN (es_config = true) a DTO
 */
function mapConfigToDto(c: Comision) {
  return {
    id: c.id,
    es_config: true,
    asesor_id: c.asesorId ?? null,
    tipo_vehiculo: (c as any).tipoVehiculo ?? null,
    valor_placa: toNumber(c.base),
    valor_placa_vehiculo: c.valorPlacaVehiculo !== null ? toNumber(c.valorPlacaVehiculo) : null,
    valor_placa_moto: c.valorPlacaMoto !== null ? toNumber(c.valorPlacaMoto) : null,
    valor_dateo: toNumber(c.monto),
    valor_nuevo_directo: toNumber(c.valorNuevoDirecto ?? 0),
    meta_rtm: c.metaRtm ?? 0,
    porcentaje_comision_meta: toNumber(c.porcentajeComisionMeta ?? 0),
    fecha_calculo: c.fechaCalculo ? c.fechaCalculo.toISO() : null,
  }
}

function mapMetaToDto(c: Comision) {
  return {
    id: c.id,
    asesor_id: c.asesorId,
    tipo_vehiculo: (c as any).tipoVehiculo ?? null,
    meta_mensual: c.metaRtm ?? 0,
    porcentaje_extra: toNumber(c.porcentajeComisionMeta ?? 0),
    valor_rtm_moto: c.valorRtmMoto ?? 0,
    valor_rtm_vehiculo: c.valorRtmVehiculo ?? 0,
    fecha_actualizacion: c.updatedAt?.toISO() ?? c.createdAt?.toISO() ?? null,
  }
}

export default class ComisionesController {
  /**
   * GET /api/comisiones
   */
  public async index({ request, response }: HttpContext) {
    const page = Number(request.input('page') || 1)
    const perPage = Math.min(Number(request.input('perPage') || 10), 100)
    const desde = request.input('desde') as string | undefined
    const hasta = request.input('hasta') as string | undefined
    const asesorId = request.input('asesorId') as number | undefined
    const convenioId = request.input('convenioId') as number | undefined
    const estado = request.input('estado') as string | undefined
    const tipoVehiculo = request.input('tipoVehiculo') as string | undefined
    const placa = request.input('placa') as string | undefined // 🆕
    const tipoAsesor = request.input('tipoAsesor') as string | undefined // 🆕
    const tipoCaptacion = request.input('tipoCaptacion') as string | undefined // 🆕
    const sortBy = (request.input('sortBy') || 'id') as string
    const order = (request.input('order') || 'desc') as 'asc' | 'desc'

    const query = Comision.query()
      .where((q) => {
        q.where('es_config', false).orWhereNull('es_config')
      })
      .preload('asesor')
      .preload('convenio')
      .preload('asesorSecundario')
      .preload('dateo', (dq) => {
        // FIX: preload descuento del dateo para AVANCE pre-marcado
        dq.preload('descuento')
        dq.preload('turno', (tq) => {
          tq.preload('servicio')
          // FIX: remover whereNotNull('descuento_id') para capturar tickets
          // de AVANCE pre-marcado (que tienen monto pero no descuento_id)
          tq.preload('facturacionTickets', (fq) => {
            fq.preload('descuento').preload('confirmedBy').preload('autorizadoPor')
          })
        })
      })

    if (desde) query.where('fecha_calculo', '>=', desde + ' 00:00:00')
    if (hasta) query.where('fecha_calculo', '<=', hasta + ' 23:59:59')

    if (asesorId) query.where('asesor_id', asesorId)
    if (convenioId) query.where('convenio_id', convenioId)
    if (estado) query.where('estado', estado)
    // 🆕 Filtro por tipo de vehículo (MOTO | VEHICULO)
    if (tipoVehiculo && ['MOTO', 'VEHICULO'].includes(tipoVehiculo.toUpperCase()))
      query.where('tipo_vehiculo', tipoVehiculo.toUpperCase())

    // 🆕 Filtro por placa (busca en el turno vinculado al dateo)
    if (placa) {
      const placaNorm = placa.replace(/[\s-]/g, '').toUpperCase()
      query.whereHas('dateo', (dq) => {
        dq.whereHas('turno', (tq) => {
          tq.whereRaw("REPLACE(REPLACE(UPPER(placa), '-', ''), ' ', '') = ?", [placaNorm])
        })
      })
    }

    // 🆕 Filtro por tipo de asesor/convenio (antes solo se aplicaba en el
    // frontend sobre la página ya paginada, rompiendo la paginación server-side)
    if (tipoAsesor === 'ASESOR_COMERCIAL' || tipoAsesor === 'ASESOR_CONVENIO') {
      query.whereHas('asesor', (aq) => aq.where('tipo', tipoAsesor))
    } else if (tipoAsesor === 'CONVENIO') {
      query.whereNotNull('convenio_id')
    }

    // 🆕 Filtro por tipo de captación (independiente de tipoAsesor, para poder
    // combinarlos: ej. un comercial + solo sus comisiones de convenio)
    if (tipoCaptacion === 'NUEVO_DIRECTO') query.whereNull('convenio_id')
    else if (tipoCaptacion === 'CONVENIO') query.whereNotNull('convenio_id')

    const SORTABLE = new Set(['id', 'estado', 'fecha_calculo', 'monto', 'asesor_id', 'convenio_id'])
    let sortCol = sortBy === 'generado_at' ? 'fecha_calculo' : sortBy
    if (!SORTABLE.has(sortCol)) sortCol = 'id'
    query.orderBy(sortCol, order)

    const paginated = await query.paginate(page, perPage)
    const meta = paginated.getMeta()
    const data = paginated.all()
    const rows = data.map((c) => mapComisionToDto(c))

    return response.ok({
      data: rows,
      total: meta.total,
      page: meta.currentPage,
      perPage: meta.perPage,
    })
  }

  /**
   * GET /api/comisiones/resumen
   * Resumen agregado (sin paginar) por tipo de captación y por estado, con
   * los mismos filtros que index(). Se pide en paralelo a la lista paginada
   * para no cargar la agregación en cada página.
   */
  public async resumen({ request, response }: HttpContext) {
    const desde = request.input('desde') as string | undefined
    const hasta = request.input('hasta') as string | undefined
    const asesorId = request.input('asesorId') as number | undefined
    const convenioId = request.input('convenioId') as number | undefined
    const estado = request.input('estado') as string | undefined
    const tipoVehiculo = request.input('tipoVehiculo') as string | undefined
    const placa = request.input('placa') as string | undefined
    const tipoAsesor = request.input('tipoAsesor') as string | undefined
    const tipoCaptacion = request.input('tipoCaptacion') as string | undefined // 🆕

    const baseQuery = () => {
      const q = Database.from('comisiones')
        .where((qb) => qb.where('es_config', false).orWhereNull('es_config'))

      if (desde) q.where('fecha_calculo', '>=', desde + ' 00:00:00')
      if (hasta) q.where('fecha_calculo', '<=', hasta + ' 23:59:59')
      if (asesorId) q.where('asesor_id', asesorId)
      if (convenioId) q.where('convenio_id', convenioId)
      if (estado) q.where('estado', estado)
      if (tipoVehiculo && ['MOTO', 'VEHICULO'].includes(tipoVehiculo.toUpperCase()))
        q.where('tipo_vehiculo', tipoVehiculo.toUpperCase())
      if (placa) {
        const placaNorm = placa.replace(/[\s-]/g, '').toUpperCase()
        q.whereIn(
          'captacion_dateo_id',
          Database.from('captacion_dateos as cd')
            .join('turnos_rtms as t', 't.id', 'cd.consumido_turno_id')
            .whereRaw("REPLACE(REPLACE(UPPER(t.placa), '-', ''), ' ', '') = ?", [placaNorm])
            .select('cd.id')
        )
      }
      if (tipoAsesor === 'ASESOR_COMERCIAL' || tipoAsesor === 'ASESOR_CONVENIO') {
        q.whereIn(
          'asesor_id',
          Database.from('agentes_captacions').where('tipo', tipoAsesor).select('id')
        )
      } else if (tipoAsesor === 'CONVENIO') {
        q.whereNotNull('convenio_id')
      }

      // 🆕 Igual que tipoAsesor: el backend lo soporta, pero el frontend NO lo
      // envía en la llamada de las tarjetas de arriba (quedan estáticas ante
      // este filtro, mismo criterio que ya aplica a `estado`).
      if (tipoCaptacion === 'NUEVO_DIRECTO') q.whereNull('convenio_id')
      else if (tipoCaptacion === 'CONVENIO') q.whereNotNull('convenio_id')

      return q
    }

    // Mismo cálculo de "monto total" que valor_total en mapComisionToDto
    // (monto_asesor/monto_convenio si existen, si no fallback a monto/base).
    const MONTO_SQL = 'COALESCE(monto_asesor, monto) + COALESCE(monto_convenio, base)'

    const porTipoRows = (await baseQuery()
      .select(
        Database.raw(
          `CASE WHEN convenio_id IS NULL THEN 'NUEVO_DIRECTO' ELSE 'CONVENIO' END as tipo_captacion`
        )
      )
      .count('* as cantidad')
      .sum(Database.raw(`(${MONTO_SQL})`) as any, 'monto')
      .groupBy('tipo_captacion')) as any[]

    const porTipoCaptacion: Record<string, { cantidad: number; monto: number }> = {
      NUEVO_DIRECTO: { cantidad: 0, monto: 0 },
      CONVENIO: { cantidad: 0, monto: 0 },
    }
    let totalTipoCantidad = 0
    let totalTipoMonto = 0
    for (const r of porTipoRows) {
      const cantidad = Number(r.cantidad)
      const monto = Number(r.monto) || 0
      porTipoCaptacion[r.tipo_captacion] = { cantidad, monto }
      totalTipoCantidad += cantidad
      totalTipoMonto += monto
    }

    const porEstadoRows = (await baseQuery()
      .select('estado')
      .count('* as cantidad')
      .sum(Database.raw(`(${MONTO_SQL})`) as any, 'monto')
      .groupBy('estado')) as any[]

    const porEstado: Record<string, { cantidad: number; monto: number }> = {
      PENDIENTE: { cantidad: 0, monto: 0 },
      APROBADA: { cantidad: 0, monto: 0 },
      PAGADA: { cantidad: 0, monto: 0 },
      ANULADA: { cantidad: 0, monto: 0 },
    }
    let totalEstadoCantidad = 0
    let totalEstadoMonto = 0
    for (const r of porEstadoRows) {
      const cantidad = Number(r.cantidad)
      const monto = Number(r.monto) || 0
      porEstado[r.estado] = { cantidad, monto }
      totalEstadoCantidad += cantidad
      totalEstadoMonto += monto
    }

    // 🆕 Resumen de descuentos aplicados por tipo (nombre de catálogo).
    // `comisiones` no tiene descuento_id propio: el descuento sale del ticket
    // de caja o del dateo (precedencia ticket > dateo, igual que
    // mapComisionToDto). Se reutiliza esa misma función por fila para no
    // duplicar la lógica de resolución en SQL.
    // Respeta TODOS los filtros activos salvo `estado` (mismo criterio que
    // "Total Generado": no está anuladas, sin importar el filtro de estado).
    const descuentosQuery = Comision.query()
      .where((q) => q.where('es_config', false).orWhereNull('es_config'))
      .whereNot('estado', 'ANULADA')
      .preload('dateo', (dq) => {
        dq.preload('descuento')
        dq.preload('turno', (tq) => {
          tq.preload('facturacionTickets', (fq) => fq.preload('descuento'))
        })
      })

    if (desde) descuentosQuery.where('fecha_calculo', '>=', desde + ' 00:00:00')
    if (hasta) descuentosQuery.where('fecha_calculo', '<=', hasta + ' 23:59:59')
    if (asesorId) descuentosQuery.where('asesor_id', asesorId)
    if (convenioId) descuentosQuery.where('convenio_id', convenioId)
    if (tipoVehiculo && ['MOTO', 'VEHICULO'].includes(tipoVehiculo.toUpperCase()))
      descuentosQuery.where('tipo_vehiculo', tipoVehiculo.toUpperCase())
    if (placa) {
      const placaNorm = placa.replace(/[\s-]/g, '').toUpperCase()
      descuentosQuery.whereHas('dateo', (dq) => {
        dq.whereHas('turno', (tq) => {
          tq.whereRaw("REPLACE(REPLACE(UPPER(placa), '-', ''), ' ', '') = ?", [placaNorm])
        })
      })
    }
    if (tipoAsesor === 'ASESOR_COMERCIAL' || tipoAsesor === 'ASESOR_CONVENIO') {
      descuentosQuery.whereHas('asesor', (aq) => aq.where('tipo', tipoAsesor))
    } else if (tipoAsesor === 'CONVENIO') {
      descuentosQuery.whereNotNull('convenio_id')
    }
    if (tipoCaptacion === 'NUEVO_DIRECTO') descuentosQuery.whereNull('convenio_id')
    else if (tipoCaptacion === 'CONVENIO') descuentosQuery.whereNotNull('convenio_id')

    const filasDescuento = await descuentosQuery

    const porDescuentoMap = new Map<
      number,
      { descuento_id: number; nombre: string; cantidad: number; monto: number }
    >()
    for (const c of filasDescuento) {
      const dto = mapComisionToDto(c)
      if (!dto.descuento || !dto.descuento_monto_aplicado) continue
      const actual = porDescuentoMap.get(dto.descuento.id) ?? {
        descuento_id: dto.descuento.id,
        nombre: dto.descuento.nombre,
        cantidad: 0,
        monto: 0,
      }
      actual.cantidad += 1
      actual.monto += dto.descuento_monto_aplicado
      porDescuentoMap.set(dto.descuento.id, actual)
    }
    const porDescuento = Array.from(porDescuentoMap.values()).sort((a, b) => b.monto - a.monto)
    const totalDescuentos = porDescuento.reduce(
      (acc, r) => ({ cantidad: acc.cantidad + r.cantidad, monto: acc.monto + r.monto }),
      { cantidad: 0, monto: 0 }
    )

    return response.ok({
      por_tipo_captacion: {
        nuevo_directo: porTipoCaptacion.NUEVO_DIRECTO,
        convenio: porTipoCaptacion.CONVENIO,
        total: { cantidad: totalTipoCantidad, monto: totalTipoMonto },
      },
      por_estado: {
        ...porEstado,
        total: { cantidad: totalEstadoCantidad, monto: totalEstadoMonto },
      },
      resumen_descuentos: {
        total: totalDescuentos,
        por_tipo: porDescuento,
      },
    })
  }

  /**
   * GET /api/comisiones/metas-mensuales
   */
  public async metasMensuales({ request, response }: HttpContext) {
    const mes = request.input('mes') as string | undefined
    const asesorIdParam = request.input('asesorId') as number | string | undefined

    let year: number
    let month: number

    if (mes && /^\d{4}-\d{2}$/.test(mes)) {
      const [y, m] = mes.split('-').map(Number)
      year = y
      month = m
    } else {
      const now = DateTime.now()
      year = now.year
      month = now.month
    }

    const start = DateTime.fromObject({ year, month, day: 1 }).startOf('day').toSQL()
    const end = DateTime.fromObject({ year, month, day: 1 }).endOf('month').toSQL()

    const asesorId =
      asesorIdParam !== undefined && asesorIdParam !== null ? Number(asesorIdParam) : undefined

    const baseQ = Database.from('comisiones')
      .where((q) => {
        q.where('es_config', false).orWhereNull('es_config')
      })
      .andWhere('tipo_servicio', 'RTM')
      .whereIn('estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
      .whereNotNull('asesor_id')

    if (start && end) baseQ.whereBetween('fecha_calculo', [start, end])
    if (asesorId) baseQ.andWhere('asesor_id', asesorId)

    const agregados = await baseQ
      .select('asesor_id')
      .select(Database.raw("SUM(CASE WHEN tipo_vehiculo = 'MOTO' THEN 1 ELSE 0 END) AS rtm_motos"))
      .select(
        Database.raw(
          "SUM(CASE WHEN tipo_vehiculo = 'VEHICULO' OR tipo_vehiculo IS NULL THEN 1 ELSE 0 END) AS rtm_vehiculos"
        )
      )
      .groupBy('asesor_id')

    const countsByAsesor = new Map<number, { rtm_motos: number; rtm_vehiculos: number }>()
    for (const row of agregados as any[]) {
      const id = Number(row.asesor_id)
      if (!Number.isFinite(id)) continue
      countsByAsesor.set(id, {
        rtm_motos: Number(row.rtm_motos || 0),
        rtm_vehiculos: Number(row.rtm_vehiculos || 0),
      })
    }

    const globalCfg = await Comision.query()
      .where('es_config', true)
      .whereNull('asesor_id')
      .where((wb) => wb.where('valor_rtm_moto', '>', 0).orWhere('valor_rtm_vehiculo', '>', 0))
      .first()

    const cfgRows = await Comision.query().where('es_config', true).where('meta_rtm', '>', 0)
    const cfgByAsesor = new Map<number, Comision>()
    for (const c of cfgRows) {
      if (c.asesorId !== null) cfgByAsesor.set(c.asesorId, c)
    }

    const allIds = new Set<number>()
    if (asesorId) {
      allIds.add(asesorId)
    } else {
      countsByAsesor.forEach((_v, id) => allIds.add(id))
      cfgByAsesor.forEach((_v, id) => allIds.add(id))
    }

    const asesorIds = Array.from(allIds)
    const asesoresMap = new Map<number, { nombre: string; tipo: string | null }>()

    if (asesorIds.length > 0) {
      const asesores = await AgenteCaptacion.query().whereIn('id', asesorIds)
      for (const a of asesores) {
        asesoresMap.set(a.id, { nombre: a.nombre, tipo: (a as any).tipo ?? null })
      }
    }

    const rows = asesorIds.map((id) => {
      const counts = countsByAsesor.get(id) ?? { rtm_motos: 0, rtm_vehiculos: 0 }
      const cfg = cfgByAsesor.get(id) ?? null

      const metaRtm = cfg ? (cfg.metaRtm ?? 0) : 0
      const pctMeta = cfg ? toNumber(cfg.porcentajeComisionMeta ?? 0) : 0
      const valorRtmMoto = cfg ? cfg.valorRtmMoto : (globalCfg?.valorRtmMoto ?? 0)
      const valorRtmVehiculo = cfg ? cfg.valorRtmVehiculo : (globalCfg?.valorRtmVehiculo ?? 0)

      const totalFacturacionMotos = counts.rtm_motos * valorRtmMoto
      const totalFacturacionVehiculos = counts.rtm_vehiculos * valorRtmVehiculo
      const totalFacturacionGlobal = totalFacturacionMotos + totalFacturacionVehiculos
      const info = asesoresMap.get(id)

      return {
        asesor_id: id,
        asesor_nombre: info?.nombre ?? '—',
        asesor_tipo: info?.tipo ?? null,
        rtm_motos: counts.rtm_motos,
        rtm_vehiculos: counts.rtm_vehiculos,
        total_rtm_motos: counts.rtm_motos,
        total_rtm_vehiculos: counts.rtm_vehiculos,
        meta_global_rtm: metaRtm,
        porcentaje_comision_meta: pctMeta,
        valor_rtm_moto: valorRtmMoto,
        valor_rtm_vehiculo: valorRtmVehiculo,
        total_facturacion_motos: totalFacturacionMotos,
        total_facturacion_vehiculos: totalFacturacionVehiculos,
        total_facturacion_global: totalFacturacionGlobal,
      }
    })

    return response.ok({ data: rows })
  }

  /**
   * GET /api/comisiones/:id
   */
  public async show({ params, response }: HttpContext) {
    const comision = await Comision.query()
      .where('id', params.id)
      .where((q) => {
        q.where('es_config', false).orWhereNull('es_config')
      })
      .preload('asesor')
      .preload('convenio')
      .preload('asesorSecundario')
      .preload('dateo', (dq) => {
        // FIX: preload descuento del dateo para AVANCE pre-marcado
        dq.preload('descuento')
        dq.preload('turno', (tq) => {
          tq.preload('servicio')
          // FIX: remover whereNotNull('descuento_id')
          tq.preload('facturacionTickets', (fq) => {
            fq.preload('descuento').preload('confirmedBy').preload('autorizadoPor')
          })
        })
      })
      .first()

    if (!comision) return response.notFound({ message: 'Comisión no encontrada' })

    const dto = mapComisionToDto(comision)

    const ultimoTurnoId = dto.turno?.ultimo_turno_id ?? null
    if (ultimoTurnoId && dto.turno) {
      const ultimoTurno = await TurnoRtm.query()
        .where('id', ultimoTurnoId)
        .preload('conductor')
        .preload('vehiculo')
        .first()

      if (ultimoTurno) {
        const conductor = (ultimoTurno as any).$preloaded?.conductor ?? null
        const vehiculo = (ultimoTurno as any).$preloaded?.vehiculo ?? null
        const vehiculoDescripcion = vehiculo
          ? [vehiculo.marca, vehiculo.linea, vehiculo.modelo].filter(Boolean).join(' ') || null
          : null

        dto.turno.ultima_visita = {
          placa: (ultimoTurno as any).placa ?? null,
          conductor_nombre: conductor?.nombre ?? null,
          vehiculo_descripcion: vehiculoDescripcion,
          fecha:
            ultimoTurno.fecha instanceof DateTime
              ? ultimoTurno.fecha.toISODate()
              : String(ultimoTurno.fecha).substring(0, 10),
        }
      }
    }

    const result = {
      ...dto,
      aprobado_at: comision.aprobadoAt?.toISO() ?? null,
      aprobado_por: comision.aprobadoPor ?? null,
      pagado_at: comision.pagadoAt?.toISO() ?? null,
      pagado_por: comision.pagadoPor ?? null,
      anulado_at: comision.anuladoAt?.toISO() ?? null,
      anulado_por: comision.anuladoPor ?? null,
      observacion: comision.observacion ?? null,
    }

    return response.ok(result)
  }

  /**
   * PATCH /api/comisiones/:id/valores
   */

  public async editar({ params, request, response }: HttpContext) {
    const comision = await Comision.find(params.id)
    if (!comision || comision.esConfig)
      return response.notFound({ message: 'Comisión no encontrada' })
    if (comision.estado !== 'PENDIENTE')
      return response.badRequest({ message: 'Solo se pueden editar comisiones PENDIENTES' })

    const payload = request.only([
      'asesor_id',
      'convenio_id',
      'monto_asesor',
      'monto_convenio',
      'tipo_cliente',
      'descuento_id',
      'dateo_observacion',
    ])

    if ('asesor_id' in payload)
      comision.asesorId = payload.asesor_id ? Number(payload.asesor_id) : null

    if ('convenio_id' in payload)
      comision.convenioId = payload.convenio_id ? Number(payload.convenio_id) : null

    if (payload.monto_asesor !== undefined) {
      const v = Math.max(0, toNumber(payload.monto_asesor))
      comision.montoAsesor = String(v)
      comision.monto = String(v)
    }

    if (payload.monto_convenio !== undefined) {
      const v = Math.max(0, toNumber(payload.monto_convenio))
      comision.montoConvenio = String(v)
      comision.base = String(v)
    }

    if ('descuento_id' in payload) {
      if (!payload.descuento_id) {
        ;(comision as any).descuentoId = null
      } else {
        const descId = Number(payload.descuento_id)
        const { default: Descuento } = await import('#models/descuento')
        const desc = await Descuento.query().where('id', descId).where('activo', true).first()
        if (!desc) return response.badRequest({ message: 'Descuento no existe o está inactivo' })
        ;(comision as any).descuentoId = descId
      }
    }

    if (payload.tipo_cliente) {
      await comision.load('dateo', (q) => q.preload('turno'))
      const turno = (comision as any).$preloaded?.dateo?.$preloaded?.turno
      if (turno) {
        turno.esRecurrente = payload.tipo_cliente === 'RECURRENTE'
        turno.esRecuperacion = payload.tipo_cliente === 'RECUPERACION'
        await turno.save()
      }
    }

    if ('dateo_observacion' in payload) {
      if (!(comision as any).$preloaded?.dateo) await comision.load('dateo')
      const dateo = (comision as any).$preloaded?.dateo
      if (dateo) {
        dateo.observacion = payload.dateo_observacion
          ? String(payload.dateo_observacion).trim()
          : null
        await dateo.save()
      }
    }

    await comision.save()
    return this.show({ params, response } as any)
  }
  public async actualizarValores({ params, request, response }: HttpContext) {
    const comision = await Comision.find(params.id)

    if (!comision || comision.esConfig)
      return response.notFound({ message: 'Comisión no encontrada' })

    if (comision.estado !== 'PENDIENTE')
      return response.badRequest({
        message: 'Solo se pueden editar comisiones en estado PENDIENTE',
      })

    const { cantidad, valor_unitario: valorUnitario } = request.only(['cantidad', 'valor_unitario'])
    const cant = toNumber(cantidad || 1)
    const vu = toNumber(valorUnitario || 0)
    const nuevoMonto = String(cant * vu)

    comision.monto = nuevoMonto
    comision.montoAsesor = nuevoMonto
    await comision.save()

    return this.show({ params, response } as any)
  }

  /**
   * POST /api/comisiones/:id/aprobar
   */
  public async aprobar({ params, response, auth }: HttpContext) {
    const comision = await Comision.find(params.id)
    if (!comision || comision.esConfig)
      return response.notFound({ message: 'Comisión no encontrada' })
    if (comision.estado !== 'PENDIENTE')
      return response.badRequest({ message: 'Solo se pueden aprobar comisiones PENDIENTES' })

    comision.estado = 'APROBADA'
    comision.aprobadoAt = DateTime.now()
    comision.aprobadoPor = auth.user?.id ?? null
    await comision.save()
    return this.show({ params, response } as any)
  }

  /**
   * POST /api/comisiones/:id/pagar
   */
  public async pagar({ params, response, auth }: HttpContext) {
    const comision = await Comision.find(params.id)
    if (!comision || comision.esConfig)
      return response.notFound({ message: 'Comisión no encontrada' })
    if (comision.estado !== 'APROBADA')
      return response.badRequest({ message: 'Solo se pueden pagar comisiones APROBADAS' })

    comision.estado = 'PAGADA'
    comision.pagadoAt = DateTime.now()
    comision.pagadoPor = auth.user?.id ?? null
    await comision.save()
    return this.show({ params, response } as any)
  }

  /**
   * POST /api/comisiones/:id/anular
   */
  public async anular({ params, request, response, auth }: HttpContext) {
    const comision = await Comision.find(params.id)
    if (!comision || comision.esConfig)
      return response.notFound({ message: 'Comisión no encontrada' })
    if (comision.estado === 'PAGADA')
      return response.badRequest({ message: 'No se pueden anular comisiones PAGADAS' })

    comision.estado = 'ANULADA'
    comision.anuladoAt = DateTime.now()
    comision.anuladoPor = auth.user?.id ?? null
    const { observacion } = request.only(['observacion'])
    if (observacion) comision.observacion = String(observacion).trim()
    await comision.save()
    return this.show({ params, response } as any)
  }

  /**
   * POST /api/comisiones/pagar-masivo
   * Body: { ids: number[], accion: 'APROBAR' | 'PAGAR', fecha_pago?: string }
   *
   * APROBAR solo afecta comisiones en PENDIENTE.
   * PAGAR afecta PENDIENTE o APROBADA (si estaba PENDIENTE, se auto-aprueba
   * con la misma fecha/usuario, igual que pide el enunciado con COALESCE).
   * Usa un loop de modelos Lucid (no un UPDATE crudo) para reutilizar la
   * misma lógica/validación que aprobar()/pagar() individuales, envuelto en
   * una transacción para que sea todo-o-nada.
   */
  public async pagarMasivo({ request, response, auth }: HttpContext) {
    const {
      ids,
      accion,
      fecha_pago: fechaPago,
      origen,
      tipo_periodo: tipoPeriodoRaw,
      fecha_inicio: fechaInicioRaw,
      fecha_fin: fechaFinRaw,
    } = request.only([
      'ids',
      'accion',
      'fecha_pago',
      'origen',
      'tipo_periodo',
      'fecha_inicio',
      'fecha_fin',
    ])

    if (!Array.isArray(ids) || ids.length === 0) {
      return response.badRequest({ message: 'ids es requerido y debe ser un arreglo no vacío' })
    }
    if (accion !== 'APROBAR' && accion !== 'PAGAR') {
      return response.badRequest({ message: "accion debe ser 'APROBAR' o 'PAGAR'" })
    }

    const idsNumericos = [
      ...new Set(
        (ids as unknown[]).map((id) => Number(id)).filter((id) => Number.isFinite(id))
      ),
    ]
    if (idsNumericos.length === 0) {
      return response.badRequest({ message: 'ids no contiene valores numéricos válidos' })
    }

    const usuarioId = auth.user?.id ?? null
    const ahora = DateTime.now()

    // Origen del pago (modal Liquidar / tabla general / panel por asesor):
    // lo declara el frontend, ya que el backend no puede inferirlo de los
    // ids solos. Si no llega (llamador desconocido/futuro), se asume el
    // caso más genérico en vez de romper el pago por un dato de trazabilidad.
    const ORIGENES_VALIDOS: LiquidacionTipoOrigen[] = [
      'MODAL_LIQUIDAR',
      'TABLA_GENERAL',
      'PANEL_ASESOR',
    ]
    const tipoOrigen: LiquidacionTipoOrigen = ORIGENES_VALIDOS.includes(origen)
      ? origen
      : 'TABLA_GENERAL'
    const PERIODOS_VALIDOS = ['DIARIO', 'SEMANAL', 'QUINCENAL', 'MENSUAL']
    const tipoPeriodo: LiquidacionTipoPeriodo = PERIODOS_VALIDOS.includes(tipoPeriodoRaw)
      ? tipoPeriodoRaw
      : null

    const trx = await Database.transaction()
    try {
      const idsActualizadas: number[] = []

      if (accion === 'APROBAR') {
        const comisiones = await Comision.query({ client: trx })
          .whereIn('id', idsNumericos)
          .where('es_config', false)
          .where('estado', 'PENDIENTE')

        for (const c of comisiones) {
          c.useTransaction(trx)
          c.estado = 'APROBADA'
          c.aprobadoAt = ahora
          c.aprobadoPor = usuarioId
          await c.save()
          idsActualizadas.push(c.id)
        }
      } else {
        const fechaPagoDt = fechaPago ? DateTime.fromISO(fechaPago) : ahora
        const fechaPagoFinal = fechaPagoDt.isValid ? fechaPagoDt : ahora

        const comisiones = await Comision.query({ client: trx })
          .whereIn('id', idsNumericos)
          .where('es_config', false)
          .whereIn('estado', ['PENDIENTE', 'APROBADA'])

        const comisionesRtmPagadas: Comision[] = []

        for (const c of comisiones) {
          c.useTransaction(trx)
          if (!c.aprobadoAt) {
            c.aprobadoAt = ahora
            c.aprobadoPor = usuarioId
          }
          c.estado = 'PAGADA'
          c.pagadoAt = fechaPagoFinal
          c.pagadoPor = usuarioId
          await c.save()
          idsActualizadas.push(c.id)
          if (c.tipoServicio === 'RTM') comisionesRtmPagadas.push(c)
        }

        // Historial de liquidaciones: un registro por CADA pago ejecutado
        // (sin importar el origen), pero SOLO sobre comisiones RTM (mismo
        // alcance que el modal de Liquidar) y SOLO para PAGAR, no APROBAR.
        // Si el batch pagado no trae ninguna comisión RTM, no se crea evento.
        if (comisionesRtmPagadas.length > 0) {
          const detalle = comisionesRtmPagadas.map((c) => ({
            comisionId: c.id,
            monto: toNumber(c.montoAsesor) + toNumber(c.montoConvenio),
          }))
          const montoTotal = detalle.reduce((acc, d) => acc + d.monto, 0)

          const fechasCalculo = comisionesRtmPagadas.map((c) => c.fechaCalculo)
          const fechaInicioModal =
            tipoOrigen === 'MODAL_LIQUIDAR' && fechaInicioRaw
              ? DateTime.fromISO(String(fechaInicioRaw))
              : null
          const fechaFinModal =
            tipoOrigen === 'MODAL_LIQUIDAR' && fechaFinRaw
              ? DateTime.fromISO(String(fechaFinRaw))
              : null
          const fechaInicio =
            fechaInicioModal && fechaInicioModal.isValid
              ? fechaInicioModal
              : DateTime.min(...fechasCalculo) ?? ahora
          const fechaFin =
            fechaFinModal && fechaFinModal.isValid
              ? fechaFinModal
              : DateTime.max(...fechasCalculo) ?? ahora

          const liquidacion = new Liquidacion()
          liquidacion.useTransaction(trx)
          liquidacion.fechaInicio = fechaInicio
          liquidacion.fechaFin = fechaFin
          liquidacion.tipoOrigen = tipoOrigen
          liquidacion.tipoPeriodo = tipoOrigen === 'MODAL_LIQUIDAR' ? tipoPeriodo : null
          liquidacion.montoTotal = montoTotal
          liquidacion.cantidadComisiones = comisionesRtmPagadas.length
          liquidacion.usuarioId = usuarioId
          await liquidacion.save()

          await LiquidacionDetalle.createMany(
            detalle.map((d) => ({
              liquidacionId: liquidacion.id,
              comisionId: d.comisionId,
              monto: d.monto,
            })),
            { client: trx }
          )
        }
      }

      await trx.commit()

      const verbo = accion === 'APROBAR' ? 'aprobada(s)' : 'pagada(s)'
      return response.ok({
        actualizadas: idsActualizadas.length,
        ids_actualizadas: idsActualizadas,
        mensaje: `${idsActualizadas.length} comisión(es) ${verbo} exitosamente`,
      })
    } catch (err) {
      await trx.rollback()
      throw err
    }
  }

  /**
   * GET /comisiones/resumen-por-asesor?tipo=&fecha_inicio=&fecha_fin=
   * Resumen de comisiones agrupado por asesor (y convenio) para alimentar
   * la lista expandible de "pagos masivos" del frontend.
   */
  public async resumenPorAsesor({ request, response }: HttpContext) {
    const tipo = request.input('tipo') as string | undefined
    if (!tipo || !['ASESOR_COMERCIAL', 'ASESOR_CONVENIO', 'CONVENIO'].includes(tipo)) {
      return response.badRequest({
        message: 'tipo debe ser ASESOR_COMERCIAL, ASESOR_CONVENIO o CONVENIO',
      })
    }

    const fechaInicio = request.input('fecha_inicio') as string | undefined
    const fechaFin = request.input('fecha_fin') as string | undefined
    // 🆕 Mismos filtros que index()/resumen(), para que el acordeón por
    // asesor no ignore lo que ya está filtrando el resto de la pantalla.
    const estado = request.input('estado') as string | undefined
    const tipoVehiculo = request.input('tipoVehiculo') as string | undefined
    const placa = request.input('placa') as string | undefined
    const asesorId = request.input('asesorId') as number | undefined
    const convenioId = request.input('convenioId') as number | undefined
    const tipoCaptacion = request.input('tipoCaptacion') as string | undefined // 🆕

    const query = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .leftJoin('convenios as conv', 'conv.id', 'c.convenio_id')
      .where('c.es_config', false)

    if (tipo === 'CONVENIO') {
      query.whereNotNull('c.convenio_id')
    } else {
      query.where('a.tipo', tipo)
    }

    if (fechaInicio && fechaFin) {
      query.whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
    }
    if (estado) query.where('c.estado', estado)
    if (tipoVehiculo && ['MOTO', 'VEHICULO'].includes(tipoVehiculo.toUpperCase()))
      query.where('c.tipo_vehiculo', tipoVehiculo.toUpperCase())
    if (placa) {
      const placaNorm = placa.replace(/[\s-]/g, '').toUpperCase()
      query.whereIn(
        'c.captacion_dateo_id',
        Database.from('captacion_dateos as cd')
          .join('turnos_rtms as t', 't.id', 'cd.consumido_turno_id')
          .whereRaw("REPLACE(REPLACE(UPPER(t.placa), '-', ''), ' ', '') = ?", [placaNorm])
          .select('cd.id')
      )
    }
    if (asesorId) query.where('c.asesor_id', asesorId)
    if (convenioId) query.where('c.convenio_id', convenioId)
    if (tipoCaptacion === 'NUEVO_DIRECTO') query.whereNull('c.convenio_id')
    else if (tipoCaptacion === 'CONVENIO') query.whereNotNull('c.convenio_id')

    const rows = (await query
      .select(
        'a.id as asesor_id',
        'a.nombre as asesor_nombre',
        'a.tipo as asesor_tipo',
        'conv.id as convenio_id',
        'conv.nombre as convenio_nombre'
      )
      .select(Database.raw("COUNT(CASE WHEN c.estado = 'PENDIENTE' THEN 1 END) as pendientes"))
      .select(Database.raw("COUNT(CASE WHEN c.estado = 'APROBADA' THEN 1 END) as aprobadas"))
      .select(Database.raw("COUNT(CASE WHEN c.estado = 'PAGADA' THEN 1 END) as pagadas"))
      .select(
        Database.raw(
          "SUM(CASE WHEN c.estado IN ('PENDIENTE','APROBADA') THEN c.monto ELSE 0 END) as total_por_pagar"
        )
      )
      .select(Database.raw("SUM(CASE WHEN c.estado = 'PENDIENTE' THEN c.monto ELSE 0 END) as total_pendiente"))
      .select(Database.raw("SUM(CASE WHEN c.estado = 'APROBADA' THEN c.monto ELSE 0 END) as total_aprobada"))
      .groupBy('a.id', 'a.nombre', 'a.tipo', 'conv.id', 'conv.nombre')
      .havingRaw(
        estado
          ? "COUNT(CASE WHEN c.estado = ? THEN 1 END) > 0"
          : "COUNT(CASE WHEN c.estado = 'PENDIENTE' THEN 1 END) + COUNT(CASE WHEN c.estado = 'APROBADA' THEN 1 END) > 0",
        estado ? [estado] : []
      )
      .orderBy('total_por_pagar', 'desc')) as any[]

    const asesores = rows.map((r) => ({
      asesor_id: Number(r.asesor_id),
      asesor_nombre: r.asesor_nombre,
      asesor_tipo: r.asesor_tipo,
      convenio_id: r.convenio_id !== null ? Number(r.convenio_id) : null,
      convenio_nombre: r.convenio_nombre ?? null,
      pendientes: Number(r.pendientes),
      aprobadas: Number(r.aprobadas),
      pagadas: Number(r.pagadas),
      total_por_pagar: Number(r.total_por_pagar) || 0,
      total_pendiente: Number(r.total_pendiente) || 0,
      total_aprobada: Number(r.total_aprobada) || 0,
    }))

    return response.ok({ tipo, asesores })
  }

  /**
   * POST /api/comisiones
   */
  public async store({ request, response }: HttpContext) {
    const payload = request.only([
      'turno_id',
      'asesor_id',
      'convenio_id',
      'monto_asesor',
      'monto_convenio',
      'tipo_cliente',
      'descuento_id',
      'dateo_observacion',
      'es_avance',
    ])

    const turnoId = Number(payload.turno_id)
    if (!turnoId) return response.badRequest({ message: 'turno_id es requerido' })

    const turno = await TurnoRtm.query().where('id', turnoId).preload('servicio').first()

    if (!turno) return response.notFound({ message: 'Turno no encontrado' })

    const { default: CaptacionDateo } = await import('#models/captacion_dateo')

    let captacionDateoId: number | null = (turno as any).captacionDateoId ?? null

    if (!captacionDateoId) {
      // Detectar canal según tipo de asesor
      let canalNuevo: string = 'ASESOR_COMERCIAL'
      if (payload.asesor_id) {
        const asesorNuevo = await AgenteCaptacion.find(Number(payload.asesor_id))
        const tipoNuevo = String(asesorNuevo?.tipo ?? '').toUpperCase()
        if (tipoNuevo.includes('CONVENIO')) canalNuevo = 'ASESOR_CONVENIO'
      }

      const nuevaDateo = await CaptacionDateo.create({
        canal: canalNuevo as any,
        agenteId: payload.asesor_id ? Number(payload.asesor_id) : null,
        convenioId: payload.convenio_id ? Number(payload.convenio_id) : null,
        placa: turno.placa,
        origen: 'UI',
        resultado: 'EN_PROCESO',
        consumidoTurnoId: turno.id,
        consumidoAt: DateTime.now(),
        observacion: payload.dateo_observacion || null,
        esAvance: Boolean(payload.es_avance),
      } as any)
      captacionDateoId = nuevaDateo.id
      ;(turno as any).captacionDateoId = captacionDateoId
      await turno.save()
    } else {
      // Corregir el canal si quedó mal (FACHADA) por creaciones anteriores
      let canalCorrecto: string = 'ASESOR_COMERCIAL'
      if (payload.asesor_id) {
        const asesorExistente = await AgenteCaptacion.find(Number(payload.asesor_id))
        const tipoAsesor = String(asesorExistente?.tipo ?? '').toUpperCase()
        if (tipoAsesor.includes('CONVENIO')) canalCorrecto = 'ASESOR_CONVENIO'
      }

      const updateData: Record<string, unknown> = { canal: canalCorrecto }
      if (payload.dateo_observacion !== undefined) {
        updateData.observacion = payload.dateo_observacion || null
      }

      await CaptacionDateo.query()
        .where('id', captacionDateoId)
        .update(updateData as any)
    }

    const comisionExistente = await Comision.query()
      .where('captacion_dateo_id', captacionDateoId!)
      .where('es_config', false)
      .whereNot('estado', 'ANULADA')
      .first()

    if (comisionExistente) {
      return response.unprocessableEntity({
        message: `Ya existe una comisión activa (id: ${comisionExistente.id}, estado: ${comisionExistente.estado}) para este turno.`,
      })
    }

    if (payload.tipo_cliente) {
      ;(turno as any).esRecurrente = payload.tipo_cliente === 'RECURRENTE'
      ;(turno as any).esRecuperacion = payload.tipo_cliente === 'RECUPERACION'
      await turno.save()
    }

    const tipoVehiculo = turno.tipoVehiculo?.includes('Motocicleta') ? 'MOTO' : 'VEHICULO'
    const tipoServicio = ((turno as any).servicio?.codigoServicio ?? 'RTM').toUpperCase()
    const montoAsesor = Math.max(0, toNumber(payload.monto_asesor ?? 0))
    const montoConvenio = Math.max(0, toNumber(payload.monto_convenio ?? 0))

    const comision = new Comision()
    comision.esConfig = false
    comision.captacionDateoId = captacionDateoId
    comision.asesorId = payload.asesor_id ? Number(payload.asesor_id) : null
    comision.convenioId = payload.convenio_id ? Number(payload.convenio_id) : null
    comision.montoAsesor = String(montoAsesor)
    comision.montoConvenio = String(montoConvenio)
    comision.monto = String(montoAsesor)
    comision.base = String(montoConvenio)
    comision.porcentaje = '0'
    comision.tipoServicio = tipoServicio as any
    ;(comision as any).tipoVehiculo = tipoVehiculo
    comision.estado = 'PENDIENTE'
    comision.fechaCalculo = DateTime.now()
    ;(comision as any).esAvance = Boolean(payload.es_avance)

    if (payload.descuento_id) {
      const { default: Descuento } = await import('#models/descuento')
      const desc = await Descuento.query()
        .where('id', Number(payload.descuento_id))
        .where('activo', true)
        .first()
      if (!desc) return response.badRequest({ message: 'Descuento no válido o inactivo' })
      ;(comision as any).descuentoId = Number(payload.descuento_id)
    }

    await comision.save()
    return this.show({ params: { id: comision.id }, response } as any)
  }
  /* ============================================================
   *          CONFIGURACIONES DE COMISIONES (es_config = true)
   * ============================================================*/

  public async configsIndex({ request, response }: HttpContext) {
    const asesorId = request.input('asesorId') as number | undefined
    const tipoVehiculo = request.input('tipoVehiculo') as string | undefined

    const query = Comision.query().where('es_config', true)
    if (asesorId) query.where('asesor_id', asesorId)
    if (tipoVehiculo) query.where('tipo_vehiculo', tipoVehiculo)
    query.orderBy('asesor_id', 'asc').orderBy('tipo_vehiculo', 'asc')

    const result = await query
    return response.ok({ data: result.map((c) => mapConfigToDto(c)) })
  }

  public async configsUpsert({ request, response }: HttpContext) {
    const payload = request.only([
      'asesor_id',
      'tipo_vehiculo',
      'valor_placa',
      'valor_placa_vehiculo',
      'valor_placa_moto',
      'valor_dateo',
      'valor_nuevo_directo',
      'meta_rtm',
      'porcentaje_comision_meta',
    ])

    const asesorIdRaw = payload.asesor_id
    const asesorId = asesorIdRaw ? Number(asesorIdRaw) : null
    const tipoVehiculo = (payload.tipo_vehiculo || '').toUpperCase()

    if (!['MOTO', 'VEHICULO'].includes(tipoVehiculo))
      return response.badRequest({ message: 'tipo_vehiculo inválido (MOTO o VEHICULO)' })

    const valorPlaca = Math.max(0, toNumber(payload.valor_placa))
    const valorDateo = Math.max(0, toNumber(payload.valor_dateo))
    const valorNuevoDirecto = Math.max(0, toNumber(payload.valor_nuevo_directo ?? 0))
    const valorPlacaVehiculo = parseNullable(payload.valor_placa_vehiculo)
    const valorPlacaMoto = parseNullable(payload.valor_placa_moto)

    const existingQuery = Comision.query()
      .where('es_config', true)
      .where('tipo_vehiculo', tipoVehiculo)

    if (asesorId === null) existingQuery.whereNull('asesor_id')
    else existingQuery.where('asesor_id', asesorId)

    let comision = await existingQuery.first()

    if (!comision) {
      comision = new Comision()
      comision.esConfig = true
      comision.captacionDateoId = null
      comision.asesorId = asesorId
      comision.convenioId = null
      comision.tipoServicio = 'OTRO'
      ;(comision as any).tipoVehiculo = tipoVehiculo
      comision.porcentaje = '0'
      comision.estado = 'PENDIENTE'
      comision.fechaCalculo = DateTime.now()
      comision.metaRtm = 0
      comision.porcentajeComisionMeta = '0'
      comision.valorRtmMoto = 0
      comision.valorRtmVehiculo = 0
    }

    comision.base = String(valorPlaca)
    comision.monto = String(valorDateo)
    comision.valorNuevoDirecto = String(valorNuevoDirecto)
    comision.valorPlacaVehiculo = valorPlacaVehiculo !== null ? String(valorPlacaVehiculo) : null
    comision.valorPlacaMoto = valorPlacaMoto !== null ? String(valorPlacaMoto) : null

    if (payload.meta_rtm !== undefined) comision.metaRtm = Math.max(0, toNumber(payload.meta_rtm))
    if (payload.porcentaje_comision_meta !== undefined)
      comision.porcentajeComisionMeta = String(
        Math.max(0, toNumber(payload.porcentaje_comision_meta))
      )

    await comision.save()
    return response.ok(mapConfigToDto(comision))
  }

  public async configsUpdate({ params, request, response }: HttpContext) {
    const comision = await Comision.find(params.id)
    if (!comision || !comision.esConfig)
      return response.notFound({ message: 'Configuración no encontrada' })

    const payload = request.only([
      'asesor_id',
      'tipo_vehiculo',
      'valor_placa',
      'valor_placa_vehiculo',
      'valor_placa_moto',
      'valor_dateo',
      'valor_nuevo_directo',
      'meta_rtm',
      'porcentaje_comision_meta',
    ])

    if (payload.asesor_id !== undefined)
      comision.asesorId = payload.asesor_id ? Number(payload.asesor_id) : null

    if (payload.tipo_vehiculo) {
      const tipoVehiculo = String(payload.tipo_vehiculo).toUpperCase()
      if (!['MOTO', 'VEHICULO'].includes(tipoVehiculo))
        return response.badRequest({ message: 'tipo_vehiculo inválido (MOTO o VEHICULO)' })
      ;(comision as any).tipoVehiculo = tipoVehiculo
    }

    if (payload.valor_placa !== undefined)
      comision.base = String(Math.max(0, toNumber(payload.valor_placa)))
    if (payload.valor_dateo !== undefined)
      comision.monto = String(Math.max(0, toNumber(payload.valor_dateo)))
    if (payload.valor_nuevo_directo !== undefined)
      comision.valorNuevoDirecto = String(Math.max(0, toNumber(payload.valor_nuevo_directo)))
    if (payload.valor_placa_vehiculo !== undefined) {
      const v = parseNullable(payload.valor_placa_vehiculo)
      comision.valorPlacaVehiculo = v !== null ? String(v) : null
    }
    if (payload.valor_placa_moto !== undefined) {
      const v = parseNullable(payload.valor_placa_moto)
      comision.valorPlacaMoto = v !== null ? String(v) : null
    }
    if (payload.meta_rtm !== undefined) comision.metaRtm = Math.max(0, toNumber(payload.meta_rtm))
    if (payload.porcentaje_comision_meta !== undefined)
      comision.porcentajeComisionMeta = String(
        Math.max(0, toNumber(payload.porcentaje_comision_meta))
      )

    await comision.save()
    return response.ok(mapConfigToDto(comision))
  }

  public async configsDestroy({ params, response }: HttpContext) {
    const comision = await Comision.find(params.id)
    if (!comision || !comision.esConfig)
      return response.notFound({ message: 'Configuración no encontrada' })
    await comision.delete()
    return response.ok({ message: 'Configuración eliminada correctamente' })
  }

  /* ============================================================
   *          METAS MENSUALES
   * ============================================================*/

  public async metasIndex({ request, response }: HttpContext) {
    const asesorId = request.input('asesorId') as number | undefined
    const tipoVehiculo = request.input('tipoVehiculo') as string | undefined

    const q = Comision.query()
      .where('es_config', true)
      .where((wb) => {
        wb.where('meta_rtm', '>', 0)
          .orWhere('valor_rtm_moto', '>', 0)
          .orWhere('valor_rtm_vehiculo', '>', 0)
      })
    if (asesorId) q.where('asesor_id', asesorId)
    if (tipoVehiculo) q.where('tipo_vehiculo', tipoVehiculo)
    q.orderBy('asesor_id', 'asc').orderBy('tipo_vehiculo', 'asc')

    const rows = await q
    return response.ok({ data: rows.map((c) => mapMetaToDto(c)) })
  }

  public async metasUpsert({ request, response }: HttpContext) {
    const payload = request.only([
      'asesor_id',
      'tipo_vehiculo',
      'meta_mensual',
      'porcentaje_extra',
      'valor_rtm_moto',
      'valor_rtm_vehiculo',
    ])

    const asesorIdRaw = payload.asesor_id
    const asesorId = asesorIdRaw ? Number(asesorIdRaw) : null

    const rawTipo = payload.tipo_vehiculo
    let tipoVehiculo: string | null = null
    if (rawTipo !== undefined && rawTipo !== null && String(rawTipo).trim() !== '') {
      const tv = String(rawTipo).toUpperCase()
      if (!['MOTO', 'VEHICULO'].includes(tv))
        return response.badRequest({
          message: 'tipo_vehiculo inválido (MOTO o VEHICULO o vacío para Global)',
        })
      tipoVehiculo = tv
    }

    const metaMensual = Math.max(0, toNumber(payload.meta_mensual))
    const porcentajeExtra = Math.max(0, toNumber(payload.porcentaje_extra))
    const valorRtmMoto = Math.max(0, toNumber(payload.valor_rtm_moto))
    const valorRtmVehiculo = Math.max(0, toNumber(payload.valor_rtm_vehiculo))

    const existingQuery = Comision.query().where('es_config', true)
    if (tipoVehiculo === null) existingQuery.whereNull('tipo_vehiculo')
    else existingQuery.where('tipo_vehiculo', tipoVehiculo)
    if (asesorId === null) existingQuery.whereNull('asesor_id')
    else existingQuery.where('asesor_id', asesorId)

    let comision = await existingQuery.first()

    if (!comision) {
      comision = new Comision()
      comision.esConfig = true
      comision.captacionDateoId = null
      comision.asesorId = asesorId
      comision.convenioId = null
      comision.tipoServicio = 'OTRO'
      ;(comision as any).tipoVehiculo = tipoVehiculo
      comision.base = '0'
      comision.monto = '0'
      comision.valorNuevoDirecto = '0'
      comision.valorPlacaVehiculo = null
      comision.valorPlacaMoto = null
      comision.porcentaje = '0'
      comision.estado = 'PENDIENTE'
      comision.fechaCalculo = DateTime.now()
      comision.metaRtm = 0
      comision.porcentajeComisionMeta = '0'
      comision.valorRtmMoto = 0
      comision.valorRtmVehiculo = 0
    }

    comision.metaRtm = metaMensual
    comision.porcentajeComisionMeta = String(porcentajeExtra)
    comision.valorRtmMoto = valorRtmMoto
    comision.valorRtmVehiculo = valorRtmVehiculo

    await comision.save()
    return response.ok(mapMetaToDto(comision))
  }

  public async metasUpdate({ params, request, response }: HttpContext) {
    const comision = await Comision.find(params.id)
    if (!comision || !comision.esConfig)
      return response.notFound({ message: 'Meta mensual no encontrada' })

    const payload = request.only([
      'asesor_id',
      'tipo_vehiculo',
      'meta_mensual',
      'porcentaje_extra',
      'valor_rtm_moto',
      'valor_rtm_vehiculo',
    ])

    if (payload.asesor_id !== undefined)
      comision.asesorId = payload.asesor_id ? Number(payload.asesor_id) : null

    if (payload.tipo_vehiculo !== undefined) {
      const rawTipo = payload.tipo_vehiculo
      if (rawTipo === null || String(rawTipo).trim() === '') {
        ;(comision as any).tipoVehiculo = null
      } else {
        const tv = String(rawTipo).toUpperCase()
        if (!['MOTO', 'VEHICULO'].includes(tv))
          return response.badRequest({
            message: 'tipo_vehiculo inválido (MOTO o VEHICULO o vacío para Global)',
          })
        ;(comision as any).tipoVehiculo = tv
      }
    }

    if (payload.meta_mensual !== undefined)
      comision.metaRtm = Math.max(0, toNumber(payload.meta_mensual))
    if (payload.porcentaje_extra !== undefined)
      comision.porcentajeComisionMeta = String(Math.max(0, toNumber(payload.porcentaje_extra)))
    if (payload.valor_rtm_moto !== undefined)
      comision.valorRtmMoto = Math.max(0, toNumber(payload.valor_rtm_moto))
    if (payload.valor_rtm_vehiculo !== undefined)
      comision.valorRtmVehiculo = Math.max(0, toNumber(payload.valor_rtm_vehiculo))

    await comision.save()
    return response.ok(mapMetaToDto(comision))
  }

  public async metasDestroy({ params, response }: HttpContext) {
    const comision = await Comision.find(params.id)
    if (!comision || !comision.esConfig)
      return response.notFound({ message: 'Meta mensual no encontrada' })
    await comision.delete()
    return response.ok({ success: true })
  }

  /* ============================================================
   *   CONFIGURACIÓN DE RECURRENCIAS
   * ============================================================*/

  public async recurrenciaConfigGlobalGet({ response }: HttpContext) {
    const { default: ConfiguracionRecurrenciaGlobal } = await import(
      '#models/configuracion_recurrencia_global'
    )

    let config = await ConfiguracionRecurrenciaGlobal.query().first()
    if (!config) {
      config = await ConfiguracionRecurrenciaGlobal.create({
        mesesMinimos: 24,
        valorDateoRecurrencia: 4300,
        valorDateoRecuperacion: 8600,
      } as any)
    }

    return response.ok({
      meses_minimos: config.mesesMinimos,
      valor_dateo_recurrencia: config.valorDateoRecurrencia,
      valor_dateo_recuperacion: config.valorDateoRecuperacion ?? 8600,
      valor_dateo_recurrencia_vehiculo: (config as any).valorDateoRecurrenciaVehiculo ?? null,
      valor_dateo_recurrencia_moto: (config as any).valorDateoRecurrenciaMoto ?? null,
      valor_dateo_recuperacion_vehiculo: (config as any).valorDateoRecuperacionVehiculo ?? null,
      valor_dateo_recuperacion_moto: (config as any).valorDateoRecuperacionMoto ?? null,
    })
  }

  public async recurrenciaConfigGlobalUpsert({ request, response }: HttpContext) {
    const { default: ConfiguracionRecurrenciaGlobal } = await import(
      '#models/configuracion_recurrencia_global'
    )

    const payload = request.only([
      'meses_minimos',
      'valor_dateo_recurrencia',
      'valor_dateo_recuperacion',
      'valor_dateo_recurrencia_vehiculo',
      'valor_dateo_recurrencia_moto',
      'valor_dateo_recuperacion_vehiculo',
      'valor_dateo_recuperacion_moto',
    ])

    const mesesMinimos = Math.max(1, toNumber(payload.meses_minimos))
    const valorDateoRecurrencia = Math.max(0, toNumber(payload.valor_dateo_recurrencia))
    const valorDateoRecuperacion = Math.max(0, toNumber(payload.valor_dateo_recuperacion ?? 8600))
    const valorDateoRecurrenciaVehiculo = parseNullable(payload.valor_dateo_recurrencia_vehiculo)
    const valorDateoRecurrenciaMoto = parseNullable(payload.valor_dateo_recurrencia_moto)
    const valorDateoRecuperacionVehiculo = parseNullable(payload.valor_dateo_recuperacion_vehiculo)
    const valorDateoRecuperacionMoto = parseNullable(payload.valor_dateo_recuperacion_moto)

    let config = await ConfiguracionRecurrenciaGlobal.query().first()

    if (!config) {
      config = await ConfiguracionRecurrenciaGlobal.create({
        mesesMinimos,
        valorDateoRecurrencia,
        valorDateoRecuperacion,
        valorDateoRecurrenciaVehiculo,
        valorDateoRecurrenciaMoto,
        valorDateoRecuperacionVehiculo,
        valorDateoRecuperacionMoto,
      } as any)
    } else {
      config.mesesMinimos = mesesMinimos
      config.valorDateoRecurrencia = valorDateoRecurrencia
      config.valorDateoRecuperacion = valorDateoRecuperacion
      config.valorDateoRecurrenciaVehiculo = valorDateoRecurrenciaVehiculo
      config.valorDateoRecurrenciaMoto = valorDateoRecurrenciaMoto
      config.valorDateoRecuperacionVehiculo = valorDateoRecuperacionVehiculo
      config.valorDateoRecuperacionMoto = valorDateoRecuperacionMoto
      await config.save()
    }

    return response.ok({
      meses_minimos: config.mesesMinimos,
      valor_dateo_recurrencia: config.valorDateoRecurrencia,
      valor_dateo_recuperacion: config.valorDateoRecuperacion,
      valor_dateo_recurrencia_vehiculo: (config as any).valorDateoRecurrenciaVehiculo ?? null,
      valor_dateo_recurrencia_moto: (config as any).valorDateoRecurrenciaMoto ?? null,
      valor_dateo_recuperacion_vehiculo: (config as any).valorDateoRecuperacionVehiculo ?? null,
      valor_dateo_recuperacion_moto: (config as any).valorDateoRecuperacionMoto ?? null,
    })
  }

  public async recurrenciaConfigAsesoresIndex({ request, response }: HttpContext) {
    const { default: ConfiguracionRecurrenciaAsesor } = await import(
      '#models/configuracion_recurrencia_asesor'
    )

    const asesorId = request.input('asesorId') as number | undefined
    const query = ConfiguracionRecurrenciaAsesor.query().preload('asesor')
    if (asesorId) query.where('asesor_id', asesorId)

    const configs = await query
    const data = configs.map((c) => {
      const asesor = (c as any).$preloaded?.asesor || null
      return {
        id: c.id,
        asesor_id: c.asesorId,
        asesor_nombre: asesor ? asesor.nombre : null,
        recurrencia_habilitada: c.recurrenciaHabilitada,
        meses_minimos: c.mesesMinimos,
        valor_dateo_recurrencia: c.valorDateoRecurrencia,
        valor_dateo_recuperacion: c.valorDateoRecuperacion,
        tipo_vehiculo: c.tipoVehiculo,
      }
    })

    return response.ok({ data })
  }

  public async recurrenciaConfigAsesoresUpsert({ request, response }: HttpContext) {
    const { default: ConfiguracionRecurrenciaAsesor } = await import(
      '#models/configuracion_recurrencia_asesor'
    )

    const payload = request.only([
      'asesor_id',
      'recurrencia_habilitada',
      'meses_minimos',
      'valor_dateo_recurrencia',
      'valor_dateo_recuperacion',
      'tipo_vehiculo',
    ])

    const asesorId = Number(payload.asesor_id)
    if (!asesorId) return response.badRequest({ message: 'asesor_id es requerido' })

    const recurrenciaHabilitada = Boolean(payload.recurrencia_habilitada)
    const mesesMinimos =
      payload.meses_minimos !== null ? Math.max(1, toNumber(payload.meses_minimos)) : null
    const valorDateoRecurrencia =
      payload.valor_dateo_recurrencia !== null
        ? Math.max(0, toNumber(payload.valor_dateo_recurrencia))
        : null
    const valorDateoRecuperacion =
      payload.valor_dateo_recuperacion !== null
        ? Math.max(0, toNumber(payload.valor_dateo_recuperacion))
        : null
    const tipoVehiculo = String(payload.tipo_vehiculo || 'AMBOS').toUpperCase()
    if (!['MOTO', 'VEHICULO', 'AMBOS'].includes(tipoVehiculo))
      return response.badRequest({ message: 'tipo_vehiculo debe ser MOTO, VEHICULO o AMBOS' })

    let config = await ConfiguracionRecurrenciaAsesor.query()
      .where('asesor_id', asesorId)
      .where('tipo_vehiculo', tipoVehiculo as any)
      .first()

    if (!config) {
      config = await ConfiguracionRecurrenciaAsesor.create({
        asesorId,
        recurrenciaHabilitada,
        mesesMinimos,
        valorDateoRecurrencia,
        valorDateoRecuperacion,
        tipoVehiculo: tipoVehiculo as any,
      })
    } else {
      config.recurrenciaHabilitada = recurrenciaHabilitada
      config.mesesMinimos = mesesMinimos
      config.valorDateoRecurrencia = valorDateoRecurrencia
      config.valorDateoRecuperacion = valorDateoRecuperacion
      await config.save()
    }

    await config.load('asesor')
    const asesor = (config as any).$preloaded?.asesor || null

    return response.ok({
      id: config.id,
      asesor_id: config.asesorId,
      asesor_nombre: asesor ? asesor.nombre : null,
      recurrencia_habilitada: config.recurrenciaHabilitada,
      meses_minimos: config.mesesMinimos,
      valor_dateo_recurrencia: config.valorDateoRecurrencia,
      valor_dateo_recuperacion: config.valorDateoRecuperacion,
      tipo_vehiculo: config.tipoVehiculo,
    })
  }

  public async recurrenciaConfigAsesoresDelete({ params, response }: HttpContext) {
    const { default: ConfiguracionRecurrenciaAsesor } = await import(
      '#models/configuracion_recurrencia_asesor'
    )

    const config = await ConfiguracionRecurrenciaAsesor.find(params.id)
    if (!config) return response.notFound({ message: 'Configuración no encontrada' })

    await config.delete()
    return response.ok({ message: 'Configuración eliminada correctamente' })
  }
}
