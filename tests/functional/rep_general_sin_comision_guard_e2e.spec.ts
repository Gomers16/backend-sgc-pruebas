import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import TurnoRtm from '#models/turno_rtm'
import FacturacionTicket from '#models/facturacion_ticket'
import Comision from '#models/comision'
import Database from '@adonisjs/lucid/services/db'
import RepGeneralImportController from '#controllers/rep_general_imports_controller'

// Gap encontrado: rep_general_imports_controller.ts::recalcularComisionSiExiste()
// reclasifica esRecurrente/esRecuperacion (al subir un Rep General posterior)
// y pisaba montoAsesor con el valor recalculado sin revisar si un ticket de
// Excepción de Dateo ya lo había forzado a $0 a propósito ("Aprobar sin
// comisión"). Fix: debeRespetarSinComision() en reserva_dateo_service.ts,
// compartida con facturacion_tickets_controller.ts::applyCommissionHook().
const PLACA_GUARD = 'TSTRGG1E' // Caso 1, sin comisión — debe quedar protegido
const PLACA_CONTROL = 'TSTRGG2E' // Caso 1, con comisión — debe recalcular normal
const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const SERVICIO_RTM_ID = 1

const EVIDENCIA_PATH = path.join(os.tmpdir(), 'rep-general-guard-e2e-evidencia.png')
const EVIDENCIA_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='

test.group('E2E manual - guard sin_comision en recalcularComisionSiExiste (Rep General)', (group) => {
  let usuarioTest: Usuario
  let agenteTest: AgenteCaptacion
  let token: string

  group.setup(async () => {
    fs.writeFileSync(EVIDENCIA_PATH, Buffer.from(EVIDENCIA_PNG_BASE64, 'base64'))

    usuarioTest = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'REPGENERAL-GUARD-E2E',
      correo: `test.repgeneral.guard.e2e.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuarioTest)
    token = tokenObj.value!.release()

    agenteTest = await AgenteCaptacion.create({
      tipo: 'ASESOR_COMERCIAL',
      nombre: 'TEST REPGENERAL GUARD COMERCIAL',
    } as any)
  })

  group.teardown(async () => {
    const placas = [PLACA_GUARD, PLACA_CONTROL]
    const placeholders = placas.map(() => '?').join(', ')
    await Database.rawQuery(
      `DELETE FROM tickets_detalle_excepcion_dateo WHERE comercial_id = ?`,
      [agenteTest.id]
    )
    await Database.rawQuery(
      `DELETE FROM tickets WHERE ${placas.map(() => 'titulo LIKE ?').join(' OR ')}`,
      placas.map((p) => `%${p}%`)
    )
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${placeholders}))`,
      placas
    )
    await Database.rawQuery(`DELETE FROM facturacion_tickets WHERE placa IN (${placeholders})`, placas)
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${placeholders})`, placas)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${placeholders})`, placas)
    await agenteTest.delete()
    await usuarioTest.delete()
    try {
      fs.unlinkSync(EVIDENCIA_PATH)
    } catch {
      // no-op
    }
  })

  async function subirEvidencias(client: any) {
    async function subirUna() {
      const res = await client
        .post('/api/media/upload')
        .header('Authorization', `Bearer ${token}`)
        .file('file', EVIDENCIA_PATH)
      res.assertStatus(201)
      return res.body().url as string
    }
    return {
      chat: await subirUna(),
      whatsapp: await subirUna(),
      bloqueo: await subirUna(),
    }
  }

  // Crea un turno fuera de ventana (horaIngreso 00:05) + facturación
  // CONFIRMADA + ticket de Excepción de Dateo aprobado con `conComision`,
  // devuelve { turnoId, comisionId, montoAsesorInicial }.
  async function crearYAprobarTicket(
    client: any,
    assert: any,
    placa: string,
    conComision: boolean
  ): Promise<{ turnoId: number; comisionId: number; montoAsesorInicial: number }> {
    // turno_codigo tiene precisión de segundo con índice único — mismo
    // mitigador que tickets_excepcion_dateo_e2e.spec.ts.
    await new Promise((resolve) => setTimeout(resolve, 1100))
    const hoy = DateTime.local().setZone('America/Bogota')
    const resTurno = await client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuarioTest.id,
        fecha: hoy.toISODate(),
        horaIngreso: '00:05',
        servicioId: SERVICIO_RTM_ID,
      })
    resTurno.assertStatus(201)
    const turnoId = resTurno.body().id as number

    const facturacion = await FacturacionTicket.create({
      hash: `TEST-HASH-REPGENERAL-GUARD-${placa}-${Date.now()}`,
      filePath: 'test/fake.jpg',
      estado: 'CONFIRMADA',
      turnoId,
      placa,
      servicioCodigo: 'RTM',
    } as any)
    assert.exists(facturacion.id)

    const ev = await subirEvidencias(client)
    const resTicket = await client
      .post('/api/tickets-excepcion-dateo')
      .header('Authorization', `Bearer ${token}`)
      .json({
        turno_id: turnoId,
        comercial_id: agenteTest.id,
        observacion: `Prueba E2E guard rep general: Caso 1, con_comision=${conComision}`,
        evidencia_chat_url: ev.chat,
        evidencia_grupo_whatsapp_url: ev.whatsapp,
        evidencia_bloqueo_url: ev.bloqueo,
      })
    resTicket.assertStatus(201)
    const ticketId = resTicket.body().ticket.id as number

    const resAprobar = await client
      .patch(`/api/tickets-excepcion-dateo/${ticketId}/aprobar`)
      .header('Authorization', `Bearer ${token}`)
      .json({ con_comision: conComision })
    resAprobar.assertStatus(200)
    const aprobarBody = resAprobar.body()
    assert.exists(aprobarBody.comisionId, 'Debe crear la comisión (facturación ya estaba CONFIRMADA)')
    assert.equal(aprobarBody.conComision, conComision)

    const comisionCreada = await Comision.findOrFail(aprobarBody.comisionId)
    return {
      turnoId,
      comisionId: aprobarBody.comisionId,
      montoAsesorInicial: Number(comisionCreada.montoAsesor),
    }
  }

  test('ticket aprobado SIN comisión (Caso 1) -> Rep General reclasifica a RECURRENTE -> montoAsesor sigue en 0', async ({
    client,
    assert,
  }) => {
    const { turnoId, comisionId, montoAsesorInicial } = await crearYAprobarTicket(
      client,
      assert,
      PLACA_GUARD,
      false
    )
    assert.equal(montoAsesorInicial, 0, 'Precondición: aprobar sin comisión debe dejar montoAsesor=0')

    // Simula lo que hace empalmarTurnosDesdeFila() al subir un Rep General
    // posterior que reclasifica este turno como RECURRENTE — llamando
    // directamente al método privado (TypeScript solo bloquea esto a nivel
    // de compilación, no en runtime), sin pasar por el parseo de CSV/XLSX
    // que está fuera del alcance de este test.
    const controller = new RepGeneralImportController()
    await (controller as any).recalcularComisionSiExiste(
      // dateoId: se resuelve leyendo el turno recién vinculado.
      (await TurnoRtm.findOrFail(turnoId)).captacionDateoId,
      {
        esRecurrente: true,
        esRecuperacion: false,
        mesesDesdeUltimaVisita: 3,
        ultimoTurnoId: null,
        fechaUltimaVisita: null,
        estadoContinuidad: null,
      },
      'Liviano Particular'
    )

    const turnoTrasRecalculo = await TurnoRtm.findOrFail(turnoId)
    // mysql2 devuelve TINYINT(1) como 0/1 (no boolean real) en una lectura
    // directa de modelo — Boolean() en vez de isTrue estricto, mismo
    // criterio ya documentado para dentroVentana en tickets_excepcion_dateo_controller.ts.
    assert.isTrue(
      Boolean(turnoTrasRecalculo.esRecurrente),
      'El turno sí debe quedar marcado esRecurrente=true — la reclasificación en sí no se bloquea'
    )

    const comisionTrasRecalculo = await Comision.findOrFail(comisionId)
    assert.equal(
      Number(comisionTrasRecalculo.montoAsesor),
      0,
      'GUARD: montoAsesor debe seguir en 0 — el Rep General no debe revertir la decisión de gerencia'
    )
  }).timeout(60000)

  test('CONTROL: ticket aprobado CON comisión (Caso 1) -> Rep General reclasifica a RECURRENTE -> SÍ recalcula normal', async ({
    client,
    assert,
  }) => {
    const { turnoId, comisionId, montoAsesorInicial } = await crearYAprobarTicket(
      client,
      assert,
      PLACA_CONTROL,
      true
    )
    assert.isTrue(montoAsesorInicial > 0, 'Precondición: aprobar con comisión debe pagar el monto completo')

    // Mismo cálculo que hace el controller internamente, para no hardcodear
    // el valor esperado — así el test no depende de qué esté configurado
    // hoy en configuracion_recurrencia_global de esta BD compartida.
    const configGlobal = await Database.from('configuracion_recurrencia_global')
      .orderBy('id', 'asc')
      .first()
    const valorRecurrenteEsperado = Number(
      configGlobal?.valor_dateo_recurrencia_vehiculo ?? configGlobal?.valor_dateo_recurrencia ?? 4300
    )

    const controller = new RepGeneralImportController()
    await (controller as any).recalcularComisionSiExiste(
      (await TurnoRtm.findOrFail(turnoId)).captacionDateoId,
      {
        esRecurrente: true,
        esRecuperacion: false,
        mesesDesdeUltimaVisita: 3,
        ultimoTurnoId: null,
        fechaUltimaVisita: null,
        estadoContinuidad: null,
      },
      'Liviano Particular'
    )

    const comisionTrasRecalculo = await Comision.findOrFail(comisionId)
    assert.equal(
      Number(comisionTrasRecalculo.montoAsesor),
      valorRecurrenteEsperado,
      'CONTROL: sin ticket "sin comisión" de por medio, el Rep General debe seguir recalculando montoAsesor con normalidad'
    )
    assert.notEqual(
      Number(comisionTrasRecalculo.montoAsesor),
      montoAsesorInicial,
      'CONTROL: el monto debe haber cambiado respecto al valor "nuevo" original — prueba que el guard no bloqueó el recalculo'
    )
  }).timeout(60000)
})
