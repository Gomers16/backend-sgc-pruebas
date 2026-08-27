// database/migrations/1787000000001_create_tickets_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tickets'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('tipo_ticket_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('tipos_ticket')
        .onDelete('RESTRICT')

      table.string('titulo').notNullable()

      table
        .enu('estado', ['PENDIENTE', 'APROBADO', 'RECHAZADO', 'RESUELTO', 'CERRADO'], {
          useNative: true,
          enumName: 'ticket_estado_enum',
        })
        .notNullable()
        .defaultTo('PENDIENTE')

      table
        .integer('creado_por_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('RESTRICT')

      table
        .integer('asignado_a_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('SET NULL')

      table.string('modulo_relacionado').nullable()

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('resuelto_at', { useTz: false }).nullable()
      table.timestamp('cerrado_at', { useTz: false }).nullable()

      table.index(['tipo_ticket_id', 'estado'])
      table.index(['creado_por_id'])
      table.index(['asignado_a_id'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
