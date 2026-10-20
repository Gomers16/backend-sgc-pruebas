// app/services/comision_ticket_service.ts
//
// Cálculo de la comisión RTM de un ticket de Facturación, separado de
// FacturacionTicketsController.applyCommissionHook() para usarlo también al
// editar el descuento de un ticket ya CONFIRMADA. Nada de este archivo
// guarda: el hook (y la edición) deciden qué se escribe y cuándo.
//  - resolverDescuentoComision(): descuento activo y avance (solo lee).
//  - construirComisionRTM(): la Comision de cada caso sin guardar, con el
//    resultado de calcularComision() ya asignado.

import { DateTime } from 'luxon'

import Comision from '#models/comision'
import Descuento from '#models/descuento'
import type CaptacionDateo from '#models/captacion_dateo'
import type FacturacionTicket from '#models/facturacion_ticket'
import {
  calcularComision,
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
