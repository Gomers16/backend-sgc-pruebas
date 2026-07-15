// database/seeders/40_test_rtm_vigente_excepcion_seeder.ts
//
// Script puntual (solo entorno de PRUEBAS) para validar el flujo de excepción
// RTM_VIGENTE_EXCEPCION_DISPONIBLE implementado en captacion_dateos_controller.ts.
//
// Crea un turno RTM finalizado para la placa TST999 cuya fecha se calcula
// dinámicamente (misma fórmula que usa el controller) para que HOY caiga
// justo dentro de la ventana de bloqueo (DIAS_VENTANA_PRE_RTM, default 10
// días), con un excedente de ~5 días — suficiente para disparar el bloqueo
// tanto para usuarios normales (RTM_VIGENTE) como para SUPER_ADMIN/GERENCIA
// (RTM_VIGENTE_EXCEPCION_DISPONIBLE).
//
// Idempotente: si ya existe un turno finalizado de RTM para TST999, no
// vuelve a insertar.
//
// Ejecutar solo este seeder:
//   node ace db:seed --files database/seeders/40_test_rtm_vigente_excepcion_seeder.ts
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import TurnoRtm from '#models/turno_rtm'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'

const PLACA_PRUEBA = 'TST999' // 3 letras + 3 dígitos: formato válido del formulario
const SEDE_ID = 2
const EXCESO_DIAS_DESEADO = 5 // cuánto queremos que exceda la ventana permitida

export default class TestRtmVigenteExcepcionSeeder extends BaseSeeder {
  public async run() {
    const trx = await db.transaction()

    try {
      const yaExiste = await TurnoRtm.query({ client: trx })
        .where('placa', PLACA_PRUEBA)
        .andWhere('estado', 'finalizado')
        .first()

      if (yaExiste) {
        console.log(
          `⚠️ Ya existe un turno finalizado para placa ${PLACA_PRUEBA} (id ${yaExiste.id}, fecha ${yaExiste.fecha?.toISODate?.()}). Seeder omitido (idempotente).`
        )
        await trx.commit()
        return
      }

      const dateoActivo = await db
        .from('captacion_dateos')
        .where('placa', PLACA_PRUEBA)
        .andWhere('liberado', false)
        .first()

      if (dateoActivo) {
        throw new Error(
          `❌ La placa ${PLACA_PRUEBA} ya tiene un dateo activo/sin liberar (id ${dateoActivo.id}). Libéralo o usa otra placa antes de correr este seeder.`
        )
      }

      const servicioRTM = await Servicio.query({ client: trx })
        .where('codigo_servicio', 'RTM')
        .first()
      if (!servicioRTM) throw new Error('❌ No existe el servicio RTM en la tabla servicios.')

      const usuario = await Usuario.query({ client: trx }).orderBy('id', 'asc').first()
      if (!usuario) throw new Error('❌ No hay usuarios en la BD para asignar como funcionario.')

      // ===== Misma fórmula que usa captacion_dateos_controller.ts (VALIDACIÓN 2) =====
      const diasVentanaPreRtm = Number(process.env.DIAS_VENTANA_PRE_RTM ?? 10)
      const hoy = DateTime.local().setZone('America/Bogota').startOf('day')
      const caducaEl = hoy.plus({ days: diasVentanaPreRtm + EXCESO_DIAS_DESEADO })
      const fechaTurno = caducaEl.minus({ months: 12 })
      const ventanaPrevia = caducaEl.minus({ days: diasVentanaPreRtm })
      const diasExcedidos = Math.ceil(ventanaPrevia.diff(hoy, 'days').days)

      const fechaISO = fechaTurno.toISODate()!

      const row = await trx.from('turnos_rtms').where('sede_id', SEDE_ID).andWhere('fecha', fechaISO).max('turno_numero as max').first()
      const turnoNumero = Number(row?.max ?? 0) + 1

      const rowServ = await trx
        .from('turnos_rtms')
        .where('sede_id', SEDE_ID)
        .andWhere('servicio_id', servicioRTM.id)
        .andWhere('fecha', fechaISO)
        .max('turno_numero_servicio as max')
        .first()
      const turnoNumeroServicio = Number(rowServ?.max ?? 0) + 1

      const turno = await TurnoRtm.create(
        {
          sedeId: SEDE_ID,
          funcionarioId: usuario.id,
          servicioId: servicioRTM.id,
          fecha: fechaTurno,
          horaIngreso: '08:15:00',
          horaSalida: '09:05:00',
          tiempoServicio: '50 min',
          turnoNumero,
          turnoNumeroServicio,
          turnoCodigo: `RTM-${fechaTurno.toFormat('yyyyMMdd')}-${String(turnoNumero).padStart(3, '0')}`,
          placa: PLACA_PRUEBA,
          tipoVehiculo: 'Liviano Particular',
          medioEntero: 'Asesor Comercial',
          observaciones: 'Turno de prueba — seeder 40 (excepción RTM_VIGENTE)',
          canalAtribucion: 'ASESOR',
          estado: 'finalizado',
        } as any,
        { client: trx }
      )

      await trx.commit()

      console.log(`✅ Turno RTM finalizado creado para placa ${PLACA_PRUEBA} (id ${turno.id})`)
      console.log(`   fecha turno (finalizado): ${fechaISO}`)
      console.log(`   hoy: ${hoy.toISODate()}`)
      console.log(`   vence RTM (caducaEl): ${caducaEl.toISODate()}`)
      console.log(`   puede datear desde (ventanaPrevia): ${ventanaPrevia.toISODate()}`)
      console.log(`   días excedidos esperados hoy: ${diasExcedidos}`)
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
