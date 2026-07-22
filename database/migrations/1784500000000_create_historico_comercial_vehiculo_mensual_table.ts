// database/migrations/1784500000000_create_historico_comercial_vehiculo_mensual_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class HistoricoComercialVehiculoMensuals extends BaseSchema {
  protected tableName = 'historico_comercial_vehiculo_mensual'

  public async up() {
    await this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('asesor_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('CASCADE')

      table.tinyint('mes').unsigned().notNullable()
      table.smallint('anio').unsigned().notNullable()

      table.integer('livianos_convenio').unsigned().notNullable().defaultTo(0)
      table.integer('motos_convenio').unsigned().notNullable().defaultTo(0)
      table.integer('livianos_propio').unsigned().notNullable().defaultTo(0)
      table.integer('motos_propio').unsigned().notNullable().defaultTo(0)

      table.decimal('tarifa_carro', 14, 2).notNullable()
      table.decimal('tarifa_moto', 14, 2).notNullable()

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['asesor_id', 'mes', 'anio'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
