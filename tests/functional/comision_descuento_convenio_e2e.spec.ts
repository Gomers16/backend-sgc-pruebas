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
  convenioSinComisionPorDescuento,
  esDescuentoFinalAvance,
  resolveConfigComision,
  resolveConfigRecurrencia,
  type CasoComision,
  type EscenarioCliente,
  type TipoVehiculoComision,
} from '#services/comision_calculo_service'

// Con convenio (Casos 2 y 3), cualquier descuento que quede en la factura
// final deja en $0 la comisión del convenio, en todos los escenarios y con
// cualquier monto (convenioSinComisionPorDescuento). Caso 3 → el comercial
// conserva su valor; Caso 2 → el asesor convenio en $0; Caso 1 no cambia.
// Cada combinación se confirma por la API y se compara: motor (configuración
// vigente) = guardado = GET /comisiones/:id = previsualización del diálogo.
// Todo lo creado aquí se borra en el teardown (por placa y por usuario).

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const AGENTE_COMERCIAL_ID = 1
const ROL_SUPER_ADMIN = 9
/** Descuentos con monto libre; los demás usan el valor del catálogo (Obsequio y SOAT-RTM: $0). */
const MONTO_LIBRE = new Set(['INFORMATIVO', 'AVANCE'])

const PLACAS = Array.from({ length: 200 }, (_, i) => `TDC${String(100 + i)}`)
const RUN = Date.now().toString(36).toUpperCase()
let siguientePlaca = 0
const placa = () => PLACAS[siguientePlaca++]

const CASOS: CasoComision[] = ['SIN_CONVENIO', 'CONVENIO_SELF', 'CONVENIO_COMERCIAL']
const ESCENARIOS: EscenarioCliente[] = ['NUEVO', 'RECURRENTE', 'RECUPERACION']
const VEHICULOS: TipoVehiculoComision[] = ['MOTO', 'VEHICULO']

interface FilaDescuento {
  id: number
  codigo: string
  valorCarro: number
  valorMoto: number
}

interface OpcionesTicket {
  caso: CasoComision
  tv?: TipoVehiculoComision
  escenario?: EscenarioCliente
  /** Descuento final de la factura (null = sin descuento). */
  descuentoCaja?: number | null
  monto?: number | null
  /** Descuento pre-marcado en el dateo. */
  premarcado?: number | null
}

test.group(
  'Comisiones: con convenio, cualquier descuento final deja al convenio en $0',
  (group) => {
    let admin: Usuario
    let token = ''
    let convenioAsesor: AgenteCaptacion
    let convenio: Convenio
    let catalogo: FilaDescuento[] = []
    let turnoNumero = 950000 + Math.floor(Math.random() * 9000)
    const id = (codigo: string) => catalogo.find((d) => d.codigo === codigo)!.id

    group.setup(async () => {
      const filas = await Database.from('descuentos').where('activo', true).orderBy('id')
      catalogo = filas.map((d) => ({
        id: Number(d.id),
        codigo: String(d.codigo),
        valorCarro: Number(d.valor_carro ?? 0),
        valorMoto: Number(d.valor_moto ?? 0),
      }))
      admin = await Usuario.create({
        nombres: 'TEST',
        apellidos: 'DESCUENTO-CONVENIO',
        correo: `test.descuento.convenio.${Date.now()}@test.local`,
        password: 'Test1234!Aa',
        rolId: ROL_SUPER_ADMIN,
        sedeId: SEDE_ID,
      } as any)
      const tokenObj = await Usuario.accessTokens.create(admin)
      token = tokenObj.value!.release()
      convenioAsesor = await AgenteCaptacion.create({
        tipo: 'ASESOR_CONVENIO',
        nombre: `TEST DESCUENTO CONVENIO ASESOR ${RUN}`,
        activo: true,
      } as any)
      convenio = await Convenio.create({
        tipo: 'TALLER',
        nombre: `TEST DESCUENTO CONVENIO ${RUN}`,
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

    /** Monto del descuento: libre (10.000) o el del catálogo para el vehículo. */
    const montoDe = (codigo: string, tv: TipoVehiculoComision) => {
      if (MONTO_LIBRE.has(codigo)) return 10000
      const d = catalogo.find((x) => x.codigo === codigo)!
      return tv === 'MOTO' ? d.valorMoto : d.valorCarro
    }

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
        turnoCodigo: `RTM-TDC-${RUN}-${turnoNumero}`,
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
        hash: `test-hash-tdc-${p}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        filePath: 'test/fixture.jpg',
        estado: 'BORRADOR',
        placa: p,
        total: 200000,
        totalFactura: 200000,
        totalSinDescuento: 200000,
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
        consecutivoDescuento: descuentoId ? `TDC-${RUN}-${p}` : null,
        // Policía exige los 3 documentos para editar el descuento.
        docCarnetPath: 'test/carnet.jpg',
        docTarjetaPropiedadPath: 'test/tarjeta.jpg',
        docCedulaPath: 'test/cedula.jpg',
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
    async function esperado(
      o: OpcionesTicket,
      codigo: string | null,
      codigoFinal: string | null,
      turno: TurnoRtm
    ) {
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
        montoAvance: 0,
        codigoDescuento: codigo,
        codigoDescuentoFinal: codigoFinal,
        cfgValues,
        recValues,
      })
      return { r, cfgValues, recValues }
    }

    const leerGet = async (client: any, comisionId: number) => {
      const g = await client
        .get(`/api/comisiones/${comisionId}`)
        .header('Authorization', `Bearer ${token}`)
      if (g.status() !== 200) throw new Error(`GET /comisiones/${comisionId}: ${g.status()}`)
      return g.body()
    }

    const leerDesglose = async (client: any, comisionId: number) => {
      const g = await leerGet(client, comisionId)
      return g.desglose_motor
    }

    const previsualizar = (client: any, ticketId: number, body: Record<string, unknown>) =>
      client
        .patch(`/api/facturacion/tickets/${ticketId}`)
        .header('Authorization', `Bearer ${token}`)
        .json({ ...body, solo_previsualizar: true })

    const guardar = (client: any, ticketId: number, body: Record<string, unknown>) =>
      client
        .patch(`/api/facturacion/tickets/${ticketId}`)
        .header('Authorization', `Bearer ${token}`)
        .json({ ...body, motivo_edicion: 'Prueba: descuento con convenio' })

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

    test('matriz por la API: 7 descuentos y sin descuento × 3 casos × escenarios × vehículos', async ({
      assert,
      client,
    }) => {
      const codigos: (string | null)[] = [null, ...catalogo.map((d) => d.codigo)]
      assert.lengthOf(codigos, 8, 'catálogo de 7 descuentos')
      let n = 0
      for (const caso of CASOS)
        for (const tv of VEHICULOS)
          for (const escenario of ESCENARIOS)
            for (const codigo of codigos) {
              const o: OpcionesTicket = {
                caso,
                tv,
                escenario,
                descuentoCaja: codigo ? id(codigo) : null,
                monto: codigo ? montoDe(codigo, tv) : null,
              }
              const donde = `${caso}/${tv}/${escenario}/${codigo}`
              const x = await confirmarTicket(client, o)
              const { r, cfgValues } = await esperado(o, codigo, codigo, x.turno)
              const d = await compararLecturas(assert, client, donde, x, r)
              n++

              const enCero = convenioSinComisionPorDescuento({ caso, codigoDescuentoFinal: codigo })
              assert.equal(enCero, caso !== 'SIN_CONVENIO' && !!codigo, donde)
              assert.equal(d.descuento.convenioSinComision, enCero, donde)
              assert.equal(
                Boolean(x.comision.esAvance),
                esDescuentoFinalAvance({ caso, codigoDescuentoFinal: codigo }),
                donde
              )
              if (caso === 'CONVENIO_COMERCIAL') {
                assert.equal(Number(x.comision.montoAsesor), cfgValues.valorDateoNuevo, donde)
                assert.equal(
                  Number(x.comision.montoConvenio),
                  enCero ? 0 : cfgValues.valorIncentivoCaso3,
                  donde
                )
              }
              if (caso === 'CONVENIO_SELF' && enCero) {
                assert.equal(Number(x.comision.montoAsesor), 0, donde)
              }
              assert.notExists(
                d.alertas.find((a: any) => a.codigo === 'AVANCE_HEREDADO'),
                `${donde}: aviso eliminado`
              )
            }
      assert.equal(n, CASOS.length * VEHICULOS.length * ESCENARIOS.length * codigos.length)
    }).timeout(900000)

    test('editar una factura sin descuento agregando uno: PENDIENTE baja, APROBADA se recalcula, PAGADA exige la casilla', async ({
      assert,
      client,
    }) => {
      for (const estado of ['PENDIENTE', 'APROBADA', 'PAGADA'] as const) {
        const x = await confirmarTicket(client, {
          caso: 'CONVENIO_COMERCIAL',
          escenario: 'RECURRENTE',
        })
        const asesorAntes = Number(x.comision.montoAsesor)
        const convenioAntes = Number(x.comision.montoConvenio)
        assert.isAbove(convenioAntes, 0, 'el convenio cobraba sin descuento')
        if (estado !== 'PENDIENTE') {
          await Database.from('comisiones').where('id', x.comision.id).update({ estado })
        }
        const body = {
          descuento_id: id('INFORMATIVO'),
          descuento_monto_aplicado: 10000,
          autorizado_por_id: admin.id,
          consecutivo_descuento: `TDC-${RUN}-ED-${estado}`,
        }
        const previa = await previsualizar(client, x.ticket.id, body)
        assert.equal(previa.status(), 200, previa.text())
        const p = previa.body().comision
        assert.equal(p.estado, estado)
        assert.equal(p.diferencia.convenio, -convenioAntes, estado)
        assert.equal(p.despues.montoAsesor, asesorAntes, estado)
        assert.equal(p.despues.montoConvenio, 0, estado)
        assert.isTrue(p.desglose.descuento.convenioSinComision, estado)
        if (estado === 'PAGADA') {
          // La pantalla muestra la casilla "ya se pagó"; sin ella no guarda.
          assert.equal(p.accion, 'AJUSTADA_TRAS_PAGO')
          assert.isTrue(p.requiereConfirmacionPago)
          const sinCasilla = await guardar(client, x.ticket.id, body)
          assert.equal(sinCasilla.status(), 409, sinCasilla.text())
          assert.equal(sinCasilla.body().code, 'COMISION_PAGADA_SIN_CONFIRMAR')
          const intacta = await Database.from('comisiones').where('id', x.comision.id).first()
          assert.equal(Number(intacta.monto_convenio), convenioAntes, 'sin casilla no cambia')
        } else {
          // PENDIENTE y APROBADA: el diálogo pide confirmar el cambio "de … a …".
          assert.equal(p.accion, 'RECALCULADA', estado)
          assert.isFalse(p.requiereConfirmacionPago, estado)
        }

        const ok = await guardar(
          client,
          x.ticket.id,
          estado === 'PAGADA' ? { ...body, confirmar_comision_pagada: true } : body
        )
        assert.equal(ok.status(), 200, ok.text())
        const fila = await Database.from('comisiones').where('id', x.comision.id).first()
        assert.equal(fila.estado, estado, 'el estado no cambia')
        assert.equal(Number(fila.monto_convenio), 0, estado)
        assert.equal(Number(fila.monto_asesor), asesorAntes, estado)

        const m = await leerDesglose(client, x.comision.id)
        assert.notExists(m.alertas.find((a: any) => a.codigo === 'DISTINTO_AL_MOTOR'))
        assert.equal(m.beneficiarios.find((b: any) => b.rol === 'CONVENIO').despues, 0)
      }
    }).timeout(120000)

    test('editar: quitar el descuento devuelve la comisión al convenio; cambiarlo por otro la deja en $0', async ({
      assert,
      client,
    }) => {
      const x = await confirmarTicket(client, {
        caso: 'CONVENIO_COMERCIAL',
        descuentoCaja: id('INFORMATIVO'),
        monto: 10000,
      })
      const { r: sin } = await esperado({ caso: 'CONVENIO_COMERCIAL' }, null, null, x.turno)
      assert.equal(Number(x.comision.montoConvenio), 0)

      // Cambiar por otro (Obsequio, monto $0) → sigue en $0.
      const cambio = {
        descuento_id: id('INFORMATIVO_OBSEQUIO'),
        descuento_monto_aplicado: 0,
        autorizado_por_id: admin.id,
        consecutivo_descuento: `TDC-${RUN}-CAMBIO`,
      }
      const resCambio = await previsualizar(client, x.ticket.id, cambio)
      const pCambio = resCambio.body().comision
      assert.equal(pCambio.despues.montoConvenio, 0)
      assert.equal(pCambio.diferencia.total, 0)
      const guardaCambio = await guardar(client, x.ticket.id, cambio)
      assert.equal(guardaCambio.status(), 200, guardaCambio.text())
      let fila = await Database.from('comisiones').where('id', x.comision.id).first()
      assert.equal(Number(fila.monto_convenio), 0)
      assert.equal(fila.descuento_codigo_aplicado, 'INFORMATIVO_OBSEQUIO')

      // Quitarlo → el convenio vuelve a cobrar su valor normal.
      const quitar = { descuento_id: null }
      const resQuitar = await previsualizar(client, x.ticket.id, quitar)
      const pQuitar = resQuitar.body().comision
      assert.equal(pQuitar.despues.montoConvenio, sin.montoConvenio)
      assert.isFalse(pQuitar.desglose.descuento.convenioSinComision)
      const guardaQuitar = await guardar(client, x.ticket.id, quitar)
      assert.equal(guardaQuitar.status(), 200, guardaQuitar.text())
      fila = await Database.from('comisiones').where('id', x.comision.id).first()
      assert.equal(Number(fila.monto_convenio), sin.montoConvenio)
      assert.equal(Number(fila.monto_asesor), sin.montoAsesor)
    }).timeout(120000)

    test('bordes: pre-marcado quitado o cambiado en caja, Avance en $0, Caso 2 y Caso 1', async ({
      assert,
      client,
    }) => {
      // Pre-marcado en el dateo y la cajera lo quita → el convenio cobra.
      const quita = await confirmarTicket(client, {
        caso: 'CONVENIO_COMERCIAL',
        premarcado: id('AVANCE'),
        descuentoCaja: null,
      })
      const { r: rQuita } = await esperado(
        { caso: 'CONVENIO_COMERCIAL' },
        'AVANCE',
        null,
        quita.turno
      )
      assert.isAbove(Number(quita.comision.montoConvenio), 0)
      assert.equal(Number(quita.comision.montoConvenio), rQuita.montoConvenio)
      assert.isFalse(Boolean(quita.comision.esAvance))
      const dQuita = await leerDesglose(client, quita.comision.id)
      assert.isNull(dQuita.descuento.codigo, 'con convenio se muestra el descuento final')
      assert.isFalse(dQuita.descuento.convenioSinComision)

      // Avance pre-marcado cambiado a INFORMATIVO → convenio $0 igual.
      const cambia = await confirmarTicket(client, {
        caso: 'CONVENIO_COMERCIAL',
        premarcado: id('AVANCE'),
        descuentoCaja: id('INFORMATIVO'),
        monto: 10000,
      })
      assert.equal(Number(cambia.comision.montoConvenio), 0)
      assert.isFalse(Boolean(cambia.comision.esAvance))

      // Avance en caja con monto $0 → convenio $0.
      const cero = await confirmarTicket(client, {
        caso: 'CONVENIO_COMERCIAL',
        descuentoCaja: id('AVANCE'),
        monto: 0,
      })
      assert.equal(Number(cero.comision.montoConvenio), 0)
      assert.isTrue(Boolean(cero.comision.esAvance))

      // Caso 2 con SOAT-RTM ($0) en caja, recurrente → $0.
      const self = await confirmarTicket(client, {
        caso: 'CONVENIO_SELF',
        escenario: 'RECURRENTE',
        descuentoCaja: id('INFORMATIVO_SOAT_RTM'),
        monto: 0,
      })
      assert.equal(Number(self.comision.montoAsesor), 0)

      // Caso 1 (regresión): Informativo con cliente nuevo → valor de recurrencia, como hoy.
      const c1 = await confirmarTicket(client, {
        caso: 'SIN_CONVENIO',
        descuentoCaja: id('INFORMATIVO'),
        monto: 10000,
      })
      const { recValues } = await esperado(
        { caso: 'SIN_CONVENIO' },
        'INFORMATIVO',
        'INFORMATIVO',
        c1.turno
      )
      assert.equal(Number(c1.comision.montoAsesor), recValues.valorRecurrente)
      assert.equal(Number(c1.comision.montoConvenio), 0)
    }).timeout(120000)

    test('Rep General: no reescribe la comisión del convenio en $0 por descuento (Casos 2 y 3); sin descuento sí reclasifica', async ({
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
      const reclasificar = (dateoId: number) =>
        (controller as any).recalcularComisionSiExiste(dateoId, rec, 'Liviano Particular')

      // Caso 2 con Informativo → $0 y se respeta.
      const self = await confirmarTicket(client, {
        caso: 'CONVENIO_SELF',
        descuentoCaja: id('INFORMATIVO'),
        monto: 10000,
      })
      assert.equal(Number(self.comision.montoAsesor), 0)
      await reclasificar(self.dateo.id)
      await self.comision.refresh()
      assert.equal(Number(self.comision.montoAsesor), 0, 'Caso 2 sigue en $0')
      assert.equal(Number(self.comision.monto), 0)

      // Caso 3 con Obsequio → convenio $0 y se respeta; el comercial no cambia.
      const comercial = await confirmarTicket(client, {
        caso: 'CONVENIO_COMERCIAL',
        descuentoCaja: id('INFORMATIVO_OBSEQUIO'),
        monto: 0,
      })
      const asesorAntes = Number(comercial.comision.montoAsesor)
      assert.equal(Number(comercial.comision.montoConvenio), 0)
      await reclasificar(comercial.dateo.id)
      await comercial.comision.refresh()
      assert.equal(Number(comercial.comision.montoConvenio), 0, 'Caso 3 convenio sigue en $0')
      assert.equal(Number(comercial.comision.montoAsesor), asesorAntes)

      // Control: Caso 2 sin descuento sí se reclasifica a recurrencia.
      const sinDescuento = await confirmarTicket(client, { caso: 'CONVENIO_SELF' })
      const antes = Number(sinDescuento.comision.montoAsesor)
      await reclasificar(sinDescuento.dateo.id)
      await sinDescuento.comision.refresh()
      const recValues = await resolveConfigRecurrencia(convenioAsesor.id, 'VEHICULO')
      assert.equal(Number(sinDescuento.comision.montoAsesor), recValues.valorRecurrente)
      assert.notEqual(
        Number(sinDescuento.comision.montoAsesor),
        antes,
        'control: sin descuento sí reclasifica'
      )
    }).timeout(120000)
  }
)
