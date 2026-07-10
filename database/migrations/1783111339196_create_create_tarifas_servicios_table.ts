import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tarifas_servicios'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('servicio_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('servicios')
        .onDelete('CASCADE')

      table.enum('tipo_vehiculo', ['MOTO', 'VEHICULO']).notNullable()

      table.decimal('valor_base', 14, 2).notNullable().defaultTo(0)
      table.decimal('valor_total', 14, 2).notNullable().defaultTo(0)

      table.string('descripcion', 120).nullable()
      table.boolean('activo').notNullable().defaultTo(true)
      table.date('vigencia_desde').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())

      table.unique(['servicio_id', 'tipo_vehiculo'], 'uq_tarifas_servicios_servicio_tipo')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
