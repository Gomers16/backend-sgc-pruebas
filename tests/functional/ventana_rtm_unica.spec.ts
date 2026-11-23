import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import { DIAS_VENTANA_PRE_VENCIMIENTO, vigenciaRtm } from '#services/ventana_rtm_service'

// Ventana previa única de 16 días (decisión 2026-11-23): verificar-placa,
// store() de dateos y cola/avisos de Telemercadeo. El borde del turno está en
// window_block_confirmable.spec.ts. Placas VTU1**.

const SEDE_ID = 3
const ZONA = 'America/Bogota'
const PLACA_16 = 'VTU116'
const PLACA_17 = 'VTU117'

test.group('Ventana RTM única de 16 días', (group) => {
  let admin: Usuario
  let token = ''
  let rtmId = 0
  const envAntes = process.env.DIAS_VENTANA_PRE_RTM
  const auth = () => ({ Authorization: `Bearer ${token}` })

  const limpiar = async () => {
    await Database.from('turnos_rtms').where('placa', 'like', 'VTU1%').delete()
    await Database.from('captacion_dateos').where('placa', 'like', 'VTU1%').delete()
    await Database.from('prospectos').where('placa', 'like', 'VTU1%').delete()
  }

  /** Turno RTM finalizado cuyo vencimiento es exactamente hoy + dias. */
  async function finalizado(placa: string, dias: number, n: number) {
    const vence = DateTime.now().setZone(ZONA).startOf('day').plus({ days: dias })
    await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: rtmId,
      fecha: vence.minus({ months: 12 }),
      horaIngreso: '08:00',
      turnoNumero: -(97000 + n),
      turnoNumeroServicio: -(97000 + n),
      turnoCodigo: `TST-VTU-${placa}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
      tieneFacturacion: false,
      esSegundaVez: false,
    } as any)
  }

  group.setup(async () => {
    // Valor de producción local: no debe tener ningún efecto.
    process.env.DIAS_VENTANA_PRE_RTM = '5'
    await limpiar()
    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'VTU',
      correo: `test.vtu.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: 9,
      sedeId: SEDE_ID,
    } as any)
    token = (await Usuario.accessTokens.create(admin)).value!.release()
    rtmId = (await Database.from('servicios').where('codigo_servicio', 'RTM').first()).id
    await finalizado(PLACA_16, 16, 1)
    await finalizado(PLACA_17, 17, 2)
  })

  group.teardown(async () => {
    if (envAntes === undefined) delete process.env.DIAS_VENTANA_PRE_RTM
    else process.env.DIAS_VENTANA_PRE_RTM = envAntes
    await limpiar()
    await admin.delete()
  })

  test('la constante es 16 y la variable de entorno no la cambia', async ({ assert }) => {
    assert.equal(DIAS_VENTANA_PRE_VENCIMIENTO, 16)
    const v = vigenciaRtm('2026-01-31')
    assert.equal(v.venceEl.diff(v.puedeDatearDesde, 'days').days, 16)
  })

  test('verificar-placa: a 16 días dentro de ventana, a 17 fuera', async ({ client, assert }) => {
    for (const [placa, dentro] of [
      [PLACA_16, true],
      [PLACA_17, false],
    ] as const) {
      const r = await client
        .get('/api/captacion-dateos/verificar-placa')
        .headers(auth())
        .qs({ placa })
      r.assertStatus(200)
      assert.isTrue(r.body().rtm_vigente)
      assert.equal(r.body().dentro_de_ventana, dentro, placa)
    }
  })

  test('store() de dateos: a 17 días bloquea, a 16 días deja datear', async ({
    client,
    assert,
  }) => {
    const datear = (placa: string, telefono: string) =>
      client
        .post('/api/captacion-dateos')
        .headers(auth())
        .json({ origen: 'UI', canal: 'FACHADA', placa, telefono, servicio_id: rtmId })
    const bloqueado = await datear(PLACA_17, '3991440017')
    bloqueado.assertStatus(409)
    assert.equal(bloqueado.body().code, 'RTM_VIGENTE_EXCEPCION_DISPONIBLE')
    assert.equal(bloqueado.body().diasExcedidos, 1)
    const ok = await datear(PLACA_16, '3991440016')
    ok.assertStatus(201)
  })
})
