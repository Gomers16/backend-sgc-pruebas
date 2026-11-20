import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export default class TarifaTramite extends compose(BaseModel, SedeScoped) {
  // Multi-sede: 3f, tarifas de trámites POR SEDE (decisión 2026-11-19).

  public static table = 'tarifas_tramites'

  @column({ isPrimary: true })
  declare id: number

  // Multi-sede: las tarifas de trámites son por sede (migración 1811000000005).
  @column({ columnName: 'sede_id' })
  declare sedeId: number

  @column({ columnName: 'tipo_tramite' })
  declare tipoTramite: string

  @column({ columnName: 'clase_vehiculo' })
  declare claseVehiculo: string | null

  @column()
  declare valor: number

  @column.date({ columnName: 'vigencia_desde' })
  declare vigenciaDesde: DateTime

  @column()
  declare descripcion: string | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
