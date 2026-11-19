import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, belongsTo } from '@adonisjs/lucid/orm'
import type { HasMany, BelongsTo } from '@adonisjs/lucid/types/relations'
import Usuario from '#models/usuario'
import Ciudad from '#models/ciudad'

export default class Sede extends BaseModel {
  public static table = 'sedes'

  @column({ isPrimary: true })
  declare id: number

  // (La tabla sedes NO tiene razon_social_id: la razón social va en el
  // usuario y en el contrato. Se quitó la columna/relación fantasma que
  // declaraba este modelo — drift detectado en multi-sede Fase 0.)

  // FK → ciudades.id
  @column({ columnName: 'ciudad_id' })
  declare ciudadId: number

  // Nombre visible de la sede
  @column()
  declare nombre: string

  // Dirección opcional
  @column()
  declare direccion?: string | null

  // Zona horaria (por defecto 'America/Bogota')
  @column()
  declare timezone: string

  // Estado
  @column()
  declare activo: boolean

  // Timestamps
  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  // Relaciones
  @hasMany(() => Usuario)
  declare usuarios: HasMany<typeof Usuario>

  @belongsTo(() => Ciudad, { foreignKey: 'ciudadId' })
  declare ciudad: BelongsTo<typeof Ciudad>
}
