import { BaseSchema } from '@adonisjs/lucid/schema'
import { backfill, columnaExiste, SEDE_IBAGUE } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 3c — sede_id NOT NULL en captacion_dateos y
 * continuidad_overrides (las dos tablas con columna propia que la 3c pone
 * bajo el mixin; los redateos heredan del dateo).
 *
 * Antes rellena lo que el código viejo haya creado con sede NULL después de
 * la Fase 1 (dateos: misma cadena que 1811000000002 — turno que lo consumió,
 * agente, asesor del convenio, convenio, resto Ibagué; overrides: Ibagué).
 * DEFAULT 1 TEMPORAL: producción local corre código viejo contra la misma BD
 * y crea sin mencionar sede_id (su modelo no tiene la columna), así que toma
 * el DEFAULT; el código nuevo la pone siempre (mixin SedeScoped). La
 * migración de cierre de la Fase 3 quita el DEFAULT.
 *
 * facturacion_tickets NO entra aquí: producción local asigna sede_id NULL
 * EXPLÍCITO al subir un ticket sin turno (STRICT_TRANS_TABLES → error); su
 * NOT NULL va en la migración de cierre de la Fase 3.
 */
const NULL_A_IBAGUE = (t: string) => ({
  desc: 'resto → Ibagué',
  sql: `UPDATE ${t} SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
})

export default class MultisedeDateosSedeNotNull extends BaseSchema {
  async up() {
    for (const t of ['captacion_dateos', 'continuidad_overrides']) {
      if (!(await columnaExiste(this.db, t, 'sede_id'))) {
        throw new Error(`[multisede] ${t}.sede_id no existe: falta 1811000000002`)
      }
    }

    await backfill(this.db, 'captacion_dateos', [
      {
        desc: '← turno que lo consumió',
        sql: `UPDATE captacion_dateos d JOIN turnos_rtms t ON t.id = d.consumido_turno_id
                 SET d.sede_id = t.sede_id WHERE d.sede_id IS NULL`,
      },
      {
        desc: '← agente que dateó',
        sql: `UPDATE captacion_dateos d JOIN agentes_captacions a ON a.id = d.agente_id
                 SET d.sede_id = a.sede_id WHERE d.sede_id IS NULL AND a.sede_id IS NOT NULL`,
      },
      {
        desc: '← agente del convenio',
        sql: `UPDATE captacion_dateos d JOIN agentes_captacions a ON a.id = d.asesor_convenio_id
                 SET d.sede_id = a.sede_id WHERE d.sede_id IS NULL AND a.sede_id IS NOT NULL`,
      },
      {
        desc: '← convenio',
        sql: `UPDATE captacion_dateos d JOIN convenios c ON c.id = d.convenio_id
                 SET d.sede_id = c.sede_id WHERE d.sede_id IS NULL AND c.sede_id IS NOT NULL`,
      },
      NULL_A_IBAGUE('captacion_dateos'),
    ])
    await backfill(this.db, 'continuidad_overrides', [NULL_A_IBAGUE('continuidad_overrides')])

    for (const t of ['captacion_dateos', 'continuidad_overrides']) {
      await this.db.rawQuery(
        `ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NOT NULL DEFAULT ${SEDE_IBAGUE}`
      )
    }
  }

  async down() {
    for (const t of ['captacion_dateos', 'continuidad_overrides']) {
      if (await columnaExiste(this.db, t, 'sede_id')) {
        await this.db.rawQuery(`ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NULL DEFAULT NULL`)
      }
    }
  }
}
