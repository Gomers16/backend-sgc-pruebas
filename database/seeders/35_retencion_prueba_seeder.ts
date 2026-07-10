// database/seeders/35_retencion_prueba_seeder.ts
//
// Puebla las columnas de retención de turnos_rtms (es_recurrente, es_recuperacion,
// meses_desde_ultima_visita, fecha_ultima_visita) sobre turnos ya facturados
// (facturacion_tickets CONFIRMADA), excluyendo placas TST%, para poder probar
// el reporte de retención de clientes.
// Solo hace UPDATE — no borra ni inserta nada.
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

const TOTAL_TARGET = 300

type Categoria = 'NUEVO' | 'RECURRENTE' | 'RECUPERACION'

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/**
 * Reparte `total` elementos entre etiquetas según pesos (porcentajes),
 * exacto, usando el método de mayor residuo (sin perder ni sobrar filas
 * por redondeo).
 */
function buildWeightedPool<T extends string>(total: number, weights: Record<T, number>): T[] {
  const entries = Object.entries(weights) as [T, number][]
  const base = entries.map(([label, w]) => {
    const exact = total * w
    return { label, count: Math.floor(exact), rem: exact - Math.floor(exact) }
  })
  const asignados = base.reduce((s, b) => s + b.count, 0)
  let faltan = total - asignados
  base.sort((a, b) => b.rem - a.rem)
  for (let i = 0; i < faltan; i++) base[i % base.length].count++

  const pool: T[] = []
  for (const b of base) for (let i = 0; i < b.count; i++) pool.push(b.label as T)
  return shuffle(pool)
}

export default class RetencionPruebaSeeder extends BaseSeeder {
  public async run() {
    const trx = await db.transaction()
    try {
      const configRecurrencia = await trx
        .from('configuracion_recurrencia_global')
        .select('meses_minimos')
        .first()

      if (!configRecurrencia) {
        console.warn('⚠️ No existe configuracion_recurrencia_global. Abortando seeder.')
        await trx.commit()
        return
      }

      const mesesMinimos = Math.max(2, Number(configRecurrencia.meses_minimos))
      console.log(`ℹ️ meses_minimos = ${mesesMinimos}`)

      // Turnos con facturación confirmada, excluyendo placas de prueba (TST%)
      const elegibles = (await trx
        .from('turnos_rtms as t')
        .innerJoin('facturacion_tickets as ft', 'ft.turno_id', 't.id')
        .where('ft.estado', 'CONFIRMADA')
        .whereNot('t.placa', 'like', 'TST%')
        .select('t.id', 't.fecha', 'ft.captacion_canal as canal')) as {
        id: number
        fecha: string
        canal: string | null
      }[]

      if (!elegibles.length) {
        console.warn('⚠️ No hay turnos elegibles (con facturación CONFIRMADA, sin placas TST%).')
        await trx.commit()
        return
      }

      // Agrupar por canal para repartir el TOTAL_TARGET proporcionalmente
      const porCanal = new Map<string, typeof elegibles>()
      for (const row of elegibles) {
        const canal = row.canal ?? 'SIN_CANAL'
        if (!porCanal.has(canal)) porCanal.set(canal, [])
        porCanal.get(canal)!.push(row)
      }

      const totalElegibles = elegibles.length
      const cupos = [...porCanal.entries()].map(([canal, rows]) => ({
        canal,
        rows,
        exact: (TOTAL_TARGET * rows.length) / totalElegibles,
      }))
      const base = cupos.map((c) => ({ ...c, count: Math.floor(c.exact), rem: c.exact - Math.floor(c.exact) }))
      let faltan = TOTAL_TARGET - base.reduce((s, b) => s + b.count, 0)
      base.sort((a, b) => b.rem - a.rem)
      for (let i = 0; i < faltan && i < base.length; i++) base[i].count++

      const seleccionados: { id: number; fecha: string }[] = []
      for (const c of base) {
        const cuota = Math.min(c.count, c.rows.length)
        const elegidos = shuffle(c.rows).slice(0, cuota)
        for (const e of elegidos) seleccionados.push({ id: e.id, fecha: e.fecha })
      }

      const seleccionadosShuffled = shuffle(seleccionados)
      const categorias = buildWeightedPool<Categoria>(seleccionadosShuffled.length, {
        NUEVO: 0.5,
        RECURRENTE: 0.3,
        RECUPERACION: 0.2,
      })

      let nuevos = 0
      let recurrentes = 0
      let recuperaciones = 0

      for (let i = 0; i < seleccionadosShuffled.length; i++) {
        const turno = seleccionadosShuffled[i]
        const categoria = categorias[i]
        const fechaTurno = DateTime.fromJSDate(new Date(turno.fecha))

        if (categoria === 'NUEVO') {
          await trx.from('turnos_rtms').where('id', turno.id).update({
            es_recurrente: 0,
            es_recuperacion: 0,
            meses_desde_ultima_visita: null,
            fecha_ultima_visita: null,
          })
          nuevos++
        } else if (categoria === 'RECURRENTE') {
          const meses = randInt(1, mesesMinimos - 1)
          const fechaUltimaVisita = fechaTurno.minus({ months: meses }).toISODate()
          await trx.from('turnos_rtms').where('id', turno.id).update({
            es_recurrente: 1,
            es_recuperacion: 0,
            meses_desde_ultima_visita: meses,
            fecha_ultima_visita: fechaUltimaVisita,
          })
          recurrentes++
        } else {
          const meses = randInt(mesesMinimos, 48)
          const fechaUltimaVisita = fechaTurno.minus({ months: meses }).toISODate()
          await trx.from('turnos_rtms').where('id', turno.id).update({
            es_recurrente: 0,
            es_recuperacion: 1,
            meses_desde_ultima_visita: meses,
            fecha_ultima_visita: fechaUltimaVisita,
          })
          recuperaciones++
        }
      }

      console.log(
        `✅ turnos_rtms actualizados: ${seleccionadosShuffled.length} (nuevos=${nuevos}, recurrentes=${recurrentes}, recuperaciones=${recuperaciones})`
      )

      await trx.commit()

      const verificacion = await db
        .from('turnos_rtms')
        .whereNot('placa', 'like', 'TST%')
        .select(
          db.raw(
            `SUM(CASE WHEN es_recurrente=0 AND es_recuperacion=0 AND meses_desde_ultima_visita IS NULL THEN 1 ELSE 0 END) as nuevos`
          ),
          db.raw(`SUM(CASE WHEN es_recurrente=1 THEN 1 ELSE 0 END) as recurrentes`),
          db.raw(`SUM(CASE WHEN es_recuperacion=1 THEN 1 ELSE 0 END) as recuperaciones`)
        )
        .first()

      console.log('📊 Verificación turnos_rtms (placa NOT LIKE "TST%"):', verificacion)
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
