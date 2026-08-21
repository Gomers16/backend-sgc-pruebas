import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Documenta en el historial de migraciones una columna que YA existe en el
 * servidor de producción real (confirmado 2026-08-21 contra la BD remota:
 * tinyint(1) NOT NULL DEFAULT 0, 46012 filas en false / 13199 en true) pero
 * que nunca se creó vía migración versionada — fue un ALTER TABLE manual en
 * algún momento no documentado. -pruebas y el local de -pruebas no tienen la
 * columna. Timestamp elegido justo después de
 * 1784900003000_add_cancelacion_fields_to_turnos_rtms_table (la migración
 * más reciente que toca turnos_rtms) como estimación razonable de cuándo
 * pudo agregarse — no hay forma de confirmar la fecha real del ALTER manual.
 *
 * Guardada con columnExists() antes del ALTER (mismo patrón ya usado en
 * 1784900002000_add_dedupe_key_to_turnos_rtms_table.ts): MySQL no soporta
 * "ADD COLUMN IF NOT EXISTS" en esta versión, así que el chequeo se hace a
 * mano contra information_schema. Esto hace que correr esta migración en
 * producción (donde la columna ya existe) sea un no-op seguro en vez de un
 * error de columna duplicada.
 */
export default class AddRepGeneralVerificadoToTurnosRtms extends BaseSchema {
  protected tableName = 'turnos_rtms'

  private async columnExists(name: string): Promise<boolean> {
    const rows = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [this.tableName, name]
    )
    return rows[0].length > 0
  }

  public async up() {
    if (!(await this.columnExists('rep_general_verificado'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD COLUMN rep_general_verificado TINYINT(1) NOT NULL DEFAULT 0
      `)
    }
  }

  public async down() {
    if (await this.columnExists('rep_general_verificado')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP COLUMN rep_general_verificado
      `)
    }
  }
}
