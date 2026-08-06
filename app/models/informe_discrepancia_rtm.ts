// app/models/informe_discrepancia_rtm.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Usuario from '#models/usuario'

/**
 * Las filas de tipo2/3/6/7 y los `turnos` dentro de duplicados_finalizado
 * traen, además de sus campos propios, la trazabilidad agregada por
 * DiscrepanciasRtmService.enrichConResponsables(): responsablePuerta,
 * responsableFacturacion, responsableCertificacion, etapaDondeSeQuedo.
 * Informes generados antes de esa función no tienen esos campos.
 */
export interface DetalleDiscrepanciasRtm {
  tipo1_placa_mal_digitada: unknown[]
  tipo2_activo_debe_finalizar: unknown[]
  tipo3_turno_fantasma: unknown[]
  tipo4_servicio_mal_asignado: unknown[]
  tipo5_falta_en_sgc: unknown[]
  tipo6_alerta_cobro_no_registrado: unknown[]
  tipo7_finalizado_sin_rastro_tecno: unknown[]
  duplicados_finalizado: unknown[]
  ambiguos_revisar_manual: unknown[]
}

export default class InformeDiscrepanciaRtm extends BaseModel {
  public static table = 'informes_discrepancias_rtm'

  @column({ isPrimary: true })
  declare id: number

  @column.date({ columnName: 'fecha_inicio' })
  declare fechaInicio: DateTime

  @column.date({ columnName: 'fecha_fin' })
  declare fechaFin: DateTime

  @column({ columnName: 'archivo_nombre' })
  declare archivoNombre: string | null

  @column({ columnName: 'filas_csv_total' })
  declare filasCsvTotal: number | null

  @column({ columnName: 'generado_por_id' })
  declare generadoPorId: number | null
  @belongsTo(() => Usuario, { foreignKey: 'generadoPorId' })
  declare generadoPor: BelongsTo<typeof Usuario>

  @column.dateTime({ columnName: 'generado_at' })
  declare generadoAt: DateTime

  @column({ columnName: 'total_tecno_valido' })
  declare totalTecnoValido: number

  @column({ columnName: 'total_sgc_finalizados' })
  declare totalSgcFinalizados: number

  @column({ columnName: 'total_coinciden' })
  declare totalCoinciden: number

  @column({ columnName: 'total_tipo1_placa_mal_digitada' })
  declare totalTipo1PlacaMalDigitada: number

  @column({ columnName: 'total_tipo2_activo_debe_finalizar' })
  declare totalTipo2ActivoDebeFinalizar: number

  @column({ columnName: 'total_tipo3_turno_fantasma' })
  declare totalTipo3TurnoFantasma: number

  @column({ columnName: 'total_tipo4_servicio_mal_asignado' })
  declare totalTipo4ServicioMalAsignado: number

  @column({ columnName: 'total_tipo5_falta_en_sgc' })
  declare totalTipo5FaltaEnSgc: number

  @column({ columnName: 'total_tipo6_alerta_cobro_no_registrado' })
  declare totalTipo6AlertaCobroNoRegistrado: number

  @column({ columnName: 'total_tipo7_finalizado_sin_rastro_tecno' })
  declare totalTipo7FinalizadoSinRastroTecno: number

  @column({ columnName: 'total_duplicados_finalizado' })
  declare totalDuplicadosFinalizado: number

  @column({ columnName: 'total_ambiguos_revisar_manual' })
  declare totalAmbiguosRevisarManual: number

  @column({
    columnName: 'detalle_json',
    prepare: (v) => JSON.stringify(v),
    consume: (v) => (typeof v === 'string' ? JSON.parse(v) : v),
  })
  declare detalleJson: DetalleDiscrepanciasRtm

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
