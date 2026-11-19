import { BaseSchema } from '@adonisjs/lucid/schema'
import {
  agregarSedeId,
  backfill,
  columnaExiste,
  contarPorSede,
  quitarSedeId,
  SEDE_IBAGUE,
} from '../helpers/multisede.js'

/**
 * Multi-sede Fase 1 — configuración con override por sede y tarifas de
 * trámites por sede.
 *
 * Configuración: sede_id NULL = valor global (las filas que existen hoy
 * quedan globales, sin backfill); una fila con sede_id es el override de esa
 * sede. La resolución sede → global llega en la Fase 5; hasta entonces el
 * código sigue leyendo la única fila (global) igual que antes.
 *
 * tarifas_tramites: por sede; las actuales son de Ibagué. NOT NULL sin
 * DEFAULT (el único alta es el seeder 27, que ya pasa sedeId = 1).
 */
const CONFIG = [
  'configuracion_recurrencia_global',
  'configuracion_redateo_global',
  'configuracion_reserva_dateos',
  'configuracion_seguimiento_tele_global',
  'configuracion_ventana_ticket_global',
]

export default class MultisedeConfigYTarifasTramites extends BaseSchema {
  async up() {
    for (const t of CONFIG) {
      await agregarSedeId(this.db, t)
      console.log(
        `[multisede] ${t} por sede ${JSON.stringify(await contarPorSede(this.db, t))} (NULL = global)`
      )
    }

    await agregarSedeId(this.db, 'tarifas_tramites')
    await backfill(this.db, 'tarifas_tramites', [
      {
        desc: 'todas → Ibagué',
        sql: `UPDATE tarifas_tramites SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
      },
    ])
    await this.db.rawQuery(`ALTER TABLE tarifas_tramites MODIFY sede_id INT UNSIGNED NOT NULL`)
  }

  async down() {
    if (await columnaExiste(this.db, 'tarifas_tramites', 'sede_id')) {
      const [otras] = await this.db.rawQuery(
        `SELECT COUNT(*) AS n FROM tarifas_tramites WHERE sede_id <> ${SEDE_IBAGUE}`
      )
      if (Number(otras[0].n) > 0) {
        throw new Error(
          `[multisede] hay ${otras[0].n} tarifas de trámites de otras sedes; bórralas antes de revertir`
        )
      }
    }
    await quitarSedeId(this.db, 'tarifas_tramites')
    for (const t of [...CONFIG].reverse()) {
      const [overrides] = await this.db
        .rawQuery(`SELECT COUNT(*) AS n FROM ${t} WHERE sede_id IS NOT NULL`)
        .catch(() => [[{ n: 0 }]])
      if (Number(overrides[0].n) > 0) {
        throw new Error(`[multisede] ${t} tiene overrides por sede; bórralos antes de revertir`)
      }
      await quitarSedeId(this.db, t)
    }
  }
}
