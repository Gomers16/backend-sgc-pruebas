// app/services/ventana_rtm_service.ts
//
// Vigencia del RTM y ventana previa en la que ya se puede datear para RTM.
// Única fuente de verdad para store() de dateos (RTM_VIGENTE), la cola de
// Telemercadeo (puede_datear_desde / RTM vigente en CLIENTES) y los avisos
// de las gestiones de Telemercadeo.
//
// OJO: la ventana sale de DIAS_VENTANA_PRE_RTM (10 por defecto). En pruebas
// no está definida (10); en producción local está en 5. La ventana de 16
// días de turnos_rtms_controller.ts (WINDOW_BLOCK al crear un turno) es otra
// regla y no se toca aquí.

import { DateTime } from 'luxon'

export const ZONA_RTM = 'America/Bogota'

/** Meses de vigencia de un RTM aprobado. */
export const MESES_VIGENCIA_RTM = 12

/** Días antes del vencimiento desde los que store() deja datear para RTM. */
export function diasVentanaPreRtm(): number {
  return Number(process.env.DIAS_VENTANA_PRE_RTM ?? 10)
}

export interface VigenciaRtm {
  /** Día en que vence el RTM (inicio del día, Bogotá). */
  venceEl: DateTime
  /** Primer día en que store() acepta un dateo RTM para esa placa. */
  puedeDatearDesde: DateTime
}

/** Vence = fecha del último RTM que da vigencia + 12 meses; ventana = vence − diasVentanaPreRtm(). */
export function vigenciaRtm(fechaUltimoRtm: DateTime | string): VigenciaRtm {
  const base =
    typeof fechaUltimoRtm === 'string'
      ? DateTime.fromISO(fechaUltimoRtm.substring(0, 10), { zone: ZONA_RTM })
      : fechaUltimoRtm.setZone(ZONA_RTM)
  const venceEl = base.plus({ months: MESES_VIGENCIA_RTM }).startOf('day')
  return { venceEl, puedeDatearDesde: venceEl.minus({ days: diasVentanaPreRtm() }) }
}

/** ¿store() bloquearía hoy un dateo RTM con RTM_VIGENTE? */
export function bloqueaDateoRtm(v: VigenciaRtm, hoy: DateTime = DateTime.now()): boolean {
  return hoy.setZone(ZONA_RTM).startOf('day') < v.puedeDatearDesde
}
