// database/migrations/1795000000000_add_consecutivo_descuento_to_facturacion_tickets.ts
//
// Consecutivo del descuento: número que caja digita a mano al confirmar un
// ticket con descuento en uso. No se puede repetir entre tickets CONFIRMADA.
//
//  1) facturacion_tickets.consecutivo_descuento VARCHAR(30) NULL — el valor
//     digitado (el controller lo guarda en mayúsculas, solo [A-Z0-9-]).
//     No confundir con `consecutivo` (el de la factura, ya existente).
//  2) facturacion_tickets.consecutivo_descuento_confirmado — columna generada
//     STORED: el consecutivo si el ticket está CONFIRMADA, NULL en cualquier
//     otro estado (BORRADOR … REVERTIDA). Mismo patrón que
//     turnos_rtms.turno_numero_activo (1787000000007): MySQL permite varios
//     NULL en un índice único, así que solo choca entre tickets CONFIRMADA.
//     El modelo NO declara esta columna (no se puede escribir en ella).
//  3) uq_fact_consecutivo_descuento_confirmado: índice único sobre (2).
//  4) facturacion_consecutivo_descuento_cambios: registro de quién y cuándo
//     corrigió el consecutivo de un ticket ya CONFIRMADA (solo SUPER_ADMIN /
//     GERENCIA). Mismo estilo que certificacion_resultado_cambios.
//
// Las filas existentes quedan con consecutivo_descuento NULL (no hay datos
// que migrar: verificado contra descuento_observacion/observaciones).
//
// SQL explícito y con chequeo previo contra information_schema (MySQL no
// soporta ADD COLUMN/INDEX IF NOT EXISTS), para que un reintento después de
// una falla a mitad de camino sea seguro.
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class AddConsecutivoDescuentoToFacturacionTickets extends BaseSchema {
  protected tableName = 'facturacion_tickets'

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
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')

    if (!(await this.columnExists('consecutivo_descuento'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD COLUMN consecutivo_descuento VARCHAR(30) NULL DEFAULT NULL
            AFTER descuento_observacion
      `)
    }

    if (!(await this.columnExists('consecutivo_descuento_confirmado'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD COLUMN consecutivo_descuento_confirmado VARCHAR(30)
            GENERATED ALWAYS AS (
              CASE WHEN estado = 'CONFIRMADA' THEN consecutivo_descuento ELSE NULL END
            ) STORED
            AFTER consecutivo_descuento
      `)
    }

    if (!(await this.indexExists('uq_fact_consecutivo_descuento_confirmado'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD UNIQUE INDEX uq_fact_consecutivo_descuento_confirmado
            (consecutivo_descuento_confirmado)
      `)
    }

    // Para la verificación en vivo (busca en cualquier estado).
    if (!(await this.indexExists('idx_fact_consecutivo_descuento'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD INDEX idx_fact_consecutivo_descuento (consecutivo_descuento)
      `)
    }

    await this.db.rawQuery(`
      CREATE TABLE IF NOT EXISTS facturacion_consecutivo_descuento_cambios (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        facturacion_ticket_id INT UNSIGNED NOT NULL,
        valor_anterior VARCHAR(30) NULL DEFAULT NULL,
        valor_nuevo VARCHAR(30) NOT NULL,
        motivo VARCHAR(255) NULL DEFAULT NULL,
        usuario_id INT UNSIGNED NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_fcdc_ticket (facturacion_ticket_id),
        KEY idx_fcdc_usuario (usuario_id),
        CONSTRAINT fk_fcdc_ticket FOREIGN KEY (facturacion_ticket_id)
          REFERENCES facturacion_tickets (id) ON DELETE CASCADE,
        CONSTRAINT fk_fcdc_usuario FOREIGN KEY (usuario_id)
          REFERENCES usuarios (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  }

  public async down() {
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')
    await this.db.rawQuery('DROP TABLE IF EXISTS facturacion_consecutivo_descuento_cambios')

    if (await this.indexExists('idx_fact_consecutivo_descuento')) {
      await this.db.rawQuery(
        `ALTER TABLE ${this.tableName} DROP INDEX idx_fact_consecutivo_descuento`
      )
    }
    if (await this.indexExists('uq_fact_consecutivo_descuento_confirmado')) {
      await this.db.rawQuery(
        `ALTER TABLE ${this.tableName} DROP INDEX uq_fact_consecutivo_descuento_confirmado`
      )
    }
    if (await this.columnExists('consecutivo_descuento_confirmado')) {
      await this.db.rawQuery(
        `ALTER TABLE ${this.tableName} DROP COLUMN consecutivo_descuento_confirmado`
      )
    }
    if (await this.columnExists('consecutivo_descuento')) {
      await this.db.rawQuery(`ALTER TABLE ${this.tableName} DROP COLUMN consecutivo_descuento`)
    }
  }
}
