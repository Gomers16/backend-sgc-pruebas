// app/models/ticket_comentario.ts
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Ticket from '#models/ticket'
import Usuario from '#models/usuario'

export default class TicketComentario extends compose(BaseModel, SedeScoped) {
  // Multi-sede: 3e, hereda la sede del ticket.
  static sedeVia = { atributo: 'ticketId', columna: 'ticket_id', tablaPadre: 'tickets' }

  public static table = 'tickets_comentarios'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'ticket_id' })
  declare ticketId: number

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number

  @column()
  declare mensaje: string

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  /* ================== Relaciones ================== */

  @belongsTo(() => Ticket, { foreignKey: 'ticketId' })
  declare ticket: BelongsTo<typeof Ticket>

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>
}
