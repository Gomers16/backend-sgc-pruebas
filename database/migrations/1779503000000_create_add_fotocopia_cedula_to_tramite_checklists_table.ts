import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tramite_checklists'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.boolean('fotocopia_cedula').notNullable().defaultTo(false)
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('fotocopia_cedula')
    })
  }
}
