import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

/**
 * Multi-sede, Fase 0 — SOLO BD LOCAL (la compartida de pruebas / producción
 * local). Crea la sede de pruebas "PRUEBAS QA" (id 3, inactiva) y le pasa
 * todo lo que hoy está en la sede 2 (Bogotá), que en local es solo basura de
 * tests, QAT y demos. Así Bogotá queda vacía para su arranque real y los
 * specs escriben en la sede 3.
 *
 * Sin --aplicar solo muestra conteos (dry-run, transacción deshecha).
 * Con --aplicar hace todo en UNA transacción y la deshace si los totales por
 * tabla cambian o queda algo en la sede 2. Idempotente: una segunda corrida
 * no mueve nada. Se niega a correr con NODE_ENV=production.
 *
 *   node ace multisede:sede-qa
 *   node ace multisede:sede-qa --aplicar
 */

const SEDE_ORIGEN = 2
const SEDE_QA = 3
const NOMBRE_QA = 'PRUEBAS QA'

/** Tablas que hoy tienen sede_id. */
const TABLAS = [
  'turnos_rtms',
  'facturacion_tickets',
  'usuarios',
  'contratos',
  'tramites',
  'tramite_checklists',
] as const

type Conteo = Record<string, Record<string, number>>

async function contar(trx: TransactionClientContract): Promise<Conteo> {
  const out: Conteo = {}
  for (const t of TABLAS) {
    const rows = (await trx.from(t).select('sede_id').count('* as n').groupBy('sede_id')) as {
      sede_id: number | null
      n: number
    }[]
    out[t] = {}
    for (const r of rows) out[t][r.sede_id === null ? 'null' : String(r.sede_id)] = Number(r.n)
  }
  return out
}

function total(c: Record<string, number>): number {
  return Object.values(c).reduce((a, b) => a + b, 0)
}

export default class MultisedeSedeQa extends BaseCommand {
  static commandName = 'multisede:sede-qa'
  static description =
    'Crea la sede PRUEBAS QA (3) y le pasa los datos de test de la sede 2 (solo BD local)'

  static options: CommandOptions = {
    startApp: true,
  }

  @flags.boolean({ description: 'Escribe los cambios (sin esto es dry-run)' })
  declare aplicar?: boolean

  async run() {
    if (process.env.NODE_ENV === 'production') {
      this.logger.error('Este comando es solo para la BD local; NODE_ENV=production.')
      this.exitCode = 1
      return
    }

    const trx = await db.transaction()
    try {
      // 1) Sede QA
      const existente = await trx.from('sedes').where('id', SEDE_QA).first()
      if (existente && existente.nombre !== NOMBRE_QA) {
        throw new Error(`La sede ${SEDE_QA} ya existe con otro nombre: "${existente.nombre}"`)
      }
      const porNombre = await trx.from('sedes').where('nombre', NOMBRE_QA).first()
      if (porNombre && Number(porNombre.id) !== SEDE_QA) {
        throw new Error(`"${NOMBRE_QA}" ya existe con id ${porNombre.id}, no ${SEDE_QA}`)
      }
      if (!existente) {
        const ibague = await trx.from('sedes').where('id', 1).first()
        if (!ibague) throw new Error('No existe la sede 1 (Ibagué)')
        await trx.table('sedes').insert({
          id: SEDE_QA,
          ciudad_id: ibague.ciudad_id,
          nombre: NOMBRE_QA,
          direccion: null,
          timezone: 'America/Bogota',
          activo: 0,
        })
        this.logger.info(`Sede ${SEDE_QA} "${NOMBRE_QA}" creada (activo=0)`)
      } else {
        this.logger.info(`Sede ${SEDE_QA} "${NOMBRE_QA}" ya existía`)
      }

      // 2) Conteos antes
      const antes = await contar(trx)

      // 3) Mover sede 2 → 3
      const movidas: Record<string, number> = {}
      for (const t of TABLAS) {
        if (t === 'facturacion_tickets') {
          // sede_nombre es el snapshot que muestran pantallas y Excel.
          movidas[t] = Number(
            await trx
              .from(t)
              .where('sede_id', SEDE_ORIGEN)
              .update({ sede_id: SEDE_QA, sede_nombre: NOMBRE_QA })
          )
        } else {
          movidas[t] = Number(
            await trx.from(t).where('sede_id', SEDE_ORIGEN).update({ sede_id: SEDE_QA })
          )
        }
      }

      // 4) Conteos después + verificación
      const despues = await contar(trx)
      const errores: string[] = []
      for (const t of TABLAS) {
        if (total(antes[t]) !== total(despues[t])) {
          errores.push(`${t}: total cambió ${total(antes[t])} → ${total(despues[t])}`)
        }
        if ((despues[t][String(SEDE_ORIGEN)] ?? 0) !== 0) {
          errores.push(
            `${t}: quedan ${despues[t][String(SEDE_ORIGEN)]} filas en sede ${SEDE_ORIGEN}`
          )
        }
        const esperado = (antes[t][String(SEDE_QA)] ?? 0) + (antes[t][String(SEDE_ORIGEN)] ?? 0)
        if ((despues[t][String(SEDE_QA)] ?? 0) !== esperado) {
          errores.push(
            `${t}: sede ${SEDE_QA} = ${despues[t][String(SEDE_QA)] ?? 0}, esperado ${esperado}`
          )
        }
      }

      this.logger.log('tabla | antes (sede: filas) | movidas | después (sede: filas)')
      for (const t of TABLAS) {
        this.logger.log(
          `${t} | ${JSON.stringify(antes[t])} | ${movidas[t]} | ${JSON.stringify(despues[t])}`
        )
      }

      if (errores.length) {
        await trx.rollback()
        this.logger.error('Verificación fallida, no se escribió nada:\n' + errores.join('\n'))
        this.exitCode = 1
        return
      }

      if (this.aplicar) {
        await trx.commit()
        this.logger.success('Aplicado.')
      } else {
        await trx.rollback()
        this.logger.info('Dry-run: nada escrito. Usa --aplicar para escribir.')
      }
    } catch (error) {
      await trx.rollback()
      this.logger.error((error as Error).message)
      this.exitCode = 1
    }
  }
}
