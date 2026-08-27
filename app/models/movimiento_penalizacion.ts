// app/models/movimiento_penalizacion.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import AgenteCaptacion from '#models/agente_captacion'
import Ticket from '#models/ticket'
import Comision from '#models/comision'
import Usuario from '#models/usuario'

export type MovimientoPenalizacionTipo = 'CARGO' | 'ABONO'
export type MovimientoPenalizacionOrigenCobro = 'COMISION' | 'NOMINA'

export default class MovimientoPenalizacion extends BaseModel {
  public static table = 'movimientos_penalizacion'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'asesor_id' })
  declare asesorId: number

  @column()
  declare tipo: MovimientoPenalizacionTipo

  @column()
  declare monto: string

  /** Solo si tipo = CARGO. */
  @column({ columnName: 'ticket_id' })
  declare ticketId: number | null

  /** Solo si tipo = ABONO. */
  @column({ columnName: 'origen_cobro' })
  declare origenCobro: MovimientoPenalizacionOrigenCobro | null

  /** Solo si origen_cobro = COMISION. */
  @column({ columnName: 'comision_id' })
  declare comisionId: number | null

  @column()
  declare observacion: string | null

  /** Snapshot de saldo_penalizaciones.saldo_actual DESPUÉS de este movimiento. */
  @column({ columnName: 'saldo_resultante' })
  declare saldoResultante: string

  @column({ columnName: 'creado_por_id' })
  declare creadoPorId: number

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  /* ================== Relaciones ================== */

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'asesorId' })
  declare asesor: BelongsTo<typeof AgenteCaptacion>

  @belongsTo(() => Ticket, { foreignKey: 'ticketId' })
  declare ticket: BelongsTo<typeof Ticket>

  @belongsTo(() => Comision, { foreignKey: 'comisionId' })
  declare comision: BelongsTo<typeof Comision>

  @belongsTo(() => Usuario, { foreignKey: 'creadoPorId' })
  declare creadoPor: BelongsTo<typeof Usuario>
}
