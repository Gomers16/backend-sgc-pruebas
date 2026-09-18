// app/models/turnero_mensaje_ticker.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class TurneroMensajeTicker extends BaseModel {
  public static table = 'turnero_mensajes_ticker'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare texto: string

  @column()
  declare orden: number

  @column()
  declare activo: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
