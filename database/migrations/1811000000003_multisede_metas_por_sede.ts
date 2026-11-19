import { BaseSchema } from '@adonisjs/lucid/schema'
import { columnaExiste, contarPorSede, fkExiste, indiceExiste } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 1 — metas e histórico de meta siempre por sede.
 *
 * configuracion_meta_mensual: único (mes, anio) → (sede_id, mes, anio).
 * historico_meta_diario:      único (fecha)     → (sede_id, fecha).
 *
 * sede_id NOT NULL DEFAULT 1 (Ibagué) TEMPORAL: el código actual inserta
 * sin sede (obtenerOCrearConfigMensual usa INSERT ... ON DUPLICATE KEY y
 * depende del índice único), y todo lo que inserta hoy es de Ibagué. La
 * Fase 4 pasa la sede explícita y quita el DEFAULT.
 *
 * Patrón 1787000000007: el único nuevo se crea ANTES de borrar el viejo.
 * down() vuelve a los únicos viejos solo si no hay duplicados entre sedes.
 */
const TABLAS = [
  {
    tabla: 'configuracion_meta_mensual',
    nuevo: 'uq_meta_mensual_sede_mes_anio',
    nuevoCols: 'sede_id, mes, anio',
    viejo: 'configuracion_meta_mensual_mes_anio_unique',
    viejoCols: 'mes, anio',
  },
  {
    tabla: 'historico_meta_diario',
    nuevo: 'uq_historico_meta_diario_sede_fecha',
    nuevoCols: 'sede_id, fecha',
    viejo: 'fecha',
    viejoCols: 'fecha',
  },
]

export default class MultisedeMetasPorSede extends BaseSchema {
  async up() {
    for (const t of TABLAS) {
      const [antes] = await this.db.rawQuery(`SELECT COUNT(*) AS n FROM ${t.tabla}`)
      if (!(await columnaExiste(this.db, t.tabla, 'sede_id'))) {
        await this.db.rawQuery(
          `ALTER TABLE ${t.tabla} ADD COLUMN sede_id INT UNSIGNED NOT NULL DEFAULT 1 AFTER id`
        )
      }
      if (!(await indiceExiste(this.db, t.tabla, t.nuevo))) {
        await this.db.rawQuery(
          `ALTER TABLE ${t.tabla} ADD UNIQUE INDEX ${t.nuevo} (${t.nuevoCols})`
        )
      }
      const fk = `fk_${t.tabla}_sede_id`
      if (!(await fkExiste(this.db, t.tabla, fk))) {
        await this.db.rawQuery(
          `ALTER TABLE ${t.tabla} ADD CONSTRAINT ${fk}
             FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE RESTRICT ON UPDATE CASCADE`
        )
      }
      if (await indiceExiste(this.db, t.tabla, t.viejo)) {
        await this.db.rawQuery(`ALTER TABLE ${t.tabla} DROP INDEX \`${t.viejo}\``)
      }
      const despues = await contarPorSede(this.db, t.tabla)
      console.log(
        `[multisede] ${t.tabla} filas ${antes[0].n} → por sede ${JSON.stringify(despues)}`
      )
      const totalDespues = Object.values(despues).reduce((a, b) => a + b, 0)
      if (totalDespues !== Number(antes[0].n)) {
        throw new Error(`[multisede] ${t.tabla}: el total cambió`)
      }
    }
  }

  async down() {
    for (const t of TABLAS) {
      if (!(await columnaExiste(this.db, t.tabla, 'sede_id'))) continue
      const [dups] = await this.db.rawQuery(
        `SELECT COUNT(*) AS n FROM (SELECT ${t.viejoCols} FROM ${t.tabla}
           GROUP BY ${t.viejoCols} HAVING COUNT(*) > 1) z`
      )
      if (Number(dups[0].n) > 0) {
        throw new Error(
          `[multisede] ${t.tabla}: ${dups[0].n} claves repetidas entre sedes; no se puede volver al único global`
        )
      }
      if (!(await indiceExiste(this.db, t.tabla, t.viejo))) {
        await this.db.rawQuery(
          `ALTER TABLE ${t.tabla} ADD UNIQUE INDEX \`${t.viejo}\` (${t.viejoCols})`
        )
      }
      const fk = `fk_${t.tabla}_sede_id`
      if (await fkExiste(this.db, t.tabla, fk)) {
        await this.db.rawQuery(`ALTER TABLE ${t.tabla} DROP FOREIGN KEY ${fk}`)
      }
      if (await indiceExiste(this.db, t.tabla, t.nuevo)) {
        await this.db.rawQuery(`ALTER TABLE ${t.tabla} DROP INDEX ${t.nuevo}`)
      }
      await this.db.rawQuery(`ALTER TABLE ${t.tabla} DROP COLUMN sede_id`)
    }
  }
}
