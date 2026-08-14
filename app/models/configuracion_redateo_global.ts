// app/models/configuracion_redateo_global.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class ConfiguracionRedateoGlobal extends BaseModel {
  public static table = 'configuracion_redateo_global'

  @column({ isPrimary: true })
  declare id: number

  /**
   * Máximo de veces que un mismo dateo puede re-datearse (fallback cuando
   * no hay override específico por asesor).
   */
  @column({ columnName: 'max_redateos' })
  declare maxRedateos: number

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
