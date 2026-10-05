import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Certificacion from '#models/certificacion'
import CertificacionResultadoCambio from '#models/certificacion_resultado_cambio'

// "Segunda vez" — Entrega C2, parte 1: PATCH /certificaciones/:turnoId/resultado
// (solo SUPER_ADMIN/GERENCIA, motivo obligatorio, auditoría). Escribe en la
// BD compartida: placas TST976–TST980, limpieza completa al final.

const SEDE_ID = 2
const SERVICIO = { RTM: 1, PREV: 2, SOAT: 4 } as const
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10, COMERCIAL: 11, CONTABILIDAD: 12, OPERATIVO_TURNOS: 14 }
const ZONA = 'America/Bogota'

const P = {
  RECHAZADA_A_APROBADA: 'TST976',
  APROBADA_A_RECHAZADA: 'TST977',
  CON_HIJA: 'TST978',
  SEGUNDA_VEZ: 'TST979',
  VARIOS: 'TST980',
}

test.group('Segunda vez · corrección del resultado (C2)', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const tokens: Record<string, string> = {}
  const ids: Record<string, Usuario> = {}
  let numero = 0
  const ahora = () => DateTime.now().setZone(ZONA)

  async function crearUsuario(clave: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `SV-C2-${clave}`,
      correo: `test.sv.c2.${clave.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(u)
    usuarios.push(u)
    ids[clave] = u
    tokens[clave] = tokenObj.value!.release()
  }

  /** Turno finalizado y certificado con el resultado dado (o activo sin certificar). */
  async function turnoCertificado(
    placa: string,
    o: {
      servicioId?: number
      resultado?: 'APROBADA' | 'RECHAZADA' | null
      esSegundaVez?: boolean
      turnoOrigenId?: number | null
      fecha?: DateTime
      sinCertificar?: boolean
    } = {}
  ) {
    numero++
    const rechazadoAt =
      o.resultado === 'RECHAZADA' ? ahora().minus({ hours: 2 }).startOf('second') : null
    const t = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: ids.ADMIN.id,
      servicioId: o.servicioId ?? SERVICIO.RTM,
      fecha: o.fecha ?? ahora().minus({ days: 1 }),
      horaIngreso: '08:00',
      horaSalida: o.sinCertificar ? null : '09:00:00',
      tieneFacturacion: true,
      turnoNumero: -(9600 + numero),
      turnoNumeroServicio: -(9600 + numero),
      turnoCodigo: `TST-SV-C2-${placa}-${numero}-${Date.now()}`,
      placa,
      tipoVehiculo: 'Liviano Particular',
      estado: o.sinCertificar ? 'activo' : 'finalizado',
      resultadoCertificacion: o.resultado ?? null,
      rechazadoAt,
      ventanaSegundaVezHasta:
        rechazadoAt && !o.esSegundaVez ? rechazadoAt.plus({ hours: 360 }) : null,
      esSegundaVez: o.esSegundaVez ?? false,
      turnoOrigenId: o.turnoOrigenId ?? null,
    } as any)
    if (!o.sinCertificar) {
      await Certificacion.create({
        turnoId: t.id,
        usuarioId: ids.ADMIN.id,
        imagenPath: 'uploads/certificaciones/tst_inexistente.png',
        observaciones: null,
        resultado: o.resultado ?? null,
      })
    }
    return t
  }

  function corregir(
    client: any,
    turnoId: number,
    body: Record<string, unknown>,
    usuario = 'ADMIN'
  ) {
    return client
      .patch(`/api/certificaciones/${turnoId}/resultado`)
      .header('Authorization', `Bearer ${tokens[usuario]}`)
      .json(body)
  }

  const auditoria = (turnoId: number) =>
    CertificacionResultadoCambio.query().where('turno_id', turnoId).orderBy('id', 'asc')

  group.setup(async () => {
    await crearUsuario('ADMIN', ROL.SUPER_ADMIN)
    await crearUsuario('GERENCIA', ROL.GERENCIA)
    await crearUsuario('OPERATIVO', ROL.OPERATIVO_TURNOS)
    await crearUsuario('CONTABILIDAD', ROL.CONTABILIDAD)
    await crearUsuario('COMERCIAL', ROL.COMERCIAL)
  })

  group.teardown(async () => {
    const placas = Object.values(P)
    const marks = placas.map(() => '?').join(',')
    // certificaciones y certificacion_resultado_cambios caen por ON DELETE CASCADE
    await Database.rawQuery(
      `DELETE FROM turnos_rtms WHERE placa IN (${marks}) ORDER BY es_segunda_vez DESC, id DESC`,
      placas
    )
    for (const u of usuarios) await u.delete()
  })

  test('RECHAZADA → APROBADA anula la ventana y deja auditoría', async ({ client, assert }) => {
    const t = await turnoCertificado(P.RECHAZADA_A_APROBADA, { resultado: 'RECHAZADA' })
    const res = await corregir(
      client,
      t.id,
      { resultado: 'APROBADA', motivo: 'Error al digitar el resultado' },
      'GERENCIA'
    )
    res.assertStatus(200)

    const recargado = await TurnoRtm.findOrFail(t.id)
    assert.equal(recargado.resultadoCertificacion, 'APROBADA')
    assert.isNull(recargado.rechazadoAt)
    assert.isNull(recargado.ventanaSegundaVezHasta)
    const cert = await Certificacion.query().where('turno_id', t.id).firstOrFail()
    assert.equal(cert.resultado, 'APROBADA')

    const cambios = await auditoria(t.id)
    assert.lengthOf(cambios, 1)
    assert.equal(cambios[0].resultadoAnterior, 'RECHAZADA')
    assert.equal(cambios[0].resultadoNuevo, 'APROBADA')
    assert.equal(cambios[0].motivo, 'Error al digitar el resultado')
    assert.equal(cambios[0].usuarioId, ids.GERENCIA.id)
  })

  test('APROBADA → RECHAZADA abre la ventana de 360 h desde la corrección', async ({
    client,
    assert,
  }) => {
    const t = await turnoCertificado(P.APROBADA_A_RECHAZADA, {
      resultado: 'APROBADA',
      servicioId: SERVICIO.PREV,
    })
    const antes = ahora().startOf('second')
    const res = await corregir(client, t.id, {
      resultado: 'RECHAZADA',
      motivo: 'El FLUR decía rechazado',
    })
    const despues = ahora()
    res.assertStatus(200)

    const r = await TurnoRtm.findOrFail(t.id)
    assert.equal(r.resultadoCertificacion, 'RECHAZADA')
    assert.isTrue(r.rechazadoAt! >= antes && r.rechazadoAt! <= despues)
    assert.equal(r.ventanaSegundaVezHasta!.diff(r.rechazadoAt!, 'hours').hours, 360)
    const cambios = await auditoria(t.id)
    assert.equal(cambios[0].resultadoAnterior, 'APROBADA')
    assert.equal(cambios[0].resultadoNuevo, 'RECHAZADA')
    assert.equal(cambios[0].usuarioId, ids.ADMIN.id)
  })

  test('Con una segunda vez activa, RECHAZADA → APROBADA da 409 y no cambia nada', async ({
    client,
    assert,
  }) => {
    const origen = await turnoCertificado(P.CON_HIJA, {
      resultado: 'RECHAZADA',
      fecha: ahora().minus({ days: 2 }),
    })
    const hija = await turnoCertificado(P.CON_HIJA, {
      sinCertificar: true,
      esSegundaVez: true,
      turnoOrigenId: origen.id,
    })
    const res = await corregir(client, origen.id, {
      resultado: 'APROBADA',
      motivo: 'Intento con hija activa',
    })
    res.assertStatus(409)
    res.assertBodyContains({ code: 'ORIGEN_CON_SEGUNDA_VEZ_ACTIVA', hijoActivoId: hija.id })

    const r = await TurnoRtm.findOrFail(origen.id)
    assert.equal(r.resultadoCertificacion, 'RECHAZADA')
    assert.isNotNull(r.ventanaSegundaVezHasta)
    assert.lengthOf(await auditoria(origen.id), 0)
  })

  test('En una segunda vez, APROBADA → RECHAZADA nunca abre ventana', async ({
    client,
    assert,
  }) => {
    const origen = await turnoCertificado(P.SEGUNDA_VEZ, {
      resultado: 'RECHAZADA',
      fecha: ahora().minus({ days: 3 }),
    })
    const sv = await turnoCertificado(P.SEGUNDA_VEZ, {
      resultado: 'APROBADA',
      esSegundaVez: true,
      turnoOrigenId: origen.id,
    })
    const res = await corregir(client, sv.id, {
      resultado: 'RECHAZADA',
      motivo: 'La reinspección también falló',
    })
    res.assertStatus(200)
    const r = await TurnoRtm.findOrFail(sv.id)
    assert.equal(r.resultadoCertificacion, 'RECHAZADA')
    assert.isNull(r.ventanaSegundaVezHasta)
  })

  test('Validaciones: motivo, sin cambio, servicio y turno sin certificar', async ({ client }) => {
    const rtm = await turnoCertificado(P.VARIOS, { resultado: 'APROBADA' })
    const sinMotivo = await corregir(client, rtm.id, { resultado: 'RECHAZADA', motivo: 'abc' })
    sinMotivo.assertStatus(422)
    sinMotivo.assertBodyContains({ code: 'MOTIVO_REQUERIDO' })
    const largo = await corregir(client, rtm.id, {
      resultado: 'RECHAZADA',
      motivo: 'x'.repeat(256),
    })
    largo.assertStatus(422)
    const sinCambio = await corregir(client, rtm.id, {
      resultado: 'APROBADA',
      motivo: 'sin cambio',
    })
    sinCambio.assertStatus(422)
    sinCambio.assertBodyContains({ code: 'SIN_CAMBIO' })
    const malo = await corregir(client, rtm.id, { resultado: 'TAL VEZ', motivo: 'resultado raro' })
    malo.assertStatus(422)

    const soat = await turnoCertificado(P.VARIOS, {
      servicioId: SERVICIO.SOAT,
      fecha: ahora().minus({ days: 2 }),
    })
    const rSoat = await corregir(client, soat.id, { resultado: 'RECHAZADA', motivo: 'no aplica' })
    rSoat.assertStatus(422)
    rSoat.assertBodyContains({ code: 'SERVICIO_SIN_RESULTADO' })

    const activo = await turnoCertificado(P.VARIOS, {
      sinCertificar: true,
      fecha: ahora().minus({ days: 3 }),
    })
    const rActivo = await corregir(client, activo.id, {
      resultado: 'APROBADA',
      motivo: 'sin certificar',
    })
    rActivo.assertStatus(409)
    rActivo.assertBodyContains({ code: 'TURNO_SIN_CERTIFICACION' })
  })

  test('Permisos: solo SUPER_ADMIN y GERENCIA (otros roles 403, sin auditoría)', async ({
    client,
    assert,
  }) => {
    const t = await turnoCertificado(P.VARIOS, {
      resultado: 'APROBADA',
      fecha: ahora().minus({ days: 4 }),
    })
    for (const rol of ['OPERATIVO', 'CONTABILIDAD', 'COMERCIAL']) {
      const res = await corregir(
        client,
        t.id,
        { resultado: 'RECHAZADA', motivo: 'sin permiso' },
        rol
      )
      res.assertStatus(403)
    }
    assert.lengthOf(await auditoria(t.id), 0)
    const r = await TurnoRtm.findOrFail(t.id)
    assert.equal(r.resultadoCertificacion, 'APROBADA')
  })
})
