// app/models/facturacion_descuento_edicion.ts
//
// Registro de cada edición del descuento de un ticket ya CONFIRMADA (ver
// FacturacionTicketsController.update, modo edición con motivo_edicion).
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import FacturacionTicket from '#models/facturacion_ticket'
import Usuario from '#models/usuario'

/**
 * Qué se hizo con la comisión del dateo del turno al editar:
 *  - RECALCULADA: PENDIENTE o APROBADA; se recalculó con el motor de siempre.
 *  - NO_MODIFICADA: ANULADA, o la comisión no coincide con el dateo actual.
 *  - SIN_CONTINUIDAD: con convenio y sin estado_continuidad guardado en el turno.
 *  - AJUSTADA_TRAS_PAGO: PAGADA o en una liquidación; se recalculó con confirmación.
 *  - SIN_COMISION: el ticket no tiene comisión que recalcular.
 */
export type AccionComisionEdicion =
  | 'RECALCULADA'
  | 'NO_MODIFICADA'
  | 'SIN_CONTINUIDAD'
  | 'SIN_COMISION'
  | 'AJUSTADA_TRAS_PAGO'

const decimal = {
  consume: (v: unknown) => (v === null || v === undefined ? null : Number(v)),
}

export default class FacturacionDescuentoEdicion extends BaseModel {
  public static table = 'facturacion_descuento_ediciones'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'facturacion_ticket_id' })
  declare facturacionTicketId: number

  @column({ columnName: 'descuento_id_anterior' })
  declare descuentoIdAnterior: number | null

  @column({ columnName: 'descuento_id_nuevo' })
  declare descuentoIdNuevo: number | null

  @column({ columnName: 'descuento_nombre_anterior' })
  declare descuentoNombreAnterior: string | null

  @column({ columnName: 'descuento_nombre_nuevo' })
  declare descuentoNombreNuevo: string | null

  @column({ columnName: 'monto_anterior', ...decimal })
  declare montoAnterior: number | null

  @column({ columnName: 'monto_nuevo', ...decimal })
  declare montoNuevo: number | null

  @column({ columnName: 'total_anterior', ...decimal })
  declare totalAnterior: number | null

  @column({ columnName: 'total_nuevo', ...decimal })
  declare totalNuevo: number | null

  @column({ columnName: 'consecutivo_anterior' })
  declare consecutivoAnterior: string | null

  @column({ columnName: 'consecutivo_nuevo' })
  declare consecutivoNuevo: string | null

  @column({ columnName: 'autorizado_por_id_anterior' })
  declare autorizadoPorIdAnterior: number | null

  @column({ columnName: 'autorizado_por_id_nuevo' })
  declare autorizadoPorIdNuevo: number | null

  @column({ columnName: 'observacion_anterior' })
  declare observacionAnterior: string | null

  @column({ columnName: 'observacion_nueva' })
  declare observacionNueva: string | null

  @column()
  declare motivo: string

  @column({ columnName: 'comision_id' })
  declare comisionId: number | null

  @column({ columnName: 'comision_estado' })
  declare comisionEstado: string | null

  @column({ columnName: 'comision_accion' })
  declare comisionAccion: AccionComisionEdicion

  @column({ columnName: 'comision_mensaje' })
  declare comisionMensaje: string | null

  @column({ columnName: 'comision_monto_anterior', ...decimal })
  declare comisionMontoAnterior: number | null

  @column({ columnName: 'comision_monto_nuevo', ...decimal })
  declare comisionMontoNuevo: number | null

  @column({ columnName: 'comision_monto_asesor_anterior', ...decimal })
  declare comisionMontoAsesorAnterior: number | null

  @column({ columnName: 'comision_monto_asesor_nuevo', ...decimal })
  declare comisionMontoAsesorNuevo: number | null

  @column({ columnName: 'comision_monto_convenio_anterior', ...decimal })
  declare comisionMontoConvenioAnterior: number | null

  @column({ columnName: 'comision_monto_convenio_nuevo', ...decimal })
  declare comisionMontoConvenioNuevo: number | null

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @column.dateTime({ columnName: 'created_at', autoCreate: true })
  declare createdAt: DateTime

  @belongsTo(() => FacturacionTicket, { foreignKey: 'facturacionTicketId' })
  declare ticket: BelongsTo<typeof FacturacionTicket>

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>
}
