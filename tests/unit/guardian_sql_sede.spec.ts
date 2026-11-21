import { test } from '@japa/runner'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

// Multi-sede — GUARDIÁN de consultas que esquivan el filtro de sede.
//
// Recorre app/**/*.ts y cuenta, por archivo, tres categorías:
//  1. sqlCrudo: knex .from/.join/... y SQL en strings (FROM/JOIN) sobre
//     tablas de sede, sin sedeSql()/aplicarSede() cerca.
//  2. whereHas: whereHas/orWhereHas/has/orHas/whereDoesntHave/... sobre
//     relaciones que apuntan a modelos con sede (la subconsulta NO pasa por
//     el mixin SedeScoped), sin aplicarSede() en el callback.
//  3. masivo: Modelo.query()...update()/delete()/increment()/decrement()
//     sobre modelos con sede (no pasan por los hooks), sin aplicarSede().
// Excepción explícita en cualquier caso: comentario "// sede: <motivo>" en
// la línea o hasta 2 líneas arriba.
//
// tests/fixtures/sede_guardian_baseline.json guarda lo que hoy no cumple.
// El test FALLA si una entrada sube o aparece una nueva. Regenerar
// (GUARDIAN_SEDE=regenerar) se NIEGA si, frente al baseline COMMITEADO en git
// (HEAD), cualquier entrada sube, aparece una nueva, o crece el número de
// entradas o de consultas: el baseline solo puede bajar. Una categoría que no
// existe en el baseline commiteado se crea una única vez (al introducirla).

const RAIZ = path.resolve(import.meta.dirname, '..', '..')
const REL_BASELINE = 'tests/fixtures/sede_guardian_baseline.json'
const BASELINE = path.join(RAIZ, REL_BASELINE)

type Categoria = 'sqlCrudo' | 'whereHas' | 'masivo'
type Baseline = Record<Categoria, Record<string, number>>
const CATEGORIAS: Categoria[] = ['sqlCrudo', 'whereHas', 'masivo']

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
const RE_WHEREHAS =
  /\.(?:whereHas|orWhereHas|has|orHas|whereDoesntHave|orWhereDoesntHave|doesntHave|orDoesntHave)\(\s*['"](\w+)['"]/g
const RE_MASIVO = /\.(?:update|delete|increment|decrement)\(/
// Marcas de filtro por sede: sedeSql()/aplicarSede(), sqlAsesorDeLaSede() (asesor
// de la sede activa; usa sedeSql por dentro) y la correlación por sede en SQL
// crudo (`t2.sede_id = t.sede_id`: misma sede que una fila ya filtrada).
const MARCA_CERCA =
  /sedeSql\(|aplicarSede\(|sqlAsesorDeLaSede\(|\b[a-z_0-9]+\.sede_id\s*=\s*[a-z_0-9]+\.sede_id\b/
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

/** Modelos con sede (por su static table) y relaciones que apuntan a ellos. */
export function mapaModelos() {
  const tablaDe = new Map<string, string>()
  const relaciones = new Map<string, Set<string>>() // nombre relación → clases destino
  for (const f of archivos(path.join(RAIZ, 'app', 'models'))) {
    const src = fs.readFileSync(f, 'utf8')
    const clase = src.match(/export default class (\w+)/)?.[1]
    const tabla = src.match(/static table\s*=\s*['"]([a-z_]+)['"]/)?.[1]
    if (clase && tabla) tablaDe.set(clase, tabla)
    for (const m of src.matchAll(
      /@(?:hasMany|belongsTo|hasOne|manyToMany|hasManyThrough)\(\s*\(\)\s*=>\s*\[?(\w+)[\s\S]*?declare\s+(\w+)\s*:/g
    )) {
      if (!relaciones.has(m[2])) relaciones.set(m[2], new Set())
      relaciones.get(m[2])!.add(m[1])
    }
  }
  const modelosSede = new Set([...tablaDe].filter(([, t]) => TABLAS_SEDE.has(t)).map(([c]) => c))
  const relacionesSede = new Set(
    [...relaciones].filter(([, cs]) => [...cs].some((c) => modelosSede.has(c))).map(([r]) => r)
  )
  return { modelosSede, relacionesSede }
}

function exento(lineas: string[], i: number) {
  return COMENTARIO.test(lineas.slice(Math.max(0, i - 2), i + 1).join('\n'))
}

/** Sentencia que empieza en la línea i: sigue mientras las líneas siguientes encadenen con ".". */
function sentencia(lineas: string[], i: number): string {
  const partes = [lineas[i]]
  for (let j = i + 1; j < Math.min(lineas.length, i + 25); j++) {
    const t = lineas[j].trim()
    if (t.startsWith('.') || t.startsWith(')') || t.startsWith('//') || t === '') {
      partes.push(lineas[j])
      continue
    }
    // argumentos multilínea de la llamada anterior
    if (/[(,]\s*$/.test(partes[partes.length - 1].trim())) {
      partes.push(lineas[j])
      continue
    }
    break
  }
  return partes.join('\n')
}

export function escanear(): Baseline {
  const { modelosSede, relacionesSede } = mapaModelos()
  const reModelo = modelosSede.size
    ? new RegExp(`\\b(${[...modelosSede].join('|')})\\.query\\(`, 'g')
    : null
  const out: Baseline = { sqlCrudo: {}, whereHas: {}, masivo: {} }
  const sumar = (cat: Categoria, k: string) => (out[cat][k] = (out[cat][k] ?? 0) + 1)

  for (const f of archivos(path.join(RAIZ, 'app'))) {
    const rel = path.relative(RAIZ, f).replace(/\\/g, '/')
    if (rel.startsWith('app/models/')) continue // definiciones de modelos/relaciones
    const lineas = fs.readFileSync(f, 'utf8').split(/\r?\n/)
    lineas.forEach((linea, i) => {
      const t = linea.trim()
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return
      if (exento(lineas, i)) return

      // 1) SQL crudo / knex
      const tablas = new Set<string>()
      for (const m of linea.matchAll(RE_KNEX)) tablas.add(m[1])
      for (const m of linea.matchAll(RE_SQL)) tablas.add(m[1])
      const ventana = lineas.slice(Math.max(0, i - 3), i + 30).join('\n')
      for (const tabla of tablas) {
        if (TABLAS_SEDE.has(tabla) && !MARCA_CERCA.test(ventana))
          sumar('sqlCrudo', `${rel}::${tabla}`)
      }

      // 2) whereHas/has sobre relaciones con sede
      for (const m of linea.matchAll(RE_WHEREHAS)) {
        if (!relacionesSede.has(m[1])) continue
        const cb = lineas.slice(i, i + 6).join('\n')
        if (!/aplicarSede\(/.test(cb)) sumar('whereHas', `${rel}::${m[1]}`)
      }

      // 3) update/delete masivo por query de un modelo con sede
      if (reModelo) {
        for (const m of linea.matchAll(reModelo)) {
          const s = sentencia(lineas, i)
          if (RE_MASIVO.test(s) && !/aplicarSede\(/.test(s)) sumar('masivo', `${rel}::${m[1]}`)
        }
      }
    })
  }
  for (const c of CATEGORIAS) {
    out[c] = Object.fromEntries(Object.entries(out[c]).sort(([a], [b]) => a.localeCompare(b)))
  }
  return out
}

function normalizar(raw: any): Partial<Baseline> {
  if (!raw) return {}
  // Formato viejo (Fase 2): mapa plano = solo sqlCrudo.
  if (!CATEGORIAS.some((c) => c in raw)) return { sqlCrudo: raw }
  return raw
}

function baselineCommiteado(): Partial<Baseline> | null {
  try {
    const txt = execSync(`git show HEAD:${REL_BASELINE}`, { cwd: RAIZ, encoding: 'utf8' })
    return normalizar(JSON.parse(txt))
  } catch {
    return null
  }
}

const totales = (m: Record<string, number>) => ({
  entradas: Object.keys(m).length,
  consultas: Object.values(m).reduce((a, b) => a + b, 0),
})

/** Diferencias que harían crecer el baseline (vacío = solo baja o igual). */
export function crecimientos(base: Partial<Baseline>, nuevo: Baseline): string[] {
  const out: string[] = []
  for (const c of CATEGORIAS) {
    const b = base[c]
    if (!b) continue // categoría nueva: se crea una vez
    for (const [k, n] of Object.entries(nuevo[c])) {
      if (n > (b[k] ?? 0)) out.push(`${c} ${k}: ${b[k] ?? 0} → ${n}`)
    }
    const tb = totales(b)
    const tn = totales(nuevo[c])
    if (tn.entradas > tb.entradas) out.push(`${c}: entradas ${tb.entradas} → ${tn.entradas}`)
    if (tn.consultas > tb.consultas) out.push(`${c}: consultas ${tb.consultas} → ${tn.consultas}`)
  }
  return out
}

test.group('Guardián de consultas por sede', () => {
  test('nada nuevo esquiva el filtro de sede (baseline solo baja)', ({ assert }) => {
    const actual = escanear()

    if (process.env.GUARDIAN_SEDE === 'regenerar') {
      const commit = baselineCommiteado()
      assert.isNotNull(commit, 'No se pudo leer el baseline commiteado (git show HEAD)')
      const crece = crecimientos(commit!, actual)
      assert.deepEqual(crece, [], 'Regenerar se niega: el baseline crecería')
      fs.writeFileSync(BASELINE, JSON.stringify(actual, null, 2) + '\n')
      const resumen = CATEGORIAS.map((c) => {
        const t = totales(actual[c])
        return `${c} ${t.consultas}/${t.entradas}`
      }).join(' · ')
      console.log(`[guardián] baseline regenerado: ${resumen}`)
      return
    }

    const base = normalizar(JSON.parse(fs.readFileSync(BASELINE, 'utf8')))
    const faltan = CATEGORIAS.filter((c) => !base[c])
    assert.deepEqual(faltan, [], 'Baseline sin categorías; regenerar')
    const crece = crecimientos(base, actual)
    const bajan: string[] = []
    for (const c of CATEGORIAS) {
      for (const [k, b] of Object.entries(base[c]!)) {
        const n = actual[c][k] ?? 0
        if (n < b) bajan.push(`${c} ${k}: ${b} → ${n}`)
      }
    }
    if (bajan.length) {
      console.log(
        `[guardián] ${bajan.length} entradas bajaron; regenera el baseline:\n  ${bajan.join('\n  ')}`
      )
    }
    assert.deepEqual(
      crece,
      [],
      'Consultas nuevas que esquivan el filtro de sede (ver guardian_sql_sede.spec.ts)'
    )
  })

  test('detector: knex, SQL crudo, marcas y comentarios', ({ assert }) => {
    const casos: Array<[string, boolean]> = [
      [`db.from('turnos_rtms as t').where('x', 1)`, true],
      [`q.leftJoin('comisiones as c', 'c.id', 'x')`, true],
      ['`SELECT * FROM facturacion_tickets ft`', true],
      ['`... JOIN captacion_dateos d ON d.id = x`', true],
      [`db.from('servicios')`, false], // catálogo global
      [`db.from('meta_comercial_asesor').whereRaw(sqlAsesorDeLaSede('m.asesor_id'))`, false],
      ['`SELECT 1 FROM turnos_rtms t2 WHERE t2.sede_id = t.sede_id`', false],
      ['`SELECT 1 FROM turnos_rtms t2 WHERE t2.sede_id = 1`', true], // no es correlación
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

  test('detector: whereHas sobre relación con sede y update masivo', ({ assert }) => {
    const { modelosSede, relacionesSede } = mapaModelos()
    assert.isTrue(modelosSede.has('TurnoRtm'))
    assert.isTrue(relacionesSede.has('turno'))
    assert.isFalse(relacionesSede.has('servicio')) // catálogo
    const wh = [...`q.whereHas('turno', (t) => t.where('fecha', hoy))`.matchAll(RE_WHEREHAS)]
    assert.equal(wh[0][1], 'turno')
    const lineas = [
      'TurnoRtm.query()',
      "  .where('id', 1)",
      '  .update({ estado: "x" })',
      'const y = 1',
    ]
    assert.isTrue(RE_MASIVO.test(sentencia(lineas, 0)))
    assert.notInclude(sentencia(lineas, 0), 'const y')
  })

  test('regenerar se niega si crece (entrada, entradas o consultas)', ({ assert }) => {
    const base: Baseline = { sqlCrudo: { 'a::t': 2 }, whereHas: {}, masivo: {} }
    const igual: Baseline = { sqlCrudo: { 'a::t': 2 }, whereHas: {}, masivo: {} }
    const baja: Baseline = { sqlCrudo: { 'a::t': 1 }, whereHas: {}, masivo: {} }
    const sube: Baseline = { sqlCrudo: { 'a::t': 3 }, whereHas: {}, masivo: {} }
    const nueva: Baseline = { sqlCrudo: { 'a::t': 1, 'b::t': 1 }, whereHas: {}, masivo: {} }
    assert.deepEqual(crecimientos(base, igual), [])
    assert.deepEqual(crecimientos(base, baja), [])
    assert.isNotEmpty(crecimientos(base, sube))
    assert.isNotEmpty(crecimientos(base, nueva)) // mover deuda a otra entrada también cuenta
    // categoría ausente en el commiteado: se puede crear
    assert.deepEqual(
      crecimientos({ sqlCrudo: { 'a::t': 2 } }, { ...igual, masivo: { 'x::M': 4 } }),
      []
    )
  })
})
