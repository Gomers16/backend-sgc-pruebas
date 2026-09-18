// app/models/turno_llamado.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import TurnoRtm from '#models/turno_rtm'
import Usuario from '#models/usuario'

export default class TurnoLlamado extends BaseModel {
  public static table = 'turno_llamados'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'turno_id' })
  declare turnoId: number

  @column()
  declare modulo: string

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @column.dateTime({ columnName: 'llamado_at' })
  declare llamadoAt: DateTime

  // Flujo Entregar / No se presentó (pantalla de exhibición del Turnero) —
  // exclusivos de esta tabla, no afectan turnos_rtms.estado.
  @column.dateTime({ columnName: 'entregado_at' })
  declare entregadoAt: DateTime | null

  @column({ columnName: 'no_presentado' })
  declare noPresentado: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => TurnoRtm, { foreignKey: 'turnoId' })
  declare turno: BelongsTo<typeof TurnoRtm>

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>
}
