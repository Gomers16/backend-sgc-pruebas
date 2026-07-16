// app/models/historico_meta_diario.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

/**
 * Respaldo histórico diario (2025 completo excepto mayo, y 2026 Ene-May)
 * cargado por fuera de la app. Se usa como fallback en el reporte Meta
 * Mensual solo para meses donde turnos_rtms no tiene datos reales.
 */
export default class HistoricoMetaDiario extends BaseModel {
  public static table = 'historico_meta_diario'

  @column({ isPrimary: true })
  declare id: number

  @column.date()
  declare fecha: DateTime

  @column()
  declare livianos: number

  @column()
  declare motos: number

  @column()
  declare total: number

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime
}
