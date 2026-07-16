// database/migrations/1784300001000_create_historico_meta_diario_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Respaldo histórico diario (2025 y meses de 2026 previos a la existencia
 * de datos reales en turnos_rtms). Los datos se cargan por fuera de esta
 * migración con un script SQL propio — esta migración SOLO crea la tabla
 * (IF NOT EXISTS) si aún no existe, nunca la recrea ni la trunca.
 */
export default class HistoricoMetaDiarios extends BaseSchema {
  protected tableName = 'historico_meta_diario'

  public async up() {
    await this.schema.raw(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id INT AUTO_INCREMENT PRIMARY KEY,
        fecha DATE NOT NULL UNIQUE,
        livianos INT NOT NULL DEFAULT 0,
        motos INT NOT NULL DEFAULT 0,
        total INT NOT NULL DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `)
  }

  public async down() {
    await this.schema.dropTableIfExists(this.tableName)
  }
}
