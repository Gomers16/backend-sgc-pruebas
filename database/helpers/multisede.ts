// database/helpers/multisede.ts
//
// Utilidades de las migraciones multi-sede (Fase 1). MySQL no soporta
// "ADD COLUMN/INDEX IF NOT EXISTS" en esta versión, así que todo se verifica
// contra information_schema (mismo patrón que 1784900002000 y
// 1787000000007) para que un reintento tras una falla a mitad sea seguro.
//
// Los backfills imprimen conteos por sede antes/después y lanzan error si
// los totales cambian o si queda algo sin sede donde no debe.

export const SEDE_IBAGUE = 1

// Cliente mínimo: QueryClientContract de Lucid (this.db en migraciones).
type Db = { rawQuery: (sql: string, bindings?: any) => any }

async function filas(db: Db, sql: string, b: unknown[] = []): Promise<any[]> {
  const r = await db.rawQuery(sql, b)
  return r[0] as any[]
}

export async function columnaExiste(db: Db, tabla: string, columna: string) {
  return (
    (
      await filas(
        db,
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
        [tabla, columna]
      )
    ).length > 0
  )
}

export async function indiceExiste(db: Db, tabla: string, indice: string) {
  return (
    (
      await filas(
        db,
        `SELECT 1 FROM information_schema.statistics
          WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
        [tabla, indice]
      )
    ).length > 0
  )
}

export async function fkExiste(db: Db, tabla: string, fk: string) {
  return (
    (
      await filas(
        db,
        `SELECT 1 FROM information_schema.table_constraints
          WHERE table_schema = DATABASE() AND table_name = ? AND constraint_name = ?
            AND constraint_type = 'FOREIGN KEY'`,
        [tabla, fk]
      )
    ).length > 0
  )
}

/** Agrega sede_id INT UNSIGNED NULL + índice + FK a sedes (idempotente). */
export async function agregarSedeId(db: Db, tabla: string) {
  if (!(await columnaExiste(db, tabla, 'sede_id'))) {
    await db.rawQuery(`ALTER TABLE \`${tabla}\` ADD COLUMN sede_id INT UNSIGNED NULL`)
  }
  const idx = `idx_${tabla}_sede_id`.slice(0, 64)
  if (!(await indiceExiste(db, tabla, idx))) {
    await db.rawQuery(`ALTER TABLE \`${tabla}\` ADD INDEX \`${idx}\` (sede_id)`)
  }
  const fk = `fk_${tabla}_sede_id`.slice(0, 64)
  if (!(await fkExiste(db, tabla, fk))) {
    await db.rawQuery(
      `ALTER TABLE \`${tabla}\` ADD CONSTRAINT \`${fk}\`
         FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE RESTRICT ON UPDATE CASCADE`
    )
  }
}

/** Revierte agregarSedeId (FK, índice, columna). No toca otros datos. */
export async function quitarSedeId(db: Db, tabla: string) {
  const fk = `fk_${tabla}_sede_id`.slice(0, 64)
  if (await fkExiste(db, tabla, fk)) {
    await db.rawQuery(`ALTER TABLE \`${tabla}\` DROP FOREIGN KEY \`${fk}\``)
  }
  const idx = `idx_${tabla}_sede_id`.slice(0, 64)
  if (await indiceExiste(db, tabla, idx)) {
    await db.rawQuery(`ALTER TABLE \`${tabla}\` DROP INDEX \`${idx}\``)
  }
  if (await columnaExiste(db, tabla, 'sede_id')) {
    await db.rawQuery(`ALTER TABLE \`${tabla}\` DROP COLUMN sede_id`)
  }
}

export type Conteo = Record<string, number>

export async function contarPorSede(db: Db, tabla: string, where = '1=1'): Promise<Conteo> {
  const rs = await filas(
    db,
    `SELECT sede_id, COUNT(*) AS n FROM \`${tabla}\` WHERE ${where} GROUP BY sede_id`
  )
  const out: Conteo = {}
  for (const r of rs) out[r.sede_id === null ? 'null' : String(r.sede_id)] = Number(r.n)
  return out
}

const total = (c: Conteo) => Object.values(c).reduce((a, b) => a + b, 0)

/**
 * Corre los pasos de backfill (UPDATE ... WHERE sede_id IS NULL en orden de
 * prioridad), imprime conteos y valida: el total no cambia y, si
 * `permitirNull` no lo autoriza, no queda ninguna fila sin sede.
 */
export async function backfill(
  db: Db,
  tabla: string,
  pasos: Array<{ desc: string; sql: string }>,
  opts: { permitirNull?: string } = {}
) {
  const antes = await contarPorSede(db, tabla)
  const detalle: string[] = []
  for (const p of pasos) {
    const r = await db.rawQuery(p.sql)
    detalle.push(`${p.desc}: ${Number(r[0]?.affectedRows ?? 0)}`)
  }
  const despues = await contarPorSede(db, tabla)
  console.log(
    `[multisede] ${tabla} antes ${JSON.stringify(antes)} → después ${JSON.stringify(despues)} | ${detalle.join(' · ')}`
  )
  if (total(antes) !== total(despues)) {
    throw new Error(`[multisede] ${tabla}: el total cambió ${total(antes)} → ${total(despues)}`)
  }
  const sinSede = opts.permitirNull
    ? Number(
        (
          await filas(
            db,
            `SELECT COUNT(*) AS n FROM \`${tabla}\` WHERE sede_id IS NULL AND NOT (${opts.permitirNull})`
          )
        )[0].n
      )
    : (despues['null'] ?? 0)
  if (sinSede > 0) {
    throw new Error(`[multisede] ${tabla}: quedan ${sinSede} filas sin sede`)
  }
  return { antes, despues }
}
