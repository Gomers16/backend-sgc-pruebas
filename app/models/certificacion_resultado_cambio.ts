// app/models/certificacion_resultado_cambio.ts
//
// Auditoría de las correcciones del resultado de una certificación RTM/PREV
// (ver CertificacionesController.corregirResultado).
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import TurnoRtm from '#models/turno_rtm'
import Usuario from '#models/usuario'
import type { ResultadoCertificacion } from '#services/segunda_vez_service'

export default class CertificacionResultadoCambio extends BaseModel {
  public static table = 'certificacion_resultado_cambios'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'turno_id' })
  declare turnoId: number

  /** NULL = el turno no tenía resultado (certificado antes de la Entrega A). */
  @column({ columnName: 'resultado_anterior' })
  declare resultadoAnterior: ResultadoCertificacion | null

  @column({ columnName: 'resultado_nuevo' })
  declare resultadoNuevo: ResultadoCertificacion

  @column()
  declare motivo: string

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @column.dateTime({ columnName: 'created_at', autoCreate: true })
  declare createdAt: DateTime

  @belongsTo(() => TurnoRtm, { foreignKey: 'turnoId' })
  declare turno: BelongsTo<typeof TurnoRtm>

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>
}
