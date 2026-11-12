import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Trazabilidad de WINDOW_BLOCK_CONFIRMABLE (turnos RTM): cuando el operador
 * crea un turno RTM antes de la ventana previa al vencimiento de la RTM
 * anterior, confirma en un modal y queda registrado quién, cuándo y cuántos
 * días faltaban para el vencimiento (contados desde la fecha del turno).
 * Mismo patrón que aprobado_excepcion_* de captacion_dateos.
 * NULL = turno creado sin esa confirmación (caso normal e históricos).
 */
export default class extends BaseSchema {
  protected tableName = 'turnos_rtms'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table
        .integer('ventana_rtm_confirmada_por_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .after('segunda_vez_excepcion_motivo')
      table
        .timestamp('ventana_rtm_confirmada_at', { useTz: false })
        .nullable()
        .after('ventana_rtm_confirmada_por_id')
      table
        .integer('ventana_rtm_dias_antes_vencimiento')
        .nullable()
        .after('ventana_rtm_confirmada_at')
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropForeign(['ventana_rtm_confirmada_por_id'])
      table.dropColumn('ventana_rtm_dias_antes_vencimiento')
      table.dropColumn('ventana_rtm_confirmada_at')
      table.dropColumn('ventana_rtm_confirmada_por_id')
    })
  }
}
