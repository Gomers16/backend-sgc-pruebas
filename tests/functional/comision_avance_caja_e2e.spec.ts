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
import RepGeneralImportController from '#controllers/rep_general_imports_controller'
import {
  calcularComision,
  esAvanceEfectivo,
  resolveConfigComision,
  resolveConfigRecurrencia,
  type CasoComision,
  type EscenarioCliente,
  type TipoVehiculoComision,
} from '#services/comision_calculo_service'

// El Avance cuenta por el descuento FINAL de la factura (esAvanceEfectivo),
// venga pre-marcado en el dateo o puesto en caja, en todos los escenarios:
// Caso 3 → convenio $0 y el comercial conserva su valor; Caso 2 → $0;
// Caso 1 lo ignora. La marca es_avance del dateo es solo informativa.
// Cada combinación se confirma por la API y se compara: motor (configuración
// vigente) = guardado = GET /comisiones/:id = previsualización del diálogo.
// Todo lo creado aquí se borra en el teardown (por placa y por usuario).

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const AGENTE_COMERCIAL_ID = 1
const ROL_SUPER_ADMIN = 9
const DESCUENTO = { INFORMATIVO: 1, AVANCE: 2, AVANCE_PROPIETARIO: 5 }
const FIJO_AVANCE_PROPIETARIO = { MOTO: 55000, VEHICULO: 90000 }

const PLACAS = Array.from({ length: 90 }, (_, i) => `TAV${String(100 + i)}`)
const RUN = Date.now().toString(36).toUpperCase()
let siguientePlaca = 0
const placa = () => PLACAS[siguientePlaca++]

const CASOS: CasoComision[] = ['SIN_CONVENIO', 'CONVENIO_SELF', 'CONVENIO_COMERCIAL']
const ESCENARIOS: EscenarioCliente[] = ['NUEVO', 'RECURRENTE', 'RECUPERACION']
const VEHICULOS: TipoVehiculoComision[] = ['MOTO', 'VEHICULO']

interface OpcionesTicket {
  caso: CasoComision
  tv?: TipoVehiculoComision
  escenario?: EscenarioCliente
  /** Descuento final de la factura (null = sin descuento). */
  descuentoCaja?: number | null
  monto?: number | null
  /** Descuento pre-marcado en el dateo y su marca es_avance. */
  premarcado?: number | null
  marca?: boolean
}

test.group('Comisiones: el Avance cuenta por el descuento final de la factura', (group) => {
  let admin: Usuario
  let token = ''
  let convenioAsesor: AgenteCaptacion
  let convenio: Convenio
  let turnoNumero = 960000 + Math.floor(Math.random() * 9000)

  group.setup(async () => {
    admin = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'AVANCE-CAJA',
      correo: `test.avance.caja.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(admin)
    token = tokenObj.value!.release()
    convenioAsesor = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST AVANCE CAJA CONVENIO ASESOR ${RUN}`,
      activo: true,
    } as any)
    convenio = await Convenio.create({
      tipo: 'TALLER',
      nombre: `TEST AVANCE CAJA CONVENIO ${RUN}`,
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

  /** Turno RTM con dateo del caso y factura CONFIRMADA por la API. */
  async function confirmarTicket(client: any, o: OpcionesTicket) {
    const p = placa()
    const tv = o.tv ?? 'VEHICULO'
    const escenario = o.escenario ?? 'NUEVO'
    const self = o.caso === 'CONVENIO_SELF'
    const dateo = await CaptacionDateo.create({
      canal: self ? 'ASESOR_CONVENIO' : 'ASESOR_COMERCIAL',
      agenteId: self ? convenioAsesor.id : AGENTE_COMERCIAL_ID,
      convenioId: o.caso === 'SIN_CONVENIO' ? null : convenio.id,
      asesorConvenioId: o.caso === 'SIN_CONVENIO' ? null : convenioAsesor.id,
      placa: p,
      servicioId: SERVICIO_RTM_ID,
      origen: 'UI',
      resultado: 'EN_PROCESO',
      descuentoId: o.premarcado ?? null,
      esAvance: o.marca ?? false,
    } as any)
    turnoNumero += 1
    const tipoVehiculo = tv === 'MOTO' ? 'Motocicleta' : 'Liviano Particular'
    const turno = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: admin.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: DateTime.now(),
      horaIngreso: '08:00:00',
      turnoNumero,
      turnoNumeroServicio: turnoNumero,
      turnoCodigo: `RTM-AVC-${RUN}-${turnoNumero}`,
      placa: p,
      tipoVehiculo,
      estado: 'activo',
      tieneFacturacion: false,
      captacionDateoId: dateo.id,
      esRecurrente: escenario === 'RECURRENTE',
      esRecuperacion: escenario === 'RECUPERACION',
    } as any)
    dateo.consumidoTurnoId = turno.id
    dateo.consumidoAt = DateTime.now()
    await dateo.save()

    const descuentoId = o.descuentoCaja ?? null
    const ticket = await FacturacionTicket.create({
      hash: `test-hash-avc-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa: p,
      total: 200000,
      totalFactura: 200000,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      agenteId: dateo.agenteId,
      turnoId: turno.id,
      dateoId: dateo.id,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      tipoVehiculoSnapshot: tipoVehiculo,
      descuentoId,
      descuentoMontoAplicado: descuentoId ? (o.monto ?? null) : null,
      consecutivoDescuento: descuentoId ? `AVC-${RUN}-${p}` : null,
    } as any)
    const res = await client
      .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
      .header('Authorization', `Bearer ${token}`)
      .json({})
    if (res.status() !== 200) throw new Error(`confirmar ${p}: ${res.status()} ${res.text()}`)
    const comision = await Comision.query()
      .where('captacion_dateo_id', dateo.id)
      .where('es_config', false)
      .firstOrFail()
    await turno.refresh()
    return { ticket, comision, turno, dateo }
  }

  /** Lo que debe pagar el motor con la configuración vigente (mismo cálculo que el hook). */
  async function esperado(o: OpcionesTicket, codigo: string | null, turno: TurnoRtm) {
    const tv = o.tv ?? 'VEHICULO'
    const asesorId = o.caso === 'CONVENIO_SELF' ? convenioAsesor.id : AGENTE_COMERCIAL_ID
    const cfgValues = await resolveConfigComision({
      asesorId,
      asesorConvenioId: o.caso === 'SIN_CONVENIO' ? null : convenioAsesor.id,
      tipoVehiculo: tv,
    })
    const recValues = await resolveConfigRecurrencia(asesorId, tv)
    const r = calcularComision({
      caso: o.caso,
      escenario: o.escenario ?? 'NUEVO',
      tuvoContinuidad: (turno as any).estadoContinuidad !== 'ROTA',
      esAvance: esAvanceEfectivo({ caso: o.caso, codigoDescuento: codigo }),
      montoAvance: 0,
      codigoDescuento: codigo,
      origenDescuento: codigo ? (o.premarcado ? 'DATEO' : 'CAJA') : null,
      cfgValues,
      recValues,
    })
    return { r, cfgValues }
  }

  const leerGet = async (client: any, id: number) => {
    const g = await client.get(`/api/comisiones/${id}`).header('Authorization', `Bearer ${token}`)
    if (g.status() !== 200) throw new Error(`GET /comisiones/${id}: ${g.status()}`)
    return g.body()
  }

  const leerDesglose = async (client: any, id: number) => {
    const g = await leerGet(client, id)
    return g.desglose_motor
  }

  const previsualizar = (client: any, id: number, body: Record<string, unknown>) =>
    client
      .patch(`/api/facturacion/tickets/${id}`)
      .header('Authorization', `Bearer ${token}`)
      .json({ ...body, solo_previsualizar: true })

  /** Guardado = motor; GET y diálogo muestran lo mismo. */
  async function compararLecturas(
    assert: any,
    client: any,
    donde: string,
    x: { ticket: FacturacionTicket; comision: Comision },
    r: { montoAsesor: number; montoConvenio: number; reglaAplicada: string }
  ) {
    assert.equal(Number(x.comision.montoAsesor), r.montoAsesor, `${donde}: asesor guardado`)
    assert.equal(Number(x.comision.montoConvenio), r.montoConvenio, `${donde}: convenio guardado`)
    assert.equal(x.comision.reglaAplicada, r.reglaAplicada, donde)

    const g = await leerGet(client, x.comision.id)
    const m = g.desglose_motor
    assert.isNotNull(m, `${donde}: ${g.desglose_motivo}`)
    assert.notExists(
      m.alertas.find((a: any) => a.codigo === 'DISTINTO_AL_MOTOR'),
      `${donde}: GET distinto al motor`
    )

    const abrir = await previsualizar(client, x.ticket.id, {})
    assert.equal(abrir.status(), 200, `${donde}: ${abrir.text()}`)
    const d = abrir.body().comision.desglose
    assert.equal(d.regla, m.regla, donde)
    assert.deepEqual(
      d.beneficiarios.map((b: any) => [b.rol, b.despues]),
      m.beneficiarios.map((b: any) => [b.rol, b.despues]),
      `${donde}: diálogo = Comisiones`
    )
    return d
  }

  test('matriz por la API: AVANCE en caja y regresión (sin descuento, INFORMATIVO, AVANCE_PROPIETARIO)', async ({
    assert,
    client,
  }) => {
    const descuentos: [string | null, number | null][] = [
      ['AVANCE', DESCUENTO.AVANCE],
      [null, null],
      ['INFORMATIVO', DESCUENTO.INFORMATIVO],
      ['AVANCE_PROPIETARIO', DESCUENTO.AVANCE_PROPIETARIO],
    ]
    let n = 0
    for (const caso of CASOS)
      for (const tv of VEHICULOS)
        for (const escenario of ESCENARIOS)
          for (const [codigo, descuentoCaja] of descuentos) {
            const o: OpcionesTicket = {
              caso,
              tv,
              escenario,
              descuentoCaja,
              monto:
                codigo === 'AVANCE_PROPIETARIO'
                  ? FIJO_AVANCE_PROPIETARIO[tv]
                  : codigo
                    ? 10000
                    : null,
            }
            const donde = `${caso}/${tv}/${escenario}/${codigo}`
            const x = await confirmarTicket(client, o)
            const { r, cfgValues } = await esperado(o, codigo, x.turno)
            const d = await compararLecturas(assert, client, donde, x, r)
            n++

            const avance = esAvanceEfectivo({ caso, codigoDescuento: codigo })
            assert.equal(Boolean(x.comision.esAvance), avance, donde)
            assert.equal(d.descuento.esAvance, avance, donde)
            if (codigo === 'AVANCE' && caso === 'CONVENIO_COMERCIAL') {
              assert.equal(Number(x.comision.montoConvenio), 0, donde)
              assert.equal(Number(x.comision.montoAsesor), cfgValues.valorDateoNuevo, donde)
            }
            if (codigo === 'AVANCE' && caso === 'CONVENIO_SELF') {
              assert.equal(Number(x.comision.montoAsesor), 0, donde)
            }
            if (caso === 'CONVENIO_COMERCIAL' && codigo !== 'AVANCE') {
              // Regresión: sin Avance el convenio cobra, salvo el especial de caja con cliente nuevo.
              const especialNuevo = codigo === 'AVANCE_PROPIETARIO' && escenario === 'NUEVO'
              assert.equal(
                Number(x.comision.montoConvenio),
                especialNuevo ? 0 : cfgValues.valorIncentivoCaso3,
                donde
              )
            }
          }
    assert.equal(n, CASOS.length * VEHICULOS.length * ESCENARIOS.length * descuentos.length)
  }).timeout(600000)

  test('editar una factura sin descuento agregando Avance: PENDIENTE baja; APROBADA se recalcula y pide confirmación', async ({
    assert,
    client,
  }) => {
    for (const estado of ['PENDIENTE', 'APROBADA'] as const) {
      const x = await confirmarTicket(client, { caso: 'CONVENIO_COMERCIAL' })
      const asesorAntes = Number(x.comision.montoAsesor)
      const convenioAntes = Number(x.comision.montoConvenio)
      assert.isAbove(convenioAntes, 0, 'el convenio cobraba antes del Avance')
      if (estado === 'APROBADA') {
        await Database.from('comisiones').where('id', x.comision.id).update({ estado })
      }
      const body = {
        descuento_id: DESCUENTO.AVANCE,
        descuento_monto_aplicado: 10000,
        autorizado_por_id: admin.id,
        consecutivo_descuento: `AVC-${RUN}-ED-${estado}`,
      }
      const previa = await previsualizar(client, x.ticket.id, body)
      assert.equal(previa.status(), 200, previa.text())
      const p = previa.body().comision
      assert.equal(p.accion, 'RECALCULADA', estado)
      assert.equal(p.estado, estado)
      // Cambia la comisión: el diálogo muestra el modal "cambiará de … a …"
      // (sin casilla de pagada) para PENDIENTE y APROBADA.
      assert.isFalse(p.requiereConfirmacionPago, estado)
      assert.equal(p.diferencia.convenio, -convenioAntes, estado)
      assert.equal(p.despues.montoAsesor, asesorAntes, estado)
      assert.equal(p.despues.montoConvenio, 0, estado)

      const guardar = await client
        .patch(`/api/facturacion/tickets/${x.ticket.id}`)
        .header('Authorization', `Bearer ${token}`)
        .json({ ...body, motivo_edicion: 'Prueba: agregar Avance en caja' })
      assert.equal(guardar.status(), 200, guardar.text())
      const fila = await Database.from('comisiones').where('id', x.comision.id).first()
      assert.equal(fila.estado, estado, 'el estado no cambia')
      assert.equal(Number(fila.monto_convenio), 0, estado)
      assert.equal(Number(fila.monto_asesor), asesorAntes, estado)
      assert.equal(Boolean(fila.es_avance), true, estado)

      const m = await leerDesglose(client, x.comision.id)
      assert.notExists(m.alertas.find((a: any) => a.codigo === 'DISTINTO_AL_MOTOR'))
      assert.equal(m.beneficiarios.find((b: any) => b.rol === 'CONVENIO').despues, 0)
    }
  }).timeout(120000)

  test('bordes: la factura final manda (Avance pre-marcado cambiado o quitado) y Avance en $0', async ({
    assert,
    client,
  }) => {
    // Pre-marcado y la cajera lo deja → convenio $0.
    const deja = await confirmarTicket(client, {
      caso: 'CONVENIO_COMERCIAL',
      premarcado: DESCUENTO.AVANCE,
      marca: true,
      descuentoCaja: DESCUENTO.AVANCE,
      monto: 10000,
    })
    assert.equal(Number(deja.comision.montoConvenio), 0)
    assert.isTrue(Boolean(deja.comision.esAvance))

    // Pre-marcado y la cajera lo cambia a INFORMATIVO → el convenio cobra.
    const cambia = await confirmarTicket(client, {
      caso: 'CONVENIO_COMERCIAL',
      premarcado: DESCUENTO.AVANCE,
      marca: true,
      descuentoCaja: DESCUENTO.INFORMATIVO,
      monto: 10000,
    })
    const { r: rCambia } = await esperado(
      { caso: 'CONVENIO_COMERCIAL', premarcado: DESCUENTO.AVANCE },
      'INFORMATIVO',
      cambia.turno
    )
    assert.isAbove(Number(cambia.comision.montoConvenio), 0)
    assert.equal(Number(cambia.comision.montoConvenio), rCambia.montoConvenio)
    assert.isFalse(Boolean(cambia.comision.esAvance))
    const dCambia = await leerDesglose(client, cambia.comision.id)
    assert.exists(dCambia.alertas.find((a: any) => a.codigo === 'AVANCE_HEREDADO'))

    // Pre-marcado y la cajera lo quita → el convenio cobra.
    const quita = await confirmarTicket(client, {
      caso: 'CONVENIO_COMERCIAL',
      premarcado: DESCUENTO.AVANCE,
      marca: true,
      descuentoCaja: null,
    })
    assert.isAbove(Number(quita.comision.montoConvenio), 0)
    assert.isFalse(Boolean(quita.comision.esAvance))
    const dQuita = await leerDesglose(client, quita.comision.id)
    assert.exists(dQuita.alertas.find((a: any) => a.codigo === 'AVANCE_HEREDADO'))

    // Avance en caja con monto $0 → cuenta igual como avance.
    const cero = await confirmarTicket(client, {
      caso: 'CONVENIO_COMERCIAL',
      descuentoCaja: DESCUENTO.AVANCE,
      monto: 0,
    })
    assert.equal(Number(cero.comision.montoConvenio), 0)
    assert.isTrue(Boolean(cero.comision.esAvance))

    // Caso 2 con Avance en caja (dateo sin marca) → $0.
    const self = await confirmarTicket(client, {
      caso: 'CONVENIO_SELF',
      escenario: 'RECURRENTE',
      descuentoCaja: DESCUENTO.AVANCE,
      monto: 10000,
    })
    assert.equal(Number(self.comision.montoAsesor), 0)
  }).timeout(120000)

  test('Rep General: Caso 2 con Avance no se reescribe al reclasificar; sin Avance sí', async ({
    assert,
    client,
  }) => {
    const rec = {
      esRecurrente: true,
      esRecuperacion: false,
      mesesDesdeUltimaVisita: 3,
      ultimoTurnoId: null,
      fechaUltimaVisita: null,
      estadoContinuidad: null,
    }
    const controller = new RepGeneralImportController()

    const conAvance = await confirmarTicket(client, {
      caso: 'CONVENIO_SELF',
      descuentoCaja: DESCUENTO.AVANCE,
      monto: 10000,
    })
    assert.equal(Number(conAvance.comision.montoAsesor), 0)
    await (controller as any).recalcularComisionSiExiste(
      conAvance.dateo.id,
      rec,
      'Liviano Particular'
    )
    await conAvance.comision.refresh()
    assert.equal(Number(conAvance.comision.montoAsesor), 0, 'el Avance sigue en $0')
    assert.equal(Number(conAvance.comision.monto), 0)

    const sinAvance = await confirmarTicket(client, { caso: 'CONVENIO_SELF' })
    const antes = Number(sinAvance.comision.montoAsesor)
    await (controller as any).recalcularComisionSiExiste(
      sinAvance.dateo.id,
      rec,
      'Liviano Particular'
    )
    await sinAvance.comision.refresh()
    const recValues = await resolveConfigRecurrencia(convenioAsesor.id, 'VEHICULO')
    assert.equal(Number(sinAvance.comision.montoAsesor), recValues.valorRecurrente)
    assert.notEqual(
      Number(sinAvance.comision.montoAsesor),
      antes,
      'control: sin Avance sí reclasifica'
    )
  }).timeout(120000)
})
