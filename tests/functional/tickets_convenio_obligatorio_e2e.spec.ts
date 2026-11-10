import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import TurnoRtm from '#models/turno_rtm'
import Comision from '#models/comision'
import FacturacionTicket from '#models/facturacion_ticket'
import TicketDetalleExcepcionDateo from '#models/ticket_detalle_excepcion_dateo'

/**
 * Convenio obligatorio en tickets de Excepción de Dateo (Etapa 1):
 *  - crear(): convenio_id o sin_convenio=true (uno de los dos); el asesor
 *    convenio no elige; COMERCIAL solo convenios asignados, SUPER_ADMIN y
 *    GERENCIA cualquiera activo (queda convenio_no_asignado en el evento).
 *  - aprobar(): ticket sin convenio que nadie decidió → 409
 *    CONFIRMAR_SIN_CONVENIO hasta confirmar o corregir; corregir a un
 *    convenio no asignado queda registrado.
 *  - GET /tickets/:id: observacion_menciona_convenio y convenio_asignado.
 *  - GET /convenios/asignados: q, limit, asignado, incluir_no_asignados.
 *  - rechazar(): sin cambios (no pide decidir el convenio).
 */

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ZONA = 'America/Bogota'
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10, COMERCIAL: 11 } as const
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const P = {
  NADA: 'TKCV01',
  AMBOS: 'TKCV02',
  SIN: 'TKCV03',
  CON: 'TKCV04',
  ASESOR_CONV: 'TKCV05',
  COMERCIAL_NO_ASIG: 'TKCV06',
  ADMIN_NO_ASIG: 'TKCV07',
  VIEJO: 'TKCV08',
  VIEJO_CORRIGE_NULL: 'TKCV09',
  APROBAR_NO_ASIG: 'TKCV10',
  AVISO: 'TKCV11',
  RECHAZO: 'TKCV12',
} as const

test.group('Tickets · convenio obligatorio (crear y aprobar)', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  const subidas: string[] = []
  const factIds: number[] = []
  let admin: Usuario
  let comercial: AgenteCaptacion
  let asesorConvenio: AgenteCaptacion
  let convenioAsignado: Convenio
  let convenioAsesor: Convenio
  let convenioNoAsignado: Convenio
  let asignacion: AsesorConvenioAsignacion
  let sufijo: string
  let imagenPath: string
  let numero = 0

  const bearer = (clave: string) => ({ Authorization: `Bearer ${tokens[clave]}` })

  async function crearUsuario(clave: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TK-CONV-${clave}`,
      correo: `test.tk.conv.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    tokens[clave] = tokenObj.value!.release()
    return u
  }

  async function turnoDirecto(placa: string) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: DateTime.now().setZone(ZONA),
      horaIngreso: '06:00',
      horaSalida: null,
      tieneFacturacion: false,
      turnoNumero: -(9200 + numero),
      turnoNumeroServicio: -(9200 + numero),
      turnoCodigo: `TST-TKCV-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      esSegundaVez: false,
    } as any)
  }

  async function facturacionConfirmada(turnoId: number, placa: string) {
    const f = await FacturacionTicket.create({
      hash: `TEST-HASH-TKCV-${placa}-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa,
      servicioCodigo: 'RTM',
    } as any)
    factIds.push(f.id)
  }

  async function evidencias(client: any) {
    const subir = async () => {
      const r = await client
        .post('/api/media/upload')
        .headers(bearer('ADMIN'))
        .file('file', imagenPath)
      r.assertStatus(201)
      subidas.push(r.body().url)
      return r.body().url as string
    }
    return {
      evidencia_chat_url: await subir(),
      evidencia_grupo_whatsapp_url: await subir(),
      evidencia_bloqueo_url: await subir(),
    }
  }

  /** body sin decisión de convenio: cada test agrega la suya. */
  async function crear(
    client: any,
    turnoId: number,
    body: Record<string, unknown>,
    quien = 'ADMIN'
  ) {
    return client
      .post('/api/tickets-excepcion-dateo')
      .headers(bearer(quien))
      .json({
        turno_id: turnoId,
        ...(quien === 'COMERCIAL' ? {} : { comercial_id: comercial.id }),
        observacion: 'Prueba convenio obligatorio',
        ...(await evidencias(client)),
        ...body,
      })
  }

  const aprobar = (client: any, ticketId: number, body: Record<string, unknown>) =>
    client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .headers(bearer('GERENCIA'))
      .json(body)

  const eventos = (ticketId: number, tipo: string) =>
    Database.from('ticket_eventos').where('ticket_id', ticketId).where('tipo', tipo)

  const datosDe = (fila: any) =>
    typeof fila.datos === 'string' ? JSON.parse(fila.datos) : fila.datos

  /** Simula un ticket anterior a la regla (o de producción local): nadie decidió. */
  const volverTicketViejo = (ticketId: number) =>
    Database.from('tickets_detalle_excepcion_dateo')
      .where('ticket_id', ticketId)
      .update({ sin_convenio_explicito: null })

  group.setup(async () => {
    admin = await crearUsuario('ADMIN', ROL.SUPER_ADMIN)
    await crearUsuario('GERENCIA', ROL.GERENCIA)
    const usuarioComercial = await crearUsuario('COMERCIAL', ROL.COMERCIAL)

    sufijo = Date.now().toString(36).toUpperCase()
    comercial = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKCV COMERCIAL ${sufijo}`,
      usuarioId: usuarioComercial.id,
    } as any)
    asesorConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKCV ASESORCONV ${sufijo}`,
    } as any)
    convenioAsesor = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKCV ASESORCONV ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    convenioAsignado = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKCV ASIGNADO ${sufijo}`,
      establecimiento: `TALLER TKCV ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    convenioNoAsignado = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKCV OTRO ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    asignacion = await AsesorConvenioAsignacion.create({
      asesorId: comercial.id,
      convenioId: convenioAsignado.id,
      activo: true,
      fechaFin: null,
    } as any)

    imagenPath = app.tmpPath(`tst_tk_conv_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const marks = placas.map(() => '?').join(',')
    const filas = await Database.from('turnos_rtms').whereIn('placa', placas).select('id')
    const turnoIds = filas.map((r: any) => r.id)
    if (turnoIds.length) {
      const detalles = await Database.from('tickets_detalle_excepcion_dateo')
        .whereIn('turno_id', turnoIds)
        .select('ticket_id')
      const ticketIds = detalles.map((d: any) => d.ticket_id)
      await Database.from('tickets_detalle_excepcion_dateo').whereIn('turno_id', turnoIds).delete()
      if (ticketIds.length) await Database.from('tickets').whereIn('id', ticketIds).delete()
    }
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${marks}))`,
      placas
    )
    if (factIds.length) await Database.from('facturacion_tickets').whereIn('id', factIds).delete()
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    for (const url of subidas) {
      await fs.unlink(app.makePath(url.replace(/^\/api\//, ''))).catch(() => {})
    }
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    await asignacion.delete()
    await convenioAsignado.delete()
    await convenioNoAsignado.delete()
    await convenioAsesor.delete()
    await comercial.delete()
    await asesorConvenio.delete()
    for (const u of usuarios) await u.delete()
  })

  /* ═══════════ crear() ═══════════ */

  test('crear() sin convenio_id ni sin_convenio → 400 CONVENIO_NO_DECIDIDO', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.NADA)
    const r = await crear(client, turno.id, { canal: 'ASESOR_COMERCIAL' })
    r.assertStatus(400)
    assert.equal(r.body().code, 'CONVENIO_NO_DECIDIDO')
    const n = await Database.from('tickets_detalle_excepcion_dateo').where('turno_id', turno.id)
    assert.lengthOf(n, 0)
  })

  test('crear() con convenio_id y sin_convenio a la vez → 400', async ({ client, assert }) => {
    const turno = await turnoDirecto(P.AMBOS)
    const r = await crear(client, turno.id, {
      canal: 'ASESOR_COMERCIAL',
      convenio_id: convenioAsignado.id,
      sin_convenio: true,
    })
    r.assertStatus(400)
    assert.equal(r.body().code, 'CONVENIO_NO_DECIDIDO')
  })

  test('crear() con sin_convenio=true → 201, sin_convenio_explicito y evento CREADO', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.SIN)
    const r = await crear(client, turno.id, { canal: 'ASESOR_COMERCIAL', sin_convenio: true })
    r.assertStatus(201)
    const ticketId = r.body().ticket.id as number
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    assert.isNull(d.convenioId)
    assert.isTrue(Boolean(d.sinConvenioExplicito))
    const [ev] = await eventos(ticketId, 'CREADO')
    assert.isTrue(datosDe(ev).sin_convenio)
    assert.isFalse(datosDe(ev).convenio_no_asignado)
  })

  test('crear() con convenio asignado → 201 y sin_convenio_explicito=false', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.CON)
    const r = await crear(client, turno.id, {
      canal: 'ASESOR_COMERCIAL',
      convenio_id: convenioAsignado.id,
    })
    r.assertStatus(201)
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', r.body().ticket.id)
    assert.equal(d.convenioId, convenioAsignado.id)
    assert.isFalse(Boolean(d.sinConvenioExplicito))
    assert.isNotNull(d.sinConvenioExplicito)
  })

  test('crear() asesor convenio sin elegir nada → 201 con su convenio', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.ASESOR_CONV)
    const r = await client
      .post('/api/tickets-excepcion-dateo')
      .headers(bearer('ADMIN'))
      .json({
        turno_id: turno.id,
        comercial_id: asesorConvenio.id,
        observacion: 'Asesor convenio',
        ...(await evidencias(client)),
      })
    r.assertStatus(201)
    assert.equal(r.body().detalle.canal, 'ASESOR_CONVENIO')
    assert.equal(r.body().detalle.convenioId, convenioAsesor.id)
    assert.isFalse(Boolean(r.body().detalle.sinConvenioExplicito))
  })

  test('crear() COMERCIAL con convenio no asignado → 403; SUPER_ADMIN → 201 registrado', async ({
    client,
    assert,
  }) => {
    const t1 = await turnoDirecto(P.COMERCIAL_NO_ASIG)
    const rComercial = await crear(
      client,
      t1.id,
      { canal: 'ASESOR_COMERCIAL', convenio_id: convenioNoAsignado.id },
      'COMERCIAL'
    )
    rComercial.assertStatus(403)
    assert.equal(rComercial.body().code, 'INTENTO_DATEO_INVALIDO')

    const t2 = await turnoDirecto(P.ADMIN_NO_ASIG)
    const rAdmin = await crear(client, t2.id, {
      canal: 'ASESOR_COMERCIAL',
      convenio_id: convenioNoAsignado.id,
    })
    rAdmin.assertStatus(201)
    const ticketId = rAdmin.body().ticket.id as number
    assert.equal(rAdmin.body().detalle.convenioId, convenioNoAsignado.id)
    const [ev] = await eventos(ticketId, 'CREADO')
    assert.isTrue(datosDe(ev).convenio_no_asignado)

    const rGet = await client.get(`/api/tickets/${ticketId}`).headers(bearer('GERENCIA'))
    rGet.assertStatus(200)
    assert.isFalse(rGet.body().convenio_asignado)
  })

  /* ═══════════ aprobar() ═══════════ */

  test('aprobar() ticket viejo sin convenio: 409 CONFIRMAR_SIN_CONVENIO, luego confirma → Caso 1', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.VIEJO)
    const r = await crear(client, turno.id, { canal: 'ASESOR_COMERCIAL', sin_convenio: true })
    r.assertStatus(201)
    const ticketId = r.body().ticket.id as number
    await volverTicketViejo(ticketId)
    await facturacionConfirmada(turno.id, P.VIEJO)

    const r409 = await aprobar(client, ticketId, { con_comision_asesor: true })
    r409.assertStatus(409)
    assert.equal(r409.body().code, 'CONFIRMAR_SIN_CONVENIO')
    // Nada se escribió: sigue PENDIENTE y el turno sin dateo.
    const t = await Database.from('tickets').where('id', ticketId).first()
    assert.equal(t.estado, 'PENDIENTE')
    const turnoDb = await TurnoRtm.findOrFail(turno.id)
    assert.isNull(turnoDb.captacionDateoId)

    const rOk = await aprobar(client, ticketId, {
      con_comision_asesor: true,
      confirmar_sin_convenio: true,
    })
    rOk.assertStatus(200)
    assert.equal(rOk.body().caso, 'SIN_CONVENIO')
    assert.isTrue(rOk.body().sinConvenioConfirmado)
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    assert.isTrue(Boolean(d.sinConvenioExplicito))
    const [ev] = await eventos(ticketId, 'APROBADO')
    assert.isTrue(datosDe(ev).sin_convenio_confirmado)
  })

  test('aprobar() ticket viejo: corregir a convenio_id null cuenta como decisión', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.VIEJO_CORRIGE_NULL)
    const r = await crear(client, turno.id, { canal: 'ASESOR_COMERCIAL', sin_convenio: true })
    const ticketId = r.body().ticket.id as number
    await volverTicketViejo(ticketId)
    const rOk = await aprobar(client, ticketId, { con_comision_asesor: true, convenio_id: null })
    rOk.assertStatus(200)
    assert.equal(rOk.body().caso, 'SIN_CONVENIO')
    assert.isTrue(rOk.body().sinConvenioConfirmado)
  })

  test('aprobar() gerencia corrige a un convenio no asignado → Caso 3 registrado', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.APROBAR_NO_ASIG)
    const r = await crear(client, turno.id, { canal: 'ASESOR_COMERCIAL', sin_convenio: true })
    const ticketId = r.body().ticket.id as number
    await facturacionConfirmada(turno.id, P.APROBAR_NO_ASIG)

    const rOk = await aprobar(client, ticketId, {
      convenio_id: convenioNoAsignado.id,
      con_comision_asesor: true,
      con_comision_convenio: true,
    })
    rOk.assertStatus(200)
    assert.equal(rOk.body().caso, 'CONVENIO_COMERCIAL')
    assert.isTrue(rOk.body().convenioCorregido)
    assert.isTrue(rOk.body().convenioNoAsignado)

    const c = await Comision.findOrFail(rOk.body().comisionId)
    assert.equal(c.convenioId, convenioNoAsignado.id)
    assert.equal(c.asesorId, comercial.id)
    const [ev] = await eventos(ticketId, 'CONVENIO_CORREGIDO')
    assert.isNull(datosDe(ev).convenio_anterior_id)
    assert.equal(datosDe(ev).convenio_nuevo_id, convenioNoAsignado.id)
    assert.isTrue(datosDe(ev).convenio_no_asignado)
    const d = await TicketDetalleExcepcionDateo.findByOrFail('ticketId', ticketId)
    assert.isFalse(Boolean(d.sinConvenioExplicito))
  })

  test('GET /tickets/:id avisa si la observación dice "convenio"', async ({ client, assert }) => {
    const turno = await turnoDirecto(P.AVISO)
    const r = await crear(client, turno.id, {
      canal: 'ASESOR_COMERCIAL',
      sin_convenio: true,
      observacion: 'El cliente vino por el CONVENÍO del taller',
    })
    r.assertStatus(201)
    const rGet = await client.get(`/api/tickets/${r.body().ticket.id}`).headers(bearer('GERENCIA'))
    rGet.assertStatus(200)
    assert.isTrue(rGet.body().observacion_menciona_convenio)
    assert.isNull(rGet.body().convenio_asignado)
    assert.isTrue(Boolean(rGet.body().detalle.sinConvenioExplicito))
  })

  /* ═══════════ rechazar() ═══════════ */

  test('rechazar() ticket viejo sin convenio: no pide decidir y no crea dateo ni comisión', async ({
    client,
    assert,
  }) => {
    const turno = await turnoDirecto(P.RECHAZO)
    const r = await crear(client, turno.id, { canal: 'ASESOR_COMERCIAL', sin_convenio: true })
    const ticketId = r.body().ticket.id as number
    await volverTicketViejo(ticketId)
    const rRech = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/rechazar`)
      .headers(bearer('GERENCIA'))
      .json({ motivo: 'no aplica' })
    rRech.assertStatus(200)
    const turnoDb = await TurnoRtm.findOrFail(turno.id)
    assert.isNull(turnoDb.captacionDateoId)
    assert.lengthOf(await eventos(ticketId, 'CONVENIO_CORREGIDO'), 0)
  })

  /* ═══════════ GET /convenios/asignados ═══════════ */

  test('convenios/asignados: q, limit y asignado', async ({ client, assert }) => {
    const base = `/api/convenios/asignados?asesor_id=${comercial.id}`
    const rTodos = await client.get(base).headers(bearer('COMERCIAL'))
    rTodos.assertStatus(200)
    assert.deepEqual(
      rTodos.body().map((c: any) => [c.id, c.asignado]),
      [[convenioAsignado.id, true]]
    )

    const rQ = await client
      .get(`${base}&q=${encodeURIComponent(`taller tkcv ${sufijo}`)}`)
      .headers(bearer('COMERCIAL'))
    assert.lengthOf(rQ.body(), 1)
    const rQNada = await client.get(`${base}&q=NO-EXISTE-${sufijo}`).headers(bearer('COMERCIAL'))
    assert.lengthOf(rQNada.body(), 0)
    // Comodines de LIKE se buscan literales.
    const rComodin = await client.get(`${base}&q=%25`).headers(bearer('COMERCIAL'))
    assert.lengthOf(rComodin.body(), 0)
  })

  test('convenios/asignados: incluir_no_asignados solo SUPER_ADMIN/GERENCIA, asignados primero', async ({
    client,
    assert,
  }) => {
    const url = `/api/convenios/asignados?asesor_id=${comercial.id}&incluir_no_asignados=1&q=${encodeURIComponent(`TEST TKCV`)}&limit=50`
    const rCom = await client.get(url).headers(bearer('COMERCIAL'))
    rCom.assertStatus(403)

    const rGer = await client.get(url).headers(bearer('GERENCIA'))
    rGer.assertStatus(200)
    const filas = rGer.body().filter((c: any) => String(c.nombre).endsWith(sufijo))
    assert.equal(filas[0].id, convenioAsignado.id)
    assert.isTrue(filas[0].asignado)
    const otro = filas.find((c: any) => c.id === convenioNoAsignado.id)
    assert.isFalse(otro.asignado)

    const rLim = await client
      .get(`/api/convenios/asignados?asesor_id=${comercial.id}&incluir_no_asignados=1&limit=1`)
      .headers(bearer('ADMIN'))
    assert.lengthOf(rLim.body(), 1)
    assert.equal(rLim.body()[0].id, convenioAsignado.id)
  })
})
