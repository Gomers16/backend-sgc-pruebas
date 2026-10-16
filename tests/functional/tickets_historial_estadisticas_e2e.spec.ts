import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import TurnoRtm from '#models/turno_rtm'
import Comision from '#models/comision'
import FacturacionTicket from '#models/facturacion_ticket'
import RepGeneralImportController from '#controllers/rep_general_imports_controller'
import { SQL_BACKFILL_TICKET_EVENTOS } from '#database/migrations/1798000000000_create_ticket_eventos_table'

/**
 * Fase 5 de Tickets — historial (ticket_eventos) y estadísticas.
 * Comercial A (Caso 3, con convenio): control, sin asesor, diferido en
 * proceso, rechazado, pendiente, dentro de ventana y régimen anterior.
 * Comercial B (Caso 1): ticket aprobado como lo deja producción local (solo
 * con_comision). Comercial C: eventos, corrección de convenio y backfill.
 */

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL = { SUPER_ADMIN: 9, COMERCIAL: 11 } as const
const ZONA = 'America/Bogota'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

const P = {
  A_CONTROL: 'TKE501',
  A_SIN_ASESOR: 'TKE502',
  A_DIFERIDO: 'TKE503',
  A_RECHAZADO: 'TKE504',
  A_PENDIENTE: 'TKE505',
  A_DENTRO: 'TKE506',
  A_REGIMEN: 'TKE507',
  B_PROD_LOCAL: 'TKE508',
  C_EVENTOS: 'TKE509',
  C_BACKFILL: 'TKE510',
} as const

test.group('Tickets · Fase 5 historial y estadísticas', (group) => {
  group.each.timeout(90_000)

  let admin: Usuario
  let usuarioComercial: Usuario
  let tokenAdmin: string
  let tokenComercial: string
  let agenteA: AgenteCaptacion
  let agenteB: AgenteCaptacion
  let agenteC: AgenteCaptacion
  let asesorConvenio: AgenteCaptacion
  let convenio: Convenio
  const asignaciones: AsesorConvenioAsignacion[] = []
  let imagenPath: string
  const subidas: string[] = []
  const factIds: number[] = []
  const ticket: Record<string, number> = {}
  const turno: Record<string, number> = {}
  let numero = 0
  // Montos completos del Caso 3 (del ticket control) y del Caso 1 (B).
  const full = { asesor: 0, convenio: 0, caso1: 0 }

  const ahora = () => DateTime.now().setZone(ZONA)
  /** await + assertStatus en un paso. */
  async function esperar(p: Promise<any> | any, status: number) {
    const r = await p
    r.assertStatus(status)
    return r
  }
  const authAdmin = () => ({ Authorization: `Bearer ${tokenAdmin}` })
  const authComercial = () => ({ Authorization: `Bearer ${tokenComercial}` })

  async function crearUsuario(clave: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TK-F5-${clave}`,
      correo: `test.tk.f5.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    const t = await Usuario.accessTokens.create(u)
    return { u, token: t.value!.release() }
  }

  async function turnoDirecto(placa: string, horaIngreso = '00:01') {
    numero++
    const t = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: ahora(),
      horaIngreso,
      horaSalida: null,
      tieneFacturacion: false,
      turnoNumero: 982000 + numero,
      turnoNumeroServicio: 982000 + numero,
      turnoCodigo: `TST-TKF5-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      esSegundaVez: false,
    } as any)
    turno[placa] = t.id
    return t
  }

  async function facturacion(turnoId: number, placa: string, estado: string) {
    const f = await FacturacionTicket.create({
      hash: `TEST-HASH-TKF5-${placa}-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado,
      turnoId,
      placa,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      total: 50000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
    } as any)
    factIds.push(f.id)
    return f
  }

  async function subir(client: any) {
    const r = await client.post('/api/media/upload').headers(authAdmin()).file('file', imagenPath)
    r.assertStatus(201)
    subidas.push(r.body().url)
    return r.body().url as string
  }

  async function crearTicket(client: any, placa: string, agente: AgenteCaptacion, intento = {}) {
    const r = await client
      .post('/api/tickets-excepcion-dateo')
      .headers(authAdmin())
      .json({
        turno_id: turno[placa],
        comercial_id: agente.id,
        observacion: 'Prueba Fase 5 tickets',
        evidencia_chat_url: await subir(client),
        evidencia_grupo_whatsapp_url: await subir(client),
        evidencia_bloqueo_url: await subir(client),
        ...intento,
      })
    r.assertStatus(201)
    ticket[placa] = r.body().ticket.id
    return r.body()
  }

  const conConvenio = () => ({ canal: 'ASESOR_COMERCIAL', convenio_id: convenio.id })
  const aprobar = (client: any, placa: string, body: Record<string, unknown>) =>
    client
      .patch(`/api/tickets-excepcion-dateo/${ticket[placa]}/aprobar`)
      .headers(authAdmin())
      .json(body)

  const listar = (client: any, qs: Record<string, unknown>, auth = authAdmin()) =>
    client.get('/api/tickets').headers(auth).qs(qs)

  const estadisticas = (client: any, qs: Record<string, unknown>) =>
    client.get('/api/tickets/estadisticas').headers(authAdmin()).qs(qs)

  group.setup(async () => {
    ;({ u: admin, token: tokenAdmin } = await crearUsuario('ADMIN', ROL.SUPER_ADMIN))
    ;({ u: usuarioComercial, token: tokenComercial } = await crearUsuario(
      'COMERCIAL',
      ROL.COMERCIAL
    ))

    const sufijo = Date.now().toString(36).toUpperCase()
    agenteA = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKF5 A ${sufijo}`,
      usuarioId: usuarioComercial.id,
    } as any)
    agenteB = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKF5 B ${sufijo}`,
    } as any)
    agenteC = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKF5 C ${sufijo}`,
    } as any)
    asesorConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKF5 CONVENIO ${sufijo}`,
    } as any)
    convenio = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKF5 CONVENIO ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    for (const a of [agenteA, agenteC]) {
      asignaciones.push(
        await AsesorConvenioAsignacion.create({
          asesorId: a.id,
          convenioId: convenio.id,
          activo: true,
          fechaFin: null,
        } as any)
      )
    }

    imagenPath = app.tmpPath(`tst_tk_f5_${Date.now()}.png`)
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
      if (ticketIds.length) {
        await Database.from('tickets_comentarios').whereIn('ticket_id', ticketIds).delete()
        await Database.from('tickets').whereIn('id', ticketIds).delete() // ticket_eventos: CASCADE
      }
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
    for (const a of asignaciones) await a.delete()
    await convenio.delete()
    for (const a of [agenteA, agenteB, agenteC, asesorConvenio]) await a.delete()
    await usuarioComercial.delete()
    await admin.delete()
  })

  test('arma los datos: aprobado directo, diferido en proceso, rechazado, pendiente, dentro de ventana, régimen anterior y producción local', async ({
    client,
    assert,
  }) => {
    // A · control: Caso 3 con comisión completa (comisión real).
    await turnoDirecto(P.A_CONTROL)
    await facturacion(turno[P.A_CONTROL], P.A_CONTROL, 'CONFIRMADA')
    await crearTicket(client, P.A_CONTROL, agenteA, conConvenio())
    const r0 = await aprobar(client, P.A_CONTROL, {
      con_comision_asesor: true,
      con_comision_convenio: true,
    })
    r0.assertStatus(200)
    const c0 = await Comision.findOrFail(r0.body().comisionId)
    full.asesor = Number(c0.montoAsesor)
    full.convenio = Number(c0.montoConvenio)
    assert.isAbove(full.asesor, 0)
    assert.isAbove(full.convenio, 0)
    // Por qué "monto − (asesor + convenio)" no sirve para lo dejado de pagar:
    // en Caso 3 `monto` es solo el valor del asesor.
    assert.equal(Number(c0.monto), full.asesor)
    assert.isBelow(Number(c0.monto) - (full.asesor + full.convenio), 0)

    // A · sin comisión asesor (comisión real).
    await turnoDirecto(P.A_SIN_ASESOR)
    await facturacion(turno[P.A_SIN_ASESOR], P.A_SIN_ASESOR, 'CONFIRMADA')
    await crearTicket(client, P.A_SIN_ASESOR, agenteA, conConvenio())
    await esperar(
      aprobar(client, P.A_SIN_ASESOR, {
        con_comision_asesor: false,
        con_comision_convenio: true,
      }),
      200
    )

    // A · diferido: aprobado sin comisión convenio, Facturación sin confirmar.
    await turnoDirecto(P.A_DIFERIDO)
    await facturacion(turno[P.A_DIFERIDO], P.A_DIFERIDO, 'LISTA_CONFIRMAR')
    await crearTicket(client, P.A_DIFERIDO, agenteA, conConvenio())
    const rDif = await aprobar(client, P.A_DIFERIDO, {
      con_comision_asesor: true,
      con_comision_convenio: false,
    })
    rDif.assertStatus(200)
    assert.isNull(rDif.body().comisionId)

    // A · rechazado y pendiente.
    await turnoDirecto(P.A_RECHAZADO)
    await crearTicket(client, P.A_RECHAZADO, agenteA, conConvenio())
    await esperar(
      client
        .patch(`/api/tickets-excepcion-dateo/${ticket[P.A_RECHAZADO]}/rechazar`)
        .headers(authAdmin())
        .json({ motivo: 'evidencia insuficiente' }),
      200
    )
    await turnoDirecto(P.A_PENDIENTE)
    await crearTicket(client, P.A_PENDIENTE, agenteA, conConvenio())

    // A · dentro de ventana (entró hace 2 min), en proceso.
    await turnoDirecto(P.A_DENTRO, ahora().minus({ minutes: 2 }).toFormat('HH:mm:ss'))
    const cDentro = await crearTicket(client, P.A_DENTRO, agenteA, conConvenio())
    assert.isTrue(Boolean(cDentro.detalle.dentroVentana))
    await esperar(aprobar(client, P.A_DENTRO, {}), 200)

    // A · régimen anterior: aprobado fuera de ventana sin decisión guardada.
    await turnoDirecto(P.A_REGIMEN)
    await crearTicket(client, P.A_REGIMEN, agenteA, conConvenio())
    await esperar(
      aprobar(client, P.A_REGIMEN, { con_comision_asesor: true, con_comision_convenio: true }),
      200
    )
    await Database.from('tickets_detalle_excepcion_dateo')
      .where('ticket_id', ticket[P.A_REGIMEN])
      .update({ con_comision: null, con_comision_asesor: null, con_comision_convenio: null })

    // B · Caso 1 aprobado sin comisión como lo deja producción local.
    await turnoDirecto(P.B_PROD_LOCAL)
    await facturacion(turno[P.B_PROD_LOCAL], P.B_PROD_LOCAL, 'CONFIRMADA')
    await crearTicket(client, P.B_PROD_LOCAL, agenteB)
    const rB = await aprobar(client, P.B_PROD_LOCAL, { con_comision_asesor: false })
    rB.assertStatus(200)
    const comisionB = await Comision.findOrFail(rB.body().comisionId)
    full.caso1 = Number(comisionB.monto)
    assert.isAbove(full.caso1, 0)
    await Database.from('tickets_detalle_excepcion_dateo')
      .where('ticket_id', ticket[P.B_PROD_LOCAL])
      // Producción local tampoco escribe la foto del valor calculado.
      .update({
        con_comision: 0,
        con_comision_asesor: null,
        con_comision_convenio: null,
        monto_asesor_calculado: null,
        monto_convenio_calculado: null,
      })
  })

  test('estadísticas: conteos, decisiones y dinero (real, en proceso y dejado de pagar)', async ({
    client,
    assert,
  }) => {
    const r = await estadisticas(client, { comercial_id: agenteA.id })
    r.assertStatus(200)
    const a = r.body().totales
    assert.equal(a.creados, 7)
    assert.equal(a.dentro_ventana, 1)
    assert.equal(a.fuera_ventana, 6)
    assert.deepEqual(a.aprobados, {
      total: 5,
      con: 2,
      sin_asesor: 1,
      sin_convenio: 1,
      sin_ninguno: 0,
      regimen_anterior: 1,
    })
    assert.equal(a.rechazados, 1)
    assert.equal(a.pendientes, 1)
    assert.equal(a.tasa_aprobacion, Math.round((5 / 6) * 100) / 100)
    assert.isNumber(a.tiempo_promedio_resolucion_min)

    // Real: control (asesor + convenio) y sin asesor (solo convenio).
    assert.equal(a.dinero.comision_real.tickets, 2)
    assert.equal(a.dinero.comision_real.asesor, full.asesor)
    assert.equal(a.dinero.comision_real.convenio, 2 * full.convenio)
    assert.equal(a.dinero.comision_real.por_estado.PENDIENTE.tickets, 2)
    // En proceso: diferido (asesor, convenio en $0), dentro de ventana y régimen anterior (completos).
    assert.equal(a.dinero.en_proceso.tickets, 3)
    assert.equal(a.dinero.en_proceso.asesor, 3 * full.asesor)
    assert.equal(a.dinero.en_proceso.convenio, 2 * full.convenio)
    // Dejado: asesor del "sin asesor" (real) + convenio del diferido (estimado).
    assert.equal(a.dinero.dejado_de_pagar.asesor, full.asesor)
    assert.equal(a.dinero.dejado_de_pagar.convenio, full.convenio)
    assert.equal(a.dinero.dejado_de_pagar.tickets, 2)
    // "Sin asesor" tiene foto (exacto); el diferido en proceso se estima.
    assert.deepEqual(a.dinero.dejado_de_pagar.exacto, {
      asesor: full.asesor,
      convenio: 0,
      tickets: 1,
    })
    assert.deepEqual(a.dinero.dejado_de_pagar.estimado, {
      asesor: 0,
      convenio: full.convenio,
      tickets: 1,
    })
    assert.isFalse(r.body().meta.tope_aplicado)
    assert.lengthOf(r.body().por_asesor, 1)
    assert.equal(r.body().por_asesor[0].comercial_id, agenteA.id)

    // B: aprobado solo con con_comision=0 (producción local) cuenta como sin asesor.
    const rb = await estadisticas(client, { comercial_id: agenteB.id })
    const b = rb.body().totales
    assert.equal(b.aprobados.sin_asesor, 1)
    assert.equal(b.dinero.comision_real.asesor, 0)
    assert.equal(b.dinero.dejado_de_pagar.asesor, full.caso1)
    // Sin foto (producción local): todo es estimado.
    assert.equal(b.dinero.dejado_de_pagar.estimado.asesor, full.caso1)
    assert.equal(b.dinero.dejado_de_pagar.exacto.tickets, 0)
  })

  test('filtros de GET /tickets (cada uno) y validación', async ({ client, assert }) => {
    const total = async (qs: Record<string, unknown>) => {
      const r = await listar(client, { comercial_id: agenteA.id, ...qs })
      r.assertStatus(200)
      return r.body().meta.total as number
    }
    assert.equal(await total({}), 7)
    assert.equal(await total({ estado: 'APROBADO' }), 5)
    assert.equal(await total({ estado: 'rechazado' }), 1)
    assert.equal(await total({ ventana: 'dentro' }), 1)
    assert.equal(await total({ ventana: 'fuera' }), 6)
    assert.equal(await total({ decision: 'con' }), 2)
    assert.equal(await total({ decision: 'sin_asesor' }), 1)
    assert.equal(await total({ decision: 'sin_convenio' }), 1)
    assert.equal(await total({ decision: 'sin_ninguno' }), 0)
    assert.equal(await total({ decision: 'regimen_anterior' }), 1)
    assert.equal(await total({ convenio_id: convenio.id }), 7)
    assert.equal(await total({ placa: P.A_SIN_ASESOR.toLowerCase() }), 1)
    assert.equal(await total({ turno_id: turno[P.A_DENTRO] }), 1)
    const hoy = ahora().toISODate()
    const ayer = ahora().minus({ days: 1 }).toISODate()
    assert.equal(await total({ fecha_desde: hoy, fecha_hasta: hoy }), 7)
    assert.equal(await total({ fecha_hasta: ayer }), 0)

    const b = await listar(client, { comercial_id: agenteB.id, decision: 'sin_asesor' })
    assert.equal(b.body().meta.total, 1)
    const fila = b.body().data[0]
    assert.equal(fila.resumen.decisionComision, 'sin_asesor')
    assert.equal(fila.resumen.comercialId, agenteB.id)

    for (const qs of [
      { decision: 'x' },
      { fecha_desde: '2026-13-01' },
      { ventana: 'casi' },
      { estado: 'NADA' },
    ]) {
      await esperar(listar(client, qs), 400)
    }
  })

  test('paginación y tope de per_page', async ({ client, assert }) => {
    const r = await listar(client, { comercial_id: agenteA.id, per_page: 2, page: 2 })
    r.assertStatus(200)
    assert.lengthOf(r.body().data, 2)
    assert.deepEqual(r.body().meta, { total: 7, current_page: 2, per_page: 2, last_page: 4 })
    const ultima = await listar(client, { comercial_id: agenteA.id, per_page: 2, page: 4 })
    assert.lengthOf(ultima.body().data, 1)
    const grande = await listar(client, { comercial_id: agenteA.id, per_page: 100000 })
    assert.equal(grande.body().meta.per_page, 100)
  })

  test('permisos: COMERCIAL recibe 403 en estadísticas, exportar y contador; su bandeja solo trae lo suyo', async ({
    client,
    assert,
  }) => {
    for (const ruta of [
      '/api/tickets/estadisticas',
      '/api/tickets/exportar',
      '/api/tickets/pendientes/contador',
    ]) {
      await esperar(client.get(ruta).headers(authComercial()), 403)
    }
    const propia = await listar(client, {}, authComercial())
    propia.assertStatus(200)
    const ids = propia.body().data.map((t: any) => t.id)
    assert.include(ids, ticket[P.A_CONTROL])
    assert.notInclude(ids, ticket[P.B_PROD_LOCAL])

    const contador = await client.get('/api/tickets/pendientes/contador').headers(authAdmin())
    contador.assertStatus(200)
    assert.isAtLeast(contador.body().pendientes, 1)
    assert.isAtLeast(contador.body().por_tipo.EXCEPCION_DATEO, 1)
  })

  test('exportar: Excel con los mismos filtros (hoja de tickets y resumen por asesor)', async ({
    assert,
  }) => {
    // Mismo patrón que reportes_por_canal.spec.ts: fetch directo para leer el binario.
    const r = await fetch(
      `http://${process.env.HOST}:${process.env.PORT}/api/tickets/exportar?comercial_id=${agenteA.id}`,
      { headers: authAdmin() }
    )
    assert.equal(r.status, 200)
    assert.include(r.headers.get('content-type') ?? '', 'spreadsheetml')
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await r.arrayBuffer()) as any)
    const tickets = wb.getWorksheet('Tickets')!
    assert.equal(tickets.rowCount, 8) // encabezado + 7
    const resumen = wb.getWorksheet('Resumen por asesor')!
    assert.equal(resumen.getRow(resumen.rowCount).getCell(1).value, 'TOTAL')
    assert.equal(resumen.getRow(resumen.rowCount).getCell(2).value, 7)
  })

  test('eventos: crear, comentario, convenio corregido y aprobar quedan en la línea de tiempo; rechazar también', async ({
    client,
    assert,
  }) => {
    await turnoDirecto(P.C_EVENTOS)
    await crearTicket(client, P.C_EVENTOS, agenteC, conConvenio())
    await esperar(
      client
        .post('/api/tickets/comentarios')
        .headers(authAdmin())
        .json({ ticket_id: ticket[P.C_EVENTOS], mensaje: 'revisando' }),
      201
    )
    await esperar(
      aprobar(client, P.C_EVENTOS, { convenio_id: null, con_comision_asesor: false }),
      200
    )

    const r = await client.get(`/api/tickets/${ticket[P.C_EVENTOS]}`).headers(authAdmin())
    r.assertStatus(200)
    const eventos = r.body().eventos
    assert.deepEqual(
      eventos.map((e: any) => e.tipo),
      ['CREADO', 'COMENTARIO', 'CONVENIO_CORREGIDO', 'APROBADO']
    )
    assert.isTrue(eventos.every((e: any) => e.sintetico === false))
    const corregido = eventos[2].datos
    assert.equal(corregido.convenio_anterior_id, convenio.id)
    assert.isNull(corregido.convenio_nuevo_id)
    assert.equal(eventos[3].datos.caso, 'SIN_CONVENIO')
    assert.equal(eventos[3].datos.con_comision_asesor, false)

    const rechazo = await Database.from('ticket_eventos')
      .where('ticket_id', ticket[P.A_RECHAZADO])
      .where('tipo', 'RECHAZADO')
      .first()
    assert.exists(rechazo)
    const datosRechazo =
      typeof rechazo.datos === 'string' ? JSON.parse(rechazo.datos) : rechazo.datos
    assert.equal(datosRechazo.motivo, 'evidencia insuficiente')
  })

  test('backfill y línea de tiempo de tickets sin eventos (p. ej. resueltos por producción local)', async ({
    client,
    assert,
  }) => {
    await turnoDirecto(P.C_BACKFILL)
    await crearTicket(client, P.C_BACKFILL, agenteC)
    await esperar(aprobar(client, P.C_BACKFILL, { con_comision_asesor: true }), 200)
    const id = ticket[P.C_BACKFILL]
    await Database.from('ticket_eventos').where('ticket_id', id).delete()

    // Sin eventos: la línea de tiempo se arma desde el ticket.
    const sinEventos = await client.get(`/api/tickets/${id}`).headers(authAdmin())
    assert.deepEqual(
      sinEventos.body().eventos.map((e: any) => [e.tipo, e.sintetico]),
      [
        ['CREADO', true],
        ['APROBADO', true],
      ]
    )

    // Backfill (idempotente: solo toca tickets sin eventos).
    for (const sql of SQL_BACKFILL_TICKET_EVENTOS) await Database.rawQuery(sql)
    const filas = await Database.from('ticket_eventos').where('ticket_id', id).orderBy('id')
    assert.deepEqual(
      filas.map((f: any) => f.tipo),
      ['CREADO', 'APROBADO']
    )
    const datos = typeof filas[1].datos === 'string' ? JSON.parse(filas[1].datos) : filas[1].datos
    assert.equal(datos.backfill, true)
    assert.equal(datos.con_comision_asesor, 1)
    for (const sql of SQL_BACKFILL_TICKET_EVENTOS) await Database.rawQuery(sql)
    assert.lengthOf(await Database.from('ticket_eventos').where('ticket_id', id), 2)
  })

  test('Rep General y "dejado de pagar": en Caso 3 no toca monto; en Caso 1 lo pasa al valor reclasificado y lo dejado sigue siendo monto − monto_asesor', async ({
    client,
    assert,
  }) => {
    const recalcular = async (placa: string) => {
      const t = await TurnoRtm.findOrFail(turno[placa])
      await (new RepGeneralImportController() as any).recalcularComisionSiExiste(
        t.captacionDateoId,
        {
          esRecurrente: true,
          esRecuperacion: false,
          mesesDesdeUltimaVisita: 3,
          ultimoTurnoId: null,
          fechaUltimaVisita: null,
          estadoContinuidad: null,
        },
        'Liviano Particular'
      )
      return Comision.query().where('captacion_dateo_id', t.captacionDateoId!).firstOrFail()
    }

    const c3 = await recalcular(P.A_SIN_ASESOR)
    assert.equal(Number(c3.monto), full.asesor, 'Caso 3: monto intacto')
    assert.equal(Number(c3.montoAsesor), 0)

    const c1 = await recalcular(P.B_PROD_LOCAL)
    assert.equal(Number(c1.montoAsesor), 0, 'se respeta el "sin comisión" de producción local')
    assert.notEqual(Number(c1.monto), full.caso1, 'Caso 1: monto pasa al valor recurrente')

    const rb = await estadisticas(client, { comercial_id: agenteB.id })
    assert.equal(rb.body().totales.dinero.dejado_de_pagar.asesor, Number(c1.monto))
  })
})
