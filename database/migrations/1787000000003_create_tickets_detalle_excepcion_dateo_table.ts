// database/migrations/1787000000003_create_tickets_detalle_excepcion_dateo_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tickets_detalle_excepcion_dateo'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('ticket_id')
        .unsigned()
        .notNullable()
        .unique()
        .references('id')
        .inTable('tickets')
        .onDelete('CASCADE')

      table
        .integer('turno_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('turnos_rtms')
        .onDelete('RESTRICT')

      table.string('placa').notNullable()

      table
        .integer('comercial_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('RESTRICT')

      table
        .integer('convenio_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('convenios')
        .onDelete('SET NULL')

      // Snapshot de turno.hora_ingreso al momento de crear el ticket (mismo
      // formato string 'HH:mm:ss' que turnos_rtms.hora_ingreso).
      table.string('hora_ingreso').notNullable()

      table.dateTime('hora_intento_dateo', { useTz: false }).notNullable()

      table.integer('minutos_totales').notNullable()
      table.integer('minutos_exceso').notNullable()

      table.text('observacion').notNullable()

      table.string('evidencia_chat_url').notNullable()
      table.string('evidencia_grupo_whatsapp_url').notNullable()
      table.string('evidencia_bloqueo_url').notNullable()
      table.string('evidencia_calamidad_url').nullable()

      table.decimal('porcentaje_penalizacion', 5, 2).nullable()

      table
        .integer('aprobado_por_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('SET NULL')
      table.dateTime('aprobado_at', { useTz: false }).nullable()

      table.text('motivo_rechazo').nullable()
      table
        .integer('rechazado_por_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('SET NULL')
      table.dateTime('rechazado_at', { useTz: false }).nullable()

      table.index(['turno_id'])
      table.index(['comercial_id'])
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
