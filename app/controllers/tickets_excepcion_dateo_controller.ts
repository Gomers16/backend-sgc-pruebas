// app/controllers/tickets_excepcion_dateo_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'

import Ticket from '#models/ticket'
import TipoTicket from '#models/tipo_ticket'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'
import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import Comision from '#models/comision'
import FacturacionTicket from '#models/facturacion_ticket'

import {
  dentroVentanaDateoTurno,
  getMinutosVentanaGlobal,
  getMinutosVentanaTicket,
} from '#services/reserva_dateo_service'
import { esEvidenciaValida } from '#services/ticket_acceso_service'
import { resolverIntentoDateo } from '#services/intento_dateo_service'
import { resolverDecisionComision } from '#services/decision_comision_ticket_service'
import { registrarEventoTicket } from '#services/ticket_eventos_service'
import {
  leerDecisionConvenioCrear,
  convenioNoAsignadoAlComercial,
} from '#services/convenio_ticket_service'
import { decidirCasoComision, type CasoComision } from '#services/comision_calculo_service'
import {
  calcularComisionTicketExcepcion,
  aplicarComisionTicketExcepcion,
} from '#services/comision_ticket_excepcion_service'
import { conflictoTurnoSegundaVez, esTurnoSegundaVez } from '#services/segunda_vez_service'

function readOptionalNumber(input: unknown): number | null {
  if (input === undefined || input === null) return null
  const s = String(input).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export default class TicketsExcepcionDateoController {
  /**
   * GET /tickets/config/ventana
   * Límite global de minutos de ventana con comisión completa (fallback cuando no
   * hay override por asesor). Mismo patrón que
   * captacion_dateos_controller.ts::maxRedateosConfigGet(). Solo lectura:
   * sin fila devuelve el default (60), no la crea.
   */
  public async ventanaConfigGet({ response }: HttpContext) {
    return response.ok({ minutos_ventana: await getMinutosVentanaGlobal() })
  }

  /**
   * POST /tickets/config/ventana
   * Actualiza el límite global. body: { minutos_ventana }
   */
  public async ventanaConfigUpsert({ request, response }: HttpContext) {
    const { default: ConfiguracionVentanaTicketGlobal } = await import(
      '#models/configuracion_ventana_ticket_global'
    )

    const raw = request.input('minutos_ventana')
    const minutosVentana = Math.trunc(Number(raw))
    if (!Number.isFinite(minutosVentana) || minutosVentana <= 0) {
      return response.badRequest({
        message: 'minutos_ventana debe ser un número entero mayor a 0',
      })
    }

    let config = await ConfiguracionVentanaTicketGlobal.query().first()
    if (!config) {
      config = await ConfiguracionVentanaTicketGlobal.create({ minutosVentana } as any)
    } else {
      config.minutosVentana = minutosVentana
      await config.save()
    }

    return response.ok({ minutos_ventana: config.minutosVentana })
  }

  /**
   * GET /tickets/config/ventana/asesores?asesorId=
   * Lista los overrides por asesor (NULL = usa el global).
   */
  public async ventanaAsesoresIndex({ request, response }: HttpContext) {
    const { default: ConfiguracionVentanaTicketAsesor } = await import(
      '#models/configuracion_ventana_ticket_asesor'
    )

    const asesorId = request.input('asesorId') as number | undefined
    const query = ConfiguracionVentanaTicketAsesor.query().preload('asesor')
    if (asesorId) query.where('asesor_id', asesorId)

    const configs = await query
    const data = configs.map((c) => {
      const asesor = (c as any).$preloaded?.asesor || null
      return {
        id: c.id,
        asesor_id: c.asesorId,
        asesor_nombre: asesor ? asesor.nombre : null,
        minutos_ventana: c.minutosVentana,
      }
    })

    return response.ok({ data })
  }

  /**
   * POST /tickets/config/ventana/asesores
   * Crea/actualiza el override de un asesor. body: { asesor_id, minutos_ventana }
   * minutos_ventana null/vacío = elimina el override (vuelve a usar el global).
   */
  public async ventanaAsesoresUpsert({ request, response }: HttpContext) {
    const { default: ConfiguracionVentanaTicketAsesor } = await import(
      '#models/configuracion_ventana_ticket_asesor'
    )

    const payload = request.only(['asesor_id', 'minutos_ventana'])

    const asesorId = Number(payload.asesor_id)
    if (!asesorId) return response.badRequest({ message: 'asesor_id es requerido' })
    const asesor = await AgenteCaptacion.find(asesorId)
    if (!asesor) return response.badRequest({ message: 'asesor_id no existe' })

    let minutosVentana: number | null = null
    if (
      payload.minutos_ventana !== null &&
      payload.minutos_ventana !== undefined &&
      payload.minutos_ventana !== ''
    ) {
      minutosVentana = Math.trunc(Number(payload.minutos_ventana))
      if (!Number.isFinite(minutosVentana) || minutosVentana <= 0) {
        return response.badRequest({
          message:
            'minutos_ventana debe ser un número entero mayor a 0, o null para usar el global',
        })
      }
    }

    let config = await ConfiguracionVentanaTicketAsesor.query().where('asesor_id', asesorId).first()

    if (!config) {
      config = await ConfiguracionVentanaTicketAsesor.create({ asesorId, minutosVentana } as any)
    } else {
      config.minutosVentana = minutosVentana
      await config.save()
    }

    return response.ok({
      id: config.id,
      asesor_id: config.asesorId,
      minutos_ventana: config.minutosVentana,
    })
  }

  /**
   * DELETE /tickets/config/ventana/asesores/:id
   * Elimina el override — el asesor vuelve a usar el límite global.
   */
  public async ventanaAsesoresDelete({ params, response }: HttpContext) {
    const { default: ConfiguracionVentanaTicketAsesor } = await import(
      '#models/configuracion_ventana_ticket_asesor'
    )

    const config = await ConfiguracionVentanaTicketAsesor.find(params.id)
    if (!config) return response.notFound({ message: 'Configuración no encontrada' })

    await config.delete()
    return response.ok({ message: 'Configuración eliminada correctamente' })
  }

  /**
   * POST /tickets-excepcion-dateo
   * Body: { turno_id, observacion, evidencia_chat_url,
   *         evidencia_grupo_whatsapp_url, evidencia_bloqueo_url,
   *         evidencia_calamidad_url?,
   *         // intento de dateo (lo que store() rechazó con REQUIERE_TICKET_DATEO)
   *         canal?, convenio_id?, servicio_id?, descuento_id?, es_avance?,
   *         comprobante_avance_url?, telefono?,
   *         sin_convenio? }
   * Convenio obligatorio de decidir: convenio_id o sin_convenio=true (uno de
   * los dos, 400 CONVENIO_NO_DECIDIDO). El asesor convenio no elige: queda
   * con el suyo. SUPER_ADMIN/GERENCIA pueden poner un convenio activo que el
   * comercial no tiene asignado (queda convenio_no_asignado en el evento).
   * El intento se valida con resolverIntentoDateo(), la misma regla de
   * store(): p. ej. un asesor convenio queda con su convenio aunque no venga.
   * El comercial se resuelve del usuario autenticado (mismo patrón que
   * captacion_dateos_controller.ts::store(), AgenteCaptacion.findBy('usuarioId', ...)).
   * Las evidencias ya vienen subidas (POST /api/uploads/images, una llamada
   * por imagen) — este endpoint solo recibe las URLs resultantes.
   */
  public async crear({ request, response, auth }: HttpContext) {
    const payload = request.only([
      'turno_id',
      'comercial_id',
      'convenio_id',
      'canal',
      'servicio_id',
      'descuento_id',
      'es_avance',
      'comprobante_avance_url',
      'telefono',
      'sin_convenio',
      'observacion',
      'evidencia_chat_url',
      'evidencia_grupo_whatsapp_url',
      'evidencia_bloqueo_url',
      'evidencia_calamidad_url',
    ])

    const turnoId = readOptionalNumber(payload.turno_id)
    if (turnoId === null) return response.badRequest({ message: 'turno_id es requerido' })

    const observacion = (payload.observacion as string | undefined)?.trim()
    if (!observacion) return response.badRequest({ message: 'observacion es requerida' })

    const evidenciaChatUrl = (payload.evidencia_chat_url as string | undefined) || null
    const evidenciaGrupoWhatsappUrl =
      (payload.evidencia_grupo_whatsapp_url as string | undefined) || null
    const evidenciaBloqueoUrl = (payload.evidencia_bloqueo_url as string | undefined) || null
    const evidenciaCalamidadUrl = (payload.evidencia_calamidad_url as string | undefined) || null

    if (!evidenciaChatUrl || !evidenciaGrupoWhatsappUrl || !evidenciaBloqueoUrl) {
      return response.badRequest({
        message:
          'evidencia_chat_url, evidencia_grupo_whatsapp_url y evidencia_bloqueo_url son obligatorias',
      })
    }

    // COMERCIAL: siempre se resuelve de su propio usuario, nunca acepta
    // comercial_id del body (no puede crear a nombre de otro).
    // SUPER_ADMIN/GERENCIA: respaldo cuando el comercial no tiene su usuario
    // a mano — deben indicar explícitamente a nombre de qué comercial se
    // registra el ticket, porque su propio usuario normalmente no tiene un
    // agentes_captacions asociado.
    await auth.user!.load('rol')
    const rolNombre = (auth.user!.rol?.nombre ?? '').toUpperCase()
    const esRespaldoPrivilegiado = ['SUPER_ADMIN', 'GERENCIA'].includes(rolNombre)

    let comercial: AgenteCaptacion | null
    if (esRespaldoPrivilegiado) {
      const comercialIdBody = readOptionalNumber(payload.comercial_id)
      if (comercialIdBody === null) {
        return response.badRequest({
          message: 'comercial_id es requerido cuando quien crea el ticket es SUPER_ADMIN/GERENCIA',
        })
      }
      comercial = await AgenteCaptacion.find(comercialIdBody)
      if (!comercial) return response.badRequest({ message: 'comercial_id no existe' })
    } else {
      comercial = await AgenteCaptacion.findBy('usuarioId', auth.user!.id)
      if (!comercial) {
        return response.badRequest({
          message: 'El usuario actual no tiene un agente comercial asociado',
        })
      }
    }

    const tipoTicket = await TipoTicket.findBy('codigo', 'EXCEPCION_DATEO')
    if (!tipoTicket) {
      return response.internalServerError({
        message: 'Tipo de ticket EXCEPCION_DATEO no configurado en tipos_ticket',
      })
    }

    const hoyISO = DateTime.local().setZone('America/Bogota').toISODate()!

    // Todo lo que depende del turno corre con el turno bloqueado (FOR
    // UPDATE): dos crear() simultáneos sobre el mismo turno se serializan y
    // el segundo ya ve el PENDIENTE del primero.
    const trx = await Database.transaction()
    try {
      const turno = await TurnoRtm.query({ client: trx }).where('id', turnoId).forUpdate().first()
      if (!turno) {
        await trx.rollback()
        return response.notFound({ message: 'Turno no encontrado' })
      }
      // Segunda vez: sin dateo ni ticket de excepción de dateo.
      if (esTurnoSegundaVez(turno)) {
        await trx.rollback()
        return response.conflict(conflictoTurnoSegundaVez('dateo ni ticket de excepción de dateo'))
      }

      // Convenio: después de la segunda vez (esa respuesta manda) y antes del
      // resto de validaciones del turno.
      const decisionConvenio = leerDecisionConvenioCrear({
        convenioId: readOptionalNumber(payload.convenio_id),
        sinConvenio: payload.sin_convenio,
        esAsesorConvenio: (comercial.tipo || '').toUpperCase() === 'ASESOR_CONVENIO',
      })
      if (!decisionConvenio.ok) {
        await trx.rollback()
        return response.badRequest({
          code: decisionConvenio.code,
          message: decisionConvenio.message,
        })
      }
      const convenioId = decisionConvenio.convenioId
      if (convenioId !== null) {
        const convenio = await Convenio.find(convenioId, { client: trx })
        if (!convenio || !convenio.activo) {
          await trx.rollback()
          return response.badRequest({ message: 'convenio_id no existe o está inactivo' })
        }
      }
      if (turno.fecha.setZone('America/Bogota').toISODate() !== hoyISO) {
        await trx.rollback()
        return response.conflict({
          code: 'TICKET_TURNO_OTRO_DIA',
          message: 'Solo se puede crear el ticket para un turno de hoy.',
        })
      }
      if (!['activo', 'finalizado'].includes(turno.estado)) {
        await trx.rollback()
        return response.conflict({
          code: 'TICKET_TURNO_ESTADO_INVALIDO',
          message: `El turno está ${turno.estado}: solo se acepta un turno activo o finalizado.`,
        })
      }
      if (turno.captacionDateoId) {
        await trx.rollback()
        return response.badRequest({ message: 'Este turno ya tiene un dateo vinculado' })
      }

      const yaExistePendiente = await TicketDetalleExcepcionDateo.query({ client: trx })
        .where('turno_id', turnoId)
        .whereHas('ticket', (q) => q.where('estado', 'PENDIENTE'))
        .first()
      if (yaExistePendiente) {
        await trx.rollback()
        return response.conflict({
          code: 'TICKET_PENDIENTE_EXISTENTE',
          message: 'Ya existe un ticket pendiente para este turno',
          ticketId: yaExistePendiente.ticketId,
        })
      }

      // Solo imágenes subidas por POST /api/media/upload que existan en disco.
      const evidenciaInvalida = (
        [
          ['evidencia_chat_url', evidenciaChatUrl],
          ['evidencia_grupo_whatsapp_url', evidenciaGrupoWhatsappUrl],
          ['evidencia_bloqueo_url', evidenciaBloqueoUrl],
          ['evidencia_calamidad_url', evidenciaCalamidadUrl],
        ] as const
      ).find(([, url]) => url !== null && !esEvidenciaValida(url))
      if (evidenciaInvalida) {
        await trx.rollback()
        return response.badRequest({
          code: 'EVIDENCIA_INVALIDA',
          message: `${evidenciaInvalida[0]} no es una imagen subida al sistema`,
        })
      }

      const resIntento = await resolverIntentoDateo({
        agenteId: comercial.id,
        canal: (payload.canal as string | undefined) || null,
        convenioId,
        descuentoId: readOptionalNumber(payload.descuento_id),
        servicioId: readOptionalNumber(payload.servicio_id) ?? turno.servicioId,
        esAvance: payload.es_avance === true || payload.es_avance === 'true',
        comprobanteAvanceUrl: (payload.comprobante_avance_url as string | undefined) || null,
        permitirConvenioNoAsignado: esRespaldoPrivilegiado,
      })
      if (!resIntento.ok) {
        await trx.rollback()
        return response
          .status(resIntento.status)
          .send({ code: 'INTENTO_DATEO_INVALIDO', message: resIntento.message })
      }
      const intento = resIntento.intento
      if (intento.servicioIdEfectivo !== turno.servicioId) {
        await trx.rollback()
        return response.badRequest({
          code: 'INTENTO_DATEO_INVALIDO',
          message: 'El servicio del dateo no coincide con el del turno',
        })
      }
      if (intento.comprobanteAvanceUrl && !esEvidenciaValida(intento.comprobanteAvanceUrl)) {
        await trx.rollback()
        return response.badRequest({
          code: 'EVIDENCIA_INVALIDA',
          message: 'comprobante_avance_url no es una imagen subida al sistema',
        })
      }
      const convenioNoAsignadoCrear = await convenioNoAsignadoAlComercial({
        canal: intento.canal,
        comercialId: comercial.id,
        convenioId: intento.convenioId,
        client: trx,
      })
      const telefono =
        String(payload.telefono ?? '')
          .replace(/\D/g, '')
          .slice(0, 20) || null

      // dentro_ventana se calcula y persiste AQUÍ, con la ventana vigente en
      // este momento (posible override del comercial que crea el ticket) — no
      // se recalcula después, así un cambio de configuración posterior no
      // afecta tickets ya creados (ver dentro_ventana en el modelo/migración).
      const minutosVentana = await getMinutosVentanaTicket(comercial.id)
      const { dentro, minutosTotales, minutosExceso } = dentroVentanaDateoTurno(
        turno,
        minutosVentana
      )

      const ticket = await Ticket.create(
        {
          tipoTicketId: tipoTicket.id,
          titulo: `Excepción de Dateo — placa ${turno.placa} (turno #${turno.turnoNumero})`,
          estado: 'PENDIENTE',
          creadoPorId: auth.user!.id,
          moduloRelacionado: 'DATEOS',
        },
        { client: trx }
      )

      const detalle = await TicketDetalleExcepcionDateo.create(
        {
          ticketId: ticket.id,
          turnoId: turno.id,
          placa: turno.placa,
          comercialId: comercial.id,
          convenioId: intento.convenioId,
          convenioIdOriginal: intento.convenioId,
          sinConvenioExplicito: intento.convenioId === null,
          canal: intento.canal,
          servicioId: intento.servicioIdEfectivo,
          descuentoId: intento.descuentoId,
          esAvance: intento.esAvance,
          comprobanteAvanceUrl: intento.comprobanteAvanceUrl,
          telefono,
          horaIngreso: turno.horaIngreso,
          horaIntentoDateo: DateTime.now(),
          minutosTotales,
          minutosExceso,
          dentroVentana: dentro,
          observacion,
          evidenciaChatUrl,
          evidenciaGrupoWhatsappUrl,
          evidenciaBloqueoUrl,
          evidenciaCalamidadUrl,
        },
        { client: trx }
      )

      await registrarEventoTicket(trx, {
        ticketId: ticket.id,
        tipo: 'CREADO',
        usuarioId: auth.user!.id,
        datos: {
          dentro_ventana: dentro,
          minutos_exceso: minutosExceso,
          comercial_id: comercial.id,
          convenio_id: intento.convenioId,
          canal: intento.canal,
          sin_convenio: intento.convenioId === null,
          convenio_no_asignado: convenioNoAsignadoCrear,
        },
      })

      await trx.commit()
      return response.created({ ticket: ticket.serialize(), detalle: detalle.serialize() })
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }

  /**
   * PATCH /tickets-excepcion-dateo/:id/aprobar
   * Body: {
   *   con_comision_asesor: boolean, con_comision_convenio?: boolean
   *       — dentro y fuera de ventana. Combinaciones válidas por caso en
   *       decision_comision_ticket_service.ts (Caso 1 sin flag de convenio,
   *       Caso 2 flags iguales, Caso 3 las 4). Dentro de ventana un body sin
   *       flags (frontend anterior) = comisión completa. `con_comision` sola
   *       se sigue aceptando como flag del asesor (frontend anterior).
   *   convenio_id?: number | null — opcional: gerencia corrige el convenio
   *                            del intento (null = sin convenio). El original
   *                            queda en convenio_id_original. Puede ser
   *                            un convenio activo no asignado al comercial
   *                            (queda convenio_no_asignado en el evento).
   *   confirmar_sin_convenio?: boolean — obligatorio (409
   *       CONFIRMAR_SIN_CONVENIO) si el ticket queda sin convenio y nadie lo
   *       decidió al crear (sin_convenio_explicito distinto de true: tickets
   *       anteriores o de producción local). Corregir a convenio_id null
   *       también cuenta como decisión.
   * }
   *
   * El dateo se crea con el intento guardado en el ticket (canal, convenio,
   * servicio, descuento, avance, teléfono). Tickets anteriores a la Fase 3
   * (canal NULL) resuelven el intento con el comercial del ticket, igual que
   * store(): un asesor convenio queda con su convenio (Caso 2).
   *
   * El cálculo de la comisión (caso/escenario/continuidad/descuento +
   * calcularComision()) replica el criterio de
   * facturacion_tickets_controller.ts::applyCommissionHook(); el caso sale de
   * decidirCasoComision(), compartida por ambos.
   */
  public async aprobar({ params, request, response, auth }: HttpContext) {
    // El ticket se bloquea (FOR UPDATE) antes de mirar su estado: dos
    // aprobaciones simultáneas se serializan y la segunda ve APROBADO → 409.
    const trx = await Database.transaction()
    try {
      const ticket = await Ticket.query({ client: trx }).where('id', params.id).forUpdate().first()
      if (!ticket) {
        await trx.rollback()
        return response.notFound({ message: 'Ticket no encontrado' })
      }
      if (ticket.estado !== 'PENDIENTE') {
        await trx.rollback()
        return response.conflict({
          code: 'TICKET_YA_RESUELTO',
          message: 'Solo se pueden aprobar tickets PENDIENTES',
          estado: ticket.estado,
        })
      }

      const detalle = await TicketDetalleExcepcionDateo.query({ client: trx })
        .where('ticket_id', ticket.id)
        .first()
      if (!detalle) {
        await trx.rollback()
        return response.notFound({ message: 'Detalle del ticket no encontrado' })
      }

      // dentro_ventana quedó fijado AL CREAR el ticket (snapshot de la ventana
      // configurada en ese momento) — no se recalcula acá. mysql2 devuelve
      // TINYINT(1) como 0/1 (no boolean real) — Boolean() en vez de === true.
      const dentroVentana = Boolean(detalle.dentroVentana)

      // La decisión se valida del todo cuando se conoce el caso (más abajo);
      // acá solo se corta temprano si falta el flag del asesor fuera de
      // ventana (dentro, sin flags = comisión completa).
      const flagsComision = {
        conComisionAsesor: request.input('con_comision_asesor'),
        conComisionConvenio: request.input('con_comision_convenio'),
        conComision: request.input('con_comision'),
      }
      if (
        !dentroVentana &&
        typeof flagsComision.conComisionAsesor !== 'boolean' &&
        typeof flagsComision.conComision !== 'boolean'
      ) {
        await trx.rollback()
        return response.badRequest({
          code: 'COMBINACION_COMISION_INVALIDA',
          message:
            'con_comision_asesor es requerido (true/false) cuando el ticket está fuera de ventana',
        })
      }

      // 1. Carga el turno del ticket.
      const turno = await TurnoRtm.query({ client: trx }).where('id', detalle.turnoId).first()
      if (!turno) {
        await trx.rollback()
        return response.notFound({ message: 'Turno del ticket no encontrado' })
      }
      turno.useTransaction(trx)

      if (turno.captacionDateoId) {
        await trx.rollback()
        return response.conflict({
          message:
            'El turno ya tiene un dateo vinculado — no se puede aprobar este ticket (verifica si ya se resolvió por otra vía).',
        })
      }

      const comercial = await AgenteCaptacion.find(detalle.comercialId, { client: trx })
      if (!comercial) {
        await trx.rollback()
        return response.notFound({ message: 'Comercial del ticket no encontrado' })
      }

      // 2. Intento de dateo: el guardado al crear, salvo que el ticket sea
      // anterior a la Fase 3 (canal NULL) o gerencia corrija el convenio — en
      // esos casos se vuelve a resolver/validar con la misma regla de store().
      const corrigeConvenio = Object.prototype.hasOwnProperty.call(request.all(), 'convenio_id')
      const convenioIdCorregido = corrigeConvenio
        ? readOptionalNumber(request.input('convenio_id'))
        : null
      if (corrigeConvenio && convenioIdCorregido !== null) {
        const conv = await Convenio.find(convenioIdCorregido, { client: trx })
        if (!conv || !conv.activo) {
          await trx.rollback()
          return response.badRequest({ message: 'convenio_id no existe o está inactivo' })
        }
      }

      const esAvanceGuardado = Boolean(detalle.esAvance)
      let canal = detalle.canal
      let convenioId = detalle.convenioId
      let asesorConvenioIdDateo: number | null =
        detalle.canal === 'ASESOR_CONVENIO' ? comercial.id : null
      if (!detalle.canal || corrigeConvenio) {
        const res = await resolverIntentoDateo({
          agenteId: comercial.id,
          canal: detalle.canal,
          convenioId: corrigeConvenio ? convenioIdCorregido : detalle.convenioId,
          descuentoId: detalle.descuentoId,
          servicioId: detalle.servicioId ?? turno.servicioId,
          esAvance: esAvanceGuardado,
          comprobanteAvanceUrl: detalle.comprobanteAvanceUrl,
          // Solo SUPER_ADMIN/GERENCIA llegan acá (ruta).
          permitirConvenioNoAsignado: true,
        })
        if (!res.ok) {
          await trx.rollback()
          return response
            .status(res.status)
            .send({ code: 'INTENTO_DATEO_INVALIDO', message: res.message })
        }
        canal = res.intento.canal
        convenioId = res.intento.convenioId
        asesorConvenioIdDateo = res.intento.asesorConvenioId
      }

      // Sin convenio: alguien tuvo que decidirlo (al crear o ahora).
      const sinConvenioAlCrear =
        detalle.sinConvenioExplicito === null ? null : Boolean(detalle.sinConvenioExplicito)
      const sinConvenioConfirmado =
        convenioId === null &&
        sinConvenioAlCrear !== true &&
        ((corrigeConvenio && convenioIdCorregido === null) ||
          request.input('confirmar_sin_convenio') === true)
      if (convenioId === null && sinConvenioAlCrear !== true && !sinConvenioConfirmado) {
        await trx.rollback()
        return response.conflict({
          code: 'CONFIRMAR_SIN_CONVENIO',
          message:
            'Nadie decidió el convenio de este ticket: elige el convenio o confirma que es sin convenio (directo).',
        })
      }

      const convenioNoAsignado = await convenioNoAsignadoAlComercial({
        canal,
        comercialId: comercial.id,
        convenioId,
        client: trx,
      })

      const convenio = convenioId ? await Convenio.find(convenioId, { client: trx }) : null

      // 3. Crea el captacion_dateo (servicioId = el del turno si el ticket no
      // lo trae, obligatorio para que dateoAplicaAServicio() lo valide).
      const dateo = await CaptacionDateo.create(
        {
          canal: canal as any,
          agenteId: comercial.id,
          convenioId,
          asesorConvenioId: asesorConvenioIdDateo,
          placa: turno.placa,
          telefono: detalle.telefono,
          servicioId: detalle.servicioId ?? turno.servicioId,
          descuentoId: detalle.descuentoId,
          esAvance: esAvanceGuardado,
          comprobanteAvanceUrl: esAvanceGuardado ? detalle.comprobanteAvanceUrl : null,
          origen: 'UI',
          resultado: 'EN_PROCESO',
          consumidoTurnoId: turno.id,
          consumidoAt: DateTime.now(),
          observacion: detalle.observacion,
        } as any,
        { client: trx }
      )

      // 4. Vinculación retroactiva.
      turno.captacionDateoId = dateo.id
      await turno.save()

      // 5. ¿Ya existe un facturacion_ticket CONFIRMADA para este turno?
      const facturacionConfirmada = await FacturacionTicket.query({ client: trx })
        .where('turno_id', turno.id)
        .where('estado', 'CONFIRMADA')
        .first()

      const asesorConvenioIdReal = convenio?.asesorConvenioId ?? null
      const caso: CasoComision = decidirCasoComision({
        convenioId: dateo.convenioId,
        agenteId: dateo.agenteId,
        canal: dateo.canal,
        asesorConvenioIdDelConvenio: asesorConvenioIdReal,
      })

      const resDecision = resolverDecisionComision({ dentroVentana, caso, ...flagsComision })
      if (!resDecision.ok) {
        await trx.rollback()
        return response.badRequest({
          code: 'COMBINACION_COMISION_INVALIDA',
          message: resDecision.message,
          caso,
        })
      }
      const decision = resDecision.decision

      // Cálculo compartido con corregirConvenio() (comision_ticket_excepcion_service).
      const calculo = await calcularComisionTicketExcepcion({
        trx,
        turno,
        dateo,
        caso,
        asesorConvenioIdReal,
        facturacionConfirmada: facturacionConfirmada ?? null,
      })

      let comisionCreada: Comision | null = null
      if (facturacionConfirmada) {
        dateo.resultado = 'EXITOSO'
        await dateo.useTransaction(trx).save()

        const c = new Comision()
        c.useTransaction(trx)
        c.esConfig = false
        c.captacionDateoId = dateo.id
        c.tipoServicio = 'RTM'
        c.estado = 'PENDIENTE'
        c.fechaCalculo = DateTime.now()
        c.calculadoPor = auth.user!.id
        c.porcentaje = '0'
        const foto = aplicarComisionTicketExcepcion(c, {
          calculo,
          dateo,
          asesorConvenioIdReal,
          facturacionConfirmada,
          decision,
        })
        // Foto del valor calculado para el "dejado de pagar" exacto (solo
        // si hubo algún "sin comisión").
        if (foto.montoAsesorCalculado !== null) {
          detalle.montoAsesorCalculado = foto.montoAsesorCalculado
          detalle.montoConvenioCalculado = foto.montoConvenioCalculado
        }
        await c.save()
        comisionCreada = c
      }
      // Si NO existe facturación confirmada: applyCommissionHook() relee
      // turno.captacionDateoId cuando el ticket de facturación se confirme y
      // toma descuento/avance del dateo recién creado.

      // 6. Cierra el ticket.
      detalle.useTransaction(trx)
      detalle.conComisionAsesor = decision.asesor
      detalle.conComisionConvenio = decision.convenio
      // Transición: producción local (misma BD) todavía lee con_comision.
      detalle.conComision = decision.asesor
      if (!detalle.canal) {
        // Ticket anterior a la Fase 3: el convenio con el que llegó.
        detalle.convenioIdOriginal = detalle.convenioId
      }
      detalle.canal = canal
      detalle.convenioId = convenioId
      detalle.sinConvenioExplicito = convenioId === null
      detalle.aprobadoPorId = auth.user!.id
      detalle.aprobadoAt = DateTime.now()
      await detalle.save()

      ticket.useTransaction(trx)
      ticket.estado = 'APROBADO'
      ticket.resueltoAt = DateTime.now()
      await ticket.save()

      const convenioCorregido =
        corrigeConvenio && (detalle.convenioIdOriginal ?? null) !== (convenioId ?? null)
      if (convenioCorregido) {
        await registrarEventoTicket(trx, {
          ticketId: ticket.id,
          tipo: 'CONVENIO_CORREGIDO',
          usuarioId: auth.user!.id,
          datos: {
            convenio_anterior_id: detalle.convenioIdOriginal,
            convenio_nuevo_id: convenioId,
            convenio_no_asignado: convenioNoAsignado,
          },
        })
      }
      await registrarEventoTicket(trx, {
        ticketId: ticket.id,
        tipo: 'APROBADO',
        usuarioId: auth.user!.id,
        datos: {
          caso,
          dentro_ventana: dentroVentana,
          con_comision_asesor: decision.asesor,
          con_comision_convenio: decision.convenio,
          comision_id: comisionCreada?.id ?? null,
          dateo_id: dateo.id,
          convenio_id: convenioId,
          sin_convenio_confirmado: sinConvenioConfirmado,
          convenio_no_asignado: convenioNoAsignado,
        },
      })

      await trx.commit()

      return response.ok({
        ticket: ticket.serialize(),
        detalle: detalle.serialize(),
        dateoId: dateo.id,
        comisionId: comisionCreada?.id ?? null,
        caso,
        dentroVentana,
        conComision: decision.asesor,
        conComisionAsesor: decision.asesor,
        conComisionConvenio: decision.convenio,
        convenioCorregido,
        convenioNoAsignado,
        sinConvenioConfirmado,
      })
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }

  /**
   * PATCH /tickets-excepcion-dateo/:id/convenio — corrige el convenio de un
   * ticket YA APROBADO (SUPER_ADMIN/GERENCIA).
   * POST /tickets-excepcion-dateo/:id/convenio/simular — mismo cálculo dentro
   * de una transacción que se deshace (vista previa de montos; motivo opcional).
   * Body: {
   *   convenio_id: number | null — obligatorio (null = sin convenio directo);
   *   motivo: string — obligatorio al corregir;
   *   con_comision_asesor?, con_comision_convenio?: boolean — si no vienen,
   *       se usa la decisión guardada al aprobar; Caso 1 → 3 fuera de ventana
   *       exige con_comision_convenio (dentro de ventana, el convenio cobra).
   * }
   * Reglas:
   *  - Solo si la comisión RTM del dateo está PENDIENTE y fuera de toda
   *    liquidación; APROBADA/PAGADA → 409 COMISION_NO_EDITABLE sin cambios
   *    (se corrige con un ajuste aparte). Sin comisión todavía: se corrigen
   *    dateo y ticket; applyCommissionHook() la calcula al confirmar la factura.
   *  - El asesor convenio (Caso 2) siempre queda con su convenio → 409.
   *  - Recalcula con el motor compartido con aprobar()
   *    (comision_ticket_excepcion_service) en la misma fila de comisión: no
   *    cambia id, estado, fecha_calculo ni calculado_por. Respeta Cobra/No
   *    cobra; la regla "convenio en $0 por descuento final" es la del motor
   *    y solo se informa (convenio_en_cero_por_descuento).
   *  - Deja CONVENIO_CORREGIDO con momento POST_APROBACION, montos antes y
   *    después y motivo. convenio_id_original no cambia.
   */
  public async corregirConvenio(ctx: HttpContext, opciones: { simular?: boolean } = {}) {
    const { params, request, response, auth } = ctx
    const simular = opciones.simular === true

    if (!Object.prototype.hasOwnProperty.call(request.all(), 'convenio_id')) {
      return response.badRequest({ message: 'convenio_id es requerido (null = sin convenio)' })
    }
    const convenioNuevoId = readOptionalNumber(request.input('convenio_id'))
    const motivo = String(request.input('motivo') ?? '').trim()
    if (!simular && !motivo) return response.badRequest({ message: 'motivo es requerido' })
    const flagBody = (clave: string): boolean | undefined | 'invalido' => {
      const v = request.input(clave)
      if (v === undefined || v === null) return undefined
      return typeof v === 'boolean' ? v : 'invalido'
    }
    const asesorBody = flagBody('con_comision_asesor')
    const convenioBody = flagBody('con_comision_convenio')
    if (asesorBody === 'invalido' || convenioBody === 'invalido') {
      return response.badRequest({
        code: 'COMBINACION_COMISION_INVALIDA',
        message: 'con_comision_asesor y con_comision_convenio deben ser true/false',
      })
    }

    const trx = await Database.transaction()
    const cortar = async (status: number, body: Record<string, unknown>) => {
      await trx.rollback()
      return response.status(status).send(body)
    }
    try {
      const ticket = await Ticket.query({ client: trx }).where('id', params.id).forUpdate().first()
      if (!ticket) return cortar(404, { message: 'Ticket no encontrado' })
      if (ticket.estado !== 'APROBADO') {
        return cortar(409, {
          code: 'TICKET_NO_APROBADO',
          message: 'Solo se corrige el convenio de un ticket APROBADO (pendiente: al aprobar).',
          estado: ticket.estado,
        })
      }
      const detalle = await TicketDetalleExcepcionDateo.query({ client: trx })
        .where('ticket_id', ticket.id)
        .first()
      if (!detalle) return cortar(404, { message: 'Detalle del ticket no encontrado' })
      if (detalle.canal === 'ASESOR_CONVENIO') {
        return cortar(409, {
          code: 'CONVENIO_ASESOR_CONVENIO',
          message: 'El asesor convenio siempre queda con su propio convenio.',
        })
      }
      const convenioAnteriorId = detalle.convenioId ?? null
      if (convenioAnteriorId === convenioNuevoId) {
        return cortar(400, {
          code: 'CONVENIO_SIN_CAMBIO',
          message: 'El ticket ya tiene ese convenio.',
        })
      }
      if (convenioNuevoId !== null) {
        const conv = await Convenio.find(convenioNuevoId, { client: trx })
        if (!conv || !conv.activo) {
          return cortar(400, { message: 'convenio_id no existe o está inactivo' })
        }
      }

      const turno = await TurnoRtm.query({ client: trx }).where('id', detalle.turnoId).first()
      if (!turno) return cortar(404, { message: 'Turno del ticket no encontrado' })
      const dateo = turno.captacionDateoId
        ? await CaptacionDateo.query({ client: trx })
            .where('id', turno.captacionDateoId)
            .forUpdate()
            .first()
        : null
      if (!dateo) {
        return cortar(409, {
          code: 'TICKET_SIN_DATEO',
          message: 'El turno del ticket no tiene dateo vinculado: no hay qué corregir.',
        })
      }

      // Comisión: solo PENDIENTE y fuera de liquidaciones.
      const comisiones = await Comision.query({ client: trx })
        .where('captacion_dateo_id', dateo.id)
        .where('tipo_servicio', 'RTM')
        .whereNot('estado', 'ANULADA')
        .forUpdate()
      const noEditable = comisiones.find((c) => c.estado !== 'PENDIENTE')
      if (noEditable) {
        return cortar(409, {
          code: 'COMISION_NO_EDITABLE',
          message: `La comisión está ${noEditable.estado}: el convenio no se corrige aquí, requiere un ajuste aparte.`,
          comision_id: noEditable.id,
          estado: noEditable.estado,
        })
      }
      if (comisiones.length > 1) {
        return cortar(409, {
          code: 'COMISION_NO_EDITABLE',
          message: 'El dateo tiene más de una comisión RTM: revísalo antes de corregir.',
        })
      }
      const comision = comisiones[0] ?? null
      if (comision) {
        const enLiquidacion = await trx
          .from('liquidacion_detalle')
          .where('comision_id', comision.id)
          .first()
        if (enLiquidacion) {
          return cortar(409, {
            code: 'COMISION_NO_EDITABLE',
            message: 'La comisión ya está en una liquidación: requiere un ajuste aparte.',
            comision_id: comision.id,
            estado: comision.estado,
          })
        }
      }

      // Mismo intento del dateo con el convenio nuevo (regla de store();
      // gerencia puede usar un convenio no asignado, queda registrado).
      const res = await resolverIntentoDateo({
        agenteId: dateo.agenteId,
        canal: dateo.canal,
        convenioId: convenioNuevoId,
        descuentoId: dateo.descuentoId,
        servicioId: dateo.servicioId ?? turno.servicioId,
        esAvance: Boolean(dateo.esAvance),
        comprobanteAvanceUrl: dateo.comprobanteAvanceUrl,
        permitirConvenioNoAsignado: true,
      })
      if (!res.ok) {
        return cortar(res.status, { code: 'INTENTO_DATEO_INVALIDO', message: res.message })
      }

      const convenioAnterior = convenioAnteriorId
        ? await Convenio.find(convenioAnteriorId, { client: trx })
        : null
      const casoAnterior = decidirCasoComision({
        convenioId: dateo.convenioId,
        agenteId: dateo.agenteId,
        canal: dateo.canal,
        asesorConvenioIdDelConvenio: convenioAnterior?.asesorConvenioId ?? null,
      })
      const asesorConvenioIdReal = res.intento.convenio?.asesorConvenioId ?? null
      const casoNuevo = decidirCasoComision({
        convenioId: res.intento.convenioId,
        agenteId: dateo.agenteId,
        canal: res.intento.canal,
        asesorConvenioIdDelConvenio: asesorConvenioIdReal,
      })

      // Decisión: la del body o la guardada al aprobar, validada para el caso nuevo.
      const dentroVentana = Boolean(detalle.dentroVentana)
      const guardado = (v: unknown) => (v === null || v === undefined ? undefined : Boolean(v))
      const conAsesor = asesorBody ?? guardado(detalle.conComisionAsesor)
      let conConvenio =
        convenioBody ??
        (casoNuevo === 'SIN_CONVENIO' ? undefined : guardado(detalle.conComisionConvenio))
      if (
        conConvenio === undefined &&
        dentroVentana &&
        casoNuevo === 'CONVENIO_COMERCIAL' &&
        conAsesor !== undefined
      ) {
        // Dentro de ventana el convenio que aparece cobra, salvo que gerencia diga otra cosa.
        conConvenio = true
      }
      const resDecision = resolverDecisionComision({
        dentroVentana,
        caso: casoNuevo,
        conComisionAsesor: conAsesor,
        conComisionConvenio: conConvenio,
        conComision: undefined,
      })
      if (!resDecision.ok) {
        return cortar(400, {
          code: 'COMBINACION_COMISION_INVALIDA',
          message: resDecision.message,
          caso: casoNuevo,
        })
      }
      const decision = resDecision.decision

      const montosDe = (c: Comision | null) =>
        c
          ? {
              asesor_id: c.asesorId,
              convenio_id: c.convenioId,
              asesor_secundario_id: c.asesorSecundarioId,
              monto: Number(c.monto ?? 0),
              monto_asesor: Number(c.montoAsesor ?? 0),
              monto_convenio: Number(c.montoConvenio ?? 0),
              regla_aplicada: c.reglaAplicada,
            }
          : null
      const montosAntes = montosDe(comision)

      dateo.useTransaction(trx)
      dateo.convenioId = res.intento.convenioId
      dateo.canal = res.intento.canal as any
      dateo.asesorConvenioId = res.intento.asesorConvenioId
      await dateo.save()

      let convenioEnCeroPorDescuento: boolean | null = null
      if (comision) {
        const facturacionConfirmada = await FacturacionTicket.query({ client: trx })
          .where('turno_id', turno.id)
          .where('estado', 'CONFIRMADA')
          .first()
        if (!facturacionConfirmada) {
          return cortar(409, {
            code: 'COMISION_NO_EDITABLE',
            message:
              'La comisión no tiene una factura CONFIRMADA del turno: revísala antes de corregir.',
            comision_id: comision.id,
          })
        }
        const calculo = await calcularComisionTicketExcepcion({
          trx,
          turno,
          dateo,
          caso: casoNuevo,
          asesorConvenioIdReal,
          facturacionConfirmada,
        })
        comision.useTransaction(trx)
        const foto = aplicarComisionTicketExcepcion(comision, {
          calculo,
          dateo,
          asesorConvenioIdReal,
          facturacionConfirmada,
          decision,
        })
        await comision.save()
        detalle.montoAsesorCalculado = foto.montoAsesorCalculado
        detalle.montoConvenioCalculado = foto.montoConvenioCalculado
        convenioEnCeroPorDescuento = calculo.convenioEnCeroPorDescuento
        // La continuidad guardada al confirmar era la del convenio anterior.
        if (turno.estadoContinuidad !== null) {
          turno.useTransaction(trx)
          turno.estadoContinuidad = calculo.estadoContinuidad
          await turno.save()
        }
      }

      detalle.useTransaction(trx)
      detalle.canal = res.intento.canal
      detalle.convenioId = res.intento.convenioId
      detalle.sinConvenioExplicito = res.intento.convenioId === null
      detalle.conComisionAsesor = decision.asesor
      detalle.conComisionConvenio = decision.convenio
      // Transición: producción local (misma BD) todavía lee con_comision.
      detalle.conComision = decision.asesor
      await detalle.save()

      const montosDespues = montosDe(comision)
      const convenioNoAsignado = await convenioNoAsignadoAlComercial({
        canal: res.intento.canal,
        comercialId: detalle.comercialId,
        convenioId: res.intento.convenioId,
        client: trx,
      })
      const datos = {
        momento: 'POST_APROBACION',
        convenio_anterior_id: convenioAnteriorId,
        convenio_nuevo_id: res.intento.convenioId,
        caso_anterior: casoAnterior,
        caso_nuevo: casoNuevo,
        con_comision_asesor: decision.asesor,
        con_comision_convenio: decision.convenio,
        comision_id: comision?.id ?? null,
        montos_antes: montosAntes,
        montos_despues: montosDespues,
        convenio_no_asignado: convenioNoAsignado,
        convenio_en_cero_por_descuento: convenioEnCeroPorDescuento,
        motivo: motivo || null,
      }
      await registrarEventoTicket(trx, {
        ticketId: ticket.id,
        tipo: 'CONVENIO_CORREGIDO',
        usuarioId: auth.user!.id,
        datos,
      })

      if (simular) {
        await trx.rollback()
        return response.ok({ ...datos, simulado: true })
      }
      await trx.commit()
      return response.ok({ ...datos, simulado: false })
    } catch (error) {
      if (!trx.isCompleted) await trx.rollback()
      throw error
    }
  }

  /**
   * PATCH /tickets-excepcion-dateo/:id/rechazar
   * Body: { motivo: string }
   * No toca turno ni dateo ni comisión.
   */
  public async rechazar({ params, request, response, auth }: HttpContext) {
    const motivo = (request.input('motivo') as string | undefined)?.trim()
    if (!motivo) return response.badRequest({ message: 'motivo es requerido' })

    // Mismo bloqueo que aprobar(): un rechazo y una aprobación simultáneos
    // no pueden resolver el mismo ticket dos veces.
    const trx = await Database.transaction()
    try {
      const ticket = await Ticket.query({ client: trx }).where('id', params.id).forUpdate().first()
      if (!ticket) {
        await trx.rollback()
        return response.notFound({ message: 'Ticket no encontrado' })
      }
      if (ticket.estado !== 'PENDIENTE') {
        await trx.rollback()
        return response.conflict({
          code: 'TICKET_YA_RESUELTO',
          message: 'Solo se pueden rechazar tickets PENDIENTES',
          estado: ticket.estado,
        })
      }

      const detalle = await TicketDetalleExcepcionDateo.query({ client: trx })
        .where('ticket_id', ticket.id)
        .first()
      if (!detalle) {
        await trx.rollback()
        return response.notFound({ message: 'Detalle del ticket no encontrado' })
      }

      detalle.useTransaction(trx)
      detalle.motivoRechazo = motivo
      detalle.rechazadoPorId = auth.user!.id
      detalle.rechazadoAt = DateTime.now()
      await detalle.save()

      ticket.useTransaction(trx)
      ticket.estado = 'RECHAZADO'
      ticket.resueltoAt = DateTime.now()
      await ticket.save()

      await registrarEventoTicket(trx, {
        ticketId: ticket.id,
        tipo: 'RECHAZADO',
        usuarioId: auth.user!.id,
        datos: { motivo },
      })

      await trx.commit()
      return response.ok({ ticket: ticket.serialize(), detalle: detalle.serialize() })
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
