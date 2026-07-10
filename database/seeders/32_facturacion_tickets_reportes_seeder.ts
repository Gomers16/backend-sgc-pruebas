// database/seeders/32_facturacion_tickets_reportes_seeder.ts
//
// Genera facturación realista de RTM para junio 2026 (sede única Ibagué, sede_id = 1)
// para poder construir los reportes de "ingresos por canal de captación".
// Crea turnos_rtms sintéticos (no hay suficientes turnos reales) + su facturacion_tickets.
// Solo INSERTA — no borra ni modifica datos existentes.
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import TurnoRtm from '#models/turno_rtm'
import FacturacionTicket from '#models/facturacion_ticket'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'
import Vehiculo from '#models/vehiculo'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'

const SEDE_ID = 1
const SEDE_NOMBRE = 'Ibagué'
const SERVICIO_CODIGO = 'RTM'
const SERVICIO_NOMBRE = 'Revisión Técnico Mecánica'

// Valores RTM Colombia 2026 (tarifa al cliente, según resolución 2026)
const VALORES_VEHICULO = [338520, 338820, 339220, 338820]
const VALORES_MOTO = [228130, 228430, 228730, 228430]
// IVA fijo por tipo (resolución 2026); subtotal = total - iva
const IVA_VEHICULO = 44400
const IVA_MOTO = 26854

type CanalCaptacion =
  | 'FACHADA'
  | 'ASESOR_CONVENIO'
  | 'ASESOR_COMERCIAL'
  | 'TELEMERCADEO'
  | 'REDES'
type TipoVehiculoTicket = 'VEHICULO' | 'MOTO'
// ⚠️ El enum real de `facturacion_tickets.forma_pago` es
//    ('EFECTIVO','TARJETA','TRANSFERENCIA','MIXTO') — NO existe 'CONSIGNACION'.
//    Se usa 'TRANSFERENCIA' como equivalente para los pagos por consignación.
type FormaPagoTicket = 'EFECTIVO' | 'TARJETA' | 'TRANSFERENCIA'

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}
function pick<T>(arr: readonly T[]): T {
  return arr[randInt(0, arr.length - 1)]
}
function round2(n: number): number {
  return Math.round(n * 100) / 100
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
 * Reparte `total` elementos en etiquetas según pesos (porcentajes),
 * exacto, usando el método de mayor residuo (sin perder ni sobrar filas
 * por redondeo), y devuelve el pool ya mezclado aleatoriamente.
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

// Volumen objetivo por día de semana (luxon: 1=lunes ... 6=sábado, 7=domingo excluido)
// Más turnos martes-viernes, menos lunes/sábado. Promedio resultante ≈ 42/día.
const VOLUMEN_POR_DIA_SEMANA: Record<number, number> = {
  1: 35, // lunes
  2: 48, // martes
  3: 48, // miércoles
  4: 48, // jueves
  5: 45, // viernes
  6: 28, // sábado
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

export default class FacturacionTicketsReportesSeeder extends BaseSeeder {
  public async run() {
    const trx = await db.transaction()
    try {
      const servicios = await Servicio.query({ client: trx })
      const servicioRtm = servicios.find(
        (s: any) => String(s.codigoServicio).toUpperCase() === SERVICIO_CODIGO
      )
      if (!servicioRtm) {
        console.warn('⚠️ No existe servicio con codigo_servicio = RTM. Abortando seeder.')
        await trx.commit()
        return
      }

      const funcionarios = await Usuario.query({ client: trx })
        .where('sede_id', SEDE_ID)
        .andWhere('estado', 'activo')
      const vehiculos = await Vehiculo.query({ client: trx })
      const agentesComercial = await AgenteCaptacion.query({ client: trx })
        .where('tipo', 'ASESOR_COMERCIAL')
        .andWhere('activo', true)
      const agentesConvenio = await AgenteCaptacion.query({ client: trx })
        .where('tipo', 'ASESOR_CONVENIO')
        .andWhere('activo', true)
      const conveniosActivos = await Convenio.query({ client: trx }).where('activo', true)

      if (
        !funcionarios.length ||
        !vehiculos.length ||
        !agentesComercial.length ||
        !agentesConvenio.length ||
        !conveniosActivos.length
      ) {
        console.warn(
          '⚠️ Faltan datos base (funcionarios de sede 1 / vehículos / agentes / convenios). Abortando seeder.'
        )
        await trx.commit()
        return
      }

      // Convenio "natural" de cada asesor de convenio (cuando el convenio ya lo tiene asignado)
      const convenioPorAsesorConvenio = new Map<number, (typeof conveniosActivos)[number]>()
      for (const c of conveniosActivos) {
        if (c.asesorConvenioId && !convenioPorAsesorConvenio.has(c.asesorConvenioId)) {
          convenioPorAsesorConvenio.set(c.asesorConvenioId, c)
        }
      }

      const dias = diasHabilesJunio2026()
      const totalFilas = dias.reduce((sum, d) => sum + (VOLUMEN_POR_DIA_SEMANA[d.weekday] ?? 0), 0)

      // Pools exactos según las distribuciones de negocio (independientes entre sí)
      const poolCanal = buildWeightedPool<CanalCaptacion>(totalFilas, {
        FACHADA: 0.4,
        ASESOR_CONVENIO: 0.25,
        ASESOR_COMERCIAL: 0.2,
        TELEMERCADEO: 0.1,
        REDES: 0.05,
      })
      const poolVehiculo = buildWeightedPool<TipoVehiculoTicket>(totalFilas, {
        VEHICULO: 0.7,
        MOTO: 0.3,
      })
      const poolPago = buildWeightedPool<FormaPagoTicket>(totalFilas, {
        EFECTIVO: 0.7,
        TARJETA: 0.2,
        TRANSFERENCIA: 0.1,
      })
      // Dentro de ASESOR_COMERCIAL: 50% trae convenio, 50% es directo
      const totalComercial = poolCanal.filter((c) => c === 'ASESOR_COMERCIAL').length
      const poolConvenioComercial = buildWeightedPool<'CON_CONVENIO' | 'DIRECTO'>(totalComercial, {
        CON_CONVENIO: 0.5,
        DIRECTO: 0.5,
      })

      const placasUsadas = new Set<string>()
      const consecGlobal = new Map<string, number>()
      const consecServicio = new Map<string, number>()

      const getNextGlobal = async (fechaISO: string): Promise<number> => {
        if (!consecGlobal.has(fechaISO)) {
          const row = await trx
            .from('turnos_rtms')
            .where('sede_id', SEDE_ID)
            .andWhere('fecha', fechaISO)
            .max('turno_numero as max')
            .first()
          consecGlobal.set(fechaISO, Number(row?.max ?? 0))
        }
        const next = (consecGlobal.get(fechaISO) || 0) + 1
        consecGlobal.set(fechaISO, next)
        return next
      }
      const getNextServicio = async (fechaISO: string): Promise<number> => {
        if (!consecServicio.has(fechaISO)) {
          const row = await trx
            .from('turnos_rtms')
            .where('sede_id', SEDE_ID)
            .andWhere('servicio_id', servicioRtm.id)
            .andWhere('fecha', fechaISO)
            .max('turno_numero_servicio as max')
            .first()
          consecServicio.set(fechaISO, Number(row?.max ?? 0))
        }
        const next = (consecServicio.get(fechaISO) || 0) + 1
        consecServicio.set(fechaISO, next)
        return next
      }

      let cursorCanal = 0
      let cursorVehiculo = 0
      let cursorPago = 0
      let cursorConvenioComercial = 0
      let creados = 0

      for (const dia of dias) {
        const fechaISO = dia.toISODate()!
        const cuota = VOLUMEN_POR_DIA_SEMANA[dia.weekday] ?? 0

        for (let i = 0; i < cuota; i++) {
          const canal = poolCanal[cursorCanal++]
          const tipoVehiculoTicket = poolVehiculo[cursorVehiculo++]
          const formaPago = poolPago[cursorPago++]

          const total =
            tipoVehiculoTicket === 'VEHICULO'
              ? VALORES_VEHICULO[i % VALORES_VEHICULO.length]
              : VALORES_MOTO[i % VALORES_MOTO.length]
          const iva = tipoVehiculoTicket === 'VEHICULO' ? IVA_VEHICULO : IVA_MOTO
          const subtotal = round2(total - iva)

          let agenteId: number | null = null
          let agenteComercialNombre: string | null = null
          let asesorConvenioNombre: string | null = null
          let convenioId: number | null = null
          let convenioNombre: string | null = null

          if (canal === 'ASESOR_COMERCIAL') {
            const ag = pick(agentesComercial)
            agenteId = ag.id
            agenteComercialNombre = ag.nombre
            const conConvenio = poolConvenioComercial[cursorConvenioComercial++] === 'CON_CONVENIO'
            if (conConvenio) {
              const conv = pick(conveniosActivos)
              convenioId = conv.id
              convenioNombre = conv.nombre
            }
          } else if (canal === 'ASESOR_CONVENIO') {
            const ag = pick(agentesConvenio)
            agenteId = ag.id
            asesorConvenioNombre = ag.nombre
            const conv = convenioPorAsesorConvenio.get(ag.id) ?? pick(conveniosActivos)
            convenioId = conv.id
            convenioNombre = conv.nombre
          }

          const tipoVehiculoTurno =
            tipoVehiculoTicket === 'MOTO'
              ? 'Motocicleta'
              : pick(['Liviano Particular', 'Liviano Taxi', 'Liviano Público'] as const)

          const medioEnteroTurno =
            canal === 'FACHADA'
              ? 'Fachada'
              : canal === 'TELEMERCADEO'
                ? 'Call Center'
                : canal === 'REDES'
                  ? 'Redes Sociales'
                  : canal === 'ASESOR_COMERCIAL'
                    ? 'Asesor Comercial'
                    : 'Convenio o Referido Externo'

          const canalAtribucionTurno =
            canal === 'FACHADA'
              ? 'FACHADA'
              : canal === 'TELEMERCADEO'
                ? 'TELE'
                : canal === 'REDES'
                  ? 'REDES'
                  : 'ASESOR'

          const dateoCanalTurno = canal === 'TELEMERCADEO' ? 'TELE' : canal

          const funcionario = pick(funcionarios)
          const vehiculo = pick(vehiculos)
          const placa = placaAleatoria(placasUsadas)

          const horaIngresoH = randInt(7, 17)
          const horaIngresoM = randInt(0, 59)
          const horaIngreso = `${String(horaIngresoH).padStart(2, '0')}:${String(
            horaIngresoM
          ).padStart(2, '0')}:00`
          const minutosServicio = randInt(15, 70)
          const horaSalidaDt = dia
            .set({ hour: horaIngresoH, minute: horaIngresoM })
            .plus({ minutes: minutosServicio })
          const horaSalida = horaSalidaDt.toFormat('HH:mm:ss')

          const turnoNumero = await getNextGlobal(fechaISO)
          const turnoNumeroServicio = await getNextServicio(fechaISO)
          const turnoCodigo = `RTM-${dia.toFormat('yyyyLLdd')}-${String(turnoNumero).padStart(4, '0')}`

          const turno = await TurnoRtm.create(
            {
              sedeId: SEDE_ID,
              funcionarioId: funcionario.id,
              servicioId: servicioRtm.id,
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
              medioEntero: medioEnteroTurno as any,
              dateoCanal: dateoCanalTurno as any,
              canalAtribucion: canalAtribucionTurno as any,
              estado: 'finalizado',
              vehiculoId: vehiculo.id,
            } as any,
            { client: trx }
          )

          const creadoAt = dia.set({ hour: horaIngresoH, minute: horaIngresoM })

          let pagoEfectivo = 0
          let pagoTarjeta = 0
          let pagoConsignacion = 0
          if (formaPago === 'EFECTIVO') pagoEfectivo = total
          else if (formaPago === 'TARJETA') pagoTarjeta = total
          else pagoConsignacion = total

          await FacturacionTicket.create(
            {
              hash: `seed-${turnoCodigo}-${randInt(100000, 999999)}`,
              filePath: `/seed/facturas/2026-06/${turnoCodigo}.jpg`,
              estado: 'CONFIRMADA',
              placa,
              total,
              totalFactura: total,
              subtotal,
              iva,
              totalSinDescuento: total,
              descuentoMontoAplicado: 0,
              fechaPago: creadoAt,
              pagoEfectivo,
              pagoTarjeta,
              pagoConsignacion,
              formaPago,
              agenteId,
              sedeId: SEDE_ID,
              turnoId: turno.id,
              dateoId: null,
              servicioId: servicioRtm.id,
              turnoNumeroGlobal: turnoNumero,
              turnoNumeroServicio,
              turnoCodigo,
              tipoVehiculoSnapshot: tipoVehiculoTurno,
              placaTurno: placa,
              servicioCodigo: SERVICIO_CODIGO,
              servicioNombre: SERVICIO_NOMBRE,
              sedeNombre: SEDE_NOMBRE,
              funcionarioNombre: `${funcionario.nombres} ${funcionario.apellidos}`,
              canalAtribucion: canal,
              medioEntero: medioEnteroTurno,
              captacionCanal: canal,
              agenteComercialNombre,
              asesorConvenioNombre,
              convenioNombre,
              clienteId: null, // ⚠️ tabla `clientes` está vacía en este entorno de pruebas
              vehiculoId: vehiculo.id,
              confirmadoAt: creadoAt,
              createdAt: creadoAt,
              updatedAt: creadoAt,
            } as any,
            { client: trx }
          )

          // convenioId no se persiste como columna propia en facturacion_tickets
          // (la tabla solo guarda el snapshot convenio_nombre); se referencia aquí
          // únicamente para dejar trazabilidad en consola si se necesita depurar.
          void convenioId

          creados++
        }
      }

      console.log(`✅ facturacion_tickets + turnos_rtms (RTM junio 2026) creados: ${creados}`)
      await trx.commit()
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
