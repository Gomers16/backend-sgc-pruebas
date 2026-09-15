// database/migrations/1787000000015_create_turno_llamados_table.ts
//
// Registra el "llamado" de un turno ya certificado (estado='finalizado') a
// un módulo. Es la fuente real de `ultimosLlamados` que consume la pantalla
// del turnero (ver turno_llamados_controller.ts::colaTurnero()). El índice
// único en turno_id es lo que impide llamar el mismo turno dos veces, tanto
// a nivel de aplicación (pre-chequeo en store()) como de base de datos
// (red de seguridad ante una condición de carrera, mismo patrón que
// uq_turno_activo_por_placa_servicio_dia en turnos_rtms).
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class CreateTurnoLlamados extends BaseSchema {
  protected tableName = 'turno_llamados'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('turno_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('turnos_rtms')
        .onDelete('CASCADE')

      table.string('modulo').notNullable()

      table
        .integer('usuario_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('SET NULL')

      table.timestamp('llamado_at', { useTz: true }).notNullable().defaultTo(this.now())

      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())

      table.unique(['turno_id'], 'uq_turno_llamados_turno_id')
      table.index(['llamado_at'], 'idx_turno_llamados_llamado_at')
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
