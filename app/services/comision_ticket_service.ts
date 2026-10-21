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
import FacturacionTicketModel from '#models/facturacion_ticket'
import type FacturacionTicket from '#models/facturacion_ticket'
import type { AccionComisionEdicion } from '#models/facturacion_descuento_edicion'
import { debeRespetarSinComision } from '#services/reserva_dateo_service'
import { evaluarContinuidad } from '#services/continuidad_service'
import {
  calcularComision,
  decidirCasoComision,
  inferTipoVehiculoComision,
  isRTM,
  resolveConfigComision,
  resolveConfigRecurrencia,
  type CampoConfigComision,
  type CasoComision,
  type ConfigComisionResuelta,
  type ConfigRecurrenciaResuelta,
  type EscenarioCliente,
  type OrigenDescuento,
  type ResultadoCalculoComision,
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
  return construirComisionRTMDetallada(p)?.comision ?? null
}

/** Igual que construirComisionRTM(), con el resultado de calcularComision() (regla, campos usados y explicación). */
export function construirComisionRTMDetallada(
  p: EntradaComisionRTM
): { comision: Comision; resultado: ResultadoCalculoComision } | null {
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
    console.log(`✅ ${resultadoCaso1.reglaAplicada} → ${resultadoCaso1.monto}`)
    return { comision: c, resultado: resultadoCaso1 }
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
    console.log(`✅ ${resultadoCaso2.reglaAplicada} → asesor cobra ${resultadoCaso2.montoAsesor}`)
    return { comision: c, resultado: resultadoCaso2 }
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
    `✅ ${resultadoCaso3.reglaAplicada} → comercial ${resultadoCaso3.montoAsesor} | convenio ${resultadoCaso3.montoConvenio}`
  )
  return { comision: c, resultado: resultadoCaso3 }
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

export interface DiferenciaComision {
  asesor: number
  convenio: number
  /** asesor + convenio */
  total: number
}

export interface PlanComisionEdicion {
  accion: AccionComisionEdicion
  /** Aviso para la pantalla (null cuando se recalcula sin novedad). */
  mensaje: string | null
  comisionId: number | null
  estado: string | null
  antes: MontosComision | null
  despues: MontosComision | null
  /** después − antes (0 si no se recalcula). */
  diferencia: DiferenciaComision
  /** Liquidaciones (el comprobante de pago de comisiones) que la incluyen. */
  liquidacionIds: number[]
  /** PAGADA o en una liquidación: el backend exige confirmar_comision_pagada=true. */
  requiereConfirmacionPago: boolean
  /** Dateo del turno (para alinear sus campos de descuento de caja). */
  dateoId: number | null
  /** Valores a escribir en la comisión existente (solo si se recalcula). */
  cambios: Partial<Record<CampoComisionRecalculado, unknown>> | null
  /** Foto del valor calculado antes del $0 de un ticket "sin comisión" (o null). */
  fotoTicket: { turnoId: number; montoAsesor: string; montoConvenio: string } | null
  /** Lo que muestra la pantalla (mismo cálculo); null sin dateo o sin factura RTM. */
  desglose: DesgloseComision | null
}

const montosDe = (c: Pick<Comision, 'monto' | 'montoAsesor' | 'montoConvenio'>) => ({
  monto: Number(c.monto ?? 0),
  montoAsesor: Number(c.montoAsesor ?? 0),
  montoConvenio: Number(c.montoConvenio ?? 0),
})

const SIN_DIFERENCIA: DiferenciaComision = { asesor: 0, convenio: 0, total: 0 }

function diferenciaDe(antes: MontosComision, despues: MontosComision): DiferenciaComision {
  const asesor = despues.montoAsesor - antes.montoAsesor
  const convenio = despues.montoConvenio - antes.montoConvenio
  return { asesor, convenio, total: asesor + convenio }
}

const pesos = (n: number) =>
  `${n < 0 ? '−' : ''}$${Math.abs(n).toLocaleString('es-CO', { maximumFractionDigits: 0 })}`

function sinRecalcular(
  accion: AccionComisionEdicion,
  mensaje: string | null,
  comision: Comision | null = null,
  extra: { liquidacionIds?: number[]; dateoId?: number | null } = {}
): PlanComisionEdicion {
  const antes = comision ? montosDe(comision) : null
  return {
    accion,
    mensaje,
    comisionId: comision?.id ?? null,
    estado: comision?.estado ?? null,
    antes,
    despues: antes,
    diferencia: SIN_DIFERENCIA,
    liquidacionIds: extra.liquidacionIds ?? [],
    requiereConfirmacionPago: false,
    dateoId: extra.dateoId ?? null,
    cambios: null,
    fotoTicket: null,
    desglose: null,
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

/* ===================== Desglose de la comisión (para la pantalla) ===================== */

export type RolBeneficiario = 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'CONVENIO'

export interface BeneficiarioComision {
  rol: RolBeneficiario
  /** id de agentes_captacions (asesores) o de convenios (CONVENIO). */
  id: number | null
  nombre: string | null
  /** Tipo de asesor (ASESOR_COMERCIAL / ASESOR_CONVENIO) o tipo del convenio. */
  tipo: string | null
  /** Para CONVENIO: quién recibe su parte (el asesor convenio). */
  cobraAsesorConvenio: { id: number; nombre: string } | null
  /** Monto guardado hoy (null = la comisión todavía no existe). */
  antes: number | null
  /** Monto con este descuento (el que se guarda; el estimado si no existe). */
  despues: number
}

export interface ValorConfigUsado {
  campo: CampoConfigComision
  /** Nombre del campo como en Configuración de comisiones. */
  etiqueta: string
  valor: number
  /** FILA_PROPIA del asesor, fila GLOBAL, o valor de RESPALDO del código (sin fila). */
  fuente: 'FILA_PROPIA' | 'GLOBAL' | 'RESPALDO'
  tabla: string | null
  filaId: number | null
  asesorId: number | null
  tipoVehiculo: string | null
  columna: string
  /** true si este valor paga algo en la regla aplicada. */
  usado: boolean
}

export type CodigoAlertaComision =
  | 'CONFIG_EN_CERO'
  | 'SIN_COMISION_TICKET'
  | 'AVANCE_HEREDADO'
  | 'SIN_CONTINUIDAD'
  | 'ESTIMADO'
  | 'NO_MODIFICADA'
  | 'DISTINTO_AL_MOTOR'

export interface AlertaComision {
  codigo: CodigoAlertaComision
  tipo: 'info' | 'warning' | 'error'
  mensaje: string
}

/**
 * Todo lo que la pantalla muestra de la comisión de un ticket: sale del mismo
 * cálculo que se guarda (calcularComision vía construirComisionRTMDetallada),
 * nunca de una copia de la regla en el frontend.
 */
export interface DesgloseComision {
  /** La comisión no existe todavía: los montos son lo que se pagaría. */
  estimado: boolean
  /** false cuando no se recalculó (ANULADA, sin continuidad, no coincide): montos = los guardados. */
  recalculado: boolean
  caso: CasoComision
  casoTexto: string
  escenario: EscenarioCliente
  escenarioTexto: string
  continuidad: { aplica: boolean; estado: string | null; texto: string }
  tipoVehiculo: TipoVehiculoComision | null
  descuento: {
    codigo: string | null
    origen: OrigenDescuento | null
    origenTexto: string
    /** Marca es_avance del dateo (la usa el motor, no el código). */
    esAvance: boolean
  }
  /** reglaAplicada del motor (o la guardada si no se recalculó). */
  regla: string | null
  explicacion: string
  /** regla_aplicada guardada hoy en la comisión (null si no existe o no la guardó). */
  reglaGuardada: string | null
  beneficiarios: BeneficiarioComision[]
  configuracion: ValorConfigUsado[]
  alertas: AlertaComision[]
}

export const TEXTO_CASO: Record<CasoComision, string> = {
  SIN_CONVENIO: 'Asesor comercial sin convenio',
  CONVENIO_COMERCIAL: 'Asesor comercial con convenio',
  CONVENIO_SELF: 'Asesor convenio que se datea a sí mismo',
}

const TEXTO_ESCENARIO: Record<EscenarioCliente, string> = {
  NUEVO: 'Cliente nuevo',
  RECURRENTE: 'Cliente recurrente',
  RECUPERACION: 'Cliente de recuperación',
}

const ETIQUETA_CAMPO: Record<CampoConfigComision, string> = {
  valorNuevoDirecto: 'Comisión cliente nuevo directo',
  valorRecurrente: 'Dateo recurrente',
  valorIncentivo: 'Incentivo base del asesor convenio',
  valorDateoNuevo: 'Comisión dateo vía convenio',
  valorIncentivoCaso3: 'Incentivo del convenio por tipo de vehículo',
}

/** Valores de configuración que puede usar cada caso (en orden de pantalla). */
const CAMPOS_POR_CASO: Record<CasoComision, CampoConfigComision[]> = {
  SIN_CONVENIO: ['valorNuevoDirecto', 'valorRecurrente'],
  CONVENIO_SELF: ['valorIncentivo', 'valorRecurrente'],
  CONVENIO_COMERCIAL: ['valorDateoNuevo', 'valorIncentivoCaso3'],
}

/** Caso de una comisión ya guardada, por cómo quedó escrita (sin recalcular). */
export function casoDeComisionGuardada(c: {
  convenioId: number | null
  asesorSecundarioId: number | null
}): CasoComision {
  if (!c.convenioId) return 'SIN_CONVENIO'
  return c.asesorSecundarioId ? 'CONVENIO_COMERCIAL' : 'CONVENIO_SELF'
}

function valoresConfig(
  caso: CasoComision,
  cfg: ConfigComisionResuelta,
  rec: ConfigRecurrenciaResuelta,
  usados: CampoConfigComision[]
): ValorConfigUsado[] {
  return CAMPOS_POR_CASO[caso].map((campo) => {
    if (campo === 'valorRecurrente') {
      const f = rec.fuenteRecurrente
      return {
        campo,
        etiqueta: ETIQUETA_CAMPO[campo],
        valor: rec.valorRecurrente,
        fuente: !f?.tabla
          ? 'RESPALDO'
          : f.tabla === 'configuracion_recurrencia_asesores'
            ? 'FILA_PROPIA'
            : 'GLOBAL',
        tabla: f?.tabla ?? null,
        filaId: f?.id ?? null,
        asesorId: null,
        tipoVehiculo: null,
        columna: f?.campo ?? 'valor_dateo_recurrencia',
        usado: usados.includes(campo),
      }
    }
    const f = cfg.fuentes?.[campo]
    return {
      campo,
      etiqueta: ETIQUETA_CAMPO[campo],
      valor: cfg[campo],
      fuente: !f?.id ? 'RESPALDO' : f.asesorId ? 'FILA_PROPIA' : 'GLOBAL',
      tabla: f?.id ? 'comisiones (es_config)' : null,
      filaId: f?.id ?? null,
      asesorId: f?.asesorId ?? null,
      tipoVehiculo: f?.tipoVehiculo ?? null,
      columna: f?.campo ?? campo,
      usado: usados.includes(campo),
    }
  })
}

/** Aviso por cada valor de configuración en 0 que hace que alguien cobre $0. */
function alertasConfigEnCero(valores: ValorConfigUsado[]): AlertaComision[] {
  return valores
    .filter((v) => v.usado && v.valor === 0)
    .map((v) => {
      const fila =
        v.fuente === 'RESPALDO'
          ? 'no hay fila de configuración (valor de respaldo del código)'
          : `${v.fuente === 'GLOBAL' ? 'la fila Global' : 'la fila propia'} #${v.filaId}` +
            `${v.tipoVehiculo ? ` (${v.tipoVehiculo})` : ''}, columna ${v.columna}`
      const extra =
        v.fuente === 'FILA_PROPIA' && v.campo === 'valorIncentivoCaso3'
          ? ' Un 0 no cae a la Global (solo un campo vacío cae).'
          : v.fuente === 'GLOBAL' && v.campo === 'valorIncentivo'
            ? ' El asesor convenio no tiene fila propia y la Global tiene la base en 0.'
            : ''
      return {
        codigo: 'CONFIG_EN_CERO' as const,
        tipo: 'warning' as const,
        mensaje: `${v.etiqueta} viene en $0 desde la configuración: ${fila}.${extra} Parece un error de configuración: revísalo en Configuración de comisiones.`,
      }
    })
}

/** Lo que el motor resolvió para el ticket (sin guardar nada). */
interface ContextoComisionTicket {
  dateo: CaptacionDateo
  turno: TurnoRtm | null
  caso: CasoComision
  escenario: EscenarioCliente
  tipoVehiculoComision: TipoVehiculoComision | null
  asesorConvenioIdReal: number | null
  descuento: DescuentoComisionResuelto
  cfgValues: ConfigComisionResuelta
  recValues: ConfigRecurrenciaResuelta
}

async function contextoComisionTicket(
  ticket: FacturacionTicket,
  turno: TurnoRtm | null,
  dateoId: number,
  trx?: TransactionClientContract
): Promise<ContextoComisionTicket | null> {
  const dateo = await CaptacionDateo.query({ client: trx })
    .where('id', dateoId)
    .preload('agente')
    .preload('asesorConvenio')
    .preload('convenio', (qConvenio) => {
      qConvenio.preload('asesorConvenio')
    })
    .first()
  if (!dateo) return null

  let asesorConvenioIdReal: number | null = null
  if (dateo.convenioId && (dateo.convenio as any)?.$preloaded?.asesorConvenio) {
    asesorConvenioIdReal = (dateo.convenio as any).$preloaded.asesorConvenio.id
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
  return {
    dateo,
    turno,
    caso,
    escenario,
    tipoVehiculoComision,
    asesorConvenioIdReal,
    descuento,
    cfgValues,
    recValues,
  }
}

function ejecutarMotor(
  ctx: ContextoComisionTicket,
  ticket: FacturacionTicket,
  tuvoContinuidad: boolean
) {
  return construirComisionRTMDetallada({
    caso: ctx.caso,
    dateo: ctx.dateo,
    ticket,
    escenario: ctx.escenario,
    tuvoContinuidad,
    descuento: ctx.descuento,
    origenDescuento: ctx.descuento.descuentoOrigenCaja ? 'CAJA' : 'DATEO',
    cfgValues: ctx.cfgValues,
    recValues: ctx.recValues,
    asesorConvenioIdReal: ctx.asesorConvenioIdReal,
    tipoVehiculoComision: ctx.tipoVehiculoComision,
    now: DateTime.now(),
    usuarioId: null,
  })
}

/**
 * Arma el desglose a partir del contexto y del resultado del motor. Pura:
 * no consulta la BD (la prueba de consistencia la llama directamente).
 *  - resultado null: no se recalculó; montos y regla = los guardados.
 */
export function armarDesglose(p: {
  caso: CasoComision
  escenario: EscenarioCliente
  tipoVehiculo: TipoVehiculoComision | null
  continuidadEstado: string | null
  codigoDescuento: string | null
  origenDescuento: OrigenDescuento | null
  esAvance: boolean
  cfgValues: ConfigComisionResuelta
  recValues: ConfigRecurrenciaResuelta
  resultado: ResultadoCalculoComision | null
  /** Montos que se guardarían (ya con el $0 de un ticket "sin comisión"). */
  despues: { montoAsesor: number; montoConvenio: number } | null
  /** Comisión guardada hoy (null = no existe: estimado). */
  guardada: { montoAsesor: number; montoConvenio: number; reglaAplicada: string | null } | null
  personas: {
    comercial: { id: number; nombre: string; tipo: string | null } | null
    asesorConvenio: { id: number; nombre: string; tipo: string | null } | null
    convenio: { id: number; nombre: string; tipo: string | null } | null
  }
  sinComisionTicket: { asesor: boolean; convenio: boolean }
}): DesgloseComision {
  const { caso, resultado, guardada } = p
  const despues =
    p.despues ??
    (guardada
      ? { montoAsesor: guardada.montoAsesor, montoConvenio: guardada.montoConvenio }
      : {
          montoAsesor: 0,
          montoConvenio: 0,
        })
  const conConvenio = caso !== 'SIN_CONVENIO'

  const beneficiarios: BeneficiarioComision[] = []
  const persona = (
    rol: RolBeneficiario,
    x: { id: number; nombre: string; tipo: string | null } | null
  ) => ({
    rol,
    id: x?.id ?? null,
    nombre: x?.nombre ?? null,
    tipo: x?.tipo ?? null,
    cobraAsesorConvenio: null,
  })
  if (caso === 'CONVENIO_SELF') {
    beneficiarios.push({
      ...persona('ASESOR_CONVENIO', p.personas.asesorConvenio),
      antes: guardada ? guardada.montoAsesor : null,
      despues: despues.montoAsesor,
    })
  } else {
    beneficiarios.push({
      ...persona('ASESOR_COMERCIAL', p.personas.comercial),
      antes: guardada ? guardada.montoAsesor : null,
      despues: despues.montoAsesor,
    })
    if (caso === 'CONVENIO_COMERCIAL') {
      const ac = p.personas.asesorConvenio
      beneficiarios.push({
        ...persona('CONVENIO', p.personas.convenio),
        cobraAsesorConvenio: ac ? { id: ac.id, nombre: ac.nombre } : null,
        antes: guardada ? guardada.montoConvenio : null,
        despues: despues.montoConvenio,
      })
    }
  }

  const configuracion = valoresConfig(caso, p.cfgValues, p.recValues, resultado?.camposUsados ?? [])
  const alertas: AlertaComision[] = []
  if (!guardada) {
    alertas.push({
      codigo: 'ESTIMADO',
      tipo: 'info',
      mensaje:
        'Todavía no existe la comisión: estos montos son un ESTIMADO de lo que se pagaría con este descuento.',
    })
  }
  if (resultado) alertas.push(...alertasConfigEnCero(configuracion))
  if (p.sinComisionTicket.asesor || p.sinComisionTicket.convenio) {
    const quien = [
      p.sinComisionTicket.asesor
        ? caso === 'CONVENIO_SELF'
          ? 'el asesor convenio'
          : 'el asesor comercial'
        : null,
      p.sinComisionTicket.convenio && caso === 'CONVENIO_COMERCIAL' ? 'el convenio' : null,
    ]
      .filter(Boolean)
      .join(' y ')
    const motor = resultado
      ? ` (el motor calcularía asesor ${pesos(resultado.montoAsesor)}${caso === 'CONVENIO_COMERCIAL' ? `, convenio ${pesos(resultado.montoConvenio)}` : ''})`
      : ''
    alertas.push({
      codigo: 'SIN_COMISION_TICKET',
      tipo: 'warning',
      mensaje: `El turno viene de un ticket de Excepción de Dateo aprobado sin comisión para ${quien || 'el asesor'}: esa decisión se respeta y queda en $0${motor}.`,
    })
  }
  const codigo = p.codigoDescuento
  if (conConvenio && p.esAvance && !(codigo ?? '').toUpperCase().includes('AVANCE')) {
    alertas.push({
      codigo: 'AVANCE_HEREDADO',
      tipo: 'warning',
      mensaje: `El dateo trae marca de avance y no cambia aunque el código ahora sea ${codigo ?? 'ninguno'}: la comisión se sigue calculando como avance.`,
    })
  }

  const continuidadAplica = conConvenio
  const continuidadTexto = !continuidadAplica
    ? 'No aplica (sin convenio)'
    : p.continuidadEstado === 'ROTA'
      ? 'Rota: el cliente pasó por otro canal o convenio'
      : p.continuidadEstado === 'CONTINUA'
        ? 'Continúa con el mismo asesor convenio'
        : p.continuidadEstado === 'SIN_EVIDENCIA'
          ? 'Sin evidencia (se respeta como continua)'
          : 'Vacía: no está guardada en el turno'

  return {
    estimado: !guardada,
    recalculado: !!resultado,
    caso,
    casoTexto: TEXTO_CASO[caso],
    escenario: p.escenario,
    escenarioTexto: TEXTO_ESCENARIO[p.escenario],
    continuidad: {
      aplica: continuidadAplica,
      estado: p.continuidadEstado,
      texto: continuidadTexto,
    },
    tipoVehiculo: p.tipoVehiculo,
    descuento: {
      codigo,
      origen: codigo ? p.origenDescuento : null,
      origenTexto: !codigo
        ? 'Sin descuento'
        : p.origenDescuento === 'CAJA'
          ? 'Puesto en caja (el dateo no traía descuento)'
          : 'Pre-marcado en el dateo',
      esAvance: p.esAvance,
    },
    regla: resultado?.reglaAplicada ?? guardada?.reglaAplicada ?? null,
    explicacion: resultado
      ? resultado.explicacion
      : 'No se recalculó: se muestran los montos guardados en la comisión.',
    reglaGuardada: guardada?.reglaAplicada ?? null,
    beneficiarios,
    configuracion,
    alertas,
  }
}

function personasDelDateo(ctx: ContextoComisionTicket) {
  const agente = (ctx.dateo as any).$preloaded?.agente ?? null
  const convenio = (ctx.dateo as any).$preloaded?.convenio ?? null
  const asesorConvenio = convenio?.$preloaded?.asesorConvenio ?? null
  const p = (x: any, tipo: string | null = x?.tipo ?? null) =>
    x ? { id: Number(x.id), nombre: String(x.nombre ?? ''), tipo } : null
  return {
    comercial: p(agente),
    asesorConvenio: p(asesorConvenio),
    convenio: p(convenio, convenio?.tipo ?? null),
  }
}

/** Desglose de un contexto ya resuelto (ver armarDesglose). */
function desgloseDe(
  ctx: ContextoComisionTicket,
  extra: {
    continuidadEstado: string | null
    resultado: ResultadoCalculoComision | null
    despues: { montoAsesor: number; montoConvenio: number } | null
    guardada: Comision | null
    sinComisionTicket: { asesor: boolean; convenio: boolean }
  }
): DesgloseComision {
  return armarDesglose({
    caso: ctx.caso,
    escenario: ctx.escenario,
    tipoVehiculo: ctx.tipoVehiculoComision,
    continuidadEstado: extra.continuidadEstado,
    codigoDescuento: ctx.descuento.codigoDescuentoActivo,
    origenDescuento: ctx.descuento.descuentoOrigenCaja ? 'CAJA' : 'DATEO',
    // Caso 1 nunca tiene avance (construirComisionRTM lo guarda en false).
    esAvance: ctx.caso === 'SIN_CONVENIO' ? false : ctx.descuento.esAvance,
    cfgValues: ctx.cfgValues,
    recValues: ctx.recValues,
    resultado: extra.resultado,
    despues: extra.despues,
    guardada: extra.guardada
      ? {
          montoAsesor: Number(extra.guardada.montoAsesor ?? 0),
          montoConvenio: Number(extra.guardada.montoConvenio ?? 0),
          reglaAplicada: extra.guardada.reglaAplicada ?? null,
        }
      : null,
    personas: personasDelDateo(ctx),
    sinComisionTicket: extra.sinComisionTicket,
  })
}

const conAlerta = (d: DesgloseComision | null, a: AlertaComision) =>
  d ? { ...d, alertas: [...d.alertas, a] } : d

/**
 * Qué le pasa a la comisión del dateo del turno si el ticket queda con el
 * descuento que trae en memoria (ya editado, sin guardar). No escribe nada.
 *  - Ticket no RTM o sin dateo → SIN_COMISION (sin desglose).
 *  - Con dateo y sin comisión → SIN_COMISION con desglose ESTIMADO.
 *  - ANULADA → NO_MODIFICADA (solo aviso).
 *  - PENDIENTE o APROBADA → RECALCULADA, sin cambiar su estado.
 *  - PAGADA o dentro de una liquidación → AJUSTADA_TRAS_PAGO: se recalcula
 *    igual, pero quien guarda debe confirmar que ya se pagó; las
 *    liquidaciones emitidas no se tocan.
 * El recálculo es el mismo motor de applyCommissionHook() (calcularComision
 * y la decisión "sin comisión" de un ticket de Excepción de Dateo). Con
 * convenio la continuidad es la guardada en el turno al confirmar; si no hay,
 * no se recalcula (SIN_CONTINUIDAD). Sin convenio, evaluarContinuidad()
 * devuelve SIN_EVIDENCIA sin leer historial: el mismo valor se usa aquí.
 * `desglose` es lo que muestra la pantalla, del mismo cálculo.
 */
export async function planearRecalculoComision(
  ticket: FacturacionTicket,
  trx?: TransactionClientContract
): Promise<PlanComisionEdicion> {
  if (!isRTM(ticket.servicioCodigo, ticket.servicioNombre)) {
    return sinRecalcular('SIN_COMISION', null)
  }
  const { comision, turno, dateoId } = await comisionDelTicket(ticket, trx)
  if (!dateoId) return sinRecalcular('SIN_COMISION', null)

  if (!comision) {
    // Facturación sin comisión todavía: lo que pagaría, como estimado.
    const ctx = await contextoComisionTicket(ticket, turno, dateoId, trx)
    const plan = sinRecalcular('SIN_COMISION', null, null, { dateoId })
    if (!ctx) return plan
    const conConvenio = !!(ctx.asesorConvenioIdReal || ctx.dateo.convenioId)
    const continuidadEstado =
      turno?.estadoContinuidad ??
      (conConvenio
        ? await evaluarContinuidad(
            {
              placa: (turno as any)?.placa ?? ticket.placaTurno ?? ctx.dateo.placa ?? '',
              asesorConvenioId: ctx.asesorConvenioIdReal,
              convenioId: ctx.dateo.convenioId,
            },
            trx
          )
        : 'SIN_EVIDENCIA')
    const motor = ejecutarMotor(ctx, ticket, continuidadEstado !== 'ROTA')
    if (!motor) return plan
    const sinComisionTicket = await debeRespetarSinComision(turno?.id ?? null)
    const c = motor.comision
    return {
      ...plan,
      desglose: desgloseDe(ctx, {
        continuidadEstado,
        resultado: motor.resultado,
        despues: {
          montoAsesor: sinComisionTicket.asesor ? 0 : Number(c.montoAsesor ?? 0),
          montoConvenio: sinComisionTicket.convenio ? 0 : Number(c.montoConvenio ?? 0),
        },
        guardada: null,
        sinComisionTicket,
      }),
    }
  }

  const filasLiquidacion = (await (trx ?? Database)
    .from('liquidacion_detalle')
    .where('comision_id', comision.id)
    .orderBy('liquidacion_id', 'asc')
    .select('liquidacion_id')) as { liquidacion_id: number }[]
  const liquidacionIds = filasLiquidacion.map((r) => Number(r.liquidacion_id))
  const extra = { liquidacionIds, dateoId }

  const ctx = await contextoComisionTicket(ticket, turno, dateoId, trx)
  const sinComisionTicket = await debeRespetarSinComision(turno?.id ?? null)
  const guardadaSinMotor = (
    accion: AccionComisionEdicion,
    mensaje: string,
    codigo: CodigoAlertaComision,
    alerta = mensaje
  ) => {
    const plan = sinRecalcular(accion, mensaje, comision, extra)
    const d = ctx
      ? desgloseDe(ctx, {
          continuidadEstado: turno?.estadoContinuidad ?? null,
          resultado: null,
          despues: null,
          guardada: comision,
          sinComisionTicket,
        })
      : null
    return { ...plan, desglose: conAlerta(d, { codigo, tipo: 'warning', mensaje: alerta }) }
  }

  if (comision.estado === 'ANULADA') {
    return guardadaSinMotor(
      'NO_MODIFICADA',
      `La comisión #${comision.id} está ANULADA: no se modificó.`,
      'NO_MODIFICADA'
    )
  }
  if (!ctx) return sinRecalcular('SIN_COMISION', null, null, extra)
  const { dateo } = ctx

  let tuvoContinuidad = true
  if (ctx.asesorConvenioIdReal || dateo.convenioId) {
    const guardada = turno?.estadoContinuidad ?? null
    if (!guardada) {
      return guardadaSinMotor(
        'SIN_CONTINUIDAD',
        `No se pudo recalcular: falta la continuidad guardada. La comisión #${comision.id} no se modificó.`,
        'SIN_CONTINUIDAD',
        `Continuidad guardada vacía: no se recalculó. La comisión #${comision.id} no se modificó.`
      )
    }
    tuvoContinuidad = guardada !== 'ROTA'
  }

  const motor = ejecutarMotor(ctx, ticket, tuvoContinuidad)
  const c = motor?.comision ?? null
  // El dateo ya no corresponde a la comisión guardada (otro asesor/convenio):
  // no se adivina, se deja como está.
  if (
    !c ||
    (c.asesorId ?? null) !== (comision.asesorId ?? null) ||
    (c.convenioId ?? null) !== (comision.convenioId ?? null)
  ) {
    return guardadaSinMotor(
      'NO_MODIFICADA',
      `No se pudo recalcular: la comisión #${comision.id} no coincide con el dateo actual. No se modificó, ajústala en Comisiones.`,
      'NO_MODIFICADA'
    )
  }

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

  const antes = montosDe(comision)
  const despues = montosDe(c)
  const diferencia = diferenciaDe(antes, despues)
  const requiereConfirmacionPago = comision.estado === 'PAGADA' || liquidacionIds.length > 0
  const avisos: string[] = []
  if (requiereConfirmacionPago) {
    const donde =
      comision.estado === 'PAGADA'
        ? 'ya fue pagada'
        : `ya está en la liquidación #${liquidacionIds.join(', #')}`
    avisos.push(
      `Esta comisión ${donde}. Se modificará el monto en el sistema, pero el dinero ya entregado no cambia. Diferencia: ${pesos(diferencia.total)}.`
    )
  }
  if (fotoTicket) {
    avisos.push(
      'El turno viene de un ticket de Excepción de Dateo aprobado sin comisión: esa decisión se respeta.'
    )
  }

  return {
    accion: requiereConfirmacionPago ? 'AJUSTADA_TRAS_PAGO' : 'RECALCULADA',
    mensaje: avisos.length ? avisos.join(' ') : null,
    comisionId: comision.id,
    estado: comision.estado,
    antes,
    despues,
    diferencia,
    liquidacionIds,
    requiereConfirmacionPago,
    dateoId,
    cambios,
    fotoTicket,
    desglose: desgloseDe(ctx, {
      continuidadEstado: turno?.estadoContinuidad ?? null,
      resultado: motor!.resultado,
      despues: { montoAsesor: despues.montoAsesor, montoConvenio: despues.montoConvenio },
      guardada: comision,
      sinComisionTicket,
    }),
  }
}

/**
 * Desglose de una comisión ya guardada (GET /comisiones/:id): el mismo
 * planearRecalculoComision() con la factura CONFIRMADA del turno tal como
 * está hoy. `antes` = lo guardado; `despues` = lo que el motor paga hoy. Si
 * no coinciden se agrega el aviso DISTINTO_AL_MOTOR (p. ej. un ajuste manual).
 * null cuando el turno no tiene factura confirmada (el motor necesita su
 * descuento y su tipo de vehículo).
 */
export async function desgloseDeComisionGuardada(
  comision: Pick<Comision, 'id' | 'captacionDateoId'>
): Promise<{ desglose: DesgloseComision | null; facturaId: number | null; motivo: string | null }> {
  if (!comision.captacionDateoId) {
    return { desglose: null, facturaId: null, motivo: 'La comisión no tiene dateo.' }
  }
  const dateo = await CaptacionDateo.find(comision.captacionDateoId)
  const turnoIds = [dateo?.consumidoTurnoId].filter((x): x is number => !!x)
  const turnoDelDateo = await TurnoRtm.query()
    .where('captacion_dateo_id', comision.captacionDateoId)
    .select('id')
  for (const t of turnoDelDateo) if (!turnoIds.includes(t.id)) turnoIds.push(t.id)
  const ticket = await FacturacionTicketModel.query()
    .where('estado', 'CONFIRMADA')
    .where((q) => {
      q.where('dateo_id', comision.captacionDateoId!)
      if (turnoIds.length) q.orWhereIn('turno_id', turnoIds)
    })
    .orderBy('id', 'desc')
    .first()
  if (!ticket) {
    return {
      desglose: null,
      facturaId: null,
      motivo: 'El turno no tiene factura confirmada: el desglose del motor aparece al confirmarla.',
    }
  }
  const plan = await planearRecalculoComision(ticket)
  let desglose = plan.desglose
  if (desglose && plan.comisionId !== null && plan.comisionId !== comision.id) {
    desglose = conAlerta(desglose, {
      codigo: 'NO_MODIFICADA',
      tipo: 'warning',
      mensaje: `La factura #${ticket.id} corresponde a la comisión #${plan.comisionId}, no a esta: el desglose es de esa comisión.`,
    })
  }
  if (
    desglose &&
    desglose.recalculado &&
    (plan.diferencia.asesor !== 0 || plan.diferencia.convenio !== 0)
  ) {
    const motor = desglose.beneficiarios
      .map((b) => `${b.nombre ?? b.rol} ${pesos(b.despues)}`)
      .join(', ')
    desglose = conAlerta(desglose, {
      codigo: 'DISTINTO_AL_MOTOR',
      tipo: 'warning',
      mensaje: `Lo guardado no coincide con lo que el motor paga hoy con esta factura y la configuración vigente (${motor}). Puede ser un ajuste manual o un cambio de configuración posterior.`,
    })
  }
  return { desglose, facturaId: ticket.id, motivo: null }
}

/**
 * Nota que queda en comisiones.observacion al recalcular por una edición del
 * descuento (se agrega al final, no reemplaza lo que había).
 */
export function notaEdicionFactura(p: {
  ticketId: number
  motivo: string
  antes: MontosComision
  despues: MontosComision
  diferencia: DiferenciaComision
  trasPago: boolean
  usuario: string
  fecha: DateTime
}): string {
  const total = (m: MontosComision) => pesos(m.montoAsesor + m.montoConvenio)
  return (
    `[${p.fecha.setZone('America/Bogota').toFormat('yyyy-LL-dd HH:mm')}] Edición de factura` +
    ` ticket #${p.ticketId} por ${p.usuario}: ${total(p.antes)} → ${total(p.despues)}` +
    ` (diferencia ${pesos(p.diferencia.total)})` +
    `${p.trasPago ? ', ajustada tras el pago' : ''}. Motivo: ${p.motivo}`
  )
}

/** Última edición de factura que cambió el monto de cada comisión (para Comisiones). */
export interface AjusteEdicionFactura {
  edicion_id: number
  facturacion_ticket_id: number
  diferencia: number
  tras_pago: boolean
  fecha: string | null
}

export async function ajustesEdicionFacturaPorComision(
  comisionIds: number[]
): Promise<Map<number, AjusteEdicionFactura>> {
  const ids = Array.from(new Set(comisionIds.filter((id) => Number(id) > 0)))
  const out = new Map<number, AjusteEdicionFactura>()
  if (!ids.length) return out
  const rows = (await Database.from('facturacion_descuento_ediciones')
    .whereIn('comision_id', ids)
    .whereIn('comision_accion', ['RECALCULADA', 'AJUSTADA_TRAS_PAGO'])
    .orderBy('id', 'desc')
    .select(
      'id',
      'comision_id',
      'facturacion_ticket_id',
      'comision_accion',
      'comision_monto_asesor_anterior',
      'comision_monto_asesor_nuevo',
      'comision_monto_convenio_anterior',
      'comision_monto_convenio_nuevo',
      'created_at'
    )) as any[]
  const n = (v: unknown) => Number(v ?? 0) || 0
  for (const r of rows) {
    const id = Number(r.comision_id)
    if (out.has(id)) continue
    const diferencia =
      n(r.comision_monto_asesor_nuevo) -
      n(r.comision_monto_asesor_anterior) +
      (n(r.comision_monto_convenio_nuevo) - n(r.comision_monto_convenio_anterior))
    out.set(id, {
      edicion_id: Number(r.id),
      facturacion_ticket_id: Number(r.facturacion_ticket_id),
      diferencia,
      tras_pago: r.comision_accion === 'AJUSTADA_TRAS_PAGO',
      fecha: r.created_at ? DateTime.fromJSDate(new Date(r.created_at)).toISO() : null,
    })
  }
  return out
}
