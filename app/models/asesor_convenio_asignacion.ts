import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Convenio from '#models/convenio'
import AgenteCaptacion from '#models/agente_captacion'
import Usuario from '#models/usuario'

export default class AsesorConvenioAsignacion extends compose(BaseModel, SedeScoped) {
  // Multi-sede: 3g, hereda la sede del asesor.
  static sedeVia = { atributo: 'asesorId', columna: 'asesor_id', tablaPadre: 'agentes_captacions' }

  public static table = 'asesor_convenio_asignaciones'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'convenio_id' })
  declare convenioId: number

  @column({ columnName: 'asesor_id' })
  declare asesorId: number

  @column({ columnName: 'asignado_por' })
  declare asignadoPor: number | null

  @column.dateTime({ columnName: 'fecha_asignacion' })
  declare fechaAsignacion: DateTime

  @column.dateTime({ columnName: 'fecha_fin' })
  declare fechaFin: DateTime | null

  @column({ columnName: 'motivo_fin' })
  declare motivoFin: string | null

  @column()
  declare activo: boolean

  // 🔹 FALTABA: flag para garantizar 1 sola activa por convenio
  @column({ columnName: 'actual_flag' })
  declare actualFlag: number | null

  @belongsTo(() => Convenio, { foreignKey: 'convenioId' })
  declare convenio: BelongsTo<typeof Convenio>

  @belongsTo(() => AgenteCaptacion, { foreignKey: 'asesorId' })
  declare asesor: BelongsTo<typeof AgenteCaptacion>

  @belongsTo(() => Usuario, { foreignKey: 'asignadoPor' })
  declare asignador: BelongsTo<typeof Usuario>
}
