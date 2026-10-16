import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Foto del valor calculado de la comisión (monto_asesor / monto_convenio que
 * dio calcularComision() ANTES de forzar a $0) cuando gerencia aprobó con
 * alguna decisión de "sin comisión". Sirve para el "dejado de pagar" exacto
 * de las estadísticas. Se escribe en aprobar() (camino directo) y en
 * applyCommissionHook() (camino diferido). NULL = no hubo "sin comisión", o
 * ticket anterior / aprobado por producción local (se estima).
 */
export default class extends BaseSchema {
  protected tableName = 'tickets_detalle_excepcion_dateo'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.decimal('monto_asesor_calculado', 12, 2).nullable()
      table.decimal('monto_convenio_calculado', 12, 2).nullable()
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('monto_asesor_calculado')
      table.dropColumn('monto_convenio_calculado')
    })
  }
}
