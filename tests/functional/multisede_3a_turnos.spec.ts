import { test } from '@japa/runner'
import ExcelJS from 'exceljs'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Multi-sede Fase 3a — turnos, Turnero y llamados aislados por sede.
// Sede A = Ibagué (1), sede B = PRUEBAS QA (3). Crea turnos de HOY con placas
// MSA3A1 (Ibagué) y MSB3A1 (QA) y los borra al final (también vehículos,
// llamados, multimedia/ticker y usuarios test.ms3a.*).

const IBAGUE = 1
const QA = 3
const RTM = 1
const PLACA_A = 'MSA3A1'
const PLACA_B = 'MSB3A1'
const MARCA = 'test.ms3a.'
const URL_MEDIA = 'https://test.local/ms3a.png'
const TEXTO_TICKER = 'MS3A ticker de prueba'

async function limpiar() {
  const placas = [PLACA_A, PLACA_B]
  await Database.rawQuery(
    'DELETE FROM turno_llamados WHERE turno_id IN (SELECT id FROM turnos_rtms WHERE placa IN (?, ?))',
    placas
  )
  await Database.rawQuery('DELETE FROM turnos_rtms WHERE placa IN (?, ?)', placas)
  await Database.rawQuery('DELETE FROM vehiculos WHERE placa IN (?, ?)', placas)
  await Database.from('turnero_multimedia').where('url', URL_MEDIA).delete()
  await Database.from('turnero_mensajes_ticker').where('texto', TEXTO_TICKER).delete()
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
    apellidos: `MS3A ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } }
}

test.group('Multi-sede 3a · turnos, Turnero y llamados', (group) => {
  group.each.timeout(90_000)
  let otA: Awaited<ReturnType<typeof actor>>
  let otB: Awaited<ReturnType<typeof actor>>
  let tvA: Awaited<ReturnType<typeof actor>>
  let tvB: Awaited<ReturnType<typeof actor>>
  let ger: Awaited<ReturnType<typeof actor>>
  let turnoA = 0
  let turnoB = 0
  const hoy = DateTime.now().setZone('America/Bogota')

  group.setup(async () => {
    await limpiar()
    otA = await actor('OPERATIVO_TURNOS', IBAGUE)
    otB = await actor('OPERATIVO_TURNOS', QA)
    tvA = await actor('TURNERO', IBAGUE)
    tvB = await actor('TURNERO', QA)
    ger = await actor('GERENCIA', QA)
  })
  group.teardown(limpiar)

  test('numeración independiente por sede y sede del turno = sede activa', async ({
    client,
    assert,
  }) => {
    const sig = async (a: typeof otA) => {
      const r = await client
        .get('/api/turnos-rtm/siguiente-turno')
        .qs({ usuarioId: a.id, servicioId: RTM })
        .headers(a.h)
      assert.equal(r.status(), 200, JSON.stringify(r.body()))
      return r.body() as { siguiente: number; siguientePorServicio: number; sedeId: number }
    }
    const crear = (a: typeof otA, placa: string, extra: Record<string, unknown> = {}) =>
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

    const a0 = await sig(otA)
    const b0 = await sig(otB)
    assert.equal(a0.sedeId, IBAGUE)
    assert.equal(b0.sedeId, QA)

    // QA crea mandando sede_id/sedeId de Ibagué y el usuarioId de Ibagué: se ignoran.
    const rb = await crear(otB, PLACA_B, { sedeId: IBAGUE, sede_id: IBAGUE, usuarioId: otA.id })
    assert.equal(rb.status(), 201, JSON.stringify(rb.body()))
    turnoB = rb.body().id ?? rb.body().turno?.id
    const filaB = await Database.from('turnos_rtms').where('id', turnoB).first()
    assert.equal(filaB.sede_id, QA)
    assert.equal(filaB.turno_numero, b0.siguiente)

    // Crear en QA no mueve la numeración de Ibagué.
    const a1 = await sig(otA)
    assert.equal(a1.siguiente, a0.siguiente)
    assert.equal(a1.siguientePorServicio, a0.siguientePorServicio)

    const ra = await crear(otA, PLACA_A)
    assert.equal(ra.status(), 201, JSON.stringify(ra.body()))
    turnoA = ra.body().id ?? ra.body().turno?.id
    const filaA = await Database.from('turnos_rtms').where('id', turnoA).first()
    assert.equal(filaA.sede_id, IBAGUE)
    assert.equal(filaA.turno_numero, a0.siguiente)

    const b1 = await sig(otB)
    assert.equal(b1.siguiente, b0.siguiente + 1)
  })

  test('usuario de QA no ve, no edita ni llama turnos de Ibagué (y al revés)', async ({
    client,
    assert,
  }) => {
    const lista = await client.get('/api/turnos-rtm').qs({ fecha: hoy.toISODate() }).headers(otB.h)
    assert.equal(lista.status(), 200)
    const placas = JSON.stringify(lista.body())
    assert.include(placas, PLACA_B)
    assert.notInclude(placas, PLACA_A)

    assert.equal((await client.get(`/api/turnos-rtm/${turnoA}`).headers(otB.h)).status(), 404)
    const put = await client
      .put(`/api/turnos-rtm/${turnoA}`)
      .headers(otB.h)
      .json({ observaciones: 'MS3A no debe guardarse', usuarioId: otB.id })
    assert.equal(put.status(), 404)
    const fila = await Database.from('turnos_rtms').where('id', turnoA).first()
    assert.notEqual(fila.observaciones, 'MS3A no debe guardarse')

    const llamar = await client
      .post(`/api/turnos-rtm/${turnoA}/llamar`)
      .headers(otB.h)
      .json({ modulo: 'Módulo 5 - Caja RTM', usuarioId: otB.id })
    assert.equal(llamar.status(), 404)
    const llamados = await Database.from('turno_llamados').where('turno_id', turnoA).count('* as n')
    assert.equal(Number(llamados[0].n), 0)

    // Y al revés
    assert.equal((await client.get(`/api/turnos-rtm/${turnoB}`).headers(otA.h)).status(), 404)
    assert.equal((await client.get(`/api/turnos-rtm/${turnoA}`).headers(otA.h)).status(), 200)
  })

  test('búsqueda y exportación no muestran turnos de otra sede', async ({ client, assert }) => {
    const b = await client.get('/api/buscar').qs({ placa: PLACA_A }).headers(otB.h)
    assert.isBelow(b.status(), 500)
    assert.notInclude(JSON.stringify(b.body()), '"sedeNombre":"Ibagué"')

    // El cliente de Japa no entrega el binario: se descarga con fetch contra
    // el mismo servidor HTTP de los tests.
    const base = `http://127.0.0.1:${process.env.PORT}`
    const qs = `fechaInicio=${hoy.toISODate()}&fechaFin=${hoy.toISODate()}`
    const x = await fetch(`${base}/api/turnos-rtm/export-excel?${qs}`, { headers: otB.h })
    assert.equal(x.status, 200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await x.arrayBuffer()) as any)
    const celdas: string[] = []
    wb.eachSheet((ws) => ws.eachRow((row) => celdas.push(JSON.stringify(row.values))))
    const todo = celdas.join('\n')
    assert.include(todo, PLACA_B)
    assert.notInclude(todo, PLACA_A)
  })

  test('cola del Turnero y pendientes de llamar: cada sede solo lo suyo', async ({
    client,
    assert,
  }) => {
    const colaA = JSON.stringify((await client.get('/api/turnero/cola').headers(tvA.h)).body())
    const colaB = JSON.stringify((await client.get('/api/turnero/cola').headers(tvB.h)).body())
    assert.include(colaA, PLACA_A)
    assert.notInclude(colaA, PLACA_B)
    assert.include(colaB, PLACA_B)
    assert.notInclude(colaB, PLACA_A)

    // El TV ignora X-Sede-Id (no es SA/GER).
    const colaAcab = JSON.stringify(
      (await client.get('/api/turnero/cola').headers({ ...tvA.h, 'X-Sede-Id': String(QA) })).body()
    )
    assert.notInclude(colaAcab, PLACA_B)

    // Pendientes de llamar: requiere turnos finalizados.
    await Database.from('turnos_rtms')
      .whereIn('id', [turnoA, turnoB])
      .update({ estado: 'finalizado' })
    const pa = JSON.stringify(
      (await client.get('/api/turnos-rtm/pendientes-llamar').headers(otA.h)).body()
    )
    assert.include(pa, PLACA_A)
    assert.notInclude(pa, PLACA_B)

    // Llamar en su sede sí funciona y aparece solo en la cola de esa sede.
    const llamar = await client
      .post(`/api/turnos-rtm/${turnoB}/llamar`)
      .headers(otB.h)
      .json({ modulo: 'Módulo 6 - Caja RTM', usuarioId: otB.id })
    assert.oneOf(llamar.status(), [200, 201], JSON.stringify(llamar.body()))
    const colaA2 = JSON.stringify((await client.get('/api/turnero/cola').headers(tvA.h)).body())
    assert.notInclude(colaA2, PLACA_B)
    const colaB2 = (await client.get('/api/turnero/cola').headers(tvB.h)).body()
    assert.include(JSON.stringify(colaB2.ultimosLlamados), PLACA_B)
  })

  test('multimedia y ticker por sede; el payload no elige la sede', async ({ client, assert }) => {
    const m = await client.post('/api/turnero/multimedia').headers(ger.h).json({
      tipo: 'imagen',
      url: URL_MEDIA,
      duracionSegundos: 5,
      sede_id: IBAGUE,
      sedeId: IBAGUE,
    })
    assert.oneOf(m.status(), [200, 201], JSON.stringify(m.body()))
    const t = await client
      .post('/api/turnero/ticker')
      .headers(ger.h)
      .json({ texto: TEXTO_TICKER, sedeId: IBAGUE })
    assert.oneOf(t.status(), [200, 201], JSON.stringify(t.body()))
    assert.equal(
      (await Database.from('turnero_multimedia').where('url', URL_MEDIA).first()).sede_id,
      QA
    )
    assert.equal(
      (await Database.from('turnero_mensajes_ticker').where('texto', TEXTO_TICKER).first()).sede_id,
      QA
    )

    const mediaA = JSON.stringify(
      (await client.get('/api/turnero/multimedia').headers(tvA.h)).body()
    )
    const mediaB = JSON.stringify(
      (await client.get('/api/turnero/multimedia').headers(tvB.h)).body()
    )
    assert.notInclude(mediaA, URL_MEDIA)
    assert.include(mediaB, URL_MEDIA)
    const tickA = JSON.stringify((await client.get('/api/turnero/ticker').headers(tvA.h)).body())
    assert.notInclude(tickA, TEXTO_TICKER)

    // Editar/borrar el de otra sede → 404
    const idMedia = (await Database.from('turnero_multimedia').where('url', URL_MEDIA).first()).id
    const gerIbague = { ...ger.h, 'X-Sede-Id': String(IBAGUE) }
    const del = await client.delete(`/api/turnero/multimedia/${idMedia}`).headers(gerIbague)
    assert.equal(del.status(), 404)
  })

  test('GERENCIA con X-Sede-Id ve la sede elegida; "todas" solo lectura', async ({
    client,
    assert,
  }) => {
    // Sin cabecera: su sede (QA) → no ve el turno de Ibagué.
    assert.equal((await client.get(`/api/turnos-rtm/${turnoA}`).headers(ger.h)).status(), 404)
    const ib = { ...ger.h, 'X-Sede-Id': String(IBAGUE) }
    assert.equal((await client.get(`/api/turnos-rtm/${turnoA}`).headers(ib)).status(), 200)
    assert.equal((await client.get(`/api/turnos-rtm/${turnoB}`).headers(ib)).status(), 404)

    // "todas" = sedes activas (QA está inactiva): ve Ibagué, no QA.
    const todas = { ...ger.h, 'X-Sede-Id': 'todas' }
    const lista = JSON.stringify(
      (await client.get('/api/turnos-rtm').qs({ fecha: hoy.toISODate() }).headers(todas)).body()
    )
    assert.include(lista, PLACA_A)
    assert.notInclude(lista, PLACA_B)
    const sig = await client
      .get('/api/turnos-rtm/siguiente-turno')
      .qs({ usuarioId: ger.id, servicioId: RTM })
      .headers(todas)
    assert.equal(sig.status(), 400)
    const crear = await client.post('/api/turnos-rtm').headers(todas).json({
      placa: 'MSC3A1',
      tipoVehiculo: 'Liviano Particular',
      usuarioId: ger.id,
      servicioId: RTM,
    })
    assert.equal(crear.status(), 400)
  })
})
