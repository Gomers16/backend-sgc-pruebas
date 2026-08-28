// database/migrations/1787000000012_replace_porcentaje_penalizacion_with_con_comision.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tickets_detalle_excepcion_dateo'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('porcentaje_penalizacion')
      // null mientras el ticket está PENDIENTE; se llena al aprobar (true/false
      // solo cuando el ticket queda fuera de ventana — dentro de ventana la
      // comisión siempre es completa, sin decisión de gerencia, queda null).
      table.boolean('con_comision').nullable()
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('con_comision')
      table.decimal('porcentaje_penalizacion', 5, 2).nullable()
    })
  }
}
