import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'
import AgenteCaptacion from '#models/agente_captacion'
import TurnoRtm from '#models/turno_rtm'
import Comision from '#models/comision'
import FacturacionTicket from '#models/facturacion_ticket'

/**
 * Ticket de Excepción de Dateo sobre un turno SOAT ya facturado:
 * aprobar() crea la comisión con tipo_servicio 'RTM' sin mirar el servicio del
 * turno (ni crear() ni aprobar() restringen el servicio). El resto del sistema
 * solo paga comisión por RTM (applyCommissionHook, update del dateo).
 *
 * El test describe el comportamiento CORRECTO (sin comisión para SOAT) y está
 * marcado .fails() mientras el bug siga abierto (pendiente de decisión,
 * 2026-11-12). Cuando se arregle, Japa avisará y hay que quitar el .fails().
 */

const SEDE_ID = 2
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10 } as const
const ZONA = 'America/Bogota'
const PLACA = 'TKS901'
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
)

test.group('Tickets · Excepción de Dateo sobre turno SOAT', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  const subidas: string[] = []
  let admin: Usuario
  let comercial: AgenteCaptacion
  let imagenPath: string
  let servicioSoatId: number

  const bearer = (clave: string) => ({ Authorization: `Bearer ${tokens[clave]}` })

  async function crearUsuario(clave: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TK-SOAT-${clave}`,
      correo: `test.tk.soat.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    tokens[clave] = tokenObj.value!.release()
    return u
  }

  async function subir(client: any) {
    const r = await client
      .post('/api/media/upload')
      .headers(bearer('ADMIN'))
      .file('file', imagenPath)
    r.assertStatus(201)
    subidas.push(r.body().url)
    return r.body().url as string
  }

  group.setup(async () => {
    const soat = await Servicio.findByOrFail('codigoServicio', 'SOAT')
    servicioSoatId = soat.id
    admin = await crearUsuario('ADMIN', ROL.SUPER_ADMIN)
    await crearUsuario('GERENCIA', ROL.GERENCIA)
    comercial = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: `TEST TKS COMERCIAL ${Date.now().toString(36).toUpperCase()}`,
    } as any)
    imagenPath = app.tmpPath(`tst_tk_soat_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    const filas = await Database.from('turnos_rtms').where('placa', PLACA).select('id')
    const turnoIds = filas.map((r: any) => r.id)
    if (turnoIds.length) {
      const detalles = await Database.from('tickets_detalle_excepcion_dateo')
        .whereIn('turno_id', turnoIds)
        .select('ticket_id')
      const ticketIds = detalles.map((d: any) => d.ticket_id)
      await Database.from('tickets_detalle_excepcion_dateo').whereIn('turno_id', turnoIds).delete()
      if (ticketIds.length) {
        await Database.from('ticket_eventos').whereIn('ticket_id', ticketIds).delete()
        await Database.from('tickets').whereIn('id', ticketIds).delete()
      }
    }
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE es_config = 0 AND captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa = ?)`,
      [PLACA]
    )
    await Database.from('facturacion_tickets').where('placa', PLACA).delete()
    await Database.from('turnos_rtms').where('placa', PLACA).update({ captacion_dateo_id: null })
    await Database.from('captacion_dateos').where('placa', PLACA).delete()
    await Database.from('turnos_rtms').where('placa', PLACA).delete()
    for (const url of subidas) {
      await fs.unlink(app.makePath(url.replace(/^\/api\//, ''))).catch(() => {})
    }
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    if (comercial) await comercial.delete()
    for (const u of usuarios) await u.delete()
  })

  test('aprobar() sobre un turno SOAT facturado no debería crear comisión (y menos tipo RTM)', async ({
    client,
    assert,
  }) => {
    const turno = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: servicioSoatId,
      fecha: DateTime.now().setZone(ZONA),
      horaIngreso: '00:01',
      tieneFacturacion: true,
      turnoNumero: 987901,
      turnoNumeroServicio: 987901,
      turnoCodigo: `TST-TKS-${PLACA}-${Date.now()}`,
      placa: PLACA,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
      esSegundaVez: false,
    } as any)
    await FacturacionTicket.create({
      hash: `TEST-HASH-TKS-${PLACA}-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId: turno.id,
      placa: PLACA,
      servicioCodigo: 'SOAT',
      servicioNombre: 'SOAT',
      total: 50000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
    } as any)

    const rCrear = await client
      .post('/api/tickets-excepcion-dateo')
      .headers(bearer('ADMIN'))
      .json({
        turno_id: turno.id,
        comercial_id: comercial.id,
        observacion: 'Ticket sobre turno SOAT',
        evidencia_chat_url: await subir(client),
        evidencia_grupo_whatsapp_url: await subir(client),
        evidencia_bloqueo_url: await subir(client),
        canal: 'ASESOR_COMERCIAL',
        sin_convenio: true,
      })
    rCrear.assertStatus(201)

    const rAprobar = await client
      .patch(`/api/tickets-excepcion-dateo/${rCrear.body().ticket.id}/aprobar`)
      .headers(bearer('GERENCIA'))
      .json({ con_comision_asesor: true })
    rAprobar.assertStatus(200)

    const turnoFinal = await TurnoRtm.findOrFail(turno.id)
    assert.isNotNull(turnoFinal.captacionDateoId, 'aprobar() vincula el dateo al turno')
    const comisiones = await Comision.query()
      .where('captacion_dateo_id', turnoFinal.captacionDateoId!)
      .where('es_config', false)
    console.log(
      '--- comisiones del dateo del turno SOAT ---',
      JSON.stringify(
        comisiones.map((c) => ({ id: c.id, tipo: c.tipoServicio, monto: c.montoAsesor }))
      )
    )
    assert.lengthOf(comisiones, 0, 'un turno SOAT no genera comisión')
  }).fails(
    'Bug conocido (2026-11-12): aprobar() crea comisión tipo RTM sobre un turno SOAT; pendiente de decisión'
  )
})
