import env from '#start/env'
import app from '@adonisjs/core/services/app'
import { Secret } from '@adonisjs/core/helpers'
import { defineConfig } from '@adonisjs/core/http'

/**
 * The app key is used for encrypting cookies, generating signed URLs,
 * and by the "encryption" module.
 */
export const appKey = new Secret(env.get('APP_KEY'))

/**
 * The configuration settings used by the HTTP server
 */
export const http = defineConfig({
  generateRequestId: true,
  allowMethodSpoofing: false,

  /**
   * 🔥 CONFIGURACIÓN DEL SERVIDOR
   */
  //  host: env.get('HOST', '0.0.0.0'),
  //  port: env.get('PORT', 3333),

  /**
   * Enabling async local storage will let you access HTTP context
   * from anywhere inside your application.
   */
  // Multi-sede Fase 2: las consultas leen la sede activa del request vía
  // HttpContext.get() (app/services/sede_scope.ts).
  useAsyncLocalStorage: true,

  /**
   * Manage cookies configuration. The settings for the session id cookie are
   * defined inside the "config/session.ts" file.
   */
  cookie: {
    domain: '',
    path: '/',
    maxAge: '2h',
    httpOnly: true,
    secure: app.inProduction,
    sameSite: 'lax',
  },
})
