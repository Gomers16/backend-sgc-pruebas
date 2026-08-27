// app/models/ticket.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, hasMany, hasOne } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany, HasOne } from '@adonisjs/lucid/types/relations'

import TipoTicket from '#models/tipo_ticket'
import Usuario from '#models/usuario'
import TicketComentario from '#models/ticket_comentario'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'

export type TicketEstado = 'PENDIENTE' | 'APROBADO' | 'RECHAZADO' | 'RESUELTO' | 'CERRADO'

export default class Ticket extends BaseModel {
  public static table = 'tickets'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'tipo_ticket_id' })
  declare tipoTicketId: number

  @column()
  declare titulo: string

  @column()
  declare estado: TicketEstado

  @column({ columnName: 'creado_por_id' })
  declare creadoPorId: number

  @column({ columnName: 'asignado_a_id' })
  declare asignadoAId: number | null

  @column({ columnName: 'modulo_relacionado' })
  declare moduloRelacionado: string | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ columnName: 'resuelto_at' })
  declare resueltoAt: DateTime | null

  @column.dateTime({ columnName: 'cerrado_at' })
  declare cerradoAt: DateTime | null

  /* ================== Relaciones ================== */

  @belongsTo(() => TipoTicket, { foreignKey: 'tipoTicketId' })
  declare tipoTicket: BelongsTo<typeof TipoTicket>

  @belongsTo(() => Usuario, { foreignKey: 'creadoPorId' })
  declare creadoPor: BelongsTo<typeof Usuario>

  @belongsTo(() => Usuario, { foreignKey: 'asignadoAId' })
  declare asignadoA: BelongsTo<typeof Usuario>

  @hasMany(() => TicketComentario, { foreignKey: 'ticketId' })
  declare comentarios: HasMany<typeof TicketComentario>

  @hasOne(() => TicketDetalleExcepcionDateo, { foreignKey: 'ticketId' })
  declare detalleExcepcionDateo: HasOne<typeof TicketDetalleExcepcionDateo>
}
