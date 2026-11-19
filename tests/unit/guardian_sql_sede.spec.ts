import { test } from '@japa/runner'
import fs from 'node:fs'
import path from 'node:path'

// Multi-sede Fase 2 — GUARDIÁN del SQL crudo y db.from.
//
// Recorre app/**/*.ts y busca consultas sobre tablas de sede hechas fuera
// del ORM (knex .from/.join/... y SQL en strings FROM/JOIN). Cada una debe
// tener cerca sedeSql(...) / aplicarSede(...) o un comentario
// "// sede: <motivo>" justo encima (para las que no van por sede a propósito).
//
// Lo que hoy no cumple está en tests/fixtures/sede_guardian_baseline.json
// (conteo por archivo::tabla). La Fase 3 lo va bajando; el test FALLA si un
// conteo SUBE o aparece un archivo::tabla nuevo. La lista no puede crecer sin
// aprobación. Para fijar el baseline tras una reducción:
//   GUARDIAN_SEDE=regenerar node ace test unit --files tests/unit/guardian_sql_sede.spec.ts
// (regenerar con conteos MAYORES requiere aprobación explícita del dueño).

const RAIZ = path.resolve(import.meta.dirname, '..', '..')
const BASELINE = path.join(RAIZ, 'tests', 'fixtures', 'sede_guardian_baseline.json')

/** Tablas con datos por sede (raíz con sede_id + hijas que heredan por join). */
export const TABLAS_SEDE = new Set([
  // raíz
  'turnos_rtms',
  'facturacion_tickets',
  'captacion_dateos',
  'comisiones',
  'comprobantes_pago',
  'liquidaciones',
  'tickets',
  'telemercadeo_gestiones',
  'telemercadeo_ciclos',
  'informes_discrepancias_rtm',
  'turnero_multimedia',
  'turnero_mensajes_ticker',
  'agentes_captacions',
  'convenios',
  'prospectos',
  'continuidad_overrides',
  'tramites',
  'tramite_checklists',
  'contratos',
  'usuarios',
  'configuracion_meta_mensual',
  'historico_meta_diario',
  'tarifas_tramites',
  // hijas
  'turno_llamados',
  'certificaciones',
  'certificacion_resultado_cambios',
  'captacion_dateo_redateos',
  'liquidacion_detalle',
  'ticket_eventos',
  'tickets_comentarios',
  'tickets_detalle_excepcion_dateo',
  'facturacion_descuento_ediciones',
  'facturacion_consecutivo_descuento_cambios',
  'tramite_liquidaciones',
  'liquidacion_pagos',
  'formularios_runt',
  'contrato_cambios',
  'contrato_eventos',
  'contrato_historial_estados',
  'contrato_pasos',
  'contratos_salarios',
  'telemercadeo_ciclo_autorizaciones',
  'asesor_prospecto_asignaciones',
  'asesor_convenio_asignaciones',
  'agente_canal_membresias',
  'historico_comercial_asesor',
  'historico_comercial_vehiculo_mensual',
  'meta_comercial_asesor',
  'meta_telemercadeo_asesor',
  'configuracion_recurrencia_asesores',
  'configuracion_redateo_asesores',
  'configuracion_seguimiento_tele_asesores',
  'configuracion_ventana_ticket_asesores',
])

const RE_KNEX =
  /\.(?:from|join|leftJoin|innerJoin|rightJoin|leftOuterJoin|rightOuterJoin|fullOuterJoin)\(\s*['"`]([a-z_]+)(?:\s+as\s+\w+)?['"`]/g
const RE_SQL = /\b(?:FROM|JOIN)\s+`?([a-z_]+)`?/g
const MARCA_CERCA = /sedeSql\(|aplicarSede\(/
const COMENTARIO = /\/\/\s*sede:\s*\S/

function archivos(dir: string): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...archivos(p))
    else if (e.name.endsWith('.ts')) out.push(p)
  }
  return out
}

/** Conteo de consultas sin marca por "archivo::tabla". */
export function escanear(): Record<string, number> {
  const out: Record<string, number> = {}
  for (const f of archivos(path.join(RAIZ, 'app'))) {
    const rel = path.relative(RAIZ, f).replace(/\\/g, '/')
    const lineas = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    lineas.forEach((linea, i) => {
      const t = linea.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      const tablas = new Set<string>()
      for (const m of linea.matchAll(RE_KNEX)) tablas.add(m[1])
      for (const m of linea.matchAll(RE_SQL)) tablas.add(m[1])
      for (const tabla of tablas) {
        if (!TABLAS_SEDE.has(tabla)) continue
        const antes = lineas.slice(Math.max(0, i - 2), i + 1).join('\n')
        const ventana = lineas.slice(Math.max(0, i - 3), i + 30).join('\n')
        if (COMENTARIO.test(antes) || MARCA_CERCA.test(ventana)) continue
        const k = `${rel}::${tabla}`
        out[k] = (out[k] ?? 0) + 1
      }
    })
  }
  return Object.fromEntries(Object.entries(out).sort(([a], [b]) => a.localeCompare(b)))
}

test.group('Guardián SQL crudo por sede', () => {
  test('ninguna consulta cruda nueva sin filtro de sede (baseline solo baja)', ({ assert }) => {
    const actual = escanear()
    if (process.env.GUARDIAN_SEDE === 'regenerar') {
      fs.mkdirSync(path.dirname(BASELINE), { recursive: true })
      fs.writeFileSync(BASELINE, JSON.stringify(actual, null, 2) + '\n')
      console.log(`[guardián] baseline regenerado: ${Object.keys(actual).length} entradas`)
      return
    }
    const baseline = JSON.parse(fs.readFileSync(BASELINE, 'utf8')) as Record<string, number>
    const crecen: string[] = []
    const bajan: string[] = []
    for (const [k, n] of Object.entries(actual)) {
      const b = baseline[k] ?? 0
      if (n > b) crecen.push(`${k}: ${b} → ${n}`)
      else if (n < b) bajan.push(`${k}: ${b} → ${n}`)
    }
    for (const [k, b] of Object.entries(baseline)) {
      if (!(k in actual)) bajan.push(`${k}: ${b} → 0`)
    }
    if (bajan.length) {
      console.log(
        `[guardián] ${bajan.length} entradas bajaron; regenera el baseline:\n  ${bajan.join('\n  ')}`
      )
    }
    assert.deepEqual(
      crecen,
      [],
      'Consultas crudas sobre tablas de sede sin sedeSql/aplicarSede ni "// sede: <motivo>"'
    )
  })

  test('el detector reconoce knex, SQL crudo, marcas y comentarios', ({ assert }) => {
    const casos: Array<[string, boolean]> = [
      [`db.from('turnos_rtms as t').where('x', 1)`, true],
      [`q.leftJoin('comisiones as c', 'c.id', 'x')`, true],
      ['`SELECT * FROM facturacion_tickets ft`', true],
      ['`... JOIN captacion_dateos d ON d.id = x`', true],
      [`db.from('servicios')`, false], // catálogo global
      [`db.from('turnos_rtms as t').whereRaw(sedeSql('t'))`, false],
    ]
    for (const [codigo, debe] of casos) {
      const tablas = new Set<string>()
      for (const m of codigo.matchAll(RE_KNEX)) tablas.add(m[1])
      for (const m of codigo.matchAll(RE_SQL)) tablas.add(m[1])
      const detecta = [...tablas].some((t) => TABLAS_SEDE.has(t)) && !MARCA_CERCA.test(codigo)
      assert.equal(detecta, debe, codigo)
    }
    assert.isTrue(COMENTARIO.test('// sede: catálogo compartido entre sedes'))
    assert.isFalse(COMENTARIO.test('// sede:'))
  })
})
