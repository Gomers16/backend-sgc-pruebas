// app/services/comision_ticket_excepcion_service.ts
//
// Comisión RTM de un ticket de Excepción de Dateo, compartida por
// tickets_excepcion_dateo_controller.ts::aprobar() (comisión nueva) y
// ::corregirConvenio() (corrección posterior de una comisión PENDIENTE). Es el
// cálculo que antes vivía dentro de aprobar(), sin cambios: mismo motor
// (calcularComision), mismo criterio de descuento/avance que
// applyCommissionHook() y la misma decisión "sin comisión" de gerencia.
//  - calcularComisionTicketExcepcion(): escenario, continuidad, configuración,
//    descuento final y avance → resultado del motor. Solo lee.
//  - aplicarComisionTicketExcepcion(): escribe en la Comision (sin guardar)
//    beneficiarios y montos, y fuerza a $0 lo que gerencia decidió.

import Database from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type Comision from '#models/comision'
import type CaptacionDateo from '#models/captacion_dateo'
import type TurnoRtm from '#models/turno_rtm'
import type FacturacionTicket from '#models/facturacion_ticket'
import Descuento from '#models/descuento'
import { evaluarContinuidad } from '#services/continuidad_service'
import {
  resolveConfigComision,
  resolveConfigRecurrencia,
  calcularComision,
  inferTipoVehiculoComision,
  esDescuentoFinalAvance,
  convenioSinComisionPorDescuento,
  type CasoComision,
  type EscenarioCliente,
  type ResultadoCalculoComision,
} from '#services/comision_calculo_service'
import type { DecisionComisionTicket } from '#services/decision_comision_ticket_service'

export interface CalculoComisionTicketExcepcion {
  caso: CasoComision
  resultado: ResultadoCalculoComision
  esAvance: boolean
  codigoDescuento: string | null
  /** Regla del motor (solo se informa): con convenio, cualquier descuento final deja al convenio en $0. */
  convenioEnCeroPorDescuento: boolean
  estadoContinuidad: Awaited<ReturnType<typeof evaluarContinuidad>>
}

export async function calcularComisionTicketExcepcion(p: {
  trx: TransactionClientContract
  turno: TurnoRtm
  dateo: CaptacionDateo
  caso: CasoComision
  asesorConvenioIdReal: number | null
  facturacionConfirmada: FacturacionTicket | null
}): Promise<CalculoComisionTicketExcepcion> {
  const { trx, turno, dateo, caso, asesorConvenioIdReal, facturacionConfirmada } = p

  // Escenario — turno.esRecurrente/esRecuperacion ya vienen calculados
  // desde la creación del turno (historial del cliente).
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
    convenioId: dateo.convenioId,
    excluirTurnoId: turno.id,
  })
  const tuvoContinuidad = estadoContinuidad !== 'ROTA'

  const cfgValues = await resolveConfigComision({
    asesorId: dateo.agenteId,
    asesorConvenioId: asesorConvenioIdReal,
    tipoVehiculo: tipoVehiculoComision,
  })
  const recValues = await resolveConfigRecurrencia(dateo.agenteId, tipoVehiculoComision)

  // Descuento y avance — mismo criterio que applyCommissionHook(): manda
  // el descuento de caja si lo hay; si no, el pre-marcado en el dateo.
  const descuentoIdActivo = facturacionConfirmada?.descuentoId ?? dateo.descuentoId ?? null
  const descuentoActivo = descuentoIdActivo
    ? await Descuento.query({ client: trx })
        .where('id', descuentoIdActivo)
        .where('activo', true)
        .first()
    : null
  const codigoDescuento = descuentoActivo?.codigo ?? null
  // Descuento final: el de la factura confirmada; sin factura todavía,
  // el del intento (applyCommissionHook lo recalcula al confirmar). Con
  // convenio, cualquier descuento final deja al convenio en $0; Avance
  // solo decide el monto de avance. La marca es_avance es informativa.
  const codigoDescuentoFinal = facturacionConfirmada
    ? facturacionConfirmada.descuentoId
      ? codigoDescuento
      : null
    : codigoDescuento
  const esAvance = esDescuentoFinalAvance({ caso, codigoDescuentoFinal })
  let montoAvance = 0
  if (esAvance && descuentoActivo) {
    const montoExplicito = Number(facturacionConfirmada?.descuentoMontoAplicado ?? 0)
    montoAvance =
      montoExplicito > 0
        ? montoExplicito
        : Number(
            tipoVehiculoComision === 'MOTO'
              ? ((descuentoActivo as any).valorMoto ?? 0)
              : ((descuentoActivo as any).valorCarro ?? 0)
          )
  }

  const resultado = calcularComision({
    caso,
    escenario,
    tuvoContinuidad,
    montoAvance,
    codigoDescuento,
    codigoDescuentoFinal,
    cfgValues,
    recValues,
  })

  return {
    caso,
    resultado,
    esAvance,
    codigoDescuento,
    convenioEnCeroPorDescuento: convenioSinComisionPorDescuento({ caso, codigoDescuentoFinal }),
    estadoContinuidad,
  }
}

/**
 * Escribe el cálculo en la Comision (no guarda): beneficiarios del caso,
 * montos y descuento; después fuerza a $0 la parte que gerencia decidió
 * "sin comisión". `monto` queda con el valor del motor (lo que se dejó de
 * pagar). Devuelve la foto previa al $0 (null si no hubo "sin comisión").
 * No toca estado, fecha_calculo ni calculado_por.
 */
export function aplicarComisionTicketExcepcion(
  c: Comision,
  p: {
    calculo: CalculoComisionTicketExcepcion
    dateo: CaptacionDateo
    asesorConvenioIdReal: number | null
    facturacionConfirmada: FacturacionTicket
    decision: DecisionComisionTicket
  }
): { montoAsesorCalculado: string | null; montoConvenioCalculado: string | null } {
  const { calculo, dateo, asesorConvenioIdReal, facturacionConfirmada, decision } = p
  const { caso, resultado } = calculo

  if (caso === 'SIN_CONVENIO') {
    c.asesorId = dateo.agenteId
    c.convenioId = null
    c.asesorSecundarioId = null
  } else if (caso === 'CONVENIO_SELF') {
    c.asesorId = asesorConvenioIdReal ?? dateo.agenteId
    c.convenioId = dateo.convenioId
    c.asesorSecundarioId = null
  } else {
    c.asesorId = dateo.agenteId
    c.convenioId = dateo.convenioId
    c.asesorSecundarioId = asesorConvenioIdReal
  }

  c.base = String(resultado.base)
  c.monto = String(resultado.monto)
  c.montoAsesor = String(resultado.montoAsesor)
  c.montoConvenio = String(resultado.montoConvenio)
  c.valorNuevoDirecto = String(resultado.valorNuevoDirectoFinal)
  c.reglaAplicada = resultado.reglaAplicada
  c.esAvance = calculo.esAvance
  c.descuentoCodigoAplicado = calculo.codigoDescuento
  c.descuentoObservacionCaja = facturacionConfirmada.descuentoObservacion ?? null
  if (resultado.descuentoMontoAplicado !== null) {
    c.descuentoMontoAplicado = resultado.descuentoMontoAplicado
  }

  // "Sin comisión" (dentro o fuera de ventana): se calcula la comisión
  // normal con el motor de siempre y se fuerza a 0 recién acá, solo la
  // parte que gerencia decidió.
  const hayFoto = decision.asesor === false || decision.convenio === false
  const foto = {
    montoAsesorCalculado: hayFoto ? c.montoAsesor : null,
    montoConvenioCalculado: hayFoto ? c.montoConvenio : null,
  }
  if (decision.asesor === false) c.montoAsesor = '0'
  if (decision.convenio === false) c.montoConvenio = '0'
  return foto
}

/**
 * Comisión RTM del dateo del turno de un ticket (para la pantalla):
 * { id, estado, en_liquidacion, monto_asesor, monto_convenio } o
 * { id: null } si todavía no hay comisión; null si el turno no tiene dateo.
 */
export async function comisionDelTicketExcepcion(turnoId: number): Promise<{
  id: number | null
  estado: string | null
  en_liquidacion: boolean
  monto_asesor: number | null
  monto_convenio: number | null
} | null> {
  const turno = await Database.from('turnos_rtms')
    .where('id', turnoId)
    .select('captacion_dateo_id')
    .first()
  if (!turno?.captacion_dateo_id) return null
  const c = await Database.from('comisiones')
    .where('captacion_dateo_id', turno.captacion_dateo_id)
    .where('tipo_servicio', 'RTM')
    .whereNot('estado', 'ANULADA')
    .orderBy('id', 'desc')
    .select('id', 'estado', 'monto_asesor', 'monto_convenio')
    .first()
  if (!c) {
    return {
      id: null,
      estado: null,
      en_liquidacion: false,
      monto_asesor: null,
      monto_convenio: null,
    }
  }
  const liq = await Database.from('liquidacion_detalle').where('comision_id', c.id).first()
  return {
    id: Number(c.id),
    estado: c.estado,
    en_liquidacion: !!liq,
    monto_asesor: c.monto_asesor === null ? null : Number(c.monto_asesor),
    monto_convenio: c.monto_convenio === null ? null : Number(c.monto_convenio),
  }
}
