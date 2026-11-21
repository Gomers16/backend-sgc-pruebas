import { BaseSchema } from '@adonisjs/lucid/schema'
import { backfill, columnaExiste, SEDE_IBAGUE } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 4 — informes de discrepancias RTM.
 *
 * informes_discrepancias_rtm.sede_id NOT NULL DEFAULT 1 TEMPORAL (mismo
 * patrón que 1812–1815). Antes rellena lo que haya quedado con NULL →
 * Ibagué (el informe no tiene otra fuente de sede; hasta hoy todos se
 * generaron en Ibagué).
 *
 * Compatible con producción local: su InformeDiscrepanciaRtm.create() no
 * menciona sede_id y toma el DEFAULT. El DEFAULT se quita en 1818, que se
 * aplica DESPUÉS de sincronizar el código nuevo (igual que 1816).
 */
const TABLA = 'informes_discrepancias_rtm'

export default class MultisedeInformesDiscrepanciasSedeNotNull extends BaseSchema {
  async up() {
    if (!(await columnaExiste(this.db, TABLA, 'sede_id'))) {
      throw new Error(`[multisede] ${TABLA}.sede_id no existe: falta 1811`)
    }
    await backfill(this.db, TABLA, [
      {
        desc: 'resto → Ibagué',
        sql: `UPDATE ${TABLA} SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
      },
    ])
    await this.db.rawQuery(
      `ALTER TABLE ${TABLA} MODIFY sede_id INT UNSIGNED NOT NULL DEFAULT ${SEDE_IBAGUE}`
    )
  }

  async down() {
    if (await columnaExiste(this.db, TABLA, 'sede_id')) {
      await this.db.rawQuery(`ALTER TABLE ${TABLA} MODIFY sede_id INT UNSIGNED NULL DEFAULT NULL`)
    }
  }
}
