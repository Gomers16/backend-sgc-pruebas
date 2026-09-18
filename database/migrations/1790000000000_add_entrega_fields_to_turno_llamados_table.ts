import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'turno_llamados'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Exclusivo del flujo Entregar / No se presentó — no toca
      // turnos_rtms.estado ni ninguna otra tabla/lógica existente.
      table.timestamp('entregado_at', { useTz: true }).nullable()
      table.boolean('no_presentado').notNullable().defaultTo(false)
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('entregado_at')
      table.dropColumn('no_presentado')
    })
  }
}
