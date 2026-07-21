// database/migrations/1784400000000_create_meta_comercial_asesor_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class MetaComercialAsesors extends BaseSchema {
  protected tableName = 'meta_comercial_asesor'

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

      // Meta total en pesos por asesor/mes (cifra única, no partida en
      // convenio/propio — así viene el dato fuente).
      table.decimal('meta_pesos', 14, 2).notNullable().defaultTo(0)

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['asesor_id', 'mes', 'anio'])
      table.index(['mes', 'anio'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
