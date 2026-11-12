import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Servicio from '#models/servicio'
import Database from '@adonisjs/lucid/services/db'

// WINDOW_BLOCK_CONFIRMABLE: crear un turno de un servicio con vigencia
// (bloqueoMesesPorServicio > 0: RTM y SOAT) antes de la ventana previa de 16
// días al vencimiento del anterior ya no es un bloqueo duro. Sin flag → 409
// WINDOW_BLOCK_CONFIRMABLE; con confirmar_ventana_vigencia: true (o el alias
// confirmar_ventana_rtm) → 201 y queda registrado en ventana_rtm_confirmada_*.
// Preventiva y Peritaje no tienen bloqueo de vigencia.
// Escribe en la BD compartida: placas VRT901–VRT909, limpieza al final.

const SEDE_ID = 2
const ROL_OPERATIVO_TURNOS_ID = 14
const ZONA = 'America/Bogota'
const DIAS_VENTANA_PRE = 16

const P = {
  RTM_CONFIRMABLE: 'VRT901',
  SOAT_CONFIRMABLE: 'VRT902',
  RTM_BORDE_16: 'VRT903',
  RTM_BORDE_17: 'VRT904',
  RTM_SIN_PREVIO: 'VRT905',
  SOAT_BORDE_16: 'VRT906',
  SOAT_BORDE_17: 'VRT907',
  PREV_RECIENTE: 'VRT908',
  PERI_RECIENTE: 'VRT909',
}

test.group('WINDOW_BLOCK_CONFIRMABLE · turnos con vigencia (RTM y SOAT)', (group) => {
  let operativo: Usuario
  let token: string
  let hoy: DateTime
  const servicioId: Record<'RTM' | 'SOAT' | 'PREV' | 'PERI', number> = {
    RTM: 0,
    SOAT: 0,
    PREV: 0,
    PERI: 0,
  }

  async function finalizadoPrevio(placa: string, codigo: keyof typeof servicioId, fecha: DateTime) {
    const n = -(9500 + Number(placa.slice(3)))
    await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: operativo.id,
      servicioId: servicioId[codigo],
      fecha,
      horaIngreso: '08:00',
      horaSalida: '09:00',
      tieneFacturacion: true,
      turnoNumero: n,
      turnoNumeroServicio: n,
      turnoCodigo: `TST-WBC-${placa}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
      resultadoCertificacion: codigo === 'RTM' || codigo === 'PREV' ? 'APROBADA' : null,
    } as any)
  }

  function crearTurno(
    client: any,
    placa: string,
    codigo: keyof typeof servicioId,
    extra: Record<string, unknown> = {}
  ) {
    return client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: operativo.id,
        fecha: hoy.toISODate(),
        horaIngreso: DateTime.local().setZone(ZONA).toFormat('HH:mm:ss'),
        servicioId: servicioId[codigo],
        ...extra,
      })
  }

  /** Fecha del turno anterior para que hoy quede a `diasAntes` del vencimiento. */
  function ultimaParaDiasAntes(diasAntes: number) {
    return hoy.startOf('day').plus({ days: diasAntes }).minus({ months: 12 })
  }

  function vencimientoDesde(ultima: DateTime) {
    return DateTime.fromISO(ultima.toISODate()!, { zone: ZONA }).plus({ months: 12 }).startOf('day')
  }

  group.setup(async () => {
    hoy = DateTime.local().setZone(ZONA)
    for (const codigo of Object.keys(servicioId) as (keyof typeof servicioId)[]) {
      const s = await Servicio.findByOrFail('codigoServicio', codigo)
      servicioId[codigo] = s.id
    }
    operativo = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'WINDOW-BLOCK-CONFIRMABLE',
      correo: `test.window.block.confirmable.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_OPERATIVO_TURNOS_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(operativo)
    token = tokenObj.value!.release()

    // Turno anterior hace ~3 meses: faltan ~9 meses para vencer.
    await finalizadoPrevio(P.RTM_CONFIRMABLE, 'RTM', hoy.minus({ months: 3 }))
    await finalizadoPrevio(P.SOAT_CONFIRMABLE, 'SOAT', hoy.minus({ months: 3 }))
    await finalizadoPrevio(P.RTM_BORDE_16, 'RTM', ultimaParaDiasAntes(DIAS_VENTANA_PRE))
    await finalizadoPrevio(P.RTM_BORDE_17, 'RTM', ultimaParaDiasAntes(DIAS_VENTANA_PRE + 1))
    await finalizadoPrevio(P.SOAT_BORDE_16, 'SOAT', ultimaParaDiasAntes(DIAS_VENTANA_PRE))
    await finalizadoPrevio(P.SOAT_BORDE_17, 'SOAT', ultimaParaDiasAntes(DIAS_VENTANA_PRE + 1))
    // Preventiva/Peritaje finalizados hace 1 mes: sin bloqueo de vigencia.
    await finalizadoPrevio(P.PREV_RECIENTE, 'PREV', hoy.minus({ months: 1 }))
    await finalizadoPrevio(P.PERI_RECIENTE, 'PERI', hoy.minus({ months: 1 }))
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const marks = placas.map(() => '?').join(',')
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, placas)
    if (operativo) await operativo.delete()
  })

  // ── Confirmación: RTM y SOAT se comportan igual
  const CASOS_CONFIRMABLES = [
    {
      codigo: 'RTM' as const,
      placa: P.RTM_CONFIRMABLE,
      anterior: 'La RTM anterior',
      // Alias aceptado (lo que manda el frontend anterior).
      flag: { confirmar_ventana_rtm: true },
    },
    {
      codigo: 'SOAT' as const,
      placa: P.SOAT_CONFIRMABLE,
      anterior: 'El SOAT anterior',
      flag: { confirmar_ventana_vigencia: true },
    },
  ]

  for (const caso of CASOS_CONFIRMABLES) {
    test(`${caso.codigo} sin confirmar → 409 WINDOW_BLOCK_CONFIRMABLE con los datos de la ventana`, async ({
      client,
      assert,
    }) => {
      const res = await crearTurno(client, caso.placa, caso.codigo)
      res.assertStatus(409)
      const ultima = hoy.minus({ months: 3 })
      const vencimiento = vencimientoDesde(ultima)
      res.assertBodyContains({
        code: 'WINDOW_BLOCK_CONFIRMABLE',
        placa: caso.placa,
        servicio: caso.codigo,
        lastFinalizedOn: ultima.toISODate(),
        vencimientoDate: vencimiento.toISODate(),
        nextAllowedDate: vencimiento.minus({ days: DIAS_VENTANA_PRE }).toISODate(),
        diasVentana: DIAS_VENTANA_PRE,
        diasAntesDelVencimiento: Math.round(vencimiento.diff(hoy.startOf('day'), 'days').days),
      })
      assert.isTrue(String(res.body().message).startsWith(caso.anterior))
      // No se creó nada (rollback).
      const creados = await TurnoRtm.query().where('placa', caso.placa).where('estado', 'activo')
      assert.lengthOf(creados, 0)
    })

    test(`${caso.codigo} mismo request con ${Object.keys(caso.flag)[0]} → 201 y registra quién confirmó`, async ({
      client,
      assert,
    }) => {
      const res = await crearTurno(client, caso.placa, caso.codigo, caso.flag)
      res.assertStatus(201)
      const t = await TurnoRtm.findOrFail(res.body().id)
      assert.equal(t.servicioId, servicioId[caso.codigo])
      assert.equal(t.ventanaRtmConfirmadaPorId, operativo.id)
      assert.isNotNull(t.ventanaRtmConfirmadaAt)
      const vencimiento = vencimientoDesde(hoy.minus({ months: 3 }))
      assert.equal(
        t.ventanaRtmDiasAntesVencimiento,
        Math.round(vencimiento.diff(hoy.startOf('day'), 'days').days)
      )
      assert.isFalse(Boolean(t.esSegundaVez))
    })
  }

  // ── Bordes de 16 y 17 días para ambos servicios
  const CASOS_BORDE = [
    { codigo: 'RTM' as const, borde16: P.RTM_BORDE_16, borde17: P.RTM_BORDE_17 },
    { codigo: 'SOAT' as const, borde16: P.SOAT_BORDE_16, borde17: P.SOAT_BORDE_17 },
  ]

  for (const caso of CASOS_BORDE) {
    test(`${caso.codigo} borde exacto: a 16 días del vencimiento se crea sin confirmar y sin registro`, async ({
      client,
      assert,
    }) => {
      const res = await crearTurno(client, caso.borde16, caso.codigo)
      res.assertStatus(201)
      const t = await TurnoRtm.findOrFail(res.body().id)
      assert.isNull(t.ventanaRtmConfirmadaPorId)
      assert.isNull(t.ventanaRtmConfirmadaAt)
      assert.isNull(t.ventanaRtmDiasAntesVencimiento)
    })

    test(`${caso.codigo} borde: a 17 días del vencimiento pide confirmación (diasAntesDelVencimiento = 17)`, async ({
      client,
    }) => {
      const res = await crearTurno(client, caso.borde17, caso.codigo)
      res.assertStatus(409)
      res.assertBodyContains({
        code: 'WINDOW_BLOCK_CONFIRMABLE',
        servicio: caso.codigo,
        diasAntesDelVencimiento: DIAS_VENTANA_PRE + 1,
        nextAllowedDate: hoy.plus({ days: 1 }).toISODate(),
      })
    })
  }

  // ── Servicios sin vigencia
  for (const caso of [
    { codigo: 'PREV' as const, placa: P.PREV_RECIENTE },
    { codigo: 'PERI' as const, placa: P.PERI_RECIENTE },
  ]) {
    test(`${caso.codigo} con turno finalizado hace 1 mes: sin bloqueo de vigencia (201 sin flag)`, async ({
      client,
      assert,
    }) => {
      const res = await crearTurno(client, caso.placa, caso.codigo)
      res.assertStatus(201)
      const t = await TurnoRtm.findOrFail(res.body().id)
      assert.isNull(t.ventanaRtmConfirmadaPorId)
    })
  }

  test('RTM sin turno previo: el flag no tiene efecto y no se registra confirmación', async ({
    client,
    assert,
  }) => {
    const res = await crearTurno(client, P.RTM_SIN_PREVIO, 'RTM', {
      confirmar_ventana_vigencia: true,
    })
    res.assertStatus(201)
    const t = await TurnoRtm.findOrFail(res.body().id)
    assert.isNull(t.ventanaRtmConfirmadaPorId)
  })
})
