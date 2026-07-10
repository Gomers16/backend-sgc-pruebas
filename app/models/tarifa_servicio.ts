import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Servicio from '#models/servicio'

export type TipoVehiculoTarifa = 'MOTO' | 'VEHICULO'

export default class TarifaServicio extends BaseModel {
  public static table = 'tarifas_servicios'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'servicio_id' })
  declare servicioId: number

  @belongsTo(() => Servicio, { foreignKey: 'servicioId' })
  declare servicio: BelongsTo<typeof Servicio>

  @column({ columnName: 'tipo_vehiculo' })
  declare tipoVehiculo: TipoVehiculoTarifa

  @column({ columnName: 'valor_base' })
  declare valorBase: number

  @column({ columnName: 'valor_total' })
  declare valorTotal: number

  @column()
  declare descripcion: string | null

  @column()
  declare activo: boolean

  @column.date({ columnName: 'vigencia_desde' })
  declare vigenciaDesde: DateTime | null

  @column.dateTime({ columnName: 'created_at', autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ columnName: 'updated_at', autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  public static async findByServicioYTipo(
    servicioId: number,
    tipoVehiculo: TipoVehiculoTarifa
  ) {
    return TarifaServicio.query()
      .where('servicio_id', servicioId)
      .andWhere('tipo_vehiculo', tipoVehiculo)
      .andWhere('activo', true)
      .first()
  }
}
