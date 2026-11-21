/*
|--------------------------------------------------------------------------
| HTTP kernel file
|--------------------------------------------------------------------------
|
| El archivo HTTP kernel registra los middleware globales y de rutas.
|
*/

import router from '@adonisjs/core/services/router'
import server from '@adonisjs/core/services/server'

/**
 * El error handler convierte excepciones en respuestas HTTP.
 */
server.errorHandler(() => import('#exceptions/handler'))

/**
 * Middleware global: se ejecutan en TODAS las peticiones,
 * incluso si no existe una ruta registrada.
 */
server.use([
  () => import('#middleware/container_bindings_middleware'),
  () => import('#middleware/force_json_response_middleware'),
  () => import('@adonisjs/cors/cors_middleware'), // ✅ este sí usa config/cors.ts
])

/**
 * Middleware de rutas: se ejecutan solo en rutas registradas.
 */
router.use([
  () => import('@adonisjs/core/bodyparser_middleware'),
  () => import('@adonisjs/auth/initialize_auth_middleware'),
])

/**
 * Middleware nombrados: se asignan explícitamente en rutas/grupos.
 */
export const middleware = router.named({
  checkRole: () => import('#middleware/check_role_middleware'),
  guest: () => import('#middleware/guest_middleware'),
  auth: () => import('#middleware/auth_middleware'),
  // Multi-sede: auth ya lo invoca; queda nombrado para usos explícitos.
  sedeActiva: () => import('#middleware/sede_activa_middleware'),
  // Multi-sede: usuarios/contratos de otra sede → 404 (rutas de Talento Humano).
  registroEnSede: () => import('#middleware/registro_en_sede_middleware'),
})
