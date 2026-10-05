import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Database from '@adonisjs/lucid/services/db'

// "Segunda vez" — Entrega A: un RTM certificado RECHAZADO no da vigencia,
// así que no dispara WINDOW_BLOCK (crear turno) ni RTM_VIGENTE /
// RTM_VIGENTE_EXCEPCION_DISPONIBLE (crear dateo). APROBADA y NULL (histórico)
// siguen bloqueando como antes. Escribe en la BD compartida: placas
// TST940–TST945, limpieza completa al final.

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN_ID = 9
const ROL_COMERCIAL_ID = 11

const PLACAS = {
  TURNO_RECHAZADO: 'TST940',
  TURNO_APROBADO: 'TST941',
  TURNO_NULL: 'TST942',
  DATEO_RECHAZADO: 'TST943',
  DATEO_APROBADO: 'TST944',
  DATEO_NULL: 'TST945',
}

const CODIGOS_RTM_VIGENTE = ['RTM_VIGENTE', 'RTM_VIGENTE_EXCEPCION_DISPONIBLE']

test.group('Segunda vez · vigencia: RECHAZADO no bloquea', (group) => {
  let superAdmin: Usuario
  let comercial: Usuario
  let tokenAdmin: string
  let tokenComercial: string
  let hoy: DateTime

  async function crearRtmFinalizado(placa: string, resultado: 'APROBADA' | 'RECHAZADA' | null) {
    const fecha = hoy.minus({ days: 3 })
    await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: superAdmin.id,
      servicioId: SERVICIO_RTM_ID,
      fecha,
      horaIngreso: '08:00',
      horaSalida: '09:00',
      tieneFacturacion: true,
      turnoNumero: -(9000 + Number(placa.slice(3))),
      turnoNumeroServicio: -(9000 + Number(placa.slice(3))),
      turnoCodigo: `TST-SV-VIG-${placa}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
      resultadoCertificacion: resultado,
      rechazadoAt: resultado === 'RECHAZADA' ? fecha.set({ hour: 9 }) : null,
      ventanaSegundaVezHasta:
        resultado === 'RECHAZADA' ? fecha.set({ hour: 9 }).plus({ hours: 360 }) : null,
    } as any)
  }

  function crearTurno(client: any, placa: string) {
    return client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${tokenAdmin}`)
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: superAdmin.id,
        fecha: hoy.toISODate(),
        horaIngreso: DateTime.local().setZone('America/Bogota').toFormat('HH:mm:ss'),
        servicioId: SERVICIO_RTM_ID,
      })
  }

  function crearDateo(client: any, token: string, placa: string) {
    return client
      .post('/api/captacion-dateos')
      .header('Authorization', `Bearer ${token}`)
      .json({ placa, canal: 'FACHADA', origen: 'UI', servicio_id: SERVICIO_RTM_ID })
  }

  group.setup(async () => {
    hoy = DateTime.local().setZone('America/Bogota')
    superAdmin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'SEGUNDA-VEZ-VIG-ADMIN',
      correo: `test.segunda.vez.vig.admin.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    comercial = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'SEGUNDA-VEZ-VIG-COMERCIAL',
      correo: `test.segunda.vez.vig.comercial.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_COMERCIAL_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenAdminObj = await Usuario.accessTokens.create(superAdmin)
    const tokenComercialObj = await Usuario.accessTokens.create(comercial)
    tokenAdmin = tokenAdminObj.value!.release()
    tokenComercial = tokenComercialObj.value!.release()

    await crearRtmFinalizado(PLACAS.TURNO_RECHAZADO, 'RECHAZADA')
    await crearRtmFinalizado(PLACAS.TURNO_APROBADO, 'APROBADA')
    await crearRtmFinalizado(PLACAS.TURNO_NULL, null)
    await crearRtmFinalizado(PLACAS.DATEO_RECHAZADO, 'RECHAZADA')
    await crearRtmFinalizado(PLACAS.DATEO_APROBADO, 'APROBADA')
    await crearRtmFinalizado(PLACAS.DATEO_NULL, null)
  })

  group.teardown(async () => {
    const placas = Object.values(PLACAS)
    const marks = placas.map(() => '?').join(',')
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, placas)
    if (superAdmin) await superAdmin.delete()
    if (comercial) await comercial.delete()
  })

  // ── Crear turno (WINDOW_BLOCK)
  test('RTM RECHAZADO finalizado NO dispara WINDOW_BLOCK al crear turno', async ({
    client,
    assert,
  }) => {
    const res = await crearTurno(client, PLACAS.TURNO_RECHAZADO)
    console.log('--- turno RECHAZADO ---', res.status(), JSON.stringify(res.body()).slice(0, 300))
    assert.notEqual(res.body()?.code, 'WINDOW_BLOCK')
    res.assertStatus(201)
  })

  test('RTM APROBADO finalizado SÍ dispara WINDOW_BLOCK (regresión)', async ({ client }) => {
    const res = await crearTurno(client, PLACAS.TURNO_APROBADO)
    res.assertStatus(409)
    res.assertBodyContains({ code: 'WINDOW_BLOCK' })
  })

  test('RTM con resultado NULL (histórico) SÍ dispara WINDOW_BLOCK (regresión)', async ({
    client,
  }) => {
    const res = await crearTurno(client, PLACAS.TURNO_NULL)
    res.assertStatus(409)
    res.assertBodyContains({ code: 'WINDOW_BLOCK' })
  })

  // ── Crear dateo (RTM_VIGENTE)
  test('RTM RECHAZADO NO dispara RTM_VIGENTE al crear dateo (COMERCIAL)', async ({
    client,
    assert,
  }) => {
    const res = await crearDateo(client, tokenComercial, PLACAS.DATEO_RECHAZADO)
    console.log('--- dateo RECHAZADO ---', res.status(), JSON.stringify(res.body()).slice(0, 300))
    assert.notInclude(CODIGOS_RTM_VIGENTE, res.body()?.code)
    res.assertStatus(201)
  })

  test('RTM APROBADO SÍ dispara RTM_VIGENTE (COMERCIAL) y la excepción (SUPER_ADMIN)', async ({
    client,
  }) => {
    const resCom = await crearDateo(client, tokenComercial, PLACAS.DATEO_APROBADO)
    resCom.assertStatus(409)
    resCom.assertBodyContains({ code: 'RTM_VIGENTE' })

    const resAdm = await crearDateo(client, tokenAdmin, PLACAS.DATEO_APROBADO)
    resAdm.assertStatus(409)
    resAdm.assertBodyContains({ code: 'RTM_VIGENTE_EXCEPCION_DISPONIBLE' })
  })

  test('RTM con resultado NULL SÍ dispara RTM_VIGENTE (regresión)', async ({ client }) => {
    const res = await crearDateo(client, tokenComercial, PLACAS.DATEO_NULL)
    res.assertStatus(409)
    res.assertBodyContains({ code: 'RTM_VIGENTE' })
  })

  // ── GET /turnos-rtm serializa resultadoCertificacion (camelCase): de eso
  // depende el filtro de refreshAlertaVentanaServicio() en CrearTurno.vue.
  test('GET /turnos-rtm devuelve resultadoCertificacion en camelCase', async ({
    client,
    assert,
  }) => {
    const casos: Array<[string, string | null]> = [
      [PLACAS.TURNO_RECHAZADO, 'RECHAZADA'],
      [PLACAS.TURNO_APROBADO, 'APROBADA'],
      [PLACAS.TURNO_NULL, null],
    ]
    for (const [placa, esperado] of casos) {
      // Mismos parámetros que CrearTurno.vue
      const res = await client
        .get('/api/turnos-rtm')
        .header('Authorization', `Bearer ${tokenAdmin}`)
        .qs({ placa, servicioId: SERVICIO_RTM_ID, estado: 'finalizado', perPage: 20, page: 1 })
      res.assertStatus(200)
      const fila = (res.body() as any[]).find((t) => t.placa === placa)
      assert.exists(fila, `placa ${placa}`)
      assert.property(fila, 'resultadoCertificacion')
      assert.notProperty(fila, 'resultado_certificacion')
      assert.strictEqual(fila.resultadoCertificacion, esperado, `placa ${placa}`)
    }
  })

  // ── Pre-chequeo de la UI de dateos (GET verificar-placa)
  test('verificar-placa: RECHAZADO → rtm_vigente=false; APROBADO/NULL → true', async ({
    client,
    assert,
  }) => {
    const casos: Array<[string, boolean]> = [
      [PLACAS.TURNO_RECHAZADO, false],
      [PLACAS.TURNO_APROBADO, true],
      [PLACAS.TURNO_NULL, true],
    ]
    for (const [placa, esperado] of casos) {
      const res = await client
        .get('/api/captacion-dateos/verificar-placa')
        .header('Authorization', `Bearer ${tokenAdmin}`)
        .qs({ placa })
      res.assertStatus(200)
      assert.equal(res.body().rtm_vigente, esperado, `placa ${placa}`)
    }
  })
})
