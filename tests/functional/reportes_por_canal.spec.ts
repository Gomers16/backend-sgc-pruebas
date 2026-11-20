import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import ExcelJS from 'exceljs'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'
import AgenteCaptacion from '#models/agente_captacion'

// Reportes por canal = "¿Cómo se enteró de nosotros?" del turno
// (canal_reporte_service). Siembra un caso por canal en un día aislado
// (2031) y comprueba por HTTP: reparto nuevo, totales iguales al método
// anterior, detalles que suman lo mismo que su fila, segunda vez excluida y
// la línea informativa "de los cuales, por convenio" (solo comerciales con
// convenio; no suma). Placas GZC9xx (no TST: los reportes excluyen TST).
// Limpieza completa.

const DIA = '2031-03-14'
const DIA_SV = '2031-03-21'
const SEDE_ID = 3
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
  COMERCIAL_CONV: 'GZC917',
  COMERCIAL_CONV_NOMBRE: 'GZC918',
  FACHADA_CONV: 'GZC919',
  ASESOR_CONV_CONV: 'GZC920',
  SIN_DETALLE_CONV: 'GZC921',
}
const PLACAS = Object.values(P)

/** Subgrupo esperado por placa con el método nuevo (ASESOR_COMERCIAL_CONVENIO = la línea informativa). */
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
  [P.COMERCIAL_CONV]: 'ASESOR_COMERCIAL_CONVENIO',
  [P.COMERCIAL_CONV_NOMBRE]: 'ASESOR_COMERCIAL_CONVENIO',
  // Fachada elegida con dateo de comercial con convenio: se respeta Fachada.
  [P.FACHADA_CONV]: 'FACHADA',
  // Asesor convenio con convenio: su fila, no la línea informativa.
  [P.ASESOR_CONV_CONV]: 'ASESOR_CONVENIO',
  // Sin detalle (no se sabe si es comercial): fuera de la línea aunque traiga convenio.
  [P.SIN_DETALLE_CONV]: 'ASESOR_SIN_DETALLE',
}

test.group('Reportes por canal (¿Cómo se enteró de nosotros?)', (group) => {
  group.each.timeout(60_000)

  let admin: Usuario
  let token = ''
  let agenteConvenio: AgenteCaptacion
  let agenteComercial: AgenteCaptacion
  let descuentoId: number
  let convenioId: number
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
      dateoConvenio?: boolean
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
        convenioId: o.dateoConvenio ? convenioId : null,
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
      convenioNombre?: string
      total: number
      descuento?: number
      dia?: string
    }
  ) {
    const [id] = await Database.table('facturacion_tickets').insert({
      sede_id: SEDE_ID,
      hash: `gzc-${randomUUID()}`,
      file_path: 'tests/gzc.png',
      estado: 'CONFIRMADA',
      servicio_codigo: 'RTM',
      placa,
      turno_id: o.turnoId,
      captacion_canal: o.captacion ?? null,
      agente_id: o.agenteId ?? null,
      convenio_nombre: o.convenioNombre ?? null,
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
    const conv = await Database.from('convenios').select('id').orderBy('id').first()
    convenioId = conv.id

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

    // Línea "de los cuales, por convenio" (solo comerciales con convenio).
    await t(
      P.COMERCIAL_CONV,
      { canal: 'ASESOR', dateoCanal: 'ASESOR_COMERCIAL', dateoConvenio: true },
      { captacion: 'ASESOR_COMERCIAL', total: 240_000, descuento: 4_000 }
    )
    // Sin dateo vinculado: el convenio sale del nombre copiado al ticket.
    await t(
      P.COMERCIAL_CONV_NOMBRE,
      { canal: 'ASESOR', agenteId: agenteComercial.id },
      { convenioNombre: 'CONVENIO GZC', total: 250_000 }
    )
    await t(
      P.FACHADA_CONV,
      { canal: 'FACHADA', dateoCanal: 'ASESOR_COMERCIAL', dateoConvenio: true },
      { captacion: 'ASESOR_COMERCIAL', convenioNombre: 'CONVENIO GZC', total: 260_000 }
    )
    await t(
      P.ASESOR_CONV_CONV,
      { canal: 'ASESOR', dateoCanal: 'ASESOR_CONVENIO', dateoConvenio: true },
      { captacion: 'ASESOR_CONVENIO', convenioNombre: 'CONVENIO GZC', total: 270_000 }
    )
    await t(
      P.SIN_DETALLE_CONV,
      { canal: 'ASESOR' },
      { convenioNombre: 'CONVENIO GZC', total: 280_000 }
    )

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
    'ASESOR_COMERCIAL_CONVENIO',
    'ASESOR_CONVENIO',
    'ASESOR_SIN_DETALLE',
    'GOOGLE_ADS',
  ]
  const NOMBRES = [
    'Fachada',
    'Redes Sociales',
    'Call Center',
    'Asesor',
    'Asesor comercial',
    'de los cuales, por convenio',
    'Asesor convenio',
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
    const suma = (claves: string[]) =>
      claves
        .map((s) => m.get(s) ?? { n: 0, v: 0 })
        .reduce((a, b) => ({ n: a.n + b.n, v: a.v + b.v }), { n: 0, v: 0 })
    const comercialSin = m.get('ASESOR_COMERCIAL') ?? { n: 0, v: 0 }
    m.set(
      'ASESOR',
      suma([
        'ASESOR_COMERCIAL',
        'ASESOR_COMERCIAL_CONVENIO',
        'ASESOR_CONVENIO',
        'ASESOR_SIN_DETALLE',
      ])
    )
    m.set('ASESOR_COMERCIAL', {
      n: comercialSin.n + (m.get('ASESOR_COMERCIAL_CONVENIO')?.n ?? 0),
      v: comercialSin.v + (m.get('ASESOR_COMERCIAL_CONVENIO')?.v ?? 0),
    })
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
    // Fachada elegida con dateo de comercial con convenio: sigue en Fachada.
    assert.equal(fila('FACHADA').cantidad, 3)
    assert.isFalse(body.aviso_canal.aplica)

    // Línea informativa: dentro de Asesor comercial, no suma.
    const inf = fila('ASESOR_COMERCIAL_CONVENIO')
    assert.isTrue(inf.es_informativa)
    assert.isTrue(inf.es_subcanal)
    assert.equal(inf.cantidad, 2)
    assert.equal(inf.total_bruto, 490_000)
    // 490.000 de 630.000 de Asesor comercial (140.000 + 240.000 + 250.000).
    assert.equal(fila('ASESOR_COMERCIAL').total_bruto, 630_000)
    assert.equal(inf.porcentaje_sobre_asesor_comercial, 77.78)
    const asesor = fila('ASESOR')
    const subs = ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO', 'ASESOR_SIN_DETALLE']
    assert.equal(
      asesor.cantidad,
      subs.reduce((a, c) => a + (fila(c)?.cantidad ?? 0), 0)
    )
    for (const r of body.por_canal)
      assert.equal(r.es_informativa, r.canal === 'ASESOR_COMERCIAL_CONVENIO')
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
    const conDescuento = [
      P.FACHADA,
      P.TELE,
      P.GADS,
      P.ASESOR_COMERCIAL,
      P.SIN_TURNO,
      P.COMERCIAL_CONV,
    ]
    const esperado = await esperadoPorCanal(conDescuento, 'descuento_monto_aplicado')
    for (const r of body.por_canal) {
      const e = esperado.get(r.canal) ?? { n: 0, v: 0 }
      assert.equal(r.cantidad, e.n, `descuentos ${r.canal}`)
      assert.equal(r.total_descuentos, e.v, `descuentos monto ${r.canal}`)
    }
    assert.equal(body.totales.cantidad, 6)
    assert.equal(body.totales.total_descuentos, 39_000)
    const inf = body.por_canal.find((r: any) => r.canal === 'ASESOR_COMERCIAL_CONVENIO')
    assert.isTrue(inf.es_informativa)
    assert.isNull(inf.porcentaje)
    assert.equal(inf.tipos_usados, 1)
    assert.equal(inf.porcentaje_sobre_asesor_comercial, 33.33)
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

    // Comercial con convenio: la línea informativa y su fila Asesor comercial.
    const buscarConv = await get(client, '/liquidacion-rtm/buscar-placa', {
      ...rango(),
      placa: P.COMERCIAL_CONV,
    })
    const enCanalConv = (buscarConv.body().matches ?? []).filter((m: any) => m.seccion === 'canal')
    assert.sameMembers(
      enCanalConv.map((m: any) => m.canal),
      ['ASESOR_COMERCIAL_CONVENIO', 'ASESOR_COMERCIAL']
    )

    // Excel: la línea informativa marcada y sin % del total.
    const qs = new URLSearchParams(rango())
    const r = await fetch(
      `http://${process.env.HOST}:${process.env.PORT}/api/reportes-admin/liquidacion-rtm/excel?${qs}`,
      { headers: auth() }
    )
    assert.equal(r.status, 200)
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await r.arrayBuffer()) as any)
    const filas: string[][] = []
    wb.worksheets[0].eachRow((row) => {
      filas.push((row.values as any[]).slice(1).map((v) => String(v ?? '')))
    })
    const filaInf = filas.find((f) => f[0].includes('de los cuales, por convenio'))
    assert.exists(filaInf)
    assert.include(filaInf![0], '(informativa, no suma)')
    assert.equal(filaInf![1], '2')
    assert.include(filaInf![3], '% de Asesor comercial')
    assert.isTrue(filas.some((f) => f[0].trim() === '· Asesor comercial'))
    assert.isTrue(filas.some((f) => f[0].trim() === '· Asesor convenio'))
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

// "Cédula convenio" en los Excel de liquidación (Liquidación RTM, Trazabilidad
// RTM y Exportar placas). Sale de convenios.doc_numero por c.convenio_id;
// "Pendiente" si está vacía o es inventada por el seeder (9999 + 6 dígitos).
// Siembra 3 convenios (cédula real con cero adelante, inventada y vacía), un
// asesor convenio y un comercial con una comisión PAGADA por convenio en un
// día aislado (2031), más una comisión de comercial sin convenio. Placas
// GZD9xx. Limpieza completa.
test.group('Cédula convenio en Excel de liquidación', (group) => {
  group.each.timeout(60_000)

  const DIA_CED = '2031-05-09'
  const CED_REAL = '0012345678'
  const CED_INVENTADA = '9999999901'
  const MONEY_FMT = '$#,##0'
  const CLAVES = ['REAL', 'INVENTADA', 'VACIA'] as const
  type Clave = (typeof CLAVES)[number]
  const ESPERADA_K: Record<Clave, string> = {
    REAL: CED_REAL,
    INVENTADA: 'Pendiente',
    VACIA: 'Pendiente',
  }

  let admin: Usuario
  let token = ''
  let agenteConvenio: AgenteCaptacion
  let agenteComercial: AgenteCaptacion
  const conv = {} as Record<Clave, number>
  // Comisiones por sección y convenio, para el body de exportar-placas.
  const comAc = {} as Record<Clave, number>
  const comCv = {} as Record<Clave, number>
  let comComercialSinConv = 0
  const convenioIds: number[] = []
  const comisionIds: number[] = []
  const dateoIds: number[] = []
  const placas: string[] = []
  let numero = 0

  const auth = () => ({ Authorization: `Bearer ${token}` })
  const base = () => `http://${process.env.HOST}:${process.env.PORT}/api/reportes-admin`

  /** Turno + dateo consumido + comisión PAGADA (lo mínimo que exige resolvePlacasPorComisionIds). */
  async function comision(
    asesorId: number,
    convenioId: number | null,
    montoAsesor: number,
    montoConvenio: number
  ) {
    numero++
    const placa = `GZD9${String(numero).padStart(2, '0')}`
    placas.push(placa)
    const t = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO_RTM,
      fecha: DateTime.fromISO(`${DIA_CED}T09:00:00`, { zone: 'America/Bogota' }),
      horaIngreso: '08:00',
      horaSalida: '09:00:00',
      tieneFacturacion: true,
      turnoNumero: -(9600 + numero),
      turnoNumeroServicio: -(9600 + numero),
      turnoCodigo: `GZD-CED-${placa}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
    } as any)
    const [dateoId] = await Database.table('captacion_dateos').insert({
      canal: 'ASESOR_CONVENIO',
      origen: 'UI',
      placa,
      agente_id: asesorId,
      convenio_id: convenioId,
      servicio_id: SERVICIO_RTM,
      resultado: 'EXITOSO',
      consumido_turno_id: t.id,
    })
    dateoIds.push(dateoId)
    const [id] = await Database.table('comisiones').insert({
      captacion_dateo_id: dateoId,
      asesor_id: asesorId,
      convenio_id: convenioId,
      tipo_servicio: 'RTM',
      tipo_vehiculo: 'VEHICULO',
      monto: montoAsesor + montoConvenio,
      monto_asesor: montoAsesor,
      monto_convenio: montoConvenio,
      estado: 'PAGADA',
      es_config: false,
      fecha_calculo: `${DIA_CED} 10:00:00`,
      created_at: `${DIA_CED} 10:00:00`,
      updated_at: `${DIA_CED} 10:00:00`,
    })
    comisionIds.push(id)
    return id
  }

  async function leerExcel(r: Response) {
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load((await r.arrayBuffer()) as any)
    return wb.worksheets[0]
  }
  const valores = (row: ExcelJS.Row) =>
    (row.values as any[]).slice(1).map((v) => String(v ?? ''))
  /** Fila (1-indexada) cuya primera celda es exactamente `texto`, a partir de `desde`. */
  function filaCon(ws: ExcelJS.Worksheet, texto: string, desde = 1): number {
    for (let i = desde; i <= ws.rowCount; i++) {
      if (String(ws.getRow(i).getCell(1).value ?? '') === texto) return i
    }
    return -1
  }
  /** Header y filas de una sección del Excel de liquidación (hasta la línea en blanco). */
  function filasSeccion(ws: ExcelJS.Worksheet, titulo: string) {
    const t = filaCon(ws, titulo)
    const header = valores(ws.getRow(t + 1))
    const filas: ExcelJS.Row[] = []
    for (let i = t + 2; i <= ws.rowCount; i++) {
      const row = ws.getRow(i)
      if (!row.getCell(1).value) break
      filas.push(row)
    }
    return { header, filas }
  }

  group.setup(async () => {
    const previos = await Database.from('convenios')
      .whereIn('doc_numero', [CED_REAL, CED_INVENTADA])
      .count('* as n')
    if (Number(previos[0].n) > 0) throw new Error('Cédulas de prueba ya existen: no se siembra.')
    const previosT = await Database.from('turnos_rtms').where('placa', 'like', 'GZD9%').count('* as n')
    if (Number(previosT[0].n) > 0) throw new Error('Placas GZD9xx ya existen: no se siembra.')

    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'CEDULA-CONVENIO',
      correo: `test.cedula.convenio.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    token = (await Usuario.accessTokens.create(admin)).value!.release()!
    agenteConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: 'TEST GZD ASESOR CONVENIO',
      activo: true,
    } as any)
    agenteComercial = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: 'TEST GZD COMERCIAL',
      activo: true,
    } as any)

    const docs: Record<Clave, string | null> = {
      REAL: CED_REAL,
      INVENTADA: CED_INVENTADA,
      VACIA: null,
    }
    for (const k of CLAVES) {
      const [id] = await Database.table('convenios').insert({
        tipo: 'PERSONA',
        nombre: `TEST GZD CONVENIO ${k}`,
        doc_tipo: docs[k] ? 'CC' : null,
        doc_numero: docs[k],
        activo: true,
        estado: 'ACTIVO',
      })
      conv[k] = id
      convenioIds.push(id)
    }

    // Montos distintos por convenio para ubicar cada fila.
    let m = 1
    for (const k of CLAVES) {
      comAc[k] = await comision(agenteConvenio.id, conv[k], 10_000 * m, 1_000 * m)
      comCv[k] = await comision(agenteComercial.id, conv[k], 0, 2_000 * m)
      m++
    }
    comComercialSinConv = await comision(agenteComercial.id, null, 7_000, 0)
  })

  group.teardown(async () => {
    if (comisionIds.length) await Database.from('comisiones').whereIn('id', comisionIds).delete()
    if (dateoIds.length) await Database.from('captacion_dateos').whereIn('id', dateoIds).delete()
    if (placas.length) await Database.from('turnos_rtms').whereIn('placa', placas).delete()
    if (convenioIds.length) await Database.from('convenios').whereIn('id', convenioIds).delete()
    if (agenteConvenio) await agenteConvenio.delete()
    if (agenteComercial) await agenteComercial.delete()
    if (admin) await admin.delete()
  })

  for (const [nombre, ruta] of [
    ['Liquidación RTM', 'liquidacion-rtm/excel'],
    ['Trazabilidad RTM', 'trazabilidad-rtm/excel'],
  ] as const) {
    test(`${nombre} Excel: columna "Cédula convenio" en Asesores Convenio y Convenios`, async ({
      assert,
    }) => {
      const qs = new URLSearchParams({ fecha_inicio: DIA_CED, fecha_fin: DIA_CED })
      const r = await fetch(`${base()}/${ruta}?${qs}`, { headers: auth() })
      assert.equal(r.status, 200)
      const ws = await leerExcel(r)

      // Secciones que no cambian: mismas columnas que antes.
      assert.deepEqual(filasSeccion(ws, 'Por canal de captación').header, [
        'Canal',
        'Turnos',
        'Monto',
        '%',
      ])
      const com = filasSeccion(ws, 'Asesores Comerciales')
      assert.deepEqual(com.header, ['Asesor', 'Turnos', 'Monto', 'Estados'])
      const filaCom = com.filas.find((f) => f.getCell(1).value === 'TEST GZD COMERCIAL')
      assert.exists(filaCom)
      // 4 turnos: sus 3 comisiones con convenio (monto asesor 0) + la de sin convenio.
      assert.deepEqual(valores(filaCom!), ['TEST GZD COMERCIAL', '4', '7000', 'PAGADA'])

      // Asesores Convenio: la cédula va en la col. 3, los montos se corren a 5 y 6.
      const ac = filasSeccion(ws, 'Asesores Convenio')
      assert.deepEqual(ac.header, [
        'Asesor',
        'Convenio',
        'Cédula convenio',
        'Turnos',
        'Monto asesor',
        'Monto convenio',
        'Estados',
      ])
      const filasAc = ac.filas.filter((f) => f.getCell(1).value === 'TEST GZD ASESOR CONVENIO')
      assert.lengthOf(filasAc, 3)
      let m = 1
      for (const k of CLAVES) {
        const f = filasAc.find((x) => x.getCell(2).value === `TEST GZD CONVENIO ${k}`)
        assert.exists(f, k)
        assert.strictEqual(f!.getCell(3).value, ESPERADA_K[k], k)
        assert.equal(f!.getCell(3).numFmt, '@')
        assert.equal(f!.getCell(4).value, 1)
        assert.equal(f!.getCell(5).value, 10_000 * m)
        assert.equal(f!.getCell(6).value, 1_000 * m)
        assert.equal(f!.getCell(7).value, 'PAGADA')
        m++
      }

      // Convenios: la cédula va en la col. 2, "Asesor comercial" pasa a la 3.
      const cv = filasSeccion(ws, 'Convenios')
      assert.deepEqual(cv.header, [
        'Convenio',
        'Cédula convenio',
        'Asesor comercial',
        'Turnos',
        'Monto convenio',
        'Estados',
      ])
      m = 1
      for (const k of CLAVES) {
        const f = cv.filas.find((x) => x.getCell(1).value === `TEST GZD CONVENIO ${k}`)
        assert.exists(f, k)
        assert.strictEqual(f!.getCell(2).value, ESPERADA_K[k], k)
        assert.equal(f!.getCell(2).numFmt, '@')
        assert.equal(f!.getCell(3).value, 'TEST GZD COMERCIAL')
        assert.equal(f!.getCell(4).value, 1)
        assert.equal(f!.getCell(5).value, 2_000 * m)
        assert.equal(f!.getCell(6).value, 'PAGADA')
        m++
      }
    })
  }

  test('Exportar placas: "Cédula convenio" en los resúmenes, demás columnas sin moverse', async ({
    assert,
  }) => {
    const body = {
      fecha_inicio: DIA_CED,
      fecha_fin: DIA_CED,
      secciones: {
        // Canal y Descuentos sin placas ese día: solo se valida su header.
        canal: [{ nombre: 'GRUPO CANAL', canal: 'FACHADA' }],
        descuentos: [{ nombre: 'GRUPO DESCUENTO', codigo: 'GZD-NO-EXISTE' }],
        comerciales: [{ nombre: 'GRUPO COMERCIAL', comision_ids: [comComercialSinConv] }],
        asesoresConvenio: CLAVES.map((k) => ({ nombre: `AC ${k}`, comision_ids: [comAc[k]] })),
        convenios: CLAVES.map((k) => ({
          nombre: `TEST GZD CONVENIO ${k}`,
          comision_ids: [comCv[k]],
        })),
      },
    }
    const r = await fetch(`${base()}/liquidacion-rtm/exportar-placas`, {
      method: 'POST',
      headers: { ...auth(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    assert.equal(r.status, 200)
    const ws = await leerExcel(r)
    const fila = (texto: string, desde: number) => {
      const i = filaCon(ws, texto, desde)
      assert.isAbove(i, 0, texto)
      return ws.getRow(i)
    }

    // Canal / Descuentos / Comerciales: headers de detalle y resumen intactos.
    const iCanal = filaCon(ws, 'POR CANAL DE CAPTACIÓN')
    assert.deepEqual(valores(ws.getRow(iCanal + 2)), ['Placa', 'Vehículo', 'Fecha pago', 'Monto'])
    const iDesc = filaCon(ws, 'DESCUENTOS APLICADOS')
    assert.deepEqual(valores(ws.getRow(iDesc + 2)), [
      'Placa',
      'Vehículo',
      'Convenio',
      'Fecha',
      'Monto descuento',
      'Comisión asesor',
      'Comisión convenio',
      'Regla aplicada',
      'Consecutivo del descuento',
    ])
    const iCom = filaCon(ws, 'ASESORES COMERCIALES')
    assert.deepEqual(valores(ws.getRow(iCom + 1)), ['Asesor', 'Turnos', 'Monto', 'Estados'])
    const resCom = ws.getRow(iCom + 2)
    assert.deepEqual(valores(resCom), ['GRUPO COMERCIAL', '1', '7000', 'PAGADA'])
    assert.equal(resCom.getCell(3).numFmt, MONEY_FMT)
    assert.deepEqual(valores(ws.getRow(iCom + 3)), [
      'Placa',
      'Vehículo',
      'Estado',
      'Fecha',
      'Clasificación',
      'Convenio',
      'Descuento',
      'Valor a pagar',
    ])
    assert.equal(ws.getRow(iCom + 4).getCell(8).value, 7_000)
    assert.equal(ws.getRow(iCom + 4).getCell(8).numFmt, MONEY_FMT)

    // Asesores Convenio: resumen con la cédula en la col. 3, montos en 5 y 6.
    const iAc = filaCon(ws, 'ASESORES CONVENIO')
    assert.deepEqual(valores(ws.getRow(iAc + 1)), [
      'Asesor',
      'Convenio',
      'Cédula convenio',
      'Turnos',
      'Monto asesor',
      'Monto convenio',
      'Estados',
    ])
    let m = 1
    for (const k of CLAVES) {
      const f = fila(`AC ${k}`, iAc)
      assert.equal(f.getCell(2).value, `TEST GZD CONVENIO ${k}`)
      assert.strictEqual(f.getCell(3).value, ESPERADA_K[k], k)
      assert.equal(f.getCell(3).numFmt, '@')
      assert.equal(f.getCell(4).value, 1)
      assert.equal(f.getCell(5).value, 10_000 * m)
      assert.equal(f.getCell(5).numFmt, MONEY_FMT)
      assert.equal(f.getCell(6).value, 1_000 * m)
      assert.equal(f.getCell(6).numFmt, MONEY_FMT)
      assert.equal(f.getCell(7).value, 'PAGADA')
      m++
    }
    // El detalle de placas de Asesores Convenio no cambia (10 columnas).
    assert.deepEqual(valores(ws.getRow(filaCon(ws, 'AC REAL', iAc) + 1)), [
      'Placa',
      'Vehículo',
      'Estado',
      'Fecha',
      'Clasificación',
      'Continuidad',
      'Medio de pago',
      'Descuento',
      'Valor a pagar (asesor)',
      'Valor a pagar (convenio)',
    ])

    // Convenios: resumen con la cédula en la col. 2, monto en la 5.
    const iCv = filaCon(ws, 'CONVENIOS')
    assert.deepEqual(valores(ws.getRow(iCv + 1)), [
      'Convenio',
      'Cédula convenio',
      'Asesor comercial',
      'Turnos',
      'Monto convenio',
      'Estados',
    ])
    m = 1
    for (const k of CLAVES) {
      const f = fila(`TEST GZD CONVENIO ${k}`, iCv)
      assert.strictEqual(f.getCell(2).value, ESPERADA_K[k], k)
      assert.equal(f.getCell(2).numFmt, '@')
      assert.equal(f.getCell(3).value, 'TEST GZD COMERCIAL')
      assert.equal(f.getCell(4).value, 1)
      assert.equal(f.getCell(5).value, 2_000 * m)
      assert.equal(f.getCell(5).numFmt, MONEY_FMT)
      assert.equal(f.getCell(6).value, 'PAGADA')
      m++
    }
    assert.deepEqual(valores(ws.getRow(filaCon(ws, 'TEST GZD CONVENIO REAL', iCv) + 1)), [
      'Placa',
      'Vehículo',
      'Estado',
      'Fecha',
      'Clasificación',
      'Medio de pago',
      'Descuento',
      'Valor a pagar',
    ])
  })
})
