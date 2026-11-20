import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { BaseModel, column, hasMany, manyToMany, belongsTo } from '@adonisjs/lucid/orm'
import type { HasMany, ManyToMany, BelongsTo } from '@adonisjs/lucid/types/relations'
import { DateTime } from 'luxon'
import Usuario from '#models/usuario'
import CaptacionDateo from '#models/captacion_dateo'
import CaptacionCanal from '#models/captacion_canal'

// 🎯 Tipos de agentes coherentes con cargos y canales
export type TipoAsesor = 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'ASESOR_TELEMERCADEO'

export default class AgenteCaptacion extends compose(BaseModel, SedeScoped) {
  // Multi-sede: 3g, sede_id propio (trabajar en 2 sedes = 2 agentes).
  @column({ columnName: 'sede_id' })
  declare sedeId: number | null

  public static table = 'agentes_captacions'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @column()
  declare tipo: TipoAsesor

  @column()
  declare nombre: string

  @column()
  declare telefono: string | null

  @column({ columnName: 'doc_tipo' })
  declare docTipo: 'CC' | 'NIT' | null

  @column({ columnName: 'doc_numero' })
  declare docNumero: string | null

  @column()
  declare activo: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  // Relaciones
  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>

  @hasMany(() => CaptacionDateo, { foreignKey: 'agenteId' })
  declare dateos: HasMany<typeof CaptacionDateo>

  @manyToMany(() => CaptacionCanal, {
    pivotTable: 'agente_canal_membresias',
    pivotColumns: ['is_default', 'activo'],
    pivotTimestamps: true,
  })
  declare canales: ManyToMany<typeof CaptacionCanal>
}
