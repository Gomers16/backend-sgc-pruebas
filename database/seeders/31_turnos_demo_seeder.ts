// database/seeders/31_turnos_demo_seeder.ts
// QA demo — módulo Turnos
// Crea 16 turnos deterministas (4 fechas × 4 servicios) para probar
// el filtro de fecha y la búsqueda por placa en TurnosDelDia.vue.
//
// Resumen de datos:
//   Placas:  TST001–TST016 (fáciles de buscar)
//   Estados: activo × 3 · finalizado × 10 · cancelado × 3
//   Fechas:  hoy · ayer · hace 7 días · hace 30 días
//   Sede:    la de SEED_SEDE (obligatoria; la 2, Bogotá, prohibida)
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import { sedeDeSeeder } from '../helpers/sede_seeder.js'
import { sinFiltroDeSede } from '#services/sede_scope'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import TurnoRtm from '#models/turno_rtm'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'

type EstadoTurno = 'activo' | 'finalizado' | 'cancelado'
type TipoVehiculo = 'Liviano Particular' | 'Liviano Taxi' | 'Liviano Público' | 'Motocicleta'

// Sede explícita: SEED_SEDE=<id> (obligatoria; la 2, Bogotá, prohibida).
// Se fija al inicio de run() con sedeDeSeeder(); ver database/helpers/sede_seeder.ts.
let SEDE_ID = 0
const HOY = DateTime.local().setZone('America/Bogota').startOf('day')

interface TurnoSpec {
  dateOffset: number
  svc: string
  placa: string
  estado: EstadoTurno
  horaIngreso: string
  horaSalida: string | null
  tiempoServicio: string | null
  tipoVehiculo: TipoVehiculo
}

const SPECS: TurnoSpec[] = [
  // ── HOY ─────────────────────────────────────────────────────────────────
  {
    dateOffset: 0,
    svc: 'RTM',
    placa: 'TST001',
    estado: 'activo',
    horaIngreso: '08:00',
    horaSalida: null,
    tiempoServicio: null,
    tipoVehiculo: 'Liviano Particular',
  },
  {
    dateOffset: 0,
    svc: 'PREV',
    placa: 'TST002',
    estado: 'activo',
    horaIngreso: '10:00',
    horaSalida: null,
    tiempoServicio: null,
    tipoVehiculo: 'Liviano Taxi',
  },
  {
    dateOffset: 0,
    svc: 'PERI',
    placa: 'TST003',
    estado: 'finalizado',
    horaIngreso: '14:00',
    horaSalida: '14:55',
    tiempoServicio: '55 min',
    tipoVehiculo: 'Liviano Público',
  },
  {
    dateOffset: 0,
    svc: 'SOAT',
    placa: 'TST004',
    estado: 'cancelado',
    horaIngreso: '16:00',
    horaSalida: null,
    tiempoServicio: null,
    tipoVehiculo: 'Motocicleta',
  },
  // ── AYER ─────────────────────────────────────────────────────────────────
  {
    dateOffset: 1,
    svc: 'RTM',
    placa: 'TST005',
    estado: 'finalizado',
    horaIngreso: '08:00',
    horaSalida: '09:10',
    tiempoServicio: '70 min',
    tipoVehiculo: 'Liviano Particular',
  },
  {
    dateOffset: 1,
    svc: 'PREV',
    placa: 'TST006',
    estado: 'activo',
    horaIngreso: '10:00',
    horaSalida: null,
    tiempoServicio: null,
    tipoVehiculo: 'Motocicleta',
  },
  {
    dateOffset: 1,
    svc: 'PERI',
    placa: 'TST007',
    estado: 'finalizado',
    horaIngreso: '14:00',
    horaSalida: '15:20',
    tiempoServicio: '80 min',
    tipoVehiculo: 'Liviano Particular',
  },
  {
    dateOffset: 1,
    svc: 'SOAT',
    placa: 'TST008',
    estado: 'cancelado',
    horaIngreso: '16:00',
    horaSalida: null,
    tiempoServicio: null,
    tipoVehiculo: 'Liviano Taxi',
  },
  // ── HACE 7 DÍAS ──────────────────────────────────────────────────────────
  {
    dateOffset: 7,
    svc: 'RTM',
    placa: 'TST009',
    estado: 'finalizado',
    horaIngreso: '08:00',
    horaSalida: '09:05',
    tiempoServicio: '65 min',
    tipoVehiculo: 'Liviano Particular',
  },
  {
    dateOffset: 7,
    svc: 'PREV',
    placa: 'TST010',
    estado: 'finalizado',
    horaIngreso: '10:00',
    horaSalida: '10:40',
    tiempoServicio: '40 min',
    tipoVehiculo: 'Liviano Público',
  },
  {
    dateOffset: 7,
    svc: 'PERI',
    placa: 'TST011',
    estado: 'finalizado',
    horaIngreso: '14:00',
    horaSalida: '14:50',
    tiempoServicio: '50 min',
    tipoVehiculo: 'Liviano Taxi',
  },
  {
    dateOffset: 7,
    svc: 'SOAT',
    placa: 'TST012',
    estado: 'cancelado',
    horaIngreso: '16:00',
    horaSalida: null,
    tiempoServicio: null,
    tipoVehiculo: 'Motocicleta',
  },
  // ── HACE 30 DÍAS ─────────────────────────────────────────────────────────
  {
    dateOffset: 30,
    svc: 'RTM',
    placa: 'TST013',
    estado: 'finalizado',
    horaIngreso: '08:00',
    horaSalida: '09:15',
    tiempoServicio: '75 min',
    tipoVehiculo: 'Liviano Particular',
  },
  {
    dateOffset: 30,
    svc: 'PREV',
    placa: 'TST014',
    estado: 'finalizado',
    horaIngreso: '10:00',
    horaSalida: '10:35',
    tiempoServicio: '35 min',
    tipoVehiculo: 'Motocicleta',
  },
  {
    dateOffset: 30,
    svc: 'PERI',
    placa: 'TST015',
    estado: 'finalizado',
    horaIngreso: '14:00',
    horaSalida: '15:10',
    tiempoServicio: '70 min',
    tipoVehiculo: 'Liviano Público',
  },
  {
    dateOffset: 30,
    svc: 'SOAT',
    placa: 'TST016',
    estado: 'finalizado',
    horaIngreso: '16:00',
    horaSalida: '16:30',
    tiempoServicio: '30 min',
    tipoVehiculo: 'Liviano Particular',
  },
]

export default class TurnosDemoSeeder extends BaseSeeder {
  // Multi-sede: sin request no hay sede activa; el seeder declara la suya en
  // cada registro, así que corre sin filtro de sede de forma explícita.
  async run() {
    SEDE_ID = sedeDeSeeder('31_turnos_demo_seeder')
    await sinFiltroDeSede(async () => await this.sembrar())
  }

  private async sembrar() {
    const trx = await db.transaction()
    try {
      // ── Prerrequisitos ────────────────────────────────────────────────────
      const usuario = await Usuario.query({ client: trx }).where('sede_id', SEDE_ID).first()
      if (!usuario) {
        console.warn('[TurnosDemoSeeder] No hay usuarios en sede_id=1. Abortando.')
        await trx.commit()
        return
      }

      const servicios = await Servicio.query({ client: trx })
      const svcMap = new Map(servicios.map((s) => [s.codigoServicio.toUpperCase(), s]))

      // ── Contadores consecutivos (inicializados desde el MAX actual de la BD)
      const globalCounters = new Map<string, number>() // key: fechaISO
      const svcCounters = new Map<string, number>() // key: fechaISO|svcId

      const getNextGlobal = async (fechaISO: string): Promise<number> => {
        if (!globalCounters.has(fechaISO)) {
          const row = await trx
            .from('turnos_rtms')
            .where('sede_id', SEDE_ID)
            .where('fecha', fechaISO)
            .max('turno_numero as max')
            .first()
          globalCounters.set(fechaISO, Number(row?.max ?? 0))
        }
        const next = globalCounters.get(fechaISO)! + 1
        globalCounters.set(fechaISO, next)
        return next
      }

      const getNextSvc = async (fechaISO: string, svcId: number): Promise<number> => {
        const key = `${fechaISO}|${svcId}`
        if (!svcCounters.has(key)) {
          const row = await trx
            .from('turnos_rtms')
            .where('sede_id', SEDE_ID)
            .where('fecha', fechaISO)
            .where('servicio_id', svcId)
            .max('turno_numero_servicio as max')
            .first()
          svcCounters.set(key, Number(row?.max ?? 0))
        }
        const next = svcCounters.get(key)! + 1
        svcCounters.set(key, next)
        return next
      }

      // ── Inserción ─────────────────────────────────────────────────────────
      let created = 0

      for (const spec of SPECS) {
        const fecha = HOY.minus({ days: spec.dateOffset })
        const fechaISO = fecha.toISODate()!
        const svc = svcMap.get(spec.svc)

        if (!svc) {
          console.warn(
            `[TurnosDemoSeeder] Servicio "${spec.svc}" no encontrado. Saltando ${spec.placa}.`
          )
          continue
        }

        const turnoNumero = await getNextGlobal(fechaISO)
        const turnoNumeroServicio = await getNextSvc(fechaISO, svc.id)

        // Cancelados llevan número negado igual que el controller cancelar(),
        // para liberar el slot del unique constraint y que MAX(>0) los ignore.
        const isCancelado = spec.estado === 'cancelado'
        const storedNumero = isCancelado ? -turnoNumero : turnoNumero
        const storedNumeroSvc = isCancelado ? -turnoNumeroServicio : turnoNumeroServicio

        await TurnoRtm.create(
          {
            sedeId: SEDE_ID,
            funcionarioId: usuario.id,
            servicioId: svc.id,
            fecha,
            horaIngreso: spec.horaIngreso,
            horaSalida: spec.horaSalida,
            tiempoServicio: spec.tiempoServicio,
            turnoNumero: storedNumero,
            turnoNumeroServicio: storedNumeroSvc,
            turnoCodigo: `${spec.svc}-${fecha.toFormat('yyyyMMdd')}-${String(turnoNumero).padStart(3, '0')}`,
            placa: spec.placa,
            tipoVehiculo: spec.tipoVehiculo,
            estado: spec.estado,
            tieneFacturacion: false,
            esRecurrente: false,
            esRecuperacion: false,
            esAvance: false,
          } as any,
          { client: trx }
        )

        created++
      }

      await trx.commit()

      console.log(`[TurnosDemoSeeder] OK — ${created}/16 turnos creados en sede_id=${SEDE_ID}`)
      console.log('  Fechas cubiertas:')
      console.log(
        `    HOY        (${HOY.toISODate()}): TST001 RTM activo · TST002 PREV activo · TST003 PERI finalizado · TST004 SOAT cancelado`
      )
      console.log(
        `    AYER       (${HOY.minus({ days: 1 }).toISODate()}): TST005 RTM finalizado · TST006 PREV activo · TST007 PERI finalizado · TST008 SOAT cancelado`
      )
      console.log(
        `    HACE 7d    (${HOY.minus({ days: 7 }).toISODate()}): TST009 RTM finalizado · TST010 PREV finalizado · TST011 PERI finalizado · TST012 SOAT cancelado`
      )
      console.log(
        `    HACE 30d   (${HOY.minus({ days: 30 }).toISODate()}): TST013–TST016 todos finalizados`
      )
      console.log('  Para probar búsqueda por placa: cualquier "TST" mostrará múltiples resultados')
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
