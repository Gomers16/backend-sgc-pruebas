// app/models/configuracion_meta_mensual.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class ConfiguracionMetaMensual extends BaseModel {
  public static table = 'configuracion_meta_mensual'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare mes: number

  @column()
  declare anio: number

  /**
   * Meta mensual de turnos RTM finalizados (estado='finalizado'),
   * separada por tipo de vehículo. Ej: 900 livianos + 500 motos = 1400.
   */
  @column({ columnName: 'meta_livianos' })
  declare metaLivianos: number

  @column({ columnName: 'meta_motos' })
  declare metaMotos: number

  /**
   * % de crecimiento de referencia usado en el comparativo contra el
   * mismo mes del año anterior cuando no hay dato real/histórico.
   */
  @column({ columnName: 'pct_crecimiento_referencia' })
  declare pctCrecimientoReferencia: number

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
