// app/models/saldo_penalizacion.ts
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import AgenteCaptacion from '#models/agente_captacion'

export default class SaldoPenalizacion extends BaseModel {
  public static table = 'saldo_penalizaciones'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'asesor_id' })
  declare asesorId: number

  @column({ columnName: 'saldo_actual' })
  declare saldoActual: string

  /* ================== Relaciones ================== */

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'asesorId' })
  declare asesor: BelongsTo<typeof AgenteCaptacion>
}
