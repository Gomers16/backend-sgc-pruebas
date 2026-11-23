import { test } from '@japa/runner'
import Database from '@adonisjs/lucid/services/db'
import { conSede, sinFiltroDeSede } from '#services/sede_scope'
import {
  getHorasExclusividad,
  getMaxRedateos,
  getMinutosVentanaGlobal,
  invalidateHorasExclusividadCache,
} from '#services/reserva_dateo_service'
import { resolveConfigRecurrencia } from '#services/comision_calculo_service'
import { getConfigSeguimientoTele } from '#services/telemercadeo_gestion_service'

// Multi-sede 3g — configuración global con override por sede (sede_id NULL =
// global). Ibagué (sin override) lee EXACTAMENTE lo mismo que antes; QA con
// un override lee el suyo; "todas" lee la global. Los overrides de prueba
// (sede 3) se borran al final.

const IBAGUE = 1
const QA = 3

const TABLAS = {
  reserva: 'configuracion_reserva_dateos',
  ventana: 'configuracion_ventana_ticket_global',
  redateo: 'configuracion_redateo_global',
  recurrencia: 'configuracion_recurrencia_global',
  tele: 'configuracion_seguimiento_tele_global',
} as const

// Overrides de QA que ya existían (p. ej. de una prueba manual): se apartan
// al inicio y se restauran al final. Los de Ibagué no se tocan.
const previos: Record<string, any[]> = {}
async function apartarOverrides() {
  for (const t of Object.values(TABLAS)) {
    previos[t] = await Database.from(t).where('sede_id', QA)
  }
  await borrarOverrides()
}
async function restaurarOverrides() {
  await borrarOverrides()
  for (const [t, filas] of Object.entries(previos)) {
    if (filas.length) await Database.table(t).multiInsert(filas)
  }
  invalidateHorasExclusividadCache()
}
async function hayOverride(sedeId: number) {
  for (const t of Object.values(TABLAS)) {
    if (await Database.from(t).where('sede_id', sedeId).first()) return true
  }
  return false
}

async function borrarOverrides() {
  for (const t of Object.values(TABLAS)) await Database.from(t).where('sede_id', QA).delete()
  invalidateHorasExclusividadCache()
}

async function lecturas() {
  invalidateHorasExclusividadCache()
  const rec = await resolveConfigRecurrencia(null, null)
  const tele = await getConfigSeguimientoTele()
  return {
    horas: await getHorasExclusividad(),
    ventana: await getMinutosVentanaGlobal(),
    redateos: await getMaxRedateos(null),
    recurrente: rec.valorRecurrente,
    recuperacion: rec.valorRecuperacion,
    teleMax: tele.maxSeguimientos,
    teleDias: tele.diasVigenciaCiclo,
  }
}

test.group('Multi-sede 3g · configuración con override por sede', (group) => {
  group.setup(apartarOverrides)
  group.teardown(restaurarOverrides)

  test('sin override: Ibagué, QA y "todas" leen la global (mismo valor que antes)', async ({
    assert,
  }) => {
    const antes = await sinFiltroDeSede(lecturas)
    // Con un override real en Ibagué, sus lecturas no tienen por qué ser las globales.
    if (!(await hayOverride(IBAGUE))) {
      assert.deepEqual(await conSede([IBAGUE], lecturas), antes)
    }
    assert.deepEqual(await conSede([QA], lecturas), antes)
    assert.deepEqual(await conSede([IBAGUE, QA], lecturas), antes)
  })

  test('override de QA: gana en QA; Ibagué y "todas" siguen con la global', async ({ assert }) => {
    const antes = await conSede([IBAGUE], lecturas)
    const global = await sinFiltroDeSede(lecturas)
    const ahora = new Date()
    await Database.table(TABLAS.reserva).insert({
      sede_id: QA,
      horas_exclusividad: 7,
      created_at: ahora,
      updated_at: ahora,
    })
    await Database.table(TABLAS.ventana).insert({
      sede_id: QA,
      minutos_ventana: 11,
      created_at: ahora,
      updated_at: ahora,
    })
    await Database.table(TABLAS.redateo).insert({
      sede_id: QA,
      max_redateos: 9,
      created_at: ahora,
      updated_at: ahora,
    })
    await Database.table(TABLAS.recurrencia).insert({
      sede_id: QA,
      meses_minimos: 12,
      valor_dateo_recurrencia: 111,
      valor_dateo_recuperacion: 222,
      created_at: ahora,
      updated_at: ahora,
    })
    await Database.table(TABLAS.tele).insert({
      sede_id: QA,
      max_seguimientos: 5,
      dias_vigencia_ciclo: 9,
      created_at: ahora,
      updated_at: ahora,
    })

    const qa = await conSede([QA], lecturas)
    assert.deepEqual(qa, {
      horas: 7,
      ventana: 11,
      redateos: 9,
      recurrente: 111,
      recuperacion: 222,
      teleMax: 5,
      teleDias: 9,
    })
    assert.deepEqual(await conSede([IBAGUE], lecturas), antes)
    assert.deepEqual(await conSede([IBAGUE, QA], lecturas), global)
  })
})
