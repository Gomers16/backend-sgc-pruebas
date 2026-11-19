// app/middleware/auth_middleware.ts

import type { HttpContext } from '@adonisjs/core/http'
import type { NextFn } from '@adonisjs/core/types/http'
import type { Authenticators } from '@adonisjs/auth/types'
import db from '@adonisjs/lucid/services/db'
import { aplicarSedeActiva } from '#middleware/sede_activa_middleware'

/**
 * Auth middleware con manejo robusto de errores JSON para MySQL
 */
export default class AuthMiddleware {
  redirectTo = '/login'

  async handle(
    ctx: HttpContext,
    next: NextFn,
    options: {
      guards?: (keyof Authenticators)[]
      /** Multi-sede: deja pasar a un usuario sin sede (solo /auth/me). */
      sedeOpcional?: boolean
    } = {}
  ) {
    try {
      await ctx.auth.authenticateUsing(options.guards, { loginRoute: this.redirectTo })
    } catch (error: any) {
      return this.responderError(ctx, error)
    }
    // Multi-sede Fase 2: todo request autenticado resuelve su sede activa.
    if (!(await aplicarSedeActiva(ctx, { sedeOpcional: options.sedeOpcional }))) return
    return next()
  }

  private async responderError(ctx: HttpContext, error: any) {
    {
      // 🔥 Detectar errores específicos de JSON corrupto
      const isJsonError =
        error.message?.includes('Unexpected end of JSON input') ||
        error.message?.includes('JSON.parse') ||
        error.message?.includes('SyntaxError')

      if (isJsonError) {
        console.error('❌ Token con JSON corrupto detectado')

        // Intentar limpiar el token corrupto
        try {
          const authHeader = ctx.request.header('Authorization')
          if (authHeader) {
            const tokenValue = authHeader.replace('Bearer ', '').replace('oat_', '').trim()

            // Eliminar tokens corruptos de este hash
            await db
              .from('auth_access_tokens')
              .where('hash', 'like', `%${tokenValue.substring(0, 15)}%`)
              .delete()

            console.log('✅ Token corrupto eliminado de BD')
          }
        } catch (cleanupError: any) {
          console.error('⚠️ Error al limpiar token:', cleanupError.message)
        }

        // Responder con error específico
        return ctx.response.unauthorized({
          message: 'Token inválido. Por favor, inicia sesión nuevamente.',
          code: 'INVALID_TOKEN',
          details: 'Token corrupto detectado y eliminado',
        })
      }

      // Otros errores de autenticación
      console.error('❌ Error de autenticación:', error.message)

      return ctx.response.unauthorized({
        message: 'No autenticado',
        code: 'UNAUTHENTICATED',
      })
    }
  }
}
