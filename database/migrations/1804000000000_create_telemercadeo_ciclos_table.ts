import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Ciclo de seguimiento de Telemercadeo: agrupa las gestiones de un mismo
 * cliente (placa + servicio), de cualquier asesor, hasta que se cierra
 * (DATEADO, TURNO o VENCIDO). El límite de seguimientos se cuenta por ciclo.
 *
 * Un solo ciclo abierto por placa + servicio: abierto_key = 1 mientras está
 * abierto y NULL al cerrarse (MySQL admite varios NULL en un UNIQUE), mismo
 * patrón que uq_segunda_vez_origen_activo en turnos_rtms.
 */
export default class extends BaseSchema {
  protected tableName = 'telemercadeo_ciclos'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.charset('utf8mb4')
      table.collate('utf8mb4_unicode_ci')
      table.increments('id')
      table.string('placa', 12).notNullable()
      table
        .integer('servicio_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('servicios')
        .onDelete('RESTRICT')
      table
        .integer('cliente_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('clientes')
        .onDelete('SET NULL')
      table.integer('numero_gestiones').unsigned().notNullable().defaultTo(0)
      // Seguimientos extra autorizados por gerencia (detalle en
      // telemercadeo_ciclo_autorizaciones).
      table.integer('extras_autorizados').unsigned().notNullable().defaultTo(0)
      table.tinyint('abierto_key').unsigned().nullable().defaultTo(1)
      table.timestamp('ultima_gestion_at', { useTz: false }).nullable()
      table.timestamp('cerrado_at', { useTz: false }).nullable()
      table.enu('cerrado_motivo', ['DATEADO', 'TURNO', 'VENCIDO']).nullable()
      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: false }).notNullable().defaultTo(this.now())

      table.unique(['placa', 'servicio_id', 'abierto_key'], { indexName: 'uq_tele_ciclo_abierto' })
      table.index(['placa'], 'idx_tele_ciclo_placa')
    })
  }

  public async down() {
    this.schema.dropTableIfExists(this.tableName)
  }
}
