// database/migrations/1787000000004_create_saldo_penalizaciones_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'saldo_penalizaciones'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('asesor_id')
        .unsigned()
        .notNullable()
        .unique()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('RESTRICT')

      table.decimal('saldo_actual', 12, 2).notNullable().defaultTo(0)
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
