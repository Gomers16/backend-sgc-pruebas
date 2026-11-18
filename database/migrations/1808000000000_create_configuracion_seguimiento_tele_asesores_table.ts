import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Override por asesor del máximo de seguimientos de Telemercadeo (mismo
 * patrón que configuracion_redateo_asesores). max_seguimientos NULL = usa
 * el valor global.
 */
export default class extends BaseSchema {
  protected tableName = 'configuracion_seguimiento_tele_asesores'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table
        .integer('asesor_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('CASCADE')
      table.integer('max_seguimientos').unsigned().nullable()
      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['asesor_id'], { indexName: 'cfg_seguimiento_tele_asesor_unique' })
    })
  }

  public async down() {
    this.schema.dropTableIfExists(this.tableName)
  }
}
