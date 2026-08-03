// database/migrations/1784800000000_add_meta_vehiculos_to_meta_comercial_asesor_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class AddMetaVehiculosToMetaComercialAsesor extends BaseSchema {
  protected tableName = 'meta_comercial_asesor'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      // Meta en cantidad de vehículos, independiente de meta_pesos —
      // nullable porque no todos los asesores/meses van a tener meta
      // definida en unidades (solo en pesos, como hoy).
      table.integer('meta_vehiculos').unsigned().nullable()
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('meta_vehiculos')
    })
  }
}
