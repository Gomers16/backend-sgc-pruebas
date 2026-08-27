// app/models/tipo_ticket.ts
import { BaseModel, column, hasMany } from '@adonisjs/lucid/orm'
import type { HasMany } from '@adonisjs/lucid/types/relations'

import Ticket from '#models/ticket'

export default class TipoTicket extends BaseModel {
  public static table = 'tipos_ticket'

  @column({ isPrimary: true })
  declare id: number

  @column()
  declare codigo: string

  @column()
  declare nombre: string

  @column({
    columnName: 'roles_creador',
    prepare: (v: string[]) => JSON.stringify(v),
    consume: (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v),
  })
  declare rolesCreador: string[]

  @column({
    columnName: 'roles_resuelve',
    prepare: (v: string[]) => JSON.stringify(v),
    consume: (v: unknown) => (typeof v === 'string' ? JSON.parse(v) : v),
  })
  declare rolesResuelve: string[]

  @column({ columnName: 'requiere_aprobacion_financiera' })
  declare requiereAprobacionFinanciera: boolean

  /* ================== Relaciones ================== */

  @hasMany(() => Ticket, { foreignKey: 'tipoTicketId' })
  declare tickets: HasMany<typeof Ticket>
}
