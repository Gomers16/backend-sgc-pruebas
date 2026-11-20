import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import fs from 'node:fs/promises'
import path from 'node:path'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Multi-sede 3h — importaciones en la sede activa. Un TECNOBASE mínimo
// (CSV, 1 fila) importado desde QA crea su turno histórico en QA (antes:
// en "la primera sede" de la tabla); "todas" → 400 en las importaciones.
// Placa MS3HT1; todo se borra al final.

const QA = 3
const MARCA = 'test.ms3h.'
const PLACA = 'MS3HT1'

async function actor(rol: string, sedeId: number) {
  const r = await Database.from('roles').where('nombre', rol).first()
  const u = await Usuario.create({
    nombres: 'TEST',
    apellidos: `MS3H ${rol} ${sedeId}`,
    correo: `${MARCA}${rol.toLowerCase()}.${sedeId}.${Date.now()}@test.local`,
    password: 'Test1234!Aa',
    rolId: r.id,
    sedeId,
  } as any)
  const token = (await Usuario.accessTokens.create(u)).value!.release()
  return { id: u.id, h: { Authorization: `Bearer ${token}` } }
}

async function limpiar() {
  await Database.from('turnos_rtms').where('placa', PLACA).delete()
  await Database.from('vehiculos').where('placa', PLACA).delete()
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  if (ids.length) {
    await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
    await Database.from('usuario_preferencia_modulo').whereIn('usuario_id', ids).delete()
    await Database.from('usuarios').whereIn('id', ids).delete()
  }
}

/** Fila TECNOBASE (separada por ;) con solo fecha, tipo de servicio y placa. */
function filaTecnobase(): string {
  const cols = Array.from({ length: 50 }, () => '')
  cols[2] = '01/04/2031'
  cols[9] = 'ORDINARIO'
  cols[10] = PLACA
  return cols.join(';')
}

test.group('Multi-sede 3h · importaciones', (group) => {
  group.each.timeout(90_000)
  let otB: Awaited<ReturnType<typeof actor>>
  let gerB: Awaited<ReturnType<typeof actor>>
  let archivo = ''

  group.setup(async () => {
    await limpiar()
    otB = await actor('OPERATIVO_TURNOS', QA)
    gerB = await actor('GERENCIA', QA)
    archivo = app.tmpPath(`TECNOBASE_ms3h_${Date.now()}.csv`)
    await fs.mkdir(path.dirname(archivo), { recursive: true })
    // Sin fila de encabezado: el importador procesa TODAS las filas como datos.
    await fs.writeFile(archivo, filaTecnobase() + '\n')
  })
  group.teardown(async () => {
    await limpiar()
    await fs.unlink(archivo).catch(() => {})
  })

  test('TECNOBASE desde QA: el turno histórico queda en QA', async ({ client, assert }) => {
    const r = await client.post('/api/rtm/rep-general/import').headers(otB.h).file('file', archivo)
    assert.equal(r.status(), 200, JSON.stringify(r.body()))
    const turno = await Database.from('turnos_rtms').where('placa', PLACA).first()
    assert.exists(turno, 'debía crear el turno histórico')
    assert.equal(turno.sede_id, QA)
    const funcionario = await Database.from('usuarios').where('id', turno.funcionario_id).first()
    assert.equal(funcionario.sede_id, QA, 'funcionario de la sede activa')
  })

  test('"todas" → 400 en las importaciones (sin escribir)', async ({ client, assert }) => {
    await Database.from('turnos_rtms').where('placa', PLACA).delete()
    await Database.from('vehiculos').where('placa', PLACA).delete()
    const todas = { ...gerB.h, 'X-Sede-Id': 'todas' }
    const rep = await client
      .post('/api/rtm/rep-general/import')
      .headers(todas)
      .file('file', archivo)
    assert.equal(rep.status(), 400, JSON.stringify(rep.body()))
    const hist = await client
      .post('/api/historico-rtm/importar')
      .headers(todas)
      .file('archivo', archivo)
    assert.equal(hist.status(), 400, JSON.stringify(hist.body()))
    assert.isNull(await Database.from('turnos_rtms').where('placa', PLACA).first())
    assert.isNull(await Database.from('vehiculos').where('placa', PLACA).first(), 'ni el vehículo')
  })
})
