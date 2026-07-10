// database/seeders/38_comisiones_prueba_seeder.ts
//
// Genera 80 comisiones REALES (es_config = 0) para poder probar el reporte
// de pagos de comisiones, que hasta ahora no tenía ningún dato (la tabla
// comisiones solo contenía 6 filas de configuración, es_config = 1).
//
// captacion_dateos también estaba vacía en este entorno (0 filas), así que
// el seeder crea primero un dateo "consumido" por cada comisión (vinculado
// a un turno_rtm RTM real, ya existente, sin dateo asignado), replicando el
// mismo patrón que usa comisiones_controller.ts#store() en producción.
// Solo INSERTA en captacion_dateos y comisiones — no borra ni modifica
// ninguna fila existente (turnos_rtms, agentes_captacions, convenios,
// usuarios se leen, nunca se actualizan). Es idempotente: si ya existe
// alguna comisión real (es_config = 0), no vuelve a insertar.
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import Comision from '#models/comision'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import Usuario from '#models/usuario'
import Rol from '#models/rol'

type ComisionEstado = 'PENDIENTE' | 'APROBADA' | 'PAGADA' | 'ANULADA'
type Canal = 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO'

const CANTIDAD_ESCENARIO_1 = 30 // Asesor Comercial directo
const CANTIDAD_ESCENARIO_2 = 30 // Asesor Convenio se datea a sí mismo
const CANTIDAD_ESCENARIO_3 = 20 // Comercial datea para convenio
const TOTAL = CANTIDAD_ESCENARIO_1 + CANTIDAD_ESCENARIO_2 + CANTIDAD_ESCENARIO_3 // 80

const CANTIDAD_PAGADA = 40
const CANTIDAD_APROBADA = 20
const CANTIDAD_PENDIENTE = 15
const CANTIDAD_ANULADA = 5

const BASE_MOTO = 141339
const BASE_VEHICULO = 233683

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function roundTo(v: number, step: number): number {
  return Math.round(v / step) * step
}
function pick<T>(arr: readonly T[]): T {
  return arr[randInt(0, arr.length - 1)]
}
function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

interface ComisionSpec {
  canal: Canal
  asesorId: number
  convenioId: number | null
  asesorSecundarioId: number | null
  montoAsesor: number
  montoConvenio: number | null
}

export default class ComisionesPruebaSeeder extends BaseSeeder {
  public async run() {
    const trx = await db.transaction()
    try {
      const yaExisten = await trx
        .from('comisiones')
        .where('es_config', false)
        .count('* as c')
        .first()
      if (Number(yaExisten?.c) > 0) {
        console.log('⚠️ Ya existen comisiones reales (es_config = 0). Seeder omitido (idempotente).')
        await trx.commit()
        return
      }

      // ===== Prerrequisitos =====
      const agentesComercial = await AgenteCaptacion.query({ client: trx })
        .where('tipo', 'ASESOR_COMERCIAL')
        .andWhere('activo', true)
      if (!agentesComercial.length) {
        throw new Error('❌ No hay agentes ASESOR_COMERCIAL activos. Abortando seeder.')
      }

      const convenios = await Convenio.query({ client: trx })
        .where('activo', true)
        .whereNotNull('asesor_convenio_id')
        .limit(40)
      if (!convenios.length) {
        throw new Error('❌ No hay convenios activos con asesor_convenio_id. Abortando seeder.')
      }

      const rolesAprobadores = await Rol.query({ client: trx }).whereIn('nombre', [
        'SUPER_ADMIN',
        'GERENCIA',
      ])
      const usuariosAprobadores = await Usuario.query({ client: trx })
        .whereIn(
          'rol_id',
          rolesAprobadores.map((r) => r.id)
        )
        .andWhere('estado', 'activo')
      if (!usuariosAprobadores.length) {
        throw new Error('❌ No hay usuarios SUPER_ADMIN/GERENCIA activos. Abortando seeder.')
      }

      // Turnos RTM reales, sin dateo asignado, con placa "real" (no TST/FIX/NEW de otros seeders)
      const turnos = await TurnoRtm.query({ client: trx })
        .where('servicio_id', 1) // RTM
        .whereNull('captacion_dateo_id')
        .whereRaw("placa REGEXP '^[A-Z]{3}[0-9]{3}$'")
        .whereRaw("placa NOT LIKE 'TST%'")
        .whereRaw("placa NOT LIKE 'FIX%'")
        .whereRaw("placa NOT LIKE 'NEW%'")
        .orderBy('id', 'asc')
        .limit(TOTAL)
      if (turnos.length < TOTAL) {
        throw new Error(
          `❌ Se necesitan ${TOTAL} turnos RTM sin dateo y solo hay ${turnos.length}. Abortando seeder.`
        )
      }

      // ===== Armar los 80 "specs" de comisión por escenario =====
      const specs: ComisionSpec[] = []

      for (let i = 0; i < CANTIDAD_ESCENARIO_1; i++) {
        specs.push({
          canal: 'ASESOR_COMERCIAL',
          asesorId: pick(agentesComercial).id,
          convenioId: null,
          asesorSecundarioId: null,
          montoAsesor: roundTo(randInt(8000, 25000), 100),
          montoConvenio: null,
        })
      }

      for (let i = 0; i < CANTIDAD_ESCENARIO_2; i++) {
        const convenio = pick(convenios)
        specs.push({
          canal: 'ASESOR_CONVENIO',
          asesorId: convenio.asesorConvenioId!,
          convenioId: convenio.id,
          asesorSecundarioId: null,
          montoAsesor: roundTo(randInt(3000, 8000), 100),
          montoConvenio: roundTo(randInt(30000, 90000), 100),
        })
      }

      for (let i = 0; i < CANTIDAD_ESCENARIO_3; i++) {
        const convenio = pick(convenios)
        specs.push({
          canal: 'ASESOR_COMERCIAL',
          asesorId: pick(agentesComercial).id,
          convenioId: convenio.id,
          asesorSecundarioId: convenio.asesorConvenioId,
          montoAsesor: roundTo(randInt(5000, 15000), 100),
          montoConvenio: roundTo(randInt(25000, 70000), 100),
        })
      }

      const specsMezcladas = shuffle(specs)

      // ===== Distribución de estados (conteos exactos, orden mezclado) =====
      const estados: ComisionEstado[] = shuffle([
        ...Array(CANTIDAD_PAGADA).fill('PAGADA' as const),
        ...Array(CANTIDAD_APROBADA).fill('APROBADA' as const),
        ...Array(CANTIDAD_PENDIENTE).fill('PENDIENTE' as const),
        ...Array(CANTIDAD_ANULADA).fill('ANULADA' as const),
      ])

      let creadas = 0

      for (let i = 0; i < TOTAL; i++) {
        const spec = specsMezcladas[i]
        const turno = turnos[i]
        const estado = estados[i]

        const esMoto = (turno.tipoVehiculo ?? '').toLowerCase().includes('moto')
        const tipoVehiculo: 'MOTO' | 'VEHICULO' = esMoto ? 'MOTO' : 'VEHICULO'
        const base = esMoto ? BASE_MOTO : BASE_VEHICULO
        const porcentaje = randInt(2, 8) + randInt(0, 99) / 100

        // fechaCalculo: día 1-20 de junio 2026, deja margen para aprobar/pagar/anular sin salirse del mes
        const fechaCalculo = DateTime.fromISO('2026-06-01').plus({ days: randInt(0, 19) })

        // ===== Dateo consumido (mismo turno, mismo canal/convenio que la comisión) =====
        const dateo = await CaptacionDateo.create(
          {
            canal: spec.canal,
            agenteId: spec.asesorId,
            placa: turno.placa,
            origen: 'IMPORT',
            observacion: 'Dateo de prueba (38_comisiones_prueba_seeder)',
            consumidoTurnoId: turno.id,
            consumidoAt: fechaCalculo,
            convenioId: spec.convenioId,
            asesorConvenioId: spec.canal === 'ASESOR_CONVENIO' ? spec.asesorId : spec.asesorSecundarioId,
            servicioId: turno.servicioId,
            resultado: 'EXITOSO',
            liberado: false,
            detectadoPorConvenio: false,
            esClienteRecurrente: false,
            esAvance: false,
          } as any,
          { client: trx }
        )

        const monto = spec.montoAsesor + (spec.montoConvenio ?? 0)

        const c = new Comision()
        c.useTransaction(trx)
        c.captacionDateoId = dateo.id
        c.asesorId = spec.asesorId
        c.convenioId = spec.convenioId
        c.asesorSecundarioId = spec.asesorSecundarioId
        c.tipoServicio = 'RTM'
        ;(c as any).tipoVehiculo = tipoVehiculo
        c.base = String(base)
        c.porcentaje = porcentaje.toFixed(2)
        c.monto = String(monto)
        c.montoAsesor = String(spec.montoAsesor)
        c.montoConvenio = spec.montoConvenio !== null ? String(spec.montoConvenio) : null
        c.valorNuevoDirecto = '0'
        c.esAvance = false
        c.esConfig = false
        c.fechaCalculo = fechaCalculo
        c.estado = estado

        if (estado === 'APROBADA' || estado === 'PAGADA') {
          const aprobador = pick(usuariosAprobadores)
          c.aprobadoAt = fechaCalculo.plus({ days: randInt(1, 4) })
          c.aprobadoPor = aprobador.id

          if (estado === 'PAGADA') {
            const pagador = pick(usuariosAprobadores)
            c.pagadoAt = c.aprobadoAt.plus({ days: randInt(2, 3) })
            c.pagadoPor = pagador.id
          }
        } else if (estado === 'ANULADA') {
          const anulador = pick(usuariosAprobadores)
          c.anuladoAt = fechaCalculo.plus({ days: randInt(1, 5) })
          c.anuladoPor = anulador.id
          c.observacion = 'Anulada en pruebas (38_comisiones_prueba_seeder)'
        }

        await c.save()
        creadas++
      }

      console.log(
        `✅ comisiones de prueba creadas: ${creadas} (30 asesor comercial + 30 asesor convenio + 20 comercial+convenio) | ` +
          `estados: ${CANTIDAD_PAGADA} PAGADA / ${CANTIDAD_APROBADA} APROBADA / ${CANTIDAD_PENDIENTE} PENDIENTE / ${CANTIDAD_ANULADA} ANULADA`
      )
      await trx.commit()
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
