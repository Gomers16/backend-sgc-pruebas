// app/models/ticket_detalle_excepcion_dateo.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Ticket from '#models/ticket'
import TurnoRtm from '#models/turno_rtm'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'
import Descuento from '#models/descuento'

export default class TicketDetalleExcepcionDateo extends BaseModel {
  public static table = 'tickets_detalle_excepcion_dateo'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'ticket_id' })
  declare ticketId: number

  @column({ columnName: 'turno_id' })
  declare turnoId: number

  @column()
  declare placa: string

  @column({ columnName: 'comercial_id' })
  declare comercialId: number

  @column({ columnName: 'convenio_id' })
  declare convenioId: number | null

  /** Snapshot de turno.hora_ingreso ('HH:mm:ss') al crear el ticket. */
  @column({ columnName: 'hora_ingreso' })
  declare horaIngreso: string

  @column.dateTime({ columnName: 'hora_intento_dateo' })
  declare horaIntentoDateo: DateTime

  @column({ columnName: 'minutos_totales' })
  declare minutosTotales: number

  @column({ columnName: 'minutos_exceso' })
  declare minutosExceso: number

  /** Snapshot calculado y persistido AL CREAR el ticket — no se recalcula. */
  @column({ columnName: 'dentro_ventana' })
  declare dentroVentana: boolean

  @column()
  declare observacion: string

  @column({ columnName: 'evidencia_chat_url' })
  declare evidenciaChatUrl: string

  @column({ columnName: 'evidencia_grupo_whatsapp_url' })
  declare evidenciaGrupoWhatsappUrl: string

  @column({ columnName: 'evidencia_bloqueo_url' })
  declare evidenciaBloqueoUrl: string

  @column({ columnName: 'evidencia_calamidad_url' })
  declare evidenciaCalamidadUrl: string | null

  /* ── Intento de dateo (lo que store() rechazó con REQUIERE_TICKET_DATEO).
   *    NULL en tickets anteriores a la migración 1796000000000. ── */

  @column()
  declare canal: 'FACHADA' | 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'TELE' | 'REDES' | null

  @column({ columnName: 'servicio_id' })
  declare servicioId: number | null

  @column({ columnName: 'descuento_id' })
  declare descuentoId: number | null

  /** TINYINT(1): mysql2 lo entrega como 0/1 — leer con Boolean(). */
  @column({ columnName: 'es_avance' })
  declare esAvance: boolean

  @column({ columnName: 'comprobante_avance_url' })
  declare comprobanteAvanceUrl: string | null

  @column()
  declare telefono: string | null

  /** Convenio pedido al crear; convenio_id puede cambiar si gerencia lo corrige al aprobar. */
  @column({ columnName: 'convenio_id_original' })
  declare convenioIdOriginal: number | null

  /**
   * Solo relevante fuera de ventana — dentro de ventana la comisión siempre
   * es completa y esta columna queda null. Se llena al aprobar (PATCH
   * /tickets-excepcion-dateo/:id/aprobar).
   */
  @column({ columnName: 'con_comision' })
  declare conComision: boolean | null

  @column({ columnName: 'aprobado_por_id' })
  declare aprobadoPorId: number | null

  @column.dateTime({ columnName: 'aprobado_at' })
  declare aprobadoAt: DateTime | null

  @column({ columnName: 'motivo_rechazo' })
  declare motivoRechazo: string | null

  @column({ columnName: 'rechazado_por_id' })
  declare rechazadoPorId: number | null

  @column.dateTime({ columnName: 'rechazado_at' })
  declare rechazadoAt: DateTime | null

  /* ================== Relaciones ================== */

  @belongsTo(() => Ticket, { foreignKey: 'ticketId' })
  declare ticket: BelongsTo<typeof Ticket>

  @belongsTo(() => TurnoRtm, { foreignKey: 'turnoId' })
  declare turno: BelongsTo<typeof TurnoRtm>

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'comercialId' })
  declare comercial: BelongsTo<typeof AgenteCaptacion>

  @belongsTo(() => Convenio, { foreignKey: 'convenioId' })
  declare convenio: BelongsTo<typeof Convenio>

  @belongsTo(() => Convenio, { foreignKey: 'convenioIdOriginal' })
  declare convenioOriginal: BelongsTo<typeof Convenio>

  @belongsTo(() => Servicio, { foreignKey: 'servicioId' })
  declare servicio: BelongsTo<typeof Servicio>

  @belongsTo(() => Descuento, { foreignKey: 'descuentoId' })
  declare descuento: BelongsTo<typeof Descuento>

  @belongsTo(() => Usuario, { foreignKey: 'aprobadoPorId' })
  declare aprobadoPor: BelongsTo<typeof Usuario>

  @belongsTo(() => Usuario, { foreignKey: 'rechazadoPorId' })
  declare rechazadoPor: BelongsTo<typeof Usuario>
}
