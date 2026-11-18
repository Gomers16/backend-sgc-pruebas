// app/models/configuracion_seguimiento_tele_asesor.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import AgenteCaptacion from '#models/agente_captacion'

/** Override por asesor del máximo de seguimientos (NULL = usa el global). */
export default class ConfiguracionSeguimientoTeleAsesor extends BaseModel {
  public static table = 'configuracion_seguimiento_tele_asesores'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'asesor_id' })
  declare asesorId: number

  @column({ columnName: 'max_seguimientos' })
  declare maxSeguimientos: number | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'asesorId' })
  declare asesor: BelongsTo<typeof AgenteCaptacion>
}
