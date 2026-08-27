import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'configuracion_ventana_ticket_global'

  public async up() {
    await this.schema.dropTableIfExists(this.tableName)

    await this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      /**
       * Minutos desde turno.horaIngreso dentro de los cuales un ticket de
       * "Excepción de Dateo" no lleva penalización (fallback cuando no hay
       * override específico por asesor).
       * Por defecto: 60
       */
      table.integer('minutos_ventana').unsigned().notNullable().defaultTo(60)

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())
    })

    // Registro inicial con el valor por defecto
    await this.db.table(this.tableName).insert({
      minutos_ventana: 60,
      created_at: this.now(),
      updated_at: this.now(),
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
