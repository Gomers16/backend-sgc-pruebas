// app/services/telemercadeo_origen_service.ts
//
// Origen de un dateo de Telemercadeo (catálogo telemercadeo_origenes) y reglas
// del asesor de Telemercadeo que datea (2026-11-23):
//  - solo datea desde una gestión suya (sin ella, 400 TELE_REQUIERE_GESTION),
//    siempre canal TELE y a su nombre, mande lo que mande el body;
//  - sin convenio, descuento ni avance;
//  - el origen es el de la gestión salvo que elija otro.
// SUPER_ADMIN/GERENCIA con canal TELE: origen obligatorio, lo demás igual.
// Ticket TELE (gestión, agente de Telemercadeo o canal TELE): sin convenio,
// origen obligatorio y canal TELE.
//
// El origen se guarda en captacion_dateos.telemercadeo_origen_id (migración
// 1820). La gestión conserva el suyo: si difieren, el cambio queda registrado
// en los dos lados. El catálogo es global (no tiene sede).

import { Exception } from '@adonisjs/core/exceptions'
import Database from '@adonisjs/lucid/services/db'
import type Usuario from '#models/usuario'
import type AgenteCaptacion from '#models/agente_captacion'
import { agenteTelemercadeoDeUsuario } from '#services/telemercadeo_gestion_service'

/** Roles que eligen agente y canal libremente, aunque tengan agente propio. */
const ROLES_LIBRES = ['SUPER_ADMIN', 'GERENCIA']

/** ¿SUPER_ADMIN o GERENCIA? */
export async function esRolLibre(user: Usuario): Promise<boolean> {
  await user.load('rol')
  return ROLES_LIBRES.includes((user.rol?.nombre ?? '').toUpperCase())
}

/** Agente de Telemercadeo del usuario si debe quedar fijo; null para los demás. */
export async function agenteTeleFijo(user: Usuario): Promise<AgenteCaptacion | null> {
  if (await esRolLibre(user)) return null
  return agenteTelemercadeoDeUsuario(user.id)
}

type ResultadoOrigen =
  | { ok: true; origenId: number | null }
  | { ok: false; status: 400; body: { code: string; message: string } }

/**
 * Origen del dateo. `raw` es lo que mandó el cliente; `origenGestion` el de la
 * gestión (null sin gestión). Igual al de la gestión se acepta aunque ya esté
 * inactivo en el catálogo; cualquier otro tiene que existir y estar activo.
 */
export async function resolverOrigenDateo(
  raw: unknown,
  origenGestion: number | null
): Promise<ResultadoOrigen> {
  if (raw === undefined || raw === null || raw === '') {
    if (origenGestion !== null) return { ok: true, origenId: origenGestion }
    return {
      ok: false,
      status: 400,
      body: { code: 'ORIGEN_REQUERIDO', message: 'Elige el origen del dateo.' },
    }
  }
  const id = Number(raw)
  if (Number.isInteger(id) && id === origenGestion) return { ok: true, origenId: id }
  const fila =
    Number.isInteger(id) && id > 0
      ? await Database.from('telemercadeo_origenes').where('id', id).first()
      : null
  if (!fila || !fila.activo) {
    return {
      ok: false,
      status: 400,
      body: { code: 'ORIGEN_INVALIDO', message: 'El origen no existe o está inactivo.' },
    }
  }
  return { ok: true, origenId: id }
}

let columnaVista = false
/**
 * ¿Está aplicada la migración 1820? Mientras no lo esté, el origen de la
 * gestión sigue siendo la única fuente y nada se rompe. Solo se recuerda el sí.
 */
export async function columnaOrigenDateo(): Promise<boolean> {
  if (columnaVista) return true
  const r = await Database.rawQuery(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND column_name = 'telemercadeo_origen_id'
        AND table_name IN ('captacion_dateos', 'tickets_detalle_excepcion_dateo')`
  )
  columnaVista = Number(r[0][0].n) === 2
  return columnaVista
}

/** Falta una migración: respuesta clara (503) en vez de un error de SQL. */
export class MigracionPendienteError extends Exception {
  constructor(migracion: string) {
    super(`Falta aplicar la migración ${migracion} en la base de datos.`, {
      status: 503,
      code: 'MIGRACION_PENDIENTE',
    })
  }
}

/** Ticket desde una gestión: necesita la columna de la migración 1819. */
export async function exigirColumnaGestionTicket(): Promise<void> {
  const r = await Database.rawQuery(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'tickets_detalle_excepcion_dateo'
        AND column_name = 'telemercadeo_gestion_id'`
  )
  if (!Number(r[0][0].n)) throw new MigracionPendienteError('1819')
}

/**
 * Atributos a guardar en el dateo o en el detalle del ticket. Sin la migración
 * 1820: con el origen de la gestión no se escribe (se lee de la gestión); con
 * otro no hay dónde guardarlo y responde 503 sin crear nada.
 */
export async function atributosOrigen(
  origenId: number | null,
  origenGestion: number | null
): Promise<{ telemercadeoOrigenId?: number }> {
  if (origenId === null) return {}
  if (!(await columnaOrigenDateo())) {
    if (origenId === origenGestion) return {}
    throw new MigracionPendienteError('1820')
  }
  return { telemercadeoOrigenId: origenId }
}
