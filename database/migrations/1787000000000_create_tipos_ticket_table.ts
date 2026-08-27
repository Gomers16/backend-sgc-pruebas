// database/migrations/1787000000000_create_tipos_ticket_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tipos_ticket'

  public async up() {
    this.schema.createTable(this.tableName, (table) => {
      table.increments('id')

      table.string('codigo', 50).notNullable().unique()
      table.string('nombre').notNullable()

      // Arrays de nombres de rol (mismo formato que usePermissions.ts /
      // check_role_middleware.ts: strings en mayúsculas, ej. 'SUPER_ADMIN').
      table.json('roles_creador').notNullable()
      table.json('roles_resuelve').notNullable()

      table.boolean('requiere_aprobacion_financiera').notNullable().defaultTo(false)
    })
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
