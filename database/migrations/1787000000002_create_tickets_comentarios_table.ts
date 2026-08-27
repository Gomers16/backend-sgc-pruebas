// database/migrations/1787000000002_create_tickets_comentarios_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tickets_comentarios'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('ticket_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('tickets')
        .onDelete('CASCADE')

      table
        .integer('usuario_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('RESTRICT')

      table.text('mensaje').notNullable()

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.index(['ticket_id'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
