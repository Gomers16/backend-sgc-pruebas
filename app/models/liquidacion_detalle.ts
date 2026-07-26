// app/models/liquidacion_detalle.ts
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Liquidacion from '#models/liquidacion'
import Comision from '#models/comision'

export default class LiquidacionDetalle extends BaseModel {
  public static table = 'liquidacion_detalle'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'liquidacion_id' })
  declare liquidacionId: number

  @column({ columnName: 'comision_id' })
  declare comisionId: number

  @column()
  declare monto: number

  @belongsTo(() => Liquidacion, { foreignKey: 'liquidacionId' })
  declare liquidacion: BelongsTo<typeof Liquidacion>

  @belongsTo(() => Comision, { foreignKey: 'comisionId' })
  declare comision: BelongsTo<typeof Comision>
}
