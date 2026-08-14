// app/models/configuracion_redateo_asesor.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import AgenteCaptacion from '#models/agente_captacion'

export default class ConfiguracionRedateoAsesor extends BaseModel {
  public static table = 'configuracion_redateo_asesores'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'asesor_id' })
  declare asesorId: number

  /**
   * Máximo de re-dateos personalizado para este asesor.
   * NULL = usa el valor global.
   */
  @column({ columnName: 'max_redateos' })
  declare maxRedateos: number | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'asesorId' })
  declare asesor: BelongsTo<typeof AgenteCaptacion>
}
