import { BaseSchema } from '@adonisjs/lucid/schema'

export default class AddCancelacionFieldsToTurnosRtms extends BaseSchema {
  protected tableName = 'turnos_rtms'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.text('motivo_cancelacion').nullable()
      table
        .integer('cancelado_por_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('SET NULL')
      table.timestamp('cancelado_at').nullable()
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('motivo_cancelacion')
      table.dropForeign(['cancelado_por_id'])
      table.dropColumn('cancelado_por_id')
      table.dropColumn('cancelado_at')
    })
  }
}
