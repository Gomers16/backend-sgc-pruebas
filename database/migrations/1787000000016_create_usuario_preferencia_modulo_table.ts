// database/migrations/1787000000016_create_usuario_preferencia_modulo_table.ts
//
// "Último módulo preferido" por usuario logueado (no por PC ni por sede) —
// precarga el select de módulo en TurnosParaLlamar.vue. Mismo patrón exacto
// que configuracion_ventana_ticket_asesores.ts (id, FK única a la entidad,
// una columna de valor nullable, timestamps), cambiando asesor_id por
// usuario_id porque esta preferencia es por usuario del sistema, no por
// asesor comercial.
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class CreateUsuarioPreferenciaModulo extends BaseSchema {
  protected tableName = 'usuario_preferencia_modulo'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table
        .integer('usuario_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('CASCADE')

      table.string('ultimo_modulo').nullable()

      table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(this.now())
      table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(this.now())

      table.unique(['usuario_id'], 'uq_usuario_preferencia_modulo_usuario_id')
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
