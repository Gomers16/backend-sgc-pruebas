import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * "Segunda vez" (Entrega A): resultado de la certificación RTM/PREV.
 *
 * NULL = sin resultado (certificaciones históricas y servicios SOAT/PERI,
 * donde el resultado no aplica). No se rellena con APROBADA.
 *
 * Cambio aditivo con ALGORITHM=INSTANT (MySQL >= 8.0.29): solo metadata,
 * sin copiar la tabla. Si el servidor no pudiera hacerlo INSTANT, el ALTER
 * falla en vez de degradar en silencio a COPY. Guardado con columnExists()
 * (mismo patrón que 1784900004000_add_rep_general_verificado_to_turnos_rtms_table)
 * para que correrla dos veces sea un no-op.
 */
export default class AddResultadoToCertificaciones extends BaseSchema {
  protected tableName = 'certificaciones'

  private async columnExists(name: string): Promise<boolean> {
    const rows = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [this.tableName, name]
    )
    return rows[0].length > 0
  }

  public async up() {
    if (!(await this.columnExists('resultado'))) {
      // Falla rápido si no consigue el MDL, en vez de encolar consultas.
      // this.db es el TransactionClient de la migración → misma conexión.
      await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD COLUMN resultado ENUM('APROBADA','RECHAZADA') NULL DEFAULT NULL,
          ALGORITHM=INSTANT
      `)
    }
  }

  public async down() {
    if (await this.columnExists('resultado')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP COLUMN resultado,
          ALGORITHM=INSTANT
      `)
    }
  }
}
