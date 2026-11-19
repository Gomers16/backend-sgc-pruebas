import { BaseSchema } from '@adonisjs/lucid/schema'
import { fkExiste, indiceExiste } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 1 — FK de contratos.sede_id (pendiente de Fase 0).
 *
 * La migración original (1752601767160) creó la columna NOT NULL pero sin
 * FK ni índice. Antes de crearla se verifica que no haya contratos con una
 * sede inexistente; si los hay, se aborta sin tocar nada.
 */
export default class MultisedeFkContratosSede extends BaseSchema {
  private readonly fk = 'fk_contratos_sede_id'
  private readonly idx = 'idx_contratos_sede_id'

  async up() {
    const [huerfanos] = await this.db.rawQuery(
      `SELECT COUNT(*) AS n FROM contratos c
         LEFT JOIN sedes s ON s.id = c.sede_id WHERE s.id IS NULL`
    )
    const n = Number(huerfanos[0].n)
    console.log(`[multisede] contratos con sede inexistente: ${n}`)
    if (n > 0) throw new Error(`[multisede] ${n} contratos con sede inexistente; no se crea la FK`)

    if (!(await indiceExiste(this.db, 'contratos', this.idx))) {
      await this.db.rawQuery(`ALTER TABLE contratos ADD INDEX ${this.idx} (sede_id)`)
    }
    if (!(await fkExiste(this.db, 'contratos', this.fk))) {
      await this.db.rawQuery(
        `ALTER TABLE contratos ADD CONSTRAINT ${this.fk}
           FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE RESTRICT ON UPDATE CASCADE`
      )
    }
  }

  async down() {
    if (await fkExiste(this.db, 'contratos', this.fk)) {
      await this.db.rawQuery(`ALTER TABLE contratos DROP FOREIGN KEY ${this.fk}`)
    }
    if (await indiceExiste(this.db, 'contratos', this.idx)) {
      await this.db.rawQuery(`ALTER TABLE contratos DROP INDEX ${this.idx}`)
    }
  }
}
