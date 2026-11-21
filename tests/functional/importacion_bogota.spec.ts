import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import ExcelJS from 'exceljs'
import fs from 'node:fs/promises'
import path from 'node:path'
import { DateTime } from 'luxon'
import Usuario from '#models/usuario'
import TurnoRtm from '#models/turno_rtm'
import Vehiculo from '#models/vehiculo'
import Cliente from '#models/cliente'
import { conSede } from '#services/sede_scope'
import { leerXls } from '#services/importacion_bogota/lector_xls'
import { MARCA_OBSERVACION } from '#services/importacion_bogota/importacion_bogota_service'

// Importación Bogotá con la muestra anonimizada de 30 filas del archivo real
// (tests/fixtures/importacion_bogota_muestra.xls): placas ZB*, documentos
// 99000000NN, nombres "CLIENTE/CONDUCTOR PRUEBA NN". Se importa en la sede de
// pruebas (3). Todo lo creado se borra al final.
//
// Esperado de la muestra: 30 filas; 2 descartes (fila 12 placa "-", fila 13
// sin fecha); 3 filas unificadas (misma placa el mismo día) → 25 visitas:
// 21 APROBADA, 4 RECHAZADA, 1 preventiva; 2 teléfonos de relleno (0 y 2000000).

const IBAGUE = 1
const BOGOTA = 2
const QA = 3
const MARCA = 'test.impbog.'
const MUESTRA = app.makePath('tests/fixtures/importacion_bogota_muestra.xls')

let placas: string[] = []
let docs: string[] = []

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `IMPBOG ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const creado = await Usuario.accessTokens.create(u)
  const token = creado.value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } as Record<string, string> }
}

async function limpiar() {
  if (placas.length) {
    await Database.from('turnos_rtms').whereIn('placa', placas).delete()
    await Database.from('vehiculos').whereIn('placa', placas).delete()
  }
  if (docs.length) {
    await Database.from('clientes').whereIn('doc_numero', docs).delete()
    await Database.from('conductores').whereIn('doc_numero', docs).delete()
  }
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  // Planes de vista previa de los usuarios de prueba (o huérfanos de corridas anteriores).
  const dir = app.tmpPath('importacion_bogota')
  for (const nombre of await fs.readdir(dir).catch(() => [] as string[])) {
    const ruta = path.join(dir, nombre)
    const plan = JSON.parse(await fs.readFile(ruta, 'utf8').catch(() => '{}'))
    const existe = await Database.from('usuarios')
      .where('id', plan.usuarioId ?? 0)
      .first()
    if (ids.includes(plan.usuarioId) || !existe) await fs.unlink(ruta).catch(() => {})
  }
  if (ids.length) {
    await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
    await Database.from('usuarios').whereIn('id', ids).delete()
  }
}

const preview = (client: any, h: Record<string, string>, archivo = MUESTRA) =>
  client.post('/api/rtm/importar-bogota/preview').headers(h).file('archivo', archivo)

async function importarTodo(client: any, h: Record<string, string>, archivo = MUESTRA) {
  const p = await preview(client, h, archivo)
  const lotes: any[] = []
  for (let i = 0; i < p.body().lotes.total; i++) {
    const r = await client
      .post('/api/rtm/importar-bogota/lote')
      .headers(h)
      .json({ token: p.body().token, lote: i })
    lotes.push(r)
  }
  return { p, lotes }
}

test.group('Importación Bogotá (formato de Bogotá en una sede distinta de Ibagué)', (group) => {
  group.each.timeout(180_000)
  let operQa: Awaited<ReturnType<typeof actor>>
  let gerQa: Awaited<ReturnType<typeof actor>>

  group.setup(async () => {
    // Placas y documentos de la muestra (ver cabecera).
    const hoja = leerXls(await fs.readFile(MUESTRA))
    placas = [
      ...new Set(
        hoja.filas
          .map((f) =>
            String(f[10] ?? '')
              .toUpperCase()
              .replace(/[^A-Z0-9]/g, '')
          )
          .filter((p) => p.length >= 5)
      ),
    ]
    docs = [
      ...new Set(
        hoja.filas
          .flatMap((f) => [f[27], f[35]])
          .filter(Boolean)
          .map((d) => String(BigInt(d as number)))
      ),
    ]
    const ocupadas = await Database.from('vehiculos').whereIn('placa', placas).count('* as n')
    const docsOcupados = await Database.from('clientes').whereIn('doc_numero', docs).count('* as n')
    if (Number(ocupadas[0].n) || Number(docsOcupados[0].n)) {
      throw new Error(
        'La BD ya tiene placas ZB* o documentos 99000000NN: limpiar antes de correr este test'
      )
    }
    operQa = await actor('OPERATIVO_TURNOS', QA)
    gerQa = await actor('GERENCIA', QA)
  })
  group.teardown(limpiar)

  test('en Ibagué y en "todas" responde 400 sin leer el archivo', async ({ client, assert }) => {
    const enIbague = await preview(client, { ...gerQa.h, 'X-Sede-Id': String(IBAGUE) })
    assert.equal(enIbague.status(), 400)
    assert.match(enIbague.body().message, /no se usa en Ibagué/)
    const todas = await preview(client, { ...gerQa.h, 'X-Sede-Id': 'todas' })
    assert.equal(todas.status(), 400)
    const lote = await client
      .post('/api/rtm/importar-bogota/lote')
      .headers({ ...gerQa.h, 'X-Sede-Id': String(IBAGUE) })
      .json({ token: '00000000-0000-0000-0000-000000000000', lote: 0 })
    assert.equal(lote.status(), 400)
  })

  test('vista previa: conteos y descartes, sin escribir nada', async ({ client, assert }) => {
    const r = await preview(client, operQa.h)
    assert.equal(r.status(), 200, JSON.stringify(r.body()))
    const b = r.body()
    assert.equal(b.sede.id, QA)
    assert.isFalse(b.conTitulos)
    assert.equal(b.filasLeidas, 30)
    assert.deepInclude(b.turnos, {
      visitas: 25,
      aCrear: 25,
      yaExisten: 0,
      aprobadas: 21,
      rechazadas: 4,
      preventivas: 1,
    })
    assert.deepInclude(b.vehiculos, { distintos: 25, aCrear: 25, existentes: 0 })
    assert.equal(b.telefonosDescartados, 2)
    const motivos = Object.fromEntries(b.descartes.map((d: any) => [d.motivo, d.filas]))
    assert.deepEqual(motivos, { PLACA_INVALIDA: 1, FECHA_INVALIDA: 1, MISMO_DIA_UNIFICADA: 3 })
    assert.equal(b.descartes.find((d: any) => d.motivo === 'PLACA_INVALIDA').ejemplos[0].fila, 12)
    const escritos = await Database.from('turnos_rtms').whereIn('placa', placas).count('* as n')
    assert.equal(Number(escritos[0].n), 0)
  })

  test('importa en la sede de pruebas: 25 turnos en sede 3, nada en Ibagué; repetir no duplica', async ({
    client,
    assert,
  }) => {
    // Vehículo de la muestra con historial en OTRA sede (Bogotá, no Ibagué),
    // con otro dueño y otra clase: no deben cambiar.
    const compartida = placas[0]
    docs.push('9900009999') // dueño previo (se borra en limpiar)
    const duenoPrevio = await Cliente.create({
      nombre: 'DUEÑO PREVIO PRUEBA',
      docTipo: 'CC',
      docNumero: '9900009999',
      telefono: '3009999999',
    } as any)
    const v = await Vehiculo.create({
      placa: compartida,
      claseVehiculoId: 4,
      clienteId: duenoPrevio.id,
      marca: null,
    } as any)
    await TurnoRtm.create({
      sedeId: BOGOTA,
      funcionarioId: operQa.id,
      servicioId: 1,
      fecha: DateTime.fromISO('2021-06-01'),
      horaIngreso: '08:00:00',
      placa: compartida,
      tipoVehiculo: 'Liviano Particular',
      turnoNumero: -771,
      turnoNumeroServicio: -771,
      turnoCodigo: `IMPBOG-${Date.now()}`,
      estado: 'finalizado',
    } as any)

    const { p, lotes } = await importarTodo(client, operQa.h)
    assert.equal(p.status(), 200)
    assert.equal(p.body().vehiculos.conHistorialEnOtraSede, 1)
    assert.isTrue(
      lotes.every((l) => l.status() === 200),
      JSON.stringify(lotes.map((l) => l.body()))
    )
    const ultimo = lotes[lotes.length - 1].body()
    assert.isTrue(ultimo.terminado)
    const creados = lotes.reduce((a, l) => a + l.body().turnosCreados, 0)
    assert.equal(creados, 25)

    const turnos = await Database.from('turnos_rtms')
      .whereIn('placa', placas)
      .where('observaciones', 'like', `${MARCA_OBSERVACION}%`)
      .select('*')
    assert.lengthOf(turnos, 25)
    assert.isTrue(turnos.every((t: any) => t.sede_id === QA && t.estado === 'finalizado'))
    assert.equal(turnos.filter((t: any) => t.resultado_certificacion === 'RECHAZADA').length, 4)
    assert.isTrue(
      turnos
        .filter((t: any) => t.resultado_certificacion === 'RECHAZADA')
        .every((t: any) => t.rechazado_at && t.ventana_segunda_vez_hasta)
    )
    assert.equal(turnos.filter((t: any) => t.resultado_certificacion === 'APROBADA').length, 21)
    assert.isTrue(
      turnos.every(
        (t: any) => t.canal_atribucion === 'FACHADA' && String(t.turno_codigo).startsWith('HIST-')
      )
    )
    const funcionarios = await Database.from('usuarios')
      .whereIn('id', [...new Set(turnos.map((t: any) => t.funcionario_id))])
      .select('sede_id')
    assert.isTrue(
      funcionarios.every((u: any) => u.sede_id === QA),
      'responsable de la sede activa'
    )
    assert.equal(turnos.filter((t: any) => t.servicio_id === 2).length, 1, 'una preventiva')

    // El vehículo compartido no cambió de dueño ni de clase y se reportó.
    await v.refresh()
    assert.equal(v.claseVehiculoId, 4)
    assert.equal(v.clienteId, duenoPrevio.id)
    assert.isNotNull(v.marca, 'los campos vacíos sí se completan')
    const avisos = lotes.flatMap((l) => l.body().avisos)
    assert.isTrue(avisos.some((a: any) => a.placa === compartida && /clase/.test(a.aviso)))
    assert.isTrue(avisos.some((a: any) => a.placa === compartida && /dueño/.test(a.aviso)))

    // Desde Ibagué no se ve nada.
    // await DENTRO de conSede(): si no, la consulta corre sin contexto de sede.
    const enIbague = await conSede(
      [IBAGUE],
      async () => await TurnoRtm.query().whereIn('placa', placas).count('* as n')
    )
    assert.equal(Number((enIbague[0] as any).$extras.n), 0)

    // Repetir: no duplica.
    const otra = await importarTodo(client, operQa.h)
    assert.deepInclude(otra.p.body().turnos, { aCrear: 0, yaExisten: 25 })
    assert.equal(
      otra.lotes.reduce((a, l) => a + l.body().turnosCreados, 0),
      0
    )
    assert.equal(
      otra.lotes.reduce((a, l) => a + l.body().turnosYaExistian, 0),
      25
    )
    const total = await Database.from('turnos_rtms')
      .whereIn('placa', placas)
      .where('sede_id', QA)
      .count('* as n')
    assert.equal(Number(total[0].n), 25)
  })

  test('.xlsx con fila de títulos: la detecta y no pierde la primera fila de datos', async ({
    client,
    assert,
  }) => {
    const hoja = leerXls(await fs.readFile(MUESTRA))
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('BD')
    const titulos = Array.from({ length: 42 }, (_, i) => `COL${i + 1}`)
    titulos[2] = 'FECHA'
    titulos[10] = 'PLACA'
    ws.addRow(titulos)
    for (const f of hoja.filas) {
      ws.addRow(
        f.map((c, i) =>
          i === 2 && typeof c === 'number' ? new Date(Math.round((c - 25569) * 86_400_000)) : c
        )
      )
    }
    const archivo = app.tmpPath(`impbog_${Date.now()}.xlsx`)
    await fs.mkdir(path.dirname(archivo), { recursive: true })
    await wb.xlsx.writeFile(archivo)
    try {
      const r = await preview(client, operQa.h, archivo)
      assert.equal(r.status(), 200, JSON.stringify(r.body()))
      assert.isTrue(r.body().conTitulos)
      assert.equal(r.body().filasLeidas, 30)
      assert.equal(r.body().turnos.visitas, 25)
    } finally {
      await fs.unlink(archivo).catch(() => {})
    }
  })

  test('un archivo con el formato de Ibagué (48 columnas) se rechaza', async ({
    client,
    assert,
  }) => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('TECNOBASE')
    ws.addRow(
      Array.from({ length: 48 }, (_, i) => (i === 10 ? 'ZBZ999' : i === 3 ? 'APROBADO' : `x${i}`))
    )
    const archivo = app.tmpPath(`impbog_ibague_${Date.now()}.xlsx`)
    await wb.xlsx.writeFile(archivo)
    try {
      const r = await preview(client, operQa.h, archivo)
      assert.equal(r.status(), 400)
      assert.match(r.body().message, /48 columnas|42/)
    } finally {
      await fs.unlink(archivo).catch(() => {})
    }
  })
})
