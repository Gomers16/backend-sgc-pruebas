import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'configuracion_redateo_asesores'

  public async up() {
    await this.schema.dropTableIfExists(this.tableName)

    await this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      /**
       * Asesor al que aplica este override
       */
      table
        .integer('asesor_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('CASCADE')

      /**
       * Máximo de re-dateos personalizado para este asesor.
       * NULL = usa el valor global (configuracion_redateo_global.max_redateos)
       */
      table.integer('max_redateos').unsigned().nullable()

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['asesor_id'], 'cfg_redateo_asesor_unique')
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
