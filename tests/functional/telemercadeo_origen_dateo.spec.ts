import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import TurnoRtm from '#models/turno_rtm'
import { columnaOrigenDateo } from '#services/telemercadeo_origen_service'

// Origen del dateo de Telemercadeo y bloqueo de agente/canal del asesor.
// Necesita la migración 1820 (y 1819 para los tickets): si no están, se omite
// y se corre contra una copia de la BD. Placas TLO1**, usuarios "TEST TLO".

const SEDE_ID = 3
const ZONA = 'America/Bogota'
const MOTIVO = 'migración 1819/1820 sin aplicar en esta BD'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

async function aplicadas() {
  const r = await Database.rawQuery(
    `SELECT COUNT(*) AS n FROM information_schema.columns
      WHERE table_schema = DATABASE() AND table_name = 'tickets_detalle_excepcion_dateo'
        AND column_name = 'telemercadeo_gestion_id'`
  )
  return Number(r[0][0].n) > 0 && (await columnaOrigenDateo())
}

async function limpiar() {
  const turnos = await Database.from('turnos_rtms').where('placa', 'like', 'TLO1%').select('id')
  const turnoIds = turnos.map((t: any) => t.id)
  if (turnoIds.length) {
    const det = await Database.from('tickets_detalle_excepcion_dateo')
      .whereIn('turno_id', turnoIds)
      .select('ticket_id')
    const ticketIds = det.map((d: any) => d.ticket_id)
    await Database.from('tickets_detalle_excepcion_dateo').whereIn('turno_id', turnoIds).delete()
    if (ticketIds.length) await Database.from('tickets').whereIn('id', ticketIds).delete()
  }
  const gestiones = await Database.from('telemercadeo_gestiones').where('placa', 'like', 'TLO1%')
  for (const g of gestiones) {
    await fs.unlink(app.makePath('uploads', ...String(g.evidencia_ruta).split('/'))).catch(() => {})
  }
  await Database.from('telemercadeo_gestiones').where('placa', 'like', 'TLO1%').delete()
  await Database.from('telemercadeo_ciclos').where('placa', 'like', 'TLO1%').delete()
  await Database.from('turnos_rtms').where('placa', 'like', 'TLO1%').delete()
  await Database.from('captacion_dateos').where('placa', 'like', 'TLO1%').delete()
  await Database.from('prospectos').where('placa', 'like', 'TLO1%').delete()
  await Database.from('telemercadeo_origenes').where('codigo', 'TEST_TLO_INACTIVO').delete()
}

test.group('Telemercadeo · origen del dateo', (group) => {
  group.each.timeout(60_000)

  let listas = false
  const usuarios: Usuario[] = []
  const agentes: AgenteCaptacion[] = []
  const tokens: Record<string, string> = {}
  const subidas: string[] = []
  const origen: Record<string, number> = {}
  let teleA: AgenteCaptacion
  let teleB: AgenteCaptacion
  let comercial: AgenteCaptacion
  let teleBogota: AgenteCaptacion
  let imagenPath = ''
  let servicioRtm = 0
  let seq = 0
  let telSeq = 0

  const bearer = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` })
  const tel = () => `39917${String(++telSeq).padStart(5, '0')}`
  const hoy = () => DateTime.now().setZone(ZONA)

  async function usuario(k: string, rolId: number, sedeId = SEDE_ID) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TLO-${k}`,
      correo: `test.tlo.${k.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId,
    } as any)
    usuarios.push(u)
    const t = await Usuario.accessTokens.create(u)
    tokens[k] = t.value!.release()
    return u
  }

  async function agente(tipo: string, nombre: string, usuarioId: number, sedeId = SEDE_ID) {
    const a = await AgenteCaptacion.create({
      sedeId,
      tipo,
      nombre: `TEST TLO ${nombre} ${Date.now()}`,
      usuarioId,
      activo: true,
    } as any)
    agentes.push(a)
    return a
  }

  async function gestion(client: any, placa: string, origenId: number, k = 'A') {
    const up = await client
      .post('/api/media/upload')
      .headers(bearer(k))
      .field('carpeta', 'telemercadeo')
      .file('file', imagenPath)
    up.assertStatus(201)
    subidas.push(up.body().ruta)
    const r = await client
      .post('/api/telemercadeo/gestiones')
      .headers(bearer(k))
      .json({
        placa,
        medio: 'LLAMADA',
        origen_id: origenId,
        resultado: 'INTERESADO',
        idempotency_key: `tlo-${Date.now()}-${++seq}`,
        evidencia_ruta: up.body().ruta,
      })
    r.assertStatus(201)
    return r.body().gestion.id as number
  }

  const datear = (client: any, k: string, body: Record<string, unknown>) =>
    client
      .post('/api/captacion-dateos')
      .headers(bearer(k))
      .json({ origen: 'UI', telefono: tel(), ...body })

  const dateoBd = (id: number) => Database.from('captacion_dateos').where('id', id).firstOrFail()

  async function resumen(client: any, agenteId: number) {
    const dia = hoy().toISODate()!
    const r = await client
      .get('/api/telemercadeo/resumen')
      .headers(bearer('ADMIN'))
      .qs({ desde: dia, hasta: dia, agente_id: agenteId })
    r.assertStatus(200)
    return r.body()
  }
  const fila = (body: any, id: number) => body.por_origen.find((o: any) => o.origen_id === id)

  async function turnoHoy(placa: string) {
    seq++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuarios[0].id,
      servicioId: servicioRtm,
      fecha: hoy(),
      horaIngreso: '06:00',
      turnoNumero: 987000 + seq,
      turnoNumeroServicio: 987000 + seq,
      turnoCodigo: `TST-TLO-${placa}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      tieneFacturacion: false,
      esSegundaVez: false,
    } as any)
  }

  async function crearTicket(client: any, k: string, turnoId: number, extra: any) {
    const subir = async () => {
      const r = await client.post('/api/media/upload').headers(bearer(k)).file('file', imagenPath)
      r.assertStatus(201)
      subidas.push(String(r.body().url).replace('/api/uploads/', ''))
      return r.body().url as string
    }
    return client
      .post('/api/tickets-excepcion-dateo')
      .headers(bearer(k))
      .json({
        turno_id: turnoId,
        observacion: 'Prueba origen',
        evidencia_chat_url: await subir(),
        evidencia_grupo_whatsapp_url: await subir(),
        evidencia_bloqueo_url: await subir(),
        ...extra,
      })
  }

  group.setup(async () => {
    listas = await aplicadas()
    if (!listas) return
    await limpiar()
    await usuario('ADMIN', 9)
    const uA = await usuario('A', 11)
    const uB = await usuario('B', 11)
    const uC = await usuario('COM', 11)
    const uBog = await usuario('BOG', 11, 2)
    teleA = await agente('ASESOR_TELEMERCADEO', 'A', uA.id)
    teleB = await agente('ASESOR_TELEMERCADEO', 'B', uB.id)
    comercial = await agente('ASESOR_COMERCIAL', 'COM', uC.id)
    teleBogota = await agente('ASESOR_TELEMERCADEO', 'BOG', uBog.id, 2)
    const [inactivo] = await Database.table('telemercadeo_origenes').insert({
      codigo: 'TEST_TLO_INACTIVO',
      nombre: 'TEST TLO inactivo',
      activo: false,
      orden: 99,
    })
    origen.INACTIVO = Number(inactivo)
    for (const o of await Database.from('telemercadeo_origenes').where('activo', true)) {
      origen[o.codigo] = o.id
    }
    const s = await Database.from('servicios').where('codigo_servicio', 'RTM').firstOrFail()
    servicioRtm = s.id
    imagenPath = app.tmpPath(`tst_tlo_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    if (!listas) return
    await limpiar()
    for (const r of subidas) {
      await fs.unlink(app.makePath('uploads', ...r.split('/'))).catch(() => {})
    }
    await fs.unlink(imagenPath).catch(() => {})
    for (const a of agentes) await a.delete()
    for (const u of usuarios) await u.delete()
  })

  const saltar = async () => !(await aplicadas())

  test('con gestión: sin origen hereda el de la gestión; uno distinto se guarda y la gestión conserva el suyo', async ({
    client,
    assert,
  }) => {
    const g1 = await gestion(client, 'TLO101', origen.RECURRENCIA)
    const d1 = await datear(client, 'A', { placa: 'TLO101', telemercadeo_gestion_id: g1 })
    d1.assertStatus(201)
    const f1 = await dateoBd(d1.body().id)
    assert.equal(f1.telemercadeo_origen_id, origen.RECURRENCIA)

    const g2 = await gestion(client, 'TLO102', origen.RECURRENCIA)
    const d2 = await datear(client, 'A', {
      placa: 'TLO102',
      telemercadeo_gestion_id: g2,
      telemercadeo_origen_id: origen.REDES,
    })
    d2.assertStatus(201)
    const f2 = await dateoBd(d2.body().id)
    assert.equal(f2.telemercadeo_origen_id, origen.REDES)
    const gb = await Database.from('telemercadeo_gestiones').where('id', g2).firstOrFail()
    assert.equal(gb.origen_id, origen.RECURRENCIA)

    // Contactos por el origen de la gestión; dateos por el del dateo; sin duplicar.
    const r = await resumen(client, teleA.id)
    assert.deepInclude(fila(r, origen.RECURRENCIA), { gestiones: 2, dateos: 1 })
    assert.deepInclude(fila(r, origen.REDES), { gestiones: 0, dateos: 1 })
    assert.deepInclude(r.totales, { gestiones: 2, dateos: 2 })
    const suma = (k: string) => r.por_origen.reduce((s: number, o: any) => s + o[k], 0)
    assert.equal(suma('dateos'), 2)
    assert.equal(suma('gestiones'), 2)
  }).skip(saltar, MOTIVO)

  test('origen inexistente, inactivo o no numérico → 400 ORIGEN_INVALIDO y no crea dateo', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLO103', origen.GOOGLE_ADS)
    for (const malo of [999999, origen.INACTIVO, 'abc', -1, 0]) {
      for (const extra of [{ telemercadeo_gestion_id: g }, {}]) {
        const r = await datear(client, 'A', {
          placa: 'TLO103',
          telemercadeo_origen_id: malo,
          ...extra,
        })
        r.assertStatus(400)
        assert.equal(r.body().code, 'ORIGEN_INVALIDO')
      }
    }
    assert.lengthOf(await Database.from('captacion_dateos').where('placa', 'TLO103'), 0)
  }).skip(saltar, MOTIVO)

  test('el origen de la gestión que luego se inactiva se puede conservar', async ({ client }) => {
    const g = await gestion(client, 'TLO104', origen.GOOGLE_ADS)
    await Database.from('telemercadeo_gestiones')
      .where('id', g)
      .update({ origen_id: origen.INACTIVO })
    const r = await datear(client, 'A', {
      placa: 'TLO104',
      telemercadeo_gestion_id: g,
      telemercadeo_origen_id: origen.INACTIVO,
    })
    r.assertStatus(201)
  }).skip(saltar, MOTIVO)

  test('sin gestión: origen obligatorio, canal TELE y suma a Control y Mi gestión', async ({
    client,
    assert,
  }) => {
    const sin = await datear(client, 'B', { placa: 'TLO105' })
    sin.assertStatus(400)
    assert.equal(sin.body().code, 'ORIGEN_REQUERIDO')

    const r = await datear(client, 'B', {
      placa: 'TLO105',
      telemercadeo_origen_id: origen.REDES,
    })
    r.assertStatus(201)
    const f = await dateoBd(r.body().id)
    assert.equal(f.canal, 'TELE')
    assert.equal(f.agente_id, teleB.id)
    assert.equal(f.telemercadeo_origen_id, origen.REDES)
    await Database.from('captacion_dateos').where('id', f.id).update({ resultado: 'EXITOSO' })

    const control = await resumen(client, teleB.id)
    assert.deepInclude(fila(control, origen.REDES), { gestiones: 0, dateos: 1, exitosos: 1 })
    assert.deepInclude(control.totales, { gestiones: 0, dateos: 1, exitosos: 1 })
    assert.deepInclude(control.por_asesor[0], { agente_id: teleB.id, dateos: 1, exitosos: 1 })

    const mio = await client
      .get('/api/telemercadeo/mi-resumen')
      .headers(bearer('B'))
      .qs({ mes: hoy().month, anio: hoy().year })
    mio.assertStatus(200)
    assert.deepInclude(mio.body(), { dateos: 1, exitosos: 1 })
    assert.equal(mio.body().metas.exitosos.avance, 1)
    assert.deepInclude(fila(mio.body(), origen.REDES), { dateos: 1, exitosos: 1 })
  }).skip(saltar, MOTIVO)

  test('bloqueo: otro agente, canal o tipo en el body se ignora; convenio y descuento → 400', async ({
    client,
    assert,
  }) => {
    const casos: Array<[string, Record<string, unknown>]> = [
      ['TLO106', { agente_id: teleB.id }],
      ['TLO107', { agenteId: comercial.id, canal: 'ASESOR', tipo_asesor: 'ASESOR_COMERCIAL' }],
      ['TLO108', { canal: 'FACHADA' }],
      ['TLO109', { canal: 'ASESOR_CONVENIO', agente_id: comercial.id }],
      ['TLO110', { canal: 'REDES', agente_id: 999999 }],
    ]
    for (const [placa, extra] of casos) {
      const r = await datear(client, 'A', {
        placa,
        telemercadeo_origen_id: origen.REDES,
        ...extra,
      })
      r.assertStatus(201)
      const f = await dateoBd(r.body().id)
      assert.equal(f.canal, 'TELE', placa)
      assert.equal(f.agente_id, teleA.id, placa)
    }
    for (const extra of [{ convenio_id: 1 }, { convenioId: 1 }, { descuento_id: 1 }]) {
      const r = await datear(client, 'A', {
        placa: 'TLO111',
        telemercadeo_origen_id: origen.REDES,
        ...extra,
      })
      r.assertStatus(400)
      assert.equal(r.body().code, 'TELE_SIN_CONVENIO_DESCUENTO')
    }
    const avance = await datear(client, 'A', {
      placa: 'TLO111',
      telemercadeo_origen_id: origen.REDES,
      es_avance: true,
    })
    avance.assertStatus(400)
    // Tampoco puede editar un dateo ya creado.
    const d = await Database.from('captacion_dateos').where('placa', 'TLO106').firstOrFail()
    const put = await client
      .put(`/api/captacion-dateos/${d.id}`)
      .headers(bearer('A'))
      .json({ agente_id: teleB.id, canal: 'ASESOR' })
    put.assertStatus(403)
  }).skip(saltar, MOTIVO)

  test('SUPER_ADMIN y comercial siguen igual: eligen canal y agente, sin origen', async ({
    client,
    assert,
  }) => {
    const sa = await datear(client, 'ADMIN', {
      placa: 'TLO112',
      canal: 'TELE',
      agente_id: teleB.id,
      telemercadeo_origen_id: origen.REDES,
    })
    sa.assertStatus(201)
    const f = await dateoBd(sa.body().id)
    assert.equal(f.agente_id, teleB.id)
    assert.isNull(f.telemercadeo_origen_id)
    const saFachada = await datear(client, 'ADMIN', { placa: 'TLO113', canal: 'FACHADA' })
    saFachada.assertStatus(201)
    const ff = await dateoBd(saFachada.body().id)
    assert.equal(ff.canal, 'FACHADA')

    const com = await datear(client, 'COM', { placa: 'TLO114', canal: 'ASESOR' })
    com.assertStatus(201)
    const fc = await dateoBd(com.body().id)
    assert.equal(fc.canal, 'ASESOR_COMERCIAL')
    assert.equal(fc.agente_id, comercial.id)
    assert.isNull(fc.telemercadeo_origen_id)
  }).skip(saltar, MOTIVO)

  test('ticket: con y sin gestión conserva el origen elegido y no deja cambiar el canal', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLO115', origen.RECURRENCIA)
    const t = await turnoHoy('TLO115')
    const r409 = await datear(client, 'A', {
      placa: 'TLO115',
      telemercadeo_gestion_id: g,
      telemercadeo_origen_id: origen.REDES,
    })
    r409.assertStatus(409)
    assert.equal(r409.body().intento.telemercadeo_origen_id, origen.REDES)
    const c = await crearTicket(client, 'A', t.id, {
      telemercadeo_gestion_id: g,
      telemercadeo_origen_id: origen.REDES,
      sin_convenio: true,
    })
    c.assertStatus(201)
    const a = await client
      .patch(`/api/tickets-excepcion-dateo/${c.body().ticket.id}/aprobar`)
      .headers(bearer('ADMIN'))
      .json({ con_comision: true })
    a.assertStatus(200)
    const f = await Database.from('captacion_dateos').where('placa', 'TLO115').firstOrFail()
    assert.equal(f.telemercadeo_origen_id, origen.REDES)

    const t2 = await turnoHoy('TLO116')
    const malo = await crearTicket(client, 'A', t2.id, {
      telemercadeo_origen_id: origen.INACTIVO,
      sin_convenio: true,
    })
    malo.assertStatus(400)
    assert.equal(malo.body().code, 'ORIGEN_INVALIDO')
    const c2 = await crearTicket(client, 'A', t2.id, {
      canal: 'ASESOR',
      comercial_id: teleB.id,
      telemercadeo_origen_id: origen.GOOGLE_ADS,
      sin_convenio: true,
    })
    c2.assertStatus(201)
    const det = await Database.from('tickets_detalle_excepcion_dateo')
      .where('turno_id', t2.id)
      .firstOrFail()
    assert.equal(det.canal, 'TELE')
    assert.equal(det.comercial_id, teleA.id)
    assert.equal(det.telemercadeo_origen_id, origen.GOOGLE_ADS)
  }).skip(saltar, MOTIVO)

  test('sede: gestión de otra sede → 404 y los conteos no se mezclan', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLO117', origen.RECURRENCIA)
    const ajena = await datear(client, 'BOG', {
      placa: 'TLO117',
      telemercadeo_gestion_id: g,
      telemercadeo_origen_id: origen.REDES,
    })
    ajena.assertStatus(404)

    const bog = await datear(client, 'BOG', {
      placa: 'TLO118',
      telemercadeo_origen_id: origen.REDES,
    })
    bog.assertStatus(201)
    const f = await dateoBd(bog.body().id)
    assert.equal(f.sede_id, 2)
    // Desde QA no se ve lo de Bogotá.
    const desdeQa = await resumen(client, teleBogota.id)
    assert.deepInclude(fila(desdeQa, origen.REDES), { dateos: 0 })
    const dia = hoy().toISODate()!
    const desdeBogota = await client
      .get('/api/telemercadeo/resumen')
      .headers({ ...bearer('ADMIN'), 'X-Sede-Id': '2' })
      .qs({ desde: dia, hasta: dia, agente_id: teleBogota.id })
    desdeBogota.assertStatus(200)
    assert.deepInclude(fila(desdeBogota.body(), origen.REDES), { dateos: 1 })
  }).skip(saltar, MOTIVO)
})
