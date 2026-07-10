// database/seeders/37_turnos_servicios_prueba_seeder.ts
//
// Genera turnos_rtms + facturacion_tickets (CONFIRMADA) de prueba para
// SOAT, PREV y PERI en junio 2026, sede_id = 1 (Ibagué), para que el
// reporte /reportes-admin/servicios tenga datos reales de esos 3 servicios
// (hasta ahora solo existía volumen real de RTM).
// Solo INSERTA — no borra ni modifica datos existentes. Es idempotente:
// si ya hay tickets CONFIRMADA para estos servicios, no vuelve a insertar.
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import TurnoRtm from '#models/turno_rtm'
import FacturacionTicket from '#models/facturacion_ticket'
import Usuario from '#models/usuario'
import Cargo from '#models/cargo'
import Servicio from '#models/servicio'
import AgenteCaptacion from '#models/agente_captacion'
import TarifaServicio from '#models/tarifa_servicio'

const SEDE_ID = 1
const SEDE_NOMBRE = 'Ibagué'

type TipoVehiculoTicket = 'MOTO' | 'VEHICULO'
type CanalCaptacion = 'FACHADA' | 'ASESOR_COMERCIAL'

// codigo_servicio -> { MOTO: cantidad, VEHICULO: cantidad }
const DISTRIBUCION: Record<string, { MOTO: number; VEHICULO: number }> = {
  SOAT: { MOTO: 5, VEHICULO: 5 },
  PREV: { MOTO: 6, VEHICULO: 6 },
  PERI: { MOTO: 4, VEHICULO: 4 },
}

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
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

const PLACA_LETRAS = 'ABCDEFGHJKLMNPRSTUVWXYZ' // sin O/Q/I
function placaAleatoria(seen: Set<string>): string {
  let p = ''
  do {
    const L = () => PLACA_LETRAS[randInt(0, PLACA_LETRAS.length - 1)]
    p = `${L()}${L()}${L()}${randInt(100, 999)}`
  } while (seen.has(p))
  seen.add(p)
  return p
}

function diasHabilesJunio2026(): DateTime[] {
  const dias: DateTime[] = []
  let d = DateTime.fromISO('2026-06-01')
  while (d.month === 6) {
    if (d.weekday !== 7) dias.push(d) // sin domingos
    d = d.plus({ days: 1 })
  }
  return dias
}

export default class TurnosServiciosPruebaSeeder extends BaseSeeder {
  public async run() {
    const trx = await db.transaction()
    try {
      const yaExisten = await trx
        .from('facturacion_tickets')
        .whereIn('servicio_codigo', ['SOAT', 'PREV', 'PERI'])
        .andWhere('estado', 'CONFIRMADA')
        .count('* as c')
        .first()
      if (Number(yaExisten?.c) > 0) {
        console.log(
          '⚠️ Ya existen facturacion_tickets CONFIRMADA para SOAT/PREV/PERI. Seeder omitido (idempotente).'
        )
        await trx.commit()
        return
      }

      const servicios = await Servicio.query({ client: trx }).whereIn('codigo_servicio', [
        'SOAT',
        'PREV',
        'PERI',
      ])
      const servicioPorCodigo = new Map(servicios.map((s) => [s.codigoServicio, s]))
      for (const codigo of Object.keys(DISTRIBUCION)) {
        if (!servicioPorCodigo.has(codigo)) {
          throw new Error(`❌ No existe servicio con codigo_servicio = ${codigo}`)
        }
      }

      const cargosInspector = await Cargo.query({ client: trx }).where(
        'nombre',
        'like',
        '%INSPECTOR%'
      )
      const funcionarios = await Usuario.query({ client: trx })
        .whereIn(
          'cargo_id',
          cargosInspector.map((c) => c.id)
        )
        .andWhere('sede_id', SEDE_ID)
        .andWhere('estado', 'activo')
      if (!funcionarios.length) {
        throw new Error('❌ No hay usuarios INSPECTOR activos en sede_id=1. Abortando seeder.')
      }

      const agentesComercial = await AgenteCaptacion.query({ client: trx })
        .where('tipo', 'ASESOR_COMERCIAL')
        .andWhere('activo', true)
      if (!agentesComercial.length) {
        throw new Error('❌ No hay agentes ASESOR_COMERCIAL activos. Abortando seeder.')
      }

      // Tarifas vigentes por servicio + tipo de vehículo
      const tarifas = new Map<string, TarifaServicio>()
      for (const codigo of Object.keys(DISTRIBUCION)) {
        const servicio = servicioPorCodigo.get(codigo)!
        for (const tipo of ['MOTO', 'VEHICULO'] as TipoVehiculoTicket[]) {
          const tarifa = await TarifaServicio.findByServicioYTipo(servicio.id, tipo)
          if (!tarifa) {
            throw new Error(`❌ Falta tarifa activa para ${codigo}/${tipo}. Abortando seeder.`)
          }
          tarifas.set(`${codigo}|${tipo}`, tarifa)
        }
      }

      // ===== Armar los 30 "trabajos" (servicio + tipo_vehiculo) =====
      type Trabajo = { codigoServicio: string; tipoVehiculo: TipoVehiculoTicket }
      const trabajos: Trabajo[] = []
      for (const [codigoServicio, cantidades] of Object.entries(DISTRIBUCION)) {
        for (let i = 0; i < cantidades.MOTO; i++) trabajos.push({ codigoServicio, tipoVehiculo: 'MOTO' })
        for (let i = 0; i < cantidades.VEHICULO; i++)
          trabajos.push({ codigoServicio, tipoVehiculo: 'VEHICULO' })
      }
      const trabajosMezclados = shuffle(trabajos)

      // Canal: 60% FACHADA / 40% ASESOR_COMERCIAL, repartido exacto sobre el total
      const totalTrabajos = trabajosMezclados.length
      const cantidadFachada = Math.round(totalTrabajos * 0.6)
      const pool: CanalCaptacion[] = [
        ...Array(cantidadFachada).fill('FACHADA' as const),
        ...Array(totalTrabajos - cantidadFachada).fill('ASESOR_COMERCIAL' as const),
      ]
      const poolCanal = shuffle(pool)

      const diasHabiles = diasHabilesJunio2026()

      const consecGlobal = new Map<string, number>() // sede|fecha
      const consecServicio = new Map<string, number>() // servicio|fecha

      const getNextGlobal = async (fechaISO: string): Promise<number> => {
        const key = fechaISO
        if (!consecGlobal.has(key)) {
          const row = await trx
            .from('turnos_rtms')
            .where('sede_id', SEDE_ID)
            .andWhere('fecha', fechaISO)
            .max('turno_numero as max')
            .first()
          consecGlobal.set(key, Number(row?.max ?? 0))
        }
        const next = (consecGlobal.get(key) || 0) + 1
        consecGlobal.set(key, next)
        return next
      }
      const getNextServicio = async (servicioId: number, fechaISO: string): Promise<number> => {
        const key = `${servicioId}|${fechaISO}`
        if (!consecServicio.has(key)) {
          const row = await trx
            .from('turnos_rtms')
            .where('sede_id', SEDE_ID)
            .andWhere('servicio_id', servicioId)
            .andWhere('fecha', fechaISO)
            .max('turno_numero_servicio as max')
            .first()
          consecServicio.set(key, Number(row?.max ?? 0))
        }
        const next = (consecServicio.get(key) || 0) + 1
        consecServicio.set(key, next)
        return next
      }

      const placasUsadas = new Set<string>()
      let creados = 0

      for (let i = 0; i < trabajosMezclados.length; i++) {
        const { codigoServicio, tipoVehiculo } = trabajosMezclados[i]
        const canal = poolCanal[i]
        const servicio = servicioPorCodigo.get(codigoServicio)!
        const tarifa = tarifas.get(`${codigoServicio}|${tipoVehiculo}`)!

        const dia = pick(diasHabiles)
        const fechaISO = dia.toISODate()!

        const tipoVehiculoTurno =
          tipoVehiculo === 'MOTO'
            ? 'Motocicleta'
            : pick(['Liviano Particular', 'Liviano Taxi', 'Liviano Público'] as const)

        const funcionario = pick(funcionarios)
        const placa = placaAleatoria(placasUsadas)

        const horaIngresoH = randInt(7, 17)
        const horaIngresoM = randInt(0, 59)
        const horaIngreso = `${String(horaIngresoH).padStart(2, '0')}:${String(
          horaIngresoM
        ).padStart(2, '0')}:00`
        const minutosServicio = randInt(15, 60)
        const horaSalidaDt = dia
          .set({ hour: horaIngresoH, minute: horaIngresoM })
          .plus({ minutes: minutosServicio })
        const horaSalida = horaSalidaDt.toFormat('HH:mm:ss')

        const turnoNumero = await getNextGlobal(fechaISO)
        const turnoNumeroServicio = await getNextServicio(servicio.id, fechaISO)
        const turnoCodigo = `${codigoServicio}-${dia.toFormat('yyyyLLdd')}-${String(
          turnoNumero
        ).padStart(4, '0')}`

        const turno = await TurnoRtm.create(
          {
            sedeId: SEDE_ID,
            funcionarioId: funcionario.id,
            servicioId: servicio.id,
            fecha: dia,
            horaIngreso,
            horaSalida,
            tiempoServicio: `${minutosServicio} min`,
            tieneFacturacion: true,
            horaFacturacion: horaSalida,
            turnoNumero,
            turnoNumeroServicio,
            turnoCodigo,
            placa,
            tipoVehiculo: tipoVehiculoTurno as any,
            medioEntero: (canal === 'FACHADA' ? 'Fachada' : 'Asesor Comercial') as any,
            canalAtribucion: (canal === 'FACHADA' ? 'FACHADA' : 'ASESOR') as any,
            estado: 'finalizado',
          } as any,
          { client: trx }
        )

        const creadoAt = dia.set({ hour: horaIngresoH, minute: horaIngresoM })

        let agenteId: number | null = null
        let agenteComercialNombre: string | null = null
        if (canal === 'ASESOR_COMERCIAL') {
          const ag = pick(agentesComercial)
          agenteId = ag.id
          agenteComercialNombre = ag.nombre
        }

        await FacturacionTicket.create(
          {
            hash: `seed-${turnoCodigo}-${randInt(100000, 999999)}`,
            filePath: `/seed/facturas/2026-06/${turnoCodigo}.jpg`,
            estado: 'CONFIRMADA',
            placa,
            total: tarifa.valorTotal,
            totalFactura: tarifa.valorTotal,
            subtotal: tarifa.valorBase,
            totalSinDescuento: tarifa.valorTotal,
            pagoEfectivo: tarifa.valorTotal,
            formaPago: 'EFECTIVO',
            agenteId,
            sedeId: SEDE_ID,
            turnoId: turno.id,
            servicioId: servicio.id,
            turnoNumeroGlobal: turnoNumero,
            turnoNumeroServicio,
            turnoCodigo,
            tipoVehiculoSnapshot: tipoVehiculoTurno,
            placaTurno: placa,
            servicioCodigo: codigoServicio,
            servicioNombre: servicio.nombreServicio,
            sedeNombre: SEDE_NOMBRE,
            funcionarioNombre: `${funcionario.nombres} ${funcionario.apellidos}`,
            canalAtribucion: canal === 'FACHADA' ? 'FACHADA' : 'ASESOR',
            medioEntero: canal === 'FACHADA' ? 'Fachada' : 'Asesor Comercial',
            captacionCanal: canal,
            agenteComercialNombre,
            confirmadoAt: creadoAt,
            createdAt: creadoAt,
            updatedAt: creadoAt,
          } as any,
          { client: trx }
        )

        creados++
      }

      console.log(`✅ turnos_rtms + facturacion_tickets (SOAT/PREV/PERI junio 2026) creados: ${creados}`)
      await trx.commit()
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
