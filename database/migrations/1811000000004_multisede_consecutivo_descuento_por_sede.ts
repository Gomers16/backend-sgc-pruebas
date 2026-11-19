import { BaseSchema } from '@adonisjs/lucid/schema'
import { indiceExiste } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 1 — consecutivo del descuento único por (sede, consecutivo).
 *
 * uq_fact_consecutivo_descuento_confirmado pasa de (consecutivo_descuento_confirmado)
 * a (sede_id, consecutivo_descuento_confirmado) y CONSERVA EL NOMBRE:
 * facturacion_tickets_controller detecta el duplicado por ese nombre
 * (UQ_CONSECUTIVO_DESCUENTO).
 *
 * Patrón 1787000000007: se crea el nuevo con un nombre temporal, se borra el
 * viejo y se renombra. Tickets con sede NULL no quedan cubiertos por el
 * índice compuesto, pero la verificación previa del controlador sigue
 * siendo global; la Fase 3b la pasa a por sede.
 */
const T = 'facturacion_tickets'
const NOMBRE = 'uq_fact_consecutivo_descuento_confirmado'
const TMP = 'uq_fact_consec_desc_tmp'

export default class MultisedeConsecutivoDescuentoPorSede extends BaseSchema {
  private async columnas(indice: string): Promise<string> {
    const [r] = await this.db.rawQuery(
      `SELECT GROUP_CONCAT(column_name ORDER BY seq_in_index) AS c
         FROM information_schema.statistics
        WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [T, indice]
    )
    return String(r[0]?.c ?? '')
  }

  async up() {
    if ((await this.columnas(NOMBRE)) === 'sede_id,consecutivo_descuento_confirmado') {
      console.log('[multisede] consecutivo ya es por sede')
      return
    }
    if (!(await indiceExiste(this.db, T, TMP))) {
      await this.db.rawQuery(
        `ALTER TABLE ${T} ADD UNIQUE INDEX ${TMP} (sede_id, consecutivo_descuento_confirmado)`
      )
    }
    if (await indiceExiste(this.db, T, NOMBRE)) {
      await this.db.rawQuery(`ALTER TABLE ${T} DROP INDEX ${NOMBRE}`)
    }
    await this.db.rawQuery(`ALTER TABLE ${T} RENAME INDEX ${TMP} TO ${NOMBRE}`)
    console.log(`[multisede] ${NOMBRE} = (${await this.columnas(NOMBRE)})`)
  }

  async down() {
    if ((await this.columnas(NOMBRE)) === 'consecutivo_descuento_confirmado') return
    const [dups] = await this.db.rawQuery(
      `SELECT COUNT(*) AS n FROM (SELECT consecutivo_descuento_confirmado FROM ${T}
         WHERE consecutivo_descuento_confirmado IS NOT NULL
         GROUP BY consecutivo_descuento_confirmado HAVING COUNT(*) > 1) z`
    )
    if (Number(dups[0].n) > 0) {
      throw new Error(
        `[multisede] ${dups[0].n} consecutivos repetidos entre sedes; no se puede volver al único global`
      )
    }
    if (!(await indiceExiste(this.db, T, TMP))) {
      await this.db.rawQuery(
        `ALTER TABLE ${T} ADD UNIQUE INDEX ${TMP} (consecutivo_descuento_confirmado)`
      )
    }
    if (await indiceExiste(this.db, T, NOMBRE)) {
      await this.db.rawQuery(`ALTER TABLE ${T} DROP INDEX ${NOMBRE}`)
    }
    await this.db.rawQuery(`ALTER TABLE ${T} RENAME INDEX ${TMP} TO ${NOMBRE}`)
  }
}
