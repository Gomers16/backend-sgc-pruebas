// database/migrations/1784900000000_create_informes_discrepancias_rtm_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class CreateInformesDiscrepanciasRtm extends BaseSchema {
  protected tableName = 'informes_discrepancias_rtm'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      // Período cubierto por el informe (auto-detectado del rango de fechas
      // del CSV de Tecnoingeniería en el momento de generar el informe).
      table.date('fecha_inicio').notNullable()
      table.date('fecha_fin').notNullable()

      // Metadata del archivo importado (no hay tabla rep_general_imports
      // a la que hacer FK — se guarda inline).
      table.string('archivo_nombre', 255).nullable()
      table.integer('filas_csv_total').unsigned().nullable()

      table
        .integer('generado_por_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('SET NULL')

      table.timestamp('generado_at', { useTz: true }).notNullable().defaultTo(this.now())

      // Resumen numérico
      table.integer('total_tecno_valido').unsigned().notNullable().defaultTo(0)
      table.integer('total_sgc_finalizados').unsigned().notNullable().defaultTo(0)
      table.integer('total_coinciden').unsigned().notNullable().defaultTo(0)

      table.integer('total_tipo1_placa_mal_digitada').unsigned().notNullable().defaultTo(0)
      table.integer('total_tipo2_activo_debe_finalizar').unsigned().notNullable().defaultTo(0)
      table.integer('total_tipo3_turno_fantasma').unsigned().notNullable().defaultTo(0)
      table.integer('total_tipo4_servicio_mal_asignado').unsigned().notNullable().defaultTo(0)
      table.integer('total_tipo5_falta_en_sgc').unsigned().notNullable().defaultTo(0)
      table
        .integer('total_tipo6_alerta_cobro_no_registrado')
        .unsigned()
        .notNullable()
        .defaultTo(0)

      table.integer('total_duplicados_finalizado').unsigned().notNullable().defaultTo(0)
      table.integer('total_ambiguos_revisar_manual').unsigned().notNullable().defaultTo(0)

      // Detalle completo: { tipo1: [...], tipo2: [...], tipo3: [...], tipo4: [...],
      // tipo5: [...], tipo6: [...], duplicados: [...], ambiguos: [...] }
      table.json('detalle_json').notNullable()

      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())

      table.index(['fecha_inicio', 'fecha_fin'], 'idx_informes_discrepancias_periodo')
      table.index(['generado_por_id'], 'idx_informes_discrepancias_generado_por')
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
