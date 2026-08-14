import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'captacion_dateos'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table
        .integer('numero_redateos_usados')
        .unsigned()
        .notNullable()
        .defaultTo(0)
        .after('aprobado_excepcion_at')

      table.timestamp('redateado_at', { useTz: false }).nullable().after('numero_redateos_usados')

      table.boolean('limite_alcanzado').notNullable().defaultTo(false).after('redateado_at')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('limite_alcanzado')
      table.dropColumn('redateado_at')
      table.dropColumn('numero_redateos_usados')
    })
  }
}
