// app/controllers/auth_controller.ts

import type { HttpContext } from '@adonisjs/core/http'
import Usuario from '#models/usuario'
import hash from '@adonisjs/core/services/hash'

export default class AuthController {
  resetPassword(_ctx: HttpContext): any {
    throw new Error('Method not implemented.')
  }
  forgotPassword(_ctx: HttpContext): any {
    throw new Error('Method not implemented.')
  }
  public async login({ request, response }: HttpContext) {
    const { correo, password } = request.only(['correo', 'password'])

    try {
      const user = await Usuario.query()
        .where('correo', correo)
        .preload('rol')
        .preload('agenteCaptacion')
        .firstOrFail()

      const cleanedPassword = typeof password === 'string' ? password.trim() : ''
      const isPasswordValid = await hash.verify(user.password, cleanedPassword)

      if (!isPasswordValid) {
        return response.unauthorized({ message: 'Correo o contraseña inválidos' })
      }

      // 🔥 Crear token
      const token = await Usuario.accessTokens.create(user)

      // 🔥 Preparar datos del usuario
      const userData = user.serialize()
      userData.profilePictureUrl = user.fotoPerfil
      userData.agenteId = user.agenteCaptacion?.id ?? null
      userData.agenteTipo = user.agenteCaptacion?.tipo ?? null

      // 🔥 RESPUESTA CORRECTA
      return response.ok({
        type: 'bearer',
        token: token.value!.release(), // Token completo con prefijo oat_
        user: userData,
      })
    } catch (error: any) {
      console.error('❌ Error en login:', error)

      if (error.code === 'E_ROW_NOT_FOUND') {
        return response.unauthorized({ message: 'Correo o contraseña inválidos' })
      }

      return response.internalServerError({
        message: 'Error interno del servidor',
      })
    }
  }

  public async me({ auth, response }: HttpContext) {
    try {
      if (!auth.user) {
        return response.unauthorized({ message: 'No autenticado' })
      }

      const user = await Usuario.query()
        .where('id', auth.user.id)
        .preload('rol')
        .preload('agenteCaptacion')
        .firstOrFail()

      const userData = user.serialize()
      userData.agenteId = user.agenteCaptacion?.id ?? null
      userData.agenteTipo = user.agenteCaptacion?.tipo ?? null

      return response.ok({
        user: userData,
      })
    } catch (error: any) {
      console.error('❌ Error en /me:', error)
      return response.unauthorized({ message: 'No autenticado' })
    }
  }

  public async logout({ auth, response }: HttpContext) {
    try {
      const user = auth.getUserOrFail()
      const token = auth.user?.currentAccessToken

      if (token) {
        await Usuario.accessTokens.delete(user, token.identifier)
      }

      return response.ok({ message: 'Sesión cerrada exitosamente' })
    } catch (error: any) {
      console.error('❌ Error en logout:', error)
      return response.internalServerError({ message: 'Error al cerrar sesión' })
    }
  }
}
