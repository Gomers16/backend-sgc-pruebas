import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'

// "Segunda vez" — Entrega B2 (migración 1792000000000): dedupe_key incluye
// es_segunda_vez y segunda_vez_origen_activo tiene índice único. La segunda
// vez se puede crear el mismo día del rechazo; sigue habiendo una sola
// segunda vez activa por origen (también en BD) y un turno normal duplicado
// el mismo día sigue bloqueado. Escribe en la BD compartida: placas
// TST970–TST974, limpieza completa al final.

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN_ID = 9
const ZONA = 'America/Bogota'

const P = {
  MISMO_DIA: 'TST970',
  NORMAL_DUPLICADO: 'TST971',
  BD_DIRECTO: 'TST972',
  UPDATE_SV: 'TST973',
  UPDATE_NORMAL: 'TST974',
}

const esperarSegundo = () => new Promise((r) => setTimeout(r, 1100))

test.group('Segunda vez · mismo día (B2)', (group) => {
  group.each.timeout(60_000)

  let usuario: Usuario
  let token: string
  let numero = 0
  const ahora = () => DateTime.now().setZone(ZONA)

  async function turnoDirecto(placa: string, o: Record<string, unknown> = {}) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuario.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: ahora(),
      horaIngreso: '08:00',
      tieneFacturacion: false,
      turnoNumero: -(9700 + numero),
      turnoNumeroServicio: -(9700 + numero),
      turnoCodigo: `TST-SVB2-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      ...o,
    } as any)
  }

  /** Origen RTM rechazado HOY (hace 1 h), ventana abierta. */
  async function origenRechazadoHoy(placa: string) {
    const rechazadoAt = ahora().minus({ hours: 1 }).startOf('second')
    return turnoDirecto(placa, {
      estado: 'finalizado',
      horaSalida: '09:00:00',
      resultadoCertificacion: 'RECHAZADA',
      rechazadoAt,
      ventanaSegundaVezHasta: rechazadoAt.plus({ hours: 360 }),
    })
  }

  async function crearTurnoHttp(client: any, placa: string, extra: Record<string, unknown> = {}) {
    await esperarSegundo()
    return client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuario.id,
        fecha: ahora().toISODate(),
        horaIngreso: ahora().toFormat('HH:mm:ss'),
        servicioId: SERVICIO_RTM_ID,
        ...extra,
      })
  }

  async function errorAlCrear(fn: () => Promise<unknown>): Promise<string> {
    try {
      await fn()
      return 'SIN_ERROR'
    } catch (e: any) {
      return `${e?.code} ${e?.sqlMessage ?? e?.message}`
    }
  }

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'SV-B2',
      correo: `test.sv.b2.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuario)
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
    if (usuario) await usuario.delete()
  })

  test('Esquema: dedupe_key incluye es_segunda_vez y existe uq_segunda_vez_origen_activo', async ({
    assert,
  }) => {
    const cols = await Database.rawQuery(
      `SELECT column_name AS c, generation_expression AS g FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = 'turnos_rtms'
         AND column_name IN ('dedupe_key', 'segunda_vez_origen_activo')`
    )
    const porNombre = Object.fromEntries(cols[0].map((r: any) => [r.c, r.g]))
    assert.include(porNombre.dedupe_key, 'es_segunda_vez')
    assert.include(porNombre.segunda_vez_origen_activo, 'turno_origen_id')
    const idx = await Database.rawQuery(
      `SELECT index_name AS i FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = 'turnos_rtms' AND non_unique = 0
         AND index_name IN ('uq_turno_activo_por_placa_servicio_dia', 'uq_segunda_vez_origen_activo')`
    )
    assert.sameMembers(
      [...new Set(idx[0].map((r: any) => r.i))],
      ['uq_turno_activo_por_placa_servicio_dia', 'uq_segunda_vez_origen_activo']
    )
  })

  test('Segunda vez el mismo día: se crea; otra sobre el mismo origen falla; cancelarla libera el índice', async ({
    client,
    assert,
  }) => {
    const origen = await origenRechazadoHoy(P.MISMO_DIA)

    const r1 = await crearTurnoHttp(client, P.MISMO_DIA, { segundaVezOrigenId: origen.id })
    r1.assertStatus(201)
    const sv1 = await TurnoRtm.findOrFail(r1.body().id)
    assert.isTrue(Boolean(sv1.esSegundaVez))
    assert.equal((sv1.fecha as DateTime).toISODate(), (origen.fecha as DateTime).toISODate())

    // Segunda confirmación sobre el mismo origen → 409 (ventana USADA).
    const r2 = await crearTurnoHttp(client, P.MISMO_DIA, { segundaVezOrigenId: origen.id })
    r2.assertStatus(409)
    r2.assertBodyContains({ code: 'SEGUNDA_VEZ_NO_DISPONIBLE', ventana: { estado: 'USADA' } })

    // Un turno normal ese mismo día tampoco: DUPLICATE_DAY (origen + segunda vez).
    const r3 = await crearTurnoHttp(client, P.MISMO_DIA)
    r3.assertStatus(409)
    r3.assertBodyContains({ code: 'DUPLICATE_DAY' })

    // En BD: otra segunda vez activa del mismo origen (otro día, para que
    // dedupe_key no intervenga) choca con uq_segunda_vez_origen_activo.
    const err = await errorAlCrear(() =>
      turnoDirecto(P.MISMO_DIA, {
        fecha: ahora().plus({ days: 1 }),
        esSegundaVez: true,
        turnoOrigenId: origen.id,
      })
    )
    assert.include(err, 'ER_DUP_ENTRY')
    assert.include(err, 'uq_segunda_vez_origen_activo')

    // Cancelar la segunda vez libera el índice y reabre la ventana.
    const cancelar = await client
      .patch(`/api/turnos-rtm/${sv1.id}/cancelar`)
      .header('Authorization', `Bearer ${token}`)
      .json({ usuarioId: usuario.id, motivoCancelacion: 'Prueba B2 liberar índice' })
    cancelar.assertStatus(200)
    const fila = await Database.from('turnos_rtms')
      .where('id', sv1.id)
      .select('segunda_vez_origen_activo', 'dedupe_key')
      .first()
    assert.isNull(fila.segunda_vez_origen_activo)
    assert.isNull(fila.dedupe_key)

    const r4 = await crearTurnoHttp(client, P.MISMO_DIA, { segundaVezOrigenId: origen.id })
    r4.assertStatus(201)
    const activas = await TurnoRtm.query()
      .where('es_segunda_vez', 1)
      .where('turno_origen_id', origen.id)
      .whereNot('estado', 'cancelado')
    assert.lengthOf(activas, 1)
  })

  test('Turno normal duplicado el mismo día sigue bloqueado (HTTP y BD)', async ({
    client,
    assert,
  }) => {
    const r1 = await crearTurnoHttp(client, P.NORMAL_DUPLICADO)
    r1.assertStatus(201)
    const r2 = await crearTurnoHttp(client, P.NORMAL_DUPLICADO)
    r2.assertStatus(409)
    r2.assertBodyContains({ code: 'DUPLICATE_DAY' })

    await turnoDirecto(P.BD_DIRECTO)
    const err = await errorAlCrear(() => turnoDirecto(P.BD_DIRECTO))
    assert.include(err, 'ER_DUP_ENTRY')
    assert.include(err, 'uq_turno_activo_por_placa_servicio_dia')

    // Una segunda vez (es_segunda_vez=1) sí convive con el normal del mismo día.
    const sv = await turnoDirecto(P.BD_DIRECTO, { esSegundaVez: true, turnoOrigenId: null })
    assert.exists(sv.id)
    // Pero no dos segundas veces el mismo día/sede/servicio/placa.
    const err2 = await errorAlCrear(() =>
      turnoDirecto(P.BD_DIRECTO, { esSegundaVez: true, turnoOrigenId: null })
    )
    assert.include(err2, 'uq_turno_activo_por_placa_servicio_dia')
  })

  test('update(): un turno normal editado para chocar con una segunda vez del mismo día → 409 detallado y no se guarda', async ({
    client,
    assert,
  }) => {
    // Con B2 la BD admitiría el choque (es_segunda_vez distinto): lo frena el
    // chequeo previo de update(), que ahora sí corta la ejecución.
    const sv = await turnoDirecto(P.UPDATE_SV, { esSegundaVez: true, turnoOrigenId: null })
    const normal = await turnoDirecto(P.UPDATE_NORMAL)

    const res = await client
      .put(`/api/turnos-rtm/${normal.id}`)
      .header('Authorization', `Bearer ${token}`)
      .json({ usuarioId: usuario.id, placa: P.UPDATE_SV })
    res.assertStatus(409)
    res.assertBodyContains({
      code: 'DUPLICATE_DAY',
      conflictoConTurnoId: sv.id,
      conflictoConTurnoCodigo: sv.turnoCodigo,
    })
    assert.include(res.body().message, sv.turnoCodigo)

    const recargado = await TurnoRtm.findOrFail(normal.id)
    assert.equal(recargado.placa, P.UPDATE_NORMAL, 'el cambio de placa no se guardó')
  })
})
