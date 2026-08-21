// app/models/comision.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import CaptacionDateo from '#models/captacion_dateo'
import Convenio from '#models/convenio'
import AgenteCaptacion from '#models/agente_captacion'

export type ComisionEstado = 'PENDIENTE' | 'APROBADA' | 'PAGADA' | 'ANULADA'
export type ComisionTipoServicio = 'RTM' | 'TECNOMECANICA' | 'PREVENTIVA' | 'SOAT' | 'OTRO'
export type ComisionTipoVehiculo = 'MOTO' | 'VEHICULO'

export default class Comision extends BaseModel {
  public static table = 'comisiones'

  @column({ isPrimary: true })
  declare id: number

  /**
   * Si es comisión real:
   *  - captacionDateoId → id del dateo en captacion_dateos
   * Si es fila de configuración (esConfig = true):
   *  - captacionDateoId → null
   */
  @column({ columnName: 'captacion_dateo_id' })
  declare captacionDateoId: number | null

  @column({ columnName: 'asesor_id' })
  declare asesorId: number | null

  @column({ columnName: 'convenio_id' })
  declare convenioId: number | null

  @column({ columnName: 'tipo_servicio' })
  declare tipoServicio: ComisionTipoServicio

  @column({ columnName: 'tipo_vehiculo' })
  declare tipoVehiculo: ComisionTipoVehiculo | null

  /**
   * BASE = incentivo convenio / comisión por placa (FALLBACK GLOBAL).
   * Se usa cuando no hay valor específico por tipo de vehículo.
   * - Asesor convenio datea cliente nuevo  → base = $14.000 (incentivo)
   * - Comercial datea con convenio         → base = $14.000 (incentivo para convenio)
   */
  @column()
  declare base: string

  @column()
  declare porcentaje: string

  /**
   * MONTO = comisión por dateo.
   * - Cliente nuevo via convenio     → $8.600  (dateo normal)
   * - Cliente recurrente             → valor recurrente (< 24 meses)
   * - Cliente recuperación           → valor recuperación (>= 24 meses)
   * - Asesor convenio datea nuevo    → $0 (solo cobra incentivo en base)
   */
  @column()
  declare monto: string

  /**
   * VALOR_NUEVO_DIRECTO:
   *  - Comisión cuando el comercial trae un cliente NUEVO sin convenio ($17.200).
   *  - Solo aplica en configs (es_config = true) y comisiones reales sin convenio
   *    donde el cliente es nuevo.
   */
  @column({ columnName: 'valor_nuevo_directo' })
  declare valorNuevoDirecto: string

  /**
   * 🆕 VALOR_PLACA_VEHICULO:
   *  - Incentivo específico para CARROS en configs (es_config = true).
   *  - Si es null → se usa `base` como fallback.
   */
  @column({ columnName: 'valor_placa_vehiculo' })
  declare valorPlacaVehiculo: string | null

  /**
   * 🆕 VALOR_PLACA_MOTO:
   *  - Incentivo específico para MOTOS en configs (es_config = true).
   *  - Si es null → se usa `base` como fallback.
   */
  @column({ columnName: 'valor_placa_moto' })
  declare valorPlacaMoto: string | null

  // ========== 💰 DESGLOSE INTERNO ==========

  /** Lo que cobra el asesor comercial por el DATEO. */
  @column({ columnName: 'monto_asesor' })
  declare montoAsesor: string | null

  /** Lo que cobra el dueño del convenio (incentivo). */
  @column({ columnName: 'monto_convenio' })
  declare montoConvenio: string | null

  /** ID del asesor del convenio (quien recibe montoConvenio). */
  @column({ columnName: 'asesor_secundario_id' })
  declare asesorSecundarioId: number | null

  // ========== FIN DESGLOSE ==========

  @column({ columnName: 'meta_rtm' })
  declare metaRtm: number

  @column({ columnName: 'valor_rtm_moto' })
  declare valorRtmMoto: number

  @column({ columnName: 'valor_rtm_vehiculo' })
  declare valorRtmVehiculo: number

  @column({ columnName: 'porcentaje_comision_meta' })
  declare porcentajeComisionMeta: string

  @column()
  declare estado: ComisionEstado

  /**
   * esConfig:
   *  - false → comisión real
   *  - true  → fila de configuración (valores editables en UI)
   */
  @column({ columnName: 'es_config' })
  declare esConfig: boolean

  @column.dateTime({ columnName: 'fecha_calculo' })
  declare fechaCalculo: DateTime

  @column({ columnName: 'calculado_por' })
  declare calculadoPor: number | null

  // ========== 📋 CICLO DE VIDA ==========
  @column.dateTime({ columnName: 'aprobado_at' })
  declare aprobadoAt: DateTime | null

  @column({ columnName: 'aprobado_por' })
  declare aprobadoPor: number | null

  @column.dateTime({ columnName: 'pagado_at' })
  declare pagadoAt: DateTime | null

  @column({ columnName: 'pagado_por' })
  declare pagadoPor: number | null

  @column.dateTime({ columnName: 'anulado_at' })
  declare anuladoAt: DateTime | null

  @column({ columnName: 'anulado_por' })
  declare anuladoPor: number | null

  @column()
  declare observacion: string | null
  // ========== FIN CICLO DE VIDA ==========

  // ========== 🔄 CAMPOS DE RECURRENCIA ==========
  @column({ columnName: 'descuento_recurrencia_aplicado' })
  declare descuentoRecurrenciaAplicado: boolean

  @column({ columnName: 'tipo_descuento_recurrencia' })
  declare tipoDescuentoRecurrencia: 'PORCENTAJE' | 'VALOR_FIJO' | null

  @column({ columnName: 'valor_descuento_recurrencia' })
  declare valorDescuentoRecurrencia: number | null

  @column({ columnName: 'monto_original_dateo' })
  declare montoOriginalDateo: number | null

  @column({ columnName: 'monto_original_placa' })
  declare montoOriginalPlaca: number | null
  // ========== FIN RECURRENCIA ==========

  // ========== 🆕 AVANCE ==========
  /**
   * es_avance: heredado del dateo/turno. Cuando true:
   *   - base                     = incentivo original (valorIncentivoPorTipo, ej: $20.000)
   *   - descuento_monto_aplicado = monto real cobrado al cliente (ej: $6.000)
   *   - monto_convenio           = base - descuento_monto_aplicado (ej: $14.000)
   *   - monto_asesor             = intacto
   * Sirve de trazabilidad para contabilidad.
   */
  @column({ columnName: 'es_avance' })
  declare esAvance: boolean

  /**
   * Monto real del avance cobrado al cliente en caja.
   * Guardado directamente en la comisión para trazabilidad
   * sin depender de la cadena ticket → dateo.
   */
  @column({ columnName: 'descuento_monto_aplicado' })
  declare descuentoMontoAplicado: number | null
  // ========== FIN AVANCE ==========

  // ========== 🆕 SINCRONIZACIÓN DESCUENTO REAL EN CAJA ==========
  /**
   * Código real del descuento aplicado en caja (ej. 'AVANCE_PROPIETARIO'),
   * copiado desde facturacion_tickets.descuento_id en applyCommissionHook()
   * o desde el payload de POST /comisiones (creación manual). Snapshot —
   * no se recalcula si el ticket cambia después.
   */
  @column({ columnName: 'descuento_codigo_aplicado' })
  declare descuentoCodigoAplicado: string | null

  /** Nota libre de la cajera, copiada desde facturacion_tickets.descuento_observacion. */
  @column({ columnName: 'descuento_observacion_caja' })
  declare descuentoObservacionCaja: string | null

  /**
   * Texto de la regla de comision_calculo_service.calcularComision() que
   * determinó el monto de esta comisión — solo se persiste desde las 3
   * ramas de applyCommissionHook() (facturacion_tickets_controller.ts).
   * null en comisiones creadas manualmente (POST /comisiones) o antes de
   * este campo existir.
   */
  @column({ columnName: 'regla_aplicada' })
  declare reglaAplicada: string | null
  // ========== FIN SINCRONIZACIÓN DESCUENTO EN CAJA ==========

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  /* ================== Relaciones ================== */

  @belongsTo(() => CaptacionDateo, { foreignKey: 'captacionDateoId' })
  declare dateo: BelongsTo<typeof CaptacionDateo>

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'asesorId' })
  declare asesor: BelongsTo<typeof AgenteCaptacion>

  @belongsTo(() => Convenio, { foreignKey: 'convenioId' })
  declare convenio: BelongsTo<typeof Convenio>

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'asesorSecundarioId' })
  declare asesorSecundario: BelongsTo<typeof AgenteCaptacion>

  valorTotal: any
}
