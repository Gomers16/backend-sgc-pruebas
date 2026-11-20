import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import Comision from '#models/comision'

// Multi-sede 3d — comisiones, liquidaciones y comprobantes aislados por sede.
// Sede A = Ibagué (1), sede B = PRUEBAS QA (3). Comisiones RTM de prueba con
// fecha_calculo en enero de 2031 (fuera de cualquier dato real) y asesores
// "TEST MS3D *"; todo se borra al final (comisiones, liquidaciones con su
// detalle, comprobantes, asesores y usuarios test.ms3d.*).

const IBAGUE = 1
const QA = 3
const MARCA = 'test.ms3d.'
const DIA = '2031-01-15'
const RANGO = { fecha_inicio: '2031-01-01', fecha_fin: '2031-01-31' }
const NOTA = 'MS3D comprobante de prueba'

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS3D ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } }
}
type Actor = Awaited<ReturnType<typeof actor>>

async function limpiar() {
  const ags = await Database.from('agentes_captacions')
    .where('nombre', 'like', 'TEST MS3D %')
    .select('id')
  const agIds = ags.map((a: any) => a.id)
  if (agIds.length) {
    const cs = await Database.from('comisiones').whereIn('asesor_id', agIds).select('id')
    const cIds = cs.map((c: any) => c.id)
    if (cIds.length) {
      const liqs = await Database.from('liquidacion_detalle')
        .whereIn('comision_id', cIds)
        .distinct('liquidacion_id')
      const liqIds = liqs.map((l: any) => l.liquidacion_id)
      await Database.from('liquidacion_detalle').whereIn('comision_id', cIds).delete()
      if (liqIds.length) await Database.from('liquidaciones').whereIn('id', liqIds).delete()
      await Database.from('comisiones').whereIn('id', cIds).delete()
    }
    await Database.from('agentes_captacions').whereIn('id', agIds).delete()
  }
  await Database.from('comprobantes_pago').where('notas', NOTA).delete()
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  if (ids.length) {
    await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
    await Database.from('usuario_preferencia_modulo').whereIn('usuario_id', ids).delete()
    await Database.from('usuarios').whereIn('id', ids).delete()
  }
}

async function asesor(sedeId: number) {
  const [id] = await Database.table('agentes_captacions').insert({
    nombre: `TEST MS3D ASESOR ${sedeId} ${Date.now()}`,
    tipo: 'ASESOR_COMERCIAL',
    activo: true,
    sede_id: sedeId,
  })
  return id as number
}

function comision(sedeId: number, asesorId: number, estado = 'PENDIENTE', monto = 1000) {
  return Comision.create({
    sedeId,
    esConfig: false,
    asesorId,
    tipoServicio: 'RTM',
    tipoVehiculo: 'VEHICULO',
    base: '0',
    porcentaje: '0',
    monto: String(monto),
    montoAsesor: String(monto),
    montoConvenio: '0',
    estado,
    fechaCalculo: DateTime.fromISO(`${DIA}T10:00:00`),
  } as any)
}

const ids = (body: any) => ((body?.data ?? body) as any[]).map((r) => Number(r.id))

test.group('Multi-sede 3d · comisiones, liquidaciones y comprobantes', (group) => {
  group.each.timeout(90_000)
  let contA: Actor
  let contB: Actor
  let gerB: Actor
  let asesorA = 0
  let asesorB = 0

  group.setup(async () => {
    await limpiar()
    contA = await actor('CONTABILIDAD', IBAGUE)
    contB = await actor('CONTABILIDAD', QA)
    gerB = await actor('GERENCIA', QA)
    asesorA = await asesor(IBAGUE)
    asesorB = await asesor(QA)
  })
  group.teardown(limpiar)

  test('listar, ver, editar, aprobar, pagar y anular de otra sede → vacío o 404', async ({
    client,
    assert,
  }) => {
    const a = await comision(IBAGUE, asesorA)
    const b = await comision(QA, asesorB)

    const lista = await client
      .get('/api/comisiones')
      .qs({ desde: RANGO.fecha_inicio, hasta: RANGO.fecha_fin, perPage: 100 })
      .headers(contB.h)
    assert.equal(lista.status(), 200)
    assert.include(ids(lista.body()), b.id)
    assert.notInclude(ids(lista.body()), a.id)

    assert.equal((await client.get(`/api/comisiones/${a.id}`).headers(contB.h)).status(), 404)
    assert.equal((await client.get(`/api/comisiones/${b.id}`).headers(contA.h)).status(), 404)
    const editar = await client
      .patch(`/api/comisiones/${a.id}/editar`)
      .headers(contB.h)
      .json({ monto_asesor: 1 })
    assert.equal(editar.status(), 404)
    for (const accion of ['aprobar', 'pagar', 'anular']) {
      const r = await client.post(`/api/comisiones/${a.id}/${accion}`).headers(contB.h)
      assert.equal(r.status(), 404, accion)
    }
    const fila = await Database.from('comisiones').where('id', a.id).first()
    assert.equal(fila.estado, 'PENDIENTE')
    assert.equal(Number(fila.monto_asesor), 1000)

    // Con su sede sí aprueba.
    const ok = await client.post(`/api/comisiones/${b.id}/aprobar`).headers(contB.h)
    assert.equal(ok.status(), 200, JSON.stringify(ok.body()))
  })

  test('resumen y resumen por asesor solo suman la sede activa', async ({ client, assert }) => {
    await comision(IBAGUE, asesorA, 'PENDIENTE', 70000)
    await comision(QA, asesorB, 'PENDIENTE', 3000)
    const resumenB = await client
      .get('/api/comisiones/resumen')
      .qs({ desde: RANGO.fecha_inicio, hasta: RANGO.fecha_fin })
      .headers(contB.h)
    assert.equal(resumenB.status(), 200)
    const sqlQa = await Database.from('comisiones')
      .where('sede_id', QA)
      .where('es_config', false)
      .where('tipo_servicio', 'RTM')
      .whereRaw('DATE(fecha_calculo) = ?', [DIA])
      .count('* as n')
      .first()
    assert.equal(resumenB.body().por_estado.total.cantidad, Number(sqlQa.n))

    const porAsesor = await client
      .get('/api/comisiones/resumen-por-asesor')
      .qs({ tipo: 'ASESOR_COMERCIAL', ...RANGO })
      .headers(contB.h)
    assert.equal(porAsesor.status(), 200)
    const asesores = (porAsesor.body().asesores as any[]).map((r) => r.asesor_id)
    assert.include(asesores, asesorB)
    assert.notInclude(asesores, asesorA)
  })

  test('liquidar (pago masivo): nunca mezcla sedes; historial por sede', async ({
    client,
    assert,
  }) => {
    const a = await comision(IBAGUE, asesorA, 'APROBADA')
    const b = await comision(QA, asesorB, 'APROBADA')

    const mezcla = await client
      .post('/api/comisiones/pagar-masivo')
      .headers(contB.h)
      .json({ ids: [a.id, b.id], accion: 'PAGAR' })
    assert.equal(mezcla.status(), 409)
    assert.equal(mezcla.body().code, 'COMISIONES_DE_OTRA_SEDE')
    assert.deepEqual(mezcla.body().ids, [a.id])
    for (const id of [a.id, b.id]) {
      assert.equal((await Database.from('comisiones').where('id', id).first()).estado, 'APROBADA')
    }

    const pago = await client
      .post('/api/comisiones/pagar-masivo')
      .headers(contB.h)
      .json({ ids: [b.id], accion: 'PAGAR' })
    assert.equal(pago.status(), 200, JSON.stringify(pago.body()))
    const det = await Database.from('liquidacion_detalle').where('comision_id', b.id).first()
    const liq = await Database.from('liquidaciones').where('id', det.liquidacion_id).first()
    assert.equal(liq.sede_id, QA)

    const histA = await client
      .get('/api/reportes-admin/historial-liquidaciones')
      .qs({ per_page: 100 })
      .headers(contA.h)
    assert.notInclude(ids(histA.body()), liq.id)
    const detA = await client
      .get(`/api/reportes-admin/historial-liquidaciones/${liq.id}`)
      .headers(contA.h)
    assert.equal(detA.status(), 404)
    const detB = await client
      .get(`/api/reportes-admin/historial-liquidaciones/${liq.id}`)
      .headers(contB.h)
    assert.equal(detB.status(), 200)
  })

  test('comprobantes: solo comisiones de la sede; otra sede no los ve', async ({
    client,
    assert,
  }) => {
    const a = await comision(IBAGUE, asesorA, 'PAGADA')
    const b = await comision(QA, asesorB, 'PAGADA')
    const grupo = (comisionIds: number[]) => ({
      notas: NOTA,
      groups: [
        {
          beneficiario_tipo: 'ASESOR',
          beneficiario_nombre: 'MS3D',
          total_general: 1000,
          comision_ids: comisionIds,
          placas: [],
        },
      ],
    })
    const mezcla = await client
      .post('/api/comprobantes-pago')
      .headers(contB.h)
      .json(grupo([a.id, b.id]))
    assert.equal(mezcla.status(), 409)
    assert.isNull(await Database.from('comprobantes_pago').where('notas', NOTA).first())

    const ok = await client
      .post('/api/comprobantes-pago')
      .headers(contB.h)
      .json(grupo([b.id]))
    assert.equal(ok.status(), 201, JSON.stringify(ok.body()))
    const id = ok.body().data[0].id
    assert.equal((await Database.from('comprobantes_pago').where('id', id).first()).sede_id, QA)

    const listaA = await client.get('/api/comprobantes-pago').qs({ perPage: 100 }).headers(contA.h)
    assert.notInclude(ids(listaA.body()), id)
    assert.equal((await client.get(`/api/comprobantes-pago/${id}`).headers(contA.h)).status(), 404)
    const evid = await client
      .patch(`/api/comprobantes-pago/${id}/evidencia`)
      .headers(contA.h)
      .json({ evidencia_url: 'https://test.local/x.png' })
    assert.equal(evid.status(), 404)
  })

  test('exportar: liquidación RTM (JSON y Excel) y detalle de placas por sede', async ({
    client,
    assert,
  }) => {
    const a = await comision(IBAGUE, asesorA)
    await comision(QA, asesorB)
    const sqlCuenta = async (sede: number) =>
      Number(
        (
          await Database.from('comisiones')
            .where('sede_id', sede)
            .where('es_config', false)
            .where('tipo_servicio', 'RTM')
            .whereRaw('DATE(fecha_calculo) BETWEEN ? AND ?', [RANGO.fecha_inicio, RANGO.fecha_fin])
            .count('* as n')
            .first()
        ).n
      )
    const liqA = await client.get('/api/reportes-admin/liquidacion-rtm').qs(RANGO).headers(contA.h)
    const liqB = await client.get('/api/reportes-admin/liquidacion-rtm').qs(RANGO).headers(contB.h)
    assert.equal(liqA.status(), 200)
    assert.equal(liqA.body().resumen.total_comisiones, await sqlCuenta(IBAGUE))
    assert.equal(liqB.body().resumen.total_comisiones, await sqlCuenta(QA))

    const excel = await client
      .get('/api/reportes-admin/liquidacion-rtm/excel')
      .qs(RANGO)
      .headers(contB.h)
    assert.equal(excel.status(), 200)

    const rep = await client.get('/api/reportes-admin/comisiones').qs(RANGO).headers(contB.h)
    assert.equal(rep.status(), 200)
    assert.notInclude(JSON.stringify(rep.body()), `"asesor_id":${asesorA}`)

    // Ids de otra sede pedidos a mano: no devuelve nada de ellos.
    const placas = await client
      .get('/api/reportes-admin/liquidacion-rtm/detalle-placas')
      .qs({ comision_ids: String(a.id) })
      .headers(contB.h)
    assert.equal(placas.status(), 200)
    assert.lengthOf(placas.body().placas, 0)
  })

  test('"todas" es solo lectura: toda escritura → 400', async ({ client, assert }) => {
    const b = await comision(QA, asesorB)
    const todas = { ...gerB.h, 'X-Sede-Id': 'todas' }
    assert.equal(
      (await client.get('/api/comisiones').qs({ perPage: 5 }).headers(todas)).status(),
      200
    )
    const escrituras = [
      client.patch(`/api/comisiones/${b.id}/editar`).headers(todas).json({ monto_asesor: 1 }),
      client.post(`/api/comisiones/${b.id}/aprobar`).headers(todas),
      client.post(`/api/comisiones/${b.id}/pagar`).headers(todas),
      client.post(`/api/comisiones/${b.id}/anular`).headers(todas),
      client
        .post('/api/comisiones/pagar-masivo')
        .headers(todas)
        .json({ ids: [b.id], accion: 'APROBAR' }),
      client
        .post('/api/comprobantes-pago')
        .headers(todas)
        .json({ notas: NOTA, groups: [{ beneficiario_nombre: 'X', comision_ids: [b.id] }] }),
    ]
    for (const req of escrituras) {
      const r = await req
      assert.equal(r.status(), 400, JSON.stringify(r.body()))
    }
    const fila = await Database.from('comisiones').where('id', b.id).first()
    assert.equal(fila.estado, 'PENDIENTE')
  })
})
