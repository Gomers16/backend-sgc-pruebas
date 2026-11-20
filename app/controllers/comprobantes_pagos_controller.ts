// app/controllers/comprobantes_pago_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import ComprobantePago from '#models/comprobante_pago'
import Comision from '#models/comision'
import { sedeParaEscritura } from '#services/sede_scope'

function toNum(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

function mapDto(c: ComprobantePago) {
  return {
    id: c.id,
    numero: c.id,
    periodo_desde: c.periodoDes
      ? c.periodoDes instanceof DateTime
        ? c.periodoDes.toISODate()
        : String(c.periodoDes).substring(0, 10)
      : null,
    periodo_hasta: c.periodoHasta
      ? c.periodoHasta instanceof DateTime
        ? c.periodoHasta.toISODate()
        : String(c.periodoHasta).substring(0, 10)
      : null,
    beneficiario_tipo: c.beneficiarioTipo,
    beneficiario_id: c.beneficiarioId,
    beneficiario_nombre: c.beneficiarioNombre,
    medio_pago: c.medioPago,
    telefono: c.telefono,
    total_motos: c.totalMotos,
    total_vehiculos: c.totalVehiculos,
    total_dateo: toNum(c.totalDateo),
    total_incentivo: toNum(c.totalIncentivo),
    total_general: toNum(c.totalGeneral),
    comision_ids: c.comisionIds,
    placas_snapshot: c.placasSnapshot,
    filtro_estado: c.filtroEstado,
    filtro_tipo_vehiculo: c.filtroTipoVehiculo,
    evidencia_url: c.evidenciaUrl,
    generado_por: c.generadoPor,
    notas: c.notas,
    created_at: c.createdAt?.toISO() ?? null,
  }
}

export default class ComprobantesPagoController {
  /**
   * POST /api/comprobantes-pago
   * Crea UN comprobante por cada grupo enviado.
   *
   * Body:
   * {
   *   periodo_desde?: string        // YYYY-MM-DD
   *   periodo_hasta?: string        // YYYY-MM-DD
   *   filtro_estado?: string
   *   filtro_tipo_vehiculo?: string
   *   notas?: string
   *   groups: [{
   *     beneficiario_tipo: 'CONVENIO' | 'ASESOR'
   *     beneficiario_id?: number
   *     beneficiario_nombre: string
   *     medio_pago?: string
   *     telefono?: string
   *     total_motos: number
   *     total_vehiculos: number
   *     total_dateo: number
   *     total_incentivo: number
   *     total_general: number
   *     comision_ids: number[]
   *     placas: string[]
   *   }]
   * }
   *
   * Responde con array de comprobantes creados (uno por grupo).
   */
  public async store({ request, response, auth }: HttpContext) {
    const payload = request.only([
      'groups',
      'periodo_desde',
      'periodo_hasta',
      'filtro_estado',
      'filtro_tipo_vehiculo',
      'notas',
    ])

    const groups = Array.isArray(payload.groups) ? payload.groups : []
    if (groups.length === 0) {
      return response.badRequest({ message: 'Se requiere al menos un grupo en groups[]' })
    }

    // Multi-sede: un comprobante es de UNA sede (la activa; "todas" → 400) y
    // todas sus comisiones tienen que ser de esa sede; si alguna es de otra,
    // no se crea ninguno (409).
    const sede = sedeParaEscritura()
    const idsComisiones = [
      ...new Set(
        groups
          .flatMap((g: any) => (Array.isArray(g.comision_ids) ? g.comision_ids : []))
          .map(Number)
          .filter((n: number) => Number.isFinite(n))
      ),
    ] as number[]
    if (sede && idsComisiones.length) {
      const ajenas: Array<{ id: number }> = await Comision.querySinSede()
        .whereIn('id', idsComisiones)
        .where('es_config', false)
        .where((q: any) => q.whereNot('sede_id', sede).orWhereNull('sede_id'))
        .select('id')
      if (ajenas.length > 0) {
        return response.conflict({
          code: 'COMISIONES_DE_OTRA_SEDE',
          message: 'El comprobante incluye comisiones de otra sede.',
          ids: ajenas.map((c) => c.id),
        })
      }
    }

    const created: ReturnType<typeof mapDto>[] = []

    for (const g of groups) {
      const c = new ComprobantePago()
      c.periodoDes = payload.periodo_desde ? DateTime.fromISO(payload.periodo_desde) : null
      c.periodoHasta = payload.periodo_hasta ? DateTime.fromISO(payload.periodo_hasta) : null
      c.beneficiarioTipo = g.beneficiario_tipo === 'CONVENIO' ? 'CONVENIO' : 'ASESOR'
      c.beneficiarioId = g.beneficiario_id ? Number(g.beneficiario_id) : null
      c.beneficiarioNombre = String(g.beneficiario_nombre ?? '—')
      c.medioPago = g.medio_pago ?? null
      c.telefono = g.telefono ?? null
      c.totalMotos = Number(g.total_motos || 0)
      c.totalVehiculos = Number(g.total_vehiculos || 0)
      c.totalDateo = Number(g.total_dateo || 0)
      c.totalIncentivo = Number(g.total_incentivo || 0)
      c.totalGeneral = Number(g.total_general || 0)
      c.comisionIds = Array.isArray(g.comision_ids) ? g.comision_ids.map(Number) : []
      c.placasSnapshot = Array.isArray(g.placas) ? (g.placas as string[]).join(',') : null
      c.filtroEstado = payload.filtro_estado ?? null
      c.filtroTipoVehiculo = payload.filtro_tipo_vehiculo ?? null
      c.evidenciaUrl = null
      c.generadoPor = auth?.user?.id ?? null
      c.notas = payload.notas ?? null

      await c.save()
      created.push(mapDto(c))
    }

    return response.created({ data: created })
  }

  /**
   * GET /api/comprobantes-pago
   * Historial con filtros:
   *   - q        : búsqueda libre por placa o nombre beneficiario
   *   - numero   : número exacto del comprobante
   *   - desde    : fecha inicio de generación (YYYY-MM-DD)
   *   - hasta    : fecha fin de generación (YYYY-MM-DD)
   *   - page, perPage
   */
  public async index({ request, response }: HttpContext) {
    const page = Number(request.input('page', 1))
    const perPage = Math.min(Number(request.input('perPage', 20)), 100)

    const q = String(request.input('q', '') || '').trim()
    const numero = request.input('numero')
    const desde = request.input('desde') as string | undefined
    const hasta = request.input('hasta') as string | undefined

    const qb = ComprobantePago.query().orderBy('id', 'desc')

    if (numero && Number.isFinite(Number(numero))) {
      qb.where('id', Number(numero))
    }

    if (desde) qb.where('created_at', '>=', desde + ' 00:00:00')
    if (hasta) qb.where('created_at', '<=', hasta + ' 23:59:59')

    if (q) {
      const term = q.toUpperCase()
      qb.where((sub) => {
        sub
          .whereRaw('UPPER(beneficiario_nombre) LIKE ?', [`%${term}%`])
          .orWhereRaw('UPPER(placas_snapshot) LIKE ?', [`%${term}%`])
      })
    }

    const paginated = await qb.paginate(page, perPage)
    const meta = paginated.getMeta()

    return response.ok({
      data: paginated.all().map(mapDto),
      total: meta.total,
      page: meta.currentPage,
      perPage: meta.perPage,
    })
  }

  /**
   * GET /api/comprobantes-pago/:id
   */
  public async show({ params, response }: HttpContext) {
    const c = await ComprobantePago.find(params.id)
    if (!c) return response.notFound({ message: 'Comprobante no encontrado' })
    return response.ok(mapDto(c))
  }

  /**
   * PATCH /api/comprobantes-pago/:id/evidencia
   * Recibe la URL de la imagen ya subida vía /api/uploads/images
   * y la asocia al comprobante.
   *
   * Body: { evidencia_url: string }
   */
  public async subirEvidencia({ params, request, response }: HttpContext) {
    sedeParaEscritura() // "todas" no escribe (400)
    const c = await ComprobantePago.find(params.id)
    if (!c) return response.notFound({ message: 'Comprobante no encontrado' })

    const { evidencia_url: evidenciaUrl } = request.only(['evidencia_url'])

    if (!evidenciaUrl || !String(evidenciaUrl).trim()) {
      return response.badRequest({ message: 'evidencia_url es requerida' })
    }

    c.evidenciaUrl = String(evidenciaUrl).trim()
    await c.save()

    return response.ok(mapDto(c))
  }

  /**
   * DELETE /api/comprobantes-pago/:id/evidencia
   * Elimina la evidencia asociada al comprobante.
   */
  public async eliminarEvidencia({ params, response }: HttpContext) {
    sedeParaEscritura() // "todas" no escribe (400)
    const c = await ComprobantePago.find(params.id)
    if (!c) return response.notFound({ message: 'Comprobante no encontrado' })

    c.evidenciaUrl = null
    await c.save()

    return response.ok(mapDto(c))
  }
}
