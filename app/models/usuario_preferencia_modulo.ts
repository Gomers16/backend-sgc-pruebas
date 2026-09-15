// app/models/usuario_preferencia_modulo.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Usuario from '#models/usuario'

export default class UsuarioPreferenciaModulo extends BaseModel {
  public static table = 'usuario_preferencia_modulo'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number

  @column({ columnName: 'ultimo_modulo' })
  declare ultimoModulo: string | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>
}
