import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import CaptacionDateo from '#models/captacion_dateo'
import {
  buildReserva,
  getHorasExclusividad,
  ttlPostConsumoDiasPorServicio,
} from '#services/reserva_dateo_service'
import { vigenciaDateoRtmSql } from '#services/telemercadeo_cola_service'

// Cola de Telemercadeo (GET /api/telemercadeo/cola, solo lectura). Escribe
// fixtures en la BD compartida: placas TLMV*/TLMC*/TLMP*, clientes con
// documento TLM-*, teléfonos 39900*, tickets con hash TLM-*. Limpieza al
// inicio (restos de una corrida fallida) y al final. Cada lista se aísla con
// q=TLMV (POR_VENCER) / q=TLMC (CLIENTES).

const SEDE_ID = 2
const SERVICIO_RTM = 1
const SERVICIO_PREV = 2
const ROL_SUPER_ADMIN = 9
const ROL_OPERATIVO_TURNOS = 14
const ZONA = 'America/Bogota'

const PLACAS = [
  ...['TLMV01', 'TLMV02', 'TLMV03', 'TLMV04', 'TLMV05', 'TLMV06'],
  ...['TLMC02', 'TLMC03X', 'TLMC07X', 'TLMC09', 'TLMC10X', 'TLMC11', 'TLMC12X', 'TLMC13'],
  ...['TLMC14', 'TLMC14X', 'TLMC15'],
  ...['TLMP00', 'TLMP01', 'TLMP02', 'TLMP03', 'TLMP04', 'TLMP05'],
]

async function limpiar() {
  const marks = PLACAS.map(() => '?').join(',')
  await Database.rawQuery(`DELETE FROM facturacion_tickets WHERE hash LIKE 'TLM-%'`)
  await Database.rawQuery(
    `DELETE FROM captacion_dateos WHERE placa IN (${marks}) OR telefono LIKE '39900%'`,
    PLACAS
  )
  await Database.rawQuery(
    `DELETE FROM turnos_rtms WHERE placa IN (${marks}) ORDER BY es_segunda_vez DESC, id DESC`,
    PLACAS
  )
  await Database.rawQuery(`DELETE FROM vehiculos WHERE placa IN (${marks})`, PLACAS)
  await Database.rawQuery(`DELETE FROM clientes WHERE doc_numero LIKE 'TLM-%'`)
}

test.group('Telemercadeo · cola de trabajo', (group) => {
  group.each.timeout(60_000)

  let admin: Usuario
  let operativo: Usuario
  let token = ''
  let tokenOperativo = ''
  let seq = 0

  const hoy = DateTime.now().setZone(ZONA).startOf('day')
  const hace = (meses: number, dias = 0) => hoy.minus({ months: meses }).minus({ days: dias })
  const auth = (t = token) => ({ Authorization: `Bearer ${t}` })

  const clientes: Record<string, number> = {}
  /** Dateos de la prueba de paridad, con la vigencia esperada. */
  const paridad: Array<{ caso: string; id: number; esperado: boolean }> = []

  async function cliente(clave: string, telefono: string) {
    const [id] = await Database.table('clientes').insert({
      nombre: `${clave.slice(0, 4)} Cliente ${clave}`,
      doc_tipo: 'CC',
      doc_numero: `TLM-${clave}`,
      telefono,
    })
    clientes[clave] = id
    return id
  }

  async function vehiculo(placa: string, clienteId: number | null) {
    await Database.table('vehiculos').insert({ placa, clase_vehiculo_id: 1, cliente_id: clienteId })
  }

  async function turno(
    placa: string,
    fecha: DateTime,
    o: {
      clienteId?: number | null
      servicioId?: number
      estado?: 'activo' | 'inactivo' | 'finalizado' | 'cancelado'
      segundaVezDe?: number
      resultado?: 'APROBADA' | 'RECHAZADA'
    } = {}
  ) {
    seq++
    const [id] = await Database.table('turnos_rtms').insert({
      funcionario_id: admin.id,
      sede_id: SEDE_ID,
      servicio_id: o.servicioId ?? SERVICIO_RTM,
      cliente_id: o.clienteId ?? null,
      fecha: fecha.toISODate(),
      hora_ingreso: '08:00:00',
      placa,
      tipo_vehiculo: 'Liviano Particular',
      turno_codigo: `TLM-${Date.now()}-${seq}`,
      turno_numero: 0,
      turno_numero_servicio: 0,
      estado: o.estado ?? 'finalizado',
      es_segunda_vez: o.segundaVezDe ? 1 : 0,
      turno_origen_id: o.segundaVezDe ?? null,
      resultado_certificacion: o.resultado ?? null,
    })
    return id
  }

  async function ticket(
    placa: string,
    fecha: DateTime,
    o: { clienteId?: number; docNumero?: string; turnoId?: number | null }
  ) {
    seq++
    await Database.table('facturacion_tickets').insert({
      hash: `TLM-${Date.now()}-${seq}`,
      file_path: 'tests/telemercadeo.jpg',
      estado: 'CONFIRMADA',
      servicio_codigo: 'RTM',
      placa,
      fecha_pago: `${fecha.toISODate()} 10:00:00`,
      cliente_id: o.clienteId ?? null,
      doc_tipo: o.docNumero ? 'CC' : null,
      doc_numero: o.docNumero ?? null,
      turno_id: o.turnoId ?? null,
    })
  }

  async function dateo(
    placa: string,
    o: {
      telefono?: string
      servicioId?: number
      resultado?: string
      liberado?: boolean
      creadoHaceHoras?: number
      redateadoHaceHoras?: number
      consumidoTurnoId?: number
      consumidoHaceDias?: number
    } = {}
  ) {
    const d = await CaptacionDateo.create({
      canal: 'FACHADA',
      origen: 'UI',
      placa,
      telefono: o.telefono ?? null,
      servicioId: o.servicioId ?? SERVICIO_RTM,
      resultado: o.resultado ?? 'PENDIENTE',
      liberado: o.liberado ?? false,
      consumidoTurnoId: o.consumidoTurnoId ?? null,
      consumidoAt:
        o.consumidoHaceDias !== undefined
          ? DateTime.now().minus({ days: o.consumidoHaceDias })
          : null,
    } as any)
    const ajustes: Record<string, Date> = {}
    if (o.creadoHaceHoras !== undefined) {
      ajustes.created_at = DateTime.now().minus({ hours: o.creadoHaceHoras }).toJSDate()
    }
    if (o.redateadoHaceHoras !== undefined) {
      ajustes.redateado_at = DateTime.now().minus({ hours: o.redateadoHaceHoras }).toJSDate()
    }
    if (Object.keys(ajustes).length) {
      await Database.from('captacion_dateos').where('id', d.id).update(ajustes)
    }
    return d.id
  }

  const cola = (client: any, qs: Record<string, unknown>, t = token) =>
    client
      .get('/api/telemercadeo/cola')
      .headers(auth(t))
      .qs({ per_page: 100, ...qs })

  group.setup(async () => {
    await limpiar()

    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'TELEMERCADEO',
      correo: `test.telemercadeo.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenAdmin = await Usuario.accessTokens.create(admin)
    token = tokenAdmin.value!.release()

    operativo = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'TELEMERCADEO-OPERATIVO',
      correo: `test.telemercadeo.op.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_OPERATIVO_TURNOS,
      sedeId: SEDE_ID,
    } as any)
    const tokenOp = await Usuario.accessTokens.create(operativo)
    tokenOperativo = tokenOp.value!.release()

    // ── POR_VENCER (q=TLMV), por placa ──
    const v1 = await cliente('TLMV01', '3990020001')
    await vehiculo('TLMV01', v1)
    await turno('TLMV01', hace(12).plus({ days: 10 }), { clienteId: v1, resultado: 'APROBADA' })

    // Vehículo sin dueño: el cliente sale del último RTM.
    const v2 = await cliente('TLMV02', '3990020002')
    await vehiculo('TLMV02', null)
    await turno('TLMV02', hace(12, 20), { clienteId: v2 }) // vencida hace ~20 días

    await turno('TLMV03', hace(12).plus({ days: 60 })) // vence en ~60 días: fuera
    await turno('TLMV04', hace(12).plus({ days: 5 }), { resultado: 'RECHAZADA' }) // no da vigencia

    await turno('TLMV05', hace(12).plus({ days: 8 }))
    await turno('TLMV05', hoy, { servicioId: SERVICIO_PREV, estado: 'activo' }) // turno hoy

    await turno('TLMV06', hace(12).plus({ days: 12 }))
    await dateo('TLMV06') // dateo RTM vigente

    // ── CLIENTES (q=TLMC). Turnos PREV para no caer en POR_VENCER. ──
    // (a) Turno por cliente_id; un cancelado y una segunda vez más recientes no cuentan.
    const c1 = await cliente('TLMC01', '3990040001')
    const origen = await turno('TLMC01', hace(3), { clienteId: c1, servicioId: SERVICIO_PREV })
    await turno('TLMC01', hace(1), {
      clienteId: c1,
      servicioId: SERVICIO_PREV,
      estado: 'cancelado',
    })
    await turno('TLMC01', hace(1).plus({ days: 2 }), {
      clienteId: c1,
      servicioId: SERVICIO_PREV,
      segundaVezDe: origen,
    })

    // (b) Turno sin cliente_id, ligado por placa al dueño actual.
    const c2 = await cliente('TLMC02', '3990040002')
    await vehiculo('TLMC02', c2)
    await turno('TLMC02', hace(8), { servicioId: SERVICIO_PREV })

    // (c) Ticket por documento cuyo turno se borró (turno_id → NULL por SET NULL).
    await cliente('TLMC03', '3990040003')
    const turnoBorrado = await turno('TLMC03X', hace(15), {
      servicioId: SERVICIO_PREV,
      estado: 'activo',
    })
    await ticket('TLMC03X', hace(15), { docNumero: 'TLM-TLMC03', turnoId: turnoBorrado })
    await Database.from('turnos_rtms').where('id', turnoBorrado).delete()

    // (c) Ticket por cliente_id sin turno.
    const c4 = await cliente('TLMC04', '3990040004')
    await ticket('TLMC04X', hace(30), { clienteId: c4 })

    // Dos fuentes: gana la más reciente (ticket 14 m sobre turno 30 m).
    const c5 = await cliente('TLMC05', '3990040005')
    await turno('TLMC05', hace(30), { clienteId: c5, servicioId: SERVICIO_PREV })
    await ticket('TLMC05X', hace(14), { clienteId: c5 })

    // Sin ninguna fecha.
    await cliente('TLMC06', '3990040006')

    // Ticket cuyo turno SÍ existe (activo, sin cliente): no cuenta → sin fecha.
    const c7 = await cliente('TLMC07', '3990040007')
    const turnoVivo = await turno('TLMC07X', hace(5), {
      servicioId: SERVICIO_PREV,
      estado: 'activo',
    })
    await ticket('TLMC07X', hace(5), { clienteId: c7, turnoId: turnoVivo })

    // 0-1 meses: solo en "Todos".
    const c8 = await cliente('TLMC08', '3990040008')
    await turno('TLMC08', hace(1), { clienteId: c8, servicioId: SERVICIO_PREV })

    // Exclusión: turno hoy por placa (turno sin cliente).
    const c9 = await cliente('TLMC09', '3990040009')
    await vehiculo('TLMC09', c9)
    await turno('TLMC09', hoy, { servicioId: SERVICIO_PREV, estado: 'activo' })

    // Exclusión: turno hoy por cliente_id (otra placa).
    const c10 = await cliente('TLMC10', '3990040010')
    await turno('TLMC10X', hoy, { clienteId: c10, servicioId: SERVICIO_PREV, estado: 'activo' })

    // Exclusión: dateo RTM vigente por placa.
    const c11 = await cliente('TLMC11', '3990040011')
    await vehiculo('TLMC11', c11)
    await dateo('TLMC11')

    // Exclusión: sin vehículo, dateo RTM vigente por teléfono.
    await cliente('TLMC12', '3990040012')
    await dateo('TLMC12X', { telefono: '3990040012' })

    // Dateo liberado (RE_DATEAR): NO excluye.
    const c13 = await cliente('TLMC13', '3990040013')
    await vehiculo('TLMC13', c13)
    await dateo('TLMC13', { resultado: 'RE_DATEAR', liberado: true })

    // Manda el ÚLTIMO dateo (placa o teléfono): el de la placa está vigente
    // pero uno más nuevo por teléfono ya venció → NO excluye.
    const c14 = await cliente('TLMC14', '3990040014')
    await vehiculo('TLMC14', c14)
    await dateo('TLMC14', { creadoHaceHoras: 2 })
    const turnoConsumo = await turno('TLMC14X', hace(24), { servicioId: SERVICIO_PREV })
    await dateo('TLMC14X', {
      telefono: '3990040014',
      resultado: 'EXITOSO',
      consumidoTurnoId: turnoConsumo,
      consumidoHaceDias: ttlPostConsumoDiasPorServicio('RTM') + 30,
    })

    // Dateo vigente de otro servicio (PREV): NO excluye (solo RTM).
    const c15 = await cliente('TLMC15', '3990040015')
    await vehiculo('TLMC15', c15)
    await dateo('TLMC15', { servicioId: SERVICIO_PREV })

    // ── Paridad SQL ↔ buildReserva (placas TLMP*) ──
    const horas = await getHorasExclusividad()
    const ttl = ttlPostConsumoDiasPorServicio('RTM')
    const turnoP = await turno('TLMP00', hace(24), { servicioId: SERVICIO_PREV })
    paridad.push(
      {
        caso: 'consumido reciente',
        esperado: true,
        id: await dateo('TLMP01', { consumidoTurnoId: turnoP, consumidoHaceDias: 10 }),
      },
      {
        caso: 'consumido viejo',
        esperado: false,
        id: await dateo('TLMP02', { consumidoTurnoId: turnoP, consumidoHaceDias: ttl + 30 }),
      },
      {
        caso: 'no consumido reciente',
        esperado: true,
        id: await dateo('TLMP03', { creadoHaceHoras: 1 }),
      },
      {
        caso: 'no consumido viejo',
        esperado: false,
        id: await dateo('TLMP04', { creadoHaceHoras: horas + 24 }),
      },
      {
        caso: 'redateado',
        esperado: true,
        id: await dateo('TLMP05', { creadoHaceHoras: horas + 24, redateadoHaceHoras: 1 }),
      }
    )
  })

  group.teardown(async () => {
    await limpiar()
    if (admin) await admin.delete()
    if (operativo) await operativo.delete()
  })

  test('sin sesión responde 401 y un rol no permitido 403', async ({ client }) => {
    const sin = await client.get('/api/telemercadeo/cola')
    sin.assertStatus(401)
    const op = await cola(client, { lista: 'CLIENTES' }, tokenOperativo)
    op.assertStatus(403)
  })

  test('parámetros inválidos responden 400', async ({ client }) => {
    const lista = await cola(client, { lista: 'DORMIDOS' })
    lista.assertStatus(400)
    const rango = await cola(client, { lista: 'CLIENTES', rango: 'PROXIMAS' })
    rango.assertStatus(400)
    const orden = await cola(client, { lista: 'CLIENTES', orden: 'OTRO' })
    orden.assertStatus(400)
  })

  test('paridad: la vigencia en SQL coincide con buildReserva en los 5 casos', async ({
    assert,
  }) => {
    const vig = await vigenciaDateoRtmSql('d', new Date())
    const ids = paridad.map((p) => p.id)
    const [rows] = await Database.rawQuery(
      `SELECT d.id, ${vig.sql} AS vig FROM captacion_dateos d WHERE d.id IN (${ids.map(() => '?').join(',')})`,
      [...vig.bindings, ...ids]
    )
    const sql = new Map((rows as any[]).map((r) => [r.id, Number(r.vig) === 1]))

    assert.lengthOf(paridad, 5)
    for (const p of paridad) {
      const d = await CaptacionDateo.findOrFail(p.id)
      const reserva = await buildReserva(d)
      assert.equal(reserva.vigente, p.esperado, `buildReserva · ${p.caso}`)
      assert.equal(sql.get(p.id), reserva.vigente, `SQL = buildReserva · ${p.caso}`)
    }
  })

  test('CLIENTES: última visita real por fuente, contadores y exclusiones', async ({
    client,
    assert,
  }) => {
    const res = await cola(client, { lista: 'CLIENTES', q: 'TLMC' })
    res.assertStatus(200)
    const { data, meta } = res.body()

    assert.deepEqual(meta.contadores.CLIENTES, {
      'total': 11,
      '0_1': 1,
      '2_5': 1,
      '6_11': 1,
      '12_23': 2,
      '24_MAS': 1,
      'SIN_FECHA': 5,
    })
    assert.equal(meta.total, 11)

    const fila = (clave: string) => data.find((f: any) => f.cliente_id === clientes[clave])

    assert.include(fila('TLMC01'), {
      fuente_ultima_visita: 'TURNO_CLIENTE',
      ultima_visita: hace(3).toISODate(),
      meses_transcurridos: 3,
      rango: '2_5',
    })
    assert.include(fila('TLMC02'), {
      fuente_ultima_visita: 'TURNO_PLACA',
      ultima_visita: hace(8).toISODate(),
      rango: '6_11',
    })
    assert.deepEqual(fila('TLMC02').placas, ['TLMC02'])
    assert.include(fila('TLMC03'), {
      fuente_ultima_visita: 'TICKET',
      ultima_visita: hace(15).toISODate(),
      rango: '12_23',
    })
    assert.include(fila('TLMC04'), { fuente_ultima_visita: 'TICKET', rango: '24_MAS' })
    assert.include(fila('TLMC05'), {
      fuente_ultima_visita: 'TICKET',
      ultima_visita: hace(14).toISODate(),
      rango: '12_23',
    })
    assert.include(fila('TLMC06'), {
      fuente_ultima_visita: null,
      ultima_visita: null,
      meses_transcurridos: null,
      rango: 'SIN_FECHA',
    })
    assert.include(fila('TLMC07'), { rango: 'SIN_FECHA' }, 'ticket con turno vivo no cuenta')
    assert.include(fila('TLMC08'), { rango: '0_1' })
    assert.equal(fila('TLMC01').documento, 'CC TLM-TLMC01')

    const ids = data.map((f: any) => f.cliente_id)
    assert.notInclude(ids, clientes.TLMC09, 'turno hoy por placa excluye')
    assert.notInclude(ids, clientes.TLMC10, 'turno hoy por cliente excluye')
    assert.notInclude(ids, clientes.TLMC11, 'dateo vigente por placa excluye')
    assert.notInclude(ids, clientes.TLMC12, 'dateo vigente por teléfono excluye')
    assert.include(ids, clientes.TLMC13, 'dateo liberado no excluye')
    assert.include(ids, clientes.TLMC14, 'manda el último dateo (vencido)')
    assert.include(ids, clientes.TLMC15, 'dateo de otro servicio no excluye')
  })

  test('CLIENTES: filtro por rango, orden y paginado en servidor', async ({ client, assert }) => {
    const ids = (body: any) => body.data.map((f: any) => f.cliente_id)

    const r12 = await cola(client, { lista: 'CLIENTES', q: 'TLMC', rango: '12_23' })
    assert.sameMembers(ids(r12.body()), [clientes.TLMC03, clientes.TLMC05])
    assert.equal(r12.body().meta.total, 2)

    const sinFecha = await cola(client, { lista: 'CLIENTES', q: 'TLMC', rango: 'SIN_FECHA' })
    assert.sameMembers(ids(sinFecha.body()), [
      clientes.TLMC06,
      clientes.TLMC07,
      clientes.TLMC13,
      clientes.TLMC14,
      clientes.TLMC15,
    ])

    const conFecha = [
      clientes.TLMC04,
      clientes.TLMC03,
      clientes.TLMC05,
      clientes.TLMC02,
      clientes.TLMC01,
      clientes.TLMC08,
    ]
    const antig = await cola(client, { lista: 'CLIENTES', q: 'TLMC' })
    assert.deepEqual(ids(antig.body()).slice(0, 6), conFecha, 'más tiempo sin venir primero')
    assert.equal(antig.body().data[6].rango, 'SIN_FECHA', 'sin fecha al final')

    const reciente = await cola(client, { lista: 'CLIENTES', q: 'TLMC', orden: 'RECIENTE' })
    assert.deepEqual(ids(reciente.body()).slice(0, 6), [...conFecha].reverse())

    const p1 = await cola(client, { lista: 'CLIENTES', q: 'TLMC', per_page: 4, page: 1 })
    const p3 = await cola(client, { lista: 'CLIENTES', q: 'TLMC', per_page: 4, page: 3 })
    assert.deepEqual(ids(p1.body()), conFecha.slice(0, 4))
    assert.lengthOf(p3.body().data, 3)
    assert.equal(p1.body().meta.last_page, 3)
    assert.equal(p1.body().meta.contadores.CLIENTES.total, 11)
  })

  test('CLIENTES: búsqueda por documento, placa y teléfono', async ({ client, assert }) => {
    const ids = (body: any) => body.data.map((f: any) => f.cliente_id)

    const porDoc = await cola(client, { lista: 'CLIENTES', q: 'tlm-tlmc03' })
    assert.deepEqual(ids(porDoc.body()), [clientes.TLMC03])

    const porPlaca = await cola(client, { lista: 'CLIENTES', q: 'TLMC02' })
    assert.include(ids(porPlaca.body()), clientes.TLMC02)

    const porTel = await cola(client, { lista: 'CLIENTES', q: '3990040004' })
    assert.deepEqual(ids(porTel.body()), [clientes.TLMC04])
  })

  test('POR_VENCER: por placa, próximas y vencidas, con exclusiones', async ({
    client,
    assert,
  }) => {
    const res = await cola(client, { lista: 'POR_VENCER', q: 'TLMV' })
    res.assertStatus(200)
    const { data, meta } = res.body()

    assert.deepEqual(meta.contadores.POR_VENCER, { total: 2, PROXIMAS: 1, VENCIDAS: 1 })
    assert.sameMembers(
      data.map((f: any) => f.placa),
      ['TLMV01', 'TLMV02']
    )

    const v1 = data.find((f: any) => f.placa === 'TLMV01')
    const venceV1 = hace(12).plus({ days: 10 }).plus({ months: 12 })
    assert.equal(v1.rango, 'PROXIMAS')
    assert.equal(v1.vence_el, venceV1.toISODate())
    assert.equal(v1.puede_datear_desde, venceV1.minus({ days: 16 }).toISODate())
    assert.equal(v1.cliente_id, clientes.TLMV01)

    const v2 = data.find((f: any) => f.placa === 'TLMV02')
    assert.equal(v2.rango, 'VENCIDAS')
    assert.isBelow(v2.dias_para_vencer, 0)
    assert.equal(v2.cliente_id, clientes.TLMV02, 'sin dueño: cliente del último RTM')

    const vencidas = await cola(client, { lista: 'POR_VENCER', q: 'TLMV', rango: 'VENCIDAS' })
    assert.deepEqual(
      vencidas.body().data.map((f: any) => f.placa),
      ['TLMV02']
    )
  })
})
