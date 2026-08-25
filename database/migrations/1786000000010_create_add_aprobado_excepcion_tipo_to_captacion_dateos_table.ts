import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'captacion_dateos'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.string('aprobado_excepcion_tipo', 30).nullable().after('aprobado_excepcion_at')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('aprobado_excepcion_tipo')
    })
  }
}
