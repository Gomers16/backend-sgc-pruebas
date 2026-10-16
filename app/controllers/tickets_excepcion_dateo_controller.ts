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
import { evaluarContinuidad } from '#services/continuidad_service'
import {
  resolveConfigComision,
  resolveConfigRecurrencia,
  calcularComision,
  inferTipoVehiculoComision,
  type CasoComision,
  type EscenarioCliente,
} from '#services/comision_calculo_service'
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
   * Límite global de minutos de ventana sin penalización (fallback cuando no
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
   * Body: { turno_id, convenio_id?, observacion, evidencia_chat_url,
   *         evidencia_grupo_whatsapp_url, evidencia_bloqueo_url,
   *         evidencia_calamidad_url? }
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

    const convenioId = readOptionalNumber(payload.convenio_id)
    if (convenioId !== null) {
      const convenio = await Convenio.find(convenioId)
      if (!convenio || !Boolean(convenio.activo)) {
        return response.badRequest({ message: 'convenio_id no existe o está inactivo' })
      }
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
          convenioId,
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

      await trx.commit()
      return response.created({ ticket: ticket.serialize(), detalle: detalle.serialize() })
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }

  /**
   * PATCH /tickets-excepcion-dateo/:id/aprobar
   * Body: { con_comision: boolean } — solo requerido/relevante fuera de
   * ventana (dentroVentana=false); dentro de ventana se ignora, la comisión
   * siempre es completa.
   *
   * Plantilla estructural: comisiones_controller.ts::store() (transacción,
   * crear/vincular dateo, marcar EXITOSO condicionalmente, generar comisión).
   * El cálculo del monto de comisión (caso/escenario/continuidad + llamada a
   * calcularComision()) replica el criterio de
   * facturacion_tickets_controller.ts::applyCommissionHook() — duplicado
   * aquí a propósito. Ese archivo sí se tocó en esta fase, pero solo para
   * respetar con_comision=false en su camino de comisión DIFERIDA (ver
   * forzarSinComisionPorTicket ahí) — el cálculo en sí sigue duplicado.
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
      // TINYINT(1) como 0/1 (no boolean real) — Boolean() en vez de === true,
      // si no la comparación estricta siempre da false.
      const dentroVentana = Boolean(detalle.dentroVentana)

      // con_comision solo es relevante fuera de ventana — dentro de ventana la
      // comisión siempre es completa, sin que gerencia decida nada, así que se
      // ignora aunque venga en el body.
      let conComision: boolean | null = null
      if (!dentroVentana) {
        const raw = request.input('con_comision')
        if (typeof raw !== 'boolean') {
          await trx.rollback()
          return response.badRequest({
            message:
              'con_comision es requerido (true/false) cuando el ticket está fuera de ventana',
          })
        }
        conComision = raw
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

      let convenio: Convenio | null = null
      if (detalle.convenioId) {
        convenio = await Convenio.find(detalle.convenioId, { client: trx })
      }

      // 2. Crea el captacion_dateo (servicioId = turno.servicioId, obligatorio
      // para que dateoAplicaAServicio() lo valide correctamente en cualquier
      // lectura futura — mismo criterio que comisiones_controller.ts::store()).
      const canal = String(comercial.tipo ?? '')
        .toUpperCase()
        .includes('CONVENIO')
        ? 'ASESOR_CONVENIO'
        : 'ASESOR_COMERCIAL'

      const dateo = await CaptacionDateo.create(
        {
          canal: canal as any,
          agenteId: comercial.id,
          convenioId: detalle.convenioId,
          placa: turno.placa,
          servicioId: turno.servicioId,
          origen: 'UI',
          resultado: 'EN_PROCESO',
          consumidoTurnoId: turno.id,
          consumidoAt: DateTime.now(),
          observacion: detalle.observacion,
        } as any,
        { client: trx }
      )

      // 3. Vinculación retroactiva.
      turno.captacionDateoId = dateo.id
      await turno.save()

      // 4. ¿Ya existe un facturacion_ticket CONFIRMADA para este turno?
      const facturacionConfirmada = await FacturacionTicket.query({ client: trx })
        .where('turno_id', turno.id)
        .where('estado', 'CONFIRMADA')
        .first()

      // Caso (1/2/3) — mismo criterio que applyCommissionHook().
      const asesorConvenioIdReal = convenio?.asesorConvenioId ?? null
      const caso: CasoComision = !detalle.convenioId
        ? 'SIN_CONVENIO'
        : !dateo.agenteId ||
            dateo.agenteId === asesorConvenioIdReal ||
            dateo.canal === 'ASESOR_CONVENIO'
          ? 'CONVENIO_SELF'
          : 'CONVENIO_COMERCIAL'

      // Escenario — turno.esRecurrente/esRecuperacion ya vienen calculados
      // desde la creación del turno (historial del cliente), independiente
      // del dateo — mismo campo que lee applyCommissionHook().
      const esClienteRecurrente = Boolean(turno.esRecurrente)
      const esClienteRecuperacion = Boolean(turno.esRecuperacion)
      const escenario: EscenarioCliente = esClienteRecurrente
        ? 'RECURRENTE'
        : esClienteRecuperacion
          ? 'RECUPERACION'
          : 'NUEVO'

      const tipoVehiculoComision = inferTipoVehiculoComision({ turnoTipo: turno.tipoVehiculo })

      const estadoContinuidad = await evaluarContinuidad({
        placa: turno.placa,
        asesorConvenioId: asesorConvenioIdReal,
        convenioId: detalle.convenioId,
        excluirTurnoId: turno.id,
      })
      const tuvoContinuidad = estadoContinuidad !== 'ROTA'

      const cfgValues = await resolveConfigComision({
        asesorId: dateo.agenteId,
        asesorConvenioId: asesorConvenioIdReal,
        tipoVehiculo: tipoVehiculoComision,
      })
      const recValues = await resolveConfigRecurrencia(dateo.agenteId, tipoVehiculoComision)

      // Sin avance ni descuento informativo — conceptos que no existen en el
      // flujo de "Excepción de Dateo".
      const resultadoComision = calcularComision({
        caso,
        escenario,
        tuvoContinuidad,
        esAvance: false,
        montoAvance: 0,
        codigoDescuento: null,
        origenDescuento: null,
        cfgValues,
        recValues,
      })

      let comisionCreada: Comision | null = null
      if (facturacionConfirmada) {
        dateo.resultado = 'EXITOSO'
        await dateo.useTransaction(trx).save()

        let comisionAsesorId: number | null
        let comisionConvenioId: number | null
        let comisionAsesorSecundarioId: number | null
        if (caso === 'SIN_CONVENIO') {
          comisionAsesorId = dateo.agenteId
          comisionConvenioId = null
          comisionAsesorSecundarioId = null
        } else if (caso === 'CONVENIO_SELF') {
          comisionAsesorId = asesorConvenioIdReal
          comisionConvenioId = dateo.convenioId
          comisionAsesorSecundarioId = null
        } else {
          comisionAsesorId = dateo.agenteId
          comisionConvenioId = dateo.convenioId
          comisionAsesorSecundarioId = asesorConvenioIdReal
        }

        const c = new Comision()
        c.useTransaction(trx)
        c.esConfig = false
        c.captacionDateoId = dateo.id
        c.asesorId = comisionAsesorId
        c.convenioId = comisionConvenioId
        c.asesorSecundarioId = comisionAsesorSecundarioId
        c.tipoServicio = 'RTM'
        c.estado = 'PENDIENTE'
        c.fechaCalculo = DateTime.now()
        c.calculadoPor = auth.user!.id
        c.porcentaje = '0'
        c.base = String(resultadoComision.base)
        c.monto = String(resultadoComision.monto)
        c.montoAsesor = String(resultadoComision.montoAsesor)
        c.montoConvenio = String(resultadoComision.montoConvenio)
        c.valorNuevoDirecto = String(resultadoComision.valorNuevoDirectoFinal)
        c.reglaAplicada = resultadoComision.reglaAplicada
        c.esAvance = false
        // Fuera de ventana + "Aprobar sin comisión": se calcula la comisión
        // normal con el motor de siempre y se fuerza a 0 recién acá, justo
        // antes de guardar — montoConvenio queda intacto (si hay convenio,
        // cobra su parte normal; si no hay, ya es $0 de por sí).
        if (!dentroVentana && conComision === false) c.montoAsesor = '0'
        await c.save()
        comisionCreada = c
      }
      // Si NO existe facturación confirmada: no se toca más el dateo/comisión
      // aquí. facturacion_tickets_controller.ts::applyCommissionHook() relee
      // turno.captacionDateoId en vivo cuando el ticket de facturación se
      // confirme más adelante (confirmado en investigación previa).

      // 5. Cierra el ticket.
      detalle.useTransaction(trx)
      detalle.conComision = dentroVentana ? null : conComision
      detalle.aprobadoPorId = auth.user!.id
      detalle.aprobadoAt = DateTime.now()
      await detalle.save()

      ticket.useTransaction(trx)
      ticket.estado = 'APROBADO'
      ticket.resueltoAt = DateTime.now()
      await ticket.save()

      await trx.commit()

      return response.ok({
        ticket: ticket.serialize(),
        detalle: detalle.serialize(),
        dateoId: dateo.id,
        comisionId: comisionCreada?.id ?? null,
        dentroVentana,
        conComision: dentroVentana ? null : conComision,
      })
    } catch (error) {
      await trx.rollback()
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

      await trx.commit()
      return response.ok({ ticket: ticket.serialize(), detalle: detalle.serialize() })
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
