// app/models/ticket_evento.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Usuario from '#models/usuario'

export type TipoTicketEvento =
  | 'CREADO'
  | 'APROBADO'
  | 'RECHAZADO'
  | 'COMENTARIO'
  | 'CONVENIO_CORREGIDO'

/**
 * Evento de la línea de tiempo de un ticket. Solo para mostrar historial:
 * las estadísticas salen de tickets/tickets_detalle_excepcion_dateo, porque
 * producción local (misma BD) no escribe eventos.
 */
export default class TicketEvento extends BaseModel {
  public static table = 'ticket_eventos'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'ticket_id' })
  declare ticketId: number

  @column()
  declare tipo: TipoTicketEvento

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column({
    prepare: (v: unknown) => (v === null || v === undefined ? null : JSON.stringify(v)),
    consume: (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v),
  })
  declare datos: Record<string, unknown> | null

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>
}
