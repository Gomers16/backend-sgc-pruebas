// app/models/certificacion.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import TurnoRtm from '#models/turno_rtm'
import User from '#models/usuario'
import type { ResultadoCertificacion } from '#services/segunda_vez_service'

export default class Certificacion extends BaseModel {
  public static table = 'certificaciones'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'turno_id' })
  declare turnoId: number

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @column({ columnName: 'imagen_path' })
  declare imagenPath: string

  @column()
  declare observaciones: string | null

  /** Solo RTM/PREV. NULL = sin resultado (histórico o SOAT/PERI). */
  @column()
  declare resultado: ResultadoCertificacion | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => TurnoRtm, { foreignKey: 'turnoId' })
  declare turno: BelongsTo<typeof TurnoRtm>

  @belongsTo(() => User, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof User>
}
