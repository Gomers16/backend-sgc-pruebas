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

// Lista fija de módulos físicos del CDA — duplicada A PROPÓSITO de
// front-sgc-pruebas/src/views/turnero/config/constantes.ts::MODULOS_TURNERO
// (repos separados, sin paquete compartido entre back y front; mismo
// criterio ya usado en este archivo para CODIGOS_SERVICIO_TURNERO). Si se
// renombra un módulo, hay que cambiar las DOS listas. Validado en store():
// nunca confiar ciegamente en lo que mande el frontend (hallazgo de la
// revisión QA del Turnero — antes este endpoint aceptaba cualquier texto).
const MODULOS_TURNERO: string[] = [
  'Módulo 1 - Caja SOAT',
  'Módulo 2 - Caja SOAT',
  'Módulo 3 - Caja SOAT',
  'Módulo 4 - Entrega',
  'Módulo 5 - Caja RTM',
  'Módulo 6 - Caja RTM',
]

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
    if (!MODULOS_TURNERO.includes(moduloLimpio)) {
      return response.badRequest({ message: 'Módulo inválido' })
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
   * GET /turnos-rtm/en-modulo-pendientes-entrega
   * Turnos ya llamados (registro en turno_llamados) que todavía no tienen
   * entregado_at. Alimenta la segunda sección de TurnosParaLlamar.vue. Los
   * marcados no_presentado=true SIGUEN apareciendo acá (solo "Entregar" los
   * saca de la lista) — el frontend los pinta distinto, no se filtran acá.
   * Orden: el que más lleva esperando primero (llamado_at asc).
   */
  public async pendientesEntrega({ response }: HttpContext) {
    try {
      const llamados = await TurnoLlamado.query()
        .whereNull('entregado_at')
        .preload('turno', (q) => q.preload('servicio'))
        .orderBy('llamado_at', 'asc')

      const turnos = llamados
        .filter((l) => !!l.turno)
        .map((l) => ({
          llamadoId: l.id,
          turnoId: l.turnoId,
          placa: l.turno.placa,
          servicio: l.turno.servicio
            ? {
                codigoServicio: l.turno.servicio.codigoServicio,
                nombreServicio: l.turno.servicio.nombreServicio,
              }
            : null,
          modulo: l.modulo,
          llamadoEn: l.llamadoAt.toISO(),
          noPresentado: l.noPresentado,
        }))

      return response.ok({ turnos })
    } catch (error) {
      console.error('Error en pendientesEntrega:', error)
      return response.internalServerError({ message: 'Error al obtener los turnos pendientes de entrega' })
    }
  }

  /**
   * PATCH /turnos-rtm/:id/entregar
   * :id es el turnoId (mismo parámetro que usan llamar()/index()). Marca
   * entregado_at = ahora en su registro de turno_llamados — a partir de acá
   * deja de aparecer en colaTurnero() y en pendientesEntrega(). No toca
   * turnos_rtms.estado ni ninguna otra tabla.
   */
  public async entregar({ params, response }: HttpContext) {
    const turnoId = Number(params.id)
    if (Number.isNaN(turnoId)) {
      return response.badRequest({ message: 'id de turno inválido' })
    }

    try {
      const llamado = await TurnoLlamado.query().where('turno_id', turnoId).first()
      if (!llamado) {
        return response.notFound({ message: 'Este turno no tiene un llamado registrado' })
      }

      llamado.entregadoAt = DateTime.local().setZone('America/Bogota')
      await llamado.save()

      return response.ok({ message: 'Turno marcado como entregado', llamadoId: llamado.id })
    } catch (error) {
      console.error('Error al marcar entregado:', error)
      return response.internalServerError({ message: 'Error al marcar el turno como entregado' })
    }
  }

  /**
   * PATCH /turnos-rtm/:id/volver-a-llamar
   * :id es el turnoId. Repite el llamado del mismo turno: actualiza
   * llamado_at = ahora en su registro existente de turno_llamados — NO crea
   * una fila nueva, NO cambia el módulo. Al subir llamado_at, colaTurnero()
   * (que ordena por llamado_at desc) lo vuelve a poner primero en
   * ultimosLlamados, y useColaModales.ts en el frontend lo vuelve a anunciar
   * (modal + pitido + voz) porque compara por (id, llamadoEn), no solo por
   * id. Se resetea no_presentado a false: volver a llamar es una oportunidad
   * nueva, ese estado de la vez anterior ya no aplica hasta que se marque de
   * nuevo. Sin límite de repeticiones.
   */
  public async volverALlamar({ params, response }: HttpContext) {
    const turnoId = Number(params.id)
    if (Number.isNaN(turnoId)) {
      return response.badRequest({ message: 'id de turno inválido' })
    }

    try {
      const llamado = await TurnoLlamado.query().where('turno_id', turnoId).first()
      if (!llamado) {
        return response.notFound({ message: 'Este turno no tiene un llamado registrado' })
      }

      if (llamado.entregadoAt) {
        return response.badRequest({ message: 'Este turno ya fue entregado, no se puede volver a llamar' })
      }

      llamado.llamadoAt = DateTime.local().setZone('America/Bogota')
      llamado.noPresentado = false
      await llamado.save()

      return response.ok({ message: 'Turno llamado de nuevo', llamadoId: llamado.id })
    } catch (error) {
      console.error('Error al volver a llamar:', error)
      return response.internalServerError({ message: 'Error al volver a llamar el turno' })
    }
  }

  /**
   * PATCH /turnos-rtm/:id/no-presentado
   * :id es el turnoId. Toggle simple de no_presentado — no requiere body,
   * cada llamada invierte el valor actual (permite revertir "No se
   * presentó" con la misma acción, ver TurnosParaLlamar.vue). Rechaza con
   * 409 si el turno ya tiene entregado_at: un turno entregado es un estado
   * terminal (ver Área 3 de la revisión QA del Turnero, antes se podía
   * seguir alternando el flag sobre un registro ya invisible en pantalla).
   */
  public async marcarNoPresentado({ params, response }: HttpContext) {
    const turnoId = Number(params.id)
    if (Number.isNaN(turnoId)) {
      return response.badRequest({ message: 'id de turno inválido' })
    }

    try {
      const llamado = await TurnoLlamado.query().where('turno_id', turnoId).first()
      if (!llamado) {
        return response.notFound({ message: 'Este turno no tiene un llamado registrado' })
      }
      if (llamado.entregadoAt) {
        return response.conflict({ message: 'Este turno ya fue entregado, no se puede modificar' })
      }

      llamado.noPresentado = !llamado.noPresentado
      await llamado.save()

      return response.ok({ message: 'Estado actualizado', noPresentado: llamado.noPresentado })
    } catch (error) {
      console.error('Error al marcar no_presentado:', error)
      return response.internalServerError({ message: 'Error al actualizar el estado del turno' })
    }
  }

  /**
   * GET /turnero/cola — único endpoint que consume la pantalla de exhibición
   * (front-sgc-pruebas, /turnero). Arma el contrato de INTEGRACION.md:
   * colaSeguimiento + ultimosLlamados (ya ordenado, más reciente primero —
   * el back decide el orden, el front del turnero nunca reordena).
   *
   * colaSeguimiento combina TRES grupos de turnos, cada uno con su propio
   * estado visual (ver config/estados.ts en el frontend para las etiquetas):
   *   - 'activo' sin facturación             -> 'en_proceso'    ("En proceso")
   *   - 'activo' facturado, servicio RTM     -> 'certificacion' ("Certificación RUNT")
   *   - 'finalizado' sin llamado todavía     -> 'por_llamar'    ("Listo para entregar")
   *     (mismo query que index()/pendientes-llamar — un turno deja de
   *     aparecer acá en el instante en que store() le registra un llamado).
   *
   * 'certificacion' es EXCLUSIVO de RTM (RUNT es un registro específico de
   * RTM) — un turno 'activo' facturado de otro servicio se muestra como
   * 'en_proceso'. Es una decisión de presentación de esta pantalla, no
   * refleja que tieneFacturacion sea RTM-only en el resto del sistema (no lo
   * es: turno_etapas_service.ts documenta que solo SOAT se salta la etapa de
   * certificación; RTM, PREV y PERI sí la tienen). No tocar tieneFacturacion
   * ni ninguna otra lógica de negocio por esto.
   *
   * Orden: agrupado por prioridad de estado (por_llamar > certificacion >
   * en_proceso — el más avanzado/urgente primero) y dentro de cada grupo por
   * turno_numero ascendente. Se decide acá, no en el frontend, mismo
   * principio que ya rige el resto de este endpoint: el front solo recorta
   * en grupos de 3 para la rotación, nunca decide qué va primero.
   */
  public async colaTurnero({ response }: HttpContext) {
    try {
      const hoyISO = DateTime.local().setZone('America/Bogota').toISODate()!

      const PRIORIDAD_ESTADO: Record<string, number> = {
        por_llamar: 0,
        certificacion: 1,
        en_proceso: 2,
      }

      const activos = await TurnoRtm.query()
        .where('estado', 'activo')
        .where('fecha', hoyISO)
        .whereHas('servicio', (q) => q.whereIn('codigo_servicio', CODIGOS_SERVICIO_TURNERO))
        .preload('servicio')
        .orderBy('turno_numero', 'asc')

      const listosParaEntrega = await TurnoRtm.query()
        .where('estado', 'finalizado')
        .where('fecha', hoyISO)
        .whereHas('servicio', (q) => q.whereIn('codigo_servicio', CODIGOS_SERVICIO_TURNERO))
        .whereDoesntHave('llamado', (q) => q)
        .preload('servicio')
        .orderBy('turno_numero', 'asc')

      const mapearTurno = (t: TurnoRtm, estado: string) => {
        const codigoServicio = (t.servicio?.codigoServicio ?? '').toUpperCase()
        return {
          id: String(t.id),
          placa: t.placa,
          turno: t.turnoNumero > 0 ? String(t.turnoNumero) : null,
          canal: CODIGO_A_CANAL_TURNERO[codigoServicio] ?? codigoServicio,
          estado,
          _turnoNumero: t.turnoNumero,
        }
      }

      const colaSeguimiento = [
        ...activos.map((t) => {
          const esRtm = (t.servicio?.codigoServicio ?? '').toUpperCase() === 'RTM'
          return mapearTurno(t, t.tieneFacturacion && esRtm ? 'certificacion' : 'en_proceso')
        }),
        ...listosParaEntrega.map((t) => mapearTurno(t, 'por_llamar')),
      ]
        .sort((a, b) => {
          const prioridad = PRIORIDAD_ESTADO[a.estado] - PRIORIDAD_ESTADO[b.estado]
          return prioridad !== 0 ? prioridad : a._turnoNumero - b._turnoNumero
        })
        .map(({ _turnoNumero, ...turno }) => turno)

      // entregado_at ya seteado -> el turno salió del turnero para siempre
      // (no vuelve a aparecer). no_presentado=true SÍ sigue apareciendo acá
      // (el cliente todavía puede volver), solo se marca para que el front
      // lo muestre atenuado — ver noPresentado en el mapeo de abajo.
      const llamados = await TurnoLlamado.query()
        .whereNull('entregado_at')
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
            noPresentado: l.noPresentado,
          }
        })

      return response.ok({ colaSeguimiento, ultimosLlamados })
    } catch (error) {
      console.error('Error en colaTurnero:', error)
      return response.internalServerError({ message: 'Error al obtener la cola del turnero' })
    }
  }
}
