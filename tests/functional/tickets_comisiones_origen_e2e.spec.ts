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
import CaptacionDateo from '#models/captacion_dateo'
import FacturacionTicket from '#models/facturacion_ticket'

/**
 * Comisiones que vienen de un ticket de Excepción de Dateo:
 *  - campos nuevos (ticket_origen, dejado_de_pagar) y filtro "origen"
 *  - bloqueo de montos que contradicen un "sin comisión" en editar, valores,
 *    crear a mano y PUT /captacion-dateos/:id — sin confirmación (409), con
 *    confirmación de gerencia (se escribe y queda registrado), rol sin
 *    permiso de confirmar (403) y montos que no contradicen (como siempre)
 */

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10, CONTABILIDAD: 12 } as const
const ZONA = 'America/Bogota'
const CODIGO = 'MONTO_CONTRADICE_TICKET_SIN_COMISION'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

// Placas AAA999.
const P = {
  SIN_CONVENIO: 'TKO601',
  CON: 'TKO602',
  MANUAL_SIN_TICKET: 'TKO603',
  CASO1_SIN: 'TKO604',
  DATEO_SIN: 'TKO605',
  DATEO_CON: 'TKO606',
} as const

test.group('Tickets · comisiones con ticket de origen y bloqueo del $0', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  const ids: Record<string, Usuario> = {}
  const subidas: string[] = []
  const factIds: number[] = []
  let comercial: AgenteCaptacion
  let asesorConvenio: AgenteCaptacion
  let convenio: Convenio
  let asignacion: AsesorConvenioAsignacion
  let imagenPath: string
  let numero = 0

  const ahora = () => DateTime.now().setZone(ZONA)
  const bearer = (clave: string) => ({ Authorization: `Bearer ${tokens[clave]}` })

  async function esperar(peticion: Promise<any>, status: number) {
    const r = await peticion
    if (r.status() !== status) console.log('esperaba', status, JSON.stringify(r.body()))
    r.assertStatus(status)
    return r
  }

  async function crearUsuario(clave: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TK-ORIGEN-${clave}`,
      correo: `test.tk.origen.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    ids[clave] = u
    tokens[clave] = tokenObj.value!.release()
  }

  async function turno(placa: string) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: ids.ADMIN.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: ahora(),
      horaIngreso: '00:01',
      horaSalida: null,
      tieneFacturacion: false,
      turnoNumero: 986000 + numero,
      turnoNumeroServicio: 986000 + numero,
      turnoCodigo: `TST-TKO-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      esSegundaVez: false,
    } as any)
  }

  async function facturar(turnoId: number, placa: string) {
    const f = await FacturacionTicket.create({
      hash: `TEST-HASH-TKO-${placa}-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      total: 50000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
    } as any)
    factIds.push(f.id)
  }

  async function subir(client: any) {
    const r = await esperar(
      client.post('/api/media/upload').headers(bearer('ADMIN')).file('file', imagenPath),
      201
    )
    subidas.push(r.body().url)
    return r.body().url as string
  }

  /** Ticket aprobado por GERENCIA; devuelve la respuesta de aprobar(). */
  async function ticketAprobado(
    client: any,
    placa: string,
    o: { convenio: boolean; flags: Record<string, boolean>; facturar: boolean }
  ) {
    const t = await turno(placa)
    if (o.facturar) await facturar(t.id, placa)
    const rCrear = await esperar(
      client
        .post('/api/tickets-excepcion-dateo')
        .headers(bearer('ADMIN'))
        .json({
          turno_id: t.id,
          comercial_id: comercial.id,
          observacion: 'Comisión con ticket de origen',
          evidencia_chat_url: await subir(client),
          evidencia_grupo_whatsapp_url: await subir(client),
          evidencia_bloqueo_url: await subir(client),
          canal: 'ASESOR_COMERCIAL',
          ...(o.convenio ? { convenio_id: convenio.id } : {}),
        }),
      201
    )
    const ticketId = rCrear.body().ticket.id as number
    const r = await esperar(
      client
        .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
        .headers(bearer('GERENCIA'))
        .json(o.flags),
      200
    )
    return { ticketId, turnoId: t.id, ...r.body() }
  }

  const comentariosDe = async (ticketId: number) =>
    Database.from('tickets_comentarios').where('ticket_id', ticketId).orderBy('id')

  group.setup(async () => {
    await crearUsuario('ADMIN', ROL.SUPER_ADMIN)
    await crearUsuario('GERENCIA', ROL.GERENCIA)
    await crearUsuario('CONTABILIDAD', ROL.CONTABILIDAD)
    const sufijo = Date.now().toString(36).toUpperCase()
    comercial = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKO COMERCIAL ${sufijo}`,
    } as any)
    asesorConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKO CONVENIO ${sufijo}`,
    } as any)
    convenio = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKO CONVENIO ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    asignacion = await AsesorConvenioAsignacion.create({
      asesorId: comercial.id,
      convenioId: convenio.id,
      activo: true,
      fechaFin: null,
    } as any)
    imagenPath = app.tmpPath(`tst_tk_origen_${Date.now()}.png`)
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
      `DELETE FROM comisiones WHERE es_config = 0 AND captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${marks}))`,
      placas
    )
    if (factIds.length) await Database.from('facturacion_tickets').whereIn('id', factIds).delete()
    await Database.rawQuery(
      `UPDATE turnos_rtms SET captacion_dateo_id = NULL WHERE placa IN (${marks})`,
      placas
    )
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, placas)
    for (const url of subidas) {
      await fs.unlink(app.makePath(url.replace(/^\/api\//, ''))).catch(() => {})
    }
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    await asignacion.delete()
    await convenio.delete()
    await comercial.delete()
    await asesorConvenio.delete()
    for (const u of usuarios) await u.delete()
  })

  // ───────────── Campos nuevos y filtro ─────────────
  test('lista y detalle: ticket_origen con la marca, quién y cuándo; filtro origen', async ({
    client,
    assert,
  }) => {
    const sinConvenio = await ticketAprobado(client, P.SIN_CONVENIO, {
      convenio: true,
      flags: { con_comision_asesor: true, con_comision_convenio: false },
      facturar: true,
    })
    const con = await ticketAprobado(client, P.CON, {
      convenio: true,
      flags: { con_comision_asesor: true, con_comision_convenio: true },
      facturar: true,
    })
    // Comisión manual en un turno sin ticket.
    const tManual = await turno(P.MANUAL_SIN_TICKET)
    const rManual = await esperar(
      client
        .post('/api/comisiones')
        .headers(bearer('ADMIN'))
        .json({ turno_id: tManual.id, asesor_id: comercial.id, monto_asesor: 1000 }),
      200
    )
    const manualId = rManual.body().id as number

    const lista = async (qs = '') => {
      const r = await esperar(
        client
          .get(`/api/comisiones?asesorId=${comercial.id}&perPage=100${qs}`)
          .headers(bearer('GERENCIA')),
        200
      )
      return r.body().data as any[]
    }
    const todas = await lista()
    const fila = (id: number) => todas.find((c) => c.id === id)
    const marcada = fila(sinConvenio.comisionId)
    assert.exists(marcada, 'la comisión del ticket sale en la lista')
    // Campos de siempre siguen ahí (producción local y el frontend viejo los leen).
    assert.containsSubset(Object.keys(marcada), ['id', 'estado', 'asesor', 'turno'])
    assert.include(marcada.ticket_origen, {
      ticket_id: sinConvenio.ticketId,
      caso: 'CONVENIO_COMERCIAL',
      marca: 'SIN_COMISION_CONVENIO',
      etiqueta: `Sin comisión convenio · ticket #${sinConvenio.ticketId}`,
      sin_comision_asesor: false,
      sin_comision_convenio: true,
      decidido_por_id: ids.GERENCIA.id,
    })
    assert.match(marcada.ticket_origen.decidido_por_nombre, /TK-ORIGEN-GERENCIA/)
    assert.isString(marcada.ticket_origen.decidido_at)
    assert.isNull(fila(con.comisionId).ticket_origen.marca, 'aprobado con comisión: sin marca')
    assert.isNull(fila(manualId).ticket_origen, 'sin ticket de origen')

    const listaConTicket = await lista('&origen=con_ticket')
    const conTicket = listaConTicket.map((c) => c.id)
    assert.includeMembers(conTicket, [sinConvenio.comisionId, con.comisionId])
    assert.notInclude(conTicket, manualId)
    const listaSinComision = await lista('&origen=sin_comision_ticket')
    const sinComision = listaSinComision.map((c) => c.id)
    assert.deepEqual(sinComision, [sinConvenio.comisionId])

    const resumen = await client
      .get(`/api/comisiones/resumen?asesorId=${comercial.id}&origen=sin_comision_ticket`)
      .headers(bearer('GERENCIA'))
    resumen.assertStatus(200)

    // Detalle: lo dejado de pagar, exacto (foto del valor calculado).
    const det = await esperar(
      client.get(`/api/comisiones/${sinConvenio.comisionId}`).headers(bearer('GERENCIA')),
      200
    )
    const dejado = det.body().ticket_origen.dejado_de_pagar
    assert.isTrue(dejado.exacto)
    assert.equal(dejado.asesor, 0)
    assert.isAbove(dejado.convenio, 0)

    // Sin foto (p. ej. aprobado por producción local): estimado.
    await Database.from('tickets_detalle_excepcion_dateo')
      .where('ticket_id', sinConvenio.ticketId)
      .update({ monto_asesor_calculado: null, monto_convenio_calculado: null })
    const det2 = await esperar(
      client.get(`/api/comisiones/${sinConvenio.comisionId}`).headers(bearer('GERENCIA')),
      200
    )
    assert.isFalse(det2.body().ticket_origen.dejado_de_pagar.exacto)
    assert.equal(det2.body().ticket_origen.dejado_de_pagar.convenio, dejado.convenio)
  })

  // ───────────── editar ─────────────
  test('editar: 409 sin confirmar, 403 si confirma quien no puede, 200 con confirmación de gerencia', async ({
    client,
    assert,
  }) => {
    const filas = await Database.from('comisiones as c')
      .join('captacion_dateos as cd', 'cd.id', 'c.captacion_dateo_id')
      .where('cd.placa', P.SIN_CONVENIO)
      .select('c.id', 'cd.consumido_turno_id')
    const comisionId = filas[0].id as number
    const editar = (quien: string, body: object) =>
      client.patch(`/api/comisiones/${comisionId}/editar`).headers(bearer(quien)).json(body)
    const montos = async () => {
      const c = await Comision.findOrFail(comisionId)
      return { asesor: Number(c.montoAsesor), convenio: Number(c.montoConvenio) }
    }
    const antes = await montos()
    assert.equal(antes.convenio, 0)

    const r409 = await esperar(editar('GERENCIA', { monto_convenio: 5000 }), 409)
    assert.equal(r409.body().code, CODIGO)
    assert.match(
      r409.body().message,
      /Este valor viene de un ticket que decidió sin comisión \(ticket #\d+\)/
    )
    assert.deepEqual(r409.body().campos, ['monto_convenio'])
    assert.isTrue(r409.body().puede_confirmar)
    const rContab = await esperar(editar('CONTABILIDAD', { monto_convenio: 5000 }), 409)
    assert.isFalse(rContab.body().puede_confirmar)
    const r403 = await esperar(
      editar('CONTABILIDAD', { monto_convenio: 5000, confirmar_excepcion: true }),
      403
    )
    assert.equal(r403.body().code, 'CONFIRMACION_SIN_COMISION_NO_PERMITIDA')
    assert.deepEqual(await montos(), antes, 'sin confirmación válida no se escribe nada')

    // No contradice: el asesor cobra en este ticket, y $0 al convenio es lo decidido.
    await esperar(editar('CONTABILIDAD', { monto_asesor: 9000, monto_convenio: 0 }), 200)
    assert.deepEqual(await montos(), { asesor: 9000, convenio: 0 })

    const ticketId = r409.body().ticket_id as number
    const previos = await comentariosDe(ticketId)
    const comentariosAntes = previos.length
    await esperar(editar('GERENCIA', { monto_convenio: 5000, confirmar_excepcion: true }), 200)
    assert.deepEqual(await montos(), { asesor: 9000, convenio: 5000 })
    const c = await Comision.findOrFail(comisionId)
    assert.match(
      String(c.observacion),
      new RegExp(`\\[Excepción ticket #${ticketId}\\] edición manual`)
    )
    assert.match(String(c.observacion), /TK-ORIGEN-GERENCIA/)
    const comentarios = await comentariosDe(ticketId)
    assert.lengthOf(comentarios, comentariosAntes + 1)
    assert.equal(comentarios.at(-1).usuario_id, ids.GERENCIA.id)
    const evento = await Database.from('ticket_eventos')
      .where('ticket_id', ticketId)
      .where('tipo', 'COMENTARIO')
      .orderBy('id', 'desc')
      .first()
    const datos = typeof evento.datos === 'string' ? JSON.parse(evento.datos) : evento.datos
    assert.equal(datos.comision_id, comisionId)
  })

  // ───────────── valores y crear a mano ─────────────
  test('valores y crear a mano (tras anular): misma regla en Caso 1 "sin comisión"', async ({
    client,
    assert,
  }) => {
    const caso1 = await ticketAprobado(client, P.CASO1_SIN, {
      convenio: false,
      flags: { con_comision_asesor: false },
      facturar: true,
    })
    const comisionId = caso1.comisionId as number
    const valores = (quien: string, body: object) =>
      client.patch(`/api/comisiones/${comisionId}/valores`).headers(bearer(quien)).json(body)

    const r409 = await esperar(valores('GERENCIA', { cantidad: 1, valor_unitario: 1000 }), 409)
    assert.deepEqual(r409.body().campos, ['monto_asesor'])
    const sinCambio = await Comision.findOrFail(comisionId)
    assert.equal(Number(sinCambio.montoAsesor), 0)
    await esperar(valores('ADMIN', { cantidad: 1, valor_unitario: 0 }), 200)
    await esperar(
      valores('ADMIN', { cantidad: 1, valor_unitario: 1000, confirmar_excepcion: true }),
      200
    )
    const confirmada = await Comision.findOrFail(comisionId)
    assert.equal(Number(confirmada.montoAsesor), 1000)

    // Anular y crear otra a mano en el mismo turno.
    await esperar(
      client.post(`/api/comisiones/${comisionId}/anular`).headers(bearer('ADMIN')).json({}),
      200
    )
    const crear = (quien: string, body: object) =>
      client
        .post('/api/comisiones')
        .headers(bearer(quien))
        .json({ turno_id: caso1.turnoId, asesor_id: comercial.id, ...body })
    const contar = async () => {
      const filas = await Database.from('comisiones')
        .where('captacion_dateo_id', caso1.dateoId)
        .where('es_config', false)
        .count('* as n')
      return Number(filas[0].n)
    }
    const antes = await contar()
    const rCrear = await esperar(crear('CONTABILIDAD', { monto_asesor: 5000 }), 409)
    assert.equal(rCrear.body().code, CODIGO)
    await esperar(crear('CONTABILIDAD', { monto_asesor: 5000, confirmar_excepcion: true }), 403)
    assert.equal(await contar(), antes, 'no se creó ninguna')
    const ok = await esperar(
      crear('GERENCIA', { monto_asesor: 5000, confirmar_excepcion: true }),
      200
    )
    assert.equal(await contar(), antes + 1)
    assert.match(String(ok.body().observacion), /comisión creada a mano/)
  })

  // ───────────── PUT /captacion-dateos/:id ─────────────
  test('PUT del dateo que genera la comisión: 409 sin confirmar (no se guarda ni el dateo), 200 con confirmación', async ({
    client,
    assert,
  }) => {
    // Caso 1 "sin comisión" con Facturación sin confirmar: el dateo queda EN_PROCESO y sin comisión.
    const sin = await ticketAprobado(client, P.DATEO_SIN, {
      convenio: false,
      flags: { con_comision_asesor: false },
      facturar: false,
    })
    const put = (quien: string, dateoId: number, body: object) =>
      client.put(`/api/captacion-dateos/${dateoId}`).headers(bearer(quien)).json(body)
    const comisionesDe = (dateoId: number) =>
      Comision.query().where('captacion_dateo_id', dateoId).where('es_config', false)

    const r409 = await esperar(
      put('GERENCIA', sin.dateoId, { resultado: 'EXITOSO', observacion: 'cambio' }),
      409
    )
    assert.equal(r409.body().code, CODIGO)
    const dateo = await CaptacionDateo.findOrFail(sin.dateoId)
    assert.notEqual(dateo.resultado, 'EXITOSO', 'rollback: el dateo no cambió')
    assert.notEqual(dateo.observacion, 'cambio')
    assert.lengthOf(await comisionesDe(sin.dateoId), 0)

    await esperar(
      put('GERENCIA', sin.dateoId, { resultado: 'EXITOSO', confirmar_excepcion: true }),
      200
    )
    const creadas = await comisionesDe(sin.dateoId)
    assert.lengthOf(creadas, 1)
    assert.isAbove(Number(creadas[0].montoAsesor), 0)
    assert.match(String(creadas[0].observacion), /comisión generada al editar el dateo/)

    // Ticket con comisión: el PUT sigue igual que siempre.
    const con = await ticketAprobado(client, P.DATEO_CON, {
      convenio: false,
      flags: { con_comision_asesor: true },
      facturar: false,
    })
    await esperar(put('GERENCIA', con.dateoId, { resultado: 'EXITOSO' }), 200)
    assert.lengthOf(await comisionesDe(con.dateoId), 1)
  })
})
