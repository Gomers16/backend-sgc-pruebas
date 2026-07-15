// database/migrations/1784044122000_create_configuracion_reserva_dateos_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class ConfiguracionReservaDateos extends BaseSchema {
  protected tableName = 'configuracion_reserva_dateos'

  public async up() {
    await this.schema.dropTableIfExists(this.tableName)

    await this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      /**
       * Horas de exclusividad de un dateo sobre una placa/teléfono antes de
       * ser consumido por un turno: mientras esté vigente, otro asesor no
       * puede datear la misma placa/teléfono (bloqueo 409).
       * Por defecto: 60 (reemplaza TTL_SIN_CONSUMIR_DIAS=7 días = 168h)
       */
      table.integer('horas_exclusividad').unsigned().notNullable().defaultTo(60)

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())
    })

    // Registro inicial con el valor por defecto
    await this.db.table(this.tableName).insert({
      horas_exclusividad: 60,
      created_at: this.now(),
      updated_at: this.now(),
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
