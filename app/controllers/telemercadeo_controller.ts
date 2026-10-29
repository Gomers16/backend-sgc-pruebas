// app/controllers/telemercadeo_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import {
  FILTROS_CLIENTES,
  LISTAS,
  ORDENES_CLIENTES,
  RANGOS_POR_VENCER,
  obtenerColaTelemercadeo,
  type ListaCola,
  type OrdenClientes,
} from '#services/telemercadeo_cola_service'

const PER_PAGE_DEFAULT = 25
const PER_PAGE_MAX = 100

export default class TelemercadeoController {
  /** GET /api/telemercadeo/cola — solo lectura (ver telemercadeo_cola_service.ts). */
  public async cola({ request, response }: HttpContext) {
    const lista = String(request.input('lista') || 'POR_VENCER').toUpperCase() as ListaCola
    if (!LISTAS.includes(lista)) {
      return response.badRequest({ message: `lista debe ser ${LISTAS.join(', ')}` })
    }

    const rangosValidos: readonly string[] =
      lista === 'CLIENTES' ? FILTROS_CLIENTES : RANGOS_POR_VENCER
    const rangoRaw = request.input('rango')
    const rango = rangoRaw ? String(rangoRaw).toUpperCase() : null
    if (rango && !rangosValidos.includes(rango)) {
      return response.badRequest({ message: `rango debe ser ${rangosValidos.join(', ')}` })
    }

    const orden = String(request.input('orden') || 'ANTIGUEDAD').toUpperCase() as OrdenClientes
    if (!ORDENES_CLIENTES.includes(orden)) {
      return response.badRequest({ message: `orden debe ser ${ORDENES_CLIENTES.join(', ')}` })
    }

    const page = Math.max(1, Number.parseInt(request.input('page'), 10) || 1)
    const perPage = Math.min(
      PER_PAGE_MAX,
      Math.max(1, Number.parseInt(request.input('per_page'), 10) || PER_PAGE_DEFAULT)
    )
    const qRaw = request.input('q')
    const q = qRaw ? String(qRaw).trim() || null : null

    return response.ok(await obtenerColaTelemercadeo({ lista, rango, q, orden, page, perPage }))
  }
}
