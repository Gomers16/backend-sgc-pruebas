import { BaseSchema } from '@adonisjs/lucid/schema'
import { backfill, columnaExiste, SEDE_IBAGUE } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 3d — sede_id NOT NULL en liquidaciones y comprobantes_pago.
 *
 * Antes rellena lo que el código viejo haya creado con sede NULL después de
 * la Fase 1: la liquidación toma la sede de sus comisiones (vía
 * liquidacion_detalle; nunca mezcla sedes), el resto → Ibagué; los
 * comprobantes → Ibagué (el código viejo solo opera Ibagué).
 * DEFAULT 1 TEMPORAL: producción local corre código viejo contra la misma BD
 * y crea sin mencionar sede_id (sus modelos no tienen la columna), así que
 * toma el DEFAULT; el código nuevo la pone siempre (mixin SedeScoped). La
 * migración de cierre de la Fase 3 quita el DEFAULT.
 *
 * comisiones NO entra: sus filas de configuración (es_config = 1) son
 * globales con sede NULL a propósito.
 */
const TABLAS = ['liquidaciones', 'comprobantes_pago']

export default class MultisedeLiquidacionesComprobantesSedeNotNull extends BaseSchema {
  async up() {
    for (const t of TABLAS) {
      if (!(await columnaExiste(this.db, t, 'sede_id'))) {
        throw new Error(`[multisede] ${t}.sede_id no existe: falta 1811000000002`)
      }
    }

    await backfill(this.db, 'liquidaciones', [
      {
        desc: '← comisiones de su detalle',
        sql: `UPDATE liquidaciones l
                 JOIN (SELECT ld.liquidacion_id, MIN(c.sede_id) AS sede_id
                         FROM liquidacion_detalle ld JOIN comisiones c ON c.id = ld.comision_id
                        WHERE c.sede_id IS NOT NULL GROUP BY ld.liquidacion_id) x
                   ON x.liquidacion_id = l.id
                 SET l.sede_id = x.sede_id WHERE l.sede_id IS NULL`,
      },
      {
        desc: 'resto → Ibagué',
        sql: `UPDATE liquidaciones SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
      },
    ])
    await backfill(this.db, 'comprobantes_pago', [
      {
        desc: 'NULL → Ibagué',
        sql: `UPDATE comprobantes_pago SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
      },
    ])

    for (const t of TABLAS) {
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
