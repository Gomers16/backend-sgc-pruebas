// app/middleware/sede_activa_middleware.ts
//
// Multi-sede Fase 2 — resuelve la sede activa del request y la deja en
// ctx.sedeScope (ver app/services/sede_scope.ts para la regla).
//
// Corre SIEMPRE después de autenticar: AuthMiddleware lo invoca al terminar,
// así ningún endpoint autenticado queda sin sede por olvido.
//  - Usuario sin sede → 403 (salvo rutas con sedeOpcional, p. ej. /auth/me).
//  - X-Sede-Id solo cuenta para SUPER_ADMIN / GERENCIA; los demás roles la
//    ignoran.
//  - "todas" solo para lecturas: POST/PUT/PATCH/DELETE con "todas" → 400.
//  - El sede_id que venga en el body de un registro operativo NO decide su
//    sede: el mixin SedeScoped lo pisa con la sede activa al crear.

import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import db from '@adonisjs/lucid/services/db'
import { CABECERA_SEDE, resolverSedeActiva } from '#services/sede_scope'

const METODOS_LECTURA = new Set(['GET', 'HEAD', 'OPTIONS'])
const TTL_MS = 60_000

let cache: { ids: number[]; hasta: number } | null = null

/** Ids de sedes activas (cache de 60 s; las sedes casi nunca cambian). */
export async function sedesActivas(): Promise<number[]> {
  if (cache && cache.hasta > Date.now()) return cache.ids
  const rows = (await db.from('sedes').where('activo', 1).select('id')) as { id: number }[]
  cache = { ids: rows.map((r) => Number(r.id)), hasta: Date.now() + TTL_MS }
  return cache.ids
}

export function invalidarCacheSedes() {
  cache = null
}

/**
 * Resuelve y guarda el scope. Devuelve true si el request puede seguir; si
 * no, ya respondió (400/403).
 */
export async function aplicarSedeActiva(
  ctx: HttpContext,
  opciones: { sedeOpcional?: boolean } = {}
): Promise<boolean> {
  const usuario = ctx.auth.user
  if (!usuario) return true // sin usuario, auth ya respondió
  if (!usuario.$preloaded.rol) await usuario.load('rol')
  const rol = (usuario as any).rol?.nombre ?? null

  const res = resolverSedeActiva({
    rol,
    sedeUsuario: usuario.sedeId ?? null,
    cabecera: ctx.request.header(CABECERA_SEDE) ?? null,
    sedesActivas: await sedesActivas(),
  })

  if (!res.ok) {
    if (opciones.sedeOpcional && res.status === 403) {
      ctx.sedeScope = null
      return true
    }
    ctx.response.status(res.status).send({ message: res.message, code: 'E_SEDE_SCOPE' })
    return false
  }

  if (res.scope.todas && !METODOS_LECTURA.has(ctx.request.method().toUpperCase())) {
    ctx.response.badRequest({
      message: 'Para operar debes elegir una sede concreta (no "todas").',
      code: 'E_SEDE_SCOPE',
    })
    return false
  }

  ctx.sedeScope = res.scope
  return true
}

/** Uso directo como middleware (además de la invocación desde AuthMiddleware). */
export default class SedeActivaMiddleware {
  async handle(ctx: HttpContext, next: NextFn, options: { sedeOpcional?: boolean } = {}) {
    if (!(await aplicarSedeActiva(ctx, options))) return
    return next()
  }
}
