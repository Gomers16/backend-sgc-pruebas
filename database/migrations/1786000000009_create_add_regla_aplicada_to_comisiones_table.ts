import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'comisiones'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Texto de la regla de comision_calculo_service.calcularComision() que
      // determinó el monto de esta comisión (ej. "Caso 1 · Sin convenio ·
      // Nuevo + informativo (INFORMATIVO_POLICIA) → valor_dateo_recurrencia").
      // Antes solo se logueaba en consola (applyCommissionHook) y se perdía —
      // ahora se persiste para poder explicar el resultado en el drill-down
      // de la sección Descuentos del modal Liquidación RTM. Comisiones
      // creadas antes de este cambio quedan con este campo en null.
      table.string('regla_aplicada', 255).nullable().after('descuento_observacion_caja')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('regla_aplicada')
    })
  }
}
