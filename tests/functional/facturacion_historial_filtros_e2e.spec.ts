import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import ExcelJS from 'exceljs'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import FacturacionTicket from '#models/facturacion_ticket'

// Filtros del historial de facturación (GET /facturacion/tickets y /exportar):
// fecha de pago en hora de Bogotá, placa parcial, vendedor, descuento (o
// "ninguno"), consecutivo del descuento, estado, servicio y la línea resumen.
// Cada consulta lleva placa_contiene=QATH para no mezclarse con datos reales.
const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const SERVICIO_RTM_ID = 1
const SERVICIO_SOAT_ID = 4
const DESCUENTO_INFORMATIVO_ID = 1
const DESCUENTO_AVANCE_ID = 2
const ZONA = 'America/Bogota'
const PREFIJO = 'QATH'

test.group('Historial de facturación: filtros, resumen y exportar', (group) => {
  let usuario: Usuario
  let token: string
  const sufijo = String(Date.now()).slice(-6)
  const consec = (n: string) => `QH${sufijo}-${n}`

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'HISTORIAL-FACTURACION',
      correo: `test.historial.facturacion.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuario)
    token = tokenObj.value!.release()

    const bog = (iso: string) => DateTime.fromISO(iso, { zone: ZONA })
    const base = {
      filePath: 'test/fixture.jpg',
      sedeId: SEDE_ID,
      servicioId: SERVICIO_RTM_ID,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
    }
    const filas = [
      // 23:30 en Bogotá ya es el día siguiente en UTC: prueba la zona.
      {
        placa: 'QATH01',
        fechaPago: bog('2026-03-10T23:30:00'),
        total: 100000,
        vendedorText: 'MARIA LOPEZ',
        descuentoId: DESCUENTO_AVANCE_ID,
        descuentoMontoAplicado: 8000,
        consecutivoDescuento: consec('A1'),
        estado: 'CONFIRMADA',
      },
      {
        placa: 'QATH02',
        fechaPago: bog('2026-03-11T08:00:00'),
        total: 200000,
        vendedorText: 'MARIA LOPEZ',
        descuentoId: null,
        consecutivoDescuento: null,
        estado: 'CONFIRMADA',
      },
      {
        placa: 'QATH03',
        fechaPago: bog('2026-03-12T10:00:00'),
        total: 300000,
        vendedorText: 'PEDRO RUIZ',
        descuentoId: DESCUENTO_INFORMATIVO_ID,
        descuentoMontoAplicado: 5000,
        consecutivoDescuento: consec('B22'),
        estado: 'REVERTIDA',
      },
      {
        placa: 'QATH04',
        fechaPago: bog('2026-03-09T12:00:00'),
        total: 400000,
        vendedorText: 'pedro ruiz gomez',
        descuentoId: DESCUENTO_AVANCE_ID,
        descuentoMontoAplicado: 0,
        consecutivoDescuento: consec('A12'),
        estado: 'CONFIRMADA',
      },
      // Ticket viejo sin servicio_id pero con código SOAT.
      {
        placa: 'QATH05',
        fechaPago: bog('2026-03-11T09:00:00'),
        total: 50000,
        vendedorText: null,
        descuentoId: null,
        consecutivoDescuento: null,
        estado: 'CONFIRMADA',
        servicioId: null,
        servicioCodigo: 'SOAT',
        servicioNombre: 'SOAT',
      },
    ]
    for (const f of filas) {
      await FacturacionTicket.create({
        ...base,
        ...f,
        totalFactura: f.total,
        hash: `test-hash-historial-${f.placa}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      } as any)
    }
  })

  group.teardown(async () => {
    await Database.from('facturacion_tickets').where('placa', 'like', `${PREFIJO}%`).delete()
    if (usuario) await usuario.delete()
  })

  const listar = async (client: any, qs: Record<string, unknown>) => {
    const r = await client
      .get('/api/facturacion/tickets')
      .qs({ placa_contiene: PREFIJO, limit: 100, ...qs })
      .header('Authorization', `Bearer ${token}`)
    r.assertStatus(200)
    const body = r.body()
    return {
      placas: (body.data as any[]).map((t) => t.placa).sort(),
      resumen: body.resumen,
      total: body.meta.total,
    }
  }

  test('placa parcial (minúsculas y espacios) + rango de fecha de pago en hora de Bogotá', async ({
    client,
    assert,
  }) => {
    const r = await listar(client, {
      placa_contiene: 'qat h0',
      fecha_pago_desde: '2026-03-10',
      fecha_pago_hasta: '2026-03-11',
    })
    assert.deepEqual(r.placas, ['QATH01', 'QATH02', 'QATH05'])

    const soloDia10 = await listar(client, {
      fecha_pago_desde: '2026-03-10',
      fecha_pago_hasta: '2026-03-10',
    })
    assert.deepEqual(soloDia10.placas, ['QATH01'])
  })

  test('vendedor parcial sin importar mayúsculas + descuento', async ({ client, assert }) => {
    const r = await listar(client, { vendedor: 'Pedro', descuento_id: DESCUENTO_AVANCE_ID })
    assert.deepEqual(r.placas, ['QATH04'])

    const sinDescuento = await listar(client, { vendedor: 'maria', descuento_id: 'ninguno' })
    assert.deepEqual(sinDescuento.placas, ['QATH02'])
  })

  test('consecutivo del descuento: parcial por defecto, exacto con consecutivo_descuento_exacto', async ({
    client,
    assert,
  }) => {
    const parcial = await listar(client, { consecutivo_descuento: `qh${sufijo}-a1` })
    assert.deepEqual(parcial.placas, ['QATH01', 'QATH04'])

    const exacto = await listar(client, {
      consecutivo_descuento: consec('A1'),
      consecutivo_descuento_exacto: 1,
    })
    assert.deepEqual(exacto.placas, ['QATH01'])
  })

  test('estado y servicio (incluye tickets viejos sin servicio_id)', async ({ client, assert }) => {
    const revertidas = await listar(client, { estado: 'REVERTIDA' })
    assert.deepEqual(revertidas.placas, ['QATH03'])
    const soat = await listar(client, { servicio_id: SERVICIO_SOAT_ID })
    assert.deepEqual(soat.placas, ['QATH05'])
    const rtm = await listar(client, { servicio_id: SERVICIO_RTM_ID })
    assert.deepEqual(rtm.placas, ['QATH01', 'QATH02', 'QATH03', 'QATH04'])
  })

  test('todos juntos + resumen con los mismos filtros', async ({ client, assert }) => {
    const r = await listar(client, {
      placa_contiene: 'QATH0',
      fecha_pago_desde: '2026-03-09',
      fecha_pago_hasta: '2026-03-12',
      vendedor: 'lopez',
      descuento_id: DESCUENTO_AVANCE_ID,
      consecutivo_descuento: consec('A'),
      estado: 'CONFIRMADA',
      servicio_id: SERVICIO_RTM_ID,
    })
    assert.deepEqual(r.placas, ['QATH01'])
    assert.deepEqual(r.resumen, { cantidad: 1, total_facturado: 100000, total_descuento: 8000 })

    const todos = await listar(client, {})
    assert.equal(todos.total, 5)
    assert.deepEqual(todos.resumen, {
      cantidad: 5,
      total_facturado: 1050000,
      total_descuento: 13000,
    })
  })

  test('los parámetros de siempre siguen igual (placa exacta)', async ({ client, assert }) => {
    const r = await client
      .get('/api/facturacion/tickets')
      .qs({ placa: 'qath02' })
      .header('Authorization', `Bearer ${token}`)
    r.assertStatus(200)
    assert.deepEqual(
      (r.body().data as any[]).map((t) => t.placa),
      ['QATH02']
    )
    assert.containsSubset(r.body().data[0], { descuento_id: null, consecutivo_descuento: null })
  })

  test('exportar a Excel respeta los filtros', async ({ assert }) => {
    // El cliente de Japa no expone el cuerpo binario: fetch al mismo servidor.
    const qs = new URLSearchParams({
      placa_contiene: PREFIJO,
      descuento_id: String(DESCUENTO_AVANCE_ID),
    })
    const r = await fetch(
      `http://${process.env.HOST}:${process.env.PORT}/api/facturacion/tickets/exportar?${qs}`,
      { headers: { Authorization: `Bearer ${token}` } }
    )
    assert.equal(r.status, 200)
    assert.include(r.headers.get('content-type') ?? '', 'spreadsheetml')

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await r.arrayBuffer()) as any)
    const ws = wb.getWorksheet('Facturación')!
    const placas: string[] = []
    ws.eachRow((row, n) => {
      if (n > 1) placas.push(String(row.getCell(3).value))
    })
    assert.deepEqual(placas.sort(), ['QATH01', 'QATH04'])
    assert.equal(ws.getRow(1).getCell(4).value, 'Fecha pago')
  })

  test('sin token no exporta', async ({ client }) => {
    const r = await client.get('/api/facturacion/tickets/exportar')
    r.assertStatus(401)
  })
})
