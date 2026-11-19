import { test } from '@japa/runner'
import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'

// Multi-sede — referencia de "Ibagué idéntico".
//
// Rango fijo 2026-06-01 → 2026-07-31: en la BD local solo tiene datos de la
// sede 1 (1.093 tickets y 2 turnos de Ibagué; nada de QA/Bogotá). Llama los
// reportes JSON de /api/reportes-admin y guarda un hash por endpoint.
//
// OPCIONAL (la BD es compartida y viva; no corre en la suite normal):
//   SNAPSHOT_IBAGUE=capturar node ace test --files tests/functional/snapshot_reportes_ibague.spec.ts
//   SNAPSHOT_IBAGUE=comparar node ace test --files tests/functional/snapshot_reportes_ibague.spec.ts
//
// Capturar: llama cada endpoint DOS veces; las rutas JSON que cambian entre
// llamadas se marcan volátiles y se excluyen del hash. Escribe, FUERA del
// repo (hay placas y nombres reales), el manifiesto (urls + hashes) y el
// JSON completo. Comparar: repite las llamadas, compara hashes y, si algo
// cambió, deja el JSON actual al lado para hacer diff.
//
// Excluidos: Excel/PDF (metadatos de generación) y GET .../config (crean la
// fila del mes si falta). Manda X-Sede-Id: 1 (hoy se ignora; desde la Fase 2
// selecciona Ibagué para el SUPER_ADMIN de prueba, que vive en la sede QA).

const MODO = process.env.SNAPSHOT_IBAGUE
const DIR =
  process.env.SNAPSHOT_IBAGUE_DIR ?? 'C:/Users/ggyt1/backups/multisede/snapshot_reportes_ibague'
const MANIFIESTO = path.join(DIR, 'manifiesto.json')
const SEDE_QA = 3
const MARCA = 'test.snapibague.'
const DESDE = '2026-06-01'
const HASTA = '2026-07-31'

type Json = unknown
interface Entrada {
  url: string
  status: number
  hash: string
  volatiles: string[]
}

/** Objetos con claves ordenadas y arrays ordenados por su JSON canónico. */
function canon(v: Json): Json {
  if (Array.isArray(v)) {
    return v.map(canon).sort((a, b) => {
      const sa = JSON.stringify(a)
      const sb = JSON.stringify(b)
      return sa < sb ? -1 : sa > sb ? 1 : 0
    })
  }
  if (v && typeof v === 'object') {
    const out: Record<string, Json> = {}
    for (const k of Object.keys(v as object).sort()) out[k] = canon((v as any)[k])
    return out
  }
  return v
}

/** Rutas (con índices como *) de las hojas que difieren entre a y b. */
function diferencias(a: Json, b: Json, ruta: string[] = [], out = new Set<string>()): Set<string> {
  if (JSON.stringify(a) === JSON.stringify(b)) return out
  const objA = a && typeof a === 'object'
  const objB = b && typeof b === 'object'
  if (!objA || !objB || Array.isArray(a) !== Array.isArray(b)) {
    out.add(ruta.join('.'))
    return out
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) {
      out.add(ruta.join('.'))
      return out
    }
    a.forEach((x, i) => diferencias(x, (b as Json[])[i], [...ruta, '*'], out))
    return out
  }
  const claves = new Set([...Object.keys(a as object), ...Object.keys(b as object)])
  for (const k of claves) diferencias((a as any)[k], (b as any)[k], [...ruta, k], out)
  return out
}

function quitar(v: Json, ruta: string[]): Json {
  if (!ruta.length || v === null || typeof v !== 'object') return v
  const [k, ...resto] = ruta
  if (Array.isArray(v)) return k === '*' ? v.map((x) => quitar(x, resto)) : v
  const copia: Record<string, Json> = { ...(v as object) } as any
  if (resto.length === 0) {
    delete copia[k]
    return copia
  }
  if (k in copia) copia[k] = quitar(copia[k], resto)
  return copia
}

function hashDe(body: Json, volatiles: string[]): string {
  let limpio = canon(body)
  for (const r of volatiles) limpio = quitar(limpio, r === '' ? [] : r.split('.'))
  // Volátil en la raíz (ruta '') → todo el cuerpo es volátil.
  if (volatiles.includes('')) limpio = '(volátil)'
  return createHash('sha256')
    .update(JSON.stringify(canon(limpio)))
    .digest('hex')
}

function archivoDe(url: string): string {
  return url.replace(/^\/api\/reportes-admin\//, '').replace(/[^a-zA-Z0-9]+/g, '_') + '.json'
}

/** URLs del snapshot. Parámetros dinámicos se eligen al capturar y quedan en el manifiesto. */
async function urlsACapturar(): Promise<string[]> {
  const R = `fecha_inicio=${DESDE}&fecha_fin=${HASTA}`
  const base = '/api/reportes-admin'
  const urls: string[] = []
  const conRango = [
    'ingresos-canal',
    'produccion-lider',
    'asesores',
    'retencion',
    'servicios',
    'descuentos-por-tipo',
    'descuentos-por-canal',
    'descuentos-por-autorizador',
    'detalle-descuentos',
    'comisiones',
    'liquidacion-rtm',
    'historial-liquidaciones',
    'trazabilidad-rtm',
    'super-informe/meta-mensual',
    'super-informe/meta-comercial',
    'super-informe/resumen-contable',
    'super-informe/reconciliacion-rtm',
    'discrepancias-rtm',
    'segunda-vez',
  ]
  for (const r of conRango) urls.push(`${base}/${r}?${R}`)

  for (const canal of ['FACHADA', 'ASESOR', 'TELE', 'REDES']) {
    urls.push(`${base}/detalle-canal?${R}&canal=${canal}`)
    urls.push(`${base}/liquidacion-rtm/detalle-placas-canal?${R}&canal=${canal}`)
  }
  for (const categoria of ['NUEVO', 'RECURRENTE', 'RECUPERACION']) {
    urls.push(`${base}/detalle-retencion?${R}&categoria=${categoria}`)
  }
  // meta-mensual/rango exige un rango dentro de un mismo mes.
  urls.push(`${base}/meta-mensual/rango?fecha_inicio=2026-06-01&fecha_fin=2026-06-30`)
  urls.push(`${base}/meta-mensual/rango?fecha_inicio=2026-07-01&fecha_fin=2026-07-31`)
  // detalle-placas: ids de las comisiones del rango.
  const ids = await Database.from('comisiones')
    .where('es_config', 0)
    .whereBetween('fecha_calculo', [`${DESDE} 00:00:00`, `${HASTA} 23:59:59`])
    .orderBy('id', 'asc')
    .limit(50)
    .select('id')
  if (ids.length) {
    urls.push(
      `${base}/liquidacion-rtm/detalle-placas?${R}&comision_ids=${ids.map((r: any) => r.id).join(',')}`
    )
  }

  // Asesor con más comisiones en el rango (para detalle-asesor).
  const asesor = await Database.from('comisiones')
    .where('es_config', 0)
    .whereNotNull('asesor_id')
    .whereBetween('fecha_calculo', [`${DESDE} 00:00:00`, `${HASTA} 23:59:59`])
    .groupBy('asesor_id')
    .select('asesor_id')
    .count('* as n')
    .orderBy('n', 'desc')
    .first()
  if (asesor) {
    urls.push(`${base}/detalle-asesor?${R}&agente_id=${asesor.asesor_id}&canal=ASESOR`)
    urls.push(`${base}/detalle-comisiones?${R}&asesor_id=${asesor.asesor_id}`)
    for (const mes of [6, 7]) {
      const M = `mes=${mes}&anio=2026&asesor_id=${asesor.asesor_id}`
      urls.push(`${base}/meta-comercial/detalle-vehiculo?${M}`)
      urls.push(`${base}/meta-comercial/ingreso-real-dateo?${M}`)
    }
  }

  // Descuento más usado y una placa facturada del rango.
  const desc = await Database.from('facturacion_tickets as ft')
    .join('descuentos as d', 'd.id', 'ft.descuento_id')
    .where('ft.sede_id', 1)
    .whereBetween('ft.fecha_pago', [`${DESDE} 00:00:00`, `${HASTA} 23:59:59`])
    .groupBy('d.codigo')
    .select('d.codigo')
    .count('* as n')
    .orderBy('n', 'desc')
    .first()
  if (desc) {
    urls.push(
      `${base}/liquidacion-rtm/detalle-placas-descuento?${R}&codigo=${encodeURIComponent(desc.codigo)}`
    )
  }
  const placa = await Database.from('facturacion_tickets')
    .where('sede_id', 1)
    .where('estado', 'CONFIRMADA')
    .whereBetween('fecha_pago', [`${DESDE} 00:00:00`, `${HASTA} 23:59:59`])
    .orderBy('id', 'asc')
    .first()
  if (placa?.placa) {
    urls.push(`${base}/liquidacion-rtm/buscar-placa?${R}&placa=${encodeURIComponent(placa.placa)}`)
  }

  for (const mes of [6, 7]) {
    const M = `mes=${mes}&anio=2026`
    for (const r of [
      'meta-mensual/resumen',
      'meta-mensual/diario',
      'meta-mensual/semanal',
      'meta-mensual/proyectado',
      'meta-comercial/resumen',
      'meta-comercial/diario',
      'meta-comercial/semanal',
      'meta-comercial/proyectado',
    ]) {
      urls.push(`${base}/${r}?${M}`)
    }
  }
  return urls
}

async function limpiar() {
  const us = await Database.from('usuarios').where('correo', 'like', `${MARCA}%`).select('id')
  const ids = us.map((u: any) => u.id)
  if (!ids.length) return
  await Database.from('auth_access_tokens').whereIn('tokenable_id', ids).delete()
  await Database.from('usuarios').whereIn('id', ids).delete()
}

test.group('Snapshot reportes Ibagué (opcional: SNAPSHOT_IBAGUE)', (group) => {
  group.each.timeout(600_000)
  let headers: Record<string, string> = {}

  group.setup(async () => {
    if (!MODO) return
    await limpiar()
    const rol = await Database.from('roles').where('nombre', 'SUPER_ADMIN').first()
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: 'SNAPSHOT IBAGUE',
      correo: `${MARCA}${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId: rol.id,
      sedeId: SEDE_QA,
    } as any)
    const token = (await Usuario.accessTokens.create(u)).value!.release()
    headers = { 'Authorization': `Bearer ${token}`, 'X-Sede-Id': '1' }
  })
  group.teardown(async () => {
    if (MODO) await limpiar()
  })

  test('capturar o comparar', async ({ client, assert }) => {
    const pedir = async (url: string) => {
      const res = await client.get(url).headers(headers)
      return { status: res.status(), body: res.body() as Json }
    }

    if (MODO === 'capturar') {
      await fs.mkdir(DIR, { recursive: true })
      const configAntes = await Database.from('configuracion_meta_mensual').count('* as n').first()
      const urls = await urlsACapturar()
      const entradas: Entrada[] = []
      for (const url of urls) {
        const a = await pedir(url)
        const b = await pedir(url)
        const volatiles = [...diferencias(canon(a.body), canon(b.body))]
        entradas.push({ url, status: a.status, hash: hashDe(a.body, volatiles), volatiles })
        await fs.writeFile(path.join(DIR, archivoDe(url)), JSON.stringify(canon(a.body), null, 1))
      }
      const configDespues = await Database.from('configuracion_meta_mensual')
        .count('* as n')
        .first()
      await fs.writeFile(
        MANIFIESTO,
        JSON.stringify(
          {
            capturado_at: new Date().toISOString(),
            rango: { desde: DESDE, hasta: HASTA },
            config_meta_mensual_filas: { antes: configAntes?.n, despues: configDespues?.n },
            entradas,
          },
          null,
          2
        )
      )
      const no2xx = entradas.filter((e) => e.status >= 300)
      console.log(
        `[snapshot] ${entradas.length} endpoints → ${MANIFIESTO}; ` +
          `no-2xx: ${no2xx.map((e) => `${e.status} ${e.url}`).join(' | ') || 'ninguno'}; ` +
          `con volátiles: ${entradas.filter((e) => e.volatiles.length).length}`
      )
      assert.isAbove(entradas.length, 0)
      return
    }

    if (MODO === 'comparar') {
      const man = JSON.parse(await fs.readFile(MANIFIESTO, 'utf8')) as { entradas: Entrada[] }
      const distintos: string[] = []
      for (const e of man.entradas) {
        const r = await pedir(e.url)
        const h = hashDe(r.body, e.volatiles)
        if (r.status !== e.status || h !== e.hash) {
          distintos.push(`${e.url} (status ${e.status}→${r.status})`)
          await fs.writeFile(
            path.join(DIR, archivoDe(e.url).replace(/\.json$/, '.actual.json')),
            JSON.stringify(canon(r.body), null, 1)
          )
        }
      }
      assert.deepEqual(distintos, [], 'Reportes de Ibagué distintos al snapshot')
      return
    }

    assert.isTrue(true) // sin SNAPSHOT_IBAGUE no hace nada
  })
})
