// app/services/segunda_vez_service.ts
//
// Única fuente de verdad de "Segunda vez" (reinspección gratuita tras una
// certificación RECHAZADA de RTM o Preventiva).
//
// Reglas (cerradas con negocio):
//  - Aplica solo a los servicios RTM y PREV (códigos reales en servicios.codigo_servicio).
//  - Al certificar RECHAZADA un turno que NO es segunda vez se abre una
//    ventana de 360 h exactas (15 días corridos) desde el instante del
//    rechazo, con hora del servidor (Bogotá), nunca la del frontend.
//  - Borde ESTRICTO: abierta solo si ahora < ventana_hasta.
//  - Si la segunda vez también sale RECHAZADA no se abre otra ventana.
//  - Un turno RECHAZADO no da vigencia (no bloquea WINDOW_BLOCK/RTM_VIGENTE).
//    resultado NULL (histórico / SOAT / PERI) se trata como aprobado.
//
// Las funciones reciben "ahora" por parámetro para poder probar los bordes.

import { DateTime } from 'luxon'

export type ResultadoCertificacion = 'APROBADA' | 'RECHAZADA'
export type EstadoVentanaSegundaVez = 'NO_APLICA' | 'ABIERTA' | 'VENCIDA'

export const ZONA_SEGUNDA_VEZ = 'America/Bogota'
export const SERVICIOS_SEGUNDA_VEZ = ['RTM', 'PREV'] as const
export const HORAS_VENTANA = 360
export const RESULTADOS_CERTIFICACION: readonly ResultadoCertificacion[] = ['APROBADA', 'RECHAZADA']

/** ¿El servicio (por codigo_servicio) participa de Segunda vez? */
export function aplicaSegundaVez(codigoServicio?: string | null): boolean {
  const c = (codigoServicio || '').toUpperCase().trim()
  return (SERVICIOS_SEGUNDA_VEZ as readonly string[]).includes(c)
}

/** Normaliza el resultado recibido del cliente; null si no es válido. */
export function parseResultadoCertificacion(v: unknown): ResultadoCertificacion | null {
  const x = String(v ?? '')
    .toUpperCase()
    .trim()
  return (RESULTADOS_CERTIFICACION as readonly string[]).includes(x)
    ? (x as ResultadoCertificacion)
    : null
}

/** Instante del rechazo según el servidor (Bogotá), truncado a segundos (DATETIME sin fracción). */
export function instanteRechazo(ahora: DateTime = DateTime.now()): DateTime {
  return ahora.setZone(ZONA_SEGUNDA_VEZ).startOf('second')
}

/** rechazadoAt + 360 h exactas. */
export function calcularVentanaHasta(rechazadoAt: DateTime): DateTime {
  return rechazadoAt.plus({ hours: HORAS_VENTANA })
}

/** es_segunda_vez es TINYINT(1): mysql2 lo entrega como 0/1. */
export function esTurnoSegundaVez(t: { esSegundaVez?: boolean | number | null }): boolean {
  return Boolean(t.esSegundaVez)
}

/**
 * Estado de la ventana de un turno rechazado.
 * Parcial en la Entrega A: solo NO_APLICA / ABIERTA / VENCIDA a partir de
 * ventana_segunda_vez_hasta (no considera excepciones ni si ya se usó).
 */
export function estadoVentana(
  t: { ventanaSegundaVezHasta?: DateTime | null },
  ahora: DateTime
): EstadoVentanaSegundaVez {
  const hasta = t.ventanaSegundaVezHasta
  if (!hasta) return 'NO_APLICA'
  return ahora.toMillis() < hasta.toMillis() ? 'ABIERTA' : 'VENCIDA'
}

/**
 * Datos de segunda vez a guardar al certificar un turno. Para servicios que
 * no aplican, resultado y ventana quedan en NULL.
 */
export function camposAlCertificar(params: {
  codigoServicio?: string | null
  resultado: ResultadoCertificacion | null
  esSegundaVez: boolean | number | null | undefined
  ahora: DateTime
}): {
  resultadoCertificacion: ResultadoCertificacion | null
  rechazadoAt: DateTime | null
  ventanaSegundaVezHasta: DateTime | null
} {
  if (!aplicaSegundaVez(params.codigoServicio) || !params.resultado) {
    return { resultadoCertificacion: null, rechazadoAt: null, ventanaSegundaVezHasta: null }
  }
  if (params.resultado === 'APROBADA') {
    return { resultadoCertificacion: 'APROBADA', rechazadoAt: null, ventanaSegundaVezHasta: null }
  }
  const rechazadoAt = instanteRechazo(params.ahora)
  return {
    resultadoCertificacion: 'RECHAZADA',
    rechazadoAt,
    // Segunda vez rechazada: no se abre otra ventana.
    ventanaSegundaVezHasta: esTurnoSegundaVez({ esSegundaVez: params.esSegundaVez })
      ? null
      : calcularVentanaHasta(rechazadoAt),
  }
}

/**
 * ¿Este turno da vigencia (cuenta para WINDOW_BLOCK / RTM_VIGENTE)?
 * estado finalizado Y resultado_certificacion NULL o APROBADA.
 */
export function esTurnoQueDaVigencia(t: {
  estado?: string | null
  resultadoCertificacion?: ResultadoCertificacion | null
}): boolean {
  return t.estado === 'finalizado' && t.resultadoCertificacion !== 'RECHAZADA'
}

/**
 * Mismo criterio que esTurnoQueDaVigencia() como filtro SQL sobre
 * turnos_rtms (Lucid model query o query builder).
 */
export function whereTurnoDaVigencia<Q extends { where: (...args: any[]) => any }>(
  query: Q,
  tabla: string = 'turnos_rtms'
): Q {
  query.where(`${tabla}.estado`, 'finalizado')
  query.where((q: any) => {
    q.whereNull(`${tabla}.resultado_certificacion`).orWhere(
      `${tabla}.resultado_certificacion`,
      'APROBADA'
    )
  })
  return query
}
