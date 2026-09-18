import env from '#start/env'
import { defineConfig } from '@adonisjs/lucid'

const dbConfig = defineConfig({
  connection: 'mysql',
  connections: {
    mysql: {
      client: 'mysql2',
      connection: {
        host: env.get('DB_HOST'),
        port: env.get('DB_PORT'),
        user: env.get('DB_USER'),
        password: env.get('DB_PASSWORD'),
        database: env.get('DB_DATABASE'),
        timezone: '-05:00',
        // Explícito en vez de confiar en el default del driver mysql2:
        // hoy ya negocia utf8mb4 igual, pero declararlo endurece la conexión
        // contra un cambio de default en una futura versión del driver.
        charset: 'utf8mb4',
      },
      migrations: {
        naturalSort: true,
        paths: ['database/migrations'],
      },
    },
  },
})

export default dbConfig
