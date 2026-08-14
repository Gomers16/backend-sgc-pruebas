import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'configuracion_redateo_global'

  public async up() {
    await this.schema.dropTableIfExists(this.tableName)

    await this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      /**
       * Máximo de veces que un mismo dateo puede re-datearse (fallback
       * cuando no hay override específico por asesor).
       * Por defecto: 3
       */
      table.integer('max_redateos').unsigned().notNullable().defaultTo(3)

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())
    })

    // Registro inicial con el valor por defecto
    await this.db.table(this.tableName).insert({
      max_redateos: 3,
      created_at: this.now(),
      updated_at: this.now(),
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
