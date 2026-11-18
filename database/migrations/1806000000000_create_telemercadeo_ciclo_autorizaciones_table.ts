import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Registro de cada seguimiento extra que SUPER_ADMIN/GERENCIA autoriza sobre
 * un ciclo de Telemercadeo (quién, cuándo y motivo obligatorio). Cada fila
 * suma 1 a telemercadeo_ciclos.extras_autorizados.
 */
export default class extends BaseSchema {
  protected tableName = 'telemercadeo_ciclo_autorizaciones'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table
        .integer('ciclo_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('telemercadeo_ciclos')
        .onDelete('CASCADE')
      table
        .integer('usuario_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('RESTRICT')
      table.string('motivo', 500).notNullable()
      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.index(['ciclo_id'], 'idx_tele_autorizacion_ciclo')
    })
  }

  public async down() {
    this.schema.dropTableIfExists(this.tableName)
  }
}
