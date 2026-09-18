// app/models/turnero_multimedia.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class TurneroMultimedia extends BaseModel {
  public static table = 'turnero_multimedia'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare tipo: 'imagen' | 'video'

  @column()
  declare url: string

  @column({ columnName: 'duracion_segundos' })
  declare duracionSegundos: number | null

  @column()
  declare orden: number

  @column()
  declare activo: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime
}
