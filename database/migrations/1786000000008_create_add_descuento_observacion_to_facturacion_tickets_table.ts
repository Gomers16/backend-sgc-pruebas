import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'facturacion_tickets'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Nota dedicada al evento de aplicar el descuento en caja — distinta
      // de `observaciones` (genérica del ticket, ya existente, no se toca).
      table.text('descuento_observacion').nullable().after('descuento_monto_aplicado')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('descuento_observacion')
    })
  }
}
