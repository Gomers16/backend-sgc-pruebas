import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import FacturacionTicket from '#models/facturacion_ticket'
import Comision from '#models/comision'

// Comisión doble / re-vinculación de dateos tras WINDOW_BLOCK_CONFIRMABLE.
// El dateo consumido por el primer turno sigue "vigente" 365 días por
// buildReserva() (TTL post-consumo), pero ya no se re-vincula a un segundo
// turno de la misma placa (store(): dateoConsumidoPorOtroTurno), y como
// respaldo applyCommissionHook() no paga dos veces el mismo dateo si ya tiene
// comisión de otro turno no cancelado, sin importar el día.
// Regresión: un dateo nuevo sí se vincula y paga; cancelar y recrear el mismo
// día sigue re-vinculando el dateo del turno cancelado.
// Escribe en la BD compartida: placas DRV901–DRV905, limpieza al final.

const SEDE_ID = 2
const AGENTE_COMERCIAL_ID = 1
const ROL_SUPER_ADMIN = 9
const ZONA = 'America/Bogota'

const P = {
  RTM_SEGUNDO: 'DRV901',
  SOAT_SEGUNDO: 'DRV902',
  RTM_DATEO_NUEVO: 'DRV903',
  RTM_CANCELA_RECREA: 'DRV904',
  RTM_RESPALDO_HOOK: 'DRV905',
}

test.group('Dateo consumido: no se re-vincula ni se paga dos veces', (group) => {
  group.each.timeout(60_000)

  let admin: Usuario
  let token = ''
  let hoy: DateTime
  const svc = { RTM: 0, SOAT: 0 }
  let numero = 975000 + Math.floor(Math.random() * 9000)
  let total = 210000

  const bearer = () => ({ Authorization: `Bearer ${token}` })

  function crearDateo(placa: string, servicioId: number, extra: Record<string, unknown> = {}) {
    return CaptacionDateo.create({
      canal: 'ASESOR_COMERCIAL',
      agenteId: AGENTE_COMERCIAL_ID,
      placa,
      servicioId,
      origen: 'UI',
      resultado: 'PENDIENTE',
      ...extra,
    } as any)
  }

  /** Primer turno (hace `diasAtras`) finalizado y con el dateo consumido. */
  async function primerTurno(
    placa: string,
    servicioId: number,
    dateo: CaptacionDateo,
    diasAtras = 30
  ) {
    numero++
    const fecha = hoy.minus({ days: diasAtras })
    const t = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId,
      fecha,
      horaIngreso: '08:00:00',
      horaSalida: '09:00:00',
      turnoNumero: numero,
      turnoNumeroServicio: numero,
      turnoCodigo: `TST-DRV-${placa}-${numero}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
      tieneFacturacion: true,
      resultadoCertificacion: servicioId === svc.RTM ? 'APROBADA' : null,
      captacionDateoId: dateo.id,
    } as any)
    dateo.consumidoTurnoId = t.id
    dateo.consumidoAt = fecha
    dateo.resultado = 'EXITOSO'
    await dateo.save()
    return t
  }

  /** Ticket de facturación confirmado por la API (dispara applyCommissionHook). */
  async function confirmarFacturacion(
    client: any,
    turno: TurnoRtm,
    codigo: 'RTM' | 'SOAT',
    dateoId: number | null = null
  ) {
    total += 1000
    const ticket = await FacturacionTicket.create({
      hash: `test-hash-drv-${turno.placa}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa: turno.placa,
      total,
      totalFactura: total,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      turnoId: turno.id,
      dateoId,
      servicioCodigo: codigo,
      servicioNombre: codigo,
      tipoVehiculoSnapshot: 'Liviano Particular',
    } as any)
    const res = await client
      .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
      .headers(bearer())
      .json({ forzar: true })
    if (res.status() !== 200) throw new Error(`confirmar: ${res.status()} ${res.text()}`)
    return ticket
  }

  function crearTurnoHttp(client: any, placa: string, servicioId: number) {
    return client
      .post('/api/turnos-rtm')
      .headers(bearer())
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: admin.id,
        fecha: hoy.toISODate(),
        horaIngreso: DateTime.local().setZone(ZONA).toFormat('HH:mm:ss'),
        servicioId,
        confirmar_ventana_vigencia: true,
      })
  }

  const comisionesDe = (dateoId: number) =>
    Comision.query().where('captacion_dateo_id', dateoId).where('es_config', false)

  /** Lleva la comisión del primer turno al día de ese turno (no "hoy"). */
  async function envejecerComisiones(dateoId: number, diasAtras = 30) {
    await Database.from('comisiones')
      .where('captacion_dateo_id', dateoId)
      .update({ fecha_calculo: hoy.minus({ days: diasAtras }).toFormat('yyyy-LL-dd HH:mm:ss') })
  }

  group.setup(async () => {
    hoy = DateTime.local().setZone(ZONA)
    const rtm = await Servicio.findByOrFail('codigoServicio', 'RTM')
    const soat = await Servicio.findByOrFail('codigoServicio', 'SOAT')
    svc.RTM = rtm.id
    svc.SOAT = soat.id
    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'DRV-ADMIN',
      correo: `test.drv.admin.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(admin)
    token = tokenObj.value!.release()
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const ph = placas.map(() => '?').join(',')
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${ph}))`,
      placas
    )
    await Database.rawQuery(`DELETE FROM facturacion_tickets WHERE placa IN (${ph})`, placas)
    await Database.rawQuery(
      `UPDATE turnos_rtms SET captacion_dateo_id = NULL WHERE placa IN (${ph})`,
      placas
    )
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${ph})`, placas)
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${ph})`, placas)
    if (admin) await admin.delete()
  })

  test('RTM: segundo turno a los 30 días con confirmación no re-vincula el dateo ni crea otra comisión', async ({
    client,
    assert,
  }) => {
    const dateo = await crearDateo(P.RTM_SEGUNDO, svc.RTM)
    const t1 = await primerTurno(P.RTM_SEGUNDO, svc.RTM, dateo)
    await confirmarFacturacion(client, t1, 'RTM')
    assert.lengthOf(await comisionesDe(dateo.id), 1, 'el primer turno genera su comisión')
    await envejecerComisiones(dateo.id)

    const r = await crearTurnoHttp(client, P.RTM_SEGUNDO, svc.RTM)
    r.assertStatus(201)
    const t2 = await TurnoRtm.findOrFail(r.body().id)
    assert.isNull(t2.captacionDateoId)
    assert.isNull(t2.agenteCaptacionId)
    assert.isNull(t2.canalAtribucion)
    assert.isNotNull(t2.ventanaRtmConfirmadaPorId)

    await confirmarFacturacion(client, t2, 'RTM')

    assert.lengthOf(await comisionesDe(dateo.id), 1, 'no hay segunda comisión')
    await dateo.refresh()
    assert.equal(dateo.consumidoTurnoId, t1.id)
    assert.equal(dateo.resultado, 'EXITOSO')
  })

  test('SOAT: el segundo turno no re-vincula el dateo del primero', async ({ client, assert }) => {
    const dateo = await crearDateo(P.SOAT_SEGUNDO, svc.SOAT)
    const t1 = await primerTurno(P.SOAT_SEGUNDO, svc.SOAT, dateo)

    const r = await crearTurnoHttp(client, P.SOAT_SEGUNDO, svc.SOAT)
    r.assertStatus(201)
    const t2 = await TurnoRtm.findOrFail(r.body().id)
    assert.isNull(t2.captacionDateoId)
    assert.isNull(t2.agenteCaptacionId)

    await confirmarFacturacion(client, t2, 'SOAT')

    await dateo.refresh()
    assert.equal(dateo.consumidoTurnoId, t1.id)
    assert.lengthOf(await comisionesDe(dateo.id), 0)
  })

  test('Regresión: un dateo nuevo y válido para el segundo turno sí se vincula y sí genera comisión', async ({
    client,
    assert,
  }) => {
    const dateoViejo = await crearDateo(P.RTM_DATEO_NUEVO, svc.RTM)
    const t1 = await primerTurno(P.RTM_DATEO_NUEVO, svc.RTM, dateoViejo)
    await confirmarFacturacion(client, t1, 'RTM')
    await envejecerComisiones(dateoViejo.id)

    const dateoNuevo = await crearDateo(P.RTM_DATEO_NUEVO, svc.RTM)

    const r = await crearTurnoHttp(client, P.RTM_DATEO_NUEVO, svc.RTM)
    r.assertStatus(201)
    const t2 = await TurnoRtm.findOrFail(r.body().id)
    assert.equal(t2.captacionDateoId, dateoNuevo.id)
    assert.equal(t2.agenteCaptacionId, AGENTE_COMERCIAL_ID)

    await confirmarFacturacion(client, t2, 'RTM')

    assert.lengthOf(await comisionesDe(dateoNuevo.id), 1, 'el dateo nuevo paga')
    assert.lengthOf(await comisionesDe(dateoViejo.id), 1, 'el viejo no paga otra vez')
    await dateoViejo.refresh()
    await dateoNuevo.refresh()
    assert.equal(dateoViejo.consumidoTurnoId, t1.id)
    assert.equal(dateoNuevo.consumidoTurnoId, t2.id)
  })

  test('Regresión: turno cancelado y recreado el mismo día re-vincula el dateo y paga una vez', async ({
    client,
    assert,
  }) => {
    const dateo = await crearDateo(P.RTM_CANCELA_RECREA, svc.RTM)

    const r1 = await crearTurnoHttp(client, P.RTM_CANCELA_RECREA, svc.RTM)
    r1.assertStatus(201)
    const t1Id = r1.body().id as number
    await dateo.refresh()
    assert.equal(dateo.consumidoTurnoId, t1Id)

    const rc = await client
      .patch(`/api/turnos-rtm/${t1Id}/cancelar`)
      .headers(bearer())
      .json({ usuarioId: admin.id, motivoCancelacion: 'Prueba: cancelar y recrear' })
    rc.assertStatus(200)

    const r2 = await crearTurnoHttp(client, P.RTM_CANCELA_RECREA, svc.RTM)
    r2.assertStatus(201)
    const t2 = await TurnoRtm.findOrFail(r2.body().id)
    assert.equal(t2.captacionDateoId, dateo.id)
    await dateo.refresh()
    assert.equal(dateo.consumidoTurnoId, t2.id)

    await confirmarFacturacion(client, t2, 'RTM')
    assert.lengthOf(await comisionesDe(dateo.id), 1)
  })

  test('Respaldo en applyCommissionHook: dateo ya pagado a otro turno no se paga otra vez otro día', async ({
    client,
    assert,
  }) => {
    // Simula un segundo turno que quedó vinculado al dateo del primero antes
    // del arreglo (o un dateo_id puesto a mano en el ticket).
    const dateo = await crearDateo(P.RTM_RESPALDO_HOOK, svc.RTM)
    const t1 = await primerTurno(P.RTM_RESPALDO_HOOK, svc.RTM, dateo)
    await confirmarFacturacion(client, t1, 'RTM')
    await envejecerComisiones(dateo.id)
    assert.lengthOf(await comisionesDe(dateo.id), 1)

    numero++
    const t2 = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: svc.RTM,
      fecha: hoy,
      horaIngreso: '08:00:00',
      turnoNumero: numero,
      turnoNumeroServicio: numero,
      turnoCodigo: `TST-DRV-${P.RTM_RESPALDO_HOOK}-${numero}`,
      placa: P.RTM_RESPALDO_HOOK,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      captacionDateoId: dateo.id,
    } as any)

    await confirmarFacturacion(client, t2, 'RTM', dateo.id)

    assert.lengthOf(await comisionesDe(dateo.id), 1, 'el respaldo evita la segunda comisión')
  })
})
