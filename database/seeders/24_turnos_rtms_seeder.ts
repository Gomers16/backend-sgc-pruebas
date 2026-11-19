// database/seeders/24_turnos_rtms_seeder.ts
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import { sinFiltroDeSede } from '#services/sede_scope'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import TurnoRtm from '#models/turno_rtm'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'
import Vehiculo from '#models/vehiculo'
import Cliente from '#models/cliente'
import AgenteCaptacion from '#models/agente_captacion'
import CaptacionDateo from '#models/captacion_dateo'
import Conductor from '#models/conductor' // 👈 NUEVO: para asociar conductor al turno

type TipoVehiculo = 'Liviano Particular' | 'Liviano Taxi' | 'Liviano Público' | 'Motocicleta'

const SEDE_ID = 2 // Ibagué — CDA del Centro

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}
function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function medioFromCanal(): 'Fachada' | 'Redes Sociales' | 'Call Center' | 'Asesor Comercial' {
  return 'Asesor Comercial'
}
function bloqueoMesesPorServicio(codigo?: string): number {
  const s = (codigo || '').toUpperCase()
  if (s === 'RTM' || s === 'SOAT') return 12
  if (s === 'PREV') return 2
  return 0
}
function normalizePlaca(v?: string | null): string | null {
  if (!v) return null
  return v.replace(/[\s-]/g, '').toUpperCase()
}
function toMySQL(dt: DateTime) {
  return dt.toFormat('yyyy-LL-dd HH:mm:ss')
}

export default class TurnosRtmsSeeder extends BaseSeeder {
  // Multi-sede: sin request no hay sede activa; el seeder declara la suya en
  // cada registro, así que corre sin filtro de sede de forma explícita.
  async run() {
    await sinFiltroDeSede(async () => await this.sembrar())
  }

  private async sembrar() {
    const trx = await db.transaction()
    try {
      const now = DateTime.local().setZone('America/Bogota')

      const usuarios = await Usuario.query({ client: trx }).where('sede_id', SEDE_ID)
      const servicios = await Servicio.query({ client: trx })
      const vehiculos = await Vehiculo.query({ client: trx })
      const clientes = await Cliente.query({ client: trx })
      const agentes = await AgenteCaptacion.query({ client: trx })
      const agentesCom = agentes.filter((a) => a.tipo === 'ASESOR_COMERCIAL')
      const agentesConv = agentes.filter((a) => a.tipo === 'ASESOR_CONVENIO')
      const conductores = await Conductor.query({ client: trx }) // 👈 conductores ya existentes

      if (!usuarios.length || !servicios.length || !vehiculos.length) {
        await trx.commit()
        return
      }

      const servicioRTM = servicios.find(
        (s: any) => String(s.codigoServicio).toUpperCase() === 'RTM'
      )
      const tipos: readonly TipoVehiculo[] = [
        'Liviano Particular',
        'Liviano Taxi',
        'Liviano Público',
        'Motocicleta',
      ] as const

      // Consecutivos cacheados por día/servicio
      const consecGlobal = new Map<string, number>() // key: sede|fecha
      const consecServicio = new Map<string, number>() // key: sede|servicio|fecha

      const dateos = await CaptacionDateo.query({ client: trx })

      const getNextGlobal = async (fechaISO: string): Promise<number> => {
        const key = `${SEDE_ID}|${fechaISO}`
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
        const key = `${SEDE_ID}|${servicioId}|${fechaISO}`
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

      // 👇 Helper para elegir conductor según vehículo (si existe)
      const getConductorIdForVehiculo = (vehiculoId: number): number | null => {
        if (!conductores.length) return null
        const candidatos = conductores.filter(
          (c) => (c as any).vehiculoId === vehiculoId || (c as any).vehiculo_id === vehiculoId
        )
        const lista = candidatos.length ? candidatos : conductores
        const elegido = pick(lista)
        return elegido.id
      }

      // ===== 1) Generación aleatoria de turnos =====
      const TOTAL_TURNOS = 50
      let created = 0

      while (created < TOTAL_TURNOS) {
        const usuario = pick(usuarios)
        const servicio = pick(servicios)
        const codigoServicio: string = (servicio as any).codigoServicio
        const veh = pick(vehiculos)
        const cliente = veh.clienteId
          ? clientes.find((c) => c.id === veh.clienteId) || pick(clientes)
          : pick(clientes)

        const fecha = now.minus({ days: randInt(0, 60) }).startOf('day')
        const fechaISO = fecha.toISODate()!

        // Evitar duplicado (sede+servicio+fecha+placa)
        const dup = await trx
          .from('turnos_rtms')
          .where('sede_id', SEDE_ID)
          .andWhere('servicio_id', servicio.id)
          .andWhere('fecha', fechaISO)
          .andWhere('placa', veh.placa)
          .first()
        if (dup) continue

        // Bloqueo por servicio si hubo FINALIZADO previo
        const lastFinal = await TurnoRtm.query({ client: trx })
          .where('placa', veh.placa)
          .andWhere('servicio_id', servicio.id)
          .andWhere('estado', 'finalizado')
          .orderBy('fecha', 'desc')
          .first()
        if (lastFinal) {
          const meses = bloqueoMesesPorServicio(codigoServicio)
          if (meses > 0) {
            const nextAllowed = lastFinal.fecha.plus({ months: meses }).startOf('day')
            if (fecha < nextAllowed) continue
          }
        }

        // Atribución
        let agenteCaptacionId: number | null = null
        if (Math.random() < 0.7 && agentesCom.length) agenteCaptacionId = pick(agentesCom).id
        else if (agentesConv.length) agenteCaptacionId = pick(agentesConv).id

        // Dateo coincidente
        let captacionDateoId: number | null = null
        if (dateos.length) {
          const candidatos = dateos.filter(
            (d) =>
              (d.placa && normalizePlaca(d.placa) === veh.placa) ||
              (cliente?.telefono && d.telefono === cliente.telefono)
          )
          if (candidatos.length) {
            const d = pick(candidatos)
            captacionDateoId = d.id
            if (!agenteCaptacionId) agenteCaptacionId = (d as any).agenteId ?? null
          }
        }

        const turnoNumero = await getNextGlobal(fechaISO)
        const turnoNumeroServicio = await getNextServicio(servicio.id, fechaISO)

        const finaliza = Math.random() < 0.65
        let estado: 'finalizado' | 'activo' | 'cancelado'
        if (finaliza) estado = 'finalizado'
        else estado = Math.random() < 0.5 ? 'activo' : 'cancelado'

        const horaIngreso = `${String(randInt(7, 17)).padStart(2, '0')}:${String(
          randInt(0, 59)
        ).padStart(2, '0')}`

        const conductorId = getConductorIdForVehiculo(veh.id) // 👈 asignar conductor (si hay)

        const turno = await TurnoRtm.create(
          {
            sedeId: SEDE_ID,
            funcionarioId: usuario.id,
            servicioId: servicio.id,
            fecha,
            horaIngreso,
            horaSalida: finaliza ? '17:00:00' : null,
            tiempoServicio: finaliza ? `${randInt(12, 80)} min` : null,
            turnoNumero,
            turnoNumeroServicio,
            turnoCodigo: `${(servicio as any).codigoServicio}-${fecha.toFormat('yyyyMMdd')}-${String(
              turnoNumero
            ).padStart(3, '0')}`,
            placa: veh.placa,
            tipoVehiculo: pick(tipos),
            medioEntero: medioFromCanal(),
            observaciones: Math.random() < 0.25 ? 'Observación demo' : null,
            canalAtribucion: 'ASESOR',
            estado,
            vehiculoId: veh.id,
            clienteId: cliente?.id ?? null,
            claseVehiculoId: (veh as any).claseVehiculoId ?? null,
            agenteCaptacionId,
            captacionDateoId,
            conductorId, // 👈 NUEVO: se guarda el conductor en el turno
          } as any,
          { client: trx }
        )

        if (captacionDateoId) {
          await CaptacionDateo.query({ client: trx })
            .where('id', captacionDateoId)
            .update({
              consumido_turno_id: turno.id,
              consumido_at: toMySQL(DateTime.local().setZone('America/Bogota')),
            } as any)
        }

        created++
      }

      // ===== 2) GARANTÍA: al menos 1 visita por vehículo =====
      const usuarioDefault = usuarios[0]
      const servicioGarantizado = servicioRTM ?? servicios[0]

      for (const veh of vehiculos) {
        const existe = await TurnoRtm.query({ client: trx }).where('vehiculo_id', veh.id).first()
        if (existe) continue

        // visita garantizada hace entre 15 y 90 días
        const fecha = now.minus({ days: randInt(15, 90) }).startOf('day')
        const fechaISO = fecha.toISODate()!
        const turnoNumero = await getNextGlobal(fechaISO)
        const turnoNumeroServicio = await getNextServicio(servicioGarantizado.id, fechaISO)

        const cliente = veh.clienteId ? clientes.find((c) => c.id === veh.clienteId) || null : null
        const conductorId = getConductorIdForVehiculo(veh.id) // 👈 también para la visita garantizada

        await TurnoRtm.create(
          {
            sedeId: SEDE_ID,
            funcionarioId: usuarioDefault.id,
            servicioId: servicioGarantizado.id,
            fecha,
            horaIngreso: '08:15:00',
            horaSalida: '09:05:00',
            tiempoServicio: '50 min',
            turnoNumero,
            turnoNumeroServicio,
            turnoCodigo: `${(servicioGarantizado as any).codigoServicio}-${fecha.toFormat(
              'yyyyMMdd'
            )}-${String(turnoNumero).padStart(3, '0')}`,
            placa: veh.placa,
            tipoVehiculo: 'Liviano Particular',
            medioEntero: 'Asesor Comercial',
            observaciones: 'Visita garantizada por seeder',
            canalAtribucion: 'ASESOR',
            estado: 'finalizado',
            vehiculoId: veh.id,
            clienteId: cliente?.id ?? null,
            claseVehiculoId: (veh as any).claseVehiculoId ?? null,
            agenteCaptacionId: null,
            captacionDateoId: null,
            conductorId, // 👈 NUEVO
          } as any,
          { client: trx }
        )
      }

      await trx.commit()
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
