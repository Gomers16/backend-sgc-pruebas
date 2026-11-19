import { test } from '@japa/runner'
import { compose } from '@adonisjs/core/helpers'
import { BaseModel, belongsTo, column, hasMany } from '@adonisjs/lucid/orm'
import type { BelongsTo, HasMany } from '@adonisjs/lucid/types/relations'
import Database from '@adonisjs/lucid/services/db'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { conSede, permitirConsultasSinContexto, sinFiltroDeSede } from '#services/sede_scope'

// Multi-sede Fase 2 — comportamiento del mixin SedeScoped con Lucid real.
// Tablas propias del test (zz_ms2_padres / zz_ms2_hijos), creadas y
// borradas aquí: en la Fase 2 el mixin no se aplica a ningún modelo de
// negocio. Documenta también los LÍMITES (whereHas, update masivo).

class Hijo extends compose(BaseModel, SedeScoped) {
  static table = 'zz_ms2_hijos'
  @column({ isPrimary: true }) declare id: number
  @column({ columnName: 'padre_id' }) declare padreId: number
  @column({ columnName: 'sede_id' }) declare sedeId: number
  @column() declare nombre: string
  @belongsTo(() => Padre, { foreignKey: 'padreId' }) declare padre: BelongsTo<typeof Padre>
}

class Padre extends compose(BaseModel, SedeScoped) {
  static table = 'zz_ms2_padres'
  @column({ isPrimary: true }) declare id: number
  @column({ columnName: 'sede_id' }) declare sedeId: number
  @column() declare nombre: string
  @hasMany(() => Hijo, { foreignKey: 'padreId' }) declare hijos: HasMany<typeof Hijo>
}

let p1 = 0 // padre de sede 1
let p2 = 0 // padre de sede 2

async function crearTablas() {
  await Database.rawQuery('DROP TABLE IF EXISTS zz_ms2_hijos')
  await Database.rawQuery('DROP TABLE IF EXISTS zz_ms2_padres')
  await Database.rawQuery(
    `CREATE TABLE zz_ms2_padres (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       sede_id INT UNSIGNED NOT NULL, nombre VARCHAR(50) NOT NULL)`
  )
  await Database.rawQuery(
    `CREATE TABLE zz_ms2_hijos (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
       padre_id INT UNSIGNED NOT NULL, sede_id INT UNSIGNED NOT NULL, nombre VARCHAR(50) NOT NULL)`
  )
  ;[p1] = await Database.table('zz_ms2_padres').insert({ sede_id: 1, nombre: 'P-IBAGUE' })
  ;[p2] = await Database.table('zz_ms2_padres').insert({ sede_id: 2, nombre: 'P-BOGOTA' })
  await Database.table('zz_ms2_hijos').multiInsert([
    { padre_id: p1, sede_id: 1, nombre: 'H1-IBAGUE' },
    { padre_id: p1, sede_id: 2, nombre: 'H1-BOGOTA-INCONSISTENTE' },
    { padre_id: p2, sede_id: 2, nombre: 'H2-BOGOTA' },
  ])
}

test.group('Multi-sede Fase 2 · mixin SedeScoped', (group) => {
  // Fail-closed real: sin el permiso de tests/bootstrap.ts.
  group.setup(async () => {
    permitirConsultasSinContexto(false)
    await crearTablas()
  })
  group.teardown(async () => {
    permitirConsultasSinContexto(true)
    await Database.rawQuery('DROP TABLE IF EXISTS zz_ms2_hijos')
    await Database.rawQuery('DROP TABLE IF EXISTS zz_ms2_padres')
  })

  test('fail-closed: sin sede activa la consulta lanza error', async ({ assert }) => {
    await assert.rejects(async () => {
      await Padre.query().exec()
    }, /sin sede activa/)
    await assert.rejects(async () => {
      await Padre.find(p1)
    }, /sin sede activa/)
  })

  test('listado: solo la sede activa', async ({ assert }) => {
    const ib = await conSede([1], async () => await Padre.query().orderBy('id'))
    assert.deepEqual(
      ib.map((p) => p.nombre),
      ['P-IBAGUE']
    )
    const todas = await conSede([1, 2], async () => await Padre.query().orderBy('id'))
    assert.lengthOf(todas, 2)
  })

  test('por ID: find → null, findOrFail/firstOrFail → 404 de otra sede', async ({ assert }) => {
    await conSede([1], async () => {
      assert.isNull(await Padre.find(p2))
      assert.isNull(await Padre.findBy('nombre', 'P-BOGOTA'))
      assert.equal((await Padre.findOrFail(p1)).nombre, 'P-IBAGUE')
      try {
        await Padre.findOrFail(p2)
        assert.fail('debió lanzar')
      } catch (e: any) {
        assert.equal(e.code, 'E_ROW_NOT_FOUND')
        assert.equal(e.status, 404)
      }
      try {
        await Padre.query().where('id', p2).firstOrFail()
        assert.fail('debió lanzar')
      } catch (e: any) {
        assert.equal(e.status, 404)
      }
    })
  })

  test('paginate: filas y total filtrados', async ({ assert }) => {
    const pag = await conSede([2], async () => await Padre.query().paginate(1, 10))
    assert.equal(pag.total, 1)
    assert.deepEqual(
      pag.all().map((p) => p.nombre),
      ['P-BOGOTA']
    )
  })

  test('preload: la relación también se filtra por sede', async ({ assert }) => {
    const [padre] = await conSede(
      [1],
      async () => await Padre.query().where('id', p1).preload('hijos')
    )
    assert.deepEqual(
      padre.hijos.map((h) => h.nombre),
      ['H1-IBAGUE']
    )
    const [hijo] = await conSede(
      [2],
      async () => await Hijo.query().where('nombre', 'H2-BOGOTA').preload('padre')
    )
    assert.equal(hijo.padre.nombre, 'P-BOGOTA')
  })

  test('LÍMITE whereHas: la subconsulta NO pasa por el filtro del modelo relacionado', async ({
    assert,
  }) => {
    // P-IBAGUE solo tiene un hijo "de Bogotá" (dato inconsistente a propósito).
    const padres = await conSede(
      [1],
      async () =>
        await Padre.query().whereHas('hijos', (q) => q.where('nombre', 'H1-BOGOTA-INCONSISTENTE'))
    )
    // La consulta principal sí filtra (solo padres de sede 1), pero el
    // whereHas encuentra al hijo de sede 2: el filtro no entra en la
    // subconsulta. En la Fase 3, whereHas sobre modelos de sede debe filtrar a mano.
    assert.deepEqual(
      padres.map((p) => p.nombre),
      ['P-IBAGUE']
    )
  })

  test('crear: pone la sede activa e ignora la del payload', async ({ assert }) => {
    const nuevo = await conSede([1], () => Padre.create({ nombre: 'NUEVO', sedeId: 2 }))
    assert.equal(nuevo.sedeId, 1)
    const fila = await Database.from('zz_ms2_padres').where('id', nuevo.id).first()
    assert.equal(fila.sede_id, 1)
  })

  test('crear con "todas" → error 400; sin sede → error', async ({ assert }) => {
    try {
      await conSede([1, 2], () => Padre.create({ nombre: 'NO', sedeId: 1 }))
      assert.fail('debió lanzar')
    } catch (e: any) {
      assert.equal(e.status, 400)
    }
    await assert.rejects(async () => {
      await Padre.create({ nombre: 'NO', sedeId: 1 })
    }, /sin sede activa/)
    const n = await Database.from('zz_ms2_padres').where('nombre', 'NO').count('* as n').first()
    assert.equal(Number(n.n), 0)
  })

  test('bypass explícito: sinFiltroDeSede() y querySinSede()', async ({ assert }) => {
    const a = await sinFiltroDeSede(async () => await Padre.query())
    assert.isAtLeast(a.length, 2)
    const b = await conSede([1], () => (Padre as any).querySinSede().exec())
    assert.isAtLeast(b.length, 2)
    const c = await sinFiltroDeSede(() => Padre.create({ nombre: 'BYPASS', sedeId: 2 }))
    assert.equal(c.sedeId, 2) // con bypass se respeta lo que trae
  })

  test('LÍMITE update/delete masivo por query: no pasan por hooks', async ({ assert }) => {
    // Documentado: Model.query().update() no filtra; en esos casos usar aplicarSede().
    const afectadas = await conSede(
      [1],
      async () => await Padre.query().where('nombre', 'P-BOGOTA').update({ nombre: 'P-BOGOTA' })
    )
    assert.deepEqual(afectadas, [1])
  })
})
