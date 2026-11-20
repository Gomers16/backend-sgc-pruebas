// app/models/comprobante_pago.ts
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Usuario from '#models/usuario'

export default class ComprobantePago extends compose(BaseModel, SedeScoped) {
  public static table = 'comprobantes_pago'

  // Multi-sede (3d): un comprobante es de UNA sede (la de sus comisiones).
  @column({ columnName: 'sede_id' })
  declare sedeId: number | null

  @column({ isPrimary: true })
  declare id: number
  // id = número de comprobante secuencial

  @column.date({ columnName: 'periodo_desde' })
  declare periodoDes: DateTime | null

  @column.date({ columnName: 'periodo_hasta' })
  declare periodoHasta: DateTime | null

  @column({ columnName: 'beneficiario_tipo' })
  declare beneficiarioTipo: 'CONVENIO' | 'ASESOR'

  @column({ columnName: 'beneficiario_id' })
  declare beneficiarioId: number | null

  @column({ columnName: 'beneficiario_nombre' })
  declare beneficiarioNombre: string

  @column({ columnName: 'medio_pago' })
  declare medioPago: string | null

  @column()
  declare telefono: string | null

  @column({ columnName: 'total_motos' })
  declare totalMotos: number

  @column({ columnName: 'total_vehiculos' })
  declare totalVehiculos: number

  @column({ columnName: 'total_dateo' })
  declare totalDateo: number

  @column({ columnName: 'total_incentivo' })
  declare totalIncentivo: number

  @column({ columnName: 'total_general' })
  declare totalGeneral: number

  @column({
    columnName: 'comision_ids',
    prepare: (v) => JSON.stringify(v),
    consume: (v) => (typeof v === 'string' ? JSON.parse(v) : v),
  })
  declare comisionIds: number[]

  @column({ columnName: 'placas_snapshot' })
  declare placasSnapshot: string | null

  @column({ columnName: 'filtro_estado' })
  declare filtroEstado: string | null

  @column({ columnName: 'filtro_tipo_vehiculo' })
  declare filtroTipoVehiculo: string | null

  @column({ columnName: 'evidencia_url' })
  declare evidenciaUrl: string | null

  @column({ columnName: 'generado_por' })
  declare generadoPor: number | null

  @column()
  declare notas: string | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime

  @belongsTo(() => Usuario, { foreignKey: 'generadoPor' })
  declare generador: BelongsTo<typeof Usuario>
}
