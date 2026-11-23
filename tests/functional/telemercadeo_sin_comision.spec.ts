import { test } from '@japa/runner'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DateTime } from 'luxon'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import FacturacionTicket from '#models/facturacion_ticket'

// Decisión 2026-11-23: un dateo de Telemercadeo (canal TELE) no genera
// comisión. Flujo completo gestión → dateo → turno → certificación → factura
// confirmada; control con un dateo de asesor comercial (sí genera).
// Placas TLZ56x y teléfonos 39990005xx, solo de este archivo.

const SEDE_ID = 3
const ROL = { SUPER_ADMIN: 9, COMERCIAL: 11 }
const ZONA = 'America/Bogota'
const P = { TELE: 'TLZ561', COMERCIAL: 'TLZ562', MANUAL: 'TLZ563' }
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

test.group('Telemercadeo · el dateo TELE no genera comisión', (group) => {
  group.each.timeout(90_000)

  const tokens: Record<string, string> = {}
  const usuarios: Usuario[] = []
  const agentes: AgenteCaptacion[] = []
  const subidas: string[] = []
  let imagenPath = ''
  let tele: AgenteCaptacion
  let comercial: AgenteCaptacion
  let servicioRtm = 0
  let origenId = 0
  let total = 310000
  let seq = 0

  const bearer = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` })
  const hoy = () => DateTime.local().setZone(ZONA)

  async function usuario(k: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TLZ-${k}`,
      correo: `test.tlz.${k.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    usuarios.push(u)
    const tk = await Usuario.accessTokens.create(u)
    tokens[k] = tk.value!.release()
    return u
  }

  async function subir(client: any, k: string, carpeta?: string) {
    const req = client.post('/api/media/upload').headers(bearer(k))
    if (carpeta) req.field('carpeta', carpeta)
    const r = await req.file('file', imagenPath)
    r.assertStatus(201)
    const ruta = carpeta ? r.body().ruta : String(r.body().url).replace(/^\/api\/uploads\//, '')
    subidas.push(ruta)
    return r.body()
  }

  /** Turno RTM de hoy por la API (vincula el dateo), certificado APROBADA y facturado. */
  async function cerrarConFactura(client: any, placa: string, dateoId: number) {
    const t = await client
      .post('/api/turnos-rtm')
      .headers(bearer('ADMIN'))
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarios[0].id,
        fecha: hoy().toISODate(),
        horaIngreso: hoy().toFormat('HH:mm:ss'),
        servicioId: servicioRtm,
        dateoId,
      })
    t.assertStatus(201)
    const turnoId = t.body().id
    const cert = await client
      .post('/api/certificaciones')
      .header('Authorization', `Bearer ${tokens.ADMIN}`)
      .field('turno_id', String(turnoId))
      .field('resultado', 'APROBADA')
      .file('imagen', imagenPath)
    cert.assertStatus(201)
    total += 1000
    const ticket = await FacturacionTicket.create({
      hash: `test-hash-tlz-${placa}-${Date.now()}-${++seq}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa,
      total,
      totalFactura: total,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      turnoId,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      tipoVehiculoSnapshot: 'Liviano Particular',
    } as any)
    const conf = await client
      .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
      .headers(bearer('ADMIN'))
      .json({ forzar: true })
    conf.assertStatus(200)
    return turnoId as number
  }

  const comisionesDe = (dateoId: number) =>
    Database.from('comisiones').where('captacion_dateo_id', dateoId).where('es_config', 0)

  async function limpiar() {
    const placas = Object.values(P)
    const ph = placas.map(() => '?').join(',')
    const filasTurnos = await Database.from('turnos_rtms').whereIn('placa', placas).select('id')
    const turnos = filasTurnos.map((r: any) => r.id)
    const certs = turnos.length
      ? await Database.from('certificaciones').whereIn('turno_id', turnos).select('imagen_path')
      : []
    for (const c of certs) {
      await fs.unlink(app.makePath(String(c.imagen_path).replace(/\\/g, '/'))).catch(() => {})
    }
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${ph}))`,
      placas
    )
    await Database.rawQuery(`DELETE FROM facturacion_tickets WHERE placa IN (${ph})`, placas)
    await Database.from('telemercadeo_gestiones').whereIn('placa', placas).delete()
    await Database.from('telemercadeo_ciclos').whereIn('placa', placas).delete()
    await Database.rawQuery(
      `UPDATE turnos_rtms SET captacion_dateo_id = NULL WHERE placa IN (${ph})`,
      placas
    )
    await Database.from('captacion_dateos').whereIn('placa', placas).delete()
    await Database.from('turnos_rtms').whereIn('placa', placas).delete()
    await Database.from('clientes').where('telefono', 'like', '39990005%').delete()
  }

  group.setup(async () => {
    await limpiar()
    await usuario('ADMIN', ROL.SUPER_ADMIN)
    const uT = await usuario('TELE', ROL.COMERCIAL)
    const uC = await usuario('COMERCIAL', ROL.COMERCIAL)
    const s = Date.now()
    tele = await AgenteCaptacion.create({
      sedeId: SEDE_ID,
      tipo: 'ASESOR_TELEMERCADEO',
      nombre: `TEST TLZ TELE ${s}`,
      usuarioId: uT.id,
      activo: true,
    } as any)
    comercial = await AgenteCaptacion.create({
      sedeId: SEDE_ID,
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TLZ COMERCIAL ${s}`,
      usuarioId: uC.id,
      activo: true,
    } as any)
    agentes.push(tele, comercial)
    const rtm = await Database.from('servicios').where('codigo_servicio', 'RTM').first()
    servicioRtm = rtm.id
    const origen = await Database.from('telemercadeo_origenes')
      .where('codigo', 'GOOGLE_ADS')
      .first()
    origenId = origen.id
    imagenPath = app.tmpPath(`tst_tlz_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    await limpiar()
    for (const r of subidas)
      await fs.unlink(app.makePath('uploads', ...r.split('/'))).catch(() => {})
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    const ids = agentes.map((a) => a.id)
    await Database.from('meta_telemercadeo_asesor').whereIn('asesor_id', ids).delete()
    for (const a of agentes) await a.delete()
    for (const u of usuarios) {
      await Database.from('auth_access_tokens').where('tokenable_id', u.id).delete()
      await u.delete()
    }
  })

  test('gestión → dateo TELE → turno → certificación → factura: sin comisión, dateo EXITOSO', async ({
    client,
    assert,
  }) => {
    const ev = await subir(client, 'TELE', 'telemercadeo')
    const g = await client
      .post('/api/telemercadeo/gestiones')
      .headers(bearer('TELE'))
      .json({
        placa: P.TELE,
        telefono: '3999000561',
        servicio_id: servicioRtm,
        medio: 'LLAMADA',
        origen_id: origenId,
        resultado: 'INTERESADO',
        idempotency_key: `tlz-${Date.now()}`,
        evidencia_ruta: ev.ruta,
      })
    g.assertStatus(201)
    const img = await subir(client, 'TELE')
    const d = await client.post('/api/captacion-dateos').headers(bearer('TELE')).json({
      canal: 'TELE',
      origen: 'UI',
      placa: P.TELE,
      telefono: '3999000561',
      servicio_id: servicioRtm,
      telemercadeo_gestion_id: g.body().gestion.id,
      imagen_url: img.url,
    })
    d.assertStatus(201)
    const dateoId = d.body().id
    assert.equal(d.body().canal, 'TELE')

    await cerrarConFactura(client, P.TELE, dateoId)

    const dateo = await Database.from('captacion_dateos').where('id', dateoId).first()
    assert.equal(dateo.resultado, 'EXITOSO')
    assert.lengthOf(await comisionesDe(dateoId), 0)

    // Meta de "Mi gestión": cuenta el exitoso igual que antes.
    const mes = hoy()
    const r = await client
      .get(`/api/telemercadeo/mi-resumen?mes=${mes.month}&anio=${mes.year}`)
      .headers(bearer('TELE'))
    r.assertStatus(200)
    assert.equal(r.body().exitosos, 1)

    // Ficha: el dateo sale EXITOSO, sin monto de comisión.
    const f = await client
      .get(
        `/api/agentes-captacion/${tele.id}/dateos-comisiones?desde=${mes.toISODate()}&hasta=${mes.toISODate()}`
      )
      .headers(bearer('TELE'))
    f.assertStatus(200)
    const fila = f.body().data.find((x: any) => x.id === dateoId)
    assert.equal(fila.resultado, 'EXITOSO')
    assert.isTrue(!fila.monto_comision)
    assert.deepEqual(fila.comisiones ?? [], [])
  })

  test('control: el dateo de un asesor comercial sigue generando su comisión', async ({
    client,
    assert,
  }) => {
    const img = await subir(client, 'COMERCIAL')
    const d = await client.post('/api/captacion-dateos').headers(bearer('COMERCIAL')).json({
      origen: 'UI',
      placa: P.COMERCIAL,
      telefono: '3999000562',
      servicio_id: servicioRtm,
      imagen_url: img.url,
    })
    d.assertStatus(201)
    const dateoId = d.body().id
    const guardado = await Database.from('captacion_dateos').where('id', dateoId).first()
    assert.equal(guardado.canal, 'ASESOR_COMERCIAL')

    await cerrarConFactura(client, P.COMERCIAL, dateoId)

    const coms = await comisionesDe(dateoId)
    assert.lengthOf(coms, 1)
    assert.equal(coms[0].asesor_id, comercial.id)
    assert.equal(coms[0].estado, 'PENDIENTE')
    assert.equal(coms[0].tipo_servicio, 'RTM')
    assert.isAbove(Number(coms[0].monto_asesor), 0)

    // Liquidación RTM: la comisión del comercial está en su sección y la del
    // Telemercadeo no existe, así que el total cuadra con las secciones.
    const dia = hoy().toISODate()
    const l = await client
      .get(`/api/reportes-admin/liquidacion-rtm?fecha_inicio=${dia}&fecha_fin=${dia}`)
      .headers(bearer('ADMIN'))
    l.assertStatus(200)
    const fila = l.body().comerciales.find((x: any) => x.asesor_id === comercial.id)
    assert.exists(fila)
    assert.include(fila.comision_ids, coms[0].id)
  })

  test('alta manual de comisión sobre un turno con dateo TELE → 409 TELE_SIN_COMISION', async ({
    client,
    assert,
  }) => {
    const dateo = await Database.table('captacion_dateos').insert({
      sede_id: SEDE_ID,
      canal: 'TELE',
      agente_id: tele.id,
      placa: P.MANUAL,
      servicio_id: servicioRtm,
      origen: 'UI',
      resultado: 'PENDIENTE',
      created_at: hoy().toFormat('yyyy-LL-dd HH:mm:ss'),
      updated_at: hoy().toFormat('yyyy-LL-dd HH:mm:ss'),
    })
    const t = await client
      .post('/api/turnos-rtm')
      .headers(bearer('ADMIN'))
      .json({
        placa: P.MANUAL,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarios[0].id,
        fecha: hoy().toISODate(),
        horaIngreso: hoy().toFormat('HH:mm:ss'),
        servicioId: servicioRtm,
        dateoId: dateo[0],
      })
    t.assertStatus(201)
    const r = await client
      .post('/api/comisiones')
      .headers(bearer('ADMIN'))
      .json({ turno_id: t.body().id, asesor_id: comercial.id, monto_asesor: 10000 })
    r.assertStatus(409)
    assert.equal(r.body().code, 'TELE_SIN_COMISION')
    assert.lengthOf(await comisionesDe(dateo[0]), 0)
    const d = await Database.from('captacion_dateos').where('id', dateo[0]).first()
    assert.equal(d.canal, 'TELE')
  })
})
