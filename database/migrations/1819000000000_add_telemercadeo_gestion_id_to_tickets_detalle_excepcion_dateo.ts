import { BaseSchema } from '@adonisjs/lucid/schema'
import { columnaExiste, fkExiste } from '../helpers/multisede.js'

/**
 * Ticket de Excepción de Dateo que nace de una gestión de Telemercadeo
 * (REQUIERE_TICKET_DATEO al datear desde la gestión): guarda la gestión para
 * que aprobar() la vincule con el dateo creado (gestión → DATEADO).
 *
 * Solo aditiva y nullable: el código de producción local no la conoce y la
 * ignora; ON DELETE SET NULL para no bloquear el borrado de gestiones.
 */
export default class extends BaseSchema {
  protected tableName = 'tickets_detalle_excepcion_dateo'
  private readonly fk = 'fk_ticket_det_exc_tele_gestion'

  async up() {
    if (!(await columnaExiste(this.db, this.tableName, 'telemercadeo_gestion_id'))) {
      await this.db.rawQuery(
        `ALTER TABLE ${this.tableName}
           ADD COLUMN telemercadeo_gestion_id INT UNSIGNED NULL DEFAULT NULL AFTER comercial_id`
      )
    }
    if (!(await fkExiste(this.db, this.tableName, this.fk))) {
      await this.db.rawQuery(
        `ALTER TABLE ${this.tableName}
           ADD CONSTRAINT ${this.fk} FOREIGN KEY (telemercadeo_gestion_id)
           REFERENCES telemercadeo_gestiones (id) ON DELETE SET NULL`
      )
    }
  }

  async down() {
    if (await fkExiste(this.db, this.tableName, this.fk)) {
      await this.db.rawQuery(`ALTER TABLE ${this.tableName} DROP FOREIGN KEY ${this.fk}`)
    }
    if (await columnaExiste(this.db, this.tableName, 'telemercadeo_gestion_id')) {
      // El índice de la FK se llama igual que la FK en MySQL.
      await this.db.rawQuery(`ALTER TABLE ${this.tableName} DROP INDEX ${this.fk}`).catch(() => {})
      await this.db.rawQuery(`ALTER TABLE ${this.tableName} DROP COLUMN telemercadeo_gestion_id`)
    }
  }
}
