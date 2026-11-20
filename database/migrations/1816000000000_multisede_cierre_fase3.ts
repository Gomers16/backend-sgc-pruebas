import { BaseSchema } from '@adonisjs/lucid/schema'
import { columnaExiste, fkExiste, SEDE_IBAGUE } from '../helpers/multisede.js'

/**
 * Multi-sede — MIGRACIÓN DE CIERRE DE LA FASE 3.
 *
 * SOLO se aplica DESPUÉS de sincronizar el código nuevo a producción local
 * (y al servidor): el código viejo guarda sede_id NULL explícito (p. ej.
 * Facturación al subir un ticket sin turno) o no menciona la columna y
 * dependía del DEFAULT 1; con esto respondería error 500.
 *
 * No rellena nada: si encuentra filas sin sede, se niega y hay que correr
 * antes el backfill del checklist de despliegue.
 *
 * 1) facturacion_tickets.sede_id NOT NULL; su FK pasa de ON DELETE SET NULL
 *    a RESTRICT (SET NULL es incompatible con NOT NULL).
 * 2) tickets.sede_id NOT NULL. usuarios.sede_id sigue nullable: el código ya
 *    impide crear o dejar usuarios sin sede, y el caso "usuario sin sede"
 *    (403 salvo /auth/me) está cubierto a propósito por la Fase 2.
 * 3) Quita el DEFAULT 1 TEMPORAL de las tablas de 1812–1815.
 * 4) comisiones.sede_id sigue nullable (configuración global, es_config = 1)
 *    pero toda comisión real tiene sede: CHECK chk_comisiones_sede_real.
 *    MySQL no admite una CHECK sobre una columna con FK de acción
 *    referencial: fk_comisiones_sede_id pasa de ON UPDATE CASCADE (Fase 1)
 *    a ON UPDATE RESTRICT (el id de una sede no cambia).
 *
 * DDL de MySQL no es transaccional: si algo falla a mitad, volver a correr
 * es seguro (cada paso comprueba su estado).
 *
 * Fuera de este cierre (Fase 4): informes_discrepancias_rtm (su modelo aún
 * no pone la sede), configuracion_meta_mensual e historico_meta_diario (su
 * DEFAULT 1 es de la fase de metas).
 */
const QUITAR_DEFAULT = [
  'turnero_multimedia',
  'turnero_mensajes_ticker',
  'captacion_dateos',
  'continuidad_overrides',
  'liquidaciones',
  'comprobantes_pago',
  'agentes_captacions',
  'convenios',
  'prospectos',
  'telemercadeo_gestiones',
  'telemercadeo_ciclos',
]
const NOT_NULL_NUEVAS = ['tickets']
const FK_FACT = 'facturacion_tickets_sede_id_foreign'
const CHECK_COMISIONES = 'chk_comisiones_sede_real'
const FK_COMISIONES = 'fk_comisiones_sede_id'

type Db = { rawQuery: (sql: string, b?: any) => any }

async function contar(db: Db, sql: string): Promise<number> {
  const r = await db.rawQuery(sql)
  return Number(r[0][0].n)
}

async function checkExiste(db: Db): Promise<boolean> {
  return (
    (await contar(
      db,
      `SELECT COUNT(*) AS n FROM information_schema.table_constraints
        WHERE table_schema = DATABASE() AND table_name = 'comisiones'
          AND constraint_name = '${CHECK_COMISIONES}'`
    )) > 0
  )
}

export default class MultisedeCierreFase3 extends BaseSchema {
  async up() {
    const tablas = ['facturacion_tickets', ...NOT_NULL_NUEVAS, ...QUITAR_DEFAULT]
    for (const t of tablas) {
      if (!(await columnaExiste(this.db, t, 'sede_id'))) {
        throw new Error(`[multisede] ${t}.sede_id no existe`)
      }
    }

    // Requisito: ninguna fila sin sede (no se rellena aquí).
    const pendientes: string[] = []
    for (const t of tablas) {
      const n = await contar(this.db, `SELECT COUNT(*) AS n FROM ${t} WHERE sede_id IS NULL`)
      if (n > 0) pendientes.push(`${t}: ${n}`)
    }
    const comisionesSinSede = await contar(
      this.db,
      'SELECT COUNT(*) AS n FROM comisiones WHERE es_config = 0 AND sede_id IS NULL'
    )
    if (comisionesSinSede > 0) pendientes.push(`comisiones reales: ${comisionesSinSede}`)
    if (pendientes.length) {
      throw new Error(
        `[multisede] Filas sin sede (correr antes el backfill del checklist): ${pendientes.join(', ')}`
      )
    }

    // 1) facturacion_tickets: FK SET NULL → RESTRICT y NOT NULL.
    if (await fkExiste(this.db, 'facturacion_tickets', FK_FACT)) {
      await this.db.rawQuery(`ALTER TABLE facturacion_tickets DROP FOREIGN KEY ${FK_FACT}`)
    }
    await this.db.rawQuery('ALTER TABLE facturacion_tickets MODIFY sede_id INT UNSIGNED NOT NULL')
    await this.db.rawQuery(
      `ALTER TABLE facturacion_tickets ADD CONSTRAINT ${FK_FACT}
         FOREIGN KEY (sede_id) REFERENCES sedes (id) ON DELETE RESTRICT`
    )

    // 2) y 3) NOT NULL sin DEFAULT.
    for (const t of [...NOT_NULL_NUEVAS, ...QUITAR_DEFAULT]) {
      await this.db.rawQuery(`ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NOT NULL`)
    }

    // 4) comisiones reales con sede (FK sin acción referencial + CHECK).
    if (!(await checkExiste(this.db))) {
      if (await fkExiste(this.db, 'comisiones', FK_COMISIONES)) {
        await this.db.rawQuery(`ALTER TABLE comisiones DROP FOREIGN KEY ${FK_COMISIONES}`)
      }
      await this.db.rawQuery(
        `ALTER TABLE comisiones ADD CONSTRAINT ${FK_COMISIONES}
           FOREIGN KEY (sede_id) REFERENCES sedes (id) ON UPDATE RESTRICT ON DELETE RESTRICT`
      )
      await this.db.rawQuery(
        `ALTER TABLE comisiones ADD CONSTRAINT ${CHECK_COMISIONES}
           CHECK (es_config = 1 OR sede_id IS NOT NULL)`
      )
    }
  }

  async down() {
    if (await checkExiste(this.db)) {
      await this.db.rawQuery(`ALTER TABLE comisiones DROP CHECK ${CHECK_COMISIONES}`)
      if (await fkExiste(this.db, 'comisiones', FK_COMISIONES)) {
        await this.db.rawQuery(`ALTER TABLE comisiones DROP FOREIGN KEY ${FK_COMISIONES}`)
      }
      await this.db.rawQuery(
        `ALTER TABLE comisiones ADD CONSTRAINT ${FK_COMISIONES}
           FOREIGN KEY (sede_id) REFERENCES sedes (id) ON UPDATE CASCADE ON DELETE RESTRICT`
      )
    }
    for (const t of QUITAR_DEFAULT) {
      await this.db.rawQuery(
        `ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NOT NULL DEFAULT ${SEDE_IBAGUE}`
      )
    }
    for (const t of NOT_NULL_NUEVAS) {
      await this.db.rawQuery(`ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NULL DEFAULT NULL`)
    }
    if (await fkExiste(this.db, 'facturacion_tickets', FK_FACT)) {
      await this.db.rawQuery(`ALTER TABLE facturacion_tickets DROP FOREIGN KEY ${FK_FACT}`)
    }
    await this.db.rawQuery(
      'ALTER TABLE facturacion_tickets MODIFY sede_id INT UNSIGNED NULL DEFAULT NULL'
    )
    await this.db.rawQuery(
      `ALTER TABLE facturacion_tickets ADD CONSTRAINT ${FK_FACT}
         FOREIGN KEY (sede_id) REFERENCES sedes (id) ON DELETE SET NULL`
    )
  }
}
