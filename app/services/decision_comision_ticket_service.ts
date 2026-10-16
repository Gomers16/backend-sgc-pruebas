// app/services/decision_comision_ticket_service.ts
//
// Decisión de gerencia sobre la comisión al aprobar un ticket de Excepción de
// Dateo fuera de ventana, separada para el asesor y el convenio.
//  - Dentro de ventana: no hay decisión (comisión completa), ambos null.
//  - Caso 1 (SIN_CONVENIO): solo el asesor; el flag de convenio no aplica.
//  - Caso 2 (CONVENIO_SELF): el asesor ES el convenio; solo con/sin comisión,
//    ambos flags iguales.
//  - Caso 3 (CONVENIO_COMERCIAL): las 4 combinaciones.
// Compatibilidad: si solo llega `con_comision` (frontend anterior) vale como
// flag del asesor con su significado de siempre (el convenio cobra; en Caso 2
// asesor y convenio son lo mismo).

import type { CasoComision } from '#services/comision_calculo_service'

export interface DecisionComisionTicket {
  /** true = paga, false = sin comisión, null = sin decisión (dentro de ventana). */
  asesor: boolean | null
  /** null también cuando el ticket no tiene convenio. */
  convenio: boolean | null
}

export type ResultadoDecisionComision =
  | { ok: true; decision: DecisionComisionTicket }
  | { ok: false; message: string }

const esFlag = (v: unknown): v is boolean => typeof v === 'boolean'
const vacio = (v: unknown) => v === undefined || v === null

export function resolverDecisionComision(p: {
  dentroVentana: boolean
  caso: CasoComision
  conComisionAsesor: unknown
  conComisionConvenio: unknown
  /** `con_comision` del body (formato anterior). */
  conComision: unknown
}): ResultadoDecisionComision {
  if (p.dentroVentana) return { ok: true, decision: { asesor: null, convenio: null } }

  const usaFormatoAnterior = vacio(p.conComisionAsesor) && esFlag(p.conComision)
  const asesor = esFlag(p.conComisionAsesor)
    ? p.conComisionAsesor
    : usaFormatoAnterior
      ? (p.conComision as boolean)
      : null
  if (asesor === null) {
    return {
      ok: false,
      message:
        'con_comision_asesor es requerido (true/false) cuando el ticket está fuera de ventana',
    }
  }
  if (!vacio(p.conComisionConvenio) && !esFlag(p.conComisionConvenio)) {
    return { ok: false, message: 'con_comision_convenio debe ser true/false' }
  }
  const convenioPedido = esFlag(p.conComisionConvenio) ? p.conComisionConvenio : null

  if (p.caso === 'SIN_CONVENIO') {
    if (convenioPedido !== null) {
      return {
        ok: false,
        message: 'El ticket no tiene convenio: no aplica una decisión de comisión para el convenio',
      }
    }
    return { ok: true, decision: { asesor, convenio: null } }
  }

  if (p.caso === 'CONVENIO_SELF') {
    const convenio = convenioPedido ?? asesor
    if (convenio !== asesor) {
      return {
        ok: false,
        message:
          'El asesor convenio cobra como asesor y como convenio: la comisión es con o sin, para ambos a la vez',
      }
    }
    return { ok: true, decision: { asesor, convenio } }
  }

  // CONVENIO_COMERCIAL
  if (convenioPedido === null) {
    if (usaFormatoAnterior) return { ok: true, decision: { asesor, convenio: true } }
    return {
      ok: false,
      message: 'con_comision_convenio es requerido (true/false) cuando el ticket tiene convenio',
    }
  }
  return { ok: true, decision: { asesor, convenio: convenioPedido } }
}
