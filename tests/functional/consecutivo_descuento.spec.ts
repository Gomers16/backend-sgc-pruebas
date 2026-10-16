import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import FacturacionTicket from '#models/facturacion_ticket'

// Consecutivo del descuento (facturacion_tickets.consecutivo_descuento):
// obligatorio al confirmar con descuento en uso, único entre tickets
// CONFIRMADA (columna generada + uq_fact_consecutivo_descuento_confirmado),
// reutilizable cuando el ticket que lo tenía deja de estar CONFIRMADA, y
// corregible tras confirmar solo por SUPER_ADMIN/GERENCIA con registro.
//
// Los tickets de este spec no tienen turno ni dateo: applyCommissionHook()
// sale antes de crear comisiones (no toca comisiones ni captacion_dateos).
// Todo lo creado aquí se borra en el teardown (por placa y por usuario).

const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const ROL_OPERATIVO_TURNOS_ID = 14
const DESCUENTO_INFORMATIVO_ID = 1

const PLACAS = [
  'TCD901',
  'TCD902',
  'TCD903',
  'TCD904',
  'TCD905',
  'TCD906',
  'TCD907',
  'TCD908',
  'TCD909',
  'TCD910',
  'TCD911',
]

// Único por corrida para no chocar con datos reales ni con corridas previas.
const RUN = Date.now().toString(36).toUpperCase()
const cd = (sufijo: string) => `CDT-${RUN}-${sufijo}`

test.group('Consecutivo del descuento (facturación)', (group) => {
  let admin: Usuario
  let operativo: Usuario
  let tokenAdmin: string
  let tokenOperativo: string

  group.setup(async () => {
    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'CONSECUTIVO-DESC-ADMIN',
      correo: `test.consecutivo.desc.admin.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokAdmin = await Usuario.accessTokens.create(admin)
    tokenAdmin = tokAdmin.value!.release()

    operativo = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'CONSECUTIVO-DESC-OPERATIVO',
      correo: `test.consecutivo.desc.operativo.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_OPERATIVO_TURNOS_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokOperativo = await Usuario.accessTokens.create(operativo)
    tokenOperativo = tokOperativo.value!.release()
  })

  group.teardown(async () => {
    const placeholders = PLACAS.map(() => '?').join(', ')
    // facturacion_consecutivo_descuento_cambios cae por ON DELETE CASCADE.
    await Database.rawQuery(
      `DELETE FROM facturacion_tickets WHERE placa IN (${placeholders})`,
      PLACAS
    )
    if (admin) await admin.delete()
    if (operativo) await operativo.delete()
  })

  async function crearTicket(placa: string, extra: Record<string, unknown> = {}) {
    return FacturacionTicket.create({
      hash: `test-hash-cd-${placa}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa,
      total: 150000,
      totalFactura: 150000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      ...extra,
    } as any)
  }

  async function statusDe(req: Promise<any>): Promise<number> {
    const res = await req
    return res.status()
  }

  async function consecutivoDe(id: number): Promise<string | null> {
    const t = await FacturacionTicket.findOrFail(id)
    return t.consecutivoDescuento
  }

  async function estadoDe(id: number): Promise<string> {
    const t = await FacturacionTicket.findOrFail(id)
    return t.estado
  }

  function confirmar(client: any, id: number) {
    return client
      .post(`/api/facturacion/tickets/${id}/confirmar`)
      .header('Authorization', `Bearer ${tokenAdmin}`)
      .json({})
  }

  function patch(client: any, id: number, body: Record<string, unknown>, token = tokenAdmin) {
    return client
      .patch(`/api/facturacion/tickets/${id}`)
      .header('Authorization', `Bearer ${token}`)
      .json(body)
  }

  test('obligatorio con descuento: confirmar sin consecutivo responde 422 y no confirma', async ({
    assert,
    client,
  }) => {
    const t = await crearTicket(PLACAS[0], { descuentoId: DESCUENTO_INFORMATIVO_ID })
    const res = await confirmar(client, t.id)
    assert.equal(res.status(), 422)
    assert.equal(res.body().code, 'CONSECUTIVO_DESCUENTO_REQUERIDO')
    const recargado = await FacturacionTicket.findOrFail(t.id)
    assert.notEqual(recargado.estado, 'CONFIRMADA')
  }).timeout(20000)

  test('sin descuento: confirma sin consecutivo y el PATCH no deja consecutivo huérfano', async ({
    assert,
    client,
  }) => {
    const t = await crearTicket(PLACAS[1])
    // Sin descuento, un consecutivo enviado se descarta.
    const p = await patch(client, t.id, { consecutivo_descuento: cd('HUERFANO') })
    assert.equal(p.status(), 200)
    assert.isNull(await consecutivoDe(t.id))

    const res = await confirmar(client, t.id)
    assert.equal(res.status(), 200)
    const recargado = await FacturacionTicket.findOrFail(t.id)
    assert.equal(recargado.estado, 'CONFIRMADA')
    assert.isNull(recargado.consecutivoDescuento)
  }).timeout(20000)

  test('formato: se guarda en mayúsculas; espacios internos o símbolos responden 422', async ({
    assert,
    client,
  }) => {
    const t = await crearTicket(PLACAS[2], { descuentoId: DESCUENTO_INFORMATIVO_ID })
    const valor = cd('fmt-007')

    const ok = await patch(client, t.id, { consecutivo_descuento: `  ${valor.toLowerCase()}  ` })
    assert.equal(ok.status(), 200)
    // Sin normalizar ceros: '007' se conserva tal cual.
    assert.equal(await consecutivoDe(t.id), valor.toUpperCase())

    for (const malo of ['AB C1', 'AB_C1', 'ÑANDU1', 'X'.repeat(31)]) {
      const r = await patch(client, t.id, { consecutivo_descuento: malo })
      assert.equal(r.status(), 422, `debió rechazar "${malo}"`)
      assert.equal(r.body().code, 'CONSECUTIVO_DESCUENTO_INVALIDO')
    }
  }).timeout(20000)

  test('duplicado: 409 en PATCH y en confirmar indicando el ticket; el índice único lo respalda', async ({
    assert,
    client,
  }) => {
    const valor = cd('DUP')
    const a = await crearTicket(PLACAS[3], { descuentoId: DESCUENTO_INFORMATIVO_ID })
    assert.equal(await statusDe(patch(client, a.id, { consecutivo_descuento: valor })), 200)
    assert.equal(await statusDe(confirmar(client, a.id)), 200)

    const b = await crearTicket(PLACAS[4], { descuentoId: DESCUENTO_INFORMATIVO_ID })
    const p = await patch(client, b.id, { consecutivo_descuento: valor })
    assert.equal(p.status(), 409)
    assert.equal(p.body().code, 'CONSECUTIVO_DESCUENTO_DUPLICADO')
    assert.equal(p.body().id, a.id)
    assert.include(p.body().message, `#${a.id}`)

    // Si el valor llega al ticket por otra vía, confirmar() también lo frena.
    await Database.from('facturacion_tickets')
      .where('id', b.id)
      .update({ consecutivo_descuento: valor })
    const c = await confirmar(client, b.id)
    assert.equal(c.status(), 409)
    assert.equal(c.body().code, 'CONSECUTIVO_DESCUENTO_DUPLICADO')
    assert.equal(c.body().id, a.id)
    assert.notEqual(await estadoDe(b.id), 'CONFIRMADA')

    // Unicidad dura: dos CONFIRMADA con el mismo valor → 1062 sobre el índice.
    let err: any = null
    try {
      await Database.from('facturacion_tickets').where('id', b.id).update({ estado: 'CONFIRMADA' })
    } catch (e) {
      err = e
    }
    assert.isNotNull(err, 'el índice único debió rechazar el segundo CONFIRMADA')
    assert.equal(err.errno, 1062)
    assert.include(String(err.sqlMessage), 'uq_fact_consecutivo_descuento_confirmado')
  }).timeout(20000)

  test('verificación en vivo: avisa en cualquier estado y solo bloquea si está CONFIRMADA', async ({
    assert,
    client,
  }) => {
    const confirmado = cd('VIVO-C')
    const borrador = cd('VIVO-B')
    const a = await crearTicket(PLACAS[5], { descuentoId: DESCUENTO_INFORMATIVO_ID })
    await patch(client, a.id, { consecutivo_descuento: confirmado })
    assert.equal(await statusDe(confirmar(client, a.id)), 200)
    const b = await crearTicket(PLACAS[6], {
      descuentoId: DESCUENTO_INFORMATIVO_ID,
      consecutivoDescuento: borrador,
    })

    const get = (valor: string, excluirId?: number) =>
      client
        .get('/api/facturacion/tickets/consecutivo-descuento/verificar')
        .qs(excluirId ? { valor, excluir_id: excluirId } : { valor })
        .header('Authorization', `Bearer ${tokenOperativo}`)

    const r1 = await get(confirmado.toLowerCase())
    assert.equal(r1.status(), 200)
    assert.include(r1.body(), { valor: confirmado, valido: true, exists: true, bloqueante: true })
    assert.equal(r1.body().tickets[0].id, a.id)
    assert.equal(r1.body().tickets[0].estado, 'CONFIRMADA')

    const r2 = await get(borrador)
    assert.include(r2.body(), { exists: true, bloqueante: false })
    assert.equal(r2.body().tickets[0].estado, 'BORRADOR')

    const r3 = await get(borrador, b.id)
    assert.include(r3.body(), { exists: false, bloqueante: false })

    const r4 = await get('AB C')
    assert.include(r4.body(), { valido: false, exists: false })
  }).timeout(20000)

  test('reutilización: si el ticket que lo tenía deja de estar CONFIRMADA (REVERTIDA), otro puede usarlo', async ({
    assert,
    client,
  }) => {
    const valor = cd('REUSO')
    const a = await crearTicket(PLACAS[7], { descuentoId: DESCUENTO_INFORMATIVO_ID })
    await patch(client, a.id, { consecutivo_descuento: valor })
    assert.equal(await statusDe(confirmar(client, a.id)), 200)

    // No hay endpoint de revertir: el test revierte su propio ticket.
    await Database.from('facturacion_tickets')
      .where('id', a.id)
      .update({ estado: 'REVERTIDA', revertida_flag: true, revertida_at: DateTime.now().toSQL({ includeOffset: false }) })
    const gen = await Database.from('facturacion_tickets')
      .where('id', a.id)
      .select('consecutivo_descuento_confirmado')
      .first()
    assert.isNull(gen.consecutivo_descuento_confirmado)

    const b = await crearTicket(PLACAS[8], { descuentoId: DESCUENTO_INFORMATIVO_ID })
    assert.equal(await statusDe(patch(client, b.id, { consecutivo_descuento: valor })), 200)
    const res = await confirmar(client, b.id)
    assert.equal(res.status(), 200)
    assert.equal(await consecutivoDe(b.id), valor)
  }).timeout(20000)

  test('edición tras confirmar: PATCH genérico 403; solo SUPER_ADMIN/GERENCIA corrige y queda registro', async ({
    assert,
    client,
  }) => {
    const original = cd('EDIT-1')
    const corregido = cd('EDIT-2')
    const t = await crearTicket(PLACAS[9], { descuentoId: DESCUENTO_INFORMATIVO_ID })
    await patch(client, t.id, { consecutivo_descuento: original })
    assert.equal(await statusDe(confirmar(client, t.id)), 200)

    // PATCH genérico: mismo valor pasa (no-op); distinto valor → 403, incluso admin.
    assert.equal(await statusDe(patch(client, t.id, { consecutivo_descuento: original })), 200)
    const g = await patch(client, t.id, { consecutivo_descuento: corregido })
    assert.equal(g.status(), 403)
    assert.equal(g.body().code, 'CONSECUTIVO_DESCUENTO_CONFIRMADO')

    const corregir = (token: string, body: Record<string, unknown>) =>
      client
        .patch(`/api/facturacion/tickets/${t.id}/consecutivo-descuento`)
        .header('Authorization', `Bearer ${token}`)
        .json(body)

    // OPERATIVO_TURNOS no puede (middleware de la ruta).
    const op = await corregir(tokenOperativo, { consecutivo_descuento: corregido })
    assert.equal(op.status(), 403)
    assert.equal(await consecutivoDe(t.id), original)

    const ok = await corregir(tokenAdmin, {
      consecutivo_descuento: corregido,
      motivo: 'Error de digitación',
    })
    assert.equal(ok.status(), 200)
    assert.equal(await consecutivoDe(t.id), corregido)

    const cambio = await Database.from('facturacion_consecutivo_descuento_cambios')
      .where('facturacion_ticket_id', t.id)
      .first()
    assert.equal(cambio.valor_anterior, original)
    assert.equal(cambio.valor_nuevo, corregido)
    assert.equal(cambio.usuario_id, admin.id)
    assert.equal(cambio.motivo, 'Error de digitación')
    assert.isNotNull(cambio.created_at)

    // Corregir a un consecutivo que ya tiene otro ticket CONFIRMADA → 409.
    const ajeno = cd('EDIT-AJENO')
    const otro = await crearTicket(PLACAS[10], { descuentoId: DESCUENTO_INFORMATIVO_ID })
    await patch(client, otro.id, { consecutivo_descuento: ajeno })
    assert.equal(await statusDe(confirmar(client, otro.id)), 200)
    const dup = await corregir(tokenAdmin, { consecutivo_descuento: ajeno })
    assert.equal(dup.status(), 409)
    assert.equal(dup.body().code, 'CONSECUTIVO_DESCUENTO_DUPLICADO')
    assert.equal(dup.body().id, otro.id)
  }).timeout(20000)
})
