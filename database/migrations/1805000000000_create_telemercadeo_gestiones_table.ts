import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Gestión de contacto de un asesor de Telemercadeo (llamada, WhatsApp, SMS o
 * correo) con evidencia obligatoria. No genera comisiones.
 *
 * - agente_id sale siempre del token (nunca del body).
 * - evidencia_ruta es una ruta PRIVADA bajo uploads/telemercadeo/ que el GET
 *   público /api/uploads/* no sirve; se ve por
 *   GET /api/telemercadeo/gestiones/:id/evidencia (autenticado).
 * - captacion_dateo_id: dateo creado desde esta gestión (UNIQUE: un dateo
 *   por gestión). Al vincularse, resultado pasa a DATEADO.
 * - idempotency_key: UNIQUE por agente, contra doble envío.
 */
export default class extends BaseSchema {
  protected tableName = 'telemercadeo_gestiones'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table
        .integer('ciclo_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('telemercadeo_ciclos')
        .onDelete('RESTRICT')
      table.integer('numero_en_ciclo').unsigned().notNullable()
      table
        .integer('agente_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('agentes_captacions')
        .onDelete('RESTRICT')
      table
        .integer('usuario_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('RESTRICT')
      table.string('placa', 12).notNullable()
      table.string('telefono', 20).nullable()
      table
        .integer('cliente_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('clientes')
        .onDelete('SET NULL')
      table
        .integer('vehiculo_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('vehiculos')
        .onDelete('SET NULL')
      table
        .integer('servicio_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('servicios')
        .onDelete('RESTRICT')
      table.enu('medio', ['LLAMADA', 'WHATSAPP', 'SMS', 'CORREO']).notNullable()
      table
        .integer('origen_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('telemercadeo_origenes')
        .onDelete('RESTRICT')
      table
        .enu('resultado', [
          'SIN_RESPUESTA',
          'NUMERO_EQUIVOCADO',
          'VOLVER_A_LLAMAR',
          'INTERESADO',
          'NO_INTERESADO',
          'YA_REALIZADO',
          'DATEADO',
        ])
        .notNullable()
      table.string('evidencia_ruta', 255).notNullable()
      table.text('observacion').nullable()
      table.date('proximo_contacto_at').nullable()
      table
        .integer('captacion_dateo_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('captacion_dateos')
        .onDelete('SET NULL')
      table.string('idempotency_key', 64).notNullable()
      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['agente_id', 'idempotency_key'], { indexName: 'uq_tele_gestion_idempotencia' })
      table.unique(['captacion_dateo_id'], { indexName: 'uq_tele_gestion_dateo' })
      table.index(['agente_id', 'created_at'], 'idx_tele_gestion_agente_fecha')
      table.index(['placa', 'servicio_id'], 'idx_tele_gestion_placa_servicio')
      table.index(['created_at'], 'idx_tele_gestion_fecha')
      table.index(['origen_id'], 'idx_tele_gestion_origen')
      table.index(['resultado'], 'idx_tele_gestion_resultado')
      table.index(['proximo_contacto_at'], 'idx_tele_gestion_proximo')
    })
  }

  public async down() {
    this.schema.dropTableIfExists(this.tableName)
  }
}
