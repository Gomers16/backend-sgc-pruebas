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

import type { NormalizeConstructor } from '@adonisjs/core/types/helpers'
import type { BaseModel } from '@adonisjs/lucid/orm'
import { scopeObligatorio, SedeScopeError } from '#services/sede_scope'

const SIN_SEDE = Symbol.for('multisede.sinSede')
const YA_FILTRADO = Symbol.for('multisede.filtrado')

type Qb = {
  whereIn: (col: string, vals: number[]) => unknown
  [k: symbol]: unknown
}

function filtrar(query: Qb, tabla: string, columna: string) {
  if (query[SIN_SEDE] || query[YA_FILTRADO]) return
  const s = scopeObligatorio()
  if (!s) return // bypass explícito
  query.whereIn(`${tabla}.${columna}`, s.sedeIds)
  query[YA_FILTRADO] = true
}

export function SedeScoped<T extends NormalizeConstructor<typeof BaseModel>>(superclass: T) {
  class ConSede extends superclass {
    /** Columna de sede en la tabla. */
    static sedeColumna = 'sede_id'
    /** Atributo del modelo que mapea esa columna. */
    static sedeAtributo = 'sedeId'

    static boot() {
      if (this.booted) return
      super.boot()
      const modelo = this as unknown as typeof ConSede & { table: string }
      this.before('find', (q: any) => filtrar(q, modelo.table, modelo.sedeColumna))
      this.before('fetch', (q: any) => filtrar(q, modelo.table, modelo.sedeColumna))
      this.before('paginate', ([countQ, q]: any[]) => {
        filtrar(countQ, modelo.table, modelo.sedeColumna)
        filtrar(q, modelo.table, modelo.sedeColumna)
      })
      this.before('create', (instancia: any) => {
        const s = scopeObligatorio()
        if (!s) return // bypass: se respeta lo que traiga
        if (s.todas || !s.sedeEscritura) {
          throw new SedeScopeError('Para operar debes elegir una sede concreta (no "todas").', 400)
        }
        instancia[modelo.sedeAtributo] = s.sedeEscritura
      })
    }

    /** Consulta SIN filtro de sede (bypass explícito y visible en el código). */
    static querySinSede(this: any, options?: any) {
      const q = this.query(options)
      q[SIN_SEDE] = true
      return q
    }
  }
  return ConSede
}
