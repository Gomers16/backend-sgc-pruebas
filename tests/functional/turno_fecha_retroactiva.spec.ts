import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Crear turno con fecha distinta de hoy (fecha_turno_service.ts):
// anterior solo SUPER_ADMIN/GERENCIA (403 al resto), futura 422 para todos,
// hoy igual que siempre. Escribe en la BD compartida: placas TST905–TST909,
// limpieza completa al final. Los roles se buscan por nombre (los ids
// cambian entre bases).
//
// turno_codigo va al segundo: se espera >1 s antes de cada creación por HTTP.

const SEDE_ID = 2
const ZONA = 'America/Bogota'

const P = {
  GERENCIA_AYER: 'TST905',
  ADMIN_AYER: 'TST906',
  OPERATIVO_AYER: 'TST907',
  OPERATIVO_HOY: 'TST908',
  FUTURA: 'TST909',
}

const esperarSegundo = () => new Promise((r) => setTimeout(r, 1100))

test.group('Turno con fecha retroactiva · regla de rol y fecha', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  const ids: Record<string, Usuario> = {}
  let servicioRtmId: number

  const ahora = () => DateTime.now().setZone(ZONA)
  const hoyISO = () => ahora().toISODate()!
  const ayerISO = () => ahora().minus({ days: 1 }).toISODate()!
  const mananaISO = () => ahora().plus({ days: 1 }).toISODate()!

  async function crearUsuario(clave: string, rolNombre: string) {
    const rol = await Database.from('roles').where('nombre', rolNombre).select('id').first()
    if (!rol) throw new Error(`No existe el rol ${rolNombre} en esta BD`)
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `FECHA-RETRO-${clave}`,
      correo: `test.fecha.retro.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: rol.id,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    ids[clave] = u
    tokens[clave] = tokenObj.value!.release()
  }

  async function crearTurnoHttp(client: any, placa: string, usuario: string, fecha: string) {
    await esperarSegundo()
    return client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${tokens[usuario]}`)
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: ids[usuario].id,
        fecha,
        horaIngreso: '08:15',
        servicioId: servicioRtmId,
      })
  }

  const turnosDePlaca = (placa: string) =>
    Database.from('turnos_rtms')
      .where('placa', placa)
      .select(
        'id',
        'sede_id',
        'turno_numero',
        'turno_numero_servicio',
        'estado',
        Database.raw("DATE_FORMAT(fecha, '%Y-%m-%d') AS fecha_iso")
      )

  /** Máximo turno_numero (> 0) de la sede en ese día, sin contar las placas del test. */
  async function maxNumeroDelDia(fechaISO: string) {
    const r = await Database.from('turnos_rtms')
      .where('sede_id', SEDE_ID)
      .where('fecha', fechaISO)
      .where('turno_numero', '>', 0)
      .max('turno_numero as max')
      .first()
    return Number(r?.max ?? 0)
  }

  group.setup(async () => {
    const rtm = await Database.from('servicios')
      .where('codigo_servicio', 'RTM')
      .select('id')
      .first()
    servicioRtmId = rtm.id
    await crearUsuario('ADMIN', 'SUPER_ADMIN')
    await crearUsuario('GERENCIA', 'GERENCIA')
    await crearUsuario('OPERATIVO', 'OPERATIVO_TURNOS')
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const marks = placas.map(() => '?').join(',')
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM prospectos WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, placas)
    for (const u of usuarios) await u.delete()
  })

  test('GERENCIA con fecha de ayer → 201, turno con esa fecha y numerado dentro de ese día', async ({
    client,
    assert,
  }) => {
    const ayer = ayerISO()
    const maxAntes = await maxNumeroDelDia(ayer)
    const res = await crearTurnoHttp(client, P.GERENCIA_AYER, 'GERENCIA', ayer)
    res.assertStatus(201)

    const filas = await turnosDePlaca(P.GERENCIA_AYER)
    assert.lengthOf(filas, 1)
    assert.equal(filas[0].fecha_iso, ayer)
    assert.equal(filas[0].sede_id, SEDE_ID)
    assert.equal(filas[0].estado, 'activo')
    assert.isAbove(Number(filas[0].turno_numero), maxAntes)
    assert.isAbove(Number(filas[0].turno_numero_servicio), 0)
  })

  test('SUPER_ADMIN con fecha de ayer → 201', async ({ client, assert }) => {
    const ayer = ayerISO()
    const res = await crearTurnoHttp(client, P.ADMIN_AYER, 'ADMIN', ayer)
    res.assertStatus(201)
    const filas = await turnosDePlaca(P.ADMIN_AYER)
    assert.lengthOf(filas, 1)
    assert.equal(filas[0].fecha_iso, ayer)
  })

  test('OPERATIVO_TURNOS con fecha de ayer → 403 y no crea nada', async ({ client, assert }) => {
    const res = await crearTurnoHttp(client, P.OPERATIVO_AYER, 'OPERATIVO', ayerISO())
    res.assertStatus(403)
    assert.equal(res.body().code, 'FECHA_RETROACTIVA_NO_AUTORIZADA')
    assert.lengthOf(await turnosDePlaca(P.OPERATIVO_AYER), 0)
  })

  test('OPERATIVO_TURNOS con fecha de hoy → 201, igual que siempre', async ({ client, assert }) => {
    const res = await crearTurnoHttp(client, P.OPERATIVO_HOY, 'OPERATIVO', hoyISO())
    res.assertStatus(201)
    const filas = await turnosDePlaca(P.OPERATIVO_HOY)
    assert.lengthOf(filas, 1)
    assert.equal(filas[0].fecha_iso, hoyISO())
  })

  test('fecha de mañana → 422 FECHA_FUTURA para GERENCIA, SUPER_ADMIN y OPERATIVO_TURNOS', async ({
    client,
    assert,
  }) => {
    for (const usuario of ['GERENCIA', 'ADMIN', 'OPERATIVO']) {
      const res = await crearTurnoHttp(client, P.FUTURA, usuario, mananaISO())
      res.assertStatus(422)
      assert.equal(res.body().code, 'FECHA_FUTURA')
    }
    assert.lengthOf(await turnosDePlaca(P.FUTURA), 0)
  })
})
