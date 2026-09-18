import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'turnero_multimedia'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table.enum('tipo', ['imagen', 'video']).notNullable()
      table.string('url', 500).notNullable()
      // Solo aplica a imágenes: un video usa su duración natural (ver
      // PanelPublicidad.vue, que avanza por el evento `ended`, no por timer).
      table.integer('duracion_segundos').unsigned().nullable()
      table.integer('orden').notNullable().defaultTo(0)
      table.boolean('activo').notNullable().defaultTo(true)

      table.timestamp('created_at')
      table.timestamp('updated_at')
    })
  }

  async down() {
    this.schema.dropTable(this.tableName)
  }
}
