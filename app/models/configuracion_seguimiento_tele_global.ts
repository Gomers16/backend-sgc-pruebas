// app/models/configuracion_seguimiento_tele_global.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/** Fila única: máximo de seguimientos y vigencia del ciclo de Telemercadeo. */
export default class ConfiguracionSeguimientoTeleGlobal extends BaseModel {
  public static table = 'configuracion_seguimiento_tele_global'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'max_seguimientos' })
  declare maxSeguimientos: number

  @column({ columnName: 'dias_vigencia_ciclo' })
  declare diasVigenciaCiclo: number

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
