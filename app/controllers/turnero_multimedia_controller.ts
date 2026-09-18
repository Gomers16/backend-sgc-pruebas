// app/controllers/turnero_multimedia_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import TurneroMultimedia from '#models/turnero_multimedia'

export default class TurneroMultimediaController {
  /**
   * GET /turnero/multimedia
   * Devuelve TODO (activos e inactivos): la pantalla de configuración
   * necesita ver ambos; la pantalla de exhibición filtra `activo` del lado
   * del cliente y ordena por `orden` (ver PanelPublicidad.vue).
   */
  async index({ response }: HttpContext) {
    try {
      const items = await TurneroMultimedia.query().orderBy('orden', 'asc')
      return response.ok({ success: true, data: items })
    } catch (error) {
      return response.internalServerError({
        success: false,
        message: 'Error al obtener la multimedia del turnero',
        error: error.message,
      })
    }
  }

  /**
   * POST /turnero/multimedia
   * Solo registra metadata — el archivo ya fue subido antes vía
   * POST /media/upload (mismo flujo que Dateos/Comprobantes), y el frontend
   * manda acá la `url` que ese endpoint devolvió.
   */
  async store({ request, response }: HttpContext) {
    try {
      const payload = request.only(['tipo', 'url', 'duracionSegundos', 'orden', 'activo'])

      if (payload.tipo !== 'imagen' && payload.tipo !== 'video') {
        return response.badRequest({ success: false, message: 'tipo debe ser "imagen" o "video"' })
      }
      if (!payload.url) {
        return response.badRequest({ success: false, message: 'url es requerida' })
      }

      // Un video usa su duración natural: si llega duracionSegundos para un
      // video, se ignora en vez de guardarla y confundir a futuro.
      if (payload.tipo === 'video') payload.duracionSegundos = null

      if (payload.orden === undefined || payload.orden === null) {
        const ultimo = await TurneroMultimedia.query().orderBy('orden', 'desc').first()
        payload.orden = (ultimo?.orden ?? -1) + 1
      }

      const item = await TurneroMultimedia.create(payload)
      // Sin esto, `activo` no viaja en la respuesta cuando no se manda en el
      // payload: el modelo en memoria no conoce el DEFAULT TRUE de la
      // columna hasta refrescarlo desde la fila real.
      await item.refresh()
      return response.created({ success: true, message: 'Multimedia registrada', data: item })
    } catch (error) {
      return response.badRequest({
        success: false,
        message: 'Error al registrar la multimedia',
        error: error.message,
      })
    }
  }

  /**
   * PATCH /turnero/multimedia/:id
   * Cambiar duración, orden o activo/inactivo. También se usa (dos llamadas,
   * una por ítem) para el intercambio de `orden` al mover arriba/abajo desde
   * ConfiguracionTurnero.vue.
   */
  async update({ params, request, response }: HttpContext) {
    try {
      const item = await TurneroMultimedia.findOrFail(params.id)
      const payload = request.only(['duracionSegundos', 'orden', 'activo'])

      if (item.tipo === 'video') payload.duracionSegundos = null

      item.merge(payload)
      await item.save()

      return response.ok({ success: true, message: 'Multimedia actualizada', data: item })
    } catch (error) {
      return response.badRequest({
        success: false,
        message: 'Error al actualizar la multimedia',
        error: error.message,
      })
    }
  }

  /** DELETE /turnero/multimedia/:id — borrado real (no soft-delete: no hay
   * histórico que preservar, es solo lo que hoy se muestra en pantalla). */
  async destroy({ params, response }: HttpContext) {
    try {
      const item = await TurneroMultimedia.findOrFail(params.id)
      await item.delete()
      return response.ok({ success: true, message: 'Multimedia eliminada' })
    } catch (error) {
      return response.badRequest({
        success: false,
        message: 'Error al eliminar la multimedia',
        error: error.message,
      })
    }
  }
}
