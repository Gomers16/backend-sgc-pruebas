// app/services/reserva_dateo_service.ts
import { DateTime } from 'luxon'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type TurnoRtm from '#models/turno_rtm'

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
  /** Fecha del último re-dateo confirmado (con evidencia). Si existe, la
   * ventana de exclusividad se recalcula desde acá en vez de desde createdAt. */
  redateadoAt?: DateTime | null
  /** 🆕 Servicio del dateo — decide la cadencia del TTL post-consumo (ver
   * ttlPostConsumoDiasPorServicio). Los 9 call sites existentes ya pasan una
   * instancia real de CaptacionDateo, que siempre trae esta columna. */
  servicioId?: number | null
}

function ttlPostConsumoDias(): number {
  return Number(process.env.TTL_POST_CONSUMO_DIAS ?? 365)
}

// 🆕 Cadencia de bloqueo post-consumo por tipo de servicio: RTM/SOAT usan el
// TTL global de siempre (365 días); PREVENTIVA/PERITAJE se liberan mucho
// antes (60 días) — su ciclo de recompra real es más corto y bloquearlos
// casi un año generaba falsos "dateo activo" (ver caso WTP333/PREVENTIVA).
function ttlPostConsumoDiasPorServicio(codigoServicio: string | null): number {
  if (codigoServicio === 'PREV' || codigoServicio === 'PERI') {
    return Number(process.env.TTL_POST_CONSUMO_DIAS_PREV_PERI ?? 60)
  }
  return ttlPostConsumoDias()
}

// Cache en memoria del proceso (mismo patrón/TTL que getHorasExclusividad()
// abajo): evita una query a `servicios` en cada buildReserva().
const CACHE_SERVICIOS_MS = 15_000
let cacheServicios: { porId: Map<number, string>; expiresAt: number } | null = null

async function getCodigoServicio(servicioId: number | null | undefined): Promise<string | null> {
  if (!servicioId) return null

  if (!cacheServicios || cacheServicios.expiresAt <= Date.now()) {
    const { default: Servicio } = await import('#models/servicio')
    const servicios = await Servicio.query().select(['id', 'codigoServicio'])
    const porId = new Map<number, string>()
    for (const s of servicios) porId.set(s.id, s.codigoServicio.toUpperCase())
    cacheServicios = { porId, expiresAt: Date.now() + CACHE_SERVICIOS_MS }
  }

  return cacheServicios.porId.get(servicioId) ?? null
}

// Mismo criterio de normalización que CaptacionDateo.normalize() (beforeSave)
// y captacion_dateos_controller.ts: sin espacios/guiones y en mayúsculas para
// placa, solo dígitos para teléfono — así es exactamente como queda guardado
// en BD, y cerrarDateosViejosPorPlacaTelefono() necesita comparar contra eso.
function normalizePlaca(v?: string | null): string | null {
  return v ? v.replace(/[\s-]/g, '').toUpperCase() : (v ?? null)
}
function normalizePhone(v?: string | null): string | null {
  return v ? v.replace(/\D/g, '') : (v ?? null)
}

// Cache en memoria del proceso: evita una query por cada buildReserva() en
// requests con varias llamadas (ver busquedas_controller.ts), sin quedar
// desactualizado más de unos segundos tras un cambio de configuración.
const CACHE_MS = 15_000
let cache: { horas: number; expiresAt: number } | null = null

export async function getHorasExclusividad(): Promise<number> {
  if (cache && cache.expiresAt > Date.now()) return cache.horas

  const { default: ConfiguracionReservaDateo } = await import('#models/configuracion_reserva_dateo')
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
    const codigoServicio = await getCodigoServicio(d.servicioId)
    const hasta = d.consumidoAt.plus({ days: ttlPostConsumoDiasPorServicio(codigoServicio) })
    return { vigente: now < hasta, bloqueaHasta: hasta.toISO() }
  }

  const base = d.redateadoAt ?? d.createdAt
  if (!base) return { vigente: false, bloqueaHasta: null }

  const horasExclusividad = await getHorasExclusividad()
  const hasta = base.plus({ hours: horasExclusividad })
  return { vigente: now < hasta, bloqueaHasta: hasta.toISO() }
}

/**
 * ¿Este dateo aplica al servicio del turno que se está creando/cerrando?
 *
 * Regla de negocio (confirmada 2026-08-19): un dateo solo se hereda/consume/
 * marca EXITOSO cuando el turno es del MISMO servicio que se dateó —
 * comparación estricta `dateo.servicioId === servicioId`. Un dateo con
 * `servicioId` en `null` (legacy o creado sin servicio explícito, la columna
 * es nullable) NO aplica a ningún servicio bajo esta regla: al no haber
 * dato con qué comparar, se trata como no-match en vez de asumir que aplica
 * a cualquiera (más seguro para no marcar EXITOSO/pagar comisión de más).
 *
 * Única fuente de verdad para esta regla — reutilizar en cualquier punto que
 * vincule/consuma/marque EXITOSO un dateo (turnos_rtms_controller.ts,
 * turnos_cierre_controller.ts, captacion_dateos_controller.ts,
 * comisiones_controller.ts), igual que buildReserva() para vigencia.
 */
export function dateoAplicaAServicio(
  dateo: { servicioId?: number | null } | null | undefined,
  servicioId: number | null | undefined
): boolean {
  if (!dateo) return false
  if (!servicioId) return false
  return dateo.servicioId === servicioId
}

/**
 * Ventana de 40 minutos desde turno.horaIngreso dentro de la cual un turno
 * SIN dateo vinculado (captacion_dateo_id NULL) todavía puede recibir un
 * dateo de excepción sin pasar por el ticket "Excepción de Dateo". Usada por
 * captacion_dateos_controller.ts::store() ANTES de la validación de
 * exclusividad por placa+servicio.
 *
 * Mismo parseo de horaIngreso ('HH:mm:ss' con fallback a 'HH:mm', zona
 * America/Bogota) que ya usan registrarSalida() (turnos_rtms_controller.ts)
 * y confirmar()/applyCommissionHook() (facturacion_tickets_controller.ts).
 */
// Exportada (antes vivía solo dentro de la función) para que
// captacion_dateos_controller.ts::store() pueda calcular
// minutos_restantes_ventana en la respuesta de éxito sin duplicar el 40
// como número mágico en dos archivos.
export const VENTANA_MINUTOS_DATEO_TURNO = 40

export function dentroVentanaDateoTurno(turno: {
  horaIngreso: TurnoRtm['horaIngreso']
}): { dentro: boolean; minutosTotales: number; minutosExceso: number } {
  let entrada = DateTime.fromFormat(turno.horaIngreso, 'HH:mm:ss', { zone: 'America/Bogota' })
  if (!entrada.isValid) {
    entrada = DateTime.fromFormat(turno.horaIngreso, 'HH:mm', { zone: 'America/Bogota' })
  }

  const ahora = DateTime.local().setZone('America/Bogota')
  const minutosTotales = Math.max(0, Math.floor(ahora.diff(entrada, 'minutes').minutes))
  const minutosExceso = Math.max(0, minutosTotales - VENTANA_MINUTOS_DATEO_TURNO)
  const dentro = minutosTotales <= VENTANA_MINUTOS_DATEO_TURNO

  return { dentro, minutosTotales, minutosExceso }
}

/**
 * Máximo de veces que un dateo puede re-datearse. Cascada: override por
 * asesor (si existe y no es null) → config global (find-or-create con
 * default 3). Sin cache — se llama solo dentro de POST /:id/redatear, bajo
 * volumen, no es un hot-path como getHorasExclusividad().
 */
export async function getMaxRedateos(agenteId?: number | null): Promise<number> {
  if (agenteId) {
    const { default: ConfiguracionRedateoAsesor } = await import(
      '#models/configuracion_redateo_asesor'
    )
    const override = await ConfiguracionRedateoAsesor.query().where('asesor_id', agenteId).first()
    if (override && override.maxRedateos !== null) {
      return override.maxRedateos
    }
  }

  const { default: ConfiguracionRedateoGlobal } = await import(
    '#models/configuracion_redateo_global'
  )
  let config = await ConfiguracionRedateoGlobal.query().first()
  if (!config) {
    config = await ConfiguracionRedateoGlobal.create({ maxRedateos: 3 } as any)
  }
  return config.maxRedateos
}

/**
 * Cierra (RE_DATEAR → REEMPLAZADO) todos los dateos vencidos-y-no-consumidos
 * de una placa/teléfono, justo antes de crear un dateo nuevo para esa misma
 * placa/teléfono. Reutiliza la columna `observacion` ya existente en
 * captacion_dateos (mismo patrón que ya usa verificarVencidos() para su nota
 * "[AUTO] Vencido por inactividad...") — no agrega columna nueva.
 *
 * Normaliza placa/teléfono internamente (mismo criterio que el modelo y los
 * controllers) para no depender de que el caller ya los mande normalizados.
 *
 * OJO: NO filtra por `liberado` — los dateos en RE_DATEAR ya tienen
 * liberado=true, filtrar por liberado=false los dejaría fuera por completo.
 */
export async function cerrarDateosViejosPorPlacaTelefono(
  placaRaw: string | null,
  telefonoRaw: string | null,
  motivo: string,
  trx?: TransactionClientContract
): Promise<number> {
  const placa = normalizePlaca(placaRaw)
  const telefono = normalizePhone(telefonoRaw)
  if (!placa && !telefono) return 0

  const { default: CaptacionDateo } = await import('#models/captacion_dateo')

  const viejos = await CaptacionDateo.query({ client: trx })
    .where('resultado', 'RE_DATEAR')
    .where((qb) => {
      if (placa) qb.orWhere('placa', placa)
      if (telefono) qb.orWhere('telefono', telefono)
    })

  const nota = `[AUTO] ${motivo}`

  for (const viejo of viejos) {
    viejo.resultado = 'REEMPLAZADO'
    viejo.observacion = viejo.observacion ? `${viejo.observacion}\n${nota}` : nota
    if (trx) {
      await viejo.useTransaction(trx).save()
    } else {
      await viejo.save()
    }
  }

  return viejos.length
}
