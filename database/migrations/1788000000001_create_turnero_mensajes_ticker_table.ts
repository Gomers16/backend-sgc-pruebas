import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'turnero_mensajes_ticker'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.string('texto', 500).notNullable()
      table.integer('orden').notNullable().defaultTo(0)
      table.boolean('activo').notNullable().defaultTo(true)

      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
