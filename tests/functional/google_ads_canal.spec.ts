import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import ExcelJS from 'exceljs'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'

// "Google ADS" como canal/medio propio (igual que Redes: sin asesor). Por
// HTTP: crear, crear tras buscar la placa (sugerencia distinta), editar sin
// perder el canal, los otros canales sin cambios, filtro, Excel y segunda
// vez. Escribe en la BD compartida: placas TST910–TST919, limpieza al final.
//
// turno_codigo tiene resolución de segundos: se espera >1 s entre creaciones.

const SEDE_ID = 2
const SERVICIO_RTM = 1
const ROL_SUPER_ADMIN = 9
const ZONA = 'America/Bogota'

const P = {
  CREAR: 'TST910',
  BUSCAR: 'TST911',
  EDITAR: 'TST912',
  FACHADA: 'TST913',
  REDES: 'TST914',
  TELE: 'TST915',
  ASESOR: 'TST916',
  SV: 'TST917',
}

const esperarSegundo = () => new Promise((r) => setTimeout(r, 1100))

test.group('Google ADS · canal de captación', (group) => {
  group.each.timeout(60_000)

  let admin: Usuario
  let token = ''
  let numero = 0

  const ahora = () => DateTime.now().setZone(ZONA)
  const auth = () => ({ Authorization: `Bearer ${token}` })

  async function crearTurnoHttp(client: any, placa: string, extra: Record<string, unknown>) {
    await esperarSegundo()
    return client
      .post('/api/turnos-rtm')
      .headers(auth())
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: admin.id,
        fecha: ahora().toISODate(),
        horaIngreso: ahora().toFormat('HH:mm:ss'),
        servicioId: SERVICIO_RTM,
        ...extra,
      })
  }

  const leer = (id: number) => TurnoRtm.findOrFail(id)

  group.setup(async () => {
    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'GOOGLE-ADS',
      correo: `test.google.ads.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(admin)
    token = tokenObj.value!.release()
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const marks = placas.map(() => '?').join(',')
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(
      `DELETE FROM turnos_rtms WHERE placa IN (${marks}) ORDER BY es_segunda_vez DESC, id DESC`,
      placas
    )
    if (admin) await admin.delete()
  })

  test('crear con canal GOOGLE_ADS guarda Google ADS, sin asesor aunque se mande uno', async ({
    client,
    assert,
  }) => {
    const agente = await Database.from('agentes_captacions').where('activo', true).first()
    const res = await crearTurnoHttp(client, P.CREAR, {
      canal: 'GOOGLE_ADS',
      ...(agente ? { agenteCaptacionId: agente.id } : {}),
    })
    res.assertStatus(201)

    const t = await leer(res.body().id ?? res.body().data?.id ?? res.body().turno?.id)
    assert.equal(t.canalAtribucion, 'GOOGLE_ADS')
    assert.equal(t.medioEntero, 'Google ADS')
    assert.isNull(t.agenteCaptacionId)
  })

  test('buscar la placa (sugiere su dateo FACHADA) y crear eligiendo Google ADS guarda Google ADS', async ({
    client,
    assert,
  }) => {
    const dateo = await CaptacionDateo.create({
      canal: 'FACHADA',
      origen: 'UI',
      placa: P.BUSCAR,
      servicioId: SERVICIO_RTM,
      resultado: 'PENDIENTE',
    } as any)

    const busqueda = await client.get('/api/buscar').headers(auth()).qs({ placa: P.BUSCAR })
    busqueda.assertStatus(200)
    assert.equal(busqueda.body().captacionSugerida?.canal, 'FACHADA')
    assert.equal(busqueda.body().dateoReciente?.id, dateo.id)

    // El operador cambió el desplegable: el frontend manda lo elegido.
    const res = await crearTurnoHttp(client, P.BUSCAR, { canal: 'GOOGLE_ADS', dateoId: dateo.id })
    res.assertStatus(201)

    const t = await TurnoRtm.query().where('placa', P.BUSCAR).firstOrFail()
    assert.equal(t.canalAtribucion, 'GOOGLE_ADS')
    assert.equal(t.medioEntero, 'Google ADS')
    assert.isNull(t.agenteCaptacionId)
  })

  test('editar un turno Google ADS conserva el canal; cambiarlo a Redes sí lo cambia', async ({
    client,
    assert,
  }) => {
    const res = await crearTurnoHttp(client, P.EDITAR, { canal: 'GOOGLE_ADS' })
    res.assertStatus(201)
    const t0 = await TurnoRtm.query().where('placa', P.EDITAR).firstOrFail()

    // Lo que manda EditarTurno al guardar sin tocar el desplegable.
    const put1 = await client
      .put(`/api/turnos-rtm/${t0.id}`)
      .headers(auth())
      .json({ usuarioId: admin.id, observaciones: 'editado', canal: 'GOOGLE_ADS' })
    put1.assertStatus(200)
    let t = await leer(t0.id)
    assert.equal(t.canalAtribucion, 'GOOGLE_ADS')
    assert.equal(t.medioEntero, 'Google ADS')
    assert.equal(t.observaciones, 'editado')

    // Sin canal en el body: no se toca.
    const put2 = await client
      .put(`/api/turnos-rtm/${t0.id}`)
      .headers(auth())
      .json({ usuarioId: admin.id, observaciones: 'otra vez' })
    put2.assertStatus(200)
    t = await leer(t0.id)
    assert.equal(t.canalAtribucion, 'GOOGLE_ADS')
    assert.equal(t.medioEntero, 'Google ADS')

    const put3 = await client
      .put(`/api/turnos-rtm/${t0.id}`)
      .headers(auth())
      .json({ usuarioId: admin.id, canal: 'REDES' })
    put3.assertStatus(200)
    t = await leer(t0.id)
    assert.equal(t.canalAtribucion, 'REDES')
    assert.equal(t.medioEntero, 'Redes Sociales')

    const put4 = await client
      .put(`/api/turnos-rtm/${t0.id}`)
      .headers(auth())
      .json({ usuarioId: admin.id, canal: 'GOOGLE_ADS' })
    put4.assertStatus(200)
    t = await leer(t0.id)
    assert.equal(t.canalAtribucion, 'GOOGLE_ADS')
    assert.equal(t.medioEntero, 'Google ADS')
  })

  test('los otros canales guardan el mismo canal y medio que antes', async ({ client, assert }) => {
    const casos = [
      { placa: P.FACHADA, canal: 'FACHADA', medio: 'Fachada' },
      { placa: P.REDES, canal: 'REDES', medio: 'Redes Sociales' },
      { placa: P.TELE, canal: 'TELE', medio: 'Call Center' },
      { placa: P.ASESOR, canal: 'ASESOR', medio: 'Asesor Comercial' },
    ]
    for (const c of casos) {
      const res = await crearTurnoHttp(client, c.placa, { canal: c.canal })
      res.assertStatus(201)
      const t = await TurnoRtm.query().where('placa', c.placa).firstOrFail()
      assert.equal(t.canalAtribucion, c.canal, c.placa)
      assert.equal(t.medioEntero, c.medio, c.placa)
    }
  })

  test('filtro canalAtribucion=GOOGLE_ADS y Excel de turnos muestran Google ADS', async ({
    client,
    assert,
  }) => {
    const hoy = ahora().toISODate()!
    const lista = await client
      .get('/api/turnos-rtm')
      .headers(auth())
      .qs({ fechaInicio: hoy, fechaFin: hoy, canalAtribucion: 'GOOGLE_ADS' })
    lista.assertStatus(200)
    const filas: any[] = Array.isArray(lista.body()) ? lista.body() : (lista.body().data ?? [])
    const nuestras = filas.filter((f) => Object.values(P).includes(f.placa))
    assert.isAbove(nuestras.length, 0)
    assert.isTrue(nuestras.every((f) => f.canalAtribucion === 'GOOGLE_ADS'))
    assert.includeMembers(
      nuestras.map((f) => f.placa),
      [P.CREAR, P.BUSCAR]
    )

    // El cliente de Japa no expone el cuerpo binario: fetch al mismo servidor.
    const qs = new URLSearchParams({
      fechaInicio: hoy,
      fechaFin: hoy,
      canalAtribucion: 'GOOGLE_ADS',
    })
    const excel = await fetch(
      `http://${process.env.HOST}:${process.env.PORT}/api/turnos-rtm/export-excel?${qs}`,
      { headers: auth() }
    )
    assert.equal(excel.status, 200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await excel.arrayBuffer()) as any)
    const ws = wb.worksheets[0]
    const cols = (ws.getRow(1).values as any[]).map((v) => String(v ?? ''))
    let colPlaca = cols.indexOf('Placa')
    let colCanal = cols.indexOf('Canal Atribución')
    let filaHeader = 1
    // El encabezado puede no estar en la fila 1 (títulos arriba).
    for (let r = 1; colPlaca < 0 && r <= 10; r++) {
      const v = (ws.getRow(r).values as any[]).map((x) => String(x ?? ''))
      colPlaca = v.indexOf('Placa')
      colCanal = v.indexOf('Canal Atribución')
      filaHeader = r
    }
    assert.isAbove(colPlaca, 0)
    const canales: string[] = []
    ws.eachRow((row, n) => {
      if (n <= filaHeader) return
      if (Object.values(P).includes(String(row.getCell(colPlaca).value)))
        canales.push(String(row.getCell(colCanal).value))
    })
    assert.isAbove(canales.length, 0)
    assert.isTrue(canales.every((c) => c === 'Google ADS'))
  })

  test('segunda vez de un origen Google ADS hereda el canal, sin asesor (igual que los demás)', async ({
    client,
    assert,
  }) => {
    const rechazadoAt = ahora().minus({ hours: 24 }).startOf('second')
    numero++
    const origen = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO_RTM,
      fecha: rechazadoAt,
      horaIngreso: '08:00',
      horaSalida: '09:00:00',
      tieneFacturacion: false,
      turnoNumero: -(9100 + numero),
      turnoNumeroServicio: -(9100 + numero),
      turnoCodigo: `TST-GADS-${P.SV}-${Date.now()}`,
      placa: P.SV,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
      resultadoCertificacion: 'RECHAZADA',
      rechazadoAt,
      ventanaSegundaVezHasta: rechazadoAt.plus({ hours: 360 }),
      canalAtribucion: 'GOOGLE_ADS',
      medioEntero: 'Google ADS',
    } as any)

    const sinConfirmar = await crearTurnoHttp(client, P.SV, { canal: 'FACHADA' })
    sinConfirmar.assertStatus(409)
    assert.equal(sinConfirmar.body().code, 'SEGUNDA_VEZ_DISPONIBLE')

    const res = await crearTurnoHttp(client, P.SV, {
      canal: 'FACHADA',
      segundaVezOrigenId: origen.id,
    })
    res.assertStatus(201)
    const sv = await TurnoRtm.query().where('placa', P.SV).where('es_segunda_vez', 1).firstOrFail()
    assert.equal(sv.turnoOrigenId, origen.id)
    assert.equal(sv.canalAtribucion, 'GOOGLE_ADS')
    assert.isNull(sv.agenteCaptacionId)
    assert.isNull(sv.captacionDateoId)
  })
})
