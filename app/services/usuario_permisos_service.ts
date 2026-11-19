// app/services/usuario_permisos_service.ts
//
// Multi-sede, Fase 0 — quién puede crear / editar / borrar a quién, y en qué
// sede (decisión 9 del 2026-11-19):
//
//   SUPER_ADMIN     → cualquier sede, cualquier rol.
//   GERENCIA        → cualquier sede, cualquier rol menos SUPER_ADMIN; no toca
//                     usuarios SUPER_ADMIN.
//   TALENTO_HUMANO  → solo su propia sede; no asigna SUPER_ADMIN ni GERENCIA y
//                     no toca usuarios con esos roles. Un usuario nuevo sin
//                     sede queda en la sede del actor.
//
// Funciones puras (sin BD) para poder probarlas en tests unitarios; los
// controladores resuelven roles y sedes y llaman aquí. Cualquier otro rol de
// actor queda denegado (las rutas ya lo filtran con checkRole; esto es la
// segunda capa).

export const ROL_SUPER_ADMIN = 'SUPER_ADMIN'
export const ROL_GERENCIA = 'GERENCIA'
export const ROL_TALENTO_HUMANO = 'TALENTO_HUMANO'

const ROLES_RESERVADOS_TH = new Set([ROL_SUPER_ADMIN, ROL_GERENCIA])

export interface ActorUsuarios {
  rol: string | null
  sedeId: number | null
}

export interface UsuarioObjetivo {
  rol: string | null
  sedeId: number | null
}

export type ResultadoPermiso =
  | { ok: true; sedeId: number | null }
  | { ok: false; status: 403 | 422; message: string }

/** Normaliza un id que puede llegar como string, '' o null desde el formulario. */
export function normalizarId(v: unknown): number | null | undefined {
  if (v === undefined) return undefined
  if (v === null || v === '') return null
  const n = Number(v)
  return Number.isInteger(n) && n > 0 ? n : Number.NaN
}

function norm(rol: string | null | undefined): string {
  return (rol ?? '').toUpperCase().trim()
}

function denegado(message: string): ResultadoPermiso {
  return { ok: false, status: 403, message }
}

/**
 * Valida una alta (objetivoActual = null), una edición o una baja
 * (cambios = {}) de usuario.
 *
 * - `cambios.rol`: nombre del rol que se quiere asignar (undefined = no cambia).
 * - `cambios.sedeId`: sede que se quiere asignar (undefined = no cambia,
 *   null = sin sede).
 *
 * Devuelve la sede final del usuario (para TALENTO_HUMANO, una alta sin sede
 * queda en la sede del actor).
 */
export function validarGestionUsuario(
  actor: ActorUsuarios,
  objetivoActual: UsuarioObjetivo | null,
  cambios: { rol?: string | null; sedeId?: number | null }
): ResultadoPermiso {
  const rolActor = norm(actor.rol)
  const rolNuevo = cambios.rol === undefined ? undefined : norm(cambios.rol)
  const rolActual = objetivoActual ? norm(objetivoActual.rol) : null

  let sedeFinal: number | null =
    cambios.sedeId !== undefined ? cambios.sedeId : (objetivoActual?.sedeId ?? null)

  // Multi-sede Fase 2: un usuario sin sede no puede operar (403 en todo), así
  // que no se deja crear ni dejar a nadie sin sede. Alta sin sede → la del
  // actor (cualquier rol); quitar la sede en una edición → 422.
  if (objetivoActual && cambios.sedeId === null) {
    return { ok: false, status: 422, message: 'La sede del usuario es obligatoria.' }
  }
  if (!objetivoActual && sedeFinal === null) sedeFinal = actor.sedeId ?? null

  if (rolActor === ROL_SUPER_ADMIN) return { ok: true, sedeId: sedeFinal }

  if (rolActor === ROL_GERENCIA) {
    if (rolActual === ROL_SUPER_ADMIN) {
      return denegado('GERENCIA no puede modificar usuarios SUPER_ADMIN.')
    }
    if (rolNuevo === ROL_SUPER_ADMIN) {
      return denegado('GERENCIA no puede asignar el rol SUPER_ADMIN.')
    }
    return { ok: true, sedeId: sedeFinal }
  }

  if (rolActor === ROL_TALENTO_HUMANO) {
    if (!actor.sedeId) {
      return denegado('Tu usuario no tiene sede asignada. Contacta al administrador.')
    }
    if (rolActual !== null && ROLES_RESERVADOS_TH.has(rolActual)) {
      return denegado('TALENTO_HUMANO no puede modificar usuarios SUPER_ADMIN ni GERENCIA.')
    }
    if (rolNuevo !== undefined && ROLES_RESERVADOS_TH.has(rolNuevo)) {
      return denegado('TALENTO_HUMANO no puede asignar los roles SUPER_ADMIN ni GERENCIA.')
    }
    if (
      objetivoActual &&
      objetivoActual.sedeId !== null &&
      objetivoActual.sedeId !== actor.sedeId
    ) {
      return denegado('Solo puedes gestionar usuarios de tu sede.')
    }
    // Alta sin sede → la del actor.
    if (!objetivoActual && sedeFinal === null) sedeFinal = actor.sedeId
    if (sedeFinal !== null && sedeFinal !== actor.sedeId) {
      return denegado('Solo puedes asignar usuarios a tu sede.')
    }
    return { ok: true, sedeId: sedeFinal }
  }

  return denegado('No tienes permisos para gestionar usuarios.')
}

/**
 * Contratos: el contrato copia su sede al usuario
 * (contratos_controller.copiarCamposContratoEnUsuario), así que es otra vía
 * para cambiar la sede de alguien. Mismas reglas de sede que arriba; los
 * roles no se tocan desde el contrato.
 *
 * - `sedeContrato`: sede final del contrato (la nueva o, si no cambia, la actual).
 * - `sedeContratoActual`: sede del contrato antes de editarlo (null en alta).
 * - `usuario`: dueño del contrato (null si el contrato no tiene usuario).
 */
export function validarSedeContrato(
  actor: ActorUsuarios,
  datos: {
    sedeContrato: number | null
    sedeContratoActual: number | null
    usuario: UsuarioObjetivo | null
  }
): ResultadoPermiso {
  const rolActor = norm(actor.rol)
  const rolUsuario = datos.usuario ? norm(datos.usuario.rol) : null

  if (rolActor === ROL_SUPER_ADMIN) return { ok: true, sedeId: datos.sedeContrato }

  if (rolActor === ROL_GERENCIA) {
    if (rolUsuario === ROL_SUPER_ADMIN) {
      return denegado('GERENCIA no puede modificar contratos de usuarios SUPER_ADMIN.')
    }
    return { ok: true, sedeId: datos.sedeContrato }
  }

  if (rolActor === ROL_TALENTO_HUMANO) {
    if (!actor.sedeId) {
      return denegado('Tu usuario no tiene sede asignada. Contacta al administrador.')
    }
    if (rolUsuario !== null && ROLES_RESERVADOS_TH.has(rolUsuario)) {
      return denegado('TALENTO_HUMANO no puede modificar contratos de SUPER_ADMIN ni GERENCIA.')
    }
    if (datos.usuario && datos.usuario.sedeId !== null && datos.usuario.sedeId !== actor.sedeId) {
      return denegado('Solo puedes gestionar contratos de usuarios de tu sede.')
    }
    if (datos.sedeContratoActual !== null && datos.sedeContratoActual !== actor.sedeId) {
      return denegado('Solo puedes gestionar contratos de tu sede.')
    }
    if (datos.sedeContrato !== null && datos.sedeContrato !== actor.sedeId) {
      return denegado('Solo puedes asignar contratos a tu sede.')
    }
    return { ok: true, sedeId: datos.sedeContrato }
  }

  return denegado('No tienes permisos para gestionar contratos.')
}
