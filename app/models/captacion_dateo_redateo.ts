// app/models/captacion_dateo_redateo.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import CaptacionDateo from '#models/captacion_dateo'
import AgenteCaptacion from '#models/agente_captacion'
import Usuario from '#models/usuario'

export default class CaptacionDateoRedateo extends BaseModel {
  public static table = 'captacion_dateo_redateos'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'captacion_dateo_id' })
  declare captacionDateoId: number

  @belongsTo(() => CaptacionDateo, { foreignKey: 'captacionDateoId' })
  declare captacionDateo: BelongsTo<typeof CaptacionDateo>

  @column({ columnName: 'numero_redateo' })
  declare numeroRedateo: number

  @column({ columnName: 'evidencia_url' })
  declare evidenciaUrl: string

  @column({ columnName: 'agente_id' })
  declare agenteId: number | null

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'agenteId' })
  declare agente: BelongsTo<typeof AgenteCaptacion>

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>

  @column()
  declare observacion: string | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime
}
