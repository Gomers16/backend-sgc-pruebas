import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'turno_llamados'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Tipo del ÚLTIMO anuncio de esta fila (la fila se reutiliza: Llamar,
      // Volver a llamar y Preguntar pisan llamado_at y este campo).
      //  - 'modulo'   → llamado a un módulo ("Diríjase a {módulo}")
      //  - 'pregunta' → llamado para una pregunta ("Por favor acérquese a
      //                 {módulo}") — mismo módulo real, distinto texto.
      table.enum('tipo_llamado', ['modulo', 'pregunta']).notNullable().defaultTo('modulo')

      // true  → la fila tuvo un "LLAMAR" real a módulo (store()): el turno
      //         está en "pendientes de entrega" / "Llamando ahora".
      // false → la fila existe solo porque se le hizo "Preguntar" a un turno
      //         todavía sin llamar: el turno sigue en "Turnos para Llamar" y
      //         en la cola (ver sinLlamadoActivo() en
      //         turno_llamados_controller.ts). No se puede deducir de
      //         tipo_llamado: una pregunta sobre un turno ya llamado también
      //         deja tipo_llamado='pregunta'.
      // Default true: todas las filas existentes son llamados oficiales, no
      // hace falta backfill.
      table.boolean('llamado_oficial').notNullable().defaultTo(true)
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('llamado_oficial')
      table.dropColumn('tipo_llamado')
    })
  }
}
