// app/models/continuidad_override.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import Usuario from '#models/usuario'

export type ContinuidadOverrideEstado = 'AUTOMATICO' | 'FORZAR_SI' | 'FORZAR_NO'

export default class ContinuidadOverride extends compose(BaseModel, SedeScoped) {
  // Multi-sede (3c): la continuidad es por sede; el mixin pone la sede al crear.
  @column({ columnName: 'sede_id' })
  declare sedeId: number | null

  public static table = 'continuidad_overrides'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare placa: string

  @column({ columnName: 'asesor_convenio_id' })
  declare asesorConvenioId: number | null

  @column({ columnName: 'convenio_id' })
  declare convenioId: number | null

  @column()
  declare estado: ContinuidadOverrideEstado

  @column()
  declare motivo: string | null

  @column({ columnName: 'creado_por_id' })
  declare creadoPorId: number

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime

  /* ================== Relaciones ================== */

  @belongsTo(() => AgenteCaptacion, {
    foreignKey: 'asesorConvenioId',
  })
  declare asesorConvenio: BelongsTo<typeof AgenteCaptacion>

  @belongsTo(() => Convenio, {
    foreignKey: 'convenioId',
  })
  declare convenio: BelongsTo<typeof Convenio>

  @belongsTo(() => Usuario, {
    foreignKey: 'creadoPorId',
  })
  declare creadoPor: BelongsTo<typeof Usuario>
}
