// app/services/telemercadeo_origen_service.ts
//
// Origen de un dateo de Telemercadeo (catálogo telemercadeo_origenes) y reglas
// del asesor de Telemercadeo que datea (2026-11-23):
//  - su dateo es siempre canal TELE y a su nombre, mande lo que mande el body;
//  - sin convenio, descuento ni avance;
//  - con gestión, el origen es el de la gestión salvo que elija otro; sin
//    gestión el origen es obligatorio.
//
// El origen se guarda en captacion_dateos.telemercadeo_origen_id (migración
// 1820). La gestión conserva el suyo: si difieren, el cambio queda registrado
// en los dos lados. El catálogo es global (no tiene sede).

import Database from '@adonisjs/lucid/services/db'
import type Usuario from '#models/usuario'
import type AgenteCaptacion from '#models/agente_captacion'
import { agenteTelemercadeoDeUsuario } from '#services/telemercadeo_gestion_service'

/** Roles que eligen agente y canal libremente, aunque tengan agente propio. */
const ROLES_LIBRES = ['SUPER_ADMIN', 'GERENCIA']

/** Agente de Telemercadeo del usuario si debe quedar fijo; null para los demás. */
export async function agenteTeleFijo(user: Usuario): Promise<AgenteCaptacion | null> {
  await user.load('rol')
  if (ROLES_LIBRES.includes((user.rol?.nombre ?? '').toUpperCase())) return null
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

/**
 * Atributos a guardar en el dateo o en el detalle del ticket. Sin la migración
 * y con el origen de la gestión no se escribe (se lee de la gestión).
 */
export async function atributosOrigen(
  origenId: number | null,
  origenGestion: number | null
): Promise<{ telemercadeoOrigenId?: number }> {
  if (origenId === null) return {}
  if (origenId === origenGestion && !(await columnaOrigenDateo())) return {}
  return { telemercadeoOrigenId: origenId }
}
