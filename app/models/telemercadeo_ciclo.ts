// app/models/telemercadeo_ciclo.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export type MotivoCierreCiclo = 'DATEADO' | 'TURNO' | 'VENCIDO'

/** Ciclo de seguimiento de Telemercadeo (placa + servicio). Ver migración 1804000000000. */
export default class TelemercadeoCiclo extends BaseModel {
  public static table = 'telemercadeo_ciclos'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare placa: string

  @column({ columnName: 'servicio_id' })
  declare servicioId: number

  @column({ columnName: 'cliente_id' })
  declare clienteId: number | null

  @column({ columnName: 'numero_gestiones' })
  declare numeroGestiones: number

  @column({ columnName: 'extras_autorizados' })
  declare extrasAutorizados: number

  /** 1 = abierto, NULL = cerrado (TINYINT: llega 0/1/null). */
  @column({ columnName: 'abierto_key' })
  declare abiertoKey: number | null

  @column.dateTime({ columnName: 'ultima_gestion_at' })
  declare ultimaGestionAt: DateTime | null

  @column.dateTime({ columnName: 'cerrado_at' })
  declare cerradoAt: DateTime | null

  @column({ columnName: 'cerrado_motivo' })
  declare cerradoMotivo: MotivoCierreCiclo | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
