// app/models/telemercadeo_gestion.ts
import { DateTime } from 'luxon'
import { BaseModel, column } from '@adonisjs/lucid/orm'

export const MEDIOS_GESTION = ['LLAMADA', 'WHATSAPP', 'SMS', 'CORREO'] as const
export type MedioGestion = (typeof MEDIOS_GESTION)[number]

export const RESULTADOS_GESTION = [
  'SIN_RESPUESTA',
  'NUMERO_EQUIVOCADO',
  'VOLVER_A_LLAMAR',
  'INTERESADO',
  'NO_INTERESADO',
  'YA_REALIZADO',
  'DATEADO',
] as const
export type ResultadoGestion = (typeof RESULTADOS_GESTION)[number]

/** DATEADO solo lo asigna el backend al vincular el dateo. */
export const RESULTADOS_ELEGIBLES: readonly ResultadoGestion[] = RESULTADOS_GESTION.filter(
  (r) => r !== 'DATEADO'
)

/** Gestión de contacto de Telemercadeo. Ver migración 1805000000000. */
export default class TelemercadeoGestion extends BaseModel {
  public static table = 'telemercadeo_gestiones'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'ciclo_id' })
  declare cicloId: number

  @column({ columnName: 'numero_en_ciclo' })
  declare numeroEnCiclo: number

  @column({ columnName: 'agente_id' })
  declare agenteId: number

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number

  @column()
  declare placa: string

  @column()
  declare telefono: string | null

  @column({ columnName: 'cliente_id' })
  declare clienteId: number | null

  @column({ columnName: 'vehiculo_id' })
  declare vehiculoId: number | null

  @column({ columnName: 'servicio_id' })
  declare servicioId: number

  @column()
  declare medio: MedioGestion

  @column({ columnName: 'origen_id' })
  declare origenId: number

  @column()
  declare resultado: ResultadoGestion

  @column({ columnName: 'evidencia_ruta' })
  declare evidenciaRuta: string

  @column()
  declare observacion: string | null

  @column.date({ columnName: 'proximo_contacto_at' })
  declare proximoContactoAt: DateTime | null

  @column({ columnName: 'captacion_dateo_id' })
  declare captacionDateoId: number | null

  @column({ columnName: 'idempotency_key' })
  declare idempotencyKey: string

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
