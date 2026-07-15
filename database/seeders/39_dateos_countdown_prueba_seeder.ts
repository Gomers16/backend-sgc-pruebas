// database/seeders/39_dateos_countdown_prueba_seeder.ts
//
// 5 dateos de prueba para verificar visualmente el countdown de exclusividad
// (useReservaCountdown.ts) en DateosList.vue y FichaComercialAsesor.vue.
// Placas con prefijo CDX (no usado por ningún otro seeder — 25/38 generan
// placas aleatorias tipo AAA000 o reusan placas reales de turnos_rtms).
// Todos los dateos quedan asignados a un asesor ficticio dedicado
// ("ASESOR PRUEBA COUNTDOWN") para no mezclarse con la data de Diana/Juan/
// Miguel u otros asesores reales que usa 25_captacion_dateos_seeder.ts.
//
// Idempotente: si ya existe un dateo con placa CDX001, no vuelve a insertar.
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import CaptacionDateo from '#models/captacion_dateo'
import AgenteCaptacion from '#models/agente_captacion'
import ConfiguracionReservaDateo from '#models/configuracion_reserva_dateo'
import TurnoRtm from '#models/turno_rtm'

export default class DateosCountdownPruebaSeeder extends BaseSeeder {
  public async run() {
    const trx = await db.transaction()

    try {
      const yaExiste = await CaptacionDateo.query({ client: trx }).where('placa', 'CDX001').first()
      if (yaExiste) {
        console.log('⚠️ Ya existen dateos de prueba del countdown (placa CDX001). Seeder omitido (idempotente).')
        await trx.commit()
        return
      }

      // ===== Horas de exclusividad configuradas ACTUALMENTE (misma tabla que lee el countdown) =====
      const config = await ConfiguracionReservaDateo.query({ client: trx }).first()
      const horas = config?.horasExclusividad ?? 60
      console.log(`ℹ️ horas_exclusividad actual en BD: ${horas}h`)

      // ===== Asesor ficticio dedicado (no choca con Diana/Juan/Miguel de otros seeders) =====
      const asesor = await AgenteCaptacion.firstOrCreate(
        { nombre: 'ASESOR PRUEBA COUNTDOWN' },
        {
          nombre: 'ASESOR PRUEBA COUNTDOWN',
          tipo: 'ASESOR_COMERCIAL',
          usuarioId: null,
          activo: true,
        },
        { client: trx }
      )

      // ===== Turno real libre (sin dateo asignado) para el escenario "consumido" =====
      const turnoLibre = await TurnoRtm.query({ client: trx })
        .whereNull('captacion_dateo_id')
        .orderBy('id', 'asc')
        .first()

      if (!turnoLibre) {
        throw new Error(
          '❌ No hay ningún turno_rtm libre (captacion_dateo_id IS NULL) para el escenario 5 (consumido). Abortando seeder.'
        )
      }

      const ahora = DateTime.now()

      const filas: Partial<CaptacionDateo>[] = [
        {
          // 1) Recién creado → countdown completo (~horas h)
          placa: 'CDX001',
          telefono: '3000000001',
          createdAt: ahora,
          updatedAt: ahora,
          observacion: `Countdown prueba 1/5: recién creado (~${horas}h restantes)`,
        },
        {
          // 2) Vence en ~20 minutos
          placa: 'CDX002',
          telefono: '3000000002',
          createdAt: ahora.minus({ hours: horas }).plus({ minutes: 20 }),
          updatedAt: ahora,
          observacion: 'Countdown prueba 2/5: vence en ~20 min',
        },
        {
          // 3) Vence en ~1 hora
          placa: 'CDX003',
          telefono: '3000000003',
          createdAt: ahora.minus({ hours: horas }).plus({ hours: 1 }),
          updatedAt: ahora,
          observacion: 'Countdown prueba 3/5: vence en ~1h',
        },
        {
          // 4) Ya vencido (bloqueaHasta ya pasó) pero SIN consumir → countdown en 0h 00min
          placa: 'CDX004',
          telefono: '3000000004',
          createdAt: ahora.minus({ hours: horas + 2 }),
          updatedAt: ahora,
          observacion: 'Countdown prueba 4/5: ya vencido, sin consumir (0h 00min)',
        },
        {
          // 5) Ya consumido (tiene turno real) → el countdown ya no aplica, sin importar la fecha
          placa: 'CDX005',
          telefono: '3000000005',
          createdAt: ahora.minus({ hours: 10 }),
          updatedAt: ahora,
          consumidoTurnoId: turnoLibre.id,
          consumidoAt: ahora,
          resultado: 'EXITOSO',
          observacion: `Countdown prueba 5/5: ya consumido (turno #${turnoLibre.id}), countdown no aplica`,
        },
      ]

      let creados = 0
      for (const fila of filas) {
        await CaptacionDateo.create(
          {
            canal: 'ASESOR_COMERCIAL',
            agenteId: asesor.id,
            convenioId: null,
            origen: 'UI',
            resultado: 'PENDIENTE',
            liberado: false,
            ...fila,
          } as any,
          { client: trx }
        )
        creados++
      }

      console.log(
        `✅ Dateos de prueba del countdown creados: ${creados} (asesor: "${asesor.nombre}" #${asesor.id}, turno consumido usado: #${turnoLibre.id} placa ${turnoLibre.placa})`
      )

      await trx.commit()
    } catch (err) {
      await trx.rollback()
      throw err
    }
  }
}
