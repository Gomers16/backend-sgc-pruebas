import { BaseSchema } from '@adonisjs/lucid/schema'
import { backfill, columnaExiste, SEDE_IBAGUE } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 3a — sede_id NOT NULL en turnero_multimedia y
 * turnero_mensajes_ticker (los únicos de la 3a que tienen columna propia;
 * turnos_rtms ya era NOT NULL y llamados/certificaciones heredan del turno).
 *
 * Antes rellena con Ibagué lo que el código viejo haya creado con sede NULL
 * después de la Fase 1. DEFAULT 1 TEMPORAL: producción local corre código
 * viejo contra la misma BD y crea sin sede; el código nuevo la pone siempre
 * (mixin SedeScoped). La migración de cierre de la Fase 3 quita el DEFAULT.
 */
const TABLAS = ['turnero_multimedia', 'turnero_mensajes_ticker']

export default class MultisedeTurneroSedeNotNull extends BaseSchema {
  async up() {
    for (const t of TABLAS) {
      if (!(await columnaExiste(this.db, t, 'sede_id'))) {
        throw new Error(`[multisede] ${t}.sede_id no existe: falta 1811000000002`)
      }
      await backfill(this.db, t, [
        {
          desc: 'NULL → Ibagué',
          sql: `UPDATE ${t} SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
        },
      ])
      await this.db.rawQuery(
        `ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NOT NULL DEFAULT ${SEDE_IBAGUE}`
      )
    }
  }

  async down() {
    for (const t of TABLAS) {
      if (await columnaExiste(this.db, t, 'sede_id')) {
        await this.db.rawQuery(`ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NULL DEFAULT NULL`)
      }
    }
  }
}
