// app/controllers/descuentos_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Descuento from '#models/descuento'
import FacturacionTicket from '#models/facturacion_ticket'

export default class DescuentosController {
  /**
   * Listar todos los descuentos
   */
  async index({ response }: HttpContext) {
    try {
      const descuentos = await Descuento.query().orderBy('id', 'asc')
      return response.ok({
        success: true,
        data: descuentos,
      })
    } catch (error) {
      return response.internalServerError({
        success: false,
        message: 'Error al obtener los descuentos',
        error: error.message,
      })
    }
  }

  /**
   * Obtener un descuento específico
   */
  async show({ params, response }: HttpContext) {
    try {
      const descuento = await Descuento.findOrFail(params.id)
      return response.ok({
        success: true,
        data: descuento,
      })
    } catch (error) {
      return response.notFound({
        success: false,
        message: 'Descuento no encontrado',
      })
    }
  }

  /**
   * Crear un nuevo descuento
   */
  async store({ request, response }: HttpContext) {
    try {
      const payload = request.only([
        'codigo',
        'nombre',
        'valorCarro',
        'valorMoto',
        'descripcion',
        'activo',
      ])
      const descuento = await Descuento.create(payload)

      return response.created({
        success: true,
        message: 'Descuento creado exitosamente',
        data: descuento,
      })
    } catch (error) {
      return response.badRequest({
        success: false,
        message: 'Error al crear el descuento',
        error: error.message,
      })
    }
  }

  /**
   * Actualizar un descuento existente
   */
  async update({ params, request, response }: HttpContext) {
    try {
      const descuento = await Descuento.findOrFail(params.id)
      const payload = request.only([
        'codigo',
        'nombre',
        'valorCarro',
        'valorMoto',
        'descripcion',
        'activo',
      ])

      descuento.merge(payload)
      await descuento.save()

      return response.ok({
        success: true,
        message: 'Descuento actualizado exitosamente',
        data: descuento,
      })
    } catch (error) {
      return response.badRequest({
        success: false,
        message: 'Error al actualizar el descuento',
        error: error.message,
      })
    }
  }

  /**
   * Eliminar un descuento
   */
  async destroy({ params, response }: HttpContext) {
    try {
      const descuento = await Descuento.findOrFail(params.id)

      // Desactivar en lugar de eliminar
      descuento.activo = false
      await descuento.save()

      return response.ok({
        success: true,
        message: 'Descuento desactivado exitosamente',
      })
    } catch (error) {
      return response.badRequest({
        success: false,
        message: 'Error al desactivar el descuento',
      })
    }
  }

  /**
   * Obtener descuentos activos
   */
  async activos({ response }: HttpContext) {
    try {
      const descuentos = await Descuento.query().where('activo', true).orderBy('nombre', 'asc')
      return response.ok({
        success: true,
        data: descuentos,
      })
    } catch (error) {
      return response.internalServerError({
        success: false,
        message: 'Error al obtener los descuentos activos',
      })
    }
  }

  /**
   * GET /api/descuentos/historial
   *
   * Historial de todos los tickets con descuento aplicado.
   * Filtros disponibles:
   *   - fecha_desde   YYYY-MM-DD  (default: hoy)
   *   - fecha_hasta   YYYY-MM-DD  (default: hoy)
   *   - descuento_id  number
   *   - origen        'dateo' | 'caja'
   *   - placa         string
   *   - asesor_id     number  (ID del agente captación del dateo)
   *   - page          number  (default: 1)
   *   - per_page      number  (default: 50, max: 200)
   */
  async historial({ request, response }: HttpContext) {
    try {
      const fechaDesdeRaw = request.input('fecha_desde') as string | undefined
      const fechaHastaRaw = request.input('fecha_hasta') as string | undefined
      const descuentoId = request.input('descuento_id')
        ? Number(request.input('descuento_id'))
        : null
      const origen = request.input('origen') as 'dateo' | 'caja' | undefined
      const placa =
        (request.input('placa') as string | undefined)?.toUpperCase().replace(/\s+/g, '') || null
      const asesorId = request.input('asesor_id') ? Number(request.input('asesor_id')) : null
      const page = Math.max(1, Number(request.input('page') || 1))
      const perPage = Math.min(200, Math.max(1, Number(request.input('per_page') || 50)))

      // Rango de fechas en zona Colombia.
      // Se usa { zone } en el constructor (NO .setZone() después) para que
      // startOf/endOf calculen correctamente las 00:00 y 23:59:59 hora Bogotá,
      // evitando el desfase UTC que mostraba registros del día anterior.
      const hoy = DateTime.now().setZone('America/Bogota').toISODate()!
      const desde = DateTime.fromISO(fechaDesdeRaw || hoy, { zone: 'America/Bogota' }).startOf(
        'day'
      )
      const hasta = DateTime.fromISO(fechaHastaRaw || hoy, { zone: 'America/Bogota' }).endOf('day')

      if (!desde.isValid || !hasta.isValid) {
        return response.badRequest({ success: false, message: 'Fechas inválidas' })
      }

      const query = FacturacionTicket.query()
        // Solo tickets con descuento
        .whereNotNull('descuento_id')
        // Solo tickets confirmados
        .where('estado', 'CONFIRMADA')
        // Rango de fechas por confirmado_at
        .whereBetween('confirmado_at', [desde.toSQL()!, hasta.toSQL()!])
        // Relaciones para trazabilidad completa
        .preload('descuento')
        .preload('confirmedBy')
        .preload('autorizadoPor')
        .preload('turno', (tq) => {
          tq.preload('servicio').preload('captacionDateo', (dq) => {
            dq.preload('agente')
          })
        })
        .orderBy('confirmado_at', 'desc')

      // Filtros opcionales
      if (descuentoId) query.where('descuento_id', descuentoId)
      if (placa) query.where('placa_turno', placa).orWhere('placa', placa)
      if (asesorId) {
        // Filtra por el agente del dateo — requiere subquery via turno → dateo → agente
        query.whereHas('turno', (tq) => {
          tq.whereHas('captacionDateo', (dq) => {
            dq.where('agente_id', asesorId)
          })
        })
      }

      // Filtro origen (dateo = sin autorizadoPorId, caja = con autorizadoPorId)
      if (origen === 'dateo') query.whereNull('autorizado_por_id')
      if (origen === 'caja') query.whereNotNull('autorizado_por_id')

      const paginado = await query.paginate(page, perPage)
      const meta = paginado.getMeta()

      const rows = paginado.all().map((t) => {
        const anyT = t as any
        const descuento = anyT.$preloaded?.descuento ?? null
        const cajero = anyT.$preloaded?.confirmedBy ?? null
        const autoriza = anyT.$preloaded?.autorizadoPor ?? null
        const turno = anyT.$preloaded?.turno ?? null
        const dateo = turno?.$preloaded?.captacionDateo ?? null
        const agente = dateo?.$preloaded?.agente ?? null
        const servicio = turno?.$preloaded?.servicio ?? null

        // 🆕 Comprobante de avance desde el dateo
        const esAvance = Boolean(dateo?.esAvance ?? (dateo as any)?.es_avance ?? false)
        const comprobanteAvanceUrl =
          (dateo as any)?.comprobanteAvanceUrl ?? (dateo as any)?.comprobante_avance_url ?? null

        // Origen: si tiene autorizadoPorId fue aplicado en caja, si no venía del dateo
        const origenRow: 'dateo' | 'caja' = t.autorizadoPorId ? 'caja' : 'dateo'

        return {
          // Identificación del ticket
          ticket_id: t.id,
          confirmado_at: t.confirmadoAt?.toISO() ?? null,

          // Vehículo / turno
          placa: t.placaTurno ?? t.placa ?? null,
          turno_id: t.turnoId ?? null,
          turno_global: anyT.turnoNumeroGlobal ?? turno?.turnoNumero ?? null,
          turno_servicio: anyT.turnoNumeroServicio ?? turno?.turnoNumeroServicio ?? null,
          servicio_nombre: anyT.servicioNombre ?? servicio?.nombreServicio ?? null,
          servicio_codigo: anyT.servicioCodigo ?? servicio?.codigoServicio ?? null,
          tipo_vehiculo: anyT.tipoVehiculoSnapshot ?? turno?.tipoVehiculo ?? null,

          // Descuento aplicado
          descuento: descuento
            ? { id: descuento.id, codigo: descuento.codigo, nombre: descuento.nombre }
            : null,
          descuento_monto_aplicado: t.descuentoMontoAplicado ?? null,
          // 🆕 Consecutivo del descuento (lo digita caja; null en tickets anteriores)
          consecutivo_descuento: t.consecutivoDescuento ?? null,
          origen: origenRow,

          // Comercial que hizo el dateo
          comercial: agente
            ? { id: agente.id, nombre: agente.nombre, tipo: agente.tipo ?? null }
            : null,
          dateo_id: t.dateoId ?? dateo?.id ?? null,

          // Cajero que confirmó el ticket
          cajero: cajero
            ? {
                id: cajero.id,
                nombre: [cajero.nombres, cajero.apellidos].filter(Boolean).join(' '),
              }
            : null,

          // Quién autorizó el descuento (solo origen caja)
          autorizado_por: autoriza
            ? {
                id: autoriza.id,
                nombre: [autoriza.nombres, autoriza.apellidos].filter(Boolean).join(' '),
              }
            : null,

          // 🆕 Comprobante de avance (comercial solicitando en nombre del convenio)
          es_avance: esAvance,
          comprobante_avance_url: esAvance && comprobanteAvanceUrl ? comprobanteAvanceUrl : null,
        }
      })

      return response.ok({
        success: true,
        meta: {
          total: meta.total,
          page: meta.currentPage,
          per_page: meta.perPage,
          last_page: meta.lastPage,
          fecha_desde: desde.toISODate(),
          fecha_hasta: hasta.toISODate(),
        },
        data: rows,
      })
    } catch (error) {
      console.error('Error en historial de descuentos:', error)
      return response.internalServerError({
        success: false,
        message: 'Error al obtener el historial de descuentos',
        error: error.message,
      })
    }
  }
}
