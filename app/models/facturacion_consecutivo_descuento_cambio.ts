// app/models/facturacion_consecutivo_descuento_cambio.ts
//
// Registro de las correcciones del consecutivo del descuento de un ticket ya
// CONFIRMADA (ver FacturacionTicketsController.corregirConsecutivoDescuento).
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import FacturacionTicket from '#models/facturacion_ticket'
import Usuario from '#models/usuario'

export default class FacturacionConsecutivoDescuentoCambio extends compose(BaseModel, SedeScoped) {
  // Multi-sede (3b): sin sede_id propio; hereda la del ticket de facturación.
  static sedeVia = {
    atributo: 'facturacionTicketId',
    columna: 'facturacion_ticket_id',
    tablaPadre: 'facturacion_tickets',
  }

  public static table = 'facturacion_consecutivo_descuento_cambios'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'facturacion_ticket_id' })
  declare facturacionTicketId: number

  /** NULL = el ticket no tenía consecutivo (confirmado antes de existir el campo). */
  @column({ columnName: 'valor_anterior' })
  declare valorAnterior: string | null

  @column({ columnName: 'valor_nuevo' })
  declare valorNuevo: string

  @column()
  declare motivo: string | null

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @column.dateTime({ columnName: 'created_at', autoCreate: true })
  declare createdAt: DateTime

  @belongsTo(() => FacturacionTicket, { foreignKey: 'facturacionTicketId' })
  declare ticket: BelongsTo<typeof FacturacionTicket>

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>
}
