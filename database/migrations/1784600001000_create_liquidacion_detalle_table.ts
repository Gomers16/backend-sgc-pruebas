// database/migrations/1784600001000_create_liquidacion_detalle_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'liquidacion_detalle'

  public async up() {
    await this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('liquidacion_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('liquidaciones')
        .onDelete('CASCADE')

      table
        .integer('comision_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('comisiones')
        .onDelete('CASCADE')

      // Snapshot del monto pagado de esta comisión al momento del pago
      // (monto_asesor + monto_convenio), por si el monto de la comisión
      // cambiara después — registro histórico/contable inmutable.
      table.decimal('monto', 12, 2).notNullable().defaultTo(0)

      table.index(['liquidacion_id'])
      table.index(['comision_id'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
