// app/services/semaforo_service.ts
//
// Semáforo de metas compartido (Súper Informe / meta comercial y metas de
// Telemercadeo). Movido sin cambios desde reportes_administrativos_controller.ts.

export type SemaforoColor = 'VERDE' | 'AMARILLO' | 'ROJO' | 'SIN_META'

/**
 * Semáforo genérico: >=100% verde, >=90% amarillo, resto rojo.
 * Umbral no especificado por el negocio — asunción documentada en el
 * resumen de implementación.
 *
 * `pct === null` significa "meta no configurada" (ver calcularPct) — se
 * retorna el estado neutro 'SIN_META' en vez de tratarlo como ROJO, para
 * no confundir "sin meta" con "va mal".
 */
export function calcularSemaforo(pct: number | null): SemaforoColor {
  if (pct === null) return 'SIN_META'
  if (pct >= 100) return 'VERDE'
  if (pct >= 90) return 'AMARILLO'
  return 'ROJO'
}

/** % de avance con un decimal; null si no hay meta (> 0). */
export function calcularPct(avance: number, meta: number): number | null {
  return meta > 0 ? Math.round((avance / meta) * 1000) / 10 : null
}
