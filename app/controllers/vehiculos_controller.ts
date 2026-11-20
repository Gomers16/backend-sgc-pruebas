// app/Controllers/Http/vehiculos_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
// Imports por alias (#models): 'app/models/*.js' no resuelve en runtime y
// toda la ruta /api/vehiculos respondía 500.
import Vehiculo from '#models/vehiculo'
import ClaseVehiculo from '#models/clase_vehiculos'
import Cliente from '#models/cliente'

function normalizePlaca(raw?: string) {
  if (!raw) return ''
  return raw.replace(/[\s-]/g, '').toUpperCase()
}

function normalizePhone(raw?: string) {
  if (!raw) return undefined
  return raw.replace(/\D/g, '')
}

export default class VehiculosController {
  /**
   * GET /vehiculos?page=1&perPage=20&q=spark&clase_codigo=LIV_PART
   * Filtros:
   *  - q: busca por placa/marca/linea/modelo
   *  - clase_codigo: filtra por código de clase (LIV_PART, MOTO, etc.)
   *  - cliente_telefono: filtra por teléfono del cliente
   */
  public async index({ request }: HttpContext) {
    const page = Number(request.input('page', 1))
    const perPage = Math.min(Number(request.input('perPage', 20)), 100)
    const q = String(request.input('q', '')).trim()
    const claseCodigo = String(request.input('clase_codigo', '')).trim()
    const clienteTelefono = normalizePhone(request.input('cliente_telefono'))

    const query = Vehiculo.query().preload('clase').preload('cliente').orderBy('id', 'asc')

    if (q) {
      query.where((qb) => {
        qb.where('placa', 'like', `%${q.toUpperCase()}%`)
          .orWhere('marca', 'like', `%${q}%`)
          .orWhere('linea', 'like', `%${q}%`)
          .orWhereRaw('CAST(modelo AS CHAR) LIKE ?', [`%${q}%`])
          // opcional: también permitir búsqueda por color o matrícula
          .orWhere('color', 'like', `%${q}%`)
          .orWhere('matricula', 'like', `%${q}%`)
      })
    }

    if (claseCodigo) {
      const clase = await ClaseVehiculo.findBy('codigo', claseCodigo)
      if (clase) query.andWhere('clase_vehiculo_id', clase.id)
      else query.andWhereRaw('1=0') // si no existe ese código, devolver vacío
    }

    if (clienteTelefono) {
      const cli = await Cliente.findBy('telefono', clienteTelefono)
      if (cli) query.andWhere('cliente_id', cli.id)
      else query.andWhereRaw('1=0')
    }

    return await query.paginate(page, perPage)
  }

  /** GET /vehiculos/:id */
  public async show({ params, response }: HttpContext) {
    const item = await Vehiculo.query()
      .where('id', params.id)
      .preload('clase')
      .preload('cliente')
      .first()

    if (!item) return response.notFound({ message: 'Vehículo no encontrado' })
    return item
  }

  /**
   * POST /vehiculos
   * body: {
   *   placa,
   *   clase_codigo | clase_vehiculo_id,
   *   marca?,
   *   linea?,
   *   modelo?,
   *   color?,        // 🟢 nuevo
   *   matricula?,    // 🟢 nuevo
   *   cliente_telefono?
   * }
   */
  public async store({ request, response }: HttpContext) {
    const placa = normalizePlaca(request.input('placa'))
    const claseCodigo = request.input('clase_codigo')
    const claseIdBody = request.input('clase_vehiculo_id')
    const marca = request.input('marca')
    const linea = request.input('linea')
    const modelo = request.input('modelo')
    const clienteTelRaw = request.input('cliente_telefono')
    const clienteTelefono = normalizePhone(clienteTelRaw)

    // 🟢 nuevos campos
    const color = request.input('color')
    const matricula = request.input('matricula')

    if (!placa) return response.badRequest({ message: 'placa es requerida' })

    // Unicidad placa
    const dup = await Vehiculo.findBy('placa', placa)
    if (dup) return response.conflict({ message: 'La placa ya existe' })

    // Resolver clase
    let claseId: number | null = null
    if (claseIdBody) claseId = Number(claseIdBody)
    if (!claseId && claseCodigo) {
      const clase = await ClaseVehiculo.findBy('codigo', String(claseCodigo).trim())
      if (!clase) return response.badRequest({ message: 'clase_codigo no existe' })
      claseId = clase.id
    }
    if (!claseId)
      return response.badRequest({ message: 'clase_vehiculo_id o clase_codigo es requerido' })

    // Resolver cliente por teléfono (opcional)
    let clienteId: number | null = null
    if (clienteTelefono) {
      const cli = await Cliente.findBy('telefono', clienteTelefono)
      clienteId = cli?.id ?? null
    }

    const created = await Vehiculo.create({
      placa,
      claseVehiculoId: claseId,
      marca: typeof marca === 'string' ? marca.trim() || null : null,
      linea: typeof linea === 'string' ? linea.trim() || null : null,
      modelo: modelo ? Number(modelo) : null,
      // 🟢 nuevos campos
      color: typeof color === 'string' ? color.trim() || null : null,
      matricula: typeof matricula === 'string' ? matricula.trim() || null : null,
      clienteId,
    })

    return response.created(created)
  }

  /**
   * PUT /vehiculos/:id
   * body parcial: {
   *   placa?,
   *   clase_codigo?|clase_vehiculo_id?,
   *   marca?,
   *   linea?,
   *   modelo?,
   *   color?,        // 🟢 nuevo
   *   matricula?,    // 🟢 nuevo
   *   cliente_telefono? | cliente_id?
   * }
   */
  public async update({ params, request, response }: HttpContext) {
    const item = await Vehiculo.find(params.id)
    if (!item) return response.notFound({ message: 'Vehículo no encontrado' })

    const placaRaw = request.input('placa')
    if (placaRaw !== undefined) {
      const nuevaPlaca = normalizePlaca(placaRaw)
      if (!nuevaPlaca) return response.badRequest({ message: 'placa no puede ser vacía' })
      if (nuevaPlaca !== item.placa) {
        const exists = await Vehiculo.query()
          .where('placa', nuevaPlaca)
          .whereNot('id', item.id)
          .first()
        if (exists) return response.conflict({ message: 'La placa ya está en uso' })
        item.placa = nuevaPlaca
      }
    }

    const claseCodigo = request.input('clase_codigo')
    const claseIdBody = request.input('clase_vehiculo_id')
    if (claseIdBody || claseCodigo) {
      let claseId: number | null = null
      if (claseIdBody) claseId = Number(claseIdBody)
      if (!claseId && claseCodigo) {
        const clase = await ClaseVehiculo.findBy('codigo', String(claseCodigo).trim())
        if (!clase) return response.badRequest({ message: 'clase_codigo no existe' })
        claseId = clase.id
      }
      if (claseId) item.claseVehiculoId = claseId
    }

    const marca = request.input('marca')
    const linea = request.input('linea')
    const modelo = request.input('modelo')

    if (typeof marca === 'string') item.marca = marca.trim() || null
    if (typeof linea === 'string') item.linea = linea.trim() || null
    if (modelo !== undefined) item.modelo = modelo ? Number(modelo) : null

    // 🟢 nuevos campos: color + matricula
    const color = request.input('color')
    const matricula = request.input('matricula')

    if (color !== undefined) {
      item.color = typeof color === 'string' ? color.trim() || null : null
    }
    if (matricula !== undefined) {
      item.matricula = typeof matricula === 'string' ? matricula.trim() || null : null
    }

    const clienteTelefono = normalizePhone(request.input('cliente_telefono'))
    const clienteIdBody = request.input('cliente_id')

    if (clienteIdBody !== undefined) {
      item.clienteId = clienteIdBody ? Number(clienteIdBody) : null
    } else if (clienteTelefono !== undefined) {
      if (!clienteTelefono) {
        item.clienteId = null
      } else {
        const cli = await Cliente.findBy('telefono', clienteTelefono)
        if (!cli) return response.badRequest({ message: 'cliente_telefono no existe' })
        item.clienteId = cli.id
      }
    }

    await item.save()
    return item
  }

  /** DELETE /vehiculos/:id */
  public async destroy({ params, response }: HttpContext) {
    const item = await Vehiculo.find(params.id)
    if (!item) return response.notFound({ message: 'Vehículo no encontrado' })

    // Si luego hay turnos que referencien vehículo, aquí se podría bloquear el delete
    await item.delete()
    return response.noContent()
  }
}
