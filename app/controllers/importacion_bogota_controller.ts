// app/controllers/importacion_bogota_controller.ts
//
// POST /api/rtm/importar-bogota/preview  (multipart: archivo .xls/.xlsx)
// POST /api/rtm/importar-bogota/lote     ({ token, lote })
// Ver app/services/importacion_bogota/importacion_bogota_service.ts.

import type { HttpContext } from '@adonisjs/core/http'
import fs from 'node:fs/promises'
import {
  ImportacionError,
  procesarLote,
  sedeDeImportacion,
  vistaPrevia,
} from '#services/importacion_bogota/importacion_bogota_service'

const TAMANO_MAXIMO = '50mb'

export default class ImportacionBogotaController {
  private responderError(response: HttpContext['response'], error: unknown) {
    if (error instanceof ImportacionError) {
      return response.status(error.status).send({ message: error.message, code: error.code })
    }
    throw error // SedeScopeError y el resto: los renderiza el manejador global
  }

  public async preview({ request, response, auth }: HttpContext) {
    sedeDeImportacion() // Ibagué o "todas" → 400 antes de leer el archivo
    const archivo = request.file('archivo', { size: TAMANO_MAXIMO, extnames: ['xls', 'xlsx'] })
    if (!archivo) {
      return response.badRequest({
        message: 'Adjunta el archivo Excel (.xls o .xlsx) en el campo "archivo".',
      })
    }
    if (!archivo.isValid || !archivo.tmpPath) {
      return response.badRequest({
        message:
          archivo.errors?.[0]?.message ?? 'Archivo inválido: solo .xls o .xlsx de hasta 50 MB.',
      })
    }
    try {
      const buf = await fs.readFile(archivo.tmpPath)
      const resultado = await vistaPrevia({
        buf,
        nombre: archivo.clientName ?? 'archivo',
        usuarioId: auth.user!.id,
      })
      return response.ok(resultado)
    } catch (error) {
      return this.responderError(response, error)
    }
  }

  public async lote({ request, response, auth }: HttpContext) {
    sedeDeImportacion()
    const token = String(request.input('token') ?? '')
    const lote = Number(request.input('lote'))
    try {
      return response.ok(await procesarLote({ token, lote, usuarioId: auth.user!.id }))
    } catch (error) {
      return this.responderError(response, error)
    }
  }
}
