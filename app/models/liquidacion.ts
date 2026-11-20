// app/models/liquidacion.ts
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'

import Usuario from '#models/usuario'
import LiquidacionDetalle from '#models/liquidacion_detalle'

export type LiquidacionTipoOrigen = 'MODAL_LIQUIDAR' | 'TABLA_GENERAL' | 'PANEL_ASESOR'
export type LiquidacionTipoPeriodo = 'DIARIO' | 'SEMANAL' | 'QUINCENAL' | 'MENSUAL' | null

export default class Liquidacion extends compose(BaseModel, SedeScoped) {
  public static table = 'liquidaciones'

  // Multi-sede (3d): una liquidación es de UNA sede (la activa al pagar).
  @column({ columnName: 'sede_id' })
  declare sedeId: number | null

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
