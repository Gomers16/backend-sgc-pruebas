import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'captacion_dateo_redateos'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('captacion_dateo_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('captacion_dateos')
        .onDelete('CASCADE')

      // Snapshot histórico: 1, 2, 3... — coincide con numero_redateos_usados
      // del dateo padre en el momento en que se creó esta fila.
      table.integer('numero_redateo').unsigned().notNullable()

      table.string('evidencia_url', 512).notNullable()

      // Asesor dueño del dateo en el momento del re-dateo (puede diferir del
      // agente_id actual del dateo si éste se reasigna después).
      table
        .integer('agente_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('SET NULL')

      // Usuario autenticado que ejecutó la acción (puede ser SUPER_ADMIN/GERENCIA
      // actuando en nombre del asesor).
      table
        .integer('usuario_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('SET NULL')

      table.text('observacion').nullable()

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.index(['captacion_dateo_id'])
      table.index(['agente_id'])
      table.index(['created_at'])
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
