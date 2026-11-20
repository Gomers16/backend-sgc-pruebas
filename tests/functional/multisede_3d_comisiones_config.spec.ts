import { test } from '@japa/runner'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import Comision from '#models/comision'
import { conSede, sinFiltroDeSede } from '#services/sede_scope'
import { resolveConfigComision } from '#services/comision_calculo_service'

// Multi-sede 3d — la CONFIGURACIÓN de comisiones (comisiones.es_config = 1)
// vive en la misma tabla que las comisiones reales. Con sede NULL es global:
// tiene que verse desde cualquier sede (si no, el motor no encontraría sus
// valores), y un override de una sede gana en esa sede con fallback a global.
// Valores conocidos con un asesor de prueba propio (sin tocar la config real).

const IBAGUE = 1
const QA = 3
const MARCA = 'test.ms3dcfg.'

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS3D CFG ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } }
}

function config(
  asesorId: number | null,
  tipo: 'MOTO' | 'VEHICULO' | null,
  monto: number,
  extra = {}
) {
  return Comision.create({
    esConfig: true,
    asesorId,
    tipoVehiculo: tipo,
    tipoServicio: 'OTRO',
    base: String(monto + 1),
    monto: String(monto),
    valorNuevoDirecto: String(monto + 2),
    porcentaje: '0',
    estado: 'PENDIENTE',
    ...extra,
  } as any)
}

test.group('Multi-sede 3d · configuración de comisiones global y por sede', (group) => {
  group.each.timeout(60_000)
  let asesorId = 0
  let gerA: Awaited<ReturnType<typeof actor>>
  let gerB: Awaited<ReturnType<typeof actor>>

  async function limpiar() {
    const ags = await Database.from('agentes_captacions')
      .where('nombre', 'like', 'TEST MS3DCFG%')
      .select('id')
    const ids = ags.map((a: any) => a.id)
    if (ids.length) {
      await Database.from('comisiones').whereIn('asesor_id', ids).delete()
      await Database.from('agentes_captacions').whereIn('id', ids).delete()
    }
    const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
    const uids = us.map((u: any) => u.id)
    if (uids.length) {
      await Database.from('auth_access_tokens').whereIn('tokenable_id', uids).delete()
      await Database.from('usuarios').whereIn('id', uids).delete()
    }
  }

  group.setup(async () => {
    await limpiar()
    ;[asesorId] = await Database.table('agentes_captacions').insert({
      nombre: `TEST MS3DCFG ASESOR ${Date.now()}`,
      tipo: 'ASESOR_COMERCIAL',
      activo: true,
      sede_id: QA,
    })
    gerA = await actor('GERENCIA', IBAGUE)
    gerB = await actor('GERENCIA', QA)
  })
  group.teardown(limpiar)

  test('config global (sede NULL) visible y usada por el motor desde cualquier sede', async ({
    assert,
    client,
  }) => {
    const global = await config(asesorId, 'VEHICULO', 11111)
    assert.isNull((await Database.from('comisiones').where('id', global.id).first()).sede_id)

    for (const sede of [IBAGUE, QA]) {
      const r = await conSede([sede], async () =>
        resolveConfigComision({ asesorId, asesorConvenioId: null, tipoVehiculo: 'VEHICULO' })
      )
      assert.equal(r.valorDateoNuevo, 11111, `sede ${sede}`)
      assert.equal(r.valorNuevoDirecto, 11113, `sede ${sede}`)
    }
    // El listado de configuración la muestra en las dos sedes.
    for (const g of [gerA, gerB]) {
      const res = await client.get('/api/comisiones/config').qs({ asesorId }).headers(g.h)
      assert.equal(res.status(), 200)
      assert.include(
        (res.body().data as any[]).map((c) => c.id),
        global.id
      )
    }
    // La config global REAL tampoco desaparece: mismo resultado sin filtro y por sede.
    const sinAsesor = { asesorId: null, asesorConvenioId: null, tipoVehiculo: 'MOTO' as const }
    const base = await sinFiltroDeSede(async () => resolveConfigComision(sinAsesor))
    for (const sede of [IBAGUE, QA]) {
      assert.deepEqual(await conSede([sede], async () => resolveConfigComision(sinAsesor)), base)
    }
  })

  test('override por sede: gana en su sede; las demás caen a la global', async ({ assert }) => {
    const ov = await config(asesorId, 'MOTO', 22222, { sedeId: QA })
    await config(asesorId, 'MOTO', 33333) // global
    assert.equal(ov.sedeId, QA)

    const motoEn = (sede: number) =>
      conSede([sede], async () =>
        resolveConfigComision({ asesorId, asesorConvenioId: null, tipoVehiculo: 'MOTO' })
      )
    assert.equal((await motoEn(QA)).valorDateoNuevo, 22222)
    assert.equal((await motoEn(IBAGUE)).valorDateoNuevo, 33333)
  })

  test('crear o editar config desde una sede la deja global; "todas" → 400', async ({
    assert,
    client,
  }) => {
    const nueva = await client
      .post('/api/comisiones/config')
      .headers(gerA.h)
      .json({ asesor_id: asesorId, tipo_vehiculo: null, valor_placa: 5, valor_dateo: 44444 })
    assert.equal(nueva.status(), 200, JSON.stringify(nueva.body()))
    const fila = await Database.from('comisiones').where('id', nueva.body().id).first()
    assert.isNull(fila.sede_id)
    assert.equal(Number(fila.monto), 44444)

    const todas = await client
      .post('/api/comisiones/config')
      .headers({ ...gerA.h, 'X-Sede-Id': 'todas' })
      .json({ asesor_id: asesorId, tipo_vehiculo: null, valor_placa: 5, valor_dateo: 55555 })
    assert.equal(todas.status(), 400)
    const sigue = await Database.from('comisiones').where('id', nueva.body().id).first()
    assert.equal(Number(sigue.monto), 44444)
  })
})
