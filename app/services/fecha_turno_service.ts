// app/services/fecha_turno_service.ts
//
// Regla de la fecha al crear un turno (crearTurno en turnos_rtms_controller.ts):
//  - Hoy (fecha del servidor, Bogotá): siempre se acepta, como siempre.
//  - Futura: 422 para todos los roles.
//  - Anterior a hoy (retroactiva): solo ROLES_FECHA_RETROACTIVA, según el rol
//    del usuario AUTENTICADO (no el usuarioId del body); los demás, 403.
// Funciones puras: "hoy" y el rol llegan por parámetro para poder probarlas.

import { DateTime } from 'luxon'

export const ZONA_FECHA_TURNO = 'America/Bogota'

/** Roles que pueden crear turnos con fecha anterior a hoy. */
export const ROLES_FECHA_RETROACTIVA: readonly string[] = ['SUPER_ADMIN', 'GERENCIA']

/** Fecha de hoy (YYYY-MM-DD) según el servidor, en Bogotá. */
export function hoyServidorISO(ahora: DateTime = DateTime.now()): string {
  return ahora.setZone(ZONA_FECHA_TURNO).toISODate()!
}

export function puedeCrearConFechaRetroactiva(rol: string | null | undefined): boolean {
  return !!rol && ROLES_FECHA_RETROACTIVA.includes(rol)
}

export interface ErrorFechaTurno {
  status: 403 | 422
  code: 'FECHA_FUTURA' | 'FECHA_RETROACTIVA_NO_AUTORIZADA'
  message: string
}

/**
 * null si la fecha se acepta; si no, el error a responder.
 * fechaISO y hoyISO en formato YYYY-MM-DD (comparables como texto).
 */
export function validarFechaTurno(params: {
  fechaISO: string
  hoyISO: string
  rol: string | null | undefined
}): ErrorFechaTurno | null {
  const { fechaISO, hoyISO, rol } = params
  if (fechaISO === hoyISO) return null
  if (fechaISO > hoyISO) {
    return {
      status: 422,
      code: 'FECHA_FUTURA',
      message: `No se puede crear un turno con fecha futura (${fechaISO}).`,
    }
  }
  if (!puedeCrearConFechaRetroactiva(rol)) {
    return {
      status: 403,
      code: 'FECHA_RETROACTIVA_NO_AUTORIZADA',
      message: `Solo ${ROLES_FECHA_RETROACTIVA.join(' o ')} pueden crear turnos con fecha anterior a hoy.`,
    }
  }
  return null
}
