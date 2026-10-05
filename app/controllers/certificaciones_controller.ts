// app/controllers/certificaciones_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import db from '@adonisjs/lucid/services/db'

import Certificacion from '#models/certificacion'
import TurnoRtm from '#models/turno_rtm'
import {
  aplicaSegundaVez,
  camposAlCertificar,
  parseResultadoCertificacion,
  type ResultadoCertificacion,
} from '#services/segunda_vez_service'

export default class CertificacionesController {
  /**
   * POST /api/certificaciones
   * Crea una certificación para un turno, sube la imagen y finaliza el turno.
   */
  public async store({ request, auth, response }: HttpContext) {
    // ===== 1) Leer inputs simples =====
    const turnoIdInput = request.input('turno_id')
    const observaciones = request.input('observaciones') as string | undefined

    if (!turnoIdInput || Number.isNaN(Number(turnoIdInput))) {
      return response.badRequest({
        message: 'turno_id es requerido y debe ser numérico',
      })
    }

    const turnoId = Number(turnoIdInput)

    // ===== 2) Archivo imagen =====
    const imagenFile = request.file('imagen', {
      size: '8mb',
      extnames: ['jpg', 'jpeg', 'png'],
    })

    if (!imagenFile) {
      return response.badRequest({
        message: 'La imagen de certificación es obligatoria',
      })
    }

    if (!imagenFile.isValid) {
      return response.badRequest({
        message: 'La imagen no es válida',
        errors: imagenFile.errors,
      })
    }

    const usuario = await auth.authenticate().catch(() => null)

    // Todo en una transacción con el turno bloqueado (FOR UPDATE): evita que
    // dos certificaciones simultáneas del mismo turno pasen el chequeo de 409.
    const trx = await db.transaction()
    let archivoMovido: string | null = null

    try {
      // ===== 3) Buscar turno (bloqueado) =====
      const turno = await TurnoRtm.query({ client: trx })
        .where('id', turnoId)
        .forUpdate()
        .preload('servicio')
        .first()

      if (!turno) {
        await trx.rollback()
        return response.notFound({ message: 'Turno no encontrado' })
      }

      const yaCertificado = await Certificacion.query({ client: trx })
        .where('turno_id', turno.id)
        .first()

      if (yaCertificado) {
        await trx.rollback()
        return response.conflict({
          code: 'YA_CERTIFICADO',
          message: 'Este turno ya tiene una certificación registrada.',
          estado: turno.estado,
        })
      }

      // Se certifica un turno 'activo', o uno 'finalizado' sin certificación
      // (p. ej. finalizado a mano desde Editar turno). Cancelado/inactivo no.
      if (turno.estado !== 'activo' && turno.estado !== 'finalizado') {
        await trx.rollback()
        return response.conflict({
          code: 'TURNO_NO_ACTIVO',
          message: `No se puede certificar un turno en estado "${turno.estado}".`,
          estado: turno.estado,
        })
      }

      // ===== 3b) Resultado (Segunda vez): obligatorio solo para RTM/PREV =====
      const codigoServicio = turno.servicio?.codigoServicio ?? null
      let resultado: ResultadoCertificacion | null = null
      if (aplicaSegundaVez(codigoServicio)) {
        resultado = parseResultadoCertificacion(request.input('resultado'))
        if (!resultado) {
          await trx.rollback()
          return response.unprocessableEntity({
            code: 'RESULTADO_REQUERIDO',
            message: 'Debes indicar el resultado de la certificación: APROBADA o RECHAZADA.',
          })
        }
      }

      // ===== 4) Preparar carpeta uploads/certificaciones =====
      const uploadsRoot = app.makePath('uploads')
      const certDir = path.join(uploadsRoot, 'certificaciones')
      await fs.mkdir(certDir, { recursive: true })

      // ===== 5) Guardar archivo físicamente =====
      const fileName = `${Date.now()}_${turno.id}.${imagenFile.extname}`
      await imagenFile.move(certDir, {
        name: fileName,
        overwrite: false,
      })
      archivoMovido = path.join(certDir, fileName)

      const relativePath = path.join('uploads', 'certificaciones', fileName) // ruta pública o relativa

      // ===== 6) Crear certificación =====
      const certificacion = await Certificacion.create(
        {
          turnoId: turno.id,
          usuarioId: usuario?.id ?? null,
          imagenPath: relativePath,
          observaciones: observaciones?.trim() || null,
          resultado,
        },
        { client: trx }
      )

      // ===== 7) 🔥 Finalizar el turno, calcular tiempo de servicio y registrar certificación =====
      const now = DateTime.now().setZone('America/Bogota')

      // Si el turno ya estaba finalizado con hora de salida, se conservan su
      // horaSalida y tiempoServicio; si no, se calculan como siempre.
      const conservaSalida = turno.estado === 'finalizado' && !!turno.horaSalida
      const horaSalida = conservaSalida ? turno.horaSalida : now.toFormat('HH:mm:ss')
      const tiempoServicio = conservaSalida
        ? turno.tiempoServicio
        : calcularTiempoServicio(turno, now) || null

      // Segunda vez: resultado + ventana (rechazado_at y +360h con hora del servidor)
      const segundaVez = camposAlCertificar({
        codigoServicio,
        resultado,
        esSegundaVez: turno.esSegundaVez,
        ahora: now,
      })

      // 👇 GUARDAR TODO: estado, hora salida, tiempo servicio y certificador
      turno.useTransaction(trx)
      turno.merge({
        estado: 'finalizado',
        horaSalida,
        tiempoServicio, // 🔥 AGREGAR TIEMPO CALCULADO
        certificacionFuncionarioId: usuario?.id ?? null,
        ...segundaVez,
      })
      await turno.save()

      await trx.commit()

      return response.created({
        message: 'Certificación registrada y turno finalizado',
        data: certificacion,
        turno: turno,
      })
    } catch (error) {
      if (!trx.isCompleted) await trx.rollback()
      if (archivoMovido) await fs.unlink(archivoMovido).catch(() => {})
      throw error
    }
  }

  /**
   * GET /api/certificaciones/turno/:turnoId
   * Devuelve la certificación (o certificaciones) de un turno.
   */
  public async showByTurno({ params, response }: HttpContext) {
    const turnoId = Number(params.turnoId)

    if (Number.isNaN(turnoId)) {
      return response.badRequest({
        message: 'turnoId debe ser numérico',
      })
    }

    const certificacion = await Certificacion.query()
      .where('turno_id', turnoId)
      .orderBy('created_at', 'desc')
      .first()

    if (!certificacion) {
      return response.notFound({
        message: 'No hay certificación registrada para este turno',
      })
    }

    return {
      data: certificacion,
    }
  }
}

/** Tiempo de servicio legible entre hora_ingreso y la salida (now). */
function calcularTiempoServicio(turno: TurnoRtm, now: DateTime): string {
  // 👇 CALCULAR TIEMPO DE SERVICIO
  let tiempoServicioStr = ''
  if (turno.horaIngreso) {
    // Intentar parsear como HH:mm:ss primero, luego como HH:mm
    let entrada = DateTime.fromFormat(turno.horaIngreso, 'HH:mm:ss', {
      zone: 'America/Bogota',
    })
    if (!entrada.isValid) {
      entrada = DateTime.fromFormat(turno.horaIngreso, 'HH:mm', { zone: 'America/Bogota' })
    }

    if (entrada.isValid) {
      // Calcular diferencia entre salida (now) y entrada
      let diff = now.diff(entrada, ['hours', 'minutes']).toObject()

      // Evitar tiempos negativos
      if ((diff.hours ?? 0) < 0 || (diff.minutes ?? 0) < 0) {
        diff = { hours: 0, minutes: 0 }
      }

      // Formatear tiempo legible
      if (diff.hours && diff.hours >= 1) {
        tiempoServicioStr += `${Math.floor(diff.hours)} h `
      }
      tiempoServicioStr += `${Math.round((diff.minutes ?? 0) % 60)} min`

      console.log('✅ [CERTIFICACION] Tiempo calculado:', {
        turnoId: turno.id,
        horaIngreso: turno.horaIngreso,
        horaSalida: now.toFormat('HH:mm:ss'),
        tiempoServicio: tiempoServicioStr,
      })
    } else {
      console.warn('⚠️ [CERTIFICACION] No se pudo parsear hora de ingreso:', turno.horaIngreso)
    }
  }
  return tiempoServicioStr
}
