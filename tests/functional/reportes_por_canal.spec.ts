import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'
import AgenteCaptacion from '#models/agente_captacion'

// Reportes por canal = "¿Cómo se enteró de nosotros?" del turno
// (canal_reporte_service). Siembra un caso por canal en un día aislado
// (2031) y comprueba por HTTP: reparto nuevo, totales iguales al método
// anterior, detalles que suman lo mismo que su fila, segunda vez excluida.
// Placas GZC9xx (no TST: los reportes excluyen TST). Limpieza completa.

const DIA = '2031-03-14'
const DIA_SV = '2031-03-21'
const SEDE_ID = 2
const SERVICIO_RTM = 1
const ROL_SUPER_ADMIN = 9

const P = {
  FACHADA: 'GZC901',
  REDES: 'GZC902',
  TELE: 'GZC903',
  GADS: 'GZC904',
  ASESOR_COMERCIAL: 'GZC905',
  ASESOR_CONVENIO: 'GZC906',
  ASESOR_AGENTE: 'GZC907',
  ASESOR_SIN: 'GZC908',
  GADS_CON_DATEO: 'GZC909',
  NULL_TELE: 'GZC910',
  NULL_NADA: 'GZC911',
  NULL_CONVENIO: 'GZC912',
  SIN_TURNO: 'GZC913',
  ACTIVO: 'GZC914',
  SV_ORIGEN: 'GZC915',
  SV: 'GZC916',
}
const PLACAS = Object.values(P)

/** Canal esperado por placa con el método nuevo (nivel subcanal). */
const ESPERADO: Record<string, string> = {
  [P.FACHADA]: 'FACHADA',
  [P.REDES]: 'REDES',
  [P.TELE]: 'TELE',
  [P.GADS]: 'GOOGLE_ADS',
  [P.ASESOR_COMERCIAL]: 'ASESOR_COMERCIAL',
  [P.ASESOR_CONVENIO]: 'ASESOR_CONVENIO',
  [P.ASESOR_AGENTE]: 'ASESOR_CONVENIO',
  [P.ASESOR_SIN]: 'ASESOR_SIN_DETALLE',
  [P.GADS_CON_DATEO]: 'GOOGLE_ADS',
  [P.NULL_TELE]: 'TELE',
  [P.NULL_NADA]: 'FACHADA',
  [P.NULL_CONVENIO]: 'ASESOR_CONVENIO',
  [P.SIN_TURNO]: 'REDES',
  [P.ACTIVO]: 'FACHADA',
}

test.group('Reportes por canal (¿Cómo se enteró de nosotros?)', (group) => {
  group.each.timeout(60_000)

  let admin: Usuario
  let token = ''
  let agenteConvenio: AgenteCaptacion
  let agenteComercial: AgenteCaptacion
  let descuentoId: number
  let numero = 0
  const ticketIds: number[] = []

  const auth = () => ({ Authorization: `Bearer ${token}` })
  const rango = (dia = DIA) => ({ fecha_inicio: dia, fecha_fin: dia })

  async function turno(
    placa: string,
    o: {
      canal?: string | null
      estado?: string
      dateoCanal?: string
      agenteId?: number | null
      fecha?: string
      esSegundaVez?: boolean
      turnoOrigenId?: number | null
    } = {}
  ) {
    numero++
    let dateoId: number | null = null
    if (o.dateoCanal) {
      const d = await CaptacionDateo.create({
        canal: o.dateoCanal,
        origen: 'UI',
        placa,
        servicioId: SERVICIO_RTM,
        resultado: 'EXITOSO',
      } as any)
      dateoId = d.id
    }
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO_RTM,
      fecha: DateTime.fromISO(`${o.fecha ?? DIA}T09:00:00`, { zone: 'America/Bogota' }),
      horaIngreso: '08:00',
      horaSalida: '09:00:00',
      tieneFacturacion: true,
      turnoNumero: -(9300 + numero),
      turnoNumeroServicio: -(9300 + numero),
      turnoCodigo: `GZC-CANAL-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: o.estado ?? 'finalizado',
      canalAtribucion: o.canal ?? null,
      agenteCaptacionId: o.agenteId ?? null,
      captacionDateoId: dateoId,
      esSegundaVez: o.esSegundaVez ?? false,
      turnoOrigenId: o.turnoOrigenId ?? null,
    } as any)
  }

  async function ticket(
    placa: string,
    o: {
      turnoId: number | null
      captacion?: string | null
      agenteId?: number | null
      total: number
      descuento?: number
      dia?: string
    }
  ) {
    const [id] = await Database.table('facturacion_tickets').insert({
      hash: `gzc-${randomUUID()}`,
      file_path: 'tests/gzc.png',
      estado: 'CONFIRMADA',
      servicio_codigo: 'RTM',
      placa,
      turno_id: o.turnoId,
      captacion_canal: o.captacion ?? null,
      agente_id: o.agenteId ?? null,
      total: o.total,
      subtotal: Math.round(o.total / 1.19),
      descuento_id: o.descuento ? descuentoId : null,
      descuento_monto_aplicado: o.descuento ?? 0,
      created_at: `${o.dia ?? DIA} 10:00:00`,
      updated_at: `${o.dia ?? DIA} 10:00:00`,
    })
    ticketIds.push(id)
    return id
  }

  group.setup(async () => {
    const previos = await Database.from('turnos_rtms').whereIn('placa', PLACAS).count('* as n')
    if (Number(previos[0].n) > 0) throw new Error('Placas GZC9xx ya existen: no se siembra.')

    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'REPORTES-CANAL',
      correo: `test.reportes.canal.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(admin)
    token = tokenObj.value!.release()
    agenteConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: 'TEST GZC AGENTE CONVENIO',
      activo: true,
    } as any)
    agenteComercial = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: 'TEST GZC AGENTE COMERCIAL',
      activo: true,
    } as any)
    const desc = await Database.from('descuentos').select('id').orderBy('id').first()
    descuentoId = desc.id

    // Un caso por canal (turno con su ticket); montos distintos para
    // poder distinguir cada fila.
    const t = async (
      placa: string,
      o: Parameters<typeof turno>[1],
      tk: Omit<Parameters<typeof ticket>[1], 'turnoId'>
    ) => {
      const tu = await turno(placa, o)
      await ticket(placa, { ...tk, turnoId: tu.id })
    }
    await t(P.FACHADA, { canal: 'FACHADA' }, { total: 100_000, descuento: 5_000 })
    await t(P.REDES, { canal: 'REDES' }, { total: 110_000 })
    await t(P.TELE, { canal: 'TELE' }, { total: 120_000, descuento: 6_000 })
    await t(P.GADS, { canal: 'GOOGLE_ADS' }, { total: 130_000, descuento: 7_000 })
    await t(
      P.ASESOR_COMERCIAL,
      { canal: 'ASESOR', dateoCanal: 'ASESOR_COMERCIAL' },
      { captacion: 'ASESOR_COMERCIAL', total: 140_000, descuento: 8_000 }
    )
    await t(
      P.ASESOR_CONVENIO,
      { canal: 'ASESOR', dateoCanal: 'ASESOR_CONVENIO' },
      { captacion: 'ASESOR_CONVENIO', total: 150_000 }
    )
    await t(P.ASESOR_AGENTE, { canal: 'ASESOR', agenteId: agenteConvenio.id }, { total: 160_000 })
    await t(P.ASESOR_SIN, { canal: 'ASESOR' }, { total: 170_000 })
    // Con dateo vigente de asesor, el operador eligió Google ADS: manda lo elegido.
    await t(
      P.GADS_CON_DATEO,
      { canal: 'GOOGLE_ADS', dateoCanal: 'ASESOR_COMERCIAL' },
      { captacion: 'ASESOR_COMERCIAL', agenteId: agenteComercial.id, total: 180_000 }
    )
    // Turnos sin canal: respaldo por el dateo del ticket.
    await t(P.NULL_TELE, { canal: null, dateoCanal: 'TELE' }, { captacion: 'TELE', total: 190_000 })
    await t(P.NULL_NADA, { canal: null }, { total: 200_000 })
    await t(
      P.NULL_CONVENIO,
      { canal: null, dateoCanal: 'ASESOR_CONVENIO' },
      { captacion: 'ASESOR_CONVENIO', total: 210_000 }
    )
    // Ticket sin turno (solo cuenta en Descuentos y Liquidación).
    await ticket(P.SIN_TURNO, {
      turnoId: null,
      captacion: 'REDES',
      total: 220_000,
      descuento: 9_000,
    })
    // Turno no finalizado: fuera de Ingresos/Retención, dentro de Liquidación.
    await t(P.ACTIVO, { canal: 'FACHADA', estado: 'activo' }, { total: 230_000 })

    // Segunda vez con ticket (la app no lo permite: se fuerza en BD) en otro día.
    const origen = await turno(P.SV_ORIGEN, { canal: 'GOOGLE_ADS', fecha: DIA_SV })
    await ticket(P.SV_ORIGEN, { turnoId: origen.id, total: 300_000, dia: DIA_SV })
    const sv = await turno(P.SV, {
      canal: 'GOOGLE_ADS',
      fecha: DIA_SV,
      esSegundaVez: true,
      turnoOrigenId: origen.id,
    })
    await ticket(P.SV, { turnoId: sv.id, total: 999_000, descuento: 1_000, dia: DIA_SV })
  })

  group.teardown(async () => {
    if (ticketIds.length)
      await Database.from('facturacion_tickets').whereIn('id', ticketIds).delete()
    await Database.from('turnos_rtms')
      .whereIn('placa', PLACAS)
      .orderBy('es_segunda_vez', 'desc')
      .delete()
    await Database.from('captacion_dateos').whereIn('placa', PLACAS).delete()
    if (agenteConvenio) await agenteConvenio.delete()
    if (agenteComercial) await agenteComercial.delete()
    if (admin) await admin.delete()
  })

  const get = (client: any, path: string, qs: Record<string, unknown>) =>
    client.get(`/api/reportes-admin${path}`).headers(auth()).qs(qs)
  const cuerpo = async (client: any, path: string, qs: Record<string, unknown>) => {
    const r = await get(client, path, qs)
    return r.body()
  }

  const ORDEN = [
    'FACHADA',
    'REDES',
    'TELE',
    'ASESOR',
    'ASESOR_COMERCIAL',
    'ASESOR_CONVENIO',
    'ASESOR_SIN_DETALLE',
    'GOOGLE_ADS',
  ]
  const NOMBRES = [
    'Fachada',
    'Redes Sociales',
    'Call Center',
    'Asesor',
    'Comercial',
    'Convenio',
    'Asesor (sin detalle)',
    'Google ADS',
  ]

  /** Suma esperada por canal (nivel subcanal) de las placas indicadas. */
  async function esperadoPorCanal(
    placas: string[],
    campo: 'total' | 'descuento_monto_aplicado' = 'total'
  ) {
    const filas = await Database.from('facturacion_tickets')
      .whereIn('id', ticketIds)
      .whereIn('placa', placas)
    const m = new Map<string, { n: number; v: number }>()
    for (const f of filas) {
      const c = ESPERADO[f.placa]
      const e = m.get(c) ?? { n: 0, v: 0 }
      e.n++
      e.v += Number(f[campo])
      m.set(c, e)
    }
    const asesor = ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO', 'ASESOR_SIN_DETALLE']
      .map((s) => m.get(s) ?? { n: 0, v: 0 })
      .reduce((a, b) => ({ n: a.n + b.n, v: a.v + b.v }), { n: 0, v: 0 })
    m.set('ASESOR', asesor)
    return m
  }

  const placasIngresos = PLACAS.filter(
    (p) => ![P.SIN_TURNO, P.ACTIVO, P.SV_ORIGEN, P.SV].includes(p)
  )

  test('Ingresos por canal: 5 canales fijos + Asesor desglosado, reparto por el turno', async ({
    client,
    assert,
  }) => {
    const res = await get(client, '/ingresos-canal', rango())
    res.assertStatus(200)
    const body = res.body()
    assert.deepEqual(
      body.por_canal.map((r: any) => r.canal),
      ORDEN
    )
    assert.deepEqual(
      body.por_canal.map((r: any) => r.nombre),
      NOMBRES
    )
    const esperado = await esperadoPorCanal(placasIngresos)
    for (const r of body.por_canal) {
      const e = esperado.get(r.canal) ?? { n: 0, v: 0 }
      assert.equal(r.cantidad, e.n, `cantidad ${r.canal}`)
      assert.equal(r.total_bruto, e.v, `bruto ${r.canal}`)
    }
    // Google ADS sin dateo en su fila; Redes y Call Center sin dateo ya no caen en Fachada.
    const fila = (c: string) => body.por_canal.find((r: any) => r.canal === c)
    assert.equal(fila('GOOGLE_ADS').cantidad, 2)
    assert.equal(fila('REDES').cantidad, 1)
    assert.equal(fila('TELE').cantidad, 2)
    assert.equal(fila('FACHADA').cantidad, 2)
    assert.isFalse(body.aviso_canal.aplica)
  })

  test('Ingresos por canal: totales iguales al método anterior; cada detalle suma lo mismo que su fila', async ({
    client,
    assert,
  }) => {
    const res = await get(client, '/ingresos-canal', rango())
    const body = res.body()
    // Método anterior (agrupando por captacion_canal) — mismos tickets.
    const viejo = (await Database.from('facturacion_tickets as ft')
      .join('turnos_rtms as t', 't.id', 'ft.turno_id')
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .where('t.estado', 'finalizado')
      .whereRaw("t.placa NOT LIKE 'TST%'")
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [DIA, DIA])
      .count('* as cantidad')
      .sum('ft.total as bruto')
      .sum('ft.subtotal as neto')
      .first()) as any
    assert.equal(body.totales.cantidad, Number(viejo.cantidad))
    assert.equal(body.totales.total_bruto, Number(viejo.bruto))
    assert.equal(body.totales.total_neto, Number(viejo.neto))
    const sumaFilas = body.por_canal
      .filter((r: any) => !r.es_subcanal)
      .reduce((a: number, r: any) => a + r.cantidad, 0)
    assert.equal(sumaFilas, body.totales.cantidad)

    for (const r of body.por_canal) {
      const d = await get(client, '/detalle-canal', { ...rango(), canal: r.canal })
      d.assertStatus(200)
      assert.equal(d.body().total_vehiculos, r.cantidad, `detalle ${r.canal}`)
      assert.equal(d.body().total_bruto, r.total_bruto, `detalle bruto ${r.canal}`)
    }
  })

  test('Retención por canal: reparto, totales y detalle por celda', async ({ client, assert }) => {
    const res = await get(client, '/retencion', rango())
    res.assertStatus(200)
    const body = res.body()
    assert.deepEqual(
      body.por_canal.map((r: any) => r.canal),
      ORDEN
    )
    const esperado = await esperadoPorCanal(placasIngresos)
    for (const r of body.por_canal) {
      const e = esperado.get(r.canal) ?? { n: 0, v: 0 }
      assert.equal(r.total, e.n, `retención ${r.canal}`)
      assert.equal(r.total_bruto, e.v, `retención bruto ${r.canal}`)
    }
    const sumaFilas = body.por_canal
      .filter((r: any) => !r.es_subcanal)
      .reduce((a: number, r: any) => a + r.total, 0)
    assert.equal(sumaFilas, body.resumen.total.cantidad)
    for (const r of body.por_canal) {
      for (const [cat, campo] of [
        ['NUEVO', 'nuevos'],
        ['RECURRENTE', 'recurrentes'],
        ['RECUPERACION', 'recuperaciones'],
      ] as const) {
        const d = await get(client, '/detalle-retencion', {
          ...rango(),
          categoria: cat,
          canal: r.canal,
        })
        d.assertStatus(200)
        assert.equal(d.body().total_vehiculos, r[campo], `detalle retención ${r.canal}/${cat}`)
      }
    }
  })

  test('Descuentos por canal: reparto, totales iguales y detalle por fila (incluye ticket sin turno)', async ({
    client,
    assert,
  }) => {
    const res = await get(client, '/descuentos-por-canal', rango())
    res.assertStatus(200)
    const body = res.body()
    // "Asesor (sin detalle)" solo aparece si tiene datos (aquí no hay descuento en esa fila).
    assert.deepEqual(
      body.por_canal.map((r: any) => r.canal),
      ORDEN.filter((c) => c !== 'ASESOR_SIN_DETALLE')
    )
    const conDescuento = [P.FACHADA, P.TELE, P.GADS, P.ASESOR_COMERCIAL, P.SIN_TURNO]
    const esperado = await esperadoPorCanal(conDescuento, 'descuento_monto_aplicado')
    for (const r of body.por_canal) {
      const e = esperado.get(r.canal) ?? { n: 0, v: 0 }
      assert.equal(r.cantidad, e.n, `descuentos ${r.canal}`)
      assert.equal(r.total_descuentos, e.v, `descuentos monto ${r.canal}`)
    }
    assert.equal(body.totales.cantidad, 5)
    assert.equal(body.totales.total_descuentos, 35_000)
    for (const r of body.por_canal) {
      const d = await get(client, '/detalle-descuentos', { ...rango(), canal: r.canal })
      d.assertStatus(200)
      assert.equal(d.body().total_vehiculos, r.cantidad, `detalle descuentos ${r.canal}`)
      assert.equal(d.body().total_descuentos, r.total_descuentos)
    }
  })

  test('Liquidación y Trazabilidad "por canal": reparto, monto total igual y placas por fila', async ({
    client,
    assert,
  }) => {
    const res = await get(client, '/liquidacion-rtm', rango())
    res.assertStatus(200)
    const porCanal = res.body().por_canal
    assert.deepEqual(
      porCanal.map((r: any) => r.canal),
      ORDEN
    )
    const todas = PLACAS.filter((p) => ![P.SV_ORIGEN, P.SV].includes(p))
    const esperado = await esperadoPorCanal(todas)
    for (const r of porCanal) {
      const e = esperado.get(r.canal) ?? { n: 0, v: 0 }
      assert.equal(r.cantidad, e.n, `liquidación ${r.canal}`)
      assert.equal(r.monto, e.v, `liquidación monto ${r.canal}`)
      const d = await get(client, '/liquidacion-rtm/detalle-placas-canal', {
        ...rango(),
        canal: r.canal,
      })
      d.assertStatus(200)
      assert.equal(d.body().placas.length, r.cantidad, `placas ${r.canal}`)
    }
    const totalMonto = porCanal
      .filter((r: any) => !r.es_subcanal)
      .reduce((a: number, r: any) => a + r.monto, 0)
    const viejo = (await Database.from('facturacion_tickets')
      .where('estado', 'CONFIRMADA')
      .where('servicio_codigo', 'RTM')
      .whereRaw('DATE(created_at) BETWEEN ? AND ?', [DIA, DIA])
      .sum('total as monto')
      .first()) as any
    assert.equal(totalMonto, Number(viejo.monto))

    const traz = await get(client, '/trazabilidad-rtm', rango())
    traz.assertStatus(200)
    assert.deepEqual(traz.body().por_canal, porCanal)

    const buscar = await get(client, '/liquidacion-rtm/buscar-placa', {
      ...rango(),
      placa: P.GADS_CON_DATEO,
    })
    buscar.assertStatus(200)
    const enCanal = (buscar.body().matches ?? []).filter((m: any) => m.seccion === 'canal')
    assert.deepEqual(
      enCanal.map((m: any) => m.canal),
      ['GOOGLE_ADS']
    )
  })

  test('segunda vez: su ticket (forzado en BD) no entra en ningún reporte por canal', async ({
    client,
    assert,
  }) => {
    const ing = await cuerpo(client, '/ingresos-canal', rango(DIA_SV))
    assert.equal(ing.totales.cantidad, 1)
    assert.equal(ing.totales.total_bruto, 300_000)
    const ret = await cuerpo(client, '/retencion', rango(DIA_SV))
    assert.equal(
      ret.por_canal
        .filter((r: any) => !r.es_subcanal)
        .reduce((a: number, r: any) => a + r.total, 0),
      1
    )
    const desc = await cuerpo(client, '/descuentos-por-canal', rango(DIA_SV))
    assert.equal(desc.totales.cantidad, 0)
    const liq = await cuerpo(client, '/liquidacion-rtm', rango(DIA_SV))
    assert.equal(liq.por_canal.find((r: any) => r.canal === 'GOOGLE_ADS').cantidad, 1)
    assert.equal(liq.por_canal.find((r: any) => r.canal === 'GOOGLE_ADS').monto, 300_000)
  })

  test('aviso de fecha confiable: aplica si el rango empieza antes de CANAL_CONFIABLE_DESDE', async ({
    client,
    assert,
  }) => {
    const antes = await cuerpo(client, '/ingresos-canal', {
      fecha_inicio: '2026-06-01',
      fecha_fin: DIA,
    })
    assert.isTrue(antes.aviso_canal.aplica)
    assert.include(antes.aviso_canal.mensaje, '¿Cómo se enteró de nosotros?')
    const despues = await cuerpo(client, '/ingresos-canal', rango())
    assert.isFalse(despues.aviso_canal.aplica)
    assert.isNull(despues.aviso_canal.mensaje)
  })

  test('PDF del Súper Informe se genera (rango con y sin aviso)', async ({ assert }) => {
    for (const q of [rango(), { fecha_inicio: '2026-06-01', fecha_fin: '2026-06-30' }]) {
      const qs = new URLSearchParams(q)
      const r = await fetch(
        `http://${process.env.HOST}:${process.env.PORT}/api/reportes-admin/super-informe/pdf?${qs}`,
        { headers: auth() }
      )
      assert.equal(r.status, 200)
      const buf = Buffer.from(await r.arrayBuffer())
      assert.equal(buf.subarray(0, 4).toString(), '%PDF')
    }
  })

  test('el reporte de Asesores sigue leyendo el canal del dateo (captacion_canal)', async ({
    client,
    assert,
  }) => {
    const res = await get(client, '/asesores', rango())
    res.assertStatus(200)
    // El ticket GADS_CON_DATEO (dateo comercial, turno Google ADS) sigue en
    // Asesores con su canal de dateo: el cambio de canal no lo mueve.
    const fila = res.body().asesores.find((a: any) => a.agente_id === agenteComercial.id)
    assert.exists(fila)
    assert.equal(fila.canal, 'ASESOR_COMERCIAL')
    assert.equal(fila.total_bruto, 180_000)
  })
})
