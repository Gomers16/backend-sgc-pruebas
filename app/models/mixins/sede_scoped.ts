// app/models/mixins/sede_scoped.ts
//
// Multi-sede Fase 2 — mixin para modelos con datos por sede.
//
//   class Algo extends compose(BaseModel, SedeScoped) { @column() declare sedeId: number }
//
// Lecturas (before:find / before:fetch / before:paginate): agrega
// `tabla.sede_id IN (sedes activas)`. find / findOrFail / firstOrFail de otra
// sede → null / E_ROW_NOT_FOUND (404 en HTTP).
// Creación (before:create): pone sede_id = sede activa de escritura e
// IGNORA lo que venga en el payload (un body con sede_id no decide nada).
// "todas" → error 400 al crear.
//
// Fail-closed: sin sede activa (request, conSede() o sinFiltroDeSede()) la
// consulta lanza error. Bypass por consulta: Modelo.querySinSede().
// Editar o borrar (before:update / before:delete) con "todas" → error 400:
// "todas" es solo lectura.
// Opcionales (3d): sedeGlobalSi (filas con sede NULL que valen para toda
// sede, p. ej. la configuración de comisiones) y resolverSedeAlCrear (sede
// derivada de los datos del registro, que tiene que ser la sede activa).
//
// LÍMITES (verificados en tests/functional/multisede_fase2_mixin.spec.ts):
//  - Los hooks solo corren en SELECT del query builder del modelo:
//    Model.query().update()/delete() masivos NO se filtran → usar
//    aplicarSede() en esos casos.
//  - whereHas/has sobre una relación: la subconsulta NO pasa por los hooks
//    del modelo relacionado (solo filtra la consulta principal).
//  - preload SÍ se filtra (la consulta de la relación corre los hooks).
//  - Con conSede()/sinFiltroDeSede() el await va DENTRO del callback:
//    `conSede([1], () => Modelo.query())` devuelve el builder sin ejecutar
//    y el await de afuera corre sin contexto (fail-closed → error).
//    Correcto: `conSede([1], async () => await Modelo.query())`.
//
// En la Fase 2 NO se aplica a ningún modelo de negocio; se activa modelo por
// modelo en las subfases de la Fase 3.

import type {
  LucidModel,
  ModelAdapterOptions,
  ModelQueryBuilderContract,
} from '@adonisjs/lucid/types/model'
import type { NormalizeConstructor } from '@adonisjs/core/types/helpers'
import type { BaseModel } from '@adonisjs/lucid/orm'
import db from '@adonisjs/lucid/services/db'
import { scopeObligatorio, SedeScopeError } from '#services/sede_scope'

const SIN_SEDE = Symbol.for('multisede.sinSede')
const YA_FILTRADO = Symbol.for('multisede.filtrado')

type Qb = {
  whereIn: (col: string, vals: number[]) => unknown
  [k: symbol]: unknown
}

/** Modelo hijo sin columna sede_id: hereda la sede de su padre. */
export interface SedeVia {
  /** Atributo del modelo con el id del padre (p. ej. 'turnoId'). */
  atributo: string
  /** Columna FK al padre (p. ej. 'turno_id'). */
  columna: string
  /** Tabla del padre, que tiene sede_id (p. ej. 'turnos_rtms') o hereda vía `padre`. */
  tablaPadre: string
  /**
   * Si el padre TAMPOCO tiene sede_id: cómo llega él a la suya (cadena de
   * herencia; p. ej. liquidacion_pagos → tramite_liquidaciones → tramites).
   */
  padre?: { columna: string; tablaPadre: string; padre?: SedeVia['padre'] }
}

/** Condición SQL "tabla.columna IN (SELECT …)" siguiendo la cadena hasta sede_id. */
function sqlVia(
  tabla: string,
  columna: string,
  tablaPadre: string,
  padre: SedeVia['padre'],
  ids: string
): string {
  const condPadre = padre
    ? sqlVia(tablaPadre, padre.columna, padre.tablaPadre, padre.padre, ids)
    : `${tablaPadre}.sede_id IN (${ids})`
  return `${tabla}.${columna} IN (SELECT ${tablaPadre}.id FROM ${tablaPadre} WHERE ${condPadre})`
}

/** Sede del registro padre `id` siguiendo la cadena (null si no existe). */
async function sedeDelPadre(
  cliente: any,
  tablaPadre: string,
  id: number,
  padre: SedeVia['padre']
): Promise<number | null> {
  if (!padre) {
    const fila = await cliente.from(tablaPadre).where('id', id).select('sede_id').first()
    return fila ? Number(fila.sede_id) : null
  }
  const fila = await cliente.from(tablaPadre).where('id', id).select(padre.columna).first()
  if (!fila || !fila[padre.columna]) return null
  return sedeDelPadre(cliente, padre.tablaPadre, Number(fila[padre.columna]), padre.padre)
}

function viaValida(v: { columna: string; tablaPadre: string; padre?: SedeVia['padre'] }): boolean {
  return IDENT.test(v.columna) && IDENT.test(v.tablaPadre) && (!v.padre || viaValida(v.padre))
}

const IDENT = /^[a-z_][a-z0-9_]*$/
/** Condición de fila global: "columna = entero" (p. ej. "es_config = 1"). */
const COND_GLOBAL = /^([a-z_][a-z0-9_]*) = (\d+)$/

/** Resultado de resolverSedeAlCrear: número = esa sede; null = fila global; undefined = sede activa. */
export type SedeAlCrear = number | null | undefined

const SOLO_LECTURA = 'Para operar debes elegir una sede concreta (no "todas").'

/**
 * Agrupa los where que ya tiene la consulta en un paréntesis (API pública de
 * Lucid wrapExisting()) antes de agregar el filtro: si no, una consulta con
 * OR a nivel superior quedaría "a OR b AND sede_id IN (...)" y la rama "a"
 * se saltaría la sede. Test: "orWhere a nivel superior" en
 * tests/functional/multisede_fase2_mixin.spec.ts.
 */
function agruparWheres(query: Qb) {
  const q = query as any
  if (typeof q.wrapExisting === 'function') q.wrapExisting()
}

function filtrar(
  query: Qb,
  tabla: string,
  columna: string,
  via: SedeVia | null,
  globalSi: string | null
) {
  if (query[SIN_SEDE] || query[YA_FILTRADO]) return
  const s = scopeObligatorio()
  if (!s) return // bypass explícito
  agruparWheres(query)
  // Ids enteros validados por la resolución de la sede: van en línea.
  const ids = s.sedeIds.length ? s.sedeIds.map((n) => Math.trunc(n)).join(',') : 'NULL'
  if (via) {
    ;(query as any).whereRaw(sqlVia(tabla, via.columna, via.tablaPadre, via.padre, ids))
  } else if (globalSi) {
    // Filas globales (sede NULL que cumplen la condición) visibles desde toda sede.
    ;(query as any).whereRaw(
      `(${tabla}.${columna} IN (${ids}) OR (${tabla}.${columna} IS NULL AND ${tabla}.${globalSi}))`
    )
  } else {
    query.whereIn(`${tabla}.${columna}`, s.sedeIds)
  }
  query[YA_FILTRADO] = true
}

/**
 * Marca un query builder (p. ej. el de un preload) para que NO se filtre por
 * sede. Bypass explícito y visible, como querySinSede(): úsese solo para
 * identidad (el agente del propio usuario en login, /auth/me).
 */
export function sinFiltroDeSedeEnConsulta<Q>(q: Q): Q {
  ;(q as any)[SIN_SEDE] = true
  return q
}

export function SedeScoped<T extends NormalizeConstructor<typeof BaseModel>>(superclass: T) {
  class ConSede extends superclass {
    /** Columna de sede en la tabla. */
    static sedeColumna = 'sede_id'
    /** Atributo del modelo que mapea esa columna. */
    static sedeAtributo = 'sedeId'
    /** Hijo sin sede_id propio: filtra por la sede de su padre. */
    static sedeVia: SedeVia | null = null
    /**
     * Filas GLOBALES: con sede NULL y esta condición ("columna = entero") se ven
     * desde cualquier sede (p. ej. comisiones "es_config = 1"). Las demás filas
     * con sede NULL siguen invisibles (fail-closed).
     */
    static sedeGlobalSi: string | null = null
    /**
     * Sede del registro al crearlo, derivada de sus datos (p. ej. la comisión
     * toma la del turno/dateo). number = esa sede (tiene que ser la activa;
     * si no, 409); null = fila global (solo con sedeGlobalSi); undefined = la
     * sede activa. Sin definir = la sede activa.
     */
    static resolverSedeAlCrear: ((instancia: any, cliente: any) => Promise<SedeAlCrear>) | null =
      null

    static boot() {
      if (this.booted) return
      super.boot()
      const modelo = this as unknown as typeof ConSede & { table: string }
      const via = modelo.sedeVia
      if (via && !viaValida(via)) {
        throw new Error(`SedeScoped: sedeVia inválido en ${modelo.name}`)
      }
      const globalSi = modelo.sedeGlobalSi
      if (globalSi && !COND_GLOBAL.test(globalSi)) {
        throw new Error(`SedeScoped: sedeGlobalSi inválido en ${modelo.name}`)
      }
      const f = (q: any) => filtrar(q, modelo.table, modelo.sedeColumna, via, globalSi)
      this.before('find', f)
      this.before('fetch', f)
      this.before('paginate', ([countQ, q]: any[]) => {
        f(countQ)
        f(q)
      })
      this.before('create', async (instancia: any) => {
        const s = scopeObligatorio()
        if (!s) return // bypass: se respeta lo que traiga
        if (s.todas || !s.sedeEscritura) {
          throw new SedeScopeError(SOLO_LECTURA, 400)
        }
        if (!via) {
          const cliente = instancia.$trx ?? db
          const r = modelo.resolverSedeAlCrear
            ? await modelo.resolverSedeAlCrear(instancia, cliente)
            : undefined
          if (r === null) {
            if (!globalSi) throw new Error(`SedeScoped: ${modelo.name} no admite filas globales`)
            instancia[modelo.sedeAtributo] = null
            return
          }
          if (typeof r === 'number') {
            if (r !== s.sedeEscritura) {
              throw new SedeScopeError('El registro pertenece a otra sede.', 409)
            }
            instancia[modelo.sedeAtributo] = r
            return
          }
          instancia[modelo.sedeAtributo] = s.sedeEscritura
          return
        }
        // Hijo: el padre tiene que ser de la sede activa.
        const cliente = instancia.$trx ?? db
        const sedePadre = await sedeDelPadre(
          cliente,
          via.tablaPadre,
          Number(instancia[via.atributo] ?? 0),
          via.padre
        )
        if (sedePadre !== s.sedeEscritura) {
          throw new SedeScopeError('Registro padre no encontrado en la sede activa.', 404)
        }
      })
      // "Todas" es solo lectura: editar o borrar un registro también exige sede concreta.
      const soloLectura = async () => {
        const s = scopeObligatorio()
        if (s && (s.todas || !s.sedeEscritura)) throw new SedeScopeError(SOLO_LECTURA, 400)
      }
      this.before('update', soloLectura)
      this.before('delete', soloLectura)
    }

    /** Consulta SIN filtro de sede (bypass explícito y visible en el código). */
    static querySinSede<M extends LucidModel>(
      this: M,
      options?: ModelAdapterOptions
    ): ModelQueryBuilderContract<M> {
      const q = this.query(options) as any
      q[SIN_SEDE] = true
      return q
    }
  }
  return ConSede
}
