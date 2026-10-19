import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'
import Comision from '#models/comision'
import { evaluarContinuidad } from '#services/continuidad_service'
import { resolveConfigRecurrencia } from '#services/comision_calculo_service'

/**
 * evaluarContinuidad() con transacción opcional:
 *  - PUT /captacion-dateos/:id que cambia convenio_id y deja el dateo EXITOSO
 *    (turno ya finalizado): la continuidad se evalúa con el convenio NUEVO,
 *    como antes del commit c80111f (el dateo se guarda dentro de la
 *    transacción y la evaluación ahora corre en ella).
 *  - Sin trx, el servicio responde igual que siempre.
 */

const SEDE_ID = 2
const ZONA = 'America/Bogota'
const P = {
  PUT: 'TKK701',
  ROTA_OTRO: 'TKK702',
  ROTA_SIN_DATEO: 'TKK703',
  CONTINUA: 'TKK704',
} as const

test.group('Continuidad · transacción opcional', (group) => {
  group.each.timeout(60_000)

  let usuario: Usuario
  let token: string
  let asesorConvenio: AgenteCaptacion
  let otroAsesor: AgenteCaptacion
  let convNuevo: Convenio
  let convViejo: Convenio
  let config: Comision
  let numero = 0

  async function turnoFinalizado(placa: string, dateoId: number | null = null) {
    numero++
    return TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuario.id,
      servicioId: 1,
      fecha: DateTime.now().setZone(ZONA).minus({ days: numero }),
      horaIngreso: '08:00',
      horaSalida: '09:00',
      tieneFacturacion: false,
      turnoNumero: 987000 + numero,
      turnoNumeroServicio: 987000 + numero,
      turnoCodigo: `TST-TKK-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
      esSegundaVez: false,
      esRecurrente: true,
      captacionDateoId: dateoId,
    } as any)
  }

  async function dateo(placa: string, convenioId: number, turnoId: number | null = null) {
    return CaptacionDateo.create({
      canal: 'ASESOR_CONVENIO',
      agenteId: asesorConvenio.id,
      convenioId,
      asesorConvenioId: null,
      placa,
      servicioId: 1,
      origen: 'UI',
      resultado: 'EN_PROCESO',
      consumidoTurnoId: turnoId,
      consumidoAt: turnoId ? DateTime.now() : null,
    } as any)
  }

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'TK-CONTINUIDAD',
      correo: `test.tk.continuidad.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: 9,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuario)
    token = tokenObj.value!.release()
    const sufijo = Date.now().toString(36).toUpperCase()
    asesorConvenio = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKK CONVENIO ${sufijo}`,
    } as any)
    otroAsesor = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST TKK OTRO ${sufijo}`,
    } as any)
    convNuevo = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKK CONVENIO ${sufijo}`,
      activo: true,
      asesorConvenioId: asesorConvenio.id,
    } as any)
    convViejo = await Convenio.create({
      tipo: 'PERSONA',
      nombre: `TEST TKK OTRO ${sufijo}`,
      activo: true,
      asesorConvenioId: otroAsesor.id,
    } as any)
    // Caso 2 con continuidad paga este `base`; sin continuidad, el valor de recurrencia.
    config = await Comision.create({
      esConfig: true,
      asesorId: asesorConvenio.id,
      tipoVehiculo: null,
      base: '15000',
      estado: 'PENDIENTE',
    } as any)
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE es_config = 0 AND captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${placas.map(() => '?').join(',')}))`,
      placas
    )
    await Database.from('turnos_rtms').whereIn('placa', placas).update({ captacion_dateo_id: null })
    await Database.from('captacion_dateos').whereIn('placa', placas).delete()
    await Database.from('turnos_rtms').whereIn('placa', placas).delete()
    await config.delete()
    await convNuevo.delete()
    await convViejo.delete()
    await asesorConvenio.delete()
    await otroAsesor.delete()
    await usuario.delete()
  })

  test('PUT que cambia convenio_id y deja EXITOSO: la continuidad usa el convenio nuevo', async ({
    client,
    assert,
  }) => {
    const rec = await resolveConfigRecurrencia(asesorConvenio.id, 'VEHICULO')
    assert.notEqual(rec.valorRecurrente, 15000, 'precondición: los dos montos se distinguen')

    // Único turno finalizado de la placa; su dateo apunta (todavía) al convenio viejo.
    const t = await turnoFinalizado(P.PUT)
    const d = await dateo(P.PUT, convViejo.id, t.id)
    t.captacionDateoId = d.id
    await t.save()

    const r = await client
      .put(`/api/captacion-dateos/${d.id}`)
      .headers({ Authorization: `Bearer ${token}` })
      .json({ convenio_id: convNuevo.id, resultado: 'EXITOSO' })
    r.assertStatus(200)

    const c = await Comision.query()
      .where('captacion_dateo_id', d.id)
      .where('es_config', false)
      .firstOrFail()
    // Con el convenio nuevo el historial es CONTINUA → incentivo base (Caso 2 recurrente).
    // Con el viejo (lo que leía la evaluación fuera de la transacción) sería ROTA → recurrencia.
    assert.equal(Number(c.montoAsesor), 15000)
    assert.equal(
      await evaluarContinuidad({
        placa: P.PUT,
        asesorConvenioId: asesorConvenio.id,
        convenioId: convNuevo.id,
      }),
      'CONTINUA'
    )
  })

  test('sin trx: mismos resultados que siempre (otro convenio, visita sin dateo, sin historial)', async ({
    assert,
  }) => {
    const params = (placa: string) => ({
      placa,
      asesorConvenioId: asesorConvenio.id,
      convenioId: convNuevo.id,
    })
    // Visita previa con dateo de OTRO convenio → ROTA.
    const t1 = await turnoFinalizado(P.ROTA_OTRO)
    const d1 = await dateo(P.ROTA_OTRO, convViejo.id, t1.id)
    t1.captacionDateoId = d1.id
    await t1.save()
    assert.equal(await evaluarContinuidad(params(P.ROTA_OTRO)), 'ROTA')
    // Visita previa sin dateo (otro canal) → ROTA.
    await turnoFinalizado(P.ROTA_SIN_DATEO)
    assert.equal(await evaluarContinuidad(params(P.ROTA_SIN_DATEO)), 'ROTA')
    // Sin historial → CONTINUA; sin asesor ni convenio → SIN_EVIDENCIA.
    assert.equal(await evaluarContinuidad(params(P.CONTINUA)), 'CONTINUA')
    assert.equal(await evaluarContinuidad({ placa: P.CONTINUA }), 'SIN_EVIDENCIA')
  })

  test('con trx ve lo escrito en la transacción; sin trx, el estado confirmado', async ({
    assert,
  }) => {
    const t = await turnoFinalizado(P.CONTINUA)
    const d = await dateo(P.CONTINUA, convViejo.id, t.id)
    t.captacionDateoId = d.id
    await t.save()
    const params = {
      placa: P.CONTINUA,
      asesorConvenioId: asesorConvenio.id,
      convenioId: convNuevo.id,
    }

    const trx = await Database.transaction()
    try {
      await trx.from('captacion_dateos').where('id', d.id).update({ convenio_id: convNuevo.id })
      assert.equal(await evaluarContinuidad(params, trx), 'CONTINUA')
      assert.equal(
        await evaluarContinuidad(params),
        'ROTA',
        'fuera de la transacción: aún el viejo'
      )
    } finally {
      await trx.rollback()
    }
    assert.equal(await evaluarContinuidad(params), 'ROTA')
  })
})
