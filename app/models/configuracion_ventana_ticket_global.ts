// app/models/configuracion_ventana_ticket_global.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class ConfiguracionVentanaTicketGlobal extends BaseModel {
  public static table = 'configuracion_ventana_ticket_global'

  @column({ isPrimary: true })
  declare id: number

  /**
   * Minutos desde turno.horaIngreso dentro de los cuales un ticket de
   * "Excepción de Dateo" no lleva penalización (fallback cuando no hay
   * override específico por asesor).
   */
  @column({ columnName: 'minutos_ventana' })
  declare minutosVentana: number

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
