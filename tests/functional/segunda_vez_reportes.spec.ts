import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Certificacion from '#models/certificacion'
import InformeDiscrepanciaRtm from '#models/informe_discrepancia_rtm'
import DiscrepanciasRtmService from '#services/discrepancias_rtm_service'

// "Segunda vez" — Entrega C1: una segunda vez no infla reportes (Meta
// Mensual, Producción por líder, Reconciliación RTM, Reporte de servicios,
// Discrepancias RTM). Los reportes excluyen placas 'TST%', así que aquí se
// usa ZSV901 (si no, los totales nunca cambiarían y el test no probaría
// nada). Escribe en la BD compartida: los datos existen solo mientras corre
// el test y se limpian al final (turnos, certificaciones e imágenes,
// informes de discrepancias creados y usuario).

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const ROL_SUPER_ADMIN_ID = 9
const ZONA = 'America/Bogota'
const PLACA = 'ZSV901'

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

test.group('Segunda vez · reportes (C1)', (group) => {
  group.each.timeout(60_000)

  let usuario: Usuario
  let token: string
  let imagenPath: string
  const informeIds: number[] = []
  const ahora = () => DateTime.now().setZone(ZONA)

  async function get(client: any, url: string, qs: Record<string, unknown>) {
    const res = await client.get(url).header('Authorization', `Bearer ${token}`).qs(qs)
    res.assertStatus(200)
    return res.body()
  }

  /** Totales de los reportes afectados, para el día de hoy. */
  async function snapshot(client: any) {
    const hoy = ahora().toISODate()!
    const rango = { fecha_inicio: hoy, fecha_fin: hoy }
    const meta = await get(client, '/api/reportes-admin/meta-mensual/resumen', {
      mes: ahora().month,
      anio: ahora().year,
    })
    const produccion = await get(client, '/api/reportes-admin/produccion-lider', rango)
    const reconciliacion = await get(
      client,
      '/api/reportes-admin/super-informe/reconciliacion-rtm',
      rango
    )
    const servicios = await get(client, '/api/reportes-admin/servicios', rango)
    const informe = await DiscrepanciasRtmService.generarInforme([], {
      archivoNombre: 'tst-segunda-vez-c1',
      generadoPorId: usuario.id,
    })
    informeIds.push(informe.id)
    return {
      meta,
      produccion,
      reconciliacion,
      servicios,
      discrepancias: {
        totalSgcFinalizados: informe.totalSgcFinalizados,
        tipo7: informe.totalTipo7FinalizadoSinRastroTecno,
        duplicados: informe.totalDuplicadosFinalizado,
        tipo2: informe.totalTipo2ActivoDebeFinalizar,
        tipo3: informe.totalTipo3TurnoFantasma,
      },
    }
  }

  group.setup(async () => {
    usuario = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'SV-C1-REPORTES',
      correo: `test.sv.c1.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: ROL_SUPER_ADMIN_ID,
      sedeId: SEDE_ID,
    } as any)
    const tokenObj = await Usuario.accessTokens.create(usuario)
    token = tokenObj.value!.release()
    imagenPath = app.tmpPath(`tst_sv_c1_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    const filas = await Database.from('turnos_rtms').where('placa', PLACA).select('id')
    const ids = filas.map((r: any) => r.id)
    if (ids.length) {
      const certs = await Certificacion.query().whereIn('turno_id', ids)
      for (const c of certs) await fs.unlink(app.makePath(c.imagenPath)).catch(() => {})
    }
    await Database.from('captacion_dateos').where('placa', PLACA).delete()
    await Database.rawQuery(
      'DELETE FROM turnos_rtms WHERE placa = ? ORDER BY es_segunda_vez DESC, id DESC',
      [PLACA]
    )
    if (informeIds.length) {
      await InformeDiscrepanciaRtm.query().whereIn('id', informeIds).delete()
    }
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    if (usuario) await usuario.delete()
  })

  test('Crear y certificar una segunda vez no cambia Meta, Producción, Reconciliación, Servicios ni Discrepancias', async ({
    client,
    assert,
  }) => {
    const t0 = await snapshot(client)

    // Origen RTM rechazado hoy (sí cuenta: es una visita real).
    const rechazadoAt = ahora().minus({ hours: 1 }).startOf('second')
    const origen = await TurnoRtm.create({
      sedeId: SEDE_ID,
      funcionarioId: usuario.id,
      servicioId: SERVICIO_RTM_ID,
      fecha: ahora(),
      horaIngreso: '08:00',
      horaSalida: '09:00:00',
      tieneFacturacion: false,
      turnoNumero: -9801,
      turnoNumeroServicio: -9801,
      turnoCodigo: `TST-SV-C1-${Date.now()}`,
      placa: PLACA,
      tipoVehiculo: 'Liviano Particular',
      estado: 'finalizado',
      resultadoCertificacion: 'RECHAZADA',
      rechazadoAt,
      ventanaSegundaVezHasta: rechazadoAt.plus({ hours: 360 }),
    } as any)

    const t1 = await snapshot(client)
    // Control: la placa sí entra en los reportes (si no, el test no prueba nada).
    assert.equal(
      t1.reconciliacion.turnos_reales_total,
      t0.reconciliacion.turnos_reales_total + 1,
      'el origen debe contar en la Reconciliación'
    )
    assert.equal(t1.discrepancias.tipo7, t0.discrepancias.tipo7 + 1)

    // Segunda vez: crear (HTTP, mismo día) y certificar APROBADA.
    await new Promise((r) => setTimeout(r, 1100))
    const crear = await client
      .post('/api/turnos-rtm')
      .header('Authorization', `Bearer ${token}`)
      .json({
        placa: PLACA,
        tipoVehiculo: 'Liviano Particular',
        usuarioId: usuario.id,
        fecha: ahora().toISODate(),
        horaIngreso: ahora().toFormat('HH:mm:ss'),
        servicioId: SERVICIO_RTM_ID,
        segundaVezOrigenId: origen.id,
      })
    crear.assertStatus(201)
    assert.isTrue(Boolean(crear.body().esSegundaVez))

    const tActiva = await snapshot(client)
    assert.deepEqual(tActiva.discrepancias, t1.discrepancias, 'segunda vez activa: discrepancias')

    const cert = await client
      .post('/api/certificaciones')
      .header('Authorization', `Bearer ${token}`)
      .field('turno_id', String(crear.body().id))
      .field('resultado', 'APROBADA')
      .file('imagen', imagenPath)
    cert.assertStatus(201)

    const t2 = await snapshot(client)
    assert.deepEqual(t2.meta, t1.meta, 'Meta Mensual')
    assert.deepEqual(t2.produccion, t1.produccion, 'Producción por líder')
    assert.deepEqual(t2.reconciliacion, t1.reconciliacion, 'Reconciliación RTM')
    assert.deepEqual(t2.servicios, t1.servicios, 'Reporte de servicios')
    assert.deepEqual(t2.discrepancias, t1.discrepancias, 'Discrepancias RTM')
  })
})
