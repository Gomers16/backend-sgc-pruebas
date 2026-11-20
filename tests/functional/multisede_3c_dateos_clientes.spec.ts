import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import { conSede } from '#services/sede_scope'
import { evaluarContinuidad } from '#services/continuidad_service'
import { evaluarVentanaSegundaVez } from '#services/segunda_vez_service'

// Multi-sede Fase 3c — dateos, búsqueda, clientes y vehículos por sede.
// Sede A = Ibagué (1), sede B = PRUEBAS QA (3). Placas MS3C* y clientes con
// teléfono 30099931xx; todo se borra al final (turnos, dateos, vehículos,
// clientes y usuarios test.ms3c.*).

const IBAGUE = 1
const QA = 3
const RTM = 1
const MARCA = 'test.ms3c.'
const P = {
  DATEO: 'MS3CD1',
  TURNO: 'MS3CT1',
  VISIBLE: 'MS3CV1',
  RECURRENTE: 'MS3CR1',
  CONTINUIDAD: 'MS3CC1',
  VENTANA: 'MS3CW1',
  SIN_HISTORIAL: 'MS3CS1',
}
const PLACAS = Object.values(P)
const TEL_VISIBLE = '3009993101'
const TEL_RECURRENTE = '3009993102'
const TEL_SIN_HISTORIAL = '3009993103'

async function limpiar() {
  const marks = PLACAS.map(() => '?').join(',')
  await Database.rawQuery(
    `UPDATE captacion_dateos SET consumido_turno_id = NULL WHERE placa IN (${marks})`,
    PLACAS
  )
  await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, PLACAS)
  await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, PLACAS)
  await Database.rawQuery(`DELETE FROM vehiculos WHERE placa IN (${marks})`, PLACAS)
  await Database.from('clientes')
    .whereIn('telefono', [TEL_VISIBLE, TEL_RECURRENTE, TEL_SIN_HISTORIAL])
    .delete()
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  if (ids.length) {
    await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
    await Database.from('usuario_preferencia_modulo').whereIn('usuario_id', ids).delete()
    await Database.from('usuarios').whereIn('id', ids).delete()
  }
}

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS3C ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } }
}

type Actor = Awaited<ReturnType<typeof actor>>

test.group('Multi-sede 3c · dateos, búsqueda, clientes y vehículos', (group) => {
  group.each.timeout(90_000)
  let comA: Actor
  let comB: Actor
  let otA: Actor
  let otB: Actor
  let claseId = 0
  const hoy = DateTime.now().setZone('America/Bogota')

  const crearTurno = (client: any, a: Actor, placa: string, extra: Record<string, unknown> = {}) =>
    client
      .post('/api/turnos-rtm')
      .headers(a.h)
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: a.id,
        fecha: hoy.toISODate(),
        horaIngreso: hoy.toFormat('HH:mm:ss'),
        servicioId: RTM,
        ...extra,
      })

  const crearDateo = (client: any, a: Actor, placa: string) =>
    client
      .post('/api/captacion-dateos')
      .headers(a.h)
      .json({ placa, canal: 'FACHADA', origen: 'UI', servicio_id: RTM, sede_id: IBAGUE })

  /** Turno histórico (finalizado) sembrado directo en la sede indicada. */
  const turnoHistorico = (sedeId: number, placa: string, extra: Record<string, unknown> = {}) =>
    TurnoRtm.create({
      sedeId,
      funcionarioId: otA.id,
      servicioId: RTM,
      fecha: DateTime.fromISO('2025-03-10'),
      horaIngreso: '08:00:00',
      placa,
      tipoVehiculo: 'Liviano Particular',
      turnoNumero: -931,
      turnoNumeroServicio: -931,
      turnoCodigo: `MS3C-HIST-${placa}-${Date.now()}`,
      estado: 'finalizado',
      ...extra,
    } as any)

  group.setup(async () => {
    await limpiar()
    comA = await actor('COMERCIAL', IBAGUE)
    comB = await actor('COMERCIAL', QA)
    otA = await actor('OPERATIVO_TURNOS', IBAGUE)
    otB = await actor('OPERATIVO_TURNOS', QA)
    claseId = (await Database.from('clases_vehiculos').orderBy('id').first()).id
  })
  group.teardown(limpiar)

  test('exclusividad del dateo por sede; sede = sede activa; no se ve en otra sede', async ({
    client,
    assert,
  }) => {
    const a = await crearDateo(client, comA, P.DATEO)
    assert.equal(a.status(), 201, JSON.stringify(a.body()))
    // QA puede datear la misma placa/servicio: la exclusividad es por sede.
    const b = await crearDateo(client, comB, P.DATEO)
    assert.equal(b.status(), 201, JSON.stringify(b.body()))
    const filaB = await Database.from('captacion_dateos').where('id', b.body().id).first()
    assert.equal(filaB.sede_id, QA, 'sede_id del body ignorado')
    // Dentro de QA sí bloquea.
    const b2 = await crearDateo(client, comB, P.DATEO)
    assert.equal(b2.status(), 409)
    assert.equal(b2.body().code, 'DATEO_ACTIVO')
    assert.equal(b2.body().dateoId, b.body().id)

    const listaB = await client.get('/api/captacion-dateos').qs({ placa: P.DATEO }).headers(comB.h)
    const idsB = (listaB.body().data as any[]).map((r) => r.id)
    assert.include(idsB, b.body().id)
    assert.notInclude(idsB, a.body().id)
    const verAjeno = await client.get(`/api/captacion-dateos/${a.body().id}`).headers(comB.h)
    assert.equal(verAjeno.status(), 404)
  })

  test('un turno de QA no vincula ni consume un dateo de Ibagué', async ({ client, assert }) => {
    const dA = await crearDateo(client, comA, P.TURNO)
    assert.equal(dA.status(), 201, JSON.stringify(dA.body()))
    const t = await crearTurno(client, otB, P.TURNO, { dateoId: dA.body().id })
    assert.equal(t.status(), 201, JSON.stringify(t.body()))
    const turnoId = t.body().id ?? t.body().turno?.id
    const fila = await Database.from('turnos_rtms').where('id', turnoId).first()
    assert.equal(fila.sede_id, QA)
    assert.isNull(fila.captacion_dateo_id)
    const dateo = await Database.from('captacion_dateos').where('id', dA.body().id).first()
    assert.equal(dateo.resultado, 'PENDIENTE')
    assert.isNull(dateo.consumido_turno_id)
  })

  test('recurrencia por sede: la visita de Ibagué no cuenta en QA', async ({ client, assert }) => {
    const [cli] = await Database.table('clientes').insert({
      nombre: 'MS3C RECURRENTE',
      telefono: TEL_RECURRENTE,
    })
    await Database.table('vehiculos').insert({
      placa: P.RECURRENTE,
      clase_vehiculo_id: claseId,
      cliente_id: cli,
    })
    const hist = await turnoHistorico(IBAGUE, P.RECURRENTE, { clienteId: cli })

    const tB = await crearTurno(client, otB, P.RECURRENTE)
    assert.equal(tB.status(), 201, JSON.stringify(tB.body()))
    const filaB = await Database.from('turnos_rtms')
      .where('id', tB.body().id ?? tB.body().turno?.id)
      .first()
    assert.isNull(filaB.ultimo_turno_id)
    assert.equal(Number(filaB.es_recurrente), 0)

    const tA = await crearTurno(client, otA, P.RECURRENTE)
    assert.equal(tA.status(), 201, JSON.stringify(tA.body()))
    const filaA = await Database.from('turnos_rtms')
      .where('id', tA.body().id ?? tA.body().turno?.id)
      .first()
    assert.equal(filaA.ultimo_turno_id, hist.id)
    assert.equal(Number(filaA.es_recurrente), 1)
  })

  test('continuidad y ventana de segunda vez por sede', async ({ assert }) => {
    // Visita finalizada SIN dateo en Ibagué → rompe la continuidad solo allí.
    await turnoHistorico(IBAGUE, P.CONTINUIDAD)
    const params = { placa: P.CONTINUIDAD, convenioId: 999999 }
    const enIbague = await conSede([IBAGUE], async () => await evaluarContinuidad(params))
    const enQa = await conSede([QA], async () => await evaluarContinuidad(params))
    assert.equal(enIbague, 'ROTA')
    assert.equal(enQa, 'CONTINUA')

    // Ventana de segunda vez abierta en Ibagué: en QA no existe.
    await turnoHistorico(IBAGUE, P.VENTANA, {
      fecha: hoy.startOf('day'),
      rechazadoAt: DateTime.now(),
      ventanaSegundaVezHasta: DateTime.now().plus({ days: 10 }),
    })
    const ahora = DateTime.now().setZone('America/Bogota')
    const vA = await conSede(
      [IBAGUE],
      async () => await evaluarVentanaSegundaVez(P.VENTANA, RTM, ahora)
    )
    const vB = await conSede(
      [QA],
      async () => await evaluarVentanaSegundaVez(P.VENTANA, RTM, ahora)
    )
    assert.isNotNull(vA)
    assert.isNull(vB)
  })

  test('cliente y vehículo: identidad global, visibles solo donde tienen turnos o dateos', async ({
    client,
    assert,
  }) => {
    const [cli] = await Database.table('clientes').insert({
      nombre: 'MS3C VISIBLE',
      telefono: TEL_VISIBLE,
      doc_tipo: 'CC',
      doc_numero: '993101',
    })
    const [veh] = await Database.table('vehiculos').insert({
      placa: P.VISIBLE,
      clase_vehiculo_id: claseId,
      cliente_id: cli,
    })
    const tA = await crearTurno(client, otA, P.VISIBLE)
    assert.equal(tA.status(), 201, JSON.stringify(tA.body()))

    // Búsqueda unificada.
    const bA = await client.get('/api/buscar').qs({ placa: P.VISIBLE }).headers(otA.h)
    assert.equal(bA.status(), 200)
    assert.equal(bA.body().vehiculo?.placa, P.VISIBLE)
    assert.isNotNull(bA.body().cliente)
    assert.isNotNull(bA.body().ultimaVisita)
    const bB = await client.get('/api/buscar').qs({ placa: P.VISIBLE }).headers(otB.h)
    assert.equal(bB.status(), 200)
    assert.isNull(bB.body().vehiculo)
    assert.isNull(bB.body().cliente)
    assert.isNull(bB.body().ultimaVisita)
    const bTel = await client.get('/api/buscar').qs({ telefono: TEL_VISIBLE }).headers(otB.h)
    assert.isNull(bTel.body().cliente)

    // Clientes.
    const listaB = await client.get('/api/clientes').qs({ q: TEL_VISIBLE }).headers(otB.h)
    assert.notInclude(
      (listaB.body().data as any[]).map((c) => c.id),
      cli
    )
    const listaA = await client.get('/api/clientes').qs({ q: TEL_VISIBLE }).headers(otA.h)
    assert.include(
      (listaA.body().data as any[]).map((c) => c.id),
      cli
    )
    for (const ruta of [`/api/clientes/${cli}`, `/api/clientes/${cli}/detalle`]) {
      assert.equal((await client.get(ruta).headers(otB.h)).status(), 404, ruta)
      assert.equal((await client.get(ruta).headers(otA.h)).status(), 200, ruta)
    }
    assert.equal((await client.get(`/api/clientes/${cli}/historial`).headers(otB.h)).status(), 404)
    const editarB = await client
      .put(`/api/clientes/${cli}`)
      .headers(otB.h)
      .json({ nombre: 'NO DEBE' })
    assert.equal(editarB.status(), 404)

    // Vehículos (además: /api/vehiculos ya no responde 500).
    const vA = await client.get('/api/vehiculos').qs({ q: P.VISIBLE }).headers(otA.h)
    assert.equal(vA.status(), 200, JSON.stringify(vA.body()))
    assert.include(
      (vA.body().data as any[]).map((v) => v.id),
      veh
    )
    const vB = await client.get('/api/vehiculos').qs({ q: P.VISIBLE }).headers(otB.h)
    assert.equal(vB.status(), 200)
    assert.notInclude(
      (vB.body().data as any[]).map((v) => v.id),
      veh
    )
    assert.equal((await client.get(`/api/vehiculos/${veh}`).headers(otB.h)).status(), 404)

    // Con un turno en QA también se ve allí; y ya no se borra desde una sola sede.
    const tB = await crearTurno(client, otB, P.VISIBLE)
    assert.equal(tB.status(), 201, JSON.stringify(tB.body()))
    assert.equal((await client.get(`/api/clientes/${cli}`).headers(otB.h)).status(), 200)
    const histB = await client.get(`/api/clientes/${cli}/historial`).headers(otB.h)
    assert.deepEqual(
      (histB.body().data as any[]).map((r) => r.id),
      [tB.body().id ?? tB.body().turno?.id],
      'el historial de QA no trae el turno de Ibagué'
    )
    const borrarCli = await client.delete(`/api/clientes/${cli}`).headers(otA.h)
    assert.equal(borrarCli.status(), 409)
    const borrarVeh = await client.delete(`/api/vehiculos/${veh}`).headers(otA.h)
    assert.equal(borrarVeh.status(), 409)
    assert.exists(await Database.from('vehiculos').where('id', veh).first())
  })

  test('sin historial en ninguna sede: visible desde todas (decisión 2026-11-20)', async ({
    client,
    assert,
  }) => {
    const [cli] = await Database.table('clientes').insert({
      nombre: 'MS3C SIN HISTORIAL',
      telefono: TEL_SIN_HISTORIAL,
    })
    const [veh] = await Database.table('vehiculos').insert({
      placa: P.SIN_HISTORIAL,
      clase_vehiculo_id: claseId,
      cliente_id: cli,
    })
    for (const a of [otA, otB]) {
      assert.equal((await client.get(`/api/clientes/${cli}`).headers(a.h)).status(), 200)
      assert.equal((await client.get(`/api/vehiculos/${veh}`).headers(a.h)).status(), 200)
      const b = await client.get('/api/buscar').qs({ placa: P.SIN_HISTORIAL }).headers(a.h)
      assert.equal(b.body().vehiculo?.placa, P.SIN_HISTORIAL)
    }
    // En cuanto tiene un turno en Ibagué, deja de verse en QA.
    const t = await crearTurno(client, otA, P.SIN_HISTORIAL)
    assert.equal(t.status(), 201, JSON.stringify(t.body()))
    assert.equal((await client.get(`/api/clientes/${cli}`).headers(otB.h)).status(), 404)
    assert.equal((await client.get(`/api/vehiculos/${veh}`).headers(otB.h)).status(), 404)
    assert.equal((await client.get(`/api/clientes/${cli}`).headers(otA.h)).status(), 200)
  })
})
