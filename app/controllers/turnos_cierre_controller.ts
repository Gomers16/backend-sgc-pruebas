// app/controllers/turnos_cierre_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'

import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'
import Servicio from '#models/servicio'
import Comision from '#models/comision'
import { dateoAplicaAServicio } from '#services/reserva_dateo_service'

type EstadoComision = 'PENDIENTE' | 'APROBADA' | 'PAGADA' | 'ANULADA'

/** Intenta parsear HH:mm o HH:mm:ss a DateTime (zona Bogotá) */
function parseHoraToDT(hora: string): DateTime | null {
  const a = DateTime.fromFormat(hora, 'HH:mm:ss', { zone: 'America/Bogota' })
  if (a.isValid) return a
  const b = DateTime.fromFormat(hora, 'HH:mm', { zone: 'America/Bogota' })
  return b.isValid ? b : null
}

/** Formatea la diferencia entre dos DateTime como "X h Y min" */
function humanDiff(a: DateTime, b: DateTime): string {
  const diff = b.diff(a, ['hours', 'minutes']).toObject()
  const h = Math.max(0, Math.floor(diff.hours || 0))
  const m = Math.max(0, Math.round((diff.minutes || 0) % 60))
  return (h ? `${h} h ` : '') + `${m} min`
}

export default class TurnosCierreController {
  /**
   * POST /api/turnos/:id/cerrar
   * Efectos:
   *  1) Finaliza el turno (estado, horaSalida, tiempoServicio si aplica)
   *  2) Si existe captacion_dateo_id → resultado = 'EXITOSO', consumido_turno_id/consumido_at
   *  3) Crea comisión PENDIENTE (si no existe) usando asesor/convenio del dateo (o null si FACHADA)
   * Idempotente: si ya hay comisión del turno, no duplica.
   */
  public async cerrar({ params, response }: HttpContext) {
    const trx = await Database.transaction()
    try {
      // 1) Buscar turno
      const turno = await TurnoRtm.find(params.id, { client: trx })
      if (!turno) {
        await trx.rollback()
        return response.notFound({ message: 'Turno no encontrado' })
      }

      // 2) Finalizar turno si no está finalizado
      if (turno.estado !== 'finalizado') {
        const ahora = DateTime.local().setZone('America/Bogota')
        // horaSalida (si no viene de otra acción)
        if (!turno.horaSalida) {
          turno.horaSalida = ahora.toFormat('HH:mm:ss')
        }
        // tiempoServicio (si hay horaIngreso válida)
        const hi = parseHoraToDT(turno.horaIngreso)
        if (hi) {
          turno.tiempoServicio = humanDiff(hi, ahora)
        }
        turno.estado = 'finalizado'
        await turno.save()
      }

      // 3) Si hay dateo vinculado → marcar EXITOSO + consumos
      let asesorId: number | null = null
      let convenioId: number | null = null

      if (turno.captacionDateoId) {
        const dateo = await CaptacionDateo.find(turno.captacionDateoId, { client: trx })
        // 🆕 Defensa adicional: no marcar EXITOSO/consumir un dateo de otro
        // servicio. La fuente principal es turnos_rtms_controller.ts::store()
        // (ya no vincula captacionDateoId si el servicio no coincide), esto
        // es un segundo seguro por si algo más setea captacionDateoId.
        if (dateo && dateoAplicaAServicio(dateo, turno.servicioId)) {
          // Marca éxito solo si no está ya exitoso
          if ((dateo as any).resultado !== 'EXITOSO') {
            ;(dateo as any).resultado = 'EXITOSO'
          }
          dateo.consumidoTurnoId = turno.id
          dateo.consumidoAt = DateTime.now()
          await dateo.save()

          // Extrae asesor / convenio para la comisión
          // (ts-ignore/any por si tu tipo no serializa snake_case)
          asesorId = (dateo as any).agenteId ?? (dateo as any).agente_id ?? null
          convenioId = (dateo as any).convenioId ?? (dateo as any).convenio_id ?? null
        }
      }

      // 4) Comprobación idempotente: ¿ya hay comisión de este turno?
      const yaExiste = await Comision.query({ client: trx }).where('turno_id', turno.id).first()

      let comisionCreada: Comision | null = null
      if (!yaExiste) {
        // Trae servicio para obtener codigo_servicio
        const svc = await Servicio.find(turno.servicioId, { client: trx })
        const servicioCodigo: string = (svc as any)?.codigoServicio ?? 'NA'

        // Reglas básicas: cantidad=1, valorUnitario=1 (deja parametrizable)
        const cantidad = 1
        const valorUnitario = 1
        const valorTotal = cantidad * valorUnitario
        const estado: EstadoComision = 'PENDIENTE'

        comisionCreada = await Comision.create(
          {
            turnoId: turno.id,
            asesorId,
            convenioId,
            servicioCodigo,
            cantidad,
            valorUnitario,
            valorTotal,
            estado,
            generadoAt: DateTime.now(),
          } as any,
          { client: trx }
        )
      }

      await trx.commit()
      return response.ok({
        ok: true,
        turnoId: turno.id,
        comision: comisionCreada
          ? {
              id: comisionCreada.id,
              estado: comisionCreada.estado,
              valorTotal: comisionCreada.valorTotal,
              servicioCodigo:
                (comisionCreada as any).servicioCodigo ?? (comisionCreada as any).servicio_codigo,
              asesorId: comisionCreada.asesorId ?? (comisionCreada as any).asesor_id ?? null,
              convenioId: comisionCreada.convenioId ?? (comisionCreada as any).convenio_id ?? null,
            }
          : 'ya_existente',
      })
    } catch (error) {
      await trx.rollback()
      console.error('Error al cerrar turno:', error)
      return response.internalServerError({ message: 'Error al cerrar el turno' })
    }
  }
}
