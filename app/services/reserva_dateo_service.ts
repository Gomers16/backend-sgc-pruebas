// app/services/reserva_dateo_service.ts
import { DateTime } from 'luxon'

/**
 * Ventana de exclusividad de un dateo sobre placa/teléfono, compartida por
 * captacion_dateos_controller.ts, busquedas_controller.ts y
 * turnos_rtms_controller.ts. Antes cada controller tenía su propia copia de
 * buildReserva() leyendo TTL_SIN_CONSUMIR_DIAS de .env — quedaba centralizada
 * aquí para que las 3 lean el mismo valor y no se desincronicen.
 */

interface DateoComoReserva {
  consumidoTurnoId: number | null
  consumidoAt: DateTime | null
  createdAt: DateTime
}

function ttlPostConsumoDias(): number {
  return Number(process.env.TTL_POST_CONSUMO_DIAS ?? 365)
}

// Cache en memoria del proceso: evita una query por cada buildReserva() en
// requests con varias llamadas (ver busquedas_controller.ts), sin quedar
// desactualizado más de unos segundos tras un cambio de configuración.
const CACHE_MS = 15_000
let cache: { horas: number; expiresAt: number } | null = null

export async function getHorasExclusividad(): Promise<number> {
  if (cache && cache.expiresAt > Date.now()) return cache.horas

  const { default: ConfiguracionReservaDateo } = await import(
    '#models/configuracion_reserva_dateo'
  )
  let config = await ConfiguracionReservaDateo.query().first()
  if (!config) {
    config = await ConfiguracionReservaDateo.create({ horasExclusividad: 60 } as any)
  }

  cache = { horas: config.horasExclusividad, expiresAt: Date.now() + CACHE_MS }
  return cache.horas
}

/** Invalida el cache — llamar tras actualizar la config desde el endpoint PUT/POST. */
export function invalidateHorasExclusividadCache(): void {
  cache = null
}

/** Reserva/ventana de exclusividad de un dateo. */
export async function buildReserva(
  d: DateoComoReserva
): Promise<{ vigente: boolean; bloqueaHasta: string | null }> {
  const now = DateTime.now()

  if (d.consumidoTurnoId && d.consumidoAt) {
    const hasta = d.consumidoAt.plus({ days: ttlPostConsumoDias() })
    return { vigente: now < hasta, bloqueaHasta: hasta.toISO() }
  }

  if (!d.createdAt) return { vigente: false, bloqueaHasta: null }

  const horasExclusividad = await getHorasExclusividad()
  const hasta = d.createdAt.plus({ hours: horasExclusividad })
  return { vigente: now < hasta, bloqueaHasta: hasta.toISO() }
}
