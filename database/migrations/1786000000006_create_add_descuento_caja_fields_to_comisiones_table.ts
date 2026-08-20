import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'comisiones'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Código real del descuento aplicado en caja al confirmar el ticket
      // (o el pasado en POST /comisiones manual) — snapshot, no se recalcula.
      table.string('descuento_codigo_aplicado', 100).nullable().after('descuento_monto_aplicado')

      // Nota libre de la cajera sobre por qué se aplicó ese descuento,
      // copiada desde facturacion_tickets.descuento_observacion.
      table.text('descuento_observacion_caja').nullable().after('descuento_codigo_aplicado')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('descuento_observacion_caja')
      table.dropColumn('descuento_codigo_aplicado')
    })
  }
}
