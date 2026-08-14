// app/models/captacion_dateo.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, beforeSave, computed } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import Prospecto from '#models/prospecto'
import Vehiculo from '#models/vehiculo'
import Cliente from '#models/cliente'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Descuento from '#models/descuento'
import Servicio from '#models/servicio'

export type Canal = 'FACHADA' | 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'TELE' | 'REDES'
export type Origen = 'UI' | 'WHATSAPP' | 'IMPORT'
export type ResultadoDateo =
  | 'PENDIENTE'
  | 'EN_PROCESO'
  | 'EXITOSO'
  | 'NO_EXITOSO'
  | 'RE_DATEAR'
  | 'REEMPLAZADO'

// === Helpers TTL usados por controladores y computados ===
function ttlSinConsumir(): number {
  return Number(process.env.TTL_SIN_CONSUMIR_DIAS ?? 7)
}
function ttlPostConsumo(): number {
  return Number(process.env.TTL_POST_CONSUMO_DIAS ?? 365)
}
function normalizePlaca(v?: string | null) {
  return v ? v.replace(/[\s-]/g, '').toUpperCase() : (v ?? null)
}
function normalizePhone(v?: string | null) {
  return v ? v.replace(/\D/g, '') : (v ?? null)
}

export default class CaptacionDateo extends BaseModel {
  public static table = 'captacion_dateos'

  @column({ isPrimary: true })
  declare id: number

  // Origen / Canal
  @column()
  declare canal: Canal

  @column({ columnName: 'agente_id' })
  declare agenteId: number | null

  // Datos captados
  @column()
  declare placa: string | null

  @column()
  declare telefono: string | null

  @column()
  declare origen: Origen

  @column()
  declare observacion: string | null

  // Imagen (opcional)
  @column({ columnName: 'imagen_url' })
  declare imagenUrl: string | null

  @column({ columnName: 'imagen_mime' })
  declare imagenMime: string | null

  @column({ columnName: 'imagen_tamano_bytes' })
  declare imagenTamanoBytes: number | null

  @column({ columnName: 'imagen_hash' })
  declare imagenHash: string | null

  @column({ columnName: 'imagen_origen_id' })
  declare imagenOrigenId: string | null

  @column({ columnName: 'imagen_subida_por' })
  declare imagenSubidaPor: number | null

  // Consumo por turno
  @column({ columnName: 'consumido_turno_id' })
  declare consumidoTurnoId: number | null

  @column.dateTime({ columnName: 'consumido_at' })
  declare consumidoAt: DateTime | null

  @column({ columnName: 'payload_hash' })
  declare payloadHash: string | null

  // Vínculos comerciales
  @column({ columnName: 'convenio_id' })
  declare convenioId: number | null

  @column({ columnName: 'asesor_convenio_id' })
  declare asesorConvenioId: number | null

  @column({ columnName: 'asesor_convenio_usuario_id' })
  declare asesorConvenioUsuarioId: number | null

  @column({ columnName: 'prospecto_id' })
  declare prospectoId: number | null

  @column({ columnName: 'vehiculo_id' })
  declare vehiculoId: number | null

  @column({ columnName: 'cliente_id' })
  declare clienteId: number | null

  // Resultado
  @column()
  declare resultado: ResultadoDateo

  @column()
  declare liberado: boolean

  @column({ columnName: 'motivo_no_exitoso' })
  declare motivoNoExitoso: string | null

  @column({ columnName: 'detectado_por_convenio' })
  declare detectadoPorConvenio: boolean

  // ========== 🔄 CAMPOS DE RECURRENCIA ==========
  @column({ columnName: 'es_cliente_recurrente' })
  declare esClienteRecurrente: boolean

  @column({ columnName: 'meses_desde_ultima_visita' })
  declare mesesDesdeUltimaVisita: number | null

  @column({ columnName: 'turno_recurrente_id' })
  declare turnoRecurrenteId: number | null
  // ========== FIN RECURRENCIA ==========

  // 🆕 Descuento informativo pre-marcado por el comercial
  @column({ columnName: 'descuento_id' })
  declare descuentoId: number | null

  // ========== 🆕 AVANCE ==========
  /**
   * es_avance:
   *   true  → el asesor convenio (o el comercial en su nombre) solicitó
   *           un avance. El incentivo (monto_convenio) se aplica como
   *           descuento variable a la factura; el asesor convenio NO cobra.
   *   false → comportamiento normal (default).
   */
  @column({ columnName: 'es_avance' })
  declare esAvance: boolean

  /**
   * comprobante_avance_url:
   *   Path del screenshot de WhatsApp donde el convenio solicitó el avance
   *   al asesor comercial.
   *   - Obligatorio cuando esAvance = true Y canal = ASESOR_COMERCIAL.
   *   - Null cuando es el propio ASESOR_CONVENIO quien datéa.
   */
  @column({ columnName: 'comprobante_avance_url' })
  declare comprobanteAvanceUrl: string | null
  // ========== FIN AVANCE ==========

  // ========== 🆕 EXCEPCIÓN RTM_VIGENTE (SUPER_ADMIN / GERENCIA) ==========
  @column({ columnName: 'aprobado_excepcion_por' })
  declare aprobadoExcepcionPor: number | null

  @column.dateTime({ columnName: 'aprobado_excepcion_at' })
  declare aprobadoExcepcionAt: DateTime | null
  // ========== FIN EXCEPCIÓN ==========

  // ========== 🆕 RE-DATEAR CON EVIDENCIA ==========
  @column({ columnName: 'numero_redateos_usados' })
  declare numeroRedateosUsados: number

  @column.dateTime({ columnName: 'redateado_at' })
  declare redateadoAt: DateTime | null

  @column({ columnName: 'limite_alcanzado' })
  declare limiteAlcanzado: boolean
  // ========== FIN RE-DATEAR ==========

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  // ===== Relaciones =====

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'agenteId' })
  declare agente: BelongsTo<typeof AgenteCaptacion>

  @belongsTo(() => Convenio, { foreignKey: 'convenioId' })
  declare convenio: BelongsTo<typeof Convenio>

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'asesorConvenioId' })
  declare asesorConvenio: BelongsTo<typeof AgenteCaptacion>

  @belongsTo(() => Usuario, { foreignKey: 'asesorConvenioUsuarioId' })
  declare asesorConvenioUsuario: BelongsTo<typeof Usuario>

  @belongsTo(() => Prospecto, { foreignKey: 'prospectoId' })
  declare prospecto: BelongsTo<typeof Prospecto>

  @belongsTo(() => Vehiculo, { foreignKey: 'vehiculoId' })
  declare vehiculo: BelongsTo<typeof Vehiculo>

  @belongsTo(() => Cliente, { foreignKey: 'clienteId' })
  declare cliente: BelongsTo<typeof Cliente>

  @belongsTo(() => TurnoRtm, { foreignKey: 'consumidoTurnoId' })
  declare turno: BelongsTo<typeof TurnoRtm>

  // 🆕
  @belongsTo(() => Descuento, { foreignKey: 'descuentoId' })
  declare descuento: BelongsTo<typeof Descuento>

  // 🆕 Servicio para el que se datéa
  @column({ columnName: 'servicio_id' })
  declare servicioId: number | null

  @belongsTo(() => Servicio, { foreignKey: 'servicioId' })
  declare servicio: BelongsTo<typeof Servicio>

  // 🆕 Usuario que aprobó la excepción de días RTM_VIGENTE
  @belongsTo(() => Usuario, { foreignKey: 'aprobadoExcepcionPor' })
  declare aprobadoExcepcionUsuario: BelongsTo<typeof Usuario>

  // ===== Normalización =====
  @beforeSave()
  public static normalize(d: CaptacionDateo) {
    d.placa = normalizePlaca(d.placa)
    d.telefono = normalizePhone(d.telefono)
  }

  // ===== Computados =====
  @computed()
  public get bloqueadoHasta(): string | null {
    if (!this.createdAt) return null
    const base = this.consumidoTurnoId && this.consumidoAt ? this.consumidoAt : this.createdAt
    const days = this.consumidoTurnoId && this.consumidoAt ? ttlPostConsumo() : ttlSinConsumir()
    return base.plus({ days }).toISO()
  }

  @computed()
  public get bloqueado(): boolean {
    if (!this.createdAt) return false
    const base = this.consumidoTurnoId && this.consumidoAt ? this.consumidoAt : this.createdAt
    const days = this.consumidoTurnoId && this.consumidoAt ? ttlPostConsumo() : ttlSinConsumir()
    return DateTime.now() < base.plus({ days })
  }
}
