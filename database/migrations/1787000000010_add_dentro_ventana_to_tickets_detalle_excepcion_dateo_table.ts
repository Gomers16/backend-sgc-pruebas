import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'tickets_detalle_excepcion_dateo'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Snapshot calculado y persistido AL CREAR el ticket (con la ventana
      // vigente en ese momento) — no se recalcula después, así un cambio de
      // configuración posterior no afecta tickets ya creados. Todos los
      // tickets existentes antes de esta migración solo pudieron crearse
      // estando fuera de ventana (era la única vía posible), de ahí el
      // default false.
      table.boolean('dentro_ventana').notNullable().defaultTo(false)
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('dentro_ventana')
    })
  }
}
