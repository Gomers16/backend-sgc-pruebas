import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Certificacion from '#models/certificacion'
import Database from '@adonisjs/lucid/services/db'

// "Segunda vez" — Entrega A: resultado APROBADA/RECHAZADA en Certificación
// y apertura de la ventana de 360 h. Escribe en la BD compartida: placas
// TST930–TST939 y TST946–TST948 y limpieza completa al final (turnos, certificaciones por
// cascade, imágenes subidas y usuario de prueba).

const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const SERVICIO = { RTM: 1, PREV: 2, PERI: 3, SOAT: 4 } as const

const PLACAS = {
  RTM_RECHAZADA: 'TST930',
  RTM_SIN_RESULTADO: 'TST931',
  PREV_RECHAZADA: 'TST932',
  SOAT: 'TST933',
  PERI: 'TST934',
  PREV_SIN_RESULTADO: 'TST935',
  CANCELADO: 'TST936',
  DOBLE_RECHAZO: 'TST937',
  RTM_APROBADA: 'TST938',
  FINALIZADO_SIN_CERT: 'TST939',
  FINALIZADO_SIN_SALIDA: 'TST946',
  INACTIVO: 'TST947',
  FINALIZADO_CON_CERT: 'TST948',
}

// PNG 1x1 válido
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

test.group('Segunda vez · Certificación con resultado', (group) => {
  let usuarioTest: Usuario
  let token: string
  let imagenPath: string
  const turnoIds: Record<string, number> = {}

  async function crearTurno(
    placa: string,
    servicioId: number,
    extra: Record<string, unknown> = {}
  ): Promise<number> {
    const hoy = DateTime.local().setZone('America/Bogota')
    const t = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuarioTest.id,
      servicioId,
      fecha: hoy,
      horaIngreso: '08:00',
      tieneFacturacion: true,
      // Números negativos: no compiten por los slots únicos reales del día.
      turnoNumero: -(9000 + Number(placa.slice(3))),
      turnoNumeroServicio: -(9000 + Number(placa.slice(3))),
      turnoCodigo: `TST-SV-${placa}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
      ...extra,
    } as any)
    return t.id
  }

  function certificar(client: any, turnoId: number, resultado?: string) {
    const req = client
      .post('/api/certificaciones')
      .header('Authorization', `Bearer ${token}`)
      .field('turno_id', String(turnoId))
      .file('imagen', imagenPath)
    return resultado === undefined ? req : req.field('resultado', resultado)
  }

  group.setup(async () => {
    usuarioTest = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'SEGUNDA-VEZ-CERT',
      correo: `test.segunda.vez.cert.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuarioTest)
    token = tokenObj.value!.release()

    imagenPath = app.tmpPath(`tst_segunda_vez_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)

    turnoIds.rtmRechazada = await crearTurno(PLACAS.RTM_RECHAZADA, SERVICIO.RTM)
    turnoIds.rtmSinResultado = await crearTurno(PLACAS.RTM_SIN_RESULTADO, SERVICIO.RTM)
    turnoIds.prevRechazada = await crearTurno(PLACAS.PREV_RECHAZADA, SERVICIO.PREV)
    turnoIds.soat = await crearTurno(PLACAS.SOAT, SERVICIO.SOAT)
    turnoIds.peri = await crearTurno(PLACAS.PERI, SERVICIO.PERI)
    turnoIds.prevSinResultado = await crearTurno(PLACAS.PREV_SIN_RESULTADO, SERVICIO.PREV)
    turnoIds.cancelado = await crearTurno(PLACAS.CANCELADO, SERVICIO.RTM, { estado: 'cancelado' })
    turnoIds.dobleRechazo = await crearTurno(PLACAS.DOBLE_RECHAZO, SERVICIO.RTM, {
      esSegundaVez: true,
    })
    turnoIds.rtmAprobada = await crearTurno(PLACAS.RTM_APROBADA, SERVICIO.RTM)
    turnoIds.finalizadoSinCert = await crearTurno(PLACAS.FINALIZADO_SIN_CERT, SERVICIO.RTM, {
      estado: 'finalizado',
      horaSalida: '09:15:00',
      tiempoServicio: '1 h 15 min',
    })
    turnoIds.finalizadoSinSalida = await crearTurno(PLACAS.FINALIZADO_SIN_SALIDA, SERVICIO.RTM, {
      estado: 'finalizado',
    })
    turnoIds.inactivo = await crearTurno(PLACAS.INACTIVO, SERVICIO.RTM, { estado: 'inactivo' })
    turnoIds.finalizadoConCert = await crearTurno(PLACAS.FINALIZADO_CON_CERT, SERVICIO.RTM, {
      estado: 'finalizado',
      horaSalida: '09:00:00',
    })
    // Certificación previa insertada directo (sin imagen real en disco)
    await Certificacion.create({
      turnoId: turnoIds.finalizadoConCert,
      usuarioId: usuarioTest.id,
      imagenPath: 'uploads/certificaciones/tst_inexistente.png',
      observaciones: null,
    })
  })

  group.teardown(async () => {
    const placas = Object.values(PLACAS)
    const ids = Object.values(turnoIds)
    if (ids.length) {
      const certs = await Certificacion.query().whereIn('turno_id', ids)
      for (const c of certs) {
        await fs.unlink(app.makePath(c.imagenPath)).catch(() => {})
      }
    }
    // certificaciones se borran por ON DELETE CASCADE
    await Database.rawQuery(
      `DELETE FROM turnos_rtms WHERE placa IN (${placas.map(() => '?').join(',')})`,
      placas
    )
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    if (usuarioTest) await usuarioTest.delete()
  })

  test('RTM RECHAZADA llena rechazado_at (hora servidor) y hasta = +360 h exactas', async ({
    client,
    assert,
  }) => {
    const antes = DateTime.now().startOf('second')
    const res = await certificar(client, turnoIds.rtmRechazada, 'RECHAZADA')
    const despues = DateTime.now()
    res.assertStatus(201)

    const t = await TurnoRtm.findOrFail(turnoIds.rtmRechazada)
    const cert = await Certificacion.query().where('turno_id', t.id).firstOrFail()
    assert.equal(t.estado, 'finalizado')
    assert.isNotNull(t.horaSalida)
    assert.equal(t.resultadoCertificacion, 'RECHAZADA')
    assert.equal(cert.resultado, 'RECHAZADA')
    assert.isNotNull(t.rechazadoAt)
    assert.isNotNull(t.ventanaSegundaVezHasta)
    assert.isTrue(t.rechazadoAt! >= antes && t.rechazadoAt! <= despues)
    assert.equal(
      t.ventanaSegundaVezHasta!.diff(t.rechazadoAt!, 'milliseconds').milliseconds,
      360 * 3600 * 1000
    )
    assert.isFalse(Boolean(t.esSegundaVez))
  })

  test('RTM sin resultado → 422 y el turno sigue activo sin certificación', async ({
    client,
    assert,
  }) => {
    const res = await certificar(client, turnoIds.rtmSinResultado)
    res.assertStatus(422)
    const t = await TurnoRtm.findOrFail(turnoIds.rtmSinResultado)
    assert.equal(t.estado, 'activo')
    const cert = await Certificacion.query().where('turno_id', t.id).first()
    assert.isNull(cert)
  })

  test('RTM con resultado inválido → 422', async ({ client }) => {
    const res = await certificar(client, turnoIds.rtmSinResultado, 'QUIZAS')
    res.assertStatus(422)
  })

  test('PREV sin resultado → 422', async ({ client }) => {
    const res = await certificar(client, turnoIds.prevSinResultado)
    res.assertStatus(422)
  })

  test('PREV RECHAZADA se comporta igual que RTM', async ({ client, assert }) => {
    const res = await certificar(client, turnoIds.prevRechazada, 'RECHAZADA')
    res.assertStatus(201)
    const t = await TurnoRtm.findOrFail(turnoIds.prevRechazada)
    assert.equal(t.resultadoCertificacion, 'RECHAZADA')
    assert.isNotNull(t.rechazadoAt)
    assert.equal(t.ventanaSegundaVezHasta!.diff(t.rechazadoAt!, 'hours').hours, 360)
  })

  test('RTM APROBADA guarda el resultado sin abrir ventana', async ({ client, assert }) => {
    const res = await certificar(client, turnoIds.rtmAprobada, 'APROBADA')
    res.assertStatus(201)
    const t = await TurnoRtm.findOrFail(turnoIds.rtmAprobada)
    assert.equal(t.resultadoCertificacion, 'APROBADA')
    assert.isNull(t.rechazadoAt)
    assert.isNull(t.ventanaSegundaVezHasta)
  })

  test('SOAT y PERI: resultado ignorado, no se abre ventana, se certifica igual', async ({
    client,
    assert,
  }) => {
    const resSoat = await certificar(client, turnoIds.soat, 'RECHAZADA')
    resSoat.assertStatus(201)
    const resPeri = await certificar(client, turnoIds.peri) // sin resultado: no es obligatorio
    resPeri.assertStatus(201)

    for (const id of [turnoIds.soat, turnoIds.peri]) {
      const t = await TurnoRtm.findOrFail(id)
      const cert = await Certificacion.query().where('turno_id', id).firstOrFail()
      assert.equal(t.estado, 'finalizado')
      assert.isNull(t.resultadoCertificacion)
      assert.isNull(t.rechazadoAt)
      assert.isNull(t.ventanaSegundaVezHasta)
      assert.isNull(cert.resultado)
    }
  })

  test('Recertificar un turno ya certificado → 409', async ({ client, assert }) => {
    const res = await certificar(client, turnoIds.rtmRechazada, 'APROBADA')
    res.assertStatus(409)
    const certs = await Certificacion.query().where('turno_id', turnoIds.rtmRechazada)
    assert.lengthOf(certs, 1)
    const t = await TurnoRtm.findOrFail(turnoIds.rtmRechazada)
    assert.equal(t.resultadoCertificacion, 'RECHAZADA')
  })

  test('Certificar un turno cancelado → 409', async ({ client, assert }) => {
    const res = await certificar(client, turnoIds.cancelado, 'APROBADA')
    res.assertStatus(409)
    const t = await TurnoRtm.findOrFail(turnoIds.cancelado)
    assert.equal(t.estado, 'cancelado')
    assert.isNull(t.resultadoCertificacion)
  })

  test('Doble rechazo: segunda vez (es_segunda_vez=1) RECHAZADA deja ventana_hasta NULL', async ({
    client,
    assert,
  }) => {
    const res = await certificar(client, turnoIds.dobleRechazo, 'RECHAZADA')
    res.assertStatus(201)
    const t = await TurnoRtm.findOrFail(turnoIds.dobleRechazo)
    assert.isTrue(Boolean(t.esSegundaVez))
    assert.equal(t.resultadoCertificacion, 'RECHAZADA')
    assert.isNotNull(t.rechazadoAt)
    assert.isNull(t.ventanaSegundaVezHasta)
  })

  test('Finalizado SIN certificación se puede certificar: conserva horaSalida/tiempoServicio y abre ventana si es RECHAZADA', async ({
    client,
    assert,
  }) => {
    const res = await certificar(client, turnoIds.finalizadoSinCert, 'RECHAZADA')
    res.assertStatus(201)
    const t = await TurnoRtm.findOrFail(turnoIds.finalizadoSinCert)
    const cert = await Certificacion.query().where('turno_id', t.id).firstOrFail()
    assert.equal(t.estado, 'finalizado')
    assert.equal(t.horaSalida, '09:15:00')
    assert.equal(t.tiempoServicio, '1 h 15 min')
    assert.equal(t.certificacionFuncionarioId, usuarioTest.id)
    assert.equal(cert.resultado, 'RECHAZADA')
    assert.equal(t.resultadoCertificacion, 'RECHAZADA')
    assert.isNotNull(t.rechazadoAt)
    assert.equal(t.ventanaSegundaVezHasta!.diff(t.rechazadoAt!, 'hours').hours, 360)
  })

  test('Finalizado sin horaSalida: se certifica y calcula horaSalida como siempre', async ({
    client,
    assert,
  }) => {
    const res = await certificar(client, turnoIds.finalizadoSinSalida, 'APROBADA')
    res.assertStatus(201)
    const t = await TurnoRtm.findOrFail(turnoIds.finalizadoSinSalida)
    assert.equal(t.estado, 'finalizado')
    assert.match(t.horaSalida ?? '', /^\d{2}:\d{2}:\d{2}$/)
    assert.isNotNull(t.tiempoServicio)
    assert.equal(t.resultadoCertificacion, 'APROBADA')
  })

  test('Inactivo → 409 TURNO_NO_ACTIVO', async ({ client, assert }) => {
    const res = await certificar(client, turnoIds.inactivo, 'APROBADA')
    res.assertStatus(409)
    res.assertBodyContains({ code: 'TURNO_NO_ACTIVO' })
    const cert = await Certificacion.query().where('turno_id', turnoIds.inactivo).first()
    assert.isNull(cert)
  })

  test('Cancelado → 409 TURNO_NO_ACTIVO', async ({ client }) => {
    const res = await certificar(client, turnoIds.cancelado, 'APROBADA')
    res.assertStatus(409)
    res.assertBodyContains({ code: 'TURNO_NO_ACTIVO' })
  })

  test('Finalizado CON certificación → 409 YA_CERTIFICADO', async ({ client, assert }) => {
    const res = await certificar(client, turnoIds.finalizadoConCert, 'RECHAZADA')
    res.assertStatus(409)
    res.assertBodyContains({ code: 'YA_CERTIFICADO' })
    const t = await TurnoRtm.findOrFail(turnoIds.finalizadoConCert)
    assert.isNull(t.resultadoCertificacion)
    assert.isNull(t.ventanaSegundaVezHasta)
    const certs = await Certificacion.query().where('turno_id', t.id)
    assert.lengthOf(certs, 1)
  })
})
