// app/models/configuracion_recurrencia_global.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class ConfiguracionRecurrenciaGlobal extends BaseModel {
  public static table = 'configuracion_recurrencia_global'

  @column({ isPrimary: true })
  declare id: number

  /** Multi-sede: NULL = configuración global; número = override de esa sede. */
  @column({ columnName: 'sede_id' })
  declare sedeId: number | null

  /**
   * Meses mínimos desde última visita para considerar RECURRENTE
   * < mesesMinimos → RECURRENTE (vino reciente)
   * >= mesesMinimos → RECUPERACIÓN (volvió después de mucho tiempo)
   */
  @column({ columnName: 'meses_minimos' })
  declare mesesMinimos: number

  /**
   * 🔄 Comisión BASE por dateo RECURRENTE
   * Fallback cuando no hay valor específico por tipo de vehículo
   */
  @column({ columnName: 'valor_dateo_recurrencia' })
  declare valorDateoRecurrencia: number

  /**
   * 💛 Comisión BASE por dateo RECUPERACIÓN
   * Fallback cuando no hay valor específico por tipo de vehículo
   */
  @column({ columnName: 'valor_dateo_recuperacion' })
  declare valorDateoRecuperacion: number

  /**
   * 🔄 Comisión recurrente para VEHÍCULO LIVIANO
   * Si null → usa valorDateoRecurrencia como fallback
   */
  @column({ columnName: 'valor_dateo_recurrencia_vehiculo' })
  declare valorDateoRecurrenciaVehiculo: number | null

  /**
   * 🔄 Comisión recurrente para MOTO
   * Si null → usa valorDateoRecurrencia como fallback
   */
  @column({ columnName: 'valor_dateo_recurrencia_moto' })
  declare valorDateoRecurrenciaMoto: number | null

  /**
   * 💛 Comisión recuperación para VEHÍCULO LIVIANO
   * Si null → usa valorDateoRecuperacion como fallback
   */
  @column({ columnName: 'valor_dateo_recuperacion_vehiculo' })
  declare valorDateoRecuperacionVehiculo: number | null

  /**
   * 💛 Comisión recuperación para MOTO
   * Si null → usa valorDateoRecuperacion como fallback
   */
  @column({ columnName: 'valor_dateo_recuperacion_moto' })
  declare valorDateoRecuperacionMoto: number | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
