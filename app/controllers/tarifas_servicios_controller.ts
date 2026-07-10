// app/controllers/tarifas_servicios_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Database from '@adonisjs/lucid/services/db'

import TarifaServicio, { type TipoVehiculoTarifa } from '#models/tarifa_servicio'

function toNumberOrZero(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export default class TarifasServiciosController {
  /**
   * GET /tarifas-servicios
   * Lista todas las tarifas con el código/nombre del servicio.
   */
  public async index({ response }: HttpContext) {
    const rows = (await Database.from('tarifas_servicios as ts')
      .innerJoin('servicios as s', 's.id', 'ts.servicio_id')
      .select(
        'ts.id',
        'ts.servicio_id',
        's.codigo_servicio',
        's.nombre_servicio',
        'ts.tipo_vehiculo',
        'ts.valor_base',
        'ts.valor_total',
        'ts.descripcion',
        'ts.activo',
        'ts.vigencia_desde'
      )
      .orderBy('ts.servicio_id', 'asc')
      .orderBy('ts.tipo_vehiculo', 'asc')) as any[]

    return response.ok(
      rows.map((r) => ({
        id: r.id,
        servicio_id: r.servicio_id,
        servicio_codigo: r.codigo_servicio,
        servicio_nombre: r.nombre_servicio,
        tipo_vehiculo: r.tipo_vehiculo,
        valor_base: Number(r.valor_base) || 0,
        valor_total: Number(r.valor_total) || 0,
        descripcion: r.descripcion,
        activo: !!r.activo,
        vigencia_desde: r.vigencia_desde,
      }))
    )
  }

  /**
   * POST /tarifas-servicios
   * body: { servicio_id, tipo_vehiculo, valor_base, valor_total, descripcion, vigencia_desde }
   * updateOrCreate por (servicio_id, tipo_vehiculo).
   */
  public async store({ request, response }: HttpContext) {
    const servicioId = Number(request.input('servicio_id'))
    const tipoVehiculo = request.input('tipo_vehiculo') as TipoVehiculoTarifa

    if (!servicioId || !['MOTO', 'VEHICULO'].includes(tipoVehiculo)) {
      return response.badRequest({
        message: 'servicio_id y tipo_vehiculo (MOTO | VEHICULO) son requeridos',
      })
    }

    const valorBase = toNumberOrZero(request.input('valor_base'))
    const valorTotal = toNumberOrZero(request.input('valor_total'))
    const descripcion = request.input('descripcion') ?? null
    const vigenciaDesde = request.input('vigencia_desde') ?? null

    const tarifa = await TarifaServicio.updateOrCreate(
      { servicioId, tipoVehiculo },
      {
        valorBase,
        valorTotal,
        descripcion,
        vigenciaDesde: vigenciaDesde as any,
      }
    )

    return response.ok(tarifa)
  }

  /**
   * PUT /tarifas-servicios/:id
   * Actualiza valor_base, valor_total, descripcion, activo, vigencia_desde.
   */
  public async update({ params, request, response }: HttpContext) {
    const tarifa = await TarifaServicio.find(params.id)
    if (!tarifa) return response.notFound({ message: 'Tarifa no encontrada' })

    const up = request.only(['valor_base', 'valor_total', 'descripcion', 'activo', 'vigencia_desde'])

    if ('valor_base' in up) tarifa.valorBase = toNumberOrZero(up.valor_base)
    if ('valor_total' in up) tarifa.valorTotal = toNumberOrZero(up.valor_total)
    if ('descripcion' in up) tarifa.descripcion = (up.descripcion as string) ?? null
    if ('activo' in up) tarifa.activo = Boolean(up.activo)
    if ('vigencia_desde' in up) tarifa.vigenciaDesde = (up.vigencia_desde as any) ?? null

    await tarifa.save()
    return response.ok(tarifa)
  }

  /**
   * DELETE /tarifas-servicios/:id
   */
  public async destroy({ params, response }: HttpContext) {
    const tarifa = await TarifaServicio.find(params.id)
    if (!tarifa) return response.notFound({ message: 'Tarifa no encontrada' })

    await tarifa.delete()
    return response.ok({ message: 'Tarifa eliminada' })
  }
}
