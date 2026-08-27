import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'configuracion_ventana_ticket_asesores'

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
       * Minutos de ventana sin penalización, personalizados para este asesor.
       * NULL = usa el valor global (configuracion_ventana_ticket_global.minutos_ventana)
       */
      table.integer('minutos_ventana').unsigned().nullable()

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['asesor_id'], 'cfg_ventana_ticket_asesor_unique')
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
