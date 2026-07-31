// database/migrations/1784700000000_create_continuidad_overrides_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'continuidad_overrides'

  async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      /**
       * Placa sobre la que aplica el override. La continuidad se evalúa
       * siempre placa + asesor_convenio/convenio, nunca solo por cliente.
       */
      table.string('placa', 20).notNullable()

      table
        .integer('asesor_convenio_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('CASCADE')

      table
        .integer('convenio_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('convenios')
        .onDelete('CASCADE')

      table
        .enu('estado', ['AUTOMATICO', 'FORZAR_SI', 'FORZAR_NO'], {
          useNative: true,
          enumName: 'continuidad_override_estado_enum',
        })
        .notNullable()
        .defaultTo('AUTOMATICO')

      // Obligatorio a nivel de aplicación cuando estado != AUTOMATICO
      table.text('motivo').nullable()

      table
        .integer('creado_por_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('usuarios')

      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.index(['placa'])
      table.index(['asesor_convenio_id'])
      table.index(['convenio_id'])
      // Una placa no puede tener dos overrides activos para el mismo asesor convenio
      table.unique(['placa', 'asesor_convenio_id'], 'continuidad_override_placa_asesor_unique')
      table.unique(['placa', 'convenio_id'], 'continuidad_override_placa_convenio_unique')
    })

    // Al menos uno de los dos (asesor_convenio_id, convenio_id) debe ser no-nulo.
    // CHECK constraints de MySQL 8 se validan en inserts/updates.
    this.schema.raw(`
      ALTER TABLE continuidad_overrides
      ADD CONSTRAINT chk_continuidad_override_scope
      CHECK (asesor_convenio_id IS NOT NULL OR convenio_id IS NOT NULL)
    `)
  }

  async down() {
    this.schema.dropTableIfExists(this.tableName)
  }
}
