import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'

// Súper Informe → sección 8 "Resumen contable RTM y servicios"
// (resumen_contable_service). Siembra turnos en días aislados (mayo 2032)
// y comprueba por HTTP: motos y livianos, RECHAZADA/APROBADA/sin resultado,
// segunda vez incluida (solo separada en RTM), cancelados, inactivos y
// placas TST excluidos, rango de varios días = suma de los días, denominador
// 0 y el PDF con la sección nueva. Placas GZR8xx (no TST: el reporte excluye
// TST) + una TST para verificar la exclusión. Limpieza completa.

const D1 = '2032-05-10'
const D2 = '2032-05-11'
const D3 = '2032-05-12'
const FUERA = '2032-05-13'
const SOLO_SV = '2032-05-14'
const SEDE_ID = 2
const ROL_SUPER_ADMIN = 9
const SERVICIO = { RTM: 1, PREV: 2, PERI: 3, SOAT: 4 }

const PLACAS = [
  'GZR801',
  'GZR802',
  'GZR803',
  'GZR804',
  'GZR805',
  'GZR806',
  'GZR807',
  'GZR808',
  'GZR809',
  'GZR810',
  'GZR811',
  'GZR812',
  'TSTRC1',
]

test.group('Súper Informe · resumen contable RTM y servicios', (group) => {
  group.each.timeout(60_000)

  let admin: Usuario
  let token = ''
  let numero = 0
  const auth = () => ({ Authorization: `Bearer ${token}` })

  async function turno(
    placa: string,
    fecha: string,
    o: {
      servicio?: keyof typeof SERVICIO
      tipo?: string
      estado?: string
      resultado?: 'APROBADA' | 'RECHAZADA' | null
      esSegundaVez?: boolean
      turnoOrigenId?: number | null
    } = {}
  ) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO[o.servicio ?? 'RTM'],
      fecha: DateTime.fromISO(`${fecha}T09:00:00`, { zone: 'America/Bogota' }),
      horaIngreso: '08:00',
      turnoNumero: -(9200 + numero),
      turnoNumeroServicio: -(9200 + numero),
      turnoCodigo: `GZR-RC-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: o.tipo ?? 'Liviano Particular',
      estado: o.estado ?? 'finalizado',
      resultadoCertificacion: o.resultado ?? null,
      esSegundaVez: o.esSegundaVez ?? false,
      turnoOrigenId: o.turnoOrigenId ?? null,
    } as any)
  }

  group.setup(async () => {
    const previos = await Database.from('turnos_rtms').whereIn('placa', PLACAS).count('* as n')
    if (Number(previos[0].n) > 0) throw new Error('Placas GZR8xx/TSTRC1 ya existen: no se siembra.')
    const enRango = await Database.from('turnos_rtms')
      .whereBetween('fecha', [D1, SOLO_SV])
      .count('* as n')
    if (Number(enRango[0].n) > 0) throw new Error('Ya hay turnos en mayo 2032: no se siembra.')

    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'RESUMEN-CONTABLE',
      correo: `test.resumen.contable.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(admin)
    token = tokenObj.value!.release()

    // D1: RTM liviano aprobada y rechazada (origen de la segunda vez), SOAT moto.
    await turno('GZR801', D1, { resultado: 'APROBADA' })
    const origen = await turno('GZR802', D1, { resultado: 'RECHAZADA' })
    await turno('GZR803', D1, { servicio: 'SOAT', tipo: 'Motocicleta' })
    // D2: RTM moto rechazada, RTM moto activo sin resultado, PREV taxi.
    await turno('GZR804', D2, { tipo: 'Motocicleta', resultado: 'RECHAZADA' })
    await turno('GZR805', D2, { tipo: 'Motocicleta', estado: 'activo' })
    await turno('GZR806', D2, { servicio: 'PREV', tipo: 'Liviano Taxi' })
    // D3: segunda vez aprobada (incluida), cancelado, inactivo y TST (excluidos).
    await turno('GZR802', D3, {
      resultado: 'APROBADA',
      esSegundaVez: true,
      turnoOrigenId: origen.id,
    })
    await turno('GZR807', D3, { estado: 'cancelado', resultado: 'RECHAZADA' })
    await turno('GZR808', D3, { servicio: 'PERI', estado: 'inactivo' })
    await turno('TSTRC1', D3, { resultado: 'RECHAZADA' })
    // Fuera del rango D1..D3.
    await turno('GZR809', FUERA, { resultado: 'RECHAZADA' })
    // Día con solo una segunda vez sin resultado (denominadores 0).
    const origen2 = await turno('GZR810', FUERA, { resultado: 'RECHAZADA' })
    await turno('GZR810', SOLO_SV, {
      esSegundaVez: true,
      turnoOrigenId: origen2.id,
      estado: 'activo',
    })
  })

  group.teardown(async () => {
    await Database.from('turnos_rtms')
      .whereIn('placa', PLACAS)
      .orderBy('es_segunda_vez', 'desc')
      .delete()
    if (admin) await admin.delete()
  })

  const resumen = async (client: any, fi: string, ff: string) => {
    const r = await client
      .get('/api/reportes-admin/super-informe/resumen-contable')
      .headers(auth())
      .qs({ fecha_inicio: fi, fecha_fin: ff })
    r.assertStatus(200)
    return r.body()
  }
  const porClave = (body: any) =>
    Object.fromEntries(
      body.filas.map((f: any) => [
        f.clave,
        { motos: f.motos, livianos: f.livianos, otros: f.otros, total: f.total },
      ])
    )

  test('rango de varios días: motos/livianos, segunda vez incluida, excluidos cancelado/inactivo/TST', async ({
    client,
    assert,
  }) => {
    const body = await resumen(client, D1, D3)
    assert.equal(body.fecha_inicio, D1)
    assert.equal(body.fecha_fin, D3)
    assert.deepEqual(porClave(body), {
      RTM_PRIMERA: { motos: 2, livianos: 2, otros: 0, total: 4 },
      RTM_SEGUNDA: { motos: 0, livianos: 1, otros: 0, total: 1 },
      RTM_TOTAL: { motos: 2, livianos: 3, otros: 0, total: 5 },
      SOAT: { motos: 1, livianos: 0, otros: 0, total: 1 },
      PREV: { motos: 0, livianos: 1, otros: 0, total: 1 },
      PERI: { motos: 0, livianos: 0, otros: 0, total: 0 },
      TOTAL: { motos: 3, livianos: 4, otros: 0, total: 7 },
    })
    assert.deepEqual(
      body.filas.map((f: any) => f.tipo),
      ['detalle', 'detalle', 'subtotal', 'detalle', 'detalle', 'detalle', 'total']
    )
    assert.equal(body.rechazo.primera_vez.aprobadas, 1)
    assert.equal(body.rechazo.primera_vez.rechazadas, 2)
    assert.equal(body.rechazo.primera_vez.sin_resultado, 1)
    assert.closeTo(body.rechazo.primera_vez.porcentaje, 200 / 3, 1e-9)
    assert.deepEqual(body.rechazo.segunda_vez, {
      aprobadas: 1,
      rechazadas: 0,
      sin_resultado: 0,
      porcentaje: 0,
    })
    assert.equal(body.sin_finalizar, 1)
  })

  test('el rango suma lo mismo que los días sueltos (equivalente a Turnos del Día)', async ({
    client,
    assert,
  }) => {
    const rango = porClave(await resumen(client, D1, D3))
    const dias = await Promise.all(
      [D1, D2, D3].map(async (d) => porClave(await resumen(client, d, d)))
    )
    for (const clave of Object.keys(rango)) {
      for (const g of ['motos', 'livianos', 'otros', 'total'] as const) {
        assert.equal(
          dias.reduce((a, d) => a + d[clave][g], 0),
          rango[clave][g],
          `${clave}.${g}`
        )
      }
    }
  })

  test('denominador 0: solo una segunda vez sin resultado → % null', async ({ client, assert }) => {
    const body = await resumen(client, SOLO_SV, SOLO_SV)
    assert.deepEqual(body.rechazo.primera_vez, {
      aprobadas: 0,
      rechazadas: 0,
      sin_resultado: 0,
      porcentaje: null,
    })
    assert.deepEqual(body.rechazo.segunda_vez, {
      aprobadas: 0,
      rechazadas: 0,
      sin_resultado: 1,
      porcentaje: null,
    })
    assert.equal(porClave(body).RTM_SEGUNDA.total, 1)
    assert.equal(body.sin_finalizar, 1)
  })

  test('valida el rango de fechas', async ({ client }) => {
    const r = await client.get('/api/reportes-admin/super-informe/resumen-contable').headers(auth())
    r.assertStatus(400)
    const r2 = await client
      .get('/api/reportes-admin/super-informe/resumen-contable')
      .headers(auth())
      .qs({ fecha_inicio: D3, fecha_fin: D1 })
    r2.assertStatus(400)
  })

  test('el PDF del Súper Informe se genera con la sección 8', async ({ assert }) => {
    const qs = new URLSearchParams({ fecha_inicio: D1, fecha_fin: D3 })
    const r = await fetch(
      `http://${process.env.HOST}:${process.env.PORT}/api/reportes-admin/super-informe/pdf?${qs}`,
      { headers: auth() }
    )
    assert.equal(r.status, 200)
    const buf = Buffer.from(await r.arrayBuffer())
    assert.equal(buf.subarray(0, 4).toString(), '%PDF')
  })
})
