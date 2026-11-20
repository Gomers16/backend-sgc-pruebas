import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import FacturacionTicket from '#models/facturacion_ticket'

// Multi-sede Fase 3b — facturación aislada por sede.
// Sede A = Ibagué (1), sede B = PRUEBAS QA (3). Turnos de HOY con placas
// MSA3B1 (Ibagué) y MSB3B1 (QA); tickets con hash "MS3B-*" o esas placas.
// Todo se borra al final (también los archivos subidos y los usuarios).

const IBAGUE = 1
const QA = 3
const RTM = 1
const PLACA_A = 'MSA3B1'
const PLACA_B = 'MSB3B1'
const MARCA = 'test.ms3b.'
const CONSEC = 'MS3B-0001'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
)

async function limpiar() {
  const placas = [PLACA_A, PLACA_B]
  const tickets = await Database.from('facturacion_tickets')
    .whereIn('placa', placas)
    .orWhere('hash', 'like', 'MS3B-%')
    .orWhereIn('turno_id', Database.from('turnos_rtms').whereIn('placa', placas).select('id'))
    .select('id', 'file_path')
  for (const t of tickets) {
    if (t.file_path && String(t.file_path).includes('uploads')) {
      await fs.unlink(app.makePath(t.file_path)).catch(() => {})
    }
  }
  if (tickets.length) {
    await Database.from('facturacion_tickets')
      .whereIn(
        'id',
        tickets.map((t: any) => t.id)
      )
      .delete()
  }
  await Database.rawQuery('DELETE FROM turnos_rtms WHERE placa IN (?, ?)', placas)
  await Database.rawQuery('DELETE FROM vehiculos WHERE placa IN (?, ?)', placas)
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
    apellidos: `MS3B ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } }
}

function ticket(sedeId: number, extra: Record<string, unknown> = {}) {
  return FacturacionTicket.create({
    sedeId,
    hash: `MS3B-${sedeId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    filePath: 'test/ms3b.png',
    estado: 'BORRADOR',
    ...extra,
  } as any)
}

test.group('Multi-sede 3b · facturación', (group) => {
  group.each.timeout(90_000)
  let otA: Awaited<ReturnType<typeof actor>>
  let otB: Awaited<ReturnType<typeof actor>>
  let ger: Awaited<ReturnType<typeof actor>>
  let turnoA = 0
  let turnoB = 0
  let imagen = ''
  let descuentoId = 0
  const hoy = DateTime.now().setZone('America/Bogota')

  group.setup(async () => {
    await limpiar()
    otA = await actor('OPERATIVO_TURNOS', IBAGUE)
    otB = await actor('OPERATIVO_TURNOS', QA)
    ger = await actor('GERENCIA', QA)
    imagen = app.tmpPath(`ms3b_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagen), { recursive: true })
    await fs.writeFile(imagen, PNG_1X1)
    const d = await Database.from('descuentos').where('activo', true).orderBy('id').first()
    descuentoId = d.id
  })
  group.teardown(async () => {
    await limpiar()
    await fs.unlink(imagen).catch(() => {})
  })

  test('alta: sede = sede activa (body ignorado) y turno de otra sede → 404', async ({
    client,
    assert,
  }) => {
    const crearTurno = async (a: typeof otA, placa: string) => {
      const r = await client
        .post('/api/turnos-rtm')
        .headers(a.h)
        .json({
          placa,
          tipoVehiculo: 'Liviano Particular',
          usuarioId: a.id,
          fecha: hoy.toISODate(),
          horaIngreso: hoy.toFormat('HH:mm:ss'),
          servicioId: RTM,
        })
      assert.equal(r.status(), 201, JSON.stringify(r.body()))
      return (r.body().id ?? r.body().turno?.id) as number
    }
    turnoA = await crearTurno(otA, PLACA_A)
    turnoB = await crearTurno(otB, PLACA_B)

    // QA intenta facturar el turno de Ibagué.
    const ajeno = await client
      .post('/api/facturacion/tickets')
      .headers(otB.h)
      .field('turno_id', String(turnoA))
      .field('servicio_id', String(RTM))
      .file('archivo', imagen)
    assert.equal(ajeno.status(), 404, JSON.stringify(ajeno.body()))

    // QA factura su turno mandando sede_id de Ibagué: se ignora.
    const propio = await client
      .post('/api/facturacion/tickets')
      .headers(otB.h)
      .field('turno_id', String(turnoB))
      .field('servicio_id', String(RTM))
      .field('sede_id', String(IBAGUE))
      .file('archivo', imagen)
    assert.equal(propio.status(), 201, JSON.stringify(propio.body()))
    const fila = await Database.from('facturacion_tickets').where('id', propio.body().id).first()
    assert.equal(fila.sede_id, QA)
    assert.equal(fila.turno_id, turnoB)

    // La misma imagen en Ibagué no choca con el hash de QA (dedupe por sede).
    const hashA = await client
      .get(`/api/facturacion/tickets/hash-exists/${fila.hash}`)
      .headers(otA.h)
    assert.isFalse(hashA.body().exists)
    const hashB = await client
      .get(`/api/facturacion/tickets/hash-exists/${fila.hash}`)
      .headers(otB.h)
    assert.isTrue(hashB.body().exists)
  })

  test('QA no lista, no ve, no edita ni confirma tickets de Ibagué (y al revés)', async ({
    client,
    assert,
  }) => {
    const a = await ticket(IBAGUE, { placa: PLACA_A })
    const b = await ticket(QA, { placa: PLACA_B })

    const listaB = await client
      .get('/api/facturacion/tickets')
      .qs({ placa_contiene: 'MS', limit: 100 })
      .headers(otB.h)
    assert.equal(listaB.status(), 200)
    const idsB = (listaB.body().data as any[]).map((r) => r.id)
    assert.include(idsB, b.id)
    assert.notInclude(idsB, a.id)
    // ?sede_id=1 desde QA no abre Ibagué.
    const forzada = await client
      .get('/api/facturacion/tickets')
      .qs({ sede_id: IBAGUE, limit: 100 })
      .headers(otB.h)
    assert.notInclude(
      (forzada.body().data as any[]).map((r) => r.id),
      a.id
    )

    assert.equal(
      (await client.get(`/api/facturacion/tickets/${a.id}`).headers(otB.h)).status(),
      404
    )
    assert.equal(
      (await client.get(`/api/facturacion/tickets/${b.id}`).headers(otA.h)).status(),
      404
    )
    const patch = await client
      .patch(`/api/facturacion/tickets/${a.id}`)
      .headers(otB.h)
      .json({ observaciones: 'no debe escribir' })
    assert.equal(patch.status(), 404)
    const conf = await client.post(`/api/facturacion/tickets/${a.id}/confirmar`).headers(otB.h)
    assert.equal(conf.status(), 404)
    const reocr = await client.post(`/api/facturacion/tickets/${a.id}/reocr`).headers(otB.h)
    assert.equal(reocr.status(), 404)
    const filaA = await Database.from('facturacion_tickets').where('id', a.id).first()
    assert.isNull(filaA.observaciones)
    assert.equal(filaA.estado, 'BORRADOR')

    // Editar: sede_id no se mueve; vincular el turno de otra sede → 404.
    const mover = await client
      .patch(`/api/facturacion/tickets/${b.id}`)
      .headers(otB.h)
      .json({ sede_id: IBAGUE, observaciones: 'ok' })
    assert.equal(mover.status(), 200, JSON.stringify(mover.body()))
    const vincAjeno = await client
      .patch(`/api/facturacion/tickets/${b.id}`)
      .headers(otB.h)
      .json({ turno_id: turnoA })
    assert.equal(vincAjeno.status(), 404)
    const filaB = await Database.from('facturacion_tickets').where('id', b.id).first()
    assert.equal(filaB.sede_id, QA)
    assert.isNull(filaB.turno_id)
    assert.equal(filaB.observaciones, 'ok')
  })

  test('consecutivo de descuento: único por (sede, consecutivo)', async ({ client, assert }) => {
    // Ibagué ya tiene CONSEC confirmado.
    await ticket(IBAGUE, {
      placa: PLACA_A,
      estado: 'CONFIRMADA',
      confirmadoAt: DateTime.now(),
      descuentoId,
      consecutivoDescuento: CONSEC,
    })
    const b1 = await ticket(QA, {
      placa: PLACA_B,
      estado: 'CONFIRMADA',
      confirmadoAt: DateTime.now(),
      descuentoId,
    })
    const b2 = await ticket(QA, {
      placa: PLACA_B,
      estado: 'CONFIRMADA',
      confirmadoAt: DateTime.now(),
      descuentoId,
    })

    const verificar = async (h: Record<string, string>) =>
      client
        .get('/api/facturacion/tickets/consecutivo-descuento/verificar')
        .qs({ valor: CONSEC })
        .headers(h)
    const v0 = await verificar(otB.h)
    assert.equal(v0.status(), 200)
    assert.isFalse(v0.body().exists, 'el de Ibagué no cuenta en QA')
    assert.isTrue((await verificar(otA.h)).body().bloqueante)
    // "todas" no verifica (no es una sede donde se factura).
    assert.equal((await verificar({ ...ger.h, 'X-Sede-Id': 'todas' })).status(), 400)

    const corregir = (id: number) =>
      client
        .patch(`/api/facturacion/tickets/${id}/consecutivo-descuento`)
        .headers(ger.h)
        .json({ consecutivo_descuento: CONSEC, motivo: 'prueba ms3b' })
    const r1 = await corregir(b1.id)
    assert.equal(r1.status(), 200, JSON.stringify(r1.body()))
    const r2 = await corregir(b2.id)
    assert.equal(r2.status(), 409, JSON.stringify(r2.body()))
    assert.include(JSON.stringify(r2.body()), `#${b1.id}`)

    const v1 = await verificar(otB.h)
    assert.isTrue(v1.body().bloqueante)
    assert.deepEqual(
      (v1.body().tickets as any[]).map((t) => t.id),
      [b1.id]
    )
  })

  test('historial de descuentos con filtro de placa no trae otra sede', async ({
    client,
    assert,
  }) => {
    const a = await ticket(IBAGUE, {
      placa: PLACA_A,
      placaTurno: PLACA_A,
      estado: 'CONFIRMADA',
      confirmadoAt: DateTime.now(),
      descuentoId,
      consecutivoDescuento: 'MS3B-HIST',
    })
    // El OR placa_turno/placa no puede saltarse el filtro de sede.
    const r = await client.get('/api/descuentos/historial').qs({ placa: PLACA_A }).headers(ger.h)
    assert.equal(r.status(), 200, JSON.stringify(r.body()))
    assert.notInclude(JSON.stringify(r.body()), `"ticket_id":${a.id}`)
    const rIb = await client
      .get('/api/descuentos/historial')
      .qs({ placa: PLACA_A })
      .headers({ ...ger.h, 'X-Sede-Id': String(IBAGUE) })
    assert.include(JSON.stringify(rIb.body()), `"ticket_id":${a.id}`)
  })
})
