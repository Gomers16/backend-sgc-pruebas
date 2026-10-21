import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import FacturacionTicket from '#models/facturacion_ticket'
import Comision from '#models/comision'

// Una sola fuente: lo que muestra el diálogo de Facturación al editar el
// descuento (solo_previsualizar → comision.desglose), lo que queda guardado
// al editar y lo que devuelve GET /comisiones/:id (montos y desglose_motor)
// salen del mismo planearRecalculoComision(). Casos 1, 2 y 3, el estimado
// de un ticket sin comisión y los avisos de configuración en 0.
// Todo lo creado aquí se borra en el teardown (por placa y por usuario).

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const AGENTE_COMERCIAL_ID = 1
const ROL_SUPER_ADMIN = 9
const DESCUENTO = { INFORMATIVO: 1, EMPLEADO: 3, OBSEQUIO: 6 }
const FIJO_EMPLEADO = 60000

const PLACAS = Array.from({ length: 10 }, (_, i) => `TDG${String(900 + i)}`)
const RUN = Date.now().toString(36).toUpperCase()
const cd = (sufijo: string) => `DSG-${RUN}-${sufijo}`

type Caso = 'SIN_CONVENIO' | 'CONVENIO_COMERCIAL' | 'CONVENIO_SELF'

test.group('Comisiones: desglose del motor = previsualización = guardado = GET', (group) => {
  let admin: Usuario
  let token = ''
  let convenioAsesor: AgenteCaptacion
  let convenio: Convenio
  let turnoNumero = 970000 + Math.floor(Math.random() * 9000)

  group.setup(async () => {
    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'DESGLOSE-ADMIN',
      correo: `test.desglose.admin.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(admin)
    token = tokenObj.value!.release()
    convenioAsesor = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST DESGLOSE CONVENIO ASESOR ${RUN}`,
      activo: true,
    } as any)
    convenio = await Convenio.create({
      tipo: 'TALLER',
      nombre: `TEST DESGLOSE CONVENIO ${RUN}`,
      activo: true,
      estado: 'ACTIVO',
      asesorConvenioId: convenioAsesor.id,
    } as any)
  })

  group.teardown(async () => {
    const ph = PLACAS.map(() => '?').join(', ')
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${ph}))`,
      PLACAS
    )
    // facturacion_descuento_ediciones cae por ON DELETE CASCADE.
    await Database.rawQuery(`DELETE FROM facturacion_tickets WHERE placa IN (${ph})`, PLACAS)
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${ph})`, PLACAS)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${ph})`, PLACAS)
    if (convenio) await Database.rawQuery('DELETE FROM convenios WHERE id = ?', [convenio.id])
    if (convenioAsesor)
      await Database.rawQuery('DELETE FROM agentes_captacions WHERE id = ?', [convenioAsesor.id])
    if (admin) await admin.delete()
  })

  /** Ticket RTM (CONFIRMADA por la API salvo `sinConfirmar`) con dateo del caso. */
  async function crearTicket(client: any, placa: string, caso: Caso, sinConfirmar = false) {
    const dateo = await CaptacionDateo.create({
      canal: caso === 'CONVENIO_SELF' ? 'ASESOR_CONVENIO' : 'ASESOR_COMERCIAL',
      agenteId: caso === 'CONVENIO_SELF' ? convenioAsesor.id : AGENTE_COMERCIAL_ID,
      convenioId: caso === 'SIN_CONVENIO' ? null : convenio.id,
      asesorConvenioId: caso === 'SIN_CONVENIO' ? null : convenioAsesor.id,
      placa,
      servicioId: SERVICIO_RTM_ID,
      origen: 'UI',
      resultado: 'EN_PROCESO',
      descuentoId: null,
    } as any)
    turnoNumero += 1
    const turno = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: DateTime.now(),
      horaIngreso: '08:00:00',
      turnoNumero,
      turnoNumeroServicio: turnoNumero,
      turnoCodigo: `RTM-DSG-${RUN}-${turnoNumero}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      tieneFacturacion: false,
      captacionDateoId: dateo.id,
    } as any)
    dateo.consumidoTurnoId = turno.id
    dateo.consumidoAt = DateTime.now()
    await dateo.save()

    const ticket = await FacturacionTicket.create({
      hash: `test-hash-dsg-${placa}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa,
      total: 200000,
      totalFactura: 200000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      agenteId: dateo.agenteId,
      turnoId: turno.id,
      dateoId: dateo.id,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      tipoVehiculoSnapshot: 'Liviano Particular',
    } as any)
    if (!sinConfirmar) {
      const res = await client
        .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
        .header('Authorization', `Bearer ${token}`)
        .json({})
      if (res.status() !== 200) throw new Error(`confirmar ${placa}: ${res.status()} ${res.text()}`)
    }
    const comision = await Comision.query()
      .where('captacion_dateo_id', dateo.id)
      .where('es_config', false)
      .first()
    return { ticket, comision }
  }

  const bodyDescuento = (descuentoId: number, monto: number, sufijo: string) => ({
    descuento_id: descuentoId,
    descuento_monto_aplicado: monto,
    autorizado_por_id: admin.id,
    consecutivo_descuento: cd(sufijo),
  })

  const previsualizar = (client: any, id: number, body: Record<string, unknown>) =>
    client
      .patch(`/api/facturacion/tickets/${id}`)
      .header('Authorization', `Bearer ${token}`)
      .json({ ...body, solo_previsualizar: true })

  /** Previsualiza, guarda y compara las tres lecturas del mismo cálculo. */
  async function editarYComparar(
    assert: any,
    client: any,
    ticketId: number,
    comisionId: number,
    body: Record<string, unknown>
  ) {
    const previa = await previsualizar(client, ticketId, body)
    assert.equal(previa.status(), 200, previa.text())
    const p = previa.body().comision
    assert.isNotNull(p.desglose)
    assert.isFalse(p.desglose.estimado)
    assert.isTrue(p.desglose.recalculado)
    const porRol = (d: any, rol: string) => d.beneficiarios.find((b: any) => b.rol === rol)

    const guardar = await client
      .patch(`/api/facturacion/tickets/${ticketId}`)
      .header('Authorization', `Bearer ${token}`)
      .json({ ...body, motivo_edicion: 'Prueba de desglose de comisión' })
    assert.equal(guardar.status(), 200, guardar.text())

    const fila = await Database.from('comisiones').where('id', comisionId).first()
    assert.equal(Number(fila.monto_asesor), p.despues.montoAsesor)
    assert.equal(Number(fila.monto_convenio), p.despues.montoConvenio)
    assert.equal(fila.regla_aplicada, p.desglose.regla)

    const get = await client
      .get(`/api/comisiones/${comisionId}`)
      .header('Authorization', `Bearer ${token}`)
    assert.equal(get.status(), 200, get.text())
    const g = get.body()
    assert.equal(Number(g.monto_asesor), p.despues.montoAsesor)
    assert.equal(Number(g.monto_convenio), p.despues.montoConvenio)
    assert.equal(g.regla_aplicada, p.desglose.regla)
    assert.equal(g.caso, p.desglose.caso)
    // El desglose de Comisiones es el mismo cálculo, con lo guardado como "antes".
    const m = g.desglose_motor
    assert.isNotNull(m, g.desglose_motivo)
    assert.equal(m.regla, p.desglose.regla)
    assert.equal(m.caso, p.desglose.caso)
    for (const b of p.desglose.beneficiarios) {
      assert.equal(porRol(m, b.rol).despues, b.despues, b.rol)
      assert.equal(porRol(m, b.rol).antes, b.despues, `${b.rol}: guardado = previsualizado`)
    }
    assert.notExists(m.alertas.find((a: any) => a.codigo === 'DISTINTO_AL_MOTOR'))
    return p.desglose
  }

  test('Caso 1: agregar Informativo → previsualización = guardado = GET /comisiones/:id', async ({
    assert,
    client,
  }) => {
    const { ticket, comision } = await crearTicket(client, PLACAS[0], 'SIN_CONVENIO')
    assert.exists(comision)
    const d = await editarYComparar(
      assert,
      client,
      ticket.id,
      comision!.id,
      bodyDescuento(DESCUENTO.INFORMATIVO, 20000, 'C1')
    )
    assert.equal(d.caso, 'SIN_CONVENIO')
    assert.equal(d.casoTexto, 'Asesor comercial sin convenio')
    assert.equal(d.descuento.codigo, 'INFORMATIVO')
    assert.equal(d.descuento.origen, 'CAJA')
    assert.lengthOf(d.beneficiarios, 1)
    assert.equal(d.beneficiarios[0].rol, 'ASESOR_COMERCIAL')
    assert.equal(d.beneficiarios[0].id, AGENTE_COMERCIAL_ID)
    assert.isString(d.beneficiarios[0].nombre)
    const usado = d.configuracion.find((v: any) => v.usado)
    assert.equal(usado.campo, 'valorRecurrente')
    assert.equal(d.beneficiarios[0].despues, usado.valor)
    assert.notInclude(d.explicacion, 'valor básico de dateo')
  }).timeout(60000)

  test('Caso 3: informativo especial en caja → convenio $0; mismo valor en las 3 lecturas', async ({
    assert,
    client,
  }) => {
    const { ticket, comision } = await crearTicket(client, PLACAS[1], 'CONVENIO_COMERCIAL')
    const d = await editarYComparar(
      assert,
      client,
      ticket.id,
      comision!.id,
      bodyDescuento(DESCUENTO.EMPLEADO, FIJO_EMPLEADO, 'C3')
    )
    assert.equal(d.caso, 'CONVENIO_COMERCIAL')
    const conv = d.beneficiarios.find((b: any) => b.rol === 'CONVENIO')
    assert.equal(conv.id, convenio.id)
    assert.equal(conv.cobraAsesorConvenio.id, convenioAsesor.id)
    assert.equal(conv.despues, 0)
    assert.include(d.explicacion, 'convenio queda en $0')
    assert.equal(d.continuidad.aplica, true)
    assert.isNotNull(d.continuidad.estado)
  }).timeout(60000)

  test('Caso 2: el asesor convenio se datea; obsequio en caja → $0 y avisos de configuración', async ({
    assert,
    client,
  }) => {
    const { ticket, comision } = await crearTicket(client, PLACAS[2], 'CONVENIO_SELF')
    // Abrir el diálogo sin cambiar nada también muestra la comisión.
    const abrir = await previsualizar(client, ticket.id, {})
    assert.equal(abrir.status(), 200, abrir.text())
    const d0 = abrir.body().comision.desglose
    assert.equal(d0.caso, 'CONVENIO_SELF')
    assert.equal(d0.beneficiarios[0].rol, 'ASESOR_CONVENIO')
    assert.equal(d0.beneficiarios[0].id, convenioAsesor.id)
    assert.equal(d0.beneficiarios[0].antes, Number(comision!.montoAsesor))
    // Un valor usado en 0 (p. ej. la base Global) siempre trae su aviso.
    const enCero = d0.configuracion.filter((v: any) => v.usado && v.valor === 0)
    const avisos = d0.alertas.filter((a: any) => a.codigo === 'CONFIG_EN_CERO')
    assert.equal(avisos.length, enCero.length)

    const d = await editarYComparar(
      assert,
      client,
      ticket.id,
      comision!.id,
      bodyDescuento(DESCUENTO.OBSEQUIO, 0, 'C2')
    )
    assert.equal(d.beneficiarios[0].despues, 0)
    assert.include(d.regla, 'INFORMATIVO_OBSEQUIO aplicado en caja')
    assert.deepEqual(
      d.configuracion.filter((v: any) => v.usado),
      [],
      'la regla deja todo en $0: ningún valor de configuración paga'
    )
    assert.notExists(d.alertas.find((a: any) => a.codigo === 'CONFIG_EN_CERO'))
  }).timeout(60000)

  test('ticket sin comisión todavía → desglose ESTIMADO con el mismo motor', async ({
    assert,
    client,
  }) => {
    const { ticket, comision } = await crearTicket(client, PLACAS[3], 'SIN_CONVENIO', true)
    assert.notExists(comision)
    const res = await previsualizar(
      client,
      ticket.id,
      bodyDescuento(DESCUENTO.INFORMATIVO, 10000, 'EST')
    )
    assert.equal(res.status(), 200, res.text())
    const c = res.body().comision
    assert.equal(c.accion, 'SIN_COMISION')
    assert.isTrue(c.desglose.estimado)
    assert.isNull(c.desglose.beneficiarios[0].antes)
    assert.exists(c.desglose.alertas.find((a: any) => a.codigo === 'ESTIMADO'))
    const usado = c.desglose.configuracion.find((v: any) => v.usado)
    assert.equal(c.desglose.beneficiarios[0].despues, usado.valor)
    // Previsualizar no escribe nada en el ticket sin confirmar.
    const fila = await Database.from('facturacion_tickets').where('id', ticket.id).first()
    assert.equal(fila.estado, 'BORRADOR')
    assert.isNull(fila.descuento_id)
    assert.isNull(fila.consecutivo_descuento)
  }).timeout(60000)

  test('GET /comisiones devuelve caso y regla_aplicada en cada fila', async ({
    assert,
    client,
  }) => {
    const { comision } = await crearTicket(client, PLACAS[4], 'CONVENIO_COMERCIAL')
    const res = await client
      .get('/api/comisiones')
      .qs({ placa: PLACAS[4] })
      .header('Authorization', `Bearer ${token}`)
    assert.equal(res.status(), 200, res.text())
    const fila = res.body().data.find((r: any) => r.id === comision!.id)
    assert.equal(fila.caso, 'CONVENIO_COMERCIAL')
    assert.equal(fila.caso_texto, 'Asesor comercial con convenio')
    assert.equal(fila.regla_aplicada, comision!.reglaAplicada)
    assert.isString(fila.regla_aplicada)
  }).timeout(60000)
})
