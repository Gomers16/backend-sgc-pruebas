import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'
import FacturacionTicket from '#models/facturacion_ticket'
import Certificacion from '#models/certificacion'
import { evaluarContinuidad } from '#services/continuidad_service'
import { buscarTurnoSinDateoHoy } from '#services/reserva_dateo_service'
import { evaluarVentanaSegundaVez } from '#services/segunda_vez_service'

// "Segunda vez" — Entrega B1: detección en store() con confirmación,
// excepciones FORZADA/NO_APLICADA, guards de facturación/comisión/cierre,
// exclusiones comerciales, etapas y Turnero. Escribe en la BD compartida:
// placas TST950–TST965, limpieza completa al final.
//
// Nota: turno_codigo se genera con resolución de segundos (bug conocido,
// pendiente B); por eso se espera >1 s antes de cada creación por HTTP.

const SEDE_ID = 2
const OTRA_SEDE_ID = 1
const SERVICIO = { RTM: 1, PREV: 2 } as const
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10, COMERCIAL: 11, OPERATIVO_TURNOS: 14 } as const
const ZONA = 'America/Bogota'

const P = {
  DIA1: 'TST950',
  BORDE_DENTRO: 'TST951',
  BORDE_FUERA: 'TST952',
  MISMO_DIA: 'TST953',
  CONCURRENCIA: 'TST954',
  CONCURRENCIA_MISMA_SEDE: 'TST963',
  DOBLE_RECHAZO: 'TST955',
  CANCELAR: 'TST956',
  OTRO_SERVICIO: 'TST957',
  OTRA_PLACA: 'TST958',
  CONTINUIDAD: 'TST959',
  TURNERO: 'TST960',
  NO_APLICADA: 'TST961',
  FORZADA: 'TST962',
  GUARDS: 'TST964',
  UPDATE: 'TST965',
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

const esperarSegundo = () => new Promise((r) => setTimeout(r, 1100))

test.group('Segunda vez · flujo B1', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  const ids: Record<string, Usuario> = {}
  const ticketIds: number[] = []
  let imagenPath: string
  let numero = 0

  const ahora = () => DateTime.now().setZone(ZONA)
  const hoyISO = () => ahora().toISODate()!

  async function crearUsuario(clave: string, rolId: number, sedeId = SEDE_ID) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `SV-B1-${clave}`,
      correo: `test.sv.b1.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    ids[clave] = u
    tokens[clave] = tokenObj.value!.release()
  }

  /** Inserta un turno directo en BD (números negativos: no ocupan slots reales). */
  async function turnoDirecto(
    placa: string,
    o: {
      servicioId?: number
      fecha?: DateTime
      estado?: string
      resultado?: 'APROBADA' | 'RECHAZADA' | null
      rechazadoAt?: DateTime | null
      hasta?: DateTime | null
      esSegundaVez?: boolean
      turnoOrigenId?: number | null
      captacionDateoId?: number | null
      canal?: string | null
      sedeId?: number
    } = {}
  ) {
    numero++
    const t = await TurnoRtm.create({
      sedeId: o.sedeId ?? SEDE_ID,
      funcionarioId: ids.ADMIN.id,
      servicioId: o.servicioId ?? SERVICIO.RTM,
      fecha: o.fecha ?? ahora(),
      horaIngreso: '08:00',
      horaSalida: o.estado === 'finalizado' ? '09:00:00' : null,
      tieneFacturacion: false,
      turnoNumero: -(9500 + numero),
      turnoNumeroServicio: -(9500 + numero),
      turnoCodigo: `TST-SVB1-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: o.estado ?? 'activo',
      resultadoCertificacion: o.resultado ?? null,
      rechazadoAt: o.rechazadoAt ?? null,
      ventanaSegundaVezHasta: o.hasta ?? null,
      esSegundaVez: o.esSegundaVez ?? false,
      turnoOrigenId: o.turnoOrigenId ?? null,
      captacionDateoId: o.captacionDateoId ?? null,
      canalAtribucion: o.canal ?? null,
    } as any)
    return t
  }

  /** Origen RTM rechazado hace `horas` horas (fecha = día del rechazo). */
  async function origenRechazado(
    placa: string,
    o: { horas?: number; hasta?: DateTime; servicioId?: number; canal?: string } = {}
  ) {
    const rechazadoAt = ahora()
      .minus({ hours: o.horas ?? 24 })
      .startOf('second')
    return turnoDirecto(placa, {
      servicioId: o.servicioId,
      fecha: rechazadoAt,
      estado: 'finalizado',
      resultado: 'RECHAZADA',
      rechazadoAt,
      hasta: o.hasta ?? rechazadoAt.plus({ hours: 360 }),
      canal: o.canal ?? null,
    })
  }

  async function crearTurnoHttp(
    client: any,
    placa: string,
    extra: Record<string, unknown> = {},
    o: { usuario?: string; servicioId?: number; esperar?: boolean } = {}
  ) {
    if (o.esperar !== false) await esperarSegundo()
    const usuario = o.usuario ?? 'ADMIN'
    return client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${tokens[usuario]}`)
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: ids[usuario].id,
        fecha: hoyISO(),
        horaIngreso: ahora().toFormat('HH:mm:ss'),
        servicioId: o.servicioId ?? SERVICIO.RTM,
        ...extra,
      })
  }

  const hijosActivos = (origenId: number) =>
    TurnoRtm.query()
      .where('es_segunda_vez', 1)
      .where('turno_origen_id', origenId)
      .whereNot('estado', 'cancelado')

  group.setup(async () => {
    await crearUsuario('ADMIN', ROL.SUPER_ADMIN)
    await crearUsuario('ADMIN_SEDE1', ROL.SUPER_ADMIN, OTRA_SEDE_ID)
    await crearUsuario('GERENCIA', ROL.GERENCIA)
    await crearUsuario('OPERATIVO', ROL.OPERATIVO_TURNOS)
    await crearUsuario('COMERCIAL', ROL.COMERCIAL)

    imagenPath = app.tmpPath(`tst_sv_b1_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const marks = placas.map(() => '?').join(',')
    const filas = await Database.from('turnos_rtms').whereIn('placa', placas).select('id')
    const turnoIds = filas.map((r: any) => r.id)
    if (turnoIds.length) {
      const certs = await Certificacion.query().whereIn('turno_id', turnoIds)
      for (const c of certs) await fs.unlink(app.makePath(c.imagenPath)).catch(() => {})
      await Database.from('tickets_detalle_excepcion_dateo').whereIn('turno_id', turnoIds).delete()
    }
    if (ticketIds.length)
      await Database.from('facturacion_tickets').whereIn('id', ticketIds).delete()
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    // Hijas antes que orígenes (turno_origen_id no tiene FK, pero por orden)
    await Database.rawQuery(
      `DELETE FROM turnos_rtms WHERE placa IN (${marks}) ORDER BY es_segunda_vez DESC, id DESC`,
      placas
    )
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    for (const u of usuarios) await u.delete()
  })

  // ───────────────────────── Día 1 ─────────────────────────
  test('Día 1: 409 SEGUNDA_VEZ_DISPONIBLE y con confirmación 201 como segunda vez, sin dateo ni WINDOW_BLOCK', async ({
    client,
    assert,
  }) => {
    // RTM APROBADA hace 5 meses: un turno normal sí daría WINDOW_BLOCK.
    await turnoDirecto(P.DIA1, {
      fecha: ahora().minus({ months: 5 }),
      estado: 'finalizado',
      resultado: 'APROBADA',
    })
    const origen = await origenRechazado(P.DIA1, { horas: 24, canal: 'FACHADA' })
    // Dateo del origen (ya consumido) y uno PENDIENTE que no debe consumirse.
    const dateoOrigen = await CaptacionDateo.create({
      canal: 'FACHADA',
      origen: 'UI',
      placa: P.DIA1,
      servicioId: SERVICIO.RTM,
      resultado: 'EXITOSO',
      consumidoTurnoId: origen.id,
    } as any)
    origen.captacionDateoId = dateoOrigen.id
    await origen.save()
    const dateoPendiente = await CaptacionDateo.create({
      canal: 'FACHADA',
      origen: 'UI',
      placa: P.DIA1,
      servicioId: SERVICIO.RTM,
      resultado: 'PENDIENTE',
    } as any)
    const agente = await Database.from('agentes_captacions').select('id').first()

    const r1 = await crearTurnoHttp(client, P.DIA1)
    r1.assertStatus(409)
    r1.assertBodyContains({ code: 'SEGUNDA_VEZ_DISPONIBLE' })
    const v = r1.body().ventana
    assert.equal(v.origenId, origen.id)
    assert.equal(v.estado, 'ABIERTA')
    assert.approximately(v.horasRestantes, 336, 0.1)
    assert.equal(
      DateTime.fromISO(v.hasta).toMillis(),
      origen.rechazadoAt!.plus({ hours: 360 }).toMillis()
    )

    const r2 = await crearTurnoHttp(client, P.DIA1, {
      segundaVezOrigenId: origen.id,
      canal: 'ASESOR',
      agenteCaptacionId: agente?.id ?? null,
      asesorDetectadoId: agente?.id ?? undefined,
      dateoId: dateoPendiente.id,
    })
    r2.assertStatus(201)
    const t = await TurnoRtm.findOrFail(r2.body().id)
    assert.isTrue(Boolean(t.esSegundaVez))
    assert.equal(t.turnoOrigenId, origen.id)
    assert.isNull(t.captacionDateoId)
    assert.isNull(t.agenteCaptacionId)
    assert.equal(t.canalAtribucion, 'FACHADA') // copiado del origen, no el del body
    assert.isNull(t.segundaVezExcepcion)
    assert.isFalse(Boolean(t.esRecurrente))
    assert.isNull(t.ultimoTurnoId)

    // El dateo del origen no cambia, el pendiente no se consume y no hay auto-dateo.
    const dOrigen = await CaptacionDateo.findOrFail(dateoOrigen.id)
    assert.equal(dOrigen.resultado, 'EXITOSO')
    assert.equal(dOrigen.consumidoTurnoId, origen.id)
    const dPend = await CaptacionDateo.findOrFail(dateoPendiente.id)
    assert.equal(dPend.resultado, 'PENDIENTE')
    assert.isNull(dPend.consumidoTurnoId)
    const dateos = await CaptacionDateo.query().where('placa', P.DIA1)
    assert.lengthOf(dateos, 2)
  })

  // ───────────────────────── Bordes ─────────────────────────
  test('Borde: hasta dentro de 60 s sigue siendo segunda vez', async ({ client }) => {
    const origen = await origenRechazado(P.BORDE_DENTRO, {
      horas: 359,
      hasta: ahora().plus({ seconds: 60 }).startOf('second'),
    })
    const r = await crearTurnoHttp(client, P.BORDE_DENTRO)
    r.assertStatus(409)
    r.assertBodyContains({ code: 'SEGUNDA_VEZ_DISPONIBLE', ventana: { origenId: origen.id } })
  })

  test('Borde: hasta hace 1 s → turno normal', async ({ client, assert }) => {
    await origenRechazado(P.BORDE_FUERA, {
      horas: 361,
      hasta: ahora().minus({ seconds: 1 }).startOf('second'),
    })
    const r = await crearTurnoHttp(client, P.BORDE_FUERA)
    r.assertStatus(201)
    const t = await TurnoRtm.findOrFail(r.body().id)
    assert.isFalse(Boolean(t.esSegundaVez))
    assert.isNull(t.turnoOrigenId)
  })

  test('Mismo día y misma sede: 409 SEGUNDA_VEZ_MISMO_DIA_PENDIENTE_B2 (no 500)', async ({
    client,
  }) => {
    const origen = await origenRechazado(P.MISMO_DIA, { horas: 0 })
    const r1 = await crearTurnoHttp(client, P.MISMO_DIA)
    r1.assertStatus(409)
    r1.assertBodyContains({ code: 'SEGUNDA_VEZ_MISMO_DIA_PENDIENTE_B2' })
    const r2 = await crearTurnoHttp(client, P.MISMO_DIA, { segundaVezOrigenId: origen.id })
    r2.assertStatus(409)
    r2.assertBodyContains({ code: 'SEGUNDA_VEZ_MISMO_DIA_PENDIENTE_B2' })
  })

  // ───────────────────────── Concurrencia ─────────────────────────
  test('Doble creación simultánea (dos sedes): una sola segunda vez activa', async ({
    client,
    assert,
  }) => {
    const origen = await origenRechazado(P.CONCURRENCIA)
    await esperarSegundo()
    const [a, b] = await Promise.all([
      crearTurnoHttp(client, P.CONCURRENCIA, { segundaVezOrigenId: origen.id }, { esperar: false }),
      crearTurnoHttp(
        client,
        P.CONCURRENCIA,
        { segundaVezOrigenId: origen.id },
        { usuario: 'ADMIN_SEDE1', esperar: false }
      ),
    ])
    const estados = [a.status(), b.status()].sort()
    assert.deepEqual(estados, [201, 409])
    console.log(
      '--- concurrencia dos sedes ---',
      a.status(),
      a.body()?.code,
      '|',
      b.status(),
      b.body()?.code
    )
    const perdedor = a.status() === 409 ? a : b
    perdedor.assertBodyContains({ code: 'SEGUNDA_VEZ_NO_DISPONIBLE' })
    assert.equal(perdedor.body().ventana.estado, 'USADA')
    assert.lengthOf(await hijosActivos(origen.id), 1)
  })

  test('Doble creación simultánea (misma sede): una sola segunda vez activa y la otra 409', async ({
    client,
    assert,
  }) => {
    // En la misma sede también la frenaría dedupe_key; se valida que el
    // perdedor recibe un 409 (nunca 500) y que queda una sola hija activa.
    const origen = await origenRechazado(P.CONCURRENCIA_MISMA_SEDE)
    await esperarSegundo()
    const [a, b] = await Promise.all([
      crearTurnoHttp(
        client,
        P.CONCURRENCIA_MISMA_SEDE,
        { segundaVezOrigenId: origen.id },
        { esperar: false }
      ),
      crearTurnoHttp(
        client,
        P.CONCURRENCIA_MISMA_SEDE,
        { segundaVezOrigenId: origen.id },
        { esperar: false }
      ),
    ])
    console.log(
      '--- concurrencia misma sede ---',
      a.status(),
      a.body()?.code,
      '|',
      b.status(),
      b.body()?.code
    )
    assert.deepEqual([a.status(), b.status()].sort(), [201, 409])
    const perdedor = a.status() === 409 ? a : b
    assert.include(['SEGUNDA_VEZ_NO_DISPONIBLE', 'DUPLICATE_DAY'], perdedor.body().code)
    assert.lengthOf(await hijosActivos(origen.id), 1)
  })

  // ───────────────────────── Doble rechazo ─────────────────────────
  test('Doble rechazo: el siguiente turno es normal (paga) y no hay WINDOW_BLOCK', async ({
    client,
    assert,
  }) => {
    const origen = await origenRechazado(P.DOBLE_RECHAZO, { horas: 72 })
    await turnoDirecto(P.DOBLE_RECHAZO, {
      fecha: ahora().minus({ days: 1 }),
      estado: 'finalizado',
      resultado: 'RECHAZADA',
      rechazadoAt: ahora().minus({ days: 1 }),
      hasta: null,
      esSegundaVez: true,
      turnoOrigenId: origen.id,
    })
    const r = await crearTurnoHttp(client, P.DOBLE_RECHAZO)
    r.assertStatus(201)
    const t = await TurnoRtm.findOrFail(r.body().id)
    assert.isFalse(Boolean(t.esSegundaVez))
  })

  // ───────────────────────── Cancelaciones ─────────────────────────
  test('Cancelar el origen con hija activa → 409; cancelar la segunda vez reabre la ventana', async ({
    client,
    assert,
  }) => {
    const origen = await origenRechazado(P.CANCELAR)
    const r1 = await crearTurnoHttp(client, P.CANCELAR, { segundaVezOrigenId: origen.id })
    r1.assertStatus(201)
    const hijaId = r1.body().id

    const cOrigen = await client
      .patch(`/api/turnos-rtm/${origen.id}/cancelar`)
      .header('Authorization', `Bearer ${tokens.ADMIN}`)
      .json({ usuarioId: ids.ADMIN.id, motivoCancelacion: 'Prueba origen con hija' })
    cOrigen.assertStatus(409)
    cOrigen.assertBodyContains({ code: 'ORIGEN_CON_SEGUNDA_VEZ_ACTIVA', hijoActivoId: hijaId })

    const cHija = await client
      .patch(`/api/turnos-rtm/${hijaId}/cancelar`)
      .header('Authorization', `Bearer ${tokens.ADMIN}`)
      .json({ usuarioId: ids.ADMIN.id, motivoCancelacion: 'Prueba reabrir ventana' })
    cHija.assertStatus(200)

    const r2 = await crearTurnoHttp(client, P.CANCELAR)
    r2.assertStatus(409)
    r2.assertBodyContains({ code: 'SEGUNDA_VEZ_DISPONIBLE', ventana: { origenId: origen.id } })
    const r3 = await crearTurnoHttp(client, P.CANCELAR, { segundaVezOrigenId: origen.id })
    r3.assertStatus(201)
    assert.lengthOf(await hijosActivos(origen.id), 1)

    // La hija cancelada no se puede reactivar con otra activa.
    const act = await client
      .patch(`/api/turnos-rtm/${hijaId}/activar`)
      .header('Authorization', `Bearer ${tokens.ADMIN}`)
      .json({ usuarioId: ids.ADMIN.id })
    act.assertStatus(409)
    act.assertBodyContains({ code: 'SEGUNDA_VEZ_YA_ACTIVA' })
  })

  // ───────────────────────── Aislamiento ─────────────────────────
  test('Otro servicio (PREV con origen RTM) y otra placa no se ven afectados', async ({
    client,
    assert,
  }) => {
    await origenRechazado(P.OTRO_SERVICIO)
    const rPrev = await crearTurnoHttp(client, P.OTRO_SERVICIO, {}, { servicioId: SERVICIO.PREV })
    rPrev.assertStatus(201)
    const tPrev = await TurnoRtm.findOrFail(rPrev.body().id)
    assert.isFalse(Boolean(tPrev.esSegundaVez))

    const rOtra = await crearTurnoHttp(client, P.OTRA_PLACA)
    rOtra.assertStatus(201)
    const tOtra = await TurnoRtm.findOrFail(rOtra.body().id)
    assert.isFalse(Boolean(tOtra.esSegundaVez))
  })

  // ───────────────────────── Guards ─────────────────────────
  test('Sin facturación ni comisión: tickets, comisión, cerrar, salida y excepción de dateo → 409 TURNO_SEGUNDA_VEZ', async ({
    client,
    assert,
  }) => {
    const origen = await origenRechazado(P.GUARDS)
    const sv = await turnoDirecto(P.GUARDS, { esSegundaVez: true, turnoOrigenId: origen.id })
    const agente = await Database.from('agentes_captacions').select('id').first()
    const auth = { Authorization: `Bearer ${tokens.ADMIN}` }

    const tStore = await client
      .post('/api/facturacion/tickets')
      .headers(auth)
      .field('turno_id', String(sv.id))
      .field('servicio_id', String(SERVICIO.RTM))
      .file('archivo', imagenPath)
    tStore.assertStatus(409)
    tStore.assertBodyContains({ code: 'TURNO_SEGUNDA_VEZ' })

    const ticketLibre = await FacturacionTicket.create({
      hash: `tst-sv-b1-libre-${Date.now()}`,
      filePath: '/tmp/tst-sv-b1-libre.png',
      estado: 'BORRADOR',
    } as any)
    ticketIds.push(ticketLibre.id)
    const tUpdate = await client
      .patch(`/api/facturacion/tickets/${ticketLibre.id}`)
      .headers(auth)
      .json({ turno_id: sv.id })
    tUpdate.assertStatus(409)
    tUpdate.assertBodyContains({ code: 'TURNO_SEGUNDA_VEZ' })

    const ticketSv = await FacturacionTicket.create({
      hash: `tst-sv-b1-sv-${Date.now()}`,
      filePath: '/tmp/tst-sv-b1-sv.png',
      estado: 'BORRADOR',
      turnoId: sv.id,
    } as any)
    ticketIds.push(ticketSv.id)
    const tConfirmar = await client
      .post(`/api/facturacion/tickets/${ticketSv.id}/confirmar`)
      .headers(auth)
      .json({})
    tConfirmar.assertStatus(409)
    tConfirmar.assertBodyContains({ code: 'TURNO_SEGUNDA_VEZ' })

    const comision = await client
      .post('/api/comisiones')
      .headers(auth)
      .json({ turno_id: sv.id, monto_asesor: 1000 })
    comision.assertStatus(409)
    comision.assertBodyContains({ code: 'TURNO_SEGUNDA_VEZ' })

    const cerrar = await client.post(`/api/turnos-rtm/${sv.id}/cerrar`).headers(auth).json({})
    cerrar.assertStatus(409)
    cerrar.assertBodyContains({ code: 'TURNO_SEGUNDA_VEZ' })

    const salida = await client
      .put(`/api/turnos-rtm/${sv.id}/salida`)
      .headers(auth)
      .json({ usuarioId: ids.ADMIN.id })
    salida.assertStatus(409)
    salida.assertBodyContains({ code: 'TURNO_SEGUNDA_VEZ' })

    const excepcion = await client.post('/api/tickets-excepcion-dateo').headers(auth).json({
      turno_id: sv.id,
      observacion: 'prueba segunda vez',
      evidencia_chat_url: 'x',
      evidencia_grupo_whatsapp_url: 'x',
      evidencia_bloqueo_url: 'x',
      comercial_id: agente?.id,
    })
    excepcion.assertStatus(409)
    excepcion.assertBodyContains({ code: 'TURNO_SEGUNDA_VEZ' })

    const turnoDb = await TurnoRtm.findOrFail(sv.id)
    assert.equal(turnoDb.estado, 'activo')
    assert.isNull(turnoDb.captacionDateoId)
  })

  test('RTM normal no se finaliza por /salida, /cerrar ni Editar turno (FINALIZAR_REQUIERE_CERTIFICACION)', async ({
    client,
  }) => {
    const t = await turnoDirecto(P.OTRA_PLACA, { fecha: ahora().minus({ days: 2 }) })
    const auth = { Authorization: `Bearer ${tokens.ADMIN}` }
    const salida = await client
      .put(`/api/turnos-rtm/${t.id}/salida`)
      .headers(auth)
      .json({ usuarioId: ids.ADMIN.id })
    salida.assertStatus(409)
    salida.assertBodyContains({ code: 'FINALIZAR_REQUIERE_CERTIFICACION' })
    const cerrar = await client.post(`/api/turnos-rtm/${t.id}/cerrar`).headers(auth).json({})
    cerrar.assertStatus(409)
    cerrar.assertBodyContains({ code: 'FINALIZAR_REQUIERE_CERTIFICACION' })
    const editar = await client
      .put(`/api/turnos-rtm/${t.id}`)
      .headers(auth)
      .json({ usuarioId: ids.ADMIN.id, estado: 'finalizado' })
    editar.assertStatus(409)
    editar.assertBodyContains({ code: 'FINALIZAR_REQUIERE_CERTIFICACION' })
  })

  test('update(): placa/servicio/fecha bloqueados en la segunda vez y en el origen con hija activa', async ({
    client,
  }) => {
    const origen = await origenRechazado(P.UPDATE)
    const sv = await turnoDirecto(P.UPDATE, { esSegundaVez: true, turnoOrigenId: origen.id })
    const auth = { Authorization: `Bearer ${tokens.ADMIN}` }
    for (const [id, cambio] of [
      [sv.id, { placa: 'TST999' }],
      [sv.id, { servicioId: SERVICIO.PREV }],
      [origen.id, { fecha: ahora().minus({ days: 5 }).toISODate() }],
    ] as const) {
      const r = await client
        .put(`/api/turnos-rtm/${id}`)
        .headers(auth)
        .json({ usuarioId: ids.ADMIN.id, ...cambio })
      r.assertStatus(409)
      r.assertBodyContains({ code: 'SEGUNDA_VEZ_CAMPOS_BLOQUEADOS' })
    }
    const cancelarOrigen = await client
      .put(`/api/turnos-rtm/${origen.id}`)
      .headers(auth)
      .json({ usuarioId: ids.ADMIN.id, estado: 'cancelado' })
    cancelarOrigen.assertStatus(409)
    cancelarOrigen.assertBodyContains({ code: 'ORIGEN_CON_SEGUNDA_VEZ_ACTIVA' })
  })

  // ───────────────────────── Exclusiones comerciales ─────────────────────────
  test('Continuidad: una segunda vez sin dateo no da ROTA; REQUIERE_TICKET_DATEO no se dispara', async ({
    client,
    assert,
  }) => {
    const convenio = await Database.from('convenios').select('id').first()
    assert.exists(convenio, 'se necesita al menos un convenio en la BD')
    const dateo = await CaptacionDateo.create({
      canal: 'ASESOR_CONVENIO',
      origen: 'UI',
      placa: P.CONTINUIDAD,
      servicioId: SERVICIO.RTM,
      convenioId: convenio.id,
      resultado: 'EXITOSO',
    } as any)
    const origen = await turnoDirecto(P.CONTINUIDAD, {
      fecha: ahora().minus({ days: 3 }),
      estado: 'finalizado',
      resultado: 'RECHAZADA',
      rechazadoAt: ahora().minus({ days: 3 }),
      hasta: ahora().minus({ days: 3 }).plus({ hours: 360 }),
      captacionDateoId: dateo.id,
    })
    // Segunda vez finalizada (ayer, sin dateo) y otra activa hoy (sin dateo).
    await turnoDirecto(P.CONTINUIDAD, {
      fecha: ahora().minus({ days: 1 }),
      estado: 'finalizado',
      resultado: 'RECHAZADA',
      esSegundaVez: true,
      turnoOrigenId: origen.id,
    })
    assert.equal(
      await evaluarContinuidad({ placa: P.CONTINUIDAD, convenioId: convenio.id }),
      'CONTINUA'
    )

    // Turno de hoy sin dateo: como turno normal SÍ exige ticket (control)...
    const hoyTurno = await turnoDirecto(P.CONTINUIDAD)
    const sinDateo = await buscarTurnoSinDateoHoy(P.CONTINUIDAD, SERVICIO.RTM)
    assert.equal(sinDateo?.id, hoyTurno.id)
    // ...como segunda vez, no.
    await Database.from('turnos_rtms')
      .where('id', hoyTurno.id)
      .update({ es_segunda_vez: 1, turno_origen_id: origen.id })
    assert.isNull(await buscarTurnoSinDateoHoy(P.CONTINUIDAD, SERVICIO.RTM))

    const dateoHttp = await client
      .post('/api/captacion-dateos')
      .header('Authorization', `Bearer ${tokens.COMERCIAL}`)
      .json({ placa: P.CONTINUIDAD, canal: 'FACHADA', origen: 'UI', servicio_id: SERVICIO.RTM })
    console.log('--- dateo sobre segunda vez ---', dateoHttp.status(), dateoHttp.body()?.code)
    // Puede chocar con TURNO_ACTIVO (vehículo en sede, regla existente), pero no con REQUIERE_TICKET_DATEO.
    assert.notEqual(dateoHttp.body()?.code, 'REQUIERE_TICKET_DATEO')
  })

  // ───────────────────────── Turnero ─────────────────────────
  test('Turnero: segunda vez RTM activa sin facturación → certificacion; certificada → pendientes-llamar', async ({
    client,
    assert,
  }) => {
    const origen = await origenRechazado(P.TURNERO)
    const sv = await turnoDirecto(P.TURNERO, { esSegundaVez: true, turnoOrigenId: origen.id })
    const auth = { Authorization: `Bearer ${tokens.ADMIN}` }

    const cola1 = await client.get('/api/turnero/cola').headers(auth)
    cola1.assertStatus(200)
    const enCola1 = cola1.body().colaSeguimiento.find((t: any) => t.id === String(sv.id))
    assert.exists(enCola1)
    assert.equal(enCola1.estado, 'certificacion')

    // Etapas desde GET /turnos-rtm: Puerta + Certificación, chip esSegundaVez.
    const lista = await client
      .get('/api/turnos-rtm')
      .headers(auth)
      .qs({ placa: P.TURNERO, fecha: hoyISO() })
    const fila = (lista.body() as any[]).find((t) => t.id === sv.id)
    assert.deepEqual(fila.etapasRequeridasLista, ['puerta', 'certificacion'])
    assert.strictEqual(fila.esSegundaVez, true)

    const cert = await client
      .post('/api/certificaciones')
      .headers(auth)
      .field('turno_id', String(sv.id))
      .field('resultado', 'APROBADA')
      .file('imagen', imagenPath)
    cert.assertStatus(201)

    const lista2 = await client
      .get('/api/turnos-rtm')
      .headers(auth)
      .qs({ placa: P.TURNERO, fecha: hoyISO() })
    const fila2 = (lista2.body() as any[]).find((t) => t.id === sv.id)
    assert.equal(fila2.estadoVisual, 'finalizado') // no "incompleto: falta facturación"

    const pend = await client
      .get('/api/turnos-rtm/pendientes-llamar')
      .headers(auth)
      .qs({ usuarioId: ids.ADMIN.id })
    pend.assertStatus(200)
    assert.exists(pend.body().turnos.find((t: any) => t.id === sv.id))

    const cola2 = await client.get('/api/turnero/cola').headers(auth)
    const enCola2 = cola2.body().colaSeguimiento.find((t: any) => t.id === String(sv.id))
    assert.equal(enCola2.estado, 'por_llamar') // "Listo para entregar"
  })

  // ───────────────────────── Excepciones ─────────────────────────
  test('Excepciones: solo SUPER_ADMIN/GERENCIA y con motivo; NO_APLICADA crea turno normal', async ({
    client,
    assert,
  }) => {
    const origen = await origenRechazado(P.NO_APLICADA)

    const sinRol = await crearTurnoHttp(
      client,
      P.NO_APLICADA,
      { segundaVezExcepcion: 'NO_APLICADA', segundaVezMotivo: 'Cliente pide pagar' },
      { usuario: 'OPERATIVO' }
    )
    sinRol.assertStatus(403)
    sinRol.assertBodyContains({ code: 'SEGUNDA_VEZ_EXCEPCION_NO_AUTORIZADA' })

    const sinMotivo = await crearTurnoHttp(client, P.NO_APLICADA, {
      segundaVezExcepcion: 'NO_APLICADA',
      segundaVezMotivo: ' ',
    })
    sinMotivo.assertStatus(422)
    sinMotivo.assertBodyContains({ code: 'SEGUNDA_VEZ_MOTIVO_REQUERIDO' })

    const ok = await crearTurnoHttp(
      client,
      P.NO_APLICADA,
      { segundaVezExcepcion: 'NO_APLICADA', segundaVezMotivo: 'Cambio de vehículo de la flota' },
      { usuario: 'GERENCIA' }
    )
    ok.assertStatus(201)
    const t = await TurnoRtm.findOrFail(ok.body().id)
    assert.isFalse(Boolean(t.esSegundaVez))
    assert.equal(t.segundaVezExcepcion, 'NO_APLICADA')
    assert.equal(t.segundaVezExcepcionPorId, ids.GERENCIA.id)
    assert.equal(t.segundaVezExcepcionMotivo, 'Cambio de vehículo de la flota')
    assert.equal(t.turnoOrigenId, origen.id)
    const ev = await evaluarVentanaSegundaVez(P.NO_APLICADA, SERVICIO.RTM, DateTime.now())
    assert.equal(ev?.estado, 'SUPERADA')
  })

  test('Excepción FORZADA: segunda vez sobre una ventana vencida (SUPER_ADMIN)', async ({
    client,
    assert,
  }) => {
    const origen = await origenRechazado(P.FORZADA, {
      horas: 400,
      hasta: ahora().minus({ hours: 40 }).startOf('second'),
    })
    const sinForzar = await crearTurnoHttp(client, P.FORZADA, { segundaVezOrigenId: origen.id })
    sinForzar.assertStatus(409)
    sinForzar.assertBodyContains({
      code: 'SEGUNDA_VEZ_NO_DISPONIBLE',
      ventana: { estado: 'VENCIDA' },
    })

    const forzarSinRol = await crearTurnoHttp(
      client,
      P.FORZADA,
      {
        segundaVezOrigenId: origen.id,
        segundaVezExcepcion: 'FORZADA',
        segundaVezMotivo: 'Llegó un día tarde por pico y placa',
      },
      { usuario: 'OPERATIVO' }
    )
    forzarSinRol.assertStatus(403)

    const ok = await crearTurnoHttp(client, P.FORZADA, {
      segundaVezOrigenId: origen.id,
      segundaVezExcepcion: 'FORZADA',
      segundaVezMotivo: 'Llegó un día tarde por pico y placa',
    })
    ok.assertStatus(201)
    const t = await TurnoRtm.findOrFail(ok.body().id)
    assert.isTrue(Boolean(t.esSegundaVez))
    assert.equal(t.turnoOrigenId, origen.id)
    assert.equal(t.segundaVezExcepcion, 'FORZADA')
    assert.equal(t.segundaVezExcepcionPorId, ids.ADMIN.id)
    assert.isNull(t.captacionDateoId)
  })

  test('Búsqueda unificada devuelve ventanaSegundaVez (origen, hasta, horas restantes)', async ({
    client,
    assert,
  }) => {
    const r = await client
      .get('/api/buscar')
      .header('Authorization', `Bearer ${tokens.ADMIN}`)
      .qs({ placa: P.BORDE_DENTRO })
    r.assertStatus(200)
    const v = r.body().ventanaSegundaVez
    assert.exists(v)
    assert.equal(v.estado, 'ABIERTA')
    assert.equal(v.servicioCodigo, 'RTM')
    assert.isAbove(v.horasRestantes, 0)
    assert.isArray(r.body().ventanasSegundaVez)
  })
})
