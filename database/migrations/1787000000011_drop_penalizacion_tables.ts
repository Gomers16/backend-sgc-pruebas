// database/migrations/1787000000011_drop_penalizacion_tables.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  public async up() {
    // Orden: movimientos_penalizacion primero (referencia a tickets/comisiones
    // pero nada le referencia a él), saldo_penalizaciones después — sin FKs
    // entrantes desde otras tablas hacia ninguna de las dos (confirmado antes
    // de escribir esta migración). Reemplazadas por el flag booleano
    // con_comision en tickets_detalle_excepcion_dateo (ver migración 012).
    this.schema.dropTableIfExists('movimientos_penalizacion')
    this.schema.dropTableIfExists('saldo_penalizaciones')
  }

  public async down() {
    // Reversión estructural (recrea las tablas vacías) — no restaura datos.
    this.schema.createTable('saldo_penalizaciones', (table) => {
      table.increments('id')
      table
        .integer('asesor_id')
        .unsigned()
        .notNullable()
        .unique()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('RESTRICT')
      table.decimal('saldo_actual', 12, 2).notNullable().defaultTo(0)
    })

    this.schema.createTable('movimientos_penalizacion', (table) => {
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
      table
        .integer('ticket_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('tickets')
        .onDelete('SET NULL')
      table
        .enu('origen_cobro', ['COMISION', 'NOMINA'], {
          useNative: true,
          enumName: 'movimiento_penalizacion_origen_cobro_enum',
        })
        .nullable()
      table
        .integer('comision_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('comisiones')
        .onDelete('SET NULL')
      table.text('observacion').nullable()
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
}
