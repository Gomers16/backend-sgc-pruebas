// database/migrations/1784900001000_add_tipo7_to_informes_discrepancias_rtm_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class AddTipo7ToInformesDiscrepanciasRtm extends BaseSchema {
  protected tableName = 'informes_discrepancias_rtm'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Turnos 'finalizado' en SGC sin ningún rastro en Tecno (ni exacto ni
      // por variación de 1 carácter en la placa). No estaba en los 6 tipos
      // originales — se detectó al validar contra datos reales de producción
      // (2026-08-05): ~37 turnos finalizados de julio no tenían ningún match,
      // caso que antes quedaba invisible (tipo3 solo cubre turnos 'activo').
      table
        .integer('total_tipo7_finalizado_sin_rastro_tecno')
        .unsigned()
        .notNullable()
        .defaultTo(0)
        .after('total_tipo6_alerta_cobro_no_registrado')
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('total_tipo7_finalizado_sin_rastro_tecno')
    })
  }
}
