// app/models/liquidacion.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'

import Usuario from '#models/usuario'
import LiquidacionDetalle from '#models/liquidacion_detalle'

export type LiquidacionTipoOrigen = 'MODAL_LIQUIDAR' | 'TABLA_GENERAL' | 'PANEL_ASESOR'
export type LiquidacionTipoPeriodo = 'DIARIO' | 'SEMANAL' | 'QUINCENAL' | 'MENSUAL' | null

export default class Liquidacion extends BaseModel {
  public static table = 'liquidaciones'

  @column({ isPrimary: true })
  declare id: number

  @column.date({ columnName: 'fecha_inicio' })
  declare fechaInicio: DateTime

  @column.date({ columnName: 'fecha_fin' })
  declare fechaFin: DateTime

  @column({ columnName: 'tipo_origen' })
  declare tipoOrigen: LiquidacionTipoOrigen

  @column({ columnName: 'tipo_periodo' })
  declare tipoPeriodo: LiquidacionTipoPeriodo

  @column({ columnName: 'monto_total' })
  declare montoTotal: number

  @column({ columnName: 'cantidad_comisiones' })
  declare cantidadComisiones: number

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>

  @hasMany(() => LiquidacionDetalle, { foreignKey: 'liquidacionId' })
  declare detalle: HasMany<typeof LiquidacionDetalle>
}
