// app/services/comision_ticket_service.ts
//
// Cálculo de la comisión RTM de un ticket de Facturación, separado de
// FacturacionTicketsController.applyCommissionHook() para usarlo también al
// editar el descuento de un ticket ya CONFIRMADA. Nada de este archivo
// guarda: el hook (y la edición) deciden qué se escribe y cuándo.
//  - resolverDescuentoComision(): descuento activo y avance (solo lee).
//  - construirComisionRTM(): la Comision de cada caso sin guardar, con el
//    resultado de calcularComision() ya asignado.
//  - planearRecalculoComision(): qué le pasaría a la comisión existente si
//    el ticket queda con el descuento editado (también solo lee).

import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

import Comision from '#models/comision'
import Descuento from '#models/descuento'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import type FacturacionTicket from '#models/facturacion_ticket'
import type { AccionComisionEdicion } from '#models/facturacion_descuento_edicion'
import { debeRespetarSinComision } from '#services/reserva_dateo_service'
import {
  calcularComision,
  decidirCasoComision,
  inferTipoVehiculoComision,
  isRTM,
  resolveConfigComision,
  resolveConfigRecurrencia,
  type CasoComision,
  type ConfigComisionResuelta,
  type ConfigRecurrenciaResuelta,
  type EscenarioCliente,
  type OrigenDescuento,
  type TipoVehiculoComision,
} from '#services/comision_calculo_service'

export interface DescuentoComisionResuelto {
  descuentoIdActivo: number | null
  /** true si el descuento lo aplicó caja y el dateo no traía uno pre-marcado. */
  descuentoOrigenCaja: boolean
  /** Código del descuento activo (o null) — el que usa calcularComision(). */
  codigoDescuentoActivo: string | null
  esAvance: boolean
  montoAvance: number
}

/** Descuento informativo activo y monto del avance del ticket. Solo lee. */
export async function resolverDescuentoComision(
  ticket: FacturacionTicket,
  dateo: CaptacionDateo,
  tipoVehiculoComision: TipoVehiculoComision | null
): Promise<DescuentoComisionResuelto> {
  // 🆕 ── Detectar si hay descuento informativo ──
  // Prioridad: ticket (aplicado en caja) > dateo (pre-marcado por el comercial)
  const descuentoIdActivo = ticket.descuentoId ?? (dateo as any).descuentoId ?? null
  // Distinguir origen: caja (ticket.descuentoId) vs dateo pre-marcado
  const descuentoOrigenCaja = !!ticket.descuentoId && !(dateo as any).descuentoId
  let tieneInformativo = false
  let esInformativoPolicia = false
  let esInformativoEmpleado = false // 🆕
  let esAvancePropietario = false // 🆕 CAMBIO 1
  let esObsequio = false // 🆕 CAMBIO NUEVO
  // Código del descuento activo (o null) — usado por comision_calculo_service.calcularComision()
  let codigoDescuentoActivo: string | null = null
  if (descuentoIdActivo) {
    const descuentoInfo = await Descuento.query()
      .where('id', descuentoIdActivo)
      .where('activo', true)
      .first()
    tieneInformativo = descuentoInfo !== null
    codigoDescuentoActivo = descuentoInfo?.codigo ?? null
    esInformativoPolicia = descuentoInfo?.codigo === 'INFORMATIVO_POLICIA'
    esInformativoEmpleado = descuentoInfo?.codigo === 'INFORMATIVO_EMPLEADO' // 🆕
    esAvancePropietario = descuentoInfo?.codigo === 'AVANCE_PROPIETARIO' // 🆕 CAMBIO 2
    esObsequio = descuentoInfo?.codigo === 'INFORMATIVO_OBSEQUIO' // 🆕 CAMBIO NUEVO
    console.log(
      `🏷️ Descuento informativo: ${tieneInformativo ? `${descuentoInfo!.nombre} (ID ${descuentoIdActivo})` : 'NO'} | esPolicia: ${esInformativoPolicia} | esEmpleado: ${esInformativoEmpleado} | esAvancePropietario: ${esAvancePropietario} | esObsequio: ${esObsequio} | origenCaja: ${descuentoOrigenCaja}`
    )
  } else {
    console.log('🏷️ Descuento informativo: NO')
  }

  // ══════════════════════════════════════════════════════════
  // 🆕 AVANCE — detectar y resolver monto según tipo vehículo
  // ══════════════════════════════════════════════════════════
  const esAvance = Boolean((dateo as any).esAvance ?? (dateo as any).es_avance ?? false)

  // Monto real del AVANCE:
  // 1. Si la cajera ingresó un monto explícito (descuentoMontoAplicado > 0) → usar ese
  // 2. Si no → auto-resolver desde tabla descuentos según tipo de vehículo
  //    MOTO    → descuento.valorMoto
  //    VEHICULO → descuento.valorCarro
  let montoAvance = 0
  if (esAvance && descuentoIdActivo) {
    const montoExplicito = Number(ticket.descuentoMontoAplicado ?? 0)
    if (montoExplicito > 0) {
      montoAvance = montoExplicito
      console.log(`🆕 AVANCE monto explícito (cajera): $${montoAvance}`)
    } else {
      // Auto-resolver desde la tabla descuentos por tipo de vehículo
      const descuentoRow = await Descuento.query()
        .where('id', descuentoIdActivo)
        .where('activo', true)
        .first()
      if (descuentoRow) {
        const esMoto = tipoVehiculoComision === 'MOTO'
        montoAvance = esMoto
          ? Number((descuentoRow as any).valorMoto ?? (descuentoRow as any).valor_moto ?? 0)
          : Number((descuentoRow as any).valorCarro ?? (descuentoRow as any).valor_carro ?? 0)
        console.log(
          `🆕 AVANCE auto-resuelto desde descuento "${descuentoRow.nombre}" | tipo: ${tipoVehiculoComision ?? 'desconocido'} | monto: $${montoAvance}`
        )
      }
    }
  }

  return { descuentoIdActivo, descuentoOrigenCaja, codigoDescuentoActivo, esAvance, montoAvance }
}

export interface EntradaComisionRTM {
  caso: CasoComision
  dateo: CaptacionDateo
  ticket: FacturacionTicket
  escenario: EscenarioCliente
  tuvoContinuidad: boolean
  descuento: DescuentoComisionResuelto
  origenDescuento: OrigenDescuento
  cfgValues: ConfigComisionResuelta
  recValues: ConfigRecurrenciaResuelta
  asesorConvenioIdReal: number | null
  tipoVehiculoComision: TipoVehiculoComision | null
  now: DateTime
  usuarioId: number | null
}

/**
 * Comision PENDIENTE del caso, sin guardar, con los montos de
 * calcularComision(). null si el caso pide un asesor y el dateo no tiene
 * (Caso 1 y Caso 3). No aplica la decisión "sin comisión" de un ticket de
 * Excepción de Dateo: eso lo hace quien guarda, después de la foto.
 */
export function construirComisionRTM(p: EntradaComisionRTM): Comision | null {
  const { caso, dateo, ticket, escenario, tuvoContinuidad, origenDescuento } = p
  const { cfgValues, recValues, asesorConvenioIdReal, tipoVehiculoComision, now, usuarioId } = p
  const { esAvance, montoAvance, codigoDescuentoActivo } = p.descuento

  // ════════════════════════════════════════════════════
  //  CASO 1: SIN CONVENIO — Comercial datea directo
  // ════════════════════════════════════════════════════
  if (caso === 'SIN_CONVENIO') {
    if (!dateo.agenteId) {
      console.warn('⚠️ Sin convenio y sin asesor')
      return null
    }

    const c = new Comision()
    c.captacionDateoId = dateo.id
    c.asesorId = dateo.agenteId
    c.convenioId = null
    c.tipoServicio = 'RTM'
    c.estado = 'PENDIENTE'
    c.fechaCalculo = now
    c.calculadoPor = usuarioId
    c.porcentaje = '0'
    c.asesorSecundarioId = null
    c.montoConvenio = '0'
    c.esAvance = false // Sin convenio: avance no aplica
    c.descuentoCodigoAplicado = codigoDescuentoActivo
    c.descuentoObservacionCaja = ticket.descuentoObservacion ?? null
    if (tipoVehiculoComision) (c as any).tipoVehiculo = tipoVehiculoComision

    const resultadoCaso1 = calcularComision({
      caso: 'SIN_CONVENIO',
      escenario,
      tuvoContinuidad,
      esAvance: false,
      montoAvance: 0,
      codigoDescuento: codigoDescuentoActivo,
      origenDescuento,
      cfgValues,
      recValues,
    })
    c.base = String(resultadoCaso1.base)
    c.monto = String(resultadoCaso1.monto)
    c.montoAsesor = String(resultadoCaso1.montoAsesor)
    c.valorNuevoDirecto = String(resultadoCaso1.valorNuevoDirectoFinal)
    c.reglaAplicada = resultadoCaso1.reglaAplicada
    console.log(`✅ ${resultadoCaso1.reglaAplicada} → $${resultadoCaso1.monto}`)
    return c
  }

  if (caso === 'CONVENIO_SELF') {
    // ═══════════════════════════════════════════════════════════
    // CASO 2: Asesor convenio se datea a sí mismo
    // El dinero va SIEMPRE a montoAsesor (él es asesor Y convenio)
    // montoConvenio SIEMPRE es $0
    // ═══════════════════════════════════════════════════════════
    const c = new Comision()
    c.captacionDateoId = dateo.id
    c.asesorId = asesorConvenioIdReal
    c.convenioId = dateo.convenioId
    c.tipoServicio = 'RTM'
    c.estado = 'PENDIENTE'
    c.fechaCalculo = now
    c.calculadoPor = usuarioId
    c.porcentaje = '0'
    c.asesorSecundarioId = null
    c.valorNuevoDirecto = '0'
    c.montoConvenio = '0' // Siempre $0 en CASO 2
    c.esAvance = esAvance
    c.descuentoCodigoAplicado = codigoDescuentoActivo
    c.descuentoObservacionCaja = ticket.descuentoObservacion ?? null
    if (tipoVehiculoComision) (c as any).tipoVehiculo = tipoVehiculoComision

    const resultadoCaso2 = calcularComision({
      caso: 'CONVENIO_SELF',
      escenario,
      tuvoContinuidad,
      esAvance,
      montoAvance,
      codigoDescuento: codigoDescuentoActivo,
      origenDescuento,
      cfgValues,
      recValues,
    })
    c.base = String(resultadoCaso2.base)
    c.monto = String(resultadoCaso2.monto)
    c.montoAsesor = String(resultadoCaso2.montoAsesor)
    if (resultadoCaso2.descuentoMontoAplicado !== null) {
      c.descuentoMontoAplicado = resultadoCaso2.descuentoMontoAplicado
    }
    c.reglaAplicada = resultadoCaso2.reglaAplicada
    console.log(`✅ ${resultadoCaso2.reglaAplicada} → asesor cobra $${resultadoCaso2.montoAsesor}`)
    return c
  }

  // ════════════════════════════════════════════════════
  //  CASO 3: CON CONVENIO — Comercial datea
  // ════════════════════════════════════════════════════
  if (!dateo.agenteId) {
    console.warn('⚠️ Con convenio pero sin asesor comercial')
    return null
  }

  const c = new Comision()
  c.captacionDateoId = dateo.id
  c.asesorId = dateo.agenteId
  c.convenioId = dateo.convenioId
  c.tipoServicio = 'RTM'
  c.estado = 'PENDIENTE'
  c.fechaCalculo = now
  c.calculadoPor = usuarioId
  c.porcentaje = '0'
  c.asesorSecundarioId = asesorConvenioIdReal
  c.valorNuevoDirecto = '0'
  c.esAvance = esAvance
  c.descuentoCodigoAplicado = codigoDescuentoActivo
  c.descuentoObservacionCaja = ticket.descuentoObservacion ?? null
  if (tipoVehiculoComision) (c as any).tipoVehiculo = tipoVehiculoComision

  const resultadoCaso3 = calcularComision({
    caso: 'CONVENIO_COMERCIAL',
    escenario,
    tuvoContinuidad,
    esAvance,
    montoAvance,
    codigoDescuento: codigoDescuentoActivo,
    origenDescuento,
    cfgValues,
    recValues,
  })
  c.base = String(resultadoCaso3.base)
  c.monto = String(resultadoCaso3.monto)
  c.montoAsesor = String(resultadoCaso3.montoAsesor)
  c.montoConvenio = String(resultadoCaso3.montoConvenio)
  if (resultadoCaso3.descuentoMontoAplicado !== null) {
    c.descuentoMontoAplicado = resultadoCaso3.descuentoMontoAplicado
  }
  c.reglaAplicada = resultadoCaso3.reglaAplicada
  console.log(
    `✅ ${resultadoCaso3.reglaAplicada} → comercial $${resultadoCaso3.montoAsesor} | convenio $${resultadoCaso3.montoConvenio}`
  )
  return c
}

/* ===================== Edición del descuento de un ticket CONFIRMADA ===================== */

export interface MontosComision {
  monto: number
  montoAsesor: number
  montoConvenio: number
}

/** Campos de la comisión que cambian con el descuento (el resto queda igual). */
const CAMPOS_RECALCULADOS = [
  'base',
  'monto',
  'montoAsesor',
  'montoConvenio',
  'valorNuevoDirecto',
  'descuentoMontoAplicado',
  'esAvance',
  'descuentoCodigoAplicado',
  'descuentoObservacionCaja',
  'reglaAplicada',
] as const
type CampoComisionRecalculado = (typeof CAMPOS_RECALCULADOS)[number]

export interface PlanComisionEdicion {
  accion: AccionComisionEdicion
  /** Aviso para la pantalla (null cuando se recalcula sin novedad). */
  mensaje: string | null
  comisionId: number | null
  estado: string | null
  antes: MontosComision | null
  despues: MontosComision | null
  /** Valores a escribir en la comisión existente (solo con RECALCULADA). */
  cambios: Partial<Record<CampoComisionRecalculado, unknown>> | null
  /** Foto del valor calculado antes del $0 de un ticket "sin comisión" (o null). */
  fotoTicket: { turnoId: number; montoAsesor: string; montoConvenio: string } | null
}

const montosDe = (c: Pick<Comision, 'monto' | 'montoAsesor' | 'montoConvenio'>) => ({
  monto: Number(c.monto ?? 0),
  montoAsesor: Number(c.montoAsesor ?? 0),
  montoConvenio: Number(c.montoConvenio ?? 0),
})

function sinRecalcular(
  accion: AccionComisionEdicion,
  mensaje: string | null,
  comision: Comision | null = null
): PlanComisionEdicion {
  const antes = comision ? montosDe(comision) : null
  return {
    accion,
    mensaje,
    comisionId: comision?.id ?? null,
    estado: comision?.estado ?? null,
    antes,
    despues: antes,
    cambios: null,
    fotoTicket: null,
  }
}

/** Comisión RTM del dateo del turno del ticket (la más reciente), o null. */
export async function comisionDelTicket(
  ticket: FacturacionTicket,
  trx?: TransactionClientContract
): Promise<{ comision: Comision | null; turno: TurnoRtm | null; dateoId: number | null }> {
  const turno = ticket.turnoId ? await TurnoRtm.find(ticket.turnoId, { client: trx }) : null
  const dateoId = ticket.dateoId ?? turno?.captacionDateoId ?? null
  if (!dateoId) return { comision: null, turno, dateoId }
  const q = Comision.query({ client: trx })
    .where('captacion_dateo_id', dateoId)
    .where('tipo_servicio', 'RTM')
    .where('es_config', false)
    .orderBy('id', 'desc')
  if (trx) q.forUpdate()
  return { comision: await q.first(), turno, dateoId }
}

/**
 * Qué le pasa a la comisión del dateo del turno si el ticket queda con el
 * descuento que trae en memoria (ya editado, sin guardar). No escribe nada.
 *  - Sin comisión (o ticket no RTM) → SIN_COMISION.
 *  - APROBADA, PAGADA, ANULADA o dentro de una liquidación → NO_MODIFICADA.
 *  - PENDIENTE → mismo motor que applyCommissionHook() (calcularComision y
 *    la decisión "sin comisión" de un ticket de Excepción de Dateo). Con
 *    convenio la continuidad es la guardada en el turno al confirmar; si no
 *    hay, no se recalcula (SIN_CONTINUIDAD). Sin convenio, evaluarContinuidad()
 *    devuelve SIN_EVIDENCIA sin leer historial: el mismo valor se usa aquí.
 */
export async function planearRecalculoComision(
  ticket: FacturacionTicket,
  trx?: TransactionClientContract
): Promise<PlanComisionEdicion> {
  if (!isRTM(ticket.servicioCodigo, ticket.servicioNombre)) {
    return sinRecalcular('SIN_COMISION', null)
  }
  const { comision, turno, dateoId } = await comisionDelTicket(ticket, trx)
  if (!comision || !dateoId) return sinRecalcular('SIN_COMISION', null)

  const enLiquidacion = await (trx ?? Database)
    .from('liquidacion_detalle')
    .where('comision_id', comision.id)
    .first()
  if (comision.estado !== 'PENDIENTE' || enLiquidacion) {
    const situacion = comision.estado !== 'PENDIENTE' ? comision.estado : 'en una liquidación'
    return sinRecalcular(
      'NO_MODIFICADA',
      `La comisión #${comision.id} ya está ${situacion}: no se modificó, ajústala en Comisiones.`,
      comision
    )
  }

  const dateo = await CaptacionDateo.query({ client: trx })
    .where('id', dateoId)
    .preload('agente')
    .preload('asesorConvenio')
    .preload('convenio', (qConvenio) => {
      qConvenio.preload('asesorConvenio')
    })
    .first()
  if (!dateo) return sinRecalcular('SIN_COMISION', null)

  let asesorConvenioIdReal: number | null = null
  if (dateo.convenioId && (dateo.convenio as any)?.$preloaded?.asesorConvenio) {
    asesorConvenioIdReal = (dateo.convenio as any).$preloaded.asesorConvenio.id
  }

  let tuvoContinuidad = true
  if (asesorConvenioIdReal || dateo.convenioId) {
    const guardada = turno?.estadoContinuidad ?? null
    if (!guardada) {
      return sinRecalcular(
        'SIN_CONTINUIDAD',
        `No se pudo recalcular: falta la continuidad guardada. La comisión #${comision.id} no se modificó.`,
        comision
      )
    }
    tuvoContinuidad = guardada !== 'ROTA'
  }

  const turnoTipoVehiculo = (turno as any)?.tipoVehiculo ?? (turno as any)?.tipo_vehiculo ?? null
  const tipoVehiculoComision = inferTipoVehiculoComision({
    ticketTipo: ticket.tipoVehiculoSnapshot ?? null,
    turnoTipo: turnoTipoVehiculo,
  })
  const esClienteRecurrente = Boolean(turno?.esRecurrente ?? false)
  const esClienteRecuperacion = Boolean(turno?.esRecuperacion ?? false)
  const escenario: EscenarioCliente =
    !esClienteRecurrente && !esClienteRecuperacion
      ? 'NUEVO'
      : esClienteRecurrente
        ? 'RECURRENTE'
        : 'RECUPERACION'

  const cfgValues = await resolveConfigComision({
    asesorId: dateo.agenteId,
    asesorConvenioId: asesorConvenioIdReal,
    tipoVehiculo: tipoVehiculoComision,
  })
  const recValues = await resolveConfigRecurrencia(dateo.agenteId, tipoVehiculoComision)
  const descuento = await resolverDescuentoComision(ticket, dateo, tipoVehiculoComision)
  const caso = decidirCasoComision({
    convenioId: dateo.convenioId,
    agenteId: dateo.agenteId,
    canal: dateo.canal,
    asesorConvenioIdDelConvenio: asesorConvenioIdReal,
  })

  const c = construirComisionRTM({
    caso,
    dateo,
    ticket,
    escenario,
    tuvoContinuidad,
    descuento,
    origenDescuento: descuento.descuentoOrigenCaja ? 'CAJA' : 'DATEO',
    cfgValues,
    recValues,
    asesorConvenioIdReal,
    tipoVehiculoComision,
    now: DateTime.now(),
    usuarioId: null,
  })
  // El dateo ya no corresponde a la comisión guardada (otro asesor/convenio):
  // no se adivina, se deja como está.
  if (
    !c ||
    (c.asesorId ?? null) !== (comision.asesorId ?? null) ||
    (c.convenioId ?? null) !== (comision.convenioId ?? null)
  ) {
    return sinRecalcular(
      'NO_MODIFICADA',
      `No se pudo recalcular: la comisión #${comision.id} no coincide con el dateo actual. No se modificó, ajústala en Comisiones.`,
      comision
    )
  }

  const sinComisionTicket = await debeRespetarSinComision(turno?.id ?? null)
  const fotoTicket =
    turno && (sinComisionTicket.asesor || sinComisionTicket.convenio)
      ? {
          turnoId: turno.id,
          montoAsesor: c.montoAsesor ?? '0',
          montoConvenio: c.montoConvenio ?? '0',
        }
      : null
  if (sinComisionTicket.asesor) c.montoAsesor = '0'
  if (sinComisionTicket.convenio) c.montoConvenio = '0'

  const cambios: Partial<Record<CampoComisionRecalculado, unknown>> = {}
  for (const campo of CAMPOS_RECALCULADOS) cambios[campo] = (c as any)[campo] ?? null

  return {
    accion: 'RECALCULADA',
    mensaje: fotoTicket
      ? 'El turno viene de un ticket de Excepción de Dateo aprobado sin comisión: esa decisión se respeta.'
      : null,
    comisionId: comision.id,
    estado: comision.estado,
    antes: montosDe(comision),
    despues: montosDe(c),
    cambios,
    fotoTicket,
  }
}
