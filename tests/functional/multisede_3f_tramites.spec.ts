import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import Tramite from '#models/tramite'
import TramiteLiquidacion from '#models/tramite_liquidacion'
import LiquidacionPago from '#models/liquidacion_pago'
import { conSede } from '#services/sede_scope'

// Multi-sede 3f — trámites, su liquidación, pagos, checklist y RUNT por sede.
// Sede A = Ibagué (1), sede B = PRUEBAS QA (3). Trámites con cédula
// "MS3F-*" y fecha 2031-03-*; todo se borra al final.

const IBAGUE = 1
const QA = 3
const RTM = 1
const MARCA = 'test.ms3f.'
const FECHA = '2031-03-05'

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS3F ${rol} ${sedeId}`,
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
  const ts = await Database.from('tramites').where('cedula', 'like', 'MS3F-%').select('id')
  const ids = ts.map((t: any) => t.id)
  if (ids.length) {
    const ls = await Database.from('tramite_liquidaciones').whereIn('tramite_id', ids).select('id')
    const lIds = ls.map((l: any) => l.id)
    if (lIds.length)
      await Database.from('liquidacion_pagos').whereIn('tramite_liquidacion_id', lIds).delete()
    await Database.from('tramite_liquidaciones').whereIn('tramite_id', ids).delete()
    await Database.from('formularios_runt').whereIn('tramite_id', ids).delete()
    await Database.from('tramites').whereIn('id', ids).delete()
  }
  await Database.from('tramite_checklists').where('fecha', FECHA).delete()
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const uIds = us.map((u: any) => u.id)
  if (uIds.length) {
    await Database.from('auth_access_tokens').whereIn('tokenable_id', uIds).delete()
    await Database.from('usuario_preferencia_modulo').whereIn('usuario_id', uIds).delete()
    await Database.from('usuarios').whereIn('id', uIds).delete()
  }
}

let seq = 0
async function tramite(sedeId: number, funcionarioId: number) {
  seq++
  const t = await Tramite.create({
    sedeId,
    funcionarioId,
    servicioId: RTM,
    fecha: DateTime.fromISO(FECHA),
    horaIngreso: '09:00:00',
    turnoNumero: 900 + seq,
    turnoCodigo: `MS3F-${sedeId}-${seq}-${Date.now()}`,
    cedula: `MS3F-${sedeId}-${seq}`,
    nombreCliente: 'MS3F',
  } as any)
  const liq = await TramiteLiquidacion.create({ tramiteId: t.id } as any)
  return { t, liq }
}

test.group('Multi-sede 3f · trámites y pagos', (group) => {
  group.each.timeout(90_000)
  let otA: Actor
  let otB: Actor
  let gerB: Actor

  group.setup(async () => {
    await limpiar()
    otA = await actor('OPERATIVO_TURNOS', IBAGUE)
    otB = await actor('OPERATIVO_TURNOS', QA)
    gerB = await actor('GERENCIA', QA)
  })
  group.teardown(limpiar)

  test('listar, ver y editar trámite de otra sede → vacío o 404', async ({ client, assert }) => {
    const a = (await tramite(IBAGUE, otA.id)).t
    const b = (await tramite(QA, otB.id)).t
    const lista = await client
      .get('/api/tramites')
      .qs({ fecha: FECHA, perPage: 100 })
      .headers(otB.h)
    assert.equal(lista.status(), 200)
    const ids = (lista.body().data as any[]).map((t) => t.id)
    assert.include(ids, b.id)
    assert.notInclude(ids, a.id)
    assert.equal((await client.get(`/api/tramites/${a.id}`).headers(otB.h)).status(), 404)
    const edit = await client
      .put(`/api/tramites/${a.id}`)
      .headers(otB.h)
      .json({ nombreCliente: 'NO' })
    assert.equal(edit.status(), 404)
    const pago = await client
      .post(`/api/tramites/${a.id}/pago`)
      .headers(otB.h)
      .json({ formaPagoCobro: 'EFECTIVO', fechaPago: FECHA })
    assert.equal(pago.status(), 404)
    assert.equal((await Database.from('tramites').where('id', a.id).first()).nombre_cliente, 'MS3F')
  })

  test('liquidación, pagos, RUNT y reporte de caja por sede', async ({ client, assert }) => {
    const { t: a, liq: liqA } = await tramite(IBAGUE, otA.id)
    await LiquidacionPago.create({
      tramiteLiquidacionId: liqA.id,
      fecha: DateTime.fromISO(FECHA),
      monto: 12345,
      formaPago: 'EFECTIVO',
    } as any)
    for (const ruta of [
      `/api/tramites/${a.id}/liquidacion`,
      `/api/tramites/${a.id}/formulario-runt`,
    ]) {
      assert.equal((await client.get(ruta).headers(otB.h)).status(), 404, ruta)
    }
    const upLiq = await client
      .put(`/api/tramites/${a.id}/liquidacion`)
      .headers(otB.h)
      .json({ valor_total: 1 })
    assert.equal(upLiq.status(), 404)
    const pagar = await client
      .post(`/api/tramites/liquidacion/${liqA.id}/pago`)
      .headers(otB.h)
      .json({ fecha: FECHA, monto: 1, formaPago: 'EFECTIVO' })
    assert.equal(pagar.status(), 404)
    assert.lengthOf(
      await Database.from('liquidacion_pagos').where('tramite_liquidacion_id', liqA.id),
      1
    )
    const caja = await client
      .get('/api/tramites/reporte-caja')
      .qs({ fechaInicio: FECHA, fechaFin: FECHA })
      .headers(otB.h)
    assert.equal(caja.status(), 200)
    assert.notInclude(JSON.stringify(caja.body()), '12345')
    const cajaA = await client
      .get('/api/tramites/reporte-caja')
      .qs({ fechaInicio: FECHA, fechaFin: FECHA })
      .headers(otA.h)
    assert.include(JSON.stringify(cajaA.body()), '12345')
  })

  test('pago de una liquidación hereda la sede en cadena (QA no la ve)', async ({ assert }) => {
    const { liq } = await tramite(IBAGUE, otA.id)
    await LiquidacionPago.create({
      tramiteLiquidacionId: liq.id,
      fecha: DateTime.fromISO(FECHA),
      monto: 1,
      formaPago: 'EFECTIVO',
    } as any)
    const enQa = await conSede([QA], async () =>
      LiquidacionPago.query().where('tramite_liquidacion_id', liq.id)
    )
    const enIb = await conSede([IBAGUE], async () =>
      LiquidacionPago.query().where('tramite_liquidacion_id', liq.id)
    )
    assert.lengthOf(enQa, 0)
    assert.lengthOf(enIb, 1)
    // Crear un pago sobre una liquidación de otra sede → 404.
    try {
      await conSede([QA], async () =>
        LiquidacionPago.create({
          tramiteLiquidacionId: liq.id,
          fecha: DateTime.fromISO(FECHA),
          monto: 2,
          formaPago: 'EFECTIVO',
        } as any)
      )
      assert.fail('debía rechazar')
    } catch (e: any) {
      assert.equal(e.status, 404)
    }
  })

  test('checklist en la sede activa; tarifas de trámites por sede', async ({ client, assert }) => {
    // QA manda sedeId de Ibagué: se guarda en QA.
    const up = await client
      .put('/api/tramites/checklist')
      .headers(otB.h)
      .json({ sedeId: IBAGUE, fecha: FECHA, turnoNumero: 77 })
    assert.equal(up.status(), 200, JSON.stringify(up.body()))
    const fila = await Database.from('tramite_checklists').where('fecha', FECHA).first()
    assert.equal(fila.sede_id, QA)
    const getA = await client
      .get('/api/tramites/checklist')
      .qs({ sedeId: QA, fecha: FECHA, turnoNumero: 77 })
      .headers(otA.h)
    assert.notInclude(JSON.stringify(getA.body()), `"id":${fila.id}`)

    // Tarifas (23 de Ibagué): QA no las ve.
    const ib = await conSede([IBAGUE], async () =>
      (await import('#models/tarifa_tramite')).default.query()
    )
    const qa = await conSede([QA], async () =>
      (await import('#models/tarifa_tramite')).default.query()
    )
    assert.isAbove(ib.length, 0)
    assert.lengthOf(qa, 0)
  })

  test('"todas" es solo lectura: escrituras de trámites → 400', async ({ client, assert }) => {
    const { t: b, liq } = await tramite(QA, otB.id)
    const todas = { ...gerB.h, 'X-Sede-Id': 'todas' }
    assert.equal(
      (await client.get('/api/tramites').qs({ fecha: FECHA }).headers(todas)).status(),
      200
    )
    const escrituras = [
      client.post('/api/tramites').headers(todas).json({ usuarioId: gerB.id }),
      client.put(`/api/tramites/${b.id}`).headers(todas).json({ nombreCliente: 'X' }),
      client
        .post(`/api/tramites/${b.id}/pago`)
        .headers(todas)
        .json({ formaPagoCobro: 'EFECTIVO', fechaPago: FECHA }),
      client.put(`/api/tramites/${b.id}/liquidacion`).headers(todas).json({}),
      client
        .post(`/api/tramites/liquidacion/${liq.id}/pago`)
        .headers(todas)
        .json({ fecha: FECHA, monto: 1, formaPago: 'EFECTIVO' }),
      client.put(`/api/tramites/${b.id}/formulario-runt`).headers(todas).json({}),
      client
        .put('/api/tramites/checklist')
        .headers(todas)
        .json({ sedeId: QA, fecha: FECHA, turnoNumero: 78 }),
    ]
    for (const req of escrituras) {
      const r = await req
      assert.equal(r.status(), 400, JSON.stringify(r.body()))
    }
    assert.equal((await Database.from('tramites').where('id', b.id).first()).nombre_cliente, 'MS3F')
  })
})
