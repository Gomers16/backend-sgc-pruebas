import { BaseSchema } from '@adonisjs/lucid/schema'
import { columnaExiste, fkExiste } from '../helpers/multisede.js'

/**
 * Origen (catálogo telemercadeo_origenes) que el asesor de Telemercadeo elige
 * en su dateo, y en el ticket de Excepción de Dateo que lo crea al aprobarse.
 * Solo aditiva y nullable: el código de producción local la ignora.
 */
export default class extends BaseSchema {
  private readonly columna = 'telemercadeo_origen_id'
  private readonly tablas = [
    { tabla: 'captacion_dateos', fk: 'fk_captacion_dateos_tele_origen' },
    { tabla: 'tickets_detalle_excepcion_dateo', fk: 'fk_ticket_det_exc_tele_origen' },
  ]

  async up() {
    for (const { tabla, fk } of this.tablas) {
      if (!(await columnaExiste(this.db, tabla, this.columna))) {
        await this.db.rawQuery(
          `ALTER TABLE ${tabla} ADD COLUMN ${this.columna} INT UNSIGNED NULL DEFAULT NULL`
        )
      }
      if (!(await fkExiste(this.db, tabla, fk))) {
        await this.db.rawQuery(
          `ALTER TABLE ${tabla} ADD CONSTRAINT ${fk} FOREIGN KEY (${this.columna})
             REFERENCES telemercadeo_origenes (id) ON DELETE RESTRICT`
        )
      }
    }
  }

  async down() {
    for (const { tabla, fk } of this.tablas) {
      if (await fkExiste(this.db, tabla, fk)) {
        await this.db.rawQuery(`ALTER TABLE ${tabla} DROP FOREIGN KEY ${fk}`)
      }
      if (await columnaExiste(this.db, tabla, this.columna)) {
        // El índice de la FK se llama igual que la FK en MySQL.
        await this.db.rawQuery(`ALTER TABLE ${tabla} DROP INDEX ${fk}`).catch(() => {})
        await this.db.rawQuery(`ALTER TABLE ${tabla} DROP COLUMN ${this.columna}`)
      }
    }
  }
}
