import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import FacturacionTicket from '#models/facturacion_ticket'
import Comision from '#models/comision'

// Consecutivo del descuento en las pantallas que NO parten del ticket
// (comisiones, dateos, ficha del asesor, historial de descuentos, Liquidación
// RTM, Meta Comercial). Se lee siempre del ticket CONFIRMADA del turno; sin
// ticket o con ticket anterior a la función → null. La subconsulta no debe
// duplicar filas aunque el turno tenga dos tickets CONFIRMADA.
//
// Ids sembrados en la BD de pruebas (mismos que descuento_caja_sync.spec.ts).
const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN_ID = 9
const AGENTE_COMERCIAL_ID = 1
const DESCUENTO_INFORMATIVO_ID = 1

const PLACAS = {
  conConsecutivo: 'TCD951',
  ticketAntiguo: 'TCD952',
  sinFacturar: 'TCD953',
}
const TODAS = Object.values(PLACAS)

test.group('Consecutivo del descuento en lecturas (comisiones, dateos, reportes)', (group) => {
  let usuarioTest: Usuario
  let token: string
  const hoy = DateTime.now().setZone('America/Bogota')
  const CONSEC = `TCD-LECT-${Date.now()}`

  group.setup(async () => {
    usuarioTest = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'CONSECUTIVO-LECTURAS',
      correo: `test.consecutivo.lecturas.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuarioTest)
    token = tokenObj.value!.release()
  })

  group.teardown(async () => {
    const ph = TODAS.map(() => '?').join(', ')
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${ph}))`,
      TODAS
    )
    await Database.rawQuery(`DELETE FROM facturacion_tickets WHERE placa IN (${ph})`, TODAS)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${ph})`, TODAS)
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${ph})`, TODAS)
    if (usuarioTest) await usuarioTest.delete()
  })

  const get = (client: any, url: string, qs: Record<string, unknown> = {}) =>
    client.get(url).qs(qs).header('Authorization', `Bearer ${token}`)

  async function crearDateoConTurno(placa: string, turnoNumero: number) {
    const dateo = await CaptacionDateo.create({
      canal: 'ASESOR_COMERCIAL',
      agenteId: AGENTE_COMERCIAL_ID,
      convenioId: null,
      placa,
      servicioId: SERVICIO_RTM_ID,
      origen: 'UI',
      resultado: 'EN_PROCESO',
      descuentoId: DESCUENTO_INFORMATIVO_ID,
    } as any)
    const turno = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuarioTest.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: DateTime.now(),
      horaIngreso: '08:00:00',
      turnoNumero,
      turnoNumeroServicio: turnoNumero,
      turnoCodigo: `RTM-TEST-${turnoNumero}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      tieneFacturacion: false,
      captacionDateoId: dateo.id,
    } as any)
    dateo.consumidoTurnoId = turno.id
    dateo.consumidoAt = DateTime.now()
    await dateo.save()
    return { dateo, turno }
  }

  function datosTicket(placa: string, turnoId: number, extra: Record<string, unknown> = {}) {
    return {
      hash: `test-hash-lect-${placa}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa,
      total: 200000,
      totalFactura: 200000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      agenteId: AGENTE_COMERCIAL_ID,
      turnoId,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      descuentoId: DESCUENTO_INFORMATIVO_ID,
      descuentoMontoAplicado: 5000,
      ...extra,
    } as any
  }

  test('ticket confirmado con consecutivo: se ve en todas las lecturas y no duplica filas', async ({
    assert,
    client,
  }) => {
    const { dateo, turno } = await crearDateoConTurno(PLACAS.conConsecutivo, 900951)
    const ticket = await FacturacionTicket.create(
      datosTicket(PLACAS.conConsecutivo, turno.id, { consecutivoDescuento: CONSEC })
    )
    const conf = await client
      .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})
    assert.equal(conf.status(), 200)

    // Meta Comercial solo lista dateos EXITOSO; se fija explícito.
    await CaptacionDateo.query().where('id', dateo.id).update({ resultado: 'EXITOSO' })

    const comision = await Comision.query()
      .where('captacion_dateo_id', dateo.id)
      .where('es_config', false)
      .firstOrFail()

    // Comisiones: detalle y lista
    const show = await get(client, `/api/comisiones/${comision.id}`)
    assert.equal(show.status(), 200)
    assert.equal(show.body().consecutivo_descuento, CONSEC)

    const lista = await get(client, '/api/comisiones', { placa: PLACAS.conConsecutivo })
    const filasLista = lista.body().data as any[]
    const filaLista = filasLista.find((r) => r.id === comision.id)
    assert.exists(filaLista)
    assert.equal(filaLista.consecutivo_descuento, CONSEC)

    // Dateos: lista y detalle
    const dateos = await get(client, '/api/captacion-dateos', { placa: PLACAS.conConsecutivo })
    const filaDateo = (dateos.body().data as any[]).find((r) => r.id === dateo.id)
    assert.equal(filaDateo.consecutivo_descuento, CONSEC)

    const dateoShow = await get(client, `/api/captacion-dateos/${dateo.id}`)
    assert.equal(dateoShow.body().consecutivo_descuento, CONSEC)

    // Ficha del asesor
    const ficha = await get(client, `/api/agentes-captacion/${AGENTE_COMERCIAL_ID}/dateos-comisiones`, {
      desde: hoy.toISODate(),
      hasta: hoy.toISODate(),
      perPage: 500,
    })
    const filaFicha = (ficha.body().data as any[]).find((r) => r.id === dateo.id)
    assert.exists(filaFicha)
    assert.equal(filaFicha.consecutivo_descuento, CONSEC)

    // Historial de descuentos
    const historial = await get(client, '/api/descuentos/historial', {
      placa: PLACAS.conConsecutivo,
      fecha_desde: hoy.toISODate(),
      fecha_hasta: hoy.toISODate(),
    })
    const filaHist = (historial.body().data as any[]).find((r) => r.ticket_id === ticket.id)
    assert.equal(filaHist.consecutivo_descuento, CONSEC)

    // Liquidación RTM: placas de la comisión y de la sección Descuentos
    const placasCom = await get(client, '/api/reportes-admin/liquidacion-rtm/detalle-placas', {
      comision_ids: String(comision.id),
    })
    assert.lengthOf(placasCom.body().placas, 1)
    assert.equal(placasCom.body().placas[0].consecutivo_descuento, CONSEC)

    const placasDesc = await get(client, '/api/reportes-admin/liquidacion-rtm/detalle-placas-descuento', {
      codigo: 'INFORMATIVO',
      fecha_inicio: hoy.toISODate(),
      fecha_fin: hoy.toISODate(),
    })
    const filaDesc = (placasDesc.body().placas as any[]).find((r) => r.ticket_id === ticket.id)
    assert.equal(filaDesc.consecutivo_descuento, CONSEC)

    // Meta Comercial → Ingreso real por dateo
    const meta = await get(client, '/api/reportes-admin/meta-comercial/ingreso-real-dateo', {
      asesor_id: AGENTE_COMERCIAL_ID,
      mes: hoy.month,
      anio: hoy.year,
    })
    assert.equal(meta.status(), 200)
    const filaMeta = (meta.body().detalle as any[]).find((r) => r.dateo_id === dateo.id)
    assert.equal(filaMeta.consecutivo_descuento, CONSEC)

    // Segundo ticket CONFIRMADA en el mismo turno (la BD no lo impide):
    // sigue una sola fila y gana el más reciente (mayor id).
    const CONSEC_2 = `${CONSEC}-B`
    await FacturacionTicket.create(
      datosTicket(PLACAS.conConsecutivo, turno.id, {
        estado: 'CONFIRMADA',
        confirmadoAt: DateTime.now(),
        consecutivoDescuento: CONSEC_2,
      })
    )
    const placasCom2 = await get(client, '/api/reportes-admin/liquidacion-rtm/detalle-placas', {
      comision_ids: String(comision.id),
    })
    assert.lengthOf(placasCom2.body().placas, 1, 'la subconsulta no duplica la fila')
    assert.equal(placasCom2.body().placas[0].consecutivo_descuento, CONSEC_2)

    const show2 = await get(client, `/api/comisiones/${comision.id}`)
    assert.equal(show2.body().consecutivo_descuento, CONSEC_2)

    const dateos2 = await get(client, '/api/captacion-dateos', { placa: PLACAS.conConsecutivo })
    const filasDateo2 = (dateos2.body().data as any[]).filter((r) => r.id === dateo.id)
    assert.lengthOf(filasDateo2, 1)
    assert.equal(filasDateo2[0].consecutivo_descuento, CONSEC_2)
  }).timeout(30000)

  test('ticket anterior a la función (sin consecutivo) y dateo sin facturar: null, sin errores', async ({
    assert,
    client,
  }) => {
    // Ticket "antiguo": CONFIRMADA directo en BD, sin consecutivo.
    const antiguo = await crearDateoConTurno(PLACAS.ticketAntiguo, 900952)
    const ticketAntiguo = await FacturacionTicket.create(
      datosTicket(PLACAS.ticketAntiguo, antiguo.turno.id, {
        estado: 'CONFIRMADA',
        confirmadoAt: DateTime.now(),
        consecutivoDescuento: null,
      })
    )
    // Dateo con descuento pre-marcado que aún no se factura.
    const sinFacturar = await crearDateoConTurno(PLACAS.sinFacturar, 900953)

    for (const d of [antiguo.dateo, sinFacturar.dateo]) {
      const res = await get(client, `/api/captacion-dateos/${d.id}`)
      assert.equal(res.status(), 200)
      assert.isNull(res.body().consecutivo_descuento)
    }

    const lista = await get(client, '/api/captacion-dateos', { placa: PLACAS.ticketAntiguo })
    const fila = (lista.body().data as any[]).find((r) => r.id === antiguo.dateo.id)
    assert.isNull(fila.consecutivo_descuento)

    const placasDesc = await get(client, '/api/reportes-admin/liquidacion-rtm/detalle-placas-descuento', {
      codigo: 'INFORMATIVO',
      fecha_inicio: hoy.toISODate(),
      fecha_fin: hoy.toISODate(),
    })
    const filaDesc = (placasDesc.body().placas as any[]).find((r) => r.ticket_id === ticketAntiguo.id)
    assert.exists(filaDesc)
    assert.isNull(filaDesc.consecutivo_descuento)

    const historial = await get(client, '/api/descuentos/historial', {
      placa: PLACAS.ticketAntiguo,
      fecha_desde: hoy.toISODate(),
      fecha_hasta: hoy.toISODate(),
    })
    const filaHist = (historial.body().data as any[]).find((r) => r.ticket_id === ticketAntiguo.id)
    assert.isNull(filaHist.consecutivo_descuento)
  }).timeout(30000)
})
