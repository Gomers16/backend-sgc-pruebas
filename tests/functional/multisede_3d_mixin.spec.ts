import { test } from '@japa/runner'
import { compose } from '@adonisjs/core/helpers'
import { BaseModel, column } from '@adonisjs/lucid/orm'
import Database from '@adonisjs/lucid/services/db'
import { SedeScoped, type SedeAlCrear } from '#models/mixins/sede_scoped'
import { conSede, permitirConsultasSinContexto } from '#services/sede_scope'

// Multi-sede 3d — extensiones del mixin que necesitan comisiones/liquidaciones:
// filas GLOBALES (sede NULL + condición), sede derivada al crear y "todas"
// solo lectura también para editar/borrar. Tabla propia zz_ms3d_cfg.

class Fila extends compose(BaseModel, SedeScoped) {
  static table = 'zz_ms3d_cfg'
  static sedeGlobalSi = 'es_config = 1'
  // Sede derivada: si trae "derivar_de", esa sede; "global" → fila global.
  static resolverSedeAlCrear = async (f: any): Promise<SedeAlCrear> => {
    if (f.esConfig) return null
    return f.$extras.derivarDe ?? undefined
  }
  @column({ isPrimary: true }) declare id: number
  @column({ columnName: 'sede_id' }) declare sedeId: number | null
  @column({ columnName: 'es_config' }) declare esConfig: boolean
  @column() declare nombre: string
}

const nombres = (fs: Fila[]) => fs.map((f) => f.nombre).sort()

async function crear(nombre: string, extra: { esConfig?: boolean; derivarDe?: number } = {}) {
  const f = new Fila()
  f.nombre = nombre
  f.esConfig = extra.esConfig ?? false
  if (extra.derivarDe) f.$extras.derivarDe = extra.derivarDe
  await f.save()
  return f
}

test.group('Multi-sede 3d · mixin (filas globales, sede derivada, todas)', (group) => {
  group.setup(async () => {
    permitirConsultasSinContexto(false)
    await Database.rawQuery('DROP TABLE IF EXISTS zz_ms3d_cfg')
    await Database.rawQuery(
      `CREATE TABLE zz_ms3d_cfg (id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
         sede_id INT UNSIGNED NULL, es_config TINYINT(1) NOT NULL DEFAULT 0,
         nombre VARCHAR(50) NOT NULL)`
    )
    await Database.table('zz_ms3d_cfg').multiInsert([
      { sede_id: null, es_config: 1, nombre: 'CFG-GLOBAL' },
      { sede_id: 1, es_config: 1, nombre: 'CFG-IBAGUE' },
      { sede_id: 1, es_config: 0, nombre: 'OP-IBAGUE' },
      { sede_id: 2, es_config: 0, nombre: 'OP-BOGOTA' },
      { sede_id: null, es_config: 0, nombre: 'OP-SIN-SEDE' },
    ])
  })
  group.teardown(async () => {
    permitirConsultasSinContexto(true)
    await Database.rawQuery('DROP TABLE IF EXISTS zz_ms3d_cfg')
  })

  test('filas globales visibles desde toda sede; operativas sin sede invisibles', async ({
    assert,
  }) => {
    const en1 = await conSede([1], async () => await Fila.query())
    const en2 = await conSede([2], async () => await Fila.query())
    assert.deepEqual(nombres(en1), ['CFG-GLOBAL', 'CFG-IBAGUE', 'OP-IBAGUE'])
    assert.deepEqual(nombres(en2), ['CFG-GLOBAL', 'OP-BOGOTA'])
    // Con un OR suelto sigue sin cruzar sedes.
    const conOr = await conSede(
      [2],
      async () => await Fila.query().where('nombre', 'OP-IBAGUE').orWhere('nombre', 'CFG-GLOBAL')
    )
    assert.deepEqual(nombres(conOr), ['CFG-GLOBAL'])
  })

  test('crear: sede derivada = activa; otra sede → 409; global → NULL', async ({ assert }) => {
    const op = await conSede([1], async () => await crear('N1', { derivarDe: 1 }))
    assert.equal(op.sedeId, 1)
    const activa = await conSede([1], async () => await crear('N2'))
    assert.equal(activa.sedeId, 1)
    const cfg = await conSede([1], async () => await crear('N3', { esConfig: true }))
    assert.isNull(cfg.sedeId)
    try {
      await conSede([1], async () => await crear('N4', { derivarDe: 2 }))
      assert.fail('debía rechazar')
    } catch (e: any) {
      assert.equal(e.status, 409)
    }
    assert.isNull(await Database.from('zz_ms3d_cfg').where('nombre', 'N4').first())
  })

  test('"todas": crear, editar y borrar → 400; leer sí', async ({ assert }) => {
    const leidas = await conSede([1, 2], async () => await Fila.query())
    assert.includeMembers(nombres(leidas), ['OP-IBAGUE', 'OP-BOGOTA'])
    const acciones: Array<() => Promise<unknown>> = [
      async () => await crear('T1'),
      async () => {
        const f = await Fila.query().where('nombre', 'OP-IBAGUE').firstOrFail()
        f.nombre = 'CAMBIADO'
        await f.save()
      },
      async () => {
        const f = await Fila.query().where('nombre', 'OP-BOGOTA').firstOrFail()
        await f.delete()
      },
    ]
    for (const accion of acciones) {
      try {
        await conSede([1, 2], accion)
        assert.fail('debía rechazar')
      } catch (e: any) {
        assert.equal(e.status, 400)
      }
    }
    const filas = await Database.from('zz_ms3d_cfg').whereIn('nombre', ['OP-IBAGUE', 'OP-BOGOTA'])
    assert.lengthOf(filas, 2)
    // Con sede concreta, editar sí.
    await conSede([1], async () => {
      const f = await Fila.query().where('nombre', 'OP-IBAGUE').firstOrFail()
      f.nombre = 'OP-IBAGUE'
      f.esConfig = false
      await f.save()
    })
  })
})
