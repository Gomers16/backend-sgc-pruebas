// app/services/sede_scope.ts
//
// Multi-sede, Fase 2 — núcleo del aislamiento por sede.
//
// 1) resolverSedeActiva(): regla pura (sin BD) de qué sede(s) ve un usuario
//    en un request:
//      - SUPER_ADMIN / GERENCIA: cabecera X-Sede-Id = id de sede ACTIVA o
//        "todas" (todas las activas, solo lectura). Sin cabecera → su sede.
//      - Cualquier otro rol: la cabecera se IGNORA; siempre su sede.
//      - Usuario sin sede (y SA/GER sin cabecera ni sede) → 403.
//    La sede propia vale aunque esté inactiva (la sede QA de los tests).
//
// 2) Contexto: el middleware sede_activa deja el SedeScope en
//    ctx.sedeScope; con useAsyncLocalStorage las consultas lo leen vía
//    HttpContext.get(). Fuera de un request (comandos, jobs, tests) hay que
//    declararlo: conSede([ids], fn) o sinFiltroDeSede(fn). Sin nada → error
//    (fail-closed).
//
// 3) SQL crudo / db.from: sedeSql('t') → "t.sede_id IN (1)" y
//    aplicarSede(qb, 't.sede_id') para el query builder de knex/Lucid.

import { AsyncLocalStorage } from 'node:async_hooks'
import { HttpContext } from '@adonisjs/core/http'
import { Exception } from '@adonisjs/core/exceptions'

export const ROLES_MULTISEDE = new Set(['SUPER_ADMIN', 'GERENCIA'])
export const CABECERA_SEDE = 'x-sede-id'

export interface SedeScope {
  /** Sedes visibles en este request (lecturas). */
  sedeIds: number[]
  /** true si SA/GER pidió "todas" (solo lectura). */
  todas: boolean
  /** Sede en la que se crea/edita; null con "todas". */
  sedeEscritura: number | null
  /** Sede propia del usuario (puede ser null solo para /auth/me). */
  sedeUsuario: number | null
  puedeCambiarSede: boolean
}

export type ResultadoSede =
  | { ok: true; scope: SedeScope }
  | { ok: false; status: 400 | 403; message: string }

export class SedeScopeError extends Exception {
  constructor(message: string, status = 403) {
    super(message, { status, code: 'E_SEDE_SCOPE' })
  }
}

/** Regla pura de resolución de la sede activa. */
export function resolverSedeActiva(entrada: {
  rol: string | null | undefined
  sedeUsuario: number | null | undefined
  cabecera: string | null | undefined
  sedesActivas: number[]
}): ResultadoSede {
  const rol = (entrada.rol ?? '').toUpperCase().trim()
  const sedeUsuario = entrada.sedeUsuario ?? null
  const puedeCambiarSede = ROLES_MULTISEDE.has(rol)
  const cab = (entrada.cabecera ?? '').trim()

  if (puedeCambiarSede && cab !== '') {
    if (cab.toLowerCase() === 'todas') {
      return {
        ok: true,
        scope: {
          sedeIds: [...entrada.sedesActivas].sort((a, b) => a - b),
          todas: true,
          sedeEscritura: null,
          sedeUsuario,
          puedeCambiarSede,
        },
      }
    }
    const id = Number(cab)
    if (!Number.isInteger(id) || id <= 0 || !entrada.sedesActivas.includes(id)) {
      return { ok: false, status: 400, message: `X-Sede-Id inválido: "${cab}"` }
    }
    return {
      ok: true,
      scope: { sedeIds: [id], todas: false, sedeEscritura: id, sedeUsuario, puedeCambiarSede },
    }
  }

  if (!sedeUsuario) {
    return {
      ok: false,
      status: 403,
      message: 'Tu usuario no tiene sede asignada. Contacta al administrador.',
    }
  }
  return {
    ok: true,
    scope: {
      sedeIds: [sedeUsuario],
      todas: false,
      sedeEscritura: sedeUsuario,
      sedeUsuario,
      puedeCambiarSede,
    },
  }
}

/* ============================ Contexto ============================ */

type Override = { tipo: 'sin_filtro' } | { tipo: 'sede'; scope: SedeScope }
const als = new AsyncLocalStorage<Override>()

/** Ejecuta fn sin filtro de sede (bypass explícito: jobs globales, migraciones de datos, tests). */
export function sinFiltroDeSede<T>(fn: () => T): T {
  return als.run({ tipo: 'sin_filtro' }, fn)
}

/** Ejecuta fn con una sede explícita (comandos, jobs por sede, tests). */
export function conSede<T>(sedeIds: number[], fn: () => T, sedeEscritura?: number): T {
  if (!sedeIds.length || sedeIds.some((s) => !Number.isInteger(s) || s <= 0)) {
    throw new SedeScopeError('conSede: lista de sedes inválida', 500)
  }
  const escritura = sedeEscritura ?? (sedeIds.length === 1 ? sedeIds[0] : null)
  return als.run(
    {
      tipo: 'sede',
      scope: {
        sedeIds: [...sedeIds],
        todas: sedeIds.length > 1,
        sedeEscritura: escritura,
        sedeUsuario: null,
        puedeCambiarSede: false,
      },
    },
    fn
  )
}

/**
 * Scope vigente: override explícito > el del request > nada.
 * Devuelve 'sin_filtro' si se pidió el bypass.
 */
export function scopeActual(): SedeScope | 'sin_filtro' | null {
  const o = als.getStore()
  if (o?.tipo === 'sin_filtro') return 'sin_filtro'
  if (o?.tipo === 'sede') return o.scope
  const ctx = HttpContext.get()
  // Dentro de un request manda SIEMPRE el scope del request (también en tests).
  if (ctx) return ctx.sedeScope ?? null
  return consultasSinContextoPermitidas ? 'sin_filtro' : null
}

/**
 * SOLO tests/bootstrap.ts: el código del test (setup, fixtures, asserts
 * contra la BD) corre fuera de cualquier request y usa los modelos
 * directamente; ahí se permite consultar sin filtro. Los requests HTTP de
 * los tests siguen usando la sede del usuario. En la app real nunca se
 * activa: fuera de un request sin conSede()/sinFiltroDeSede() → error.
 */
let consultasSinContextoPermitidas = false
export function permitirConsultasSinContexto(valor: boolean) {
  consultasSinContextoPermitidas = valor
}
export function consultasSinContextoActivas() {
  return consultasSinContextoPermitidas
}

/** Scope obligatorio (fail-closed). null = bypass explícito. */
export function scopeObligatorio(): SedeScope | null {
  const s = scopeActual()
  if (s === 'sin_filtro') return null
  if (!s) {
    throw new SedeScopeError(
      'Consulta de datos por sede sin sede activa (usa conSede() o sinFiltroDeSede())',
      500
    )
  }
  return s
}

/* ============================ SQL ============================ */

const COLUMNA_RE = /^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)?$/

/**
 * Fragmento SQL "alias.sede_id IN (1,2)" con la sede activa. Los ids son
 * enteros validados, así que van en línea (sin bindings). Con bypass
 * devuelve "1=1". `columna` puede ser un alias ('t') o 'alias.columna'.
 *
 * Es solo el fragmento: el SQL que lo usa debe ponerlo en AND con sus OR
 * agrupados ("WHERE (a OR b) AND <sedeSql>"); "a OR b AND <sedeSql>" deja
 * pasar la rama "a" de otra sede. Sobre un query builder, preferir
 * aplicarSede(), que agrupa solo.
 */
export function sedeSql(aliasOColumna: string): string {
  if (!COLUMNA_RE.test(aliasOColumna)) {
    throw new SedeScopeError(`sedeSql: columna inválida "${aliasOColumna}"`, 500)
  }
  const col = aliasOColumna.includes('.') ? aliasOColumna : `${aliasOColumna}.sede_id`
  const s = scopeObligatorio()
  if (!s) return '1=1'
  if (!s.sedeIds.length) return '1=0'
  return `${col} IN (${s.sedeIds.map((n) => Math.trunc(n)).join(',')})`
}

/**
 * Aplica el filtro de sede a un query builder (db.from / Model.query / trx.from).
 * Antes agrupa los where que ya tiene (wrapExisting() de Lucid; en un builder
 * knex puro, sus _statements): si no, un orWhere suelto quedaría
 * "a OR b AND sede_id IN (...)" y la rama "a" traería filas de otra sede.
 * Un orWhere agregado DESPUÉS de aplicarSede() sí se lo saltaría: el filtro
 * va al final de la consulta (o con sus OR propios ya agrupados).
 */
export function aplicarSede<Q extends { whereIn: (c: string, v: number[]) => unknown }>(
  qb: Q,
  columna: string
): Q {
  if (!COLUMNA_RE.test(columna)) {
    throw new SedeScopeError(`aplicarSede: columna inválida "${columna}"`, 500)
  }
  const s = scopeObligatorio()
  if (!s) return qb
  agruparWheres(qb)
  qb.whereIn(columna, s.sedeIds)
  return qb
}

function agruparWheres(qb: unknown) {
  const q = qb as any
  if (typeof q.wrapExisting === 'function') {
    q.wrapExisting() // Lucid (DatabaseQueryBuilder / ModelQueryBuilder)
    return
  }
  const st = q?._statements
  if (!Array.isArray(st)) return
  const wheres = st.filter((x: any) => x.grouping === 'where')
  if (!wheres.some((x: any) => x.bool === 'or')) return
  q._statements = st.filter((x: any) => x.grouping !== 'where')
  q.where(function (this: any) {
    this._statements.push(...wheres)
  })
}

/** Sede donde se escribe (crear/editar). Error si no hay o si es "todas". */
export function sedeParaEscritura(): number | null {
  const s = scopeObligatorio()
  if (!s) return null
  if (s.todas || !s.sedeEscritura) {
    throw new SedeScopeError('Para operar debes elegir una sede concreta (no "todas").', 400)
  }
  return s.sedeEscritura
}

declare module '@adonisjs/core/http' {
  interface HttpContext {
    sedeScope?: SedeScope | null
  }
}

/* ===================== Configuración con override por sede ===================== */

/**
 * Configuración "global con override por sede" (tablas configuracion_*_global
 * y similares: sede_id NULL = global). Restringe la consulta a la fila de la
 * sede activa o a la global y ordena para que gane el override:
 *   - sede concreta → (sede_id = sede OR sede_id IS NULL), override primero;
 *   - "todas" → solo la global (no hay una sede que elegir);
 *   - bypass (sin request: comandos, tests) → todas las filas, override
 *     primero (hoy: la única fila global, igual que antes).
 * Siempre desempata por id ascendente (antes: .first() = la de menor id).
 */
export function preferirConfigDeSede<
  Q extends {
    where: (...a: any[]) => any
    whereNull: (c: string) => any
    orderByRaw: (sql: string) => any
    orderBy: (c: string, d?: 'asc' | 'desc') => any
  },
>(qb: Q, columna = 'sede_id'): Q {
  if (!COLUMNA_RE.test(columna)) {
    throw new SedeScopeError(`preferirConfigDeSede: columna inválida "${columna}"`, 500)
  }
  const s = scopeObligatorio()
  const sede = s && !s.todas ? s.sedeEscritura : null
  if (s && sede) {
    qb.where((q: any) => q.where(columna, sede).orWhereNull(columna))
  } else if (s) {
    qb.whereNull(columna)
  }
  qb.orderByRaw(`${columna} IS NULL`)
  qb.orderBy('id', 'asc')
  return qb
}

/** Clave de caché por sede para valores de configuración ("global" en todas/bypass). */
export function claveCacheSede(): string {
  const s = scopeActual()
  if (!s || s === 'sin_filtro' || s.todas || !s.sedeEscritura) return 'global'
  return `sede:${s.sedeEscritura}`
}
