import { BaseSchema } from '@adonisjs/lucid/schema'
import { columnaExiste, SEDE_IBAGUE } from '../helpers/multisede.js'

/**
 * Multi-sede — cierre de la Fase 4 (metas e informes por sede).
 *
 * Quita el DEFAULT 1 TEMPORAL de sede_id (queda NOT NULL sin default) en:
 *   - configuracion_meta_mensual (DEFAULT desde 1811000000003)
 *   - historico_meta_diario      (DEFAULT desde 1811000000003)
 *   - informes_discrepancias_rtm (DEFAULT desde 1817)
 *
 * NO APLICAR ANTES DE SINCRONIZAR el código nuevo (igual que 1816): el
 * código viejo de producción local inserta sin sede_id
 * (obtenerOCrearConfigMensual con SQL crudo e InformeDiscrepanciaRtm.create)
 * y sin DEFAULT esas escrituras fallan ("Field 'sede_id' doesn't have a
 * default value") — p. ej. la meta del primer día de cada mes.
 * El código nuevo siempre manda la sede (mixin SedeScoped).
 *
 * Exige que las tres columnas ya sean NOT NULL (1811/1817 aplicadas); si no,
 * se niega sin cambiar nada. No toca datos.
 */
const TABLAS = ['configuracion_meta_mensual', 'historico_meta_diario', 'informes_discrepancias_rtm']

type Db = { rawQuery: (sql: string, bindings?: any) => any }

async function esNotNull(db: Db, tabla: string): Promise<boolean> {
  const r = await db.rawQuery(
    `SELECT is_nullable AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = ? AND column_name = 'sede_id'`,
    [tabla]
  )
  return r[0]?.[0]?.n === 'NO'
}

export default class MultisedeCierreFase4 extends BaseSchema {
  async up() {
    for (const t of TABLAS) {
      if (!(await columnaExiste(this.db, t, 'sede_id'))) {
        throw new Error(`[multisede] ${t}.sede_id no existe: falta 1811`)
      }
      if (!(await esNotNull(this.db, t))) {
        throw new Error(`[multisede] ${t}.sede_id todavía admite NULL: aplicar 1811/1817 antes`)
      }
    }
    for (const t of TABLAS) {
      await this.db.rawQuery(`ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NOT NULL`)
    }
  }

  async down() {
    for (const t of TABLAS) {
      if (await columnaExiste(this.db, t, 'sede_id')) {
        await this.db.rawQuery(
          `ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NOT NULL DEFAULT ${SEDE_IBAGUE}`
        )
      }
    }
  }
}
