import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Catálogo de "canal de origen" de una gestión de Telemercadeo (por dónde
 * llegó el cliente). Es una dimensión propia del módulo, distinta del canal
 * de captación del dateo (captacion_dateos.canal) y del "¿Cómo se enteró?"
 * del turno (turnos_rtms.canal_atribucion). Administrable: se siembran los
 * tres orígenes iniciales.
 */
export default class extends BaseSchema {
  protected tableName = 'telemercadeo_origenes'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table.string('codigo', 40).notNullable().unique()
      table.string('nombre', 80).notNullable()
      table.boolean('activo').notNullable().defaultTo(true)
      table.smallint('orden').unsigned().notNullable().defaultTo(0)
      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())
    })

    this.defer(async (db) => {
      await db.table(this.tableName).multiInsert([
        { codigo: 'RECURRENCIA', nombre: 'Recurrencia', activo: true, orden: 1 },
        { codigo: 'GOOGLE_ADS', nombre: 'Google ADS', activo: true, orden: 2 },
        { codigo: 'REDES', nombre: 'Redes sociales', activo: true, orden: 3 },
      ])
    })
  }

  public async down() {
    this.schema.dropTableIfExists(this.tableName)
  }
}
