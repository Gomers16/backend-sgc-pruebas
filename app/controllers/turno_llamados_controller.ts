// app/controllers/turno_llamados_controller.ts
//
// Integración con la pantalla del turnero (TurneroCDAPro, proyecto
// independiente). Tres responsabilidades:
//  1. index()       — GET /turnos-rtm/pendientes-llamar (admin: TurnosParaLlamar.vue)
//  2. store()        — POST /turnos-rtm/:id/llamar (admin: registra el llamado)
//  3. colaTurnero()   — GET /turnero/cola (rol TURNERO: contrato de INTEGRACION.md)
// Más las acciones sobre un llamado activo desde TurnosParaLlamar.vue:
// entregar(), volverALlamar(), llamarPregunta() y marcarNoPresentado().
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import type { ModelQueryBuilderContract } from '@adonisjs/lucid/types/model'

import TurnoRtm from '#models/turno_rtm'
import TurnoLlamado from '#models/turno_llamado'
import UsuarioPreferenciaModulo from '#models/usuario_preferencia_modulo'
import { esTurnoSegundaVez } from '#services/segunda_vez_service'

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

// Estados de una fila de turno_llamados, sin entregar:
//  - LLAMADO ACTIVO OFICIAL: tuvo un "LLAMAR" real y el cliente no faltó
//    (llamado_oficial=true, no_presentado=false). El turno está en
//    "pendientes de entrega" y en "Llamando ahora" (hero + histórico).
//  - FUERA DE MÓDULO: la fila existe, pero el turno sigue perteneciendo a
//    "Turnos para Llamar" y a la cola — o no se presentó (no_presentado=true),
//    o solo se le hizo "Preguntar" sin llamarlo nunca (llamado_oficial=false).
// La fila se conserva en ambos casos (índice único en turno_id): store()
// la reutiliza al llamarlo de verdad.

// Filtro sobre turno_llamados: llamado activo oficial. Se usa como
// `.where(llamadoActivoOficial)` en pendientesEntrega() y colaTurnero().
function llamadoActivoOficial(q: ModelQueryBuilderContract<typeof TurnoLlamado>) {
  q.whereNull('entregado_at').where('no_presentado', false).where('llamado_oficial', true)
}

// Filtro sobre turnos_rtms: sin llamado activo oficial — sin fila, o fila
// fuera de módulo (ver arriba). Misma condición en index() y colaTurnero()
// para que nunca diverjan. Se usa como `.where(sinLlamadoActivo)` — el
// callback de where() agrupa las ramas entre paréntesis, así los OR no se
// mezclan con los demás filtros.
function sinLlamadoActivo(q: ModelQueryBuilderContract<typeof TurnoRtm>) {
  q.whereDoesntHave('llamado', (l) => l).orWhereHas('llamado', (l) =>
    l.whereNull('entregado_at').where((f) => f.where('no_presentado', true).orWhere('llamado_oficial', false))
  )
}

function esLlamadoActivoOficial(l: TurnoLlamado): boolean {
  return !l.entregadoAt && !l.noPresentado && l.llamadoOficial
}

export default class TurnoLlamadosController {
  /**
   * GET /turnos-rtm/pendientes-llamar
   * Turnos ya certificados (estado='finalizado') sin llamado activo oficial
   * (ver sinLlamadoActivo(): nunca llamados, llamados que no se presentaron,
   * o con solo un "Preguntar"). Alimenta la tabla de TurnosParaLlamar.vue —
   * cada turno trae noPresentadoPrevio=true si ya se le llamó una vez y no
   * se presentó, y preguntaEnviada=true si se le hizo "Preguntar" sin
   * llamarlo todavía (chips en la tabla).
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
        .where(sinLlamadoActivo)
        .preload('servicio')
        .preload('vehiculo')
        .preload('llamado')
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
        turnos: turnos.map((t) => ({
          ...t.serialize(),
          noPresentadoPrevio: !!t.llamado?.noPresentado,
          preguntaEnviada: !!t.llamado && !t.llamado.llamadoOficial,
        })),
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
   * Si el turno ya tiene una fila fuera de módulo (no se presentó, o solo
   * se le hizo "Preguntar"; sin entregar), la REUTILIZA — el índice único
   * en turno_id no permite una segunda: módulo = el enviado ahora (aunque la
   * pregunta haya usado otro), usuario, llamado_at = ahora,
   * tipo_llamado = 'modulo', llamado_oficial = true, no_presentado = false.
   * Con un llamado activo oficial o ya entregado → 409.
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
      const esReutilizable =
        !!yaLlamado && !yaLlamado.entregadoAt && (yaLlamado.noPresentado || !yaLlamado.llamadoOficial)
      if (yaLlamado && !esReutilizable) {
        await trx.rollback()
        return response.conflict({ message: 'Este turno ya fue llamado', llamadoId: yaLlamado.id })
      }

      const ahora = DateTime.local().setZone('America/Bogota')

      let llamadoId: number
      if (yaLlamado) {
        // Reutiliza la fila fuera de módulo. UPDATE condicionado a que siga
        // fuera de módulo y sin entregar: si otro operador lo llamó (o lo
        // entregó) entre la lectura de arriba y este punto, no afecta filas
        // y se responde 409 — mismo papel que cumple el índice único en el
        // INSERT de abajo ante una condición de carrera.
        const resultado = await TurnoLlamado.query({ client: trx })
          .where('id', yaLlamado.id)
          .whereNull('entregado_at')
          .where((f) => f.where('no_presentado', true).orWhere('llamado_oficial', false))
          .update({
            modulo: moduloLimpio,
            usuario_id: idNumericoUsuario,
            llamado_at: ahora.toFormat('yyyy-MM-dd HH:mm:ss'),
            no_presentado: false,
            tipo_llamado: 'modulo',
            llamado_oficial: true,
            updated_at: ahora.toFormat('yyyy-MM-dd HH:mm:ss'),
          })
        const filasAfectadas = Number(Array.isArray(resultado) ? resultado[0] : resultado)
        if (!filasAfectadas) {
          await trx.rollback()
          return response.conflict({ message: 'Este turno ya fue llamado', llamadoId: yaLlamado.id })
        }
        llamadoId = yaLlamado.id
      } else {
        const llamado = await TurnoLlamado.create(
          {
            turnoId,
            modulo: moduloLimpio,
            usuarioId: idNumericoUsuario,
            llamadoAt: ahora,
          } as any,
          { client: trx }
        )
        llamadoId = llamado.id
      }

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
      return response.created({ message: 'Turno llamado', llamadoId })
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
   * POST /turnos-rtm/:id/preguntar
   * body: { modulo: string, usuarioId: number }
   * "Preguntar" desde "Turnos para Llamar" (turno SIN llamado activo
   * oficial): la pantalla lo anuncia (modal + pitido + voz: "…por favor
   * acérquese al {módulo}") pero el turno NO pasa a "pendientes de entrega"
   * ni al hero/histórico — sigue arriba y en la cola hasta un LLAMAR real.
   * Necesita fila en turno_llamados porque la pantalla solo detecta anuncios
   * por polling de GET /turnero/cola (ultimosLlamados, con enModulo=false).
   *  a) Sin fila → la crea: modulo = el seleccionado, tipo_llamado =
   *     'pregunta', llamado_oficial = false.
   *  b) Fila fuera de módulo (solo pregunta, o no presentado) → la actualiza:
   *     modulo = el seleccionado, llamado_at = ahora, tipo_llamado =
   *     'pregunta'; NO toca llamado_oficial ni no_presentado (sigue arriba).
   * Llamado activo oficial → 409 (se pregunta desde "pendientes de entrega",
   * ver llamarPregunta()). NO guarda la preferencia de módulo del usuario
   * (a diferencia de store()): una pregunta no es el llamado real.
   */
  public async preguntar({ params, request, response }: HttpContext) {
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

      const ahora = DateTime.local().setZone('America/Bogota')
      const existente = await TurnoLlamado.query({ client: trx }).where('turno_id', turnoId).first()

      let llamadoId: number
      if (!existente) {
        // a) Sin fila: se crea como "solo pregunta". Un doble clic simultáneo
        // choca con el índice único → 409 (ver catch).
        const llamado = await TurnoLlamado.create(
          {
            turnoId,
            modulo: moduloLimpio,
            usuarioId: idNumericoUsuario,
            llamadoAt: ahora,
            tipoLlamado: 'pregunta',
            llamadoOficial: false,
          } as any,
          { client: trx }
        )
        llamadoId = llamado.id
      } else {
        if (existente.entregadoAt) {
          await trx.rollback()
          return response.conflict({ message: 'Este turno ya fue entregado' })
        }
        if (esLlamadoActivoOficial(existente)) {
          await trx.rollback()
          return response.conflict({
            message: 'Este turno ya fue llamado: use "Preguntar" en "pendientes de entrega"',
          })
        }
        // b) Fila fuera de módulo: UPDATE condicionado a que siga fuera de
        // módulo (si otro operador lo llamó en el medio → 409).
        const resultado = await TurnoLlamado.query({ client: trx })
          .where('id', existente.id)
          .whereNull('entregado_at')
          .where((f) => f.where('no_presentado', true).orWhere('llamado_oficial', false))
          .update({
            modulo: moduloLimpio,
            usuario_id: idNumericoUsuario,
            llamado_at: ahora.toFormat('yyyy-MM-dd HH:mm:ss'),
            tipo_llamado: 'pregunta',
            updated_at: ahora.toFormat('yyyy-MM-dd HH:mm:ss'),
          })
        const filasAfectadas = Number(Array.isArray(resultado) ? resultado[0] : resultado)
        if (!filasAfectadas) {
          await trx.rollback()
          return response.conflict({ message: 'Este turno ya fue llamado', llamadoId: existente.id })
        }
        llamadoId = existente.id
      }

      await trx.commit()
      return response.ok({ message: 'Pregunta enviada', llamadoId })
    } catch (error: any) {
      try {
        await trx.rollback()
      } catch {}
      if (
        error?.code === 'ER_DUP_ENTRY' &&
        String(error?.sqlMessage ?? error?.message ?? '').includes('uq_turno_llamados_turno_id')
      ) {
        return response.conflict({ message: 'Este turno ya tiene un llamado en curso, intente de nuevo' })
      }
      console.error('Error al preguntar:', error)
      return response.internalServerError({ message: 'Error al enviar la pregunta' })
    }
  }

  /**
   * GET /turnos-rtm/en-modulo-pendientes-entrega
   * Turnos con llamado activo oficial (ver llamadoActivoOficial()). Alimenta
   * la segunda sección de TurnosParaLlamar.vue. Los que no se presentaron o
   * solo tienen un "Preguntar" NO aparecen acá: están en "Turnos para
   * Llamar" (ver sinLlamadoActivo()).
   * Orden: el que más lleva esperando primero (llamado_at asc).
   */
  public async pendientesEntrega({ response }: HttpContext) {
    try {
      // Solo turnos de HOY, igual que index() y colaTurnero(). Sin este
      // filtro, un turno viejo llamado hoy aparecía acá y, al marcarlo "No se
      // presentó", no podía volver a "Turnos para Llamar" (que sí filtra
      // por fecha) — desaparecía de las dos listas.
      const hoyISO = DateTime.local().setZone('America/Bogota').toISODate()!

      const llamados = await TurnoLlamado.query()
        .where(llamadoActivoOficial)
        .whereHas('turno', (q) => q.where('fecha', hoyISO))
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
          tipoLlamado: l.tipoLlamado,
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
   * turnos_rtms.estado ni ninguna otra tabla. Rechaza con 409 una fila que
   * solo tiene un "Preguntar" (llamado_oficial=false): no se entrega algo
   * que nunca se llamó a un módulo.
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
      if (!llamado.llamadoOficial) {
        return response.conflict({
          message: 'Este turno todavía no fue llamado a un módulo: no se puede entregar',
        })
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
   * id. tipo_llamado vuelve a 'modulo' (si el último anuncio fue una
   * pregunta, este vuelve a anunciar el módulo). Rechaza con 409 lo que no
   * sea un llamado activo oficial (no se presentó, o solo tiene un
   * "Preguntar"): esos se llaman desde "Turnos para Llamar", eligiendo
   * módulo (store()). Sin límite de repeticiones.
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
      if (!esLlamadoActivoOficial(llamado)) {
        return response.conflict({
          message: 'Este turno no está en un módulo: llámelo desde "Turnos para Llamar"',
        })
      }

      llamado.llamadoAt = DateTime.local().setZone('America/Bogota')
      llamado.tipoLlamado = 'modulo'
      await llamado.save()

      return response.ok({ message: 'Turno llamado de nuevo', llamadoId: llamado.id })
    } catch (error) {
      console.error('Error al volver a llamar:', error)
      return response.internalServerError({ message: 'Error al volver a llamar el turno' })
    }
  }

  /**
   * PATCH /turnos-rtm/:id/llamar-pregunta
   * :id es el turnoId. "Preguntar" desde "pendientes de entrega" (turno YA
   * llamado a un módulo). Mismo mecanismo que volverALlamar() (sube
   * llamado_at → la pantalla lo anuncia con modal + pitido + voz), pero
   * marca tipo_llamado = 'pregunta': la pantalla muestra "Por favor
   * acérquese a {módulo}" en vez de "Diríjase a {módulo}". Usa el módulo que
   * ya tenía (no recibe body) y no toca llamado_oficial (sigue true). Un
   * "Volver a llamar" posterior vuelve a 'modulo'. Solo aplica a llamados
   * activos oficiales — mismas validaciones que volverALlamar(). Para un
   * turno todavía sin llamar, ver preguntar().
   */
  public async llamarPregunta({ params, response }: HttpContext) {
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
        return response.badRequest({ message: 'Este turno ya fue entregado, no se puede llamar' })
      }
      if (!esLlamadoActivoOficial(llamado)) {
        return response.conflict({
          message: 'Este turno no está en un módulo: use "Preguntar" desde "Turnos para Llamar"',
        })
      }

      llamado.llamadoAt = DateTime.local().setZone('America/Bogota')
      llamado.tipoLlamado = 'pregunta'
      await llamado.save()

      return response.ok({ message: 'Turno llamado para pregunta', llamadoId: llamado.id })
    } catch (error) {
      console.error('Error al llamar para pregunta:', error)
      return response.internalServerError({ message: 'Error al llamar el turno para pregunta' })
    }
  }

  /**
   * PATCH /turnos-rtm/:id/no-presentado
   * :id es el turnoId. Acción de una sola vía (ya no es toggle): pone
   * no_presentado = true, sin body. A partir de ahí el turno sale de
   * "Llamando ahora" y de "pendientes de entrega" y vuelve a la cola y a
   * "Turnos para Llamar" (ver sinLlamadoActivo()); se vuelve a llamar con
   * store(), que reutiliza esta fila. Si ya estaba marcado, no hace nada.
   * Rechaza con 409 si el turno ya tiene entregado_at (estado terminal, ver
   * Área 3 de la revisión QA del Turnero) o si la fila solo tiene un
   * "Preguntar" (llamado_oficial=false): nunca se llamó a un módulo.
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
      if (!llamado.llamadoOficial) {
        return response.conflict({ message: 'Este turno todavía no fue llamado a un módulo' })
      }

      if (!llamado.noPresentado) {
        llamado.noPresentado = true
        await llamado.save()
      }

      return response.ok({ message: 'Turno marcado como no presentado', noPresentado: true })
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
   *   - 'finalizado' sin llamado activo      -> 'por_llamar'    ("Listo para entregar")
   *     (misma condición que index()/pendientes-llamar, ver
   *     sinLlamadoActivo() — un turno deja de aparecer acá en el instante en
   *     que store() le registra un llamado, vuelve si se marca
   *     no_presentado, y sigue acá aunque se le haga "Preguntar"; se ve
   *     igual que cualquier otro 'por_llamar').
   *
   * ultimosLlamados combina, más reciente primero:
   *   - llamados activos oficiales (enModulo=true): los que pinta
   *     "Llamando ahora" (hero + histórico).
   *   - preguntas de HOY sobre turnos fuera de módulo (enModulo=false): solo
   *     viajan para que la pantalla las detecte por polling y dispare modal
   *     + pitido + voz — PanelEntrega.vue las filtra, el turno se sigue
   *     viendo una sola vez, en la cola. Solo las de turnos de hoy, para
   *     que una pregunta que nunca llegó a LLAMAR no se quede ocupando lugar.
   *   Ambas filtran por turnos_rtms.fecha = hoy, igual que colaSeguimiento.
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
        .where(sinLlamadoActivo)
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
          // Una segunda vez no factura: ya está lista para Certificación.
          const listoParaCertificar = t.tieneFacturacion || esTurnoSegundaVez(t)
          return mapearTurno(t, listoParaCertificar && esRtm ? 'certificacion' : 'en_proceso')
        }),
        ...listosParaEntrega.map((t) => mapearTurno(t, 'por_llamar')),
      ]
        .sort((a, b) => {
          const prioridad = PRIORIDAD_ESTADO[a.estado] - PRIORIDAD_ESTADO[b.estado]
          return prioridad !== 0 ? prioridad : a._turnoNumero - b._turnoNumero
        })
        .map(({ _turnoNumero, ...turno }) => turno)

      // entregado_at ya seteado -> el turno salió del turnero para siempre
      // (no vuelve a aparecer). Los que no se presentaron tampoco están en
      // la primera consulta: volvieron a colaSeguimiento como 'por_llamar'.
      // Dos consultas separadas (cada una con su propio límite) para que las
      // preguntas del día nunca desplacen a los llamados reales del top 20.
      // Las dos, solo turnos de HOY (turnos_rtms.fecha), mismo criterio que
      // las consultas de arriba, index() y pendientesEntrega(): sin él, un
      // turno viejo llamado hoy aparecía en el hero/histórico.
      const llamadosOficiales = await TurnoLlamado.query()
        .where(llamadoActivoOficial)
        .whereHas('turno', (q) => q.where('fecha', hoyISO))
        .preload('turno', (q) => q.preload('servicio'))
        .orderBy('llamado_at', 'desc')
        .limit(20)

      const preguntasFueraDeModulo = await TurnoLlamado.query()
        .whereNull('entregado_at')
        .where('tipo_llamado', 'pregunta')
        .where((f) => f.where('no_presentado', true).orWhere('llamado_oficial', false))
        .whereHas('turno', (q) => q.where('fecha', hoyISO))
        .preload('turno', (q) => q.preload('servicio'))
        .orderBy('llamado_at', 'desc')
        .limit(20)

      // tipoLlamado: 'modulo' → "Diríjase a {módulo}", 'pregunta' → "Por
      // favor acérquese a {módulo}" (el front decide el texto; el módulo es
      // siempre el real). enModulo: ver el comentario del método.
      const mapearLlamado = (l: TurnoLlamado, enModulo: boolean) => {
        const codigoServicio = (l.turno.servicio?.codigoServicio ?? '').toUpperCase()
        return {
          id: String(l.turnoId),
          placa: l.turno.placa,
          turno: l.turno.turnoNumero > 0 ? String(l.turno.turnoNumero) : null,
          canal: CODIGO_A_CANAL_TURNERO[codigoServicio] ?? codigoServicio,
          modulo: l.modulo,
          llamadoEn: l.llamadoAt.toISO(),
          tipoLlamado: l.tipoLlamado,
          enModulo,
          _llamadoMs: l.llamadoAt.toMillis(),
        }
      }

      const ultimosLlamados = [
        ...llamadosOficiales.filter((l) => !!l.turno).map((l) => mapearLlamado(l, true)),
        ...preguntasFueraDeModulo.filter((l) => !!l.turno).map((l) => mapearLlamado(l, false)),
      ]
        .sort((a, b) => b._llamadoMs - a._llamadoMs)
        .map(({ _llamadoMs, ...llamado }) => llamado)

      return response.ok({ colaSeguimiento, ultimosLlamados })
    } catch (error) {
      console.error('Error en colaTurnero:', error)
      return response.internalServerError({ message: 'Error al obtener la cola del turnero' })
    }
  }
}
