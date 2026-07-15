import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'captacion_dateos'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table
        .integer('aprobado_excepcion_por')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .after('servicio_id')
      table
        .timestamp('aprobado_excepcion_at', { useTz: false })
        .nullable()
        .after('aprobado_excepcion_por')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('aprobado_excepcion_at')
      table.dropColumn('aprobado_excepcion_por')
    })
  }
}
