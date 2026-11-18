import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Configuración global de seguimientos de Telemercadeo (mismo patrón que
 * configuracion_redateo_global). Fila única; si no existe, el servicio la
 * crea con los valores por defecto.
 *  - max_seguimientos: gestiones máximas por ciclo (default 3).
 *  - dias_vigencia_ciclo: días sin gestiones tras los cuales el ciclo vence
 *    y la siguiente gestión abre uno nuevo (default 30).
 */
export default class extends BaseSchema {
  protected tableName = 'configuracion_seguimiento_tele_global'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table.integer('max_seguimientos').unsigned().notNullable().defaultTo(3)
      table.integer('dias_vigencia_ciclo').unsigned().notNullable().defaultTo(30)
      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())
    })
  }

  public async down() {
    this.schema.dropTableIfExists(this.tableName)
  }
}
