// app/controllers/turno_llamados_controller.ts
//
// Integración con la pantalla del turnero (TurneroCDAPro, proyecto
// independiente). Tres responsabilidades:
//  1. index()       — GET /turnos-rtm/pendientes-llamar (admin: TurnosParaLlamar.vue)
//  2. store()        — POST /turnos-rtm/:id/llamar (admin: registra el llamado)
//  3. colaTurnero()   — GET /turnero/cola (rol TURNERO: contrato de INTEGRACION.md)
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'

import TurnoRtm from '#models/turno_rtm'
import TurnoLlamado from '#models/turno_llamado'
import UsuarioPreferenciaModulo from '#models/usuario_preferencia_modulo'

// Códigos reales en BD (servicios.codigo_servicio) que el turnero exhibe —
// TRAMITES queda fuera a propósito (ver INTEGRACION.md, el turnero no lo
// contempla como canal).
const CODIGOS_SERVICIO_TURNERO: string[] = ['RTM', 'SOAT', 'PREV', 'PERI']

// El contrato de INTEGRACION.md usa 'PREVENTIVA', no 'PREV' — es la única
// traducción de nombre que hace falta entre el código real y el contrato.
const CODIGO_A_CANAL_TURNERO: Record<string, string> = {
  RTM: 'RTM',
  SOAT: 'SOAT',
  PREV: 'PREVENTIVA',
  PERI: 'PERI',
}

export default class TurnoLlamadosController {
  /**
   * GET /turnos-rtm/pendientes-llamar
   * Turnos ya certificados (estado='finalizado') que todavía no tienen un
   * llamado registrado. Alimenta la tabla de TurnosParaLlamar.vue.
   * qs: usuarioId (para devolver también su preferencia de módulo).
   */
  public async index({ request, response }: HttpContext) {
    const { usuarioId } = request.qs()

    try {
      // Igual que colaTurnero(): solo turnos de HOY. Sin este filtro, el
      // backlog histórico completo de turnos finalizados sin llamado
      // (miles de filas en datos reales) aparecería en la pantalla —
      // confirmado en pruebas manuales contra -pruebas antes de este fix.
      const hoyISO = DateTime.local().setZone('America/Bogota').toISODate()!

      const turnos = await TurnoRtm.query()
        .where('estado', 'finalizado')
        .where('fecha', hoyISO)
        .whereHas('servicio', (q) => q.whereIn('codigo_servicio', CODIGOS_SERVICIO_TURNERO))
        .whereDoesntHave('llamado', (q) => q)
        .preload('servicio')
        .preload('vehiculo')
        .orderBy('fecha', 'asc')
        .orderBy('hora_salida', 'asc')

      let ultimoModuloPreferido: string | null = null
      if (usuarioId) {
        const pref = await UsuarioPreferenciaModulo.query()
          .where('usuario_id', Number(usuarioId))
          .first()
        ultimoModuloPreferido = pref?.ultimoModulo ?? null
      }

      return response.ok({
        turnos: turnos.map((t) => t.serialize()),
        ultimoModuloPreferido,
      })
    } catch (error) {
      console.error('Error en pendientes-llamar:', error)
      return response.internalServerError({ message: 'Error al obtener turnos pendientes de llamar' })
    }
  }

  /**
   * POST /turnos-rtm/:id/llamar
   * body: { modulo: string, usuarioId: number }
   */
  public async store({ params, request, response }: HttpContext) {
    const { modulo, usuarioId } = request.only(['modulo', 'usuarioId'])

    const moduloLimpio = typeof modulo === 'string' ? modulo.trim() : ''
    if (!moduloLimpio) {
      return response.badRequest({ message: 'El módulo es obligatorio' })
    }

    const idNumericoUsuario = Number(usuarioId)
    if (!usuarioId || Number.isNaN(idNumericoUsuario)) {
      return response.badRequest({ message: 'usuarioId inválido' })
    }

    const turnoId = Number(params.id)
    if (Number.isNaN(turnoId)) {
      return response.badRequest({ message: 'id de turno inválido' })
    }

    const trx = await Database.transaction()
    try {
      const turno = await TurnoRtm.find(turnoId, { client: trx })
      if (!turno) {
        await trx.rollback()
        return response.notFound({ message: 'Turno no encontrado' })
      }

      if (turno.estado !== 'finalizado') {
        await trx.rollback()
        return response.badRequest({
          message: 'Solo se puede llamar un turno ya certificado (estado finalizado)',
        })
      }

      // Pre-chequeo de aplicación — el índice único uq_turno_llamados_turno_id
      // es la red de seguridad final ante una condición de carrera (mismo
      // patrón que DUPLICATE_DAY en turnos_rtms_controller.ts::store()).
      const yaLlamado = await TurnoLlamado.query({ client: trx }).where('turno_id', turnoId).first()
      if (yaLlamado) {
        await trx.rollback()
        return response.conflict({ message: 'Este turno ya fue llamado', llamadoId: yaLlamado.id })
      }

      const ahora = DateTime.local().setZone('America/Bogota')

      const llamado = await TurnoLlamado.create(
        {
          turnoId,
          modulo: moduloLimpio,
          usuarioId: idNumericoUsuario,
          llamadoAt: ahora,
        } as any,
        { client: trx }
      )

      const preferencia = await UsuarioPreferenciaModulo.query({ client: trx })
        .where('usuario_id', idNumericoUsuario)
        .first()
      if (preferencia) {
        preferencia.ultimoModulo = moduloLimpio
        await preferencia.useTransaction(trx).save()
      } else {
        await UsuarioPreferenciaModulo.create(
          { usuarioId: idNumericoUsuario, ultimoModulo: moduloLimpio } as any,
          { client: trx }
        )
      }

      await trx.commit()
      return response.created({ message: 'Turno llamado', llamadoId: llamado.id })
    } catch (error: any) {
      try {
        await trx.rollback()
      } catch {}
      if (
        error?.code === 'ER_DUP_ENTRY' &&
        String(error?.sqlMessage ?? error?.message ?? '').includes('uq_turno_llamados_turno_id')
      ) {
        return response.conflict({ message: 'Este turno ya fue llamado' })
      }
      console.error('Error al registrar llamado:', error)
      return response.internalServerError({ message: 'Error al registrar el llamado' })
    }
  }

  /**
   * GET /turnero/cola — único endpoint que consume TurneroCDAPro (rol
   * TURNERO). Arma exactamente el contrato de INTEGRACION.md: colaSeguimiento
   * (turnos activos de hoy) + ultimosLlamados (ya ordenado, más reciente
   * primero — el back decide el orden, el front del turnero nunca reordena).
   */
  public async colaTurnero({ response }: HttpContext) {
    try {
      const hoyISO = DateTime.local().setZone('America/Bogota').toISODate()!

      const activos = await TurnoRtm.query()
        .where('estado', 'activo')
        .where('fecha', hoyISO)
        .whereHas('servicio', (q) => q.whereIn('codigo_servicio', CODIGOS_SERVICIO_TURNERO))
        .preload('servicio')
        .orderBy('turno_numero', 'asc')

      const colaSeguimiento = activos.map((t) => {
        const codigoServicio = (t.servicio?.codigoServicio ?? '').toUpperCase()
        return {
          id: String(t.id),
          placa: t.placa,
          turno: t.turnoNumero > 0 ? String(t.turnoNumero) : null,
          canal: CODIGO_A_CANAL_TURNERO[codigoServicio] ?? codigoServicio,
          estado: t.tieneFacturacion ? 'certificacion' : 'en_proceso',
        }
      })

      const llamados = await TurnoLlamado.query()
        .preload('turno', (q) => q.preload('servicio'))
        .orderBy('llamado_at', 'desc')
        .limit(20)

      const ultimosLlamados = llamados
        .filter((l) => !!l.turno)
        .map((l) => {
          const codigoServicio = (l.turno.servicio?.codigoServicio ?? '').toUpperCase()
          return {
            id: String(l.turnoId),
            placa: l.turno.placa,
            turno: l.turno.turnoNumero > 0 ? String(l.turno.turnoNumero) : null,
            canal: CODIGO_A_CANAL_TURNERO[codigoServicio] ?? codigoServicio,
            modulo: l.modulo,
            llamadoEn: l.llamadoAt.toISO(),
          }
        })

      return response.ok({ colaSeguimiento, ultimosLlamados })
    } catch (error) {
      console.error('Error en colaTurnero:', error)
      return response.internalServerError({ message: 'Error al obtener la cola del turnero' })
    }
  }
}
