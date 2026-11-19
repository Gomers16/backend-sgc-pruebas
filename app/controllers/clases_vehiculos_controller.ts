// app/Controllers/Http/clases_vehiculos_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import ClaseVehiculo from '#models/clase_vehiculos'

export default class ClasesVehiculosController {
  /**
   * GET /clases-vehiculo?page=1&perPage=20&q=taxi
   */
  public async index({ request }: HttpContext) {
    const page = Number(request.input('page', 1))
    const perPage = Math.min(Number(request.input('perPage', 20)), 100)
    const q = (request.input('q', '') as string).trim()

    const query = ClaseVehiculo.query().orderBy('id', 'asc')

    if (q) {
      query.where('codigo', 'like', `%${q}%`).orWhere('nombre', 'like', `%${q}%`)
    }

    return await query.paginate(page, perPage)
  }

  /**
   * GET /clases-vehiculo/:id
   */
  public async show({ params, response }: HttpContext) {
    const item = await ClaseVehiculo.find(params.id)
    if (!item) return response.notFound({ message: 'Clase de vehículo no encontrada' })
    return item
  }

  /**
   * POST /clases-vehiculo
   * body: { codigo, nombre }
   */
  public async store({ request, response }: HttpContext) {
    const { codigo, nombre } = request.only(['codigo', 'nombre'])

    if (!codigo || !nombre) {
      return response.badRequest({ message: 'codigo y nombre son requeridos' })
    }

    const exists = await ClaseVehiculo.findBy('codigo', codigo)
    if (exists) return response.conflict({ message: 'El código ya existe' })

    const created = await ClaseVehiculo.create({
      codigo: String(codigo).trim(),
      nombre: String(nombre).trim(),
    })
    return response.created(created)
  }

  /**
   * PUT /clases-vehiculo/:id
   * body parcial: { codigo?, nombre? }
   */
  public async update({ params, request, response }: HttpContext) {
    const item = await ClaseVehiculo.find(params.id)
    if (!item) return response.notFound({ message: 'Clase de vehículo no encontrada' })

    const { codigo, nombre } = request.only(['codigo', 'nombre'])

    if (codigo && codigo !== item.codigo) {
      const same = await ClaseVehiculo.query()
        .where('codigo', codigo)
        .whereNot('id', item.id)
        .first()
      if (same) return response.conflict({ message: 'El código ya está en uso' })
      item.codigo = String(codigo).trim()
    }

    if (typeof nombre === 'string' && nombre.trim() !== '') {
      item.nombre = nombre.trim()
    }

    await item.save()
    return item
  }

  /**
   * DELETE /clases-vehiculo/:id
   * Protegido: no permite borrar si hay vehículos que usan esta clase.
   */
  public async destroy({ params, response }: HttpContext) {
    const item = await ClaseVehiculo.find(params.id)
    if (!item) return response.notFound({ message: 'Clase de vehículo no encontrada' })

    const [{ total }] = await db
      .from('vehiculos')
      .where('clase_vehiculo_id', params.id)
      .count('* as total')
    if (Number(total) > 0) {
      return response.conflict({
        message:
          'No se puede eliminar: existen vehículos asociados a esta clase. Cambia la clase de esos vehículos primero.',
      })
    }

    await item.delete()
    return response.noContent()
  }
}
