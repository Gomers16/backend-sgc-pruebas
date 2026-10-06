import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * "Google ADS" como canal/medio propio en Crear Turno (se comporta como
 * Redes: sin asesor ni comisión propia).
 *
 * Agrega el valor AL FINAL de los dos ENUM de turnos_rtms:
 *   - medio_entero      + 'Google ADS'
 *   - canal_atribucion  + 'GOOGLE_ADS'
 * Agregar al final de un ENUM (sin pasar de 255 valores) es solo metadata:
 * ALGORITHM=INSTANT. Si MySQL lo rechazara (exigiría COPY), el ALTER falla
 * y no se aplica nada — es un único ALTER, atómico. idx_turno_canal no se
 * reconstruye. facturacion_tickets guarda canal/medio como VARCHAR: no cambia.
 *
 * Idempotente: si los dos ENUM ya tienen el valor nuevo, no hace nada.
 */
export default class AddGoogleAdsToTurnosRtmsEnums extends BaseSchema {
  protected tableName = 'turnos_rtms'

  private readonly MEDIOS = [
    'Redes Sociales',
    'Convenio o Referido Externo',
    'Call Center',
    'Fachada',
    'Referido Interno',
    'Asesor Comercial',
  ]
  private readonly CANALES = ['FACHADA', 'ASESOR', 'TELE', 'REDES']

  private enumSql(values: string[]) {
    return `ENUM(${values.map((v) => `'${v}'`).join(',')}) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci NULL DEFAULT NULL`
  }

  private async columnType(name: string): Promise<string> {
    const rows = await this.db.rawQuery(
      `SELECT column_type AS t FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [this.tableName, name]
    )
    return String(rows[0][0]?.t ?? '')
  }

  public async up() {
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')

    const medioType = await this.columnType('medio_entero')
    const canalType = await this.columnType('canal_atribucion')
    if (medioType.includes("'Google ADS'") && canalType.includes("'GOOGLE_ADS'")) return

    await this.db.rawQuery(
      `ALTER TABLE ${this.tableName}
         MODIFY medio_entero ${this.enumSql([...this.MEDIOS, 'Google ADS'])},
         MODIFY canal_atribucion ${this.enumSql([...this.CANALES, 'GOOGLE_ADS'])},
         ALGORITHM=INSTANT`
    )
  }

  /**
   * Quitar valores de un ENUM no es INSTANT (MySQL reconstruye la tabla).
   * Se niega si ya hay turnos guardados con Google ADS: hay que pasarlos a
   * otro canal a mano antes de revertir.
   */
  public async down() {
    const rows = await this.db.rawQuery(
      `SELECT COUNT(*) AS n FROM ${this.tableName}
       WHERE medio_entero = 'Google ADS' OR canal_atribucion = 'GOOGLE_ADS'`
    )
    const n = Number(rows[0][0]?.n ?? 0)
    if (n > 0) {
      throw new Error(
        `Hay ${n} turno(s) con Google ADS: reasígnalos a otro canal antes de revertir esta migración.`
      )
    }
    await this.db.rawQuery(
      `ALTER TABLE ${this.tableName}
         MODIFY medio_entero ${this.enumSql(this.MEDIOS)},
         MODIFY canal_atribucion ${this.enumSql(this.CANALES)}`
    )
  }
}
