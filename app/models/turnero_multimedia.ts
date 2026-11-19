// app/models/turnero_multimedia.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'

export default class TurneroMultimedia extends compose(BaseModel, SedeScoped) {
  // Multi-sede (3a)
  @column({ columnName: 'sede_id' })
  declare sedeId: number

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
