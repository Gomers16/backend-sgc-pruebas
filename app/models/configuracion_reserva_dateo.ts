// app/models/configuracion_reserva_dateo.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class ConfiguracionReservaDateo extends BaseModel {
  public static table = 'configuracion_reserva_dateos'

  @column({ isPrimary: true })
  declare id: number

  /**
   * Horas de exclusividad de un dateo sobre una placa/teléfono antes de ser
   * consumido por un turno. Mientras esté vigente, otro asesor no puede
   * datear la misma placa/teléfono (bloqueo 409 en buildReserva()).
   */
  @column({ columnName: 'horas_exclusividad' })
  declare horasExclusividad: number

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
