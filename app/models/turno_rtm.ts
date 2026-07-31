// app/models/turno_rtm.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'

import Usuario from '#models/usuario'
import Sede from '#models/sede'
import Servicio from '#models/servicio'
import Vehiculo from '#models/vehiculo'
import Cliente from '#models/cliente'
import ClaseVehiculo from '#models/clase_vehiculos'
import AgenteCaptacion from '#models/agente_captacion'
import CaptacionDateo from '#models/captacion_dateo'
import FacturacionTicket from '#models/facturacion_ticket'
import Certificacion from '#models/certificacion'
import Conductor from '#models/conductor'

export type TipoVehiculoUI =
  | 'Liviano Particular'
  | 'Liviano Taxi'
  | 'Liviano Público'
  | 'Motocicleta'

export type MedioEntero = 'Fachada' | 'Redes Sociales' | 'Call Center' | 'Asesor Comercial'
export type EstadoTurno = 'activo' | 'inactivo' | 'cancelado' | 'finalizado'
export type CanalAtribucion = 'FACHADA' | 'ASESOR' | 'TELE' | 'REDES'
export type CanalDateo = 'FACHADA' | 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'TELE' | 'REDES'

export default class TurnoRtm extends BaseModel {
  public static table = 'turnos_rtms'

  @column({ isPrimary: true })
  declare id: number

  // ── FKs base
  @column({ columnName: 'sede_id' })
  declare sedeId: number
  @belongsTo(() => Sede, { foreignKey: 'sedeId' })
  declare sede: BelongsTo<typeof Sede>

  @column({ columnName: 'funcionario_id' })
  declare funcionarioId: number
  @belongsTo(() => Usuario, { foreignKey: 'funcionarioId' })
  declare usuario: BelongsTo<typeof Usuario>

  // ── Etapas de facturación y certificación
  @column({ columnName: 'facturacion_funcionario_id' })
  declare facturacionFuncionarioId: number | null
  @belongsTo(() => Usuario, { foreignKey: 'facturacionFuncionarioId' })
  declare facturacionFuncionario: BelongsTo<typeof Usuario>

  @column({ columnName: 'certificacion_funcionario_id' })
  declare certificacionFuncionarioId: number | null
  @belongsTo(() => Usuario, { foreignKey: 'certificacionFuncionarioId' })
  declare certificacionFuncionario: BelongsTo<typeof Usuario>

  @column({ columnName: 'servicio_id' })
  declare servicioId: number
  @belongsTo(() => Servicio, { foreignKey: 'servicioId' })
  declare servicio: BelongsTo<typeof Servicio>

  // ── Enlaces opcionales
  @column({ columnName: 'vehiculo_id' })
  declare vehiculoId: number | null
  @belongsTo(() => Vehiculo, { foreignKey: 'vehiculoId' })
  declare vehiculo: BelongsTo<typeof Vehiculo>

  @column({ columnName: 'cliente_id' })
  declare clienteId: number | null
  @belongsTo(() => Cliente, { foreignKey: 'clienteId' })
  declare cliente: BelongsTo<typeof Cliente>

  @column({ columnName: 'clase_vehiculo_id' })
  declare claseVehiculoId: number | null
  @belongsTo(() => ClaseVehiculo, { foreignKey: 'claseVehiculoId' })
  declare claseVehiculo: BelongsTo<typeof ClaseVehiculo>

  @column({ columnName: 'conductor_id' })
  declare conductorId: number | null
  @belongsTo(() => Conductor, { foreignKey: 'conductorId' })
  declare conductor: BelongsTo<typeof Conductor>

  @column({ columnName: 'agente_captacion_id' })
  declare agenteCaptacionId: number | null
  @belongsTo(() => AgenteCaptacion, { foreignKey: 'agenteCaptacionId' })
  declare agenteCaptacion: BelongsTo<typeof AgenteCaptacion>

  @column({ columnName: 'captacion_dateo_id' })
  declare captacionDateoId: number | null
  @belongsTo(() => CaptacionDateo, { foreignKey: 'captacionDateoId' })
  declare captacionDateo: BelongsTo<typeof CaptacionDateo>

  // ── Datos del turno
  @column.dateTime({ columnName: 'fecha', serializeAs: 'fecha' })
  declare fecha: DateTime

  @column({ columnName: 'hora_ingreso' })
  declare horaIngreso: string

  @column({ columnName: 'hora_salida' })
  declare horaSalida: string | null

  @column({ columnName: 'tiempo_servicio' })
  declare tiempoServicio: string | null

  @column({ columnName: 'hora_facturacion' })
  declare horaFacturacion: string | null

  @column({ columnName: 'tiene_facturacion' })
  declare tieneFacturacion: boolean

  @column({ columnName: 'turno_numero' })
  declare turnoNumero: number

  @column({ columnName: 'turno_numero_servicio' })
  declare turnoNumeroServicio: number

  @column({ columnName: 'turno_codigo' })
  declare turnoCodigo: string

  @column()
  declare placa: string

  @column({ columnName: 'tipo_vehiculo' })
  declare tipoVehiculo: TipoVehiculoUI

  @column({
    columnName: 'medio_entero',
    serialize: (value?: MedioEntero | null) => value ?? null,
  })
  declare medioEntero: MedioEntero | null

  @column()
  declare observaciones: string | null

  // ── Campos del dateo
  @column({ columnName: 'dateo_observacion' })
  declare dateoObservacion: string | null

  @column({ columnName: 'dateo_imagen_url' })
  declare dateoImagenUrl: string | null

  @column({
    columnName: 'dateo_canal',
    serialize: (value?: CanalDateo | null) => value ?? null,
  })
  declare dateoCanal: CanalDateo | null

  @column({
    columnName: 'canal_atribucion',
    serialize: (value?: CanalAtribucion | null) => value ?? null,
  })
  declare canalAtribucion: CanalAtribucion | null

  @column()
  declare estado: EstadoTurno

  // ── 🆕 Campos de recurrencia y recuperación
  /**
   * 🔄 RECURRENTE: el cliente vino hace MENOS de mesesMinimos (ej. < 24 meses)
   * → Comisión reducida (valor_dateo_recurrencia, ej. $4,300)
   */
  @column({ columnName: 'es_recurrente' })
  declare esRecurrente: boolean

  /**
   * 💛 RECUPERACIÓN: el cliente vino hace MÁS de mesesMinimos (ej. >= 24 meses)
   * → Ya estaba en la base pero tardó mucho en regresar
   * → Comisión intermedia (valor_dateo_recuperacion, ej. $8,600)
   */
  @column({ columnName: 'es_recuperacion' })
  declare esRecuperacion: boolean

  // Cuántos meses pasaron desde la última visita de este cliente/conductor
  @column({ columnName: 'meses_desde_ultima_visita' })
  declare mesesDesdeUltimaVisita: number | null

  // ID del turno anterior de referencia (para trazabilidad)
  @column({ columnName: 'ultimo_turno_id' })
  declare ultimoTurnoId: number | null

  // Fecha de ese turno anterior (para mostrar en UI sin hacer JOIN)
  @column.date({ columnName: 'fecha_ultima_visita' })
  declare fechaUltimaVisita: DateTime | null

  // ========== 🆕 AVANCE ==========
  /**
   * es_avance: heredado del dateo al crear el turno.
   * true → caja debe aplicar descuento AVANCE al ticket;
   *        monto_convenio de la comisión queda en $0.
   */
  @column({ columnName: 'es_avance' })
  declare esAvance: boolean
  // ========== FIN AVANCE ==========

  /**
   * Resultado guardado de la evaluación de continuidad de asesor convenio
   * (ver turnos_rtms_controller.ts). NULL cuando no aplica a este turno.
   */
  @column({ columnName: 'estado_continuidad' })
  declare estadoContinuidad: 'CONTINUA' | 'ROTA' | 'SIN_EVIDENCIA' | null

  @column({ columnName: 'reasignado_de_turno_id' })
  declare reasignadoDeTurnoId: number | null

  @column({ columnName: 'rep_general_verificado' })
  declare repGeneralVerificado: boolean

  // ── Timestamps
  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime

  // ── Relaciones de facturación y certificación
  @hasMany(() => FacturacionTicket, { foreignKey: 'turnoId' })
  declare facturacionTickets: HasMany<typeof FacturacionTicket>

  @hasMany(() => Certificacion, { foreignKey: 'turnoId' })
  declare certificaciones: HasMany<typeof Certificacion>
}
