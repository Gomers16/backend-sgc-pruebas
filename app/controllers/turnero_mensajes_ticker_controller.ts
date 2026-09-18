// app/controllers/turnero_mensajes_ticker_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import TurneroMensajeTicker from '#models/turnero_mensaje_ticker'

export default class TurneroMensajesTickerController {
  /** GET /turnero/ticker — todos (activos e inactivos), ver nota en
   * TurneroMultimediaController.index(). */
  async index({ response }: HttpContext) {
    try {
      const items = await TurneroMensajeTicker.query().orderBy('orden', 'asc')
      return response.ok({ success: true, data: items })
    } catch (error) {
      return response.internalServerError({
        success: false,
        message: 'Error al obtener los mensajes de la cinta',
        error: error.message,
      })
    }
  }

  async store({ request, response }: HttpContext) {
    try {
      const payload = request.only(['texto', 'orden', 'activo'])

      if (!payload.texto || !String(payload.texto).trim()) {
        return response.badRequest({ success: false, message: 'texto es requerido' })
      }

      if (payload.orden === undefined || payload.orden === null) {
        const ultimo = await TurneroMensajeTicker.query().orderBy('orden', 'desc').first()
        payload.orden = (ultimo?.orden ?? -1) + 1
      }

      const item = await TurneroMensajeTicker.create(payload)
      // Ver nota equivalente en TurneroMultimediaController.store().
      await item.refresh()
      return response.created({ success: true, message: 'Mensaje creado', data: item })
    } catch (error) {
      return response.badRequest({
        success: false,
        message: 'Error al crear el mensaje',
        error: error.message,
      })
    }
  }

  async update({ params, request, response }: HttpContext) {
    try {
      const item = await TurneroMensajeTicker.findOrFail(params.id)
      const payload = request.only(['texto', 'orden', 'activo'])
      item.merge(payload)
      await item.save()
      return response.ok({ success: true, message: 'Mensaje actualizado', data: item })
    } catch (error) {
      return response.badRequest({
        success: false,
        message: 'Error al actualizar el mensaje',
        error: error.message,
      })
    }
  }

  async destroy({ params, response }: HttpContext) {
    try {
      const item = await TurneroMensajeTicker.findOrFail(params.id)
      await item.delete()
      return response.ok({ success: true, message: 'Mensaje eliminado' })
    } catch (error) {
      return response.badRequest({
        success: false,
        message: 'Error al eliminar el mensaje',
        error: error.message,
      })
    }
  }
}
