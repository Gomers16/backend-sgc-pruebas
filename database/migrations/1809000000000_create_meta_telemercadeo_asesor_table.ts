import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Metas mensuales de Telemercadeo por asesor (sin pesos). Las tres métricas
 * son opcionales: NULL = meta no definida (sin semáforo para esa métrica,
 * nunca 0%). Tabla separada de meta_comercial_asesor para no mezclar a los
 * asesores de Telemercadeo en los reportes de meta comercial.
 */
export default class extends BaseSchema {
  protected tableName = 'meta_telemercadeo_asesor'

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
      table.tinyint('mes').unsigned().notNullable()
      table.smallint('anio').unsigned().notNullable()
      table.integer('meta_gestiones').unsigned().nullable()
      table.integer('meta_dateos').unsigned().nullable()
      table.integer('meta_exitosos').unsigned().nullable()
      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['asesor_id', 'mes', 'anio'], { indexName: 'uq_meta_tele_asesor_mes' })
      table.index(['mes', 'anio'], 'idx_meta_tele_mes')
    })
  }

  public async down() {
    this.schema.dropTableIfExists(this.tableName)
  }
}
