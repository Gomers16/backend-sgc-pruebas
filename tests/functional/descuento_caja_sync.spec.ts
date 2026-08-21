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

// Ids conocidos ya sembrados en la BD de pruebas (mismos que
// servicio_mismatch_e2e.spec.ts).
const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN_ID = 9
const AGENTE_COMERCIAL_ID = 1

// Catálogo de descuentos (confirmado por investigación previa contra la BD
// de pruebas: id=1 INFORMATIVO, id=2 AVANCE, id=3 INFORMATIVO_EMPLEADO).
const DESCUENTO_INFORMATIVO_ID = 1
const DESCUENTO_AVANCE_ID = 2
const DESCUENTO_INFORMATIVO_EMPLEADO_ID = 3

const PLACAS = {
  caso1: 'TST991',
  caso2: 'TST992',
  caso3: 'TST993',
  storeManual: 'TST994',
  listados: 'TST995',
}

test.group('Sincronización descuento real en caja (dateo <-> comisión)', (group) => {
  let usuarioTest: Usuario
  let token: string
  let convenioAsesor: AgenteCaptacion
  let convenio: Convenio

  group.setup(async () => {
    usuarioTest = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'DESCUENTO-CAJA',
      correo: `test.descuento.caja.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuarioTest)
    token = tokenObj.value!.release()

    convenioAsesor = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST CONVENIO ASESOR ${Date.now()}`,
      activo: true,
    } as any)

    convenio = await Convenio.create({
      tipo: 'TALLER',
      nombre: `TEST CONVENIO ${Date.now()}`,
      activo: true,
      estado: 'ACTIVO',
      asesorConvenioId: convenioAsesor.id,
    } as any)
  })

  group.teardown(async () => {
    await Database.rawQuery(
      'DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (?, ?, ?, ?, ?))',
      [PLACAS.caso1, PLACAS.caso2, PLACAS.caso3, PLACAS.storeManual, PLACAS.listados]
    )
    await Database.rawQuery('DELETE FROM facturacion_tickets WHERE placa IN (?, ?, ?, ?)', [
      PLACAS.caso1,
      PLACAS.caso2,
      PLACAS.caso3,
      PLACAS.listados,
    ])
    await Database.rawQuery('DELETE FROM turnos_rtms WHERE placa IN (?, ?, ?, ?, ?)', [
      PLACAS.caso1,
      PLACAS.caso2,
      PLACAS.caso3,
      PLACAS.storeManual,
      PLACAS.listados,
    ])
    await Database.rawQuery('DELETE FROM captacion_dateos WHERE placa IN (?, ?, ?, ?, ?)', [
      PLACAS.caso1,
      PLACAS.caso2,
      PLACAS.caso3,
      PLACAS.storeManual,
      PLACAS.listados,
    ])
    if (convenio) await Database.rawQuery('DELETE FROM convenios WHERE id = ?', [convenio.id])
    if (convenioAsesor)
      await Database.rawQuery('DELETE FROM agentes_captacions WHERE id = ?', [convenioAsesor.id])
    if (usuarioTest) await usuarioTest.delete()
  })

  async function crearTurno(placa: string, funcionarioId: number, turnoNumero: number) {
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId,
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
    } as any)
  }

  test('Caso 1 (SIN_CONVENIO): descuento aplicado en caja sin pre-marca del asesor queda sincronizado', async ({
    assert,
    client,
  }) => {
    const dateo = await CaptacionDateo.create({
      canal: 'ASESOR_COMERCIAL',
      agenteId: AGENTE_COMERCIAL_ID,
      convenioId: null,
      placa: PLACAS.caso1,
      servicioId: SERVICIO_RTM_ID,
      origen: 'UI',
      resultado: 'EN_PROCESO',
      descuentoId: null, // el asesor NO pre-marcó nada
    } as any)

    const turno = await crearTurno(PLACAS.caso1, usuarioTest.id, 900001)
    turno.captacionDateoId = dateo.id
    await turno.save()
    dateo.consumidoTurnoId = turno.id
    dateo.consumidoAt = DateTime.now()
    await dateo.save()

    const OBS = 'Cliente pide en caja el descuento'
    const ticket = await FacturacionTicket.create({
      hash: `test-hash-${PLACAS.caso1}-${Date.now()}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa: PLACAS.caso1,
      total: 200000,
      totalFactura: 200000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      agenteId: AGENTE_COMERCIAL_ID,
      turnoId: turno.id,
      dateoId: dateo.id,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      descuentoId: DESCUENTO_INFORMATIVO_ID,
      descuentoObservacion: OBS,
    } as any)

    const res = await client
      .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})

    assert.equal(res.status(), 200)

    const comision = await Comision.query()
      .where('captacion_dateo_id', dateo.id)
      .where('es_config', false)
      .firstOrFail()
    assert.equal(comision.descuentoCodigoAplicado, 'INFORMATIVO')
    assert.equal(comision.descuentoObservacionCaja, OBS)

    const dateoRecargado = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(dateoRecargado.descuentoId, null, 'el pre-marcado original no se toca')
    assert.equal(dateoRecargado.descuentoCajaId, DESCUENTO_INFORMATIVO_ID)
    assert.equal(dateoRecargado.descuentoCajaObservacion, OBS)
    assert.isNotNull(dateoRecargado.descuentoCajaAplicadoAt)
  }).timeout(20000)

  test('Caso 2 (CONVENIO_SELF): descuento AVANCE aplicado en caja queda sincronizado', async ({
    assert,
    client,
  }) => {
    const dateo = await CaptacionDateo.create({
      canal: 'ASESOR_CONVENIO',
      agenteId: convenioAsesor.id,
      convenioId: convenio.id,
      asesorConvenioId: convenioAsesor.id,
      placa: PLACAS.caso2,
      servicioId: SERVICIO_RTM_ID,
      origen: 'UI',
      resultado: 'EN_PROCESO',
      descuentoId: null,
    } as any)

    const turno = await crearTurno(PLACAS.caso2, usuarioTest.id, 900002)
    turno.captacionDateoId = dateo.id
    await turno.save()
    dateo.consumidoTurnoId = turno.id
    dateo.consumidoAt = DateTime.now()
    await dateo.save()

    const OBS = 'Asesor no puso descuento'
    const ticket = await FacturacionTicket.create({
      hash: `test-hash-${PLACAS.caso2}-${Date.now()}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa: PLACAS.caso2,
      total: 200000,
      totalFactura: 200000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      agenteId: convenioAsesor.id,
      turnoId: turno.id,
      dateoId: dateo.id,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      descuentoId: DESCUENTO_AVANCE_ID,
      descuentoObservacion: OBS,
    } as any)

    const res = await client
      .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})

    assert.equal(res.status(), 200)

    const comision = await Comision.query()
      .where('captacion_dateo_id', dateo.id)
      .where('es_config', false)
      .firstOrFail()
    assert.equal(comision.descuentoCodigoAplicado, 'AVANCE')
    assert.equal(comision.descuentoObservacionCaja, OBS)
    assert.equal(Number(comision.montoConvenio), 0, 'Caso 2 siempre monto_convenio=0')

    const dateoRecargado = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(dateoRecargado.descuentoId, null)
    assert.equal(dateoRecargado.descuentoCajaId, DESCUENTO_AVANCE_ID)
    assert.equal(dateoRecargado.descuentoCajaObservacion, OBS)
  }).timeout(20000)

  test('Caso 3 (CONVENIO_COMERCIAL): descuento aplicado en caja queda sincronizado, sin tocar el pre-marcado del asesor', async ({
    assert,
    client,
  }) => {
    // Este dateo SÍ tenía algo pre-marcado (AVANCE) por el asesor comercial.
    const dateo = await CaptacionDateo.create({
      canal: 'ASESOR_COMERCIAL',
      agenteId: AGENTE_COMERCIAL_ID,
      convenioId: convenio.id,
      placa: PLACAS.caso3,
      servicioId: SERVICIO_RTM_ID,
      origen: 'UI',
      resultado: 'EN_PROCESO',
      descuentoId: DESCUENTO_AVANCE_ID, // pre-marcado original del asesor
    } as any)

    const turno = await crearTurno(PLACAS.caso3, usuarioTest.id, 900003)
    turno.captacionDateoId = dateo.id
    await turno.save()
    dateo.consumidoTurnoId = turno.id
    dateo.consumidoAt = DateTime.now()
    await dateo.save()

    // En caja terminó aplicándose un código DISTINTO al pre-marcado.
    const OBS = 'Cliente cambió de opinión en caja'
    const ticket = await FacturacionTicket.create({
      hash: `test-hash-${PLACAS.caso3}-${Date.now()}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa: PLACAS.caso3,
      total: 300000,
      totalFactura: 300000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      agenteId: AGENTE_COMERCIAL_ID,
      turnoId: turno.id,
      dateoId: dateo.id,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      descuentoId: DESCUENTO_INFORMATIVO_EMPLEADO_ID,
      descuentoObservacion: OBS,
    } as any)

    const res = await client
      .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})

    assert.equal(res.status(), 200)

    const comision = await Comision.query()
      .where('captacion_dateo_id', dateo.id)
      .where('es_config', false)
      .firstOrFail()
    assert.equal(comision.descuentoCodigoAplicado, 'INFORMATIVO_EMPLEADO')
    assert.equal(comision.descuentoObservacionCaja, OBS)

    const dateoRecargado = await CaptacionDateo.findOrFail(dateo.id)
    assert.equal(
      dateoRecargado.descuentoId,
      DESCUENTO_AVANCE_ID,
      'el pre-marcado original del asesor NUNCA se sobrescribe'
    )
    assert.equal(dateoRecargado.descuentoCajaId, DESCUENTO_INFORMATIVO_EMPLEADO_ID)
    assert.equal(dateoRecargado.descuentoCajaObservacion, OBS)
  }).timeout(20000)

  test('POST /comisiones (creación manual) sincroniza descuento_codigo_aplicado y el dateo', async ({
    assert,
    client,
  }) => {
    const turno = await crearTurno(PLACAS.storeManual, usuarioTest.id, 900004)

    const OBS = 'Corrección manual — el asesor olvidó marcar el descuento'
    const res = await client
      .post('/api/comisiones')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turno.id,
        asesor_id: AGENTE_COMERCIAL_ID,
        convenio_id: null,
        monto_asesor: 4300,
        monto_convenio: 0,
        tipo_cliente: 'RECURRENTE',
        descuento_id: DESCUENTO_INFORMATIVO_ID,
        descuento_observacion: OBS,
        es_avance: false,
      })

    assert.equal(res.status(), 200)
    const comisionId = res.body()?.id
    assert.exists(comisionId)

    const comision = await Comision.findOrFail(comisionId)
    assert.equal(comision.descuentoCodigoAplicado, 'INFORMATIVO')
    assert.equal(comision.descuentoObservacionCaja, OBS)

    const dateo = await CaptacionDateo.findOrFail(comision.captacionDateoId!)
    assert.equal(dateo.descuentoCajaId, DESCUENTO_INFORMATIVO_ID)
    assert.equal(dateo.descuentoCajaObservacion, OBS)
    assert.isNotNull(dateo.descuentoCajaAplicadoAt)
  }).timeout(20000)

  test('GET /captacion-dateos (listado) devuelve el descuento aplicado en caja con código y monto', async ({
    assert,
    client,
  }) => {
    // ASESOR_CONVENIO + es_avance:true + descuento AVANCE → el hook auto-resuelve
    // un monto real (valor_carro/valor_moto del catálogo), no 0, dando una
    // aserción de monto más fuerte que un descuento meramente informativo.
    const dateo = await CaptacionDateo.create({
      canal: 'ASESOR_CONVENIO',
      agenteId: convenioAsesor.id,
      convenioId: convenio.id,
      asesorConvenioId: convenioAsesor.id,
      placa: PLACAS.listados,
      servicioId: SERVICIO_RTM_ID,
      origen: 'UI',
      resultado: 'EN_PROCESO',
      descuentoId: null,
      esAvance: true,
    } as any)

    const turno = await crearTurno(PLACAS.listados, usuarioTest.id, 900005)
    turno.captacionDateoId = dateo.id
    await turno.save()
    dateo.consumidoTurnoId = turno.id
    dateo.consumidoAt = DateTime.now()
    await dateo.save()

    const OBS = 'Descuento aplicado en caja para prueba de listado'
    const ticket = await FacturacionTicket.create({
      hash: `test-hash-${PLACAS.listados}-${Date.now()}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa: PLACAS.listados,
      total: 200000,
      totalFactura: 200000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      agenteId: convenioAsesor.id,
      turnoId: turno.id,
      dateoId: dateo.id,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      descuentoId: DESCUENTO_AVANCE_ID,
      descuentoObservacion: OBS,
    } as any)

    const confirmRes = await client
      .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})
    assert.equal(confirmRes.status(), 200)

    const comision = await Comision.query()
      .where('captacion_dateo_id', dateo.id)
      .where('es_config', false)
      .firstOrFail()
    assert.equal(comision.descuentoCodigoAplicado, 'AVANCE')
    const montoEsperado = Number(comision.descuentoMontoAplicado)
    assert.isAbove(montoEsperado, 0, 'el monto de AVANCE debe auto-resolverse a un valor > 0')

    // --- Listado de dateos: código + monto (resuelto desde la comisión) ---
    const dateosListRes = await client
      .get('/api/captacion-dateos')
      .qs({ placa: PLACAS.listados, perPage: 5 })
      .header('Authorization', `Bearer ${token}`)

    assert.equal(dateosListRes.status(), 200)
    const dateoRow = dateosListRes.body().data.find((r: any) => r.id === dateo.id)
    assert.exists(dateoRow, 'el dateo debe aparecer en el listado')
    assert.equal(dateoRow.descuento_caja_id, DESCUENTO_AVANCE_ID)
    assert.equal(dateoRow.descuento_caja?.codigo, 'AVANCE')
    assert.equal(dateoRow.descuento_caja_observacion, OBS)
    assert.isNotNull(dateoRow.descuento_caja_aplicado_at)
    assert.equal(Number(dateoRow.descuento_caja_monto), montoEsperado)

    // --- Listado de comisiones: código + observación + monto ---
    const comisionesListRes = await client
      .get('/api/comisiones')
      .qs({ placa: PLACAS.listados, perPage: 5 })
      .header('Authorization', `Bearer ${token}`)

    assert.equal(comisionesListRes.status(), 200)
    const comisionRow = comisionesListRes.body().data.find((r: any) => r.dateo_id === dateo.id)
    assert.exists(comisionRow, 'la comisión debe aparecer en el listado')
    assert.equal(comisionRow.descuento_codigo_aplicado, 'AVANCE')
    assert.equal(comisionRow.descuento_observacion_caja, OBS)
    assert.equal(Number(comisionRow.descuento_monto_aplicado), montoEsperado)
  }).timeout(20000)
})
