// app/middleware/registro_en_sede_middleware.ts
//
// Multi-sede — Talento Humano por sede: usuarios y contratos de otra sede no
// se ven ni se tocan por id (404, igual que el mixin SedeScoped).
//
// Usuario y Contrato no llevan el mixin (identidad, login y muchos joins de
// nombres los leen sin contexto), así que la regla va en las rutas de
// gestión. Se compara contra las sedes visibles del request
// (ctx.sedeScope.sedeIds: la propia, la elegida por SA/GER o "todas").
// El propio usuario (y sus contratos) siempre es visible.
//
// Uso: middleware.registroEnSede({ tipo: 'usuario' | 'contrato', param: 'id' })

import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import db from '@adonisjs/lucid/services/db'

type Opciones = { tipo: 'usuario' | 'contrato'; param: string }

/** Sedes visibles del request; null = sin contexto (no filtra). */
function sedesVisibles(ctx: HttpContext): number[] | null {
  return ctx.sedeScope ? ctx.sedeScope.sedeIds : null
}

/**
 * ¿El registro es visible en las sedes del request? Sede NULL (no debería
 * quedar ninguna tras el backfill) solo la ve quien puede cambiar de sede.
 */
export async function registroVisibleEnSede(
  ctx: HttpContext,
  tipo: Opciones['tipo'],
  id: number
): Promise<boolean> {
  const sedes = sedesVisibles(ctx)
  if (!sedes) return true
  const yo = ctx.auth.user?.id ?? null
  const fila =
    tipo === 'usuario'
      ? // sede: lectura por id para decidir la visibilidad (es el filtro de sede)
        await db.from('usuarios').where('id', id).select('id as usuario_id', 'sede_id').first()
      : // sede: lectura por id para decidir la visibilidad (es el filtro de sede)
        await db.from('contratos').where('id', id).select('usuario_id', 'sede_id').first()
  if (!fila) return true // que el controlador responda su propio 404
  if (yo !== null && Number(fila.usuario_id) === yo) return true
  if (fila.sede_id === null) return ctx.sedeScope?.puedeCambiarSede === true
  return sedes.includes(Number(fila.sede_id))
}

export default class RegistroEnSedeMiddleware {
  async handle(ctx: HttpContext, next: NextFn, opciones: Opciones) {
    const id = Number(ctx.params[opciones.param])
    if (Number.isInteger(id) && id > 0) {
      if (!(await registroVisibleEnSede(ctx, opciones.tipo, id))) {
        const que = opciones.tipo === 'usuario' ? 'Usuario' : 'Contrato'
        return ctx.response.notFound({ message: `${que} no encontrado` })
      }
    }
    return next()
  }
}
