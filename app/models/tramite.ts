// app/models/tramite.ts
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo, hasOne } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasOne } from '@adonisjs/lucid/types/relations'

import Usuario from '#models/usuario'
import Sede from '#models/sede'
import Servicio from '#models/servicio'
import FormularioRunt from '#models/formulario_runt'
import TramiteLiquidacion from '#models/tramite_liquidacion'

export type TipoTramite =
  | 'MATRICULA_REGISTRO'
  | 'TRASPASO'
  | 'TRASLADO_MATRICULA_REGISTRO'
  | 'RADICADO_MATRICULA_REGISTRO'
  | 'CAMBIO_COLOR'
  | 'CAMBIO_SERVICIO'
  | 'REGRABAR_MOTOR'
  | 'REGRABAR_CHASIS'
  | 'TRANSFORMACION'
  | 'DUPLICADO_LICENCIA_TRANSITO'
  | 'INSCRIPCION_PRENDA'
  | 'LEVANTA_PRENDA'
  | 'CANCELACION_MATRICULA_REGISTRO'
  | 'CAMBIO_PLACAS'
  | 'DUPLICADO_PLACAS'
  | 'REMATRICULA'
  | 'CAMBIO_CARROCERIA'
  | 'OTROS'

export type EstadoTramite = 'en_espera' | 'en_atencion' | 'completado' | 'cancelado'

export default class Tramite extends compose(BaseModel, SedeScoped) {
  // Multi-sede: 3f, sede_id propio; el mixin la pone al crear.

  public static table = 'tramites'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'sede_id' })
  declare sedeId: number
  @belongsTo(() => Sede, { foreignKey: 'sedeId' })
  declare sede: BelongsTo<typeof Sede>

  @column({ columnName: 'funcionario_id' })
  declare funcionarioId: number
  @belongsTo(() => Usuario, { foreignKey: 'funcionarioId' })
  declare funcionario: BelongsTo<typeof Usuario>

  @column({ columnName: 'servicio_id' })
  declare servicioId: number
  @belongsTo(() => Servicio, { foreignKey: 'servicioId' })
  declare servicio: BelongsTo<typeof Servicio>

  // ── Solicitante
  @column({ columnName: 'nombre_cliente' })
  declare nombreCliente: string

  @column()
  declare cedula: string

  @column()
  declare telefono: string | null

  @column()
  declare email: string | null

  // ── Turno
  @column({ columnName: 'turno_numero' })
  declare turnoNumero: number

  @column({ columnName: 'turno_codigo' })
  declare turnoCodigo: string

  // ── Placa del vehículo
  @column()
  declare placa: string | null

  // ── Tipo y estado
  @column({ columnName: 'tipo_tramite' })
  declare tipoTramite: TipoTramite | null

  @column()
  declare estado: EstadoTramite

  // ── Tiempos
  @column.date({ columnName: 'fecha' })
  declare fecha: DateTime

  @column({ columnName: 'hora_ingreso' })
  declare horaIngreso: string

  @column({ columnName: 'hora_atencion' })
  declare horaAtencion: string | null

  @column({ columnName: 'hora_fin' })
  declare horaFin: string | null

  @column({ columnName: 'tiempo_atencion' })
  declare tiempoAtencion: string | null

  // ── Pago
  @column({ columnName: 'estado_pago' })
  declare estadoPago: 'pendiente' | 'pagado' | 'exento' | null

  @column({ columnName: 'valor_liquidado' })
  declare valorLiquidado: number | null

  @column({ columnName: 'forma_pago_cobro' })
  declare formaPagoCobro: string | null

  @column({ columnName: 'referencia_pago' })
  declare referenciaPago: string | null

  @column({ columnName: 'evidencia_pago_url' })
  declare evidenciaPagoUrl: string | null

  @column.dateTime({ columnName: 'fecha_pago' })
  declare fechaPago: DateTime | null

  // ── Campos de traspaso
  @column({ columnName: 'valor_vehiculo' })
  declare valorVehiculo: number | null

  @column({ columnName: 'forma_pago' })
  declare formaPago: string | null

  @column.date({ columnName: 'fecha_entrega' })
  declare fechaEntrega: DateTime | null

  @column({ columnName: 'destrate' })
  declare destrate: number | null

  @column({ columnName: 'incluye_compraventa' })
  declare incluyeCompraventa: boolean | null

  // ── Notas
  @column()
  declare observaciones: string | null

  @column()
  declare resultado: string | null

  @hasOne(() => FormularioRunt, { foreignKey: 'tramiteId' })
  declare formularioRunt: HasOne<typeof FormularioRunt>

  @hasOne(() => TramiteLiquidacion, { foreignKey: 'tramiteId' })
  declare liquidacion: HasOne<typeof TramiteLiquidacion>

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
