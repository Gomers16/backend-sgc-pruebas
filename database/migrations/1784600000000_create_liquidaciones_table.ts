// database/migrations/1784600000000_create_liquidaciones_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'liquidaciones'

  public async up() {
    await this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table.date('fecha_inicio').notNullable()
      table.date('fecha_fin').notNullable()

      table
        .enu('tipo_origen', ['MODAL_LIQUIDAR', 'TABLA_GENERAL', 'PANEL_ASESOR'], {
          useNative: true,
          enumName: 'liquidacion_tipo_origen_enum',
        })
        .notNullable()

      table
        .enu('tipo_periodo', ['DIARIO', 'SEMANAL', 'QUINCENAL', 'MENSUAL'], {
          useNative: true,
          enumName: 'liquidacion_tipo_periodo_enum',
        })
        .nullable()

      table.decimal('monto_total', 14, 2).notNullable().defaultTo(0)
      table.integer('cantidad_comisiones').unsigned().notNullable().defaultTo(0)

      table
        .integer('usuario_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('SET NULL')

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.index(['tipo_origen'])
      table.index(['fecha_inicio', 'fecha_fin'])
      table.index(['usuario_id'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
