import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Certificacion from '#models/certificacion'

// "Segunda vez" — Entrega C2, parte 2: GET /reportes-admin/segunda-vez.
// Un caso sembrado por cada estado de ventana; el reporte debe cuadrar.
// El reporte excluye placas TST% (como los demás), así que aquí se usan
// placas ZSV91x, filtradas con placa=ZSV91 para aislarlas. Escribe en la BD
// compartida solo mientras corre; limpieza completa al final.

const SEDE_ID = 2
const SERVICIO = { RTM: 1, PREV: 2 } as const
const ROL = { SUPER_ADMIN: 9, COMERCIAL: 11, CONTABILIDAD: 12 }
const ZONA = 'America/Bogota'

const P = {
  ABIERTA: 'ZSV911',
  USADA: 'ZSV912',
  VENCIDA: 'ZSV913',
  SUPERADA: 'ZSV914',
  ANULADA_CANCELADO: 'ZSV915',
  ANULADA_CORREGIDO: 'ZSV916',
}

test.group('Segunda vez · reporte (C2)', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  let admin: Usuario
  let numero = 0
  const ahora = () => DateTime.now().setZone(ZONA)
  const hoy = () => ahora().startOf('day')

  async function crearUsuario(clave: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `SV-C2-REP-${clave}`,
      correo: `test.sv.c2.rep.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    tokens[clave] = tokenObj.value!.release()
    return u
  }

  async function turno(placa: string, o: Record<string, unknown>) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO.RTM,
      horaIngreso: '08:00',
      tieneFacturacion: true,
      turnoNumero: -(9400 + numero),
      turnoNumeroServicio: -(9400 + numero),
      turnoCodigo: `TST-SV-C2-REP-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
      horaSalida: '09:00:00',
      certificacionFuncionarioId: admin.id,
      ...o,
    } as any)
  }

  /** Origen rechazado: rechazado_at dado, ventana +360 h, fecha = día del rechazo. */
  async function origen(placa: string, rechazadoAt: DateTime, o: Record<string, unknown> = {}) {
    const t = await turno(placa, {
      fecha: rechazadoAt,
      resultadoCertificacion: 'RECHAZADA',
      rechazadoAt,
      ventanaSegundaVezHasta: rechazadoAt.plus({ hours: 360 }),
      ...o,
    })
    await Certificacion.create({
      turnoId: t.id,
      usuarioId: admin.id,
      imagenPath: 'uploads/certificaciones/tst_inexistente.png',
      observaciones: null,
      resultado: 'RECHAZADA',
    })
    return t
  }

  function reporte(client: any, qs: Record<string, unknown> = {}, usuario = 'ADMIN') {
    return client
      .get('/api/reportes-admin/segunda-vez')
      .header('Authorization', `Bearer ${tokens[usuario]}`)
      .qs({
        fecha_inicio: hoy().minus({ days: 20 }).toISODate(),
        fecha_fin: hoy().toISODate(),
        placa: 'ZSV91',
        ...qs,
      })
  }

  const seed: Record<string, TurnoRtm> = {}

  group.setup(async () => {
    admin = await crearUsuario('ADMIN', ROL.SUPER_ADMIN)
    await crearUsuario('COMERCIAL', ROL.COMERCIAL)
    await crearUsuario('CONTABILIDAD', ROL.CONTABILIDAD)

    // ABIERTA: rechazado hace 1 h.
    seed.abierta = await origen(P.ABIERTA, ahora().minus({ hours: 1 }).startOf('second'))
    // USADA: rechazado hoy 08:00 − 48 h; su segunda vez llegó hoy 08:00 (48 h)
    // y salió RECHAZADA (un rechazo de una segunda vez no es un rechazo nuevo).
    seed.usada = await origen(P.USADA, hoy().set({ hour: 8 }).minus({ hours: 48 }))
    seed.usadaHija = await turno(P.USADA, {
      fecha: hoy(),
      horaIngreso: '08:00',
      resultadoCertificacion: 'RECHAZADA',
      rechazadoAt: hoy().set({ hour: 9 }),
      ventanaSegundaVezHasta: null,
      esSegundaVez: true,
      turnoOrigenId: null, // se fija abajo (necesita el id del origen)
    })
    seed.usadaHija.turnoOrigenId = seed.usada.id
    await seed.usadaHija.save()
    // VENCIDA: rechazado hace 400 h, no regresó.
    seed.vencida = await origen(P.VENCIDA, ahora().minus({ hours: 400 }).startOf('second'))
    // SUPERADA: rechazado hace 400 h (venció hace 40 h) y regresó hoy pagando normal.
    seed.superada = await origen(P.SUPERADA, ahora().minus({ hours: 400 }).startOf('second'))
    seed.superadaPosterior = await turno(P.SUPERADA, {
      fecha: hoy(),
      horaIngreso: ahora().toFormat('HH:mm'),
      resultadoCertificacion: 'APROBADA',
    })
    // ANULADA (1): origen cancelado después del rechazo.
    seed.anuladaCancelado = await origen(
      P.ANULADA_CANCELADO,
      ahora().minus({ hours: 10 }).startOf('second'),
      { estado: 'cancelado' }
    )
    // ANULADA (2): rechazo corregido a APROBADA (se hace por HTTP en el test).
    seed.anuladaCorregido = await origen(
      P.ANULADA_CORREGIDO,
      ahora().minus({ hours: 5 }).startOf('second')
    )
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const marks = placas.map(() => '?').join(',')
    await Database.rawQuery(
      `DELETE FROM turnos_rtms WHERE placa IN (${marks}) ORDER BY es_segunda_vez DESC, id DESC`,
      placas
    )
    for (const u of usuarios) await u.delete()
  })

  test('El reporte cuadra con lo sembrado: un caso por cada estado de ventana', async ({
    client,
    assert,
  }) => {
    const corr = await client
      .patch(`/api/certificaciones/${seed.anuladaCorregido.id}/resultado`)
      .header('Authorization', `Bearer ${tokens.ADMIN}`)
      .json({ resultado: 'APROBADA', motivo: 'Rechazo digitado por error' })
    corr.assertStatus(200)

    const res = await reporte(client)
    res.assertStatus(200)
    const body = res.body()
    console.log('--- indicadores ---', JSON.stringify(body.indicadores))

    assert.deepEqual(body.indicadores, {
      rechazos: 6,
      abiertas: 1,
      usadas: 1,
      vencidas: 1,
      superadas: 1,
      anuladas: 2,
      tasa_regreso_pct: 50,
      segundas_veces: { aprobadas: 0, rechazadas: 1, pendientes: 0 },
      horas_promedio_hasta_regreso: 48,
      regresaron_tras_vencer_pagando: 1,
    })

    const porPlaca = Object.fromEntries(body.detalle.map((f: any) => [f.placa, f]))
    assert.equal(porPlaca[P.ABIERTA].estado, 'ABIERTA')
    assert.equal(porPlaca[P.USADA].estado, 'USADA')
    assert.equal(porPlaca[P.USADA].segunda_vez_codigo, seed.usadaHija.turnoCodigo)
    assert.equal(porPlaca[P.USADA].segunda_vez_resultado, 'RECHAZADA')
    assert.equal(porPlaca[P.USADA].horas_transcurridas, 48)
    assert.equal(porPlaca[P.VENCIDA].estado, 'VENCIDA')
    assert.equal(porPlaca[P.SUPERADA].estado, 'SUPERADA')
    assert.isTrue(porPlaca[P.SUPERADA].regreso_tras_vencer_pagando)
    assert.equal(porPlaca[P.ANULADA_CANCELADO].estado, 'ANULADA')
    assert.equal(porPlaca[P.ANULADA_CORREGIDO].estado, 'ANULADA')
    assert.isTrue(porPlaca[P.ANULADA_CORREGIDO].rechazo_corregido)
    assert.equal(porPlaca[P.ABIERTA].turno_origen_codigo, seed.abierta.turnoCodigo)
    assert.equal(porPlaca[P.ABIERTA].certificado_por, 'TEST SV-C2-REP-ADMIN')
    assert.isNotNull(porPlaca[P.ABIERTA].ventana_hasta)
    // La segunda vez rechazada no aparece como rechazo propio.
    assert.notInclude(
      body.detalle.map((f: any) => f.turno_origen_id),
      seed.usadaHija.id
    )
    // El rango termina hoy: aviso de ventanas que aún pueden estar abiertas.
    assert.isString(body.aviso)
  })

  test('Filtros: estado, servicio y rango antiguo sin aviso', async ({ client, assert }) => {
    const soloVencidas = await reporte(client, { estado: 'VENCIDA' })
    soloVencidas.assertStatus(200)
    assert.deepEqual(
      soloVencidas.body().detalle.map((f: any) => f.placa),
      [P.VENCIDA]
    )
    // Los indicadores no dependen del filtro de estado.
    assert.equal(soloVencidas.body().indicadores.rechazos, 6)

    const prev = await reporte(client, { servicio: 'PREV' })
    assert.equal(prev.body().indicadores.rechazos, 0)

    const viejo = await reporte(client, {
      fecha_inicio: '2020-01-01',
      fecha_fin: '2020-01-31',
    })
    assert.isNull(viejo.body().aviso)

    const malo = await reporte(client, { estado: 'RARO' })
    malo.assertStatus(400)
  })

  test('Permisos y Excel: CONTABILIDAD sí, COMERCIAL no', async ({ client, assert }) => {
    const contabilidad = await reporte(client, {}, 'CONTABILIDAD')
    contabilidad.assertStatus(200)
    const comercial = await reporte(client, {}, 'COMERCIAL')
    comercial.assertStatus(403)

    const excel = await client
      .get('/api/reportes-admin/segunda-vez/excel')
      .header('Authorization', `Bearer ${tokens.CONTABILIDAD}`)
      .qs({
        fecha_inicio: hoy().minus({ days: 20 }).toISODate(),
        fecha_fin: hoy().toISODate(),
        placa: 'ZSV91',
      })
    excel.assertStatus(200)
    assert.include(String(excel.header('content-type')), 'spreadsheetml')
  })
})
