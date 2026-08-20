import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'captacion_dateos'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Snapshot de "lo que realmente pasó en caja" — NUNCA sobrescribe
      // descuento_id (el pre-marcado original del asesor). Se escribe una
      // sola vez desde applyCommissionHook()/comisiones_controller::store().
      table
        .integer('descuento_caja_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('descuentos')
        .onDelete('SET NULL')
        .after('descuento_id')

      table.text('descuento_caja_observacion').nullable().after('descuento_caja_id')

      table
        .timestamp('descuento_caja_aplicado_at', { useTz: false })
        .nullable()
        .after('descuento_caja_observacion')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('descuento_caja_aplicado_at')
      table.dropColumn('descuento_caja_observacion')
      table.dropColumn('descuento_caja_id')
    })
  }
}
