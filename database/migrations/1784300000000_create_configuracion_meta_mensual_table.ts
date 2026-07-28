// database/migrations/1784300000000_create_configuracion_meta_mensual_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class ConfiguracionMetaMensuals extends BaseSchema {
  protected tableName = 'configuracion_meta_mensual'

  public async up() {
    await this.schema.dropTableIfExists(this.tableName)

    await this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table.tinyint('mes').unsigned().notNullable()
      table.smallint('anio').unsigned().notNullable()

      /**
       * Meta mensual de turnos RTM finalizados, separada por tipo de
       * vehículo. Ej: 900 livianos + 500 motos = 1400 total.
       */
      table.integer('meta_livianos').unsigned().notNullable().defaultTo(0)
      table.integer('meta_motos').unsigned().notNullable().defaultTo(0)

      /**
       * % de crecimiento de referencia usado en el comparativo contra el
       * mismo mes del año anterior cuando no hay dato real/histórico
       * suficiente. Ej: 10.00 = +10%
       *
       */
      table.decimal('pct_crecimiento_referencia', 5, 2).notNullable().defaultTo(0)

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['mes', 'anio'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
