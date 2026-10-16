import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Línea de tiempo de los tickets internos (solo para mostrar el historial;
 * las estadísticas NUNCA salen de aquí, salen de tickets +
 * tickets_detalle_excepcion_dateo + comisiones, porque producción local, que
 * usa la misma BD, no escribe eventos).
 *
 * Backfill: un CREADO por ticket (fecha del ticket), la resolución si la hay
 * (APROBADO/RECHAZADO con la fecha de aprobado_at/rechazado_at) y un
 * COMENTARIO por comentario. Solo para tickets que todavía no tengan eventos.
 */
export const SQL_BACKFILL_TICKET_EVENTOS = [
  `INSERT INTO ticket_eventos (ticket_id, tipo, usuario_id, created_at, datos)
   SELECT t.id, 'CREADO', t.creado_por_id, t.created_at,
          JSON_OBJECT('backfill', TRUE, 'dentro_ventana', d.dentro_ventana = 1,
                      'convenio_id', d.convenio_id, 'minutos_exceso', d.minutos_exceso)
     FROM tickets t
     LEFT JOIN tickets_detalle_excepcion_dateo d ON d.ticket_id = t.id
    WHERE NOT EXISTS (SELECT 1 FROM ticket_eventos e WHERE e.ticket_id = t.id)`,
  `INSERT INTO ticket_eventos (ticket_id, tipo, usuario_id, created_at, datos)
   SELECT t.id, 'APROBADO', d.aprobado_por_id, COALESCE(d.aprobado_at, t.resuelto_at, t.created_at),
          JSON_OBJECT('backfill', TRUE,
                      'con_comision_asesor', COALESCE(d.con_comision_asesor, d.con_comision),
                      'con_comision_convenio', d.con_comision_convenio,
                      'dentro_ventana', d.dentro_ventana = 1)
     FROM tickets t
     JOIN tickets_detalle_excepcion_dateo d ON d.ticket_id = t.id
    WHERE t.estado = 'APROBADO'
      AND NOT EXISTS (SELECT 1 FROM ticket_eventos e WHERE e.ticket_id = t.id AND e.tipo = 'APROBADO')`,
  `INSERT INTO ticket_eventos (ticket_id, tipo, usuario_id, created_at, datos)
   SELECT t.id, 'RECHAZADO', d.rechazado_por_id, COALESCE(d.rechazado_at, t.resuelto_at, t.created_at),
          JSON_OBJECT('backfill', TRUE, 'motivo', d.motivo_rechazo)
     FROM tickets t
     JOIN tickets_detalle_excepcion_dateo d ON d.ticket_id = t.id
    WHERE t.estado = 'RECHAZADO'
      AND NOT EXISTS (SELECT 1 FROM ticket_eventos e WHERE e.ticket_id = t.id AND e.tipo = 'RECHAZADO')`,
  `INSERT INTO ticket_eventos (ticket_id, tipo, usuario_id, created_at, datos)
   SELECT c.ticket_id, 'COMENTARIO', c.usuario_id, c.created_at,
          JSON_OBJECT('backfill', TRUE, 'comentario_id', c.id)
     FROM tickets_comentarios c
    WHERE NOT EXISTS (
      SELECT 1 FROM ticket_eventos e
       WHERE e.ticket_id = c.ticket_id AND e.tipo = 'COMENTARIO'
         AND JSON_EXTRACT(e.datos, '$.comentario_id') = c.id)`,
]

export default class extends BaseSchema {
  protected tableName = 'ticket_eventos'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')
      table
        .integer('ticket_id')
        .unsigned()
        .notNullable()
        .references('id')
        .inTable('tickets')
        .onDelete('CASCADE')
      table
        .enu('tipo', ['CREADO', 'APROBADO', 'RECHAZADO', 'COMENTARIO', 'CONVENIO_CORREGIDO'])
        .notNullable()
      table
        .integer('usuario_id')
        .unsigned()
        .nullable()
        .references('id')
        .inTable('usuarios')
        .onDelete('SET NULL')
      table.timestamp('created_at', { useTz: false }).notNullable().defaultTo(this.now())
      table.json('datos').nullable()

      table.index(['ticket_id', 'created_at'])
    })

    this.defer(async (db) => {
      for (const sql of SQL_BACKFILL_TICKET_EVENTOS) await db.rawQuery(sql)
    })
  }

  public async down() {
    this.schema.dropTable(this.tableName)
  }
}
