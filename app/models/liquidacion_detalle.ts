// app/models/liquidacion_detalle.ts
import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import Liquidacion from '#models/liquidacion'
import Comision from '#models/comision'

export default class LiquidacionDetalle extends compose(BaseModel, SedeScoped) {
  // Multi-sede (3d): sin sede_id propio; hereda la de su liquidación.
  static sedeVia = {
    atributo: 'liquidacionId',
    columna: 'liquidacion_id',
    tablaPadre: 'liquidaciones',
  }

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
