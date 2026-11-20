// app/models/convenio.ts
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { DateTime } from 'luxon'
import { BaseModel, column, hasMany, belongsTo } from '@adonisjs/lucid/orm'
import type { HasMany, BelongsTo } from '@adonisjs/lucid/types/relations'

import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import CaptacionDateo from '#models/captacion_dateo'
import AgenteCaptacion from '#models/agente_captacion'

export type ConvenioTipo = 'PERSONA' | 'TALLER' | 'PARQUEADERO' | 'LAVADERO'
export type MetodoPago = 'EFECTIVO' | 'TRANSFERENCIA' | 'TARJETA' | 'CHEQUE'
export type ConvenioEstado = 'ACTIVO' | 'INACTIVO' | 'PROSPECTO'
export type ConvenioPeriodicidad = 'DIARIA' | 'SEMANAL' | 'QUINCENAL' | 'MENSUAL'

export default class Convenio extends compose(BaseModel, SedeScoped) {
  // Multi-sede: 3g, sede_id propio.
  @column({ columnName: 'sede_id' })
  declare sedeId: number | null

  public static table = 'convenios'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare tipo: ConvenioTipo

  @column()
  declare codigo: string | null

  @column()
  declare nombre: string

  @column()
  declare establecimiento: string | null

  @column({ columnName: 'doc_tipo' })
  declare docTipo: string | null

  @column({ columnName: 'doc_numero' })
  declare docNumero: string | null

  @column()
  declare telefono: string | null

  @column()
  declare whatsapp: string | null

  @column()
  declare email: string | null

  @column({ columnName: 'ciudad_id' })
  declare ciudadId: number | null

  @column()
  declare direccion: string | null

  @column()
  declare notas: string | null

  @column()
  declare activo: boolean

  // ✅ NUEVO: Fecha de apertura del convenio
  @column.date({ columnName: 'fecha_apertura' })
  declare fechaApertura: DateTime | null

  // Campos de método de pago
  @column({ columnName: 'metodo_pago' })
  declare metodoPago: MetodoPago | null

  @column({ columnName: 'numero_metodo_pago' })
  declare numeroMetodoPago: string | null

  @column({ columnName: 'asesor_convenio_id' })
  declare asesorConvenioId: number | null

  // ✅ NUEVOS CAMPOS DESDE EXCEL BASE DE DATOS

  // Ruta del asesor (ej: '1', '2', 'CDA', 'INT', 'RICAURTE', 'SALADO')
  @column()
  declare ruta: string | null

  // Sub-ruta dentro de la ruta principal (ej: '1 . 2', '1 . 20', '1.15')
  @column({ columnName: 'sub_ruta' })
  declare subRuta: string | null

  // Frecuencia de visita al convenio
  @column()
  declare periodicidad: ConvenioPeriodicidad | null

  // Asesor o persona que reporta / gestiona el convenio
  @column()
  declare reporta: string | null

  // Estado detallado del convenio (complementa el boolean activo)
  // ACTIVO | INACTIVO | PROSPECTO
  @column()
  declare estado: ConvenioEstado | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime

  // ========== RELACIONES ==========
  @hasMany(() => AsesorConvenioAsignacion, { foreignKey: 'convenioId' })
  declare asignaciones: HasMany<typeof AsesorConvenioAsignacion>

  @hasMany(() => CaptacionDateo, { foreignKey: 'convenioId' })
  declare dateos: HasMany<typeof CaptacionDateo>

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'asesorConvenioId' })
  declare asesorConvenio: BelongsTo<typeof AgenteCaptacion>
}
