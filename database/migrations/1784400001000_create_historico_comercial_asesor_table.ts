// database/migrations/1784400001000_create_historico_comercial_asesor_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Respaldo histórico semanal de captaciones por asesor (feb-jul/2026, previo
 * a la existencia de comisiones reales enlazadas en este entorno). Guarda
 * CANTIDAD de turnos/dateos captados por semana, no pesos — el valor en
 * pesos se calcula en el endpoint del reporte, igual que historico_meta_diario
 * se combina con valores configurados en vez de guardar $ directamente.
 * Semana comercial sábado→viernes, mismo criterio que
 * semanaSabadoViernes() en reportes_administrativos_controller.ts.
 */
export default class HistoricoComercialAsesors extends BaseSchema {
  protected tableName = 'historico_comercial_asesor'

  public async up() {
    await this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('asesor_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('CASCADE')

      table.date('fecha_inicio').notNullable()
      table.date('fecha_fin').notNullable()

      table
        .enu('tipo', ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'], {
          useNative: true,
          enumName: 'historico_comercial_tipo_enum',
        })
        .notNullable()

      table.integer('cantidad').unsigned().notNullable().defaultTo(0)

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['asesor_id', 'fecha_inicio', 'tipo'])
      table.index(['fecha_inicio', 'fecha_fin'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
