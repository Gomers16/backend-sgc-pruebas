import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import CaptacionDateo from '#models/captacion_dateo'
import Certificacion from '#models/certificacion'

// Certificación de un servicio NO RTM (PREV, PERI) marca EXITOSO el dateo del
// turno si es del mismo servicio, con resultado APROBADA o RECHAZADA (regla
// compartida con registrarSalida: marcarDateoExitosoAlFinalizarNoRtm). RTM no:
// su dateo se cierra al confirmar Facturación. Escribe en la BD compartida:
// placas TST900–TST904, limpieza completa al final.

const SEDE_ID = 2
const ROL_SUPER_ADMIN_ID = 9
const SERVICIO = { RTM: 1, PREV: 2, PERI: 3 } as const

const P = {
  PREV_RECHAZADA: 'TST900',
  PREV_APROBADA: 'TST901',
  PERI: 'TST902',
  RTM: 'TST903',
  PREV_DATEO_OTRO_SERVICIO: 'TST904',
}

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

test.group('Certificación · dateo de servicios no RTM', (group) => {
  let usuario: Usuario
  let token: string
  let imagenPath: string
  let numero = 0

  /** Turno activo con un dateo EN_PROCESO ya consumido por él. */
  async function turnoConDateo(placa: string, servicioId: number, servicioDateoId = servicioId) {
    numero++
    const turno = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuario.id,
      servicioId,
      fecha: DateTime.now().setZone('America/Bogota'),
      horaIngreso: '08:00',
      tieneFacturacion: true,
      turnoNumero: -(9900 + numero),
      turnoNumeroServicio: -(9900 + numero),
      turnoCodigo: `TST-CERT-NORTM-${placa}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: 'activo',
    } as any)
    const dateo = await CaptacionDateo.create({
      canal: 'FACHADA',
      origen: 'UI',
      placa,
      servicioId: servicioDateoId,
      resultado: 'EN_PROCESO',
      consumidoTurnoId: turno.id,
      consumidoAt: DateTime.now(),
    } as any)
    turno.captacionDateoId = dateo.id
    await turno.save()
    return { turno, dateo }
  }

  function certificar(client: any, turnoId: number, resultado?: string) {
    const req = client
      .post('/api/certificaciones')
      .header('Authorization', `Bearer ${token}`)
      .field('turno_id', String(turnoId))
      .file('imagen', imagenPath)
    return resultado ? req.field('resultado', resultado) : req
  }

  async function resultadoDateo(id: number) {
    const dateo = await CaptacionDateo.findOrFail(id)
    return dateo.resultado
  }

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'CERT-DATEO-NO-RTM',
      correo: `test.cert.dateo.nortm.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuario)
    token = tokenObj.value!.release()
    imagenPath = app.tmpPath(`tst_cert_nortm_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const marks = placas.map(() => '?').join(',')
    const filas = await Database.from('turnos_rtms').whereIn('placa', placas).select('id')
    const ids = filas.map((r: any) => r.id)
    if (ids.length) {
      const certs = await Certificacion.query().whereIn('turno_id', ids)
      for (const c of certs) await fs.unlink(app.makePath(c.imagenPath)).catch(() => {})
    }
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${marks})`, placas)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${marks})`, placas)
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    if (usuario) await usuario.delete()
  })

  test('PREV certificado RECHAZADA → dateo EXITOSO', async ({ client, assert }) => {
    const { turno, dateo } = await turnoConDateo(P.PREV_RECHAZADA, SERVICIO.PREV)
    const res = await certificar(client, turno.id, 'RECHAZADA')
    res.assertStatus(201)
    assert.equal(await resultadoDateo(dateo.id), 'EXITOSO')
  })

  test('PREV certificado APROBADA → dateo EXITOSO', async ({ client, assert }) => {
    const { turno, dateo } = await turnoConDateo(P.PREV_APROBADA, SERVICIO.PREV)
    const res = await certificar(client, turno.id, 'APROBADA')
    res.assertStatus(201)
    assert.equal(await resultadoDateo(dateo.id), 'EXITOSO')
  })

  test('PERI certificado (sin resultado) → dateo EXITOSO', async ({ client, assert }) => {
    const { turno, dateo } = await turnoConDateo(P.PERI, SERVICIO.PERI)
    const res = await certificar(client, turno.id)
    res.assertStatus(201)
    assert.equal(await resultadoDateo(dateo.id), 'EXITOSO')
  })

  test('RTM certificado → el dateo NO cambia (se cierra al confirmar Facturación)', async ({
    client,
    assert,
  }) => {
    const { turno, dateo } = await turnoConDateo(P.RTM, SERVICIO.RTM)
    const res = await certificar(client, turno.id, 'APROBADA')
    res.assertStatus(201)
    assert.equal(await resultadoDateo(dateo.id), 'EN_PROCESO')
  })

  test('PREV con dateo de otro servicio → el dateo NO cambia', async ({ client, assert }) => {
    const { turno, dateo } = await turnoConDateo(
      P.PREV_DATEO_OTRO_SERVICIO,
      SERVICIO.PREV,
      SERVICIO.RTM
    )
    const res = await certificar(client, turno.id, 'APROBADA')
    res.assertStatus(201)
    assert.equal(await resultadoDateo(dateo.id), 'EN_PROCESO')
  })
})
