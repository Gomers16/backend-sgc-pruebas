// app/services/ticket_acceso_service.ts
//
// Quién puede ver/comentar un ticket interno y validación de las URLs de
// evidencia. Única fuente de verdad para tickets_controller.ts y
// tickets_excepcion_dateo_controller.ts.

import * as fs from 'node:fs'
import app from '@adonisjs/core/services/app'
import type Ticket from '#models/ticket'
import type Usuario from '#models/usuario'

/** Roles que ven y resuelven todos los tickets (además de roles_resuelve del tipo). */
export const ROLES_RESOLUTORES_TICKET = ['SUPER_ADMIN', 'GERENCIA'] as const

async function rolDe(usuario: Usuario): Promise<string> {
  if (!usuario.rol) await usuario.load('rol')
  return (usuario.rol?.nombre ?? '').toUpperCase()
}

/**
 * ¿El usuario puede ver (y comentar) el ticket?
 *  - quien lo creó,
 *  - el comercial del ticket (agentes_captacions.usuario_id del comercial_id
 *    del detalle, p. ej. cuando gerencia lo creó a su nombre),
 *  - un rol resolutor (SUPER_ADMIN/GERENCIA, o roles_resuelve del tipo).
 */
export async function puedeVerTicket(ticket: Ticket, usuario: Usuario): Promise<boolean> {
  if (ticket.creadoPorId === usuario.id) return true

  const rol = await rolDe(usuario)
  if ((ROLES_RESOLUTORES_TICKET as readonly string[]).includes(rol)) return true

  if (!ticket.tipoTicket) await ticket.load('tipoTicket')
  const rolesResuelve = (ticket.tipoTicket?.rolesResuelve ?? []).map((r) => String(r).toUpperCase())
  if (rolesResuelve.includes(rol)) return true

  const { default: Database } = await import('@adonisjs/lucid/services/db')
  const comercialDelTicket = await Database.from('tickets_detalle_excepcion_dateo as d')
    .join('agentes_captacions as a', 'a.id', 'd.comercial_id')
    .where('d.ticket_id', ticket.id)
    .where('a.usuario_id', usuario.id)
    .first()
  return !!comercialDelTicket
}

/**
 * URL devuelta por POST /api/media/upload para una imagen:
 * /api/uploads/dateos/AAAA/MM/<cuid>.<ext> (ver uploads_controller.ts).
 */
const RUTA_EVIDENCIA =
  /^\/api\/uploads\/dateos\/(\d{4})\/(\d{2})\/([a-z0-9]+\.(?:jpg|jpeg|png|webp|heic|heif))$/i

/** ¿La URL es una imagen subida por /media/upload y el archivo existe en disco? */
export function esEvidenciaValida(url: string | null | undefined): boolean {
  if (!url) return false
  const m = RUTA_EVIDENCIA.exec(url)
  if (!m) return false
  const [, anio, mes, archivo] = m
  return fs.existsSync(app.makePath('uploads', 'dateos', anio, mes, archivo))
}
