// app/services/ventana_rtm_service.ts
//
// Vigencia del RTM y ventana previa al vencimiento. Única fuente de verdad
// para crear un turno (WINDOW_BLOCK_CONFIRMABLE), store() de dateos
// (RTM_VIGENTE), verificar-placa, la cola de Telemercadeo (puede_datear_desde
// / RTM vigente en CLIENTES) y los avisos de las gestiones.
//
// Decisión 2026-11-23: 16 días fijos en todos los sitios. La variable de
// entorno que cambiaba la ventana de dateos ya no se lee.

import { DateTime } from 'luxon'

export const ZONA_RTM = 'America/Bogota'

/** Meses de vigencia de un RTM aprobado. */
export const MESES_VIGENCIA_RTM = 12

/** Días antes del vencimiento desde los que se puede datear y crear el turno. */
export const DIAS_VENTANA_PRE_VENCIMIENTO = 16

export interface VigenciaRtm {
  /** Día en que vence el RTM (inicio del día, Bogotá). */
  venceEl: DateTime
  /** Primer día en que store() acepta un dateo RTM para esa placa. */
  puedeDatearDesde: DateTime
}

/** Vence = fecha del último RTM que da vigencia + 12 meses; ventana = vence − DIAS_VENTANA_PRE_VENCIMIENTO. */
export function vigenciaRtm(fechaUltimoRtm: DateTime | string): VigenciaRtm {
  const base =
    typeof fechaUltimoRtm === 'string'
      ? DateTime.fromISO(fechaUltimoRtm.substring(0, 10), { zone: ZONA_RTM })
      : fechaUltimoRtm.setZone(ZONA_RTM)
  const venceEl = base.plus({ months: MESES_VIGENCIA_RTM }).startOf('day')
  return { venceEl, puedeDatearDesde: venceEl.minus({ days: DIAS_VENTANA_PRE_VENCIMIENTO }) }
}

/** ¿store() bloquearía hoy un dateo RTM con RTM_VIGENTE? */
export function bloqueaDateoRtm(v: VigenciaRtm, hoy: DateTime = DateTime.now()): boolean {
  return hoy.setZone(ZONA_RTM).startOf('day') < v.puedeDatearDesde
}
