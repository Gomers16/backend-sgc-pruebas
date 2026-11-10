// app/services/convenio_ticket_service.ts
//
// Decisión del convenio en un ticket de Excepción de Dateo: crear() y
// aprobar() obligan a elegir convenio o "Sin convenio (directo)".
//  - leerDecisionConvenioCrear(): valida el par convenio_id / sin_convenio del body.
//  - observacionMencionaConvenio(): aviso al aprobar (la observación dice
//    "convenio" y el ticket no tiene).
//  - convenioAsignadoAlAsesor(): si el convenio está asignado al comercial
//    (SUPER_ADMIN/GERENCIA pueden usar uno que no, queda registrado).

import Database from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

export type DecisionConvenioCrear =
  | { ok: true; convenioId: number | null; sinConvenio: boolean }
  | { ok: false; code: 'CONVENIO_NO_DECIDIDO'; message: string }

const esVerdadero = (v: unknown) => v === true || v === 'true' || v === 1 || v === '1'

/**
 * Body de crear(): exactamente uno de convenio_id o sin_convenio=true.
 * `esAsesorConvenio`: el convenio lo pone resolverIntentoDateo() (el suyo),
 * así que no hace falta elegirlo.
 */
export function leerDecisionConvenioCrear(p: {
  convenioId: number | null
  sinConvenio: unknown
  esAsesorConvenio: boolean
}): DecisionConvenioCrear {
  const sinConvenio = esVerdadero(p.sinConvenio)
  if (p.convenioId !== null && sinConvenio) {
    return {
      ok: false,
      code: 'CONVENIO_NO_DECIDIDO',
      message: 'Elige un convenio o "Sin convenio (directo)", no los dos.',
    }
  }
  // Asesor convenio: resolverIntentoDateo() le pone su convenio; un
  // sin_convenio que llegue no cambia nada.
  if (p.esAsesorConvenio) return { ok: true, convenioId: p.convenioId, sinConvenio: false }
  if (p.convenioId === null && !sinConvenio) {
    return {
      ok: false,
      code: 'CONVENIO_NO_DECIDIDO',
      message: 'Indica el convenio del cliente o marca "Sin convenio (directo)".',
    }
  }
  return { ok: true, convenioId: p.convenioId, sinConvenio }
}

/** La observación menciona un convenio ("convenio", "Convenios", "CONVENÍO"…). */
export function observacionMencionaConvenio(texto: string | null | undefined): boolean {
  if (!texto) return false
  const plano = texto.normalize('NFD').replace(/[̀-ͯ]/g, '')
  return /convenio/i.test(plano)
}

/** Asignación vigente asesor ↔ convenio (misma condición que resolverIntentoDateo()). */
export async function convenioAsignadoAlAsesor(
  asesorId: number,
  convenioId: number,
  client?: TransactionClientContract
): Promise<boolean> {
  const fila = await (client ?? Database)
    .from('asesor_convenio_asignaciones')
    .where('asesor_id', asesorId)
    .where('convenio_id', convenioId)
    .where('activo', true)
    .whereNull('fecha_fin')
    .first()
  return !!fila
}

/**
 * "Convenio no asignado" de un ticket: el mismo criterio en crear(),
 * aprobar(), corregirConvenio() y GET /tickets/:id (convenio_asignado):
 * cualquier canal salvo asesor convenio (que siempre usa el suyo).
 */
export async function convenioNoAsignadoAlComercial(p: {
  canal: string | null
  comercialId: number
  convenioId: number | null
  client?: TransactionClientContract
}): Promise<boolean> {
  if (p.convenioId === null || p.canal === 'ASESOR_CONVENIO') return false
  return !(await convenioAsignadoAlAsesor(p.comercialId, p.convenioId, p.client))
}
