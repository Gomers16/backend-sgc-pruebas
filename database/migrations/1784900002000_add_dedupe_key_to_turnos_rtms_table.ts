import { BaseSchema } from '@adonisjs/lucid/schema'

export default class AddDedupeKeyToTurnosRtms extends BaseSchema {
  protected tableName = 'turnos_rtms'

  private async columnExists(name: string): Promise<boolean> {
    const rows = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [this.tableName, name]
    )
    return rows[0].length > 0
  }

  private async indexExists(name: string): Promise<boolean> {
    const rows = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [this.tableName, name]
    )
    return rows[0].length > 0
  }

  public async up() {
    // MySQL no soporta índices únicos parciales/filtrados de forma nativa.
    // Se emula uno con una columna generada STORED que es NULL para turnos
    // cancelados (MySQL permite múltiples NULL en un índice único) y un
    // valor determinístico para cualquier otro estado, de forma que la
    // combinación sede+fecha+servicio+placa solo puede repetirse si todas
    // las filas repetidas están canceladas.
    //
    // MySQL no soporta "ADD COLUMN/INDEX IF NOT EXISTS" en esta versión
    // (probado: da error de sintaxis), y cada ALTER hace commit inmediato
    // fuera de la transacción de la migración. Por eso el estado se checa
    // manualmente contra information_schema antes de cada paso, para que un
    // reintento después de una falla a mitad de camino sea seguro.
    if (!(await this.columnExists('dedupe_key'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD COLUMN dedupe_key VARCHAR(191)
            GENERATED ALWAYS AS (
              CASE WHEN estado = 'cancelado' THEN NULL
                   ELSE CONCAT(sede_id, '|', fecha, '|', servicio_id, '|', UPPER(TRIM(placa)))
              END
            ) STORED
      `)
    }

    if (!(await this.indexExists('uq_turno_activo_por_placa_servicio_dia'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD UNIQUE INDEX uq_turno_activo_por_placa_servicio_dia (dedupe_key)
      `)
    }
  }

  public async down() {
    if (await this.indexExists('uq_turno_activo_por_placa_servicio_dia')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP INDEX uq_turno_activo_por_placa_servicio_dia
      `)
    }
    if (await this.columnExists('dedupe_key')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP COLUMN dedupe_key
      `)
    }
  }
}
