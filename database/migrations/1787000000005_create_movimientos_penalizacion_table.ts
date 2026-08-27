// database/migrations/1787000000005_create_movimientos_penalizacion_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'movimientos_penalizacion'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('asesor_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('RESTRICT')

      table
        .enu('tipo', ['CARGO', 'ABONO'], {
          useNative: true,
          enumName: 'movimiento_penalizacion_tipo_enum',
        })
        .notNullable()

      table.decimal('monto', 12, 2).notNullable()

      // Solo si tipo = CARGO
      table
        .integer('ticket_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('tickets')
        .onDelete('SET NULL')

      // Solo si tipo = ABONO
      table
        .enu('origen_cobro', ['COMISION', 'NOMINA'], {
          useNative: true,
          enumName: 'movimiento_penalizacion_origen_cobro_enum',
        })
        .nullable()

      // Solo si origen_cobro = COMISION
      table
        .integer('comision_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('comisiones')
        .onDelete('SET NULL')

      table.text('observacion').nullable()

      // Snapshot del saldo de saldo_penalizaciones DESPUÉS de aplicar este movimiento.
      table.decimal('saldo_resultante', 12, 2).notNullable()

      table
        .integer('creado_por_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('RESTRICT')

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.index(['asesor_id'])
      table.index(['ticket_id'])
      table.index(['comision_id'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
