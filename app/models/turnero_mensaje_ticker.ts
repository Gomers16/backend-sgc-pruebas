// app/models/turnero_mensaje_ticker.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'

export default class TurneroMensajeTicker extends compose(BaseModel, SedeScoped) {
  // Multi-sede (3a)
  @column({ columnName: 'sede_id' })
  declare sedeId: number

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
