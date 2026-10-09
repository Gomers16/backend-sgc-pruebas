// app/controllers/turnos_rtms_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import ExcelJS from 'exceljs'
import Database from '@adonisjs/lucid/services/db'

import TurnoRtm, { type CanalAtribucion, type MedioEntero } from '#models/turno_rtm'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'
import Vehiculo from '#models/vehiculo'
import Cliente from '#models/cliente'
import Conductor from '#models/conductor'
import CaptacionDateo from '#models/captacion_dateo'
import FacturacionTicket from '#models/facturacion_ticket'
import AgenteCaptacion from '#models/agente_captacion'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import {
  buildReserva,
  cerrarDateosViejosPorPlacaTelefono,
  dateoAplicaAServicio,
  marcarDateoExitosoAlFinalizarNoRtm,
} from '#services/reserva_dateo_service'
import { evaluarContinuidad } from '#services/continuidad_service'
import {
  computeEtapasTurno,
  getEtapasRequeridas,
  type EstadoVisualTurno,
  type EtapaKey,
} from '#services/turno_etapas_service'
import {
  aplicaSegundaVez,
  conflictoFinalizarSinCertificacion,
  conflictoOrigenConHijoActivo,
  conflictoTurnoSegundaVez,
  evaluarVentanaSegundaVez,
  esTurnoSegundaVez,
  excluirSegundaVez,
  hijoActivoDeOrigen,
  otroHijoActivo,
  serializarVentana,
  whereTurnoDaVigencia,
} from '#services/segunda_vez_service'
import { hoyServidorISO, validarFechaTurno } from '#services/fecha_turno_service'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'

// ===== Helpers =====
const toMySQL = (dt: DateTime) => dt.toFormat('yyyy-LL-dd HH:mm:ss')
const toMySQLDate = (dt: DateTime) => dt.toFormat('yyyy-LL-dd')

type TipoVehiculoDB = 'Liviano Particular' | 'Liviano Taxi' | 'Liviano Público' | 'Motocicleta'
const VALID_TIPOS_VEHICULO: TipoVehiculoDB[] = [
  'Liviano Particular',
  'Liviano Taxi',
  'Liviano Público',
  'Motocicleta',
]

type CanalAtrib = CanalAtribucion

type HistItem = {
  id: number
  fechaStr: string
  clienteNombre: string | null
  servicioCodigo: string | null
}

function normalizePlaca(v?: string) {
  return v ? v.replace(/[\s-]/g, '').toUpperCase() : v
}
function normalizePhone(v?: string) {
  return v ? v.replace(/\D/g, '') : v
}
function parseHoraIngresoToHHmm(h: string): string | null {
  const asHHmm = DateTime.fromFormat(h, 'HH:mm', { zone: 'America/Bogota' })
  if (asHHmm.isValid) return asHHmm.toFormat('HH:mm')
  const asHHmmss = DateTime.fromFormat(h, 'HH:mm:ss', { zone: 'America/Bogota' })
  if (asHHmmss.isValid) return asHHmmss.toFormat('HH:mm')
  return null
}

function bloqueoMesesPorServicio(codigo?: string): number {
  const c = (codigo || '').toUpperCase()
  if (c === 'RTM' || c === 'SOAT') return 12
  return 0
}

const normalizeCanal = (v?: string): CanalAtrib | null => {
  const x = (v || '').toUpperCase().trim()
  if (['FACHADA', 'ASESOR', 'TELE', 'REDES', 'GOOGLE_ADS'].includes(x)) return x as CanalAtrib
  if (['REDES_SOCIALES', 'RRSS'].includes(x)) return 'REDES'
  if (['GOOGLE ADS', 'GOOGLEADS'].includes(x)) return 'GOOGLE_ADS'
  if (['CALLCENTER', 'CALL_CENTER', 'TELEMERCADEO', 'TELEMARKETING', 'TELEFONO'].includes(x))
    return 'TELE'
  if (['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'].includes(x)) return 'ASESOR'
  return null
}

function medioFromCanal(canal: CanalAtrib): MedioEntero {
  switch (canal) {
    case 'REDES':
      return 'Redes Sociales'
    case 'GOOGLE_ADS':
      return 'Google ADS'
    case 'TELE':
      return 'Call Center'
    case 'ASESOR':
      return 'Asesor Comercial'
    case 'FACHADA':
    default:
      return 'Fachada'
  }
}

// ============================================================================

/**
 * Reintentos de store() cuando el INSERT choca con los índices de numeración
 * (uq_turno_numero_activo_por_dia_sede / uq_turno_numero_servicio_activo_por_dia_sede)
 * o cuando dos creaciones concurrentes se bloquean mutuamente (deadlock por
 * los gap locks del FOR UPDATE sobre el MAX), y cuando dos creaciones del
 * mismo segundo toman el mismo turno_codigo. Toda la escritura de store()
 * va por la misma trx, así que tras el rollback repetirlo es seguro.
 */
const MAX_INTENTOS_NUMERACION = 3

class ColisionNumeracionTurno extends Error {}

function esColisionNumeracion(error: any): boolean {
  if (error?.code === 'ER_LOCK_DEADLOCK') return true
  if (error?.code !== 'ER_DUP_ENTRY') return false
  const msg = String(error?.sqlMessage ?? error?.message ?? '')
  return (
    msg.includes('uq_turno_numero_activo_por_dia_sede') ||
    msg.includes('uq_turno_numero_servicio_activo_por_dia_sede')
  )
}

export default class TurnosRtmController {
  /** 🔥 Lista turnos con filtros Y PAGINACIÓN */
  public async index({ request, response }: HttpContext) {
    const {
      fecha,
      placa,
      tipoVehiculo,
      estado,
      turnoNumero,
      fechaInicio,
      fechaFin,
      servicioId,
      servicioCodigo,
      canalAtribucion,
      agenteId,
      agenteTipo,
      clienteId,
      vehiculoId,
      page = 1,
      perPage = 100,
    } = request.qs()

    try {
      const query = TurnoRtm.query()
        .preload('usuario')
        .preload('facturacionFuncionario')
        .preload('certificacionFuncionario')
        .preload('sede')
        .preload('servicio')
        .preload('vehiculo')
        .preload('cliente')
        .preload('conductor')
        .preload('agenteCaptacion')
        .preload('captacionDateo', (q) => q.preload('agente').preload('convenio'))
        .preload('certificaciones')

      // 🔥 FILTRO POR DEFECTO: ÚLTIMOS 7 DÍAS
      if (!fechaInicio && !fechaFin && !fecha && !placa && !turnoNumero) {
        const hoy = DateTime.local().setZone('America/Bogota')
        const hace7Dias = hoy.minus({ days: 7 })
        query.whereBetween('fecha', [toMySQLDate(hace7Dias), toMySQLDate(hoy)])
      }

      // ====== FILTROS ======
      if (fechaInicio && fechaFin) {
        const fi = DateTime.fromISO(String(fechaInicio), { zone: 'America/Bogota' }).startOf('day')
        const ff = DateTime.fromISO(String(fechaFin), { zone: 'America/Bogota' }).endOf('day')
        if (!fi.isValid || !ff.isValid) return response.badRequest({ message: 'Fechas inválidas' })
        query.whereBetween('fecha', [toMySQLDate(fi), toMySQLDate(ff)])
      } else if (fecha) {
        const f = DateTime.fromISO(String(fecha), { zone: 'America/Bogota' })
        if (!f.isValid) return response.badRequest({ message: 'Fecha inválida' })
        query.whereBetween('fecha', [toMySQLDate(f.startOf('day')), toMySQLDate(f.endOf('day'))])
      }

      if (placa) {
        query.whereRaw('LOWER(placa) LIKE ?', [`%${String(placa).toLowerCase()}%`])
      }
      if (turnoNumero) {
        const n = Number(turnoNumero)
        if (Number.isNaN(n)) return response.badRequest({ message: 'turnoNumero inválido' })
        query.where('turno_numero', n)
      }
      if (tipoVehiculo) {
        if (!VALID_TIPOS_VEHICULO.includes(tipoVehiculo as TipoVehiculoDB)) {
          return response.badRequest({ message: `tipoVehiculo inválido: ${tipoVehiculo}` })
        }
        query.where('tipo_vehiculo', tipoVehiculo as TipoVehiculoDB)
      }
      if (estado) {
        const ok = ['activo', 'inactivo', 'cancelado', 'finalizado']
        if (!ok.includes(String(estado))) return response.badRequest({ message: 'estado inválido' })
        query.where('estado', String(estado) as any)
      }

      // Servicio (soporta múltiples)
      if (servicioId) {
        const servicioIds = String(servicioId)
          .split(',')
          .map((id) => Number(id.trim()))
          .filter((n) => !Number.isNaN(n))
        if (servicioIds.length > 0) {
          query.whereIn('servicio_id', servicioIds)
        }
      } else if (servicioCodigo) {
        const codigos = String(servicioCodigo)
          .split(',')
          .map((c) => c.trim().toUpperCase())
        const servicios = await Servicio.query().whereIn('codigo_servicio', codigos)
        if (servicios.length > 0) {
          query.whereIn(
            'servicio_id',
            servicios.map((s) => s.id)
          )
        }
      }

      // Filtros adicionales
      if (canalAtribucion) {
        const allowed: CanalAtrib[] = ['FACHADA', 'ASESOR', 'TELE', 'REDES', 'GOOGLE_ADS']
        const canales = String(canalAtribucion)
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter((c) => allowed.includes(c as CanalAtrib))

        if (canales.length > 0) {
          query.whereIn('canal_atribucion', canales as CanalAtrib[])
        }
      }
      if (agenteId) query.where('agente_captacion_id', Number(agenteId))
      if (agenteTipo) {
        query.whereHas('agenteCaptacion', (q) => q.where('tipo', String(agenteTipo)))
      }
      if (clienteId) query.where('cliente_id', Number(clienteId))
      if (vehiculoId) query.where('vehiculo_id', Number(vehiculoId))

      // 👇 PAGINACIÓN
      const pageNum = Math.max(1, Number(page) || 1)
      const limit = Math.min(100, Math.max(10, Number(perPage) || 100))

      const paginatedResult = await query
        .orderBy('fecha', 'desc')
        .orderBy('turno_numero', 'desc')
        .paginate(pageNum, limit)

      const turnos = paginatedResult.all()

      const camposDerivados = await this.computeCamposDerivados(turnos)
      const payload = turnos.map((t) => ({
        ...t.serialize(),
        ...camposDerivados.get(t.id),
      }))

      return response.ok(payload)
    } catch (error) {
      console.error('Error en index turnos:', error)
      return response.internalServerError({ message: 'Error al obtener turnos' })
    }
  }

  // 👇 MÉTODO HELPER
  private getClienteNombre(c: Cliente | null | undefined): string | null {
    if (!c) return null
    const any = c as any
    if (any.nombreCompleto) return String(any.nombreCompleto)
    if (any.nombre) return String(any.nombre)
    const partes = [any.nombres, any.apellidos].filter(Boolean).join(' ').trim()
    if (partes) return partes
    if (any.razonSocial) return String(any.razonSocial)
    return null
  }

  /**
   * Campos derivados que NO vienen directo de la columna `turnos_rtms`: si
   * tiene facturación CONFIRMADA, y el historial de visitas del vehículo
   * (mismo cálculo — antes solo vivía en index()). Compartido por index() y
   * show() para que el modal de detalle de turno se vea idéntico sin
   * importar si se abre desde Estado de Turnos o desde Comisiones.
   */
  private async computeCamposDerivados(turnos: TurnoRtm[]): Promise<
    Map<
      number,
      {
        tieneFacturacion: boolean
        tieneCertificacion: boolean
        visitaVehiculoNumero: number | null
        visitaVehiculoTexto: string
        visitaVehiculoUltimasFechas: string[]
        visitasVehiculoDetalle: HistItem[]
        etapasRequeridas: number
        etapasCompletadas: number
        estadoVisual: EstadoVisualTurno
        /** Lista de etapas que aplican (fuente de verdad para el front). */
        etapasRequeridasLista: EtapaKey[]
        esSegundaVez: boolean
      }
    >
  > {
    const resultado = new Map<
      number,
      {
        tieneFacturacion: boolean
        tieneCertificacion: boolean
        visitaVehiculoNumero: number | null
        visitaVehiculoTexto: string
        visitaVehiculoUltimasFechas: string[]
        visitasVehiculoDetalle: HistItem[]
        etapasRequeridas: number
        etapasCompletadas: number
        estadoVisual: EstadoVisualTurno
        /** Lista de etapas que aplican (fuente de verdad para el front). */
        etapasRequeridasLista: EtapaKey[]
        esSegundaVez: boolean
      }
    >()
    if (turnos.length === 0) return resultado

    // ====== FACTURACIÓN CONFIRMADA ======
    const turnoIds = turnos.map((t) => t.id)
    const facturadas = await FacturacionTicket.query()
      .whereIn('turno_id', turnoIds)
      .where('estado', 'CONFIRMADA')
      .select('turno_id')
    const turnosConFactura = new Set<number>(
      facturadas.map((f) => (f as any).turnoId ?? (f as any).turno_id)
    )

    // 🔥 HISTORIAL OPTIMIZADO (UNA SOLA CONSULTA)
    const placasUnicas = Array.from(new Set(turnos.map((t) => t.placa)))
    const historialPorPlaca: Record<string, HistItem[]> = {}

    if (placasUnicas.length > 0) {
      const rows = await TurnoRtm.query()
        .whereIn('placa', placasUnicas)
        .whereNot('estado', 'inactivo')
        .orderBy('fecha', 'asc')
        .orderBy('hora_ingreso', 'asc')
        .preload('cliente')
        .preload('servicio')

      rows.forEach((r) => {
        if (!historialPorPlaca[r.placa]) {
          historialPorPlaca[r.placa] = []
        }
        historialPorPlaca[r.placa].push({
          id: r.id,
          fechaStr: toMySQLDate(r.fecha as DateTime),
          clienteNombre: this.getClienteNombre(r.cliente),
          servicioCodigo: r.servicio ? ((r.servicio as any).codigoServicio ?? null) : null,
        })
      })
    }

    const visitaLabel = (n: number | null): string => {
      if (!n || n <= 0) return '—'
      // "visita" (no "vez") para no confundir con la Segunda vez gratuita.
      if (n === 1) return 'Primera visita'
      return `${n}ª visita`
    }

    turnos.forEach((t) => {
      const hist = historialPorPlaca[t.placa] ?? []

      let visitaNumero: number | null = null
      const ultimasFechas: string[] = []
      let visitasDetalle: HistItem[] = []

      if (hist.length) {
        const idxFound = hist.findIndex((h) => h.id === t.id)
        const idx = idxFound >= 0 ? idxFound : hist.length - 1

        visitaNumero = idx + 1
        if (idx > 0) ultimasFechas.push(hist[idx - 1].fechaStr)
        if (idx > 1) ultimasFechas.push(hist[idx - 2].fechaStr)

        visitasDetalle = hist
      }

      const tieneFacturacion = turnosConFactura.has(t.id)
      const etapasInfo = computeEtapasTurno({
        servicioCodigo: t.servicio ? (t.servicio as any).codigoServicio : null,
        esSegundaVez: esTurnoSegundaVez(t),
        estado: t.estado,
        horaIngreso: t.horaIngreso,
        tieneFacturacion,
        horaSalida: t.horaSalida,
      })

      resultado.set(t.id, {
        tieneFacturacion,
        tieneCertificacion: (t.certificaciones ?? []).length > 0,
        visitaVehiculoNumero: visitaNumero,
        visitaVehiculoTexto: visitaLabel(visitaNumero),
        visitaVehiculoUltimasFechas: ultimasFechas,
        visitasVehiculoDetalle: visitasDetalle,
        etapasRequeridas: etapasInfo.totalRequeridas,
        etapasCompletadas: etapasInfo.totalCompletadas,
        estadoVisual: etapasInfo.estadoVisual,
        etapasRequeridasLista: etapasInfo.etapasRequeridas,
        esSegundaVez: esTurnoSegundaVez(t),
      })
    })

    return resultado
  }

  /** GET /turnos/:id */
  public async show({ params, response }: HttpContext) {
    try {
      const id = Number(params.id)
      if (Number.isNaN(id)) {
        return response.badRequest({ message: 'id inválido' })
      }

      const turno = await TurnoRtm.query()
        .where('id', id)
        .preload('usuario')
        .preload('facturacionFuncionario')
        .preload('certificacionFuncionario')
        .preload('sede')
        .preload('servicio')
        .preload('vehiculo', (q) => q.preload('clase'))
        .preload('cliente')
        .preload('conductor')
        .preload('agenteCaptacion')
        .preload('captacionDateo', (q) => q.preload('agente').preload('convenio'))
        .preload('certificaciones')
        .first()

      if (!turno) {
        return response.notFound({ message: 'Turno no encontrado' })
      }

      const camposDerivados = await this.computeCamposDerivados([turno])
      return response.ok({
        ...turno.serialize(),
        ...camposDerivados.get(turno.id),
      })
    } catch (error) {
      console.error('Error en show turno:', error)
      return response.internalServerError({ message: 'Error al obtener el turno' })
    }
  }

  /** Crear turno */
  public async store(ctx: HttpContext) {
    for (let intento = 1; ; intento++) {
      try {
        return await this.crearTurno(ctx, intento >= MAX_INTENTOS_NUMERACION)
      } catch (error) {
        if (!(error instanceof ColisionNumeracionTurno)) throw error
        console.warn(`⚠️ Colisión de numeración al crear turno (intento ${intento}), reintentando`)
      }
    }
  }

  private async crearTurno({ request, response, auth }: HttpContext, ultimoIntento: boolean) {
    const trx = await Database.transaction()
    try {
      const raw = request.only([
        'placa',
        'telefono',
        'tipoVehiculo',
        'observaciones',
        'fecha',
        'horaIngreso',
        'usuarioId',
        'servicioId',
        'servicioCodigo',
        'canal',
        'agenteCaptacionId',
        'dateoId',
        'clienteTelefono',
        'clienteNombre',
        'clienteEmail',
        'conductorId',
        'conductorTelefono',
        'conductorNombre',
        'asesorDetectadoId',
      ])

      if (!raw.placa || !raw.tipoVehiculo || !raw.usuarioId || !raw.fecha || !raw.horaIngreso) {
        await trx.rollback()
        return response.badRequest({
          message:
            'Faltan campos obligatorios: placa, tipoVehiculo, usuarioId, fecha, horaIngreso.',
        })
      }

      const placa = normalizePlaca(raw.placa)!
      const telefono = normalizePhone(raw.telefono) ?? normalizePhone(raw.clienteTelefono)
      const conductorTelefono = normalizePhone(raw.conductorTelefono)

      const idUsuario = Number(raw.usuarioId)

      if (Number.isNaN(idUsuario) || idUsuario <= 0) {
        console.error('❌ [TURNO-CREATE] ID usuario inválido:', {
          recibido: raw.usuarioId,
          tipo: typeof raw.usuarioId,
          parseado: idUsuario,
          timestamp: new Date().toISOString(),
        })
        await trx.rollback()
        return response.badRequest({
          message: 'ID de usuario inválido. Por favor, cierra sesión y vuelve a ingresar.',
          debug: {
            recibido: raw.usuarioId,
            parseado: idUsuario,
          },
        })
      }

      const usuarioCreador = await Usuario.query().where('id', idUsuario).preload('sede').first()

      console.log('🔍 [TURNO-CREATE] Usuario encontrado:', {
        id: usuarioCreador?.id,
        correo: usuarioCreador?.correo,
        sedeId: usuarioCreador?.sedeId,
        sede: usuarioCreador?.sede?.nombre,
        timestamp: new Date().toISOString(),
      })

      if (!usuarioCreador) {
        console.error('❌ [TURNO-CREATE] Usuario no existe:', { idBuscado: idUsuario })
        await trx.rollback()
        return response.badRequest({
          message: `Usuario ${idUsuario} no encontrado en el sistema`,
        })
      }

      if (!usuarioCreador.sedeId || !usuarioCreador.sede) {
        console.error('❌ [TURNO-CREATE] Usuario sin sede:', {
          usuarioId: idUsuario,
          correo: usuarioCreador.correo,
          sedeId: usuarioCreador.sedeId,
          sede: usuarioCreador.sede,
          timestamp: new Date().toISOString(),
        })
        await trx.rollback()
        return response.badRequest({
          message: 'Tu usuario no tiene sede asignada. Contacta al administrador.',
          debug: {
            usuarioId: idUsuario,
            correo: usuarioCreador.correo,
            sedeId: usuarioCreador.sedeId,
          },
        })
      }

      let servicio: Servicio | null = null
      if (raw.servicioId) {
        const sid = Number(raw.servicioId)
        if (Number.isNaN(sid)) {
          await trx.rollback()
          return response.badRequest({ message: 'servicioId debe ser numérico' })
        }
        servicio = await Servicio.find(sid)
      } else if (raw.servicioCodigo) {
        servicio = await Servicio.query()
          .where('codigo_servicio', String(raw.servicioCodigo))
          .first()
      }
      if (!servicio) {
        await trx.rollback()
        return response.badRequest({ message: 'Debe enviar servicioId o servicioCodigo válido' })
      }

      if (!VALID_TIPOS_VEHICULO.includes(raw.tipoVehiculo as TipoVehiculoDB)) {
        await trx.rollback()
        return response.badRequest({
          message: `tipoVehiculo inválido. Debe ser uno de: ${VALID_TIPOS_VEHICULO.join(', ')}`,
        })
      }

      const fechaGuardar = DateTime.fromISO(raw.fecha, { zone: 'America/Bogota' })
      if (!fechaGuardar.isValid) {
        await trx.rollback()
        return response.badRequest({ message: 'Fecha inválida' })
      }
      const horaIngresoStr = parseHoraIngresoToHHmm(String(raw.horaIngreso))
      if (!horaIngresoStr) {
        await trx.rollback()
        return response.badRequest({ message: 'Hora de ingreso inválida (HH:mm o HH:mm:ss)' })
      }

      const hoyISO = fechaGuardar.toISODate()!

      // ── Fecha distinta de hoy (ver fecha_turno_service.ts): futura nunca;
      // anterior solo SUPER_ADMIN/GERENCIA (rol del usuario autenticado). Un
      // turno de hoy no entra aquí y sigue exactamente igual.
      const hoyServidor = hoyServidorISO()
      if (hoyISO !== hoyServidor) {
        let rol: string | null = null
        if (hoyISO < hoyServidor && auth.user) {
          await (auth.user as any).load('rol')
          rol = (auth.user as any).rol?.nombre ?? null
        }
        const errorFecha = validarFechaTurno({ fechaISO: hoyISO, hoyISO: hoyServidor, rol })
        if (errorFecha) {
          await trx.rollback()
          return response
            .status(errorFecha.status)
            .send({ code: errorFecha.code, message: errorFecha.message })
        }
      }

      // ── Segunda vez (RTM/PREV) ─────────────────────────────────────────
      // Detección automática con confirmación del operador: si placa+servicio
      // tiene una ventana ABIERTA (ver segunda_vez_service.ts), sin
      // segundaVezOrigenId se responde 409 SEGUNDA_VEZ_DISPONIBLE; con él se
      // revalida aquí (con candado sobre el origen) y el turno se crea como
      // segunda vez. SUPER_ADMIN/GERENCIA pueden FORZAR (sin ventana abierta)
      // o NO_APLICAR (cobrar normal) con motivo obligatorio.
      const sv = await this.resolverSegundaVez({
        request,
        auth,
        response,
        trx,
        placa,
        servicio,
      })
      if ('respuesta' in sv) {
        await trx.rollback()
        return sv.respuesta
      }
      const modoSegundaVez = sv.modo
      const esSV = modoSegundaVez?.tipo === 'SEGUNDA_VEZ'

      // DUPLICATE_DAY: misma regla que dedupe_key (incluye es_segunda_vez,
      // Entrega B2). Una segunda vez solo choca con otra segunda vez del día,
      // así que ignora a su origen (rechazado hoy en esta sede). Un turno
      // normal se sigue bloqueando con cualquier turno no cancelado del día.
      const dupDiarioQuery = trx
        .from('turnos_rtms')
        .where('sede_id', usuarioCreador.sedeId!)
        .andWhere('servicio_id', servicio.id)
        .andWhere('fecha', hoyISO)
        .andWhere('placa', placa)
        .whereNot('estado', 'cancelado')
      if (esSV) dupDiarioQuery.andWhere('es_segunda_vez', 1)
      const dupDiario = await dupDiarioQuery.count('* as total').first()

      const totalDup = Number((dupDiario as any)?.total ?? 0)
      if (totalDup > 0) {
        await trx.rollback()
        const manana = fechaGuardar.plus({ days: 1 }).toISODate()
        return response.conflict({
          code: 'DUPLICATE_DAY',
          message:
            'Ya existe un turno hoy para esta placa y servicio en esta sede. Intenta nuevamente mañana.',
          nextAllowedDate: manana,
        })
      }

      // Solo turnos que dan vigencia: un RTM/PREV certificado RECHAZADO no
      // bloquea el regreso (ver segunda_vez_service.ts).
      const lastFinalizado = await whereTurnoDaVigencia(
        TurnoRtm.query({ client: trx }).where('placa', placa).andWhere('servicio_id', servicio.id)
      )
        .orderBy('fecha', 'desc')
        .first()

      // Una segunda vez no pasa por el bloqueo de vigencia.
      if (lastFinalizado && !esSV) {
        const meses = bloqueoMesesPorServicio((servicio as any).codigoServicio)
        if (meses > 0) {
          const ultimaFecha = lastFinalizado.fecha as DateTime
          const DIAS_VENTANA_PRE = 16
          const vencimiento = ultimaFecha.plus({ months: meses }).startOf('day')
          const nextAllowed = vencimiento.minus({ days: DIAS_VENTANA_PRE })
          if (fechaGuardar.startOf('day') < nextAllowed) {
            await trx.rollback()
            return response.conflict({
              code: 'WINDOW_BLOCK',
              message: `No es posible crear un nuevo turno de ${servicio.codigoServicio} aún. Válido nuevamente desde ${nextAllowed.toISODate()}.`,
              servicio: servicio.codigoServicio,
              lastFinalizedOn: ultimaFecha.toISODate(),
              nextAllowedDate: nextAllowed.toISODate(),
              vencimientoDate: vencimiento.toISODate(),
              monthsBlocked: meses,
              diasVentana: DIAS_VENTANA_PRE,
            })
          }
        }
      }

      // ── Regla 1: turno anterior 'activo' (abierto) para la misma
      // placa+servicio+sede, de cualquier día anterior. No cubierto por
      // DUPLICATE_DAY (que solo mira hoy) ni por WINDOW_BLOCK (que solo
      // mira turnos ya 'finalizado').
      const turnoAbierto = await TurnoRtm.query({ client: trx })
        .where('sede_id', usuarioCreador.sedeId!)
        .andWhere('servicio_id', servicio.id)
        .andWhere('placa', placa)
        .andWhere('estado', 'activo')
        .andWhereNot('fecha', hoyISO)
        .orderBy('fecha', 'desc')
        .first()

      if (turnoAbierto) {
        const tieneFacturacion = !!turnoAbierto.tieneFacturacion
        const tieneCertificacion = !!turnoAbierto.horaSalida
        const fechaAbierta = (turnoAbierto.fecha as DateTime).toISODate()

        if (!tieneFacturacion && !tieneCertificacion) {
          await trx.rollback()
          return response.conflict({
            code: 'OPEN_TURNO_SIN_EVIDENCIA',
            message: `Ya existe un turno abierto (${turnoAbierto.turnoCodigo}, ${fechaAbierta}) sin evidencia para esta placa y servicio. Puedes cancelarlo (indicando el motivo) para continuar.`,
            turnoAbiertoId: turnoAbierto.id,
            turnoAbiertoCodigo: turnoAbierto.turnoCodigo,
            turnoAbiertoFecha: fechaAbierta,
          })
        }

        await trx.rollback()
        let detalleEvidencia: string
        if (tieneFacturacion && !tieneCertificacion) {
          detalleEvidencia = 'tiene facturación pero le falta certificación'
        } else if (!tieneFacturacion && tieneCertificacion) {
          detalleEvidencia = 'tiene certificación pero le falta facturación'
        } else {
          detalleEvidencia = 'tiene facturación y certificación registradas'
        }
        return response.conflict({
          code: 'OPEN_TURNO_BLOQUEADO',
          message: `El turno anterior de esta placa (${turnoAbierto.turnoCodigo}, ${fechaAbierta}) ${detalleEvidencia} y sigue sin finalizar. Para continuar, complétalo en su pantalla correspondiente o cancélalo indicando el motivo desde la pantalla de turnos.`,
          turnoAbiertoId: turnoAbierto.id,
          turnoAbiertoCodigo: turnoAbierto.turnoCodigo,
          turnoAbiertoFecha: fechaAbierta,
          tieneFacturacion,
          tieneCertificacion,
        })
      }

      // ── Reasignación: slots liberados por cancelados del mismo día ──────
      // Subquery: IDs de cancelados cuyo slot global ya fue reclamado
      const slotsClamados = trx
        .from('turnos_rtms')
        .select('reasignado_de_turno_id')
        .where('sede_id', usuarioCreador.sedeId!)
        .where('fecha', hoyISO)
        .whereNotNull('reasignado_de_turno_id')

      const huecoGlobal = await trx
        .from('turnos_rtms')
        .select('id')
        .select(Database.raw('ABS(turno_numero) AS slot_libre'))
        .where('sede_id', usuarioCreador.sedeId!)
        .where('fecha', hoyISO)
        .where('estado', 'cancelado')
        .where('turno_numero', '<', 0)
        .whereNotIn('id', slotsClamados)
        // Excluir slots cuyo número positivo ya está físicamente ocupado
        // (cubre turnos creados antes de que existiera reasignadoDeTurnoId)
        .whereRaw(
          'ABS(turno_numero) NOT IN (SELECT turno_numero FROM turnos_rtms WHERE sede_id = ? AND fecha = ? AND turno_numero > 0)',
          [usuarioCreador.sedeId!, hoyISO]
        )
        .orderByRaw('ABS(turno_numero) ASC')
        .limit(1)
        .forUpdate()
        .first()

      const huecoServicio = await trx
        .from('turnos_rtms')
        .select(Database.raw('ABS(turno_numero_servicio) AS slot_svc_libre'))
        .where('sede_id', usuarioCreador.sedeId!)
        .where('fecha', hoyISO)
        .where('servicio_id', servicio.id)
        .where('estado', 'cancelado')
        .where('turno_numero_servicio', '<', 0)
        .whereRaw(
          'ABS(turno_numero_servicio) NOT IN (SELECT turno_numero_servicio FROM turnos_rtms WHERE sede_id = ? AND fecha = ? AND servicio_id = ? AND turno_numero_servicio > 0)',
          [usuarioCreador.sedeId!, hoyISO, servicio.id]
        )
        .orderByRaw('ABS(turno_numero_servicio) ASC')
        .limit(1)
        .forUpdate()
        .first()

      let nextGlobal: number
      let reasignadoDeTurnoId: number | null = null

      if (huecoGlobal?.slot_libre != null) {
        nextGlobal = Number(huecoGlobal.slot_libre)
        reasignadoDeTurnoId = Number(huecoGlobal.id)
      } else {
        const rowGlobal = await trx
          .from('turnos_rtms')
          .where('sede_id', usuarioCreador.sedeId!)
          .where('fecha', hoyISO)
          .where('turno_numero', '>', 0)
          // Sin filtrar por estado: un número > 0 ocupa el índice único
          // uq_turno_numero_activo_por_dia_sede sea cual sea el estado (p. ej.
          // un cancelado por PUT o un inactivo no negaron su número), así
          // que el MAX debe contarlo para no proponer un número ya tomado.
          .max('turno_numero as max')
          .forUpdate()
          .first()
        nextGlobal = Number(rowGlobal?.max ?? 0) + 1
      }

      let nextPorServicio: number

      if (huecoServicio?.slot_svc_libre != null) {
        nextPorServicio = Number(huecoServicio.slot_svc_libre)
      } else {
        const rowSvc = await trx
          .from('turnos_rtms')
          .where('sede_id', usuarioCreador.sedeId!)
          .where('servicio_id', servicio.id)
          .where('fecha', hoyISO)
          .where('turno_numero_servicio', '>', 0)
          .max('turno_numero_servicio as max')
          .forUpdate()
          .first()
        nextPorServicio = Number(rowSvc?.max ?? 0) + 1
      }
      // ── fin reasignación ─────────────────────────────────────────────────

      let vehiculoId: number | null = null
      let clienteId: number | null = null
      let claseVehiculoId: number | null = null

      const veh = await Vehiculo.query({ client: trx })
        .where('placa', placa)
        .preload('clase')
        .first()
      if (veh) {
        vehiculoId = veh.id
        claseVehiculoId = (veh as any).claseVehiculoId ?? (veh as any).claseId ?? null
        clienteId = veh.clienteId ?? null
      }

      const esAsesorDetectado = !!raw.asesorDetectadoId
      if (!clienteId && telefono && !esAsesorDetectado) {
        const cExist = await Cliente.query({ client: trx }).where('telefono', telefono).first()
        if (cExist) {
          clienteId = cExist.id
        } else if (raw.clienteNombre || raw.clienteEmail) {
          const cNuevo = await Cliente.create(
            {
              nombre: String(raw.clienteNombre || 'Cliente'),
              telefono,
              email: raw.clienteEmail || null,
            } as any,
            { client: trx }
          )
          clienteId = cNuevo.id
        }
      }

      let conductorId: number | null = null

      if (raw.conductorId) {
        const c = await Conductor.find(Number(raw.conductorId))
        if (c) conductorId = c.id
      }

      if (!conductorId && (conductorTelefono || raw.conductorNombre)) {
        let cExist: Conductor | null = null
        if (conductorTelefono) {
          cExist = await Conductor.query({ client: trx })
            .where('telefono', conductorTelefono)
            .first()
        }

        if (cExist) {
          conductorId = cExist.id
        } else {
          const nuevoConductor = await Conductor.create(
            {
              nombre: String(raw.conductorNombre || 'Conductor'),
              telefono: conductorTelefono || null,
            } as any,
            { client: trx }
          )
          conductorId = nuevoConductor.id
        }
      }

      const nowBog = DateTime.local().setZone('America/Bogota')
      // turno_codigo es único y va al segundo: si otro turno del mismo
      // servicio ya tomó este segundo se agrega sufijo -2, -3… (formato normal
      // intacto en el caso común). Una carrera sobre el mismo sufijo cae en
      // ER_DUP_ENTRY y store() reintenta viendo el ya confirmado.
      const codigoBase = `${servicio.codigoServicio}-${nowBog.toFormat('yyyyMMddHHmmss')}`
      const codigosDelSegundo = await trx
        .from('turnos_rtms')
        .where('turno_codigo', 'like', `${codigoBase}%`)
        .count('* as total')
        .first()
      const nCodigos = Number(codigosDelSegundo?.total ?? 0)
      const turnoCodigo = nCodigos === 0 ? codigoBase : `${codigoBase}-${nCodigos + 1}`

      let canalAtribucion: CanalAtrib | null = raw.canal ? normalizeCanal(raw.canal) : null
      let agenteCaptacionId: number | null = null
      if (canalAtribucion === 'ASESOR') {
        agenteCaptacionId = raw.agenteCaptacionId ? Number(raw.agenteCaptacionId) || null : null
      }
      // Segunda vez: canal del origen solo para trazabilidad; sin agente ni
      // dateo (no genera comisión). Todo el bloque de dateo de abajo
      // (explícito, fallback, reintento, red de seguridad y auto-dateo por
      // teléfono) y la recurrencia se saltan con esSV.
      if (esSV) {
        canalAtribucion = modoSegundaVez!.origen.canalAtribucion ?? null
        agenteCaptacionId = null
      }

      // 🆕 Un dateo solo se vincula/hereda/consume si es del MISMO servicio
      // que se está creando (dateoAplicaAServicio, reserva_dateo_service.ts).
      // El frontend hoy solo muestra una alerta visual si el servicio no
      // coincide, no bloquea — el backend es la fuente de verdad real.
      let dateo: CaptacionDateo | null = null
      if (!esSV && raw.dateoId) {
        // 🆕 Antes de consultar, validar que raw.dateoId sea un número finito
        // real. Un valor no numérico (ej. "abc") pasado crudo a `.where('id', NaN)`
        // rompía la query con un 500 ("Unknown column 'NaN'") en vez de caer al
        // fallback como cualquier otro dateoId inválido/no aplicable.
        const dateoIdNum = Number(raw.dateoId)
        if (Number.isFinite(dateoIdNum)) {
          const dateoExplicito = await CaptacionDateo.query({ client: trx })
            .where('id', dateoIdNum)
            .first()
          // No confiar ciegamente en el dateoId que manda el frontend: si su
          // servicio no coincide, se trata como si no se hubiera mandado nada
          // y se cae al fallback por placa/teléfono+servicio de abajo.
          if (dateoExplicito && dateoAplicaAServicio(dateoExplicito, servicio.id)) {
            dateo = dateoExplicito
          }
        } else {
          console.log('⚠️ [DATEO-INVALIDO] raw.dateoId no es numérico, se ignora y cae al fallback:', {
            rawDateoIdRecibido: raw.dateoId,
            tipo: typeof raw.dateoId,
          })
        }
      }
      if (!esSV && !dateo) {
        dateo = await CaptacionDateo.query({ client: trx })
          .where((qb) => {
            qb.where('placa', placa)
            if (telefono) qb.orWhere('telefono', telefono)
          })
          .andWhere('servicio_id', servicio.id)
          .orderBy('created_at', 'desc')
          .first()
      }

      let dateoObservacion: string | null = null
      let dateoImagenUrl: string | null = null
      let dateoCanal: 'FACHADA' | 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'TELE' | 'REDES' | null =
        null

      if (dateo) {
        dateoObservacion = dateo.observacion || null
        dateoImagenUrl = dateo.imagenUrl || null
        dateoCanal = dateo.canal || null

        console.log('📋 Copiando datos del dateo:', {
          dateoId: dateo.id,
          tieneObservacion: !!dateoObservacion,
          tieneImagen: !!dateoImagenUrl,
          canal: dateoCanal,
        })
      }

      let captacionDateoId: number | null = null
      let esAvanceHeredado: boolean = false

      // 🆕 Logging de diagnóstico permanente (no solo para debug puntual):
      // deja rastro en pm2 logs de qué dateoId llegó y qué dateo se resolvió
      // ANTES de validar vigencia, para poder reconstruir con certeza un caso
      // como este si vuelve a pasar sin causa clara.
      console.log('🔎 [DATEO-DIAGNOSTICO] Antes de validar vigencia:', {
        rawDateoIdRecibido: raw.dateoId,
        tipoRawDateoId: typeof raw.dateoId,
        dateoResueltoId: dateo?.id ?? 'ninguno',
        servicioIdTurno: servicio.id,
      })

      // 🆕 Aplica un dateo vigente con la misma lógica de vinculación que ya
      // usaba el camino feliz (canalAtribucion, agenteCaptacionId,
      // captacionDateoId, esAvanceHeredado) — compartida también por el
      // reintento (Capa 1) y la red de seguridad final (Capa 2) para no
      // triplicar esta lógica.
      const vincularDateoVigente = (d: CaptacionDateo) => {
        dateo = d
        dateoObservacion = d.observacion || null
        dateoImagenUrl = d.imagenUrl || null
        dateoCanal = d.canal || null

        const cRaw = (d as any).canal as string | undefined
        const cNorm = normalizeCanal(cRaw)
        if (cNorm && !canalAtribucion) {
          canalAtribucion = cNorm
        }
        if (!agenteCaptacionId) {
          agenteCaptacionId = (d as any).agenteId ?? (d as any).agente_id ?? null
        }

        captacionDateoId = d.id
        esAvanceHeredado = Boolean((d as any).esAvance ?? false)
      }

      if (dateo) {
        const r = await buildReserva(dateo)
        if (r.vigente) {
          vincularDateoVigente(dateo)
          console.log(`🆕 esAvance heredado del dateo ${dateo.id}: ${esAvanceHeredado}`)
        } else {
          // 🆕 Capa 1: el candidato (explícito o fallback) no está vigente —
          // antes de rendirnos, reintentamos el fallback por placa/teléfono
          // + servicio EXCLUYENDO este id, por si hay otro dateo vigente
          // disponible para esta misma placa+servicio.
          const dateoDescartadoId = dateo.id
          dateo = null
          dateoObservacion = null
          dateoImagenUrl = null
          dateoCanal = null

          const dateoRetry = await CaptacionDateo.query({ client: trx })
            .where((qb) => {
              qb.where('placa', placa)
              if (telefono) qb.orWhere('telefono', telefono)
            })
            .andWhere('servicio_id', servicio.id)
            .whereNot('id', dateoDescartadoId)
            .orderBy('created_at', 'desc')
            .first()

          if (dateoRetry) {
            const rRetry = await buildReserva(dateoRetry)
            if (rRetry.vigente) {
              vincularDateoVigente(dateoRetry)
              console.log('🆕 [RETRY] Dateo descartado por no vigente — se vinculó otro dateo vigente en el reintento:', {
                dateoDescartadoId,
                dateoVinculadoId: dateoRetry.id,
                placa,
                servicioId: servicio.id,
              })
            }
          }
        }
      }
      // ── Clasificación de recurrencia en tiempo real ──
      const configGlobal = await Database.from('configuracion_recurrencia_global')
        .orderBy('id', 'asc')
        .first()
      const mesesMinimos: number = configGlobal?.meses_minimos ?? 24

      let esRecurrente = false
      let esRecuperacion = false
      let mesesDesdeUltimaVisita: number | null = null
      let ultimoTurnoId: number | null = null
      let fechaUltimaVisita: string | null = null
      let estadoContinuidad: 'CONTINUA' | 'ROTA' | 'SIN_EVIDENCIA' | null = null

      if (!esSV && clienteId) {
        // La última visita ignora las segundas veces (el origen rechazado sí cuenta).
        const ultimoTurno = await excluirSegundaVez(
          TurnoRtm.query({ client: trx })
            .where('cliente_id', clienteId)
            .where('estado', 'finalizado')
            .where('fecha', '<', hoyISO)
        )
          .orderBy('fecha', 'desc')
          .first()

        if (ultimoTurno) {
          const fechaAnteriorISO =
            ultimoTurno.fecha instanceof DateTime
              ? ultimoTurno.fecha.toISODate()!
              : String(ultimoTurno.fecha).substring(0, 10)

          const fechaActualDt = DateTime.fromISO(hoyISO, { zone: 'America/Bogota' })
          const fechaAnteriorDt = DateTime.fromISO(fechaAnteriorISO, { zone: 'America/Bogota' })
          const meses = Math.floor(fechaActualDt.diff(fechaAnteriorDt, 'months').months)

          ultimoTurnoId = ultimoTurno.id
          fechaUltimaVisita = fechaAnteriorISO
          mesesDesdeUltimaVisita = meses

          if (captacionDateoId) {
            const dateoActual = await Database.from('captacion_dateos')
              .where('id', captacionDateoId)
              .first()
            const convenioIdActual = dateoActual?.convenio_id ?? null
            const asesorConvenioActual = dateoActual?.asesor_convenio_id ?? null

            const esAsesorConvenioDateando = dateoActual?.canal === 'ASESOR_CONVENIO'
            if (esAsesorConvenioDateando && (asesorConvenioActual || convenioIdActual)) {
              estadoContinuidad = await evaluarContinuidad({
                placa,
                asesorConvenioId: asesorConvenioActual,
                convenioId: convenioIdActual,
              })

              // CONTINUA o SIN_EVIDENCIA → no es recurrente (cobra incentivo completo)
              // ROTA → sí es recurrente (cobra valor recurrente)
              esRecurrente = estadoContinuidad === 'ROTA'
              esRecuperacion = false
            } else {
              esRecurrente = meses < mesesMinimos
              esRecuperacion = meses >= mesesMinimos
            }
          } else {
            esRecurrente = meses < mesesMinimos
            esRecuperacion = meses >= mesesMinimos
          }
        }
      }
      // 🆕 Capa 2: red de seguridad final, independiente de la causa raíz.
      // Si a esta altura captacionDateoId sigue null, se intenta una última
      // vez por placa+servicio_id antes de crear el turno sin vincular.
      if (!esSV && !captacionDateoId) {
        const dateoUltimoIntento = await CaptacionDateo.query({ client: trx })
          .where('placa', placa)
          .andWhere('servicio_id', servicio.id)
          .orderBy('created_at', 'desc')
          .first()

        if (dateoUltimoIntento) {
          const rUltimoIntento = await buildReserva(dateoUltimoIntento)
          if (rUltimoIntento.vigente) {
            vincularDateoVigente(dateoUltimoIntento)
            console.log('🆕 [RED-SEGURIDAD] captacionDateoId seguía null justo antes de crear el turno — se vinculó en el último intento:', {
              rawDateoIdOriginal: raw.dateoId,
              dateoVinculadoId: dateoUltimoIntento.id,
              placa,
              servicioId: servicio.id,
            })
          }
        }
      }

      const payload: any = {
        sedeId: usuarioCreador.sedeId!,
        funcionarioId: usuarioCreador.id,
        servicioId: servicio.id,
        fecha: fechaGuardar,
        horaIngreso: horaIngresoStr,
        turnoNumero: nextGlobal,
        turnoCodigo,
        placa,
        tipoVehiculo: raw.tipoVehiculo as TipoVehiculoDB,
        observaciones: raw.observaciones || null,
        estado: 'activo',
        vehiculoId,
        clienteId,
        claseVehiculoId,
        conductorId,
        canalAtribucion,
        agenteCaptacionId,
        captacionDateoId: captacionDateoId ?? null,
        dateoObservacion,
        dateoImagenUrl,
        dateoCanal,
        esAvance: esAvanceHeredado,
        esRecurrente,
        estadoContinuidad,
        esRecuperacion,
        mesesDesdeUltimaVisita,
        ultimoTurnoId,
        fechaUltimaVisita,
        reasignadoDeTurnoId,
        // Segunda vez / excepción (ver resolverSegundaVez)
        esSegundaVez: esSV,
        turnoOrigenId: modoSegundaVez?.origen.id ?? null,
        segundaVezExcepcion: modoSegundaVez?.excepcion ?? null,
        segundaVezExcepcionPorId: modoSegundaVez?.excepcion ? modoSegundaVez.excepcionPorId : null,
        segundaVezExcepcionMotivo: modoSegundaVez?.excepcion ? modoSegundaVez.motivo : null,
      }

      if (canalAtribucion && !esSV) {
        payload.medioEntero = medioFromCanal(canalAtribucion)
      }

      payload.turnoNumeroServicio = nextPorServicio
      payload['turno_numero_servicio'] = nextPorServicio

      const turno = await TurnoRtm.create(payload, { client: trx })

      if (captacionDateoId) {
        await CaptacionDateo.query({ client: trx })
          .where('id', captacionDateoId)
          .update({
            resultado: 'EN_PROCESO',
            consumidoTurnoId: turno.id,
            consumidoAt: toMySQL(nowBog),
            updatedAt: toMySQL(nowBog) as any,
          } as any)
      }

      const esRTM = servicio.codigoServicio?.toUpperCase() === 'RTM'
      const asesorDetectadoPorTelefono = raw.asesorDetectadoId
        ? Number(raw.asesorDetectadoId)
        : null

      console.log('🔍 Auto-dateo check:', {
        esRTM,
        asesorDetectadoPorTelefono,
        placa,
        condicion: esRTM && asesorDetectadoPorTelefono && placa,
      })

      if (!esSV && esRTM && asesorDetectadoPorTelefono && placa) {
        try {
          const dateoExistente = await CaptacionDateo.query({ client: trx })
            .where('agente_id', asesorDetectadoPorTelefono)
            .where('placa', placa)
            .where('resultado', 'PENDIENTE')
            .first()

          if (dateoExistente) {
            dateoExistente.resultado = 'EN_PROCESO'
            dateoExistente.consumidoTurnoId = turno.id
            dateoExistente.consumidoAt = nowBog
            await dateoExistente.useTransaction(trx).save()

            turno.captacionDateoId = dateoExistente.id
            await turno.useTransaction(trx).save()

            console.log(
              `✅ Dateo existente #${dateoExistente.id} consumido para turno #${turno.id}`
            )
          } else {
            const asesor = await AgenteCaptacion.find(asesorDetectadoPorTelefono)
            if (asesor) {
              const canal =
                (asesor as any).tipo === 'ASESOR_CONVENIO' ? 'ASESOR_CONVENIO' : 'ASESOR_COMERCIAL'

              let convenioId: number | null = null
              if ((asesor as any).tipo === 'ASESOR_CONVENIO') {
                const asignacion = await AsesorConvenioAsignacion.query({ client: trx })
                  .where('asesor_id', asesor.id)
                  .where('activo', true)
                  .whereNull('fecha_fin')
                  .first()
                if (asignacion) convenioId = asignacion.convenioId
              }

              // 🆕 Bug fix: cierra dateo(s) viejos en RE_DATEAR de esta misma
              // placa (típicamente de OTRO asesor, ya que este camino solo
              // reutiliza dateoExistente cuando coincide agente_id) antes de
              // crear el nuevo auto-dateo. Reutiliza la trx en curso.
              await cerrarDateosViejosPorPlacaTelefono(
                placa,
                telefono || null,
                'Reemplazado automáticamente — nuevo dateo detectado para otro asesor.',
                trx
              )

              const nuevoDateo = await CaptacionDateo.create(
                {
                  canal: canal as any,
                  agenteId: asesor.id,
                  convenioId,
                  placa,
                  telefono: telefono || null,
                  origen: 'UI',
                  resultado: 'EN_PROCESO',
                  consumidoTurnoId: turno.id,
                  consumidoAt: nowBog,
                  observacion: 'Auto-dateo por teléfono detectado',
                  esAvance: false,
                } as any,
                { client: trx }
              )

              turno.captacionDateoId = nuevoDateo.id
              await turno.useTransaction(trx).save()

              console.log(`✅ Nuevo dateo #${nuevoDateo.id} creado para turno #${turno.id}`)
            }
          }
        } catch (err) {
          console.error('❌ Error en auto-dateo:', err)
        }
      }

      await trx.commit()

      await turno.load('usuario')
      await turno.load('sede')
      await turno.load('servicio')
      await turno.load('vehiculo')
      await turno.load('cliente')
      await turno.load('conductor')
      await turno.load('agenteCaptacion')
      await turno.load('captacionDateo', (q) => q.preload('agente').preload('convenio'))

      return response.created(turno)
    } catch (error: any) {
      try {
        await (trx as any).rollback()
      } catch {}
      if (
        error?.code === 'ER_DUP_ENTRY' &&
        String(error?.sqlMessage ?? error?.message ?? '').includes(
          'uq_turno_activo_por_placa_servicio_dia'
        )
      ) {
        return response.conflict({
          code: 'DUPLICATE_DAY',
          message:
            'Ya existe un turno activo o finalizado hoy para esta placa y servicio en esta sede.',
        })
      }
      // Índice único de B2: una sola segunda vez activa por origen (respaldo
      // en BD del candado de resolverSegundaVez()).
      if (
        error?.code === 'ER_DUP_ENTRY' &&
        String(error?.sqlMessage ?? error?.message ?? '').includes('uq_segunda_vez_origen_activo')
      ) {
        return response.conflict({
          code: 'SEGUNDA_VEZ_NO_DISPONIBLE',
          message: 'El turno de origen ya tiene una segunda vez activa.',
        })
      }
      // Número de turno tomado por otra creación concurrente: store() recalcula
      // y reintenta; agotados los intentos se responde 409 en vez de 500.
      if (esColisionNumeracion(error)) {
        if (!ultimoIntento) throw new ColisionNumeracionTurno()
        console.error('Colisión de numeración persistente al crear turno:', error)
        return response.conflict({
          code: 'TURNO_NUMERO_OCUPADO',
          message:
            'No se pudo asignar un número de turno libre (varias creaciones simultáneas). Intenta de nuevo.',
        })
      }
      if (
        error?.code === 'ER_DUP_ENTRY' &&
        String(error?.sqlMessage ?? error?.message ?? '').includes('turno_codigo')
      ) {
        if (!ultimoIntento) throw new ColisionNumeracionTurno()
        return response.conflict({
          code: 'TURNO_CODIGO_DUPLICADO',
          message: 'Se creó otro turno del mismo servicio en este mismo segundo. Intenta de nuevo.',
        })
      }
      console.error('Error al crear turno:', error)
      return response.internalServerError({
        message: 'Error al crear el turno',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /**
   * Una segunda vez cancelada no vuelve a activarse (activar() o el selector
   * de estado de update()) si su origen ya tiene otra segunda vez activa.
   */
  private async conflictoReactivacionSegundaVez(turno: TurnoRtm, estadoNuevo: string) {
    if (!esTurnoSegundaVez(turno)) return null
    if (turno.estado !== 'cancelado' || estadoNuevo === 'cancelado') return null
    const otro = await otroHijoActivo(turno)
    if (!otro) return null
    return {
      code: 'SEGUNDA_VEZ_YA_ACTIVA',
      message: 'El turno de origen ya tiene otra segunda vez activa; no se puede reactivar esta.',
      hijoActivoId: otro,
    }
  }

  /**
   * Decide si el turno que se está creando es una segunda vez (o una
   * excepción NO_APLICADA) o un turno normal. Devuelve `{ respuesta }` cuando
   * hay que cortar store() con un error, o `{ modo }` (null = turno normal).
   * Corre dentro de la trx de store(): evaluarVentanaSegundaVez() bloquea el
   * origen con FOR UPDATE, así que solo una segunda vez activa por origen.
   */
  private async resolverSegundaVez(opts: {
    request: HttpContext['request']
    auth: HttpContext['auth']
    response: HttpContext['response']
    trx: TransactionClientContract
    placa: string
    servicio: Servicio
  }): Promise<
    | { respuesta: any }
    | {
        modo: {
          tipo: 'SEGUNDA_VEZ' | 'NO_APLICADA'
          origen: TurnoRtm
          excepcion: 'FORZADA' | 'NO_APLICADA' | null
          excepcionPorId: number | null
          motivo: string | null
        } | null
      }
  > {
    const { request, auth, response, trx, placa, servicio } = opts
    const ahora = DateTime.now().setZone('America/Bogota')

    const origenIdRaw = request.input('segundaVezOrigenId')
    const origenIdPedido =
      origenIdRaw !== undefined && origenIdRaw !== null && origenIdRaw !== ''
        ? Number(origenIdRaw)
        : null
    const excepcion = String(request.input('segundaVezExcepcion') ?? '')
      .toUpperCase()
      .trim()
    const motivo = String(request.input('segundaVezMotivo') ?? '').trim()

    if (origenIdPedido !== null && !Number.isInteger(origenIdPedido)) {
      return {
        respuesta: response.unprocessableEntity({ message: 'segundaVezOrigenId inválido' }),
      }
    }
    if (excepcion && excepcion !== 'FORZADA' && excepcion !== 'NO_APLICADA') {
      return {
        respuesta: response.unprocessableEntity({
          message: 'segundaVezExcepcion debe ser FORZADA o NO_APLICADA',
        }),
      }
    }

    if (!aplicaSegundaVez(servicio.codigoServicio)) {
      if (origenIdPedido !== null || excepcion) {
        return {
          respuesta: response.unprocessableEntity({
            code: 'SEGUNDA_VEZ_NO_APLICA_SERVICIO',
            message: `La segunda vez solo aplica a RTM y PREV (servicio: ${servicio.codigoServicio}).`,
          }),
        }
      }
      return { modo: null }
    }

    // Excepción manual: solo SUPER_ADMIN / GERENCIA (rol del usuario
    // autenticado, no el usuarioId del body) y con motivo obligatorio.
    let excepcionPorId: number | null = null
    if (excepcion) {
      const user = auth.user
      if (user) await (user as any).load('rol')
      const rol = (user as any)?.rol?.nombre ?? ''
      if (!user || !['SUPER_ADMIN', 'GERENCIA'].includes(rol)) {
        return {
          respuesta: response.forbidden({
            code: 'SEGUNDA_VEZ_EXCEPCION_NO_AUTORIZADA',
            message: 'Solo SUPER_ADMIN o GERENCIA pueden forzar o desactivar la segunda vez.',
          }),
        }
      }
      if (motivo.length < 5 || motivo.length > 255) {
        return {
          respuesta: response.unprocessableEntity({
            code: 'SEGUNDA_VEZ_MOTIVO_REQUERIDO',
            message: 'El motivo de la excepción es obligatorio (entre 5 y 255 caracteres).',
          }),
        }
      }
      excepcionPorId = user.id
    }

    // ── FORZADA: segunda vez aunque la ventana no esté abierta.
    if (excepcion === 'FORZADA') {
      if (origenIdPedido === null) {
        return {
          respuesta: response.unprocessableEntity({
            code: 'SEGUNDA_VEZ_ORIGEN_REQUERIDO',
            message: 'Para forzar la segunda vez indica el turno rechazado de origen.',
          }),
        }
      }
      const origen = await TurnoRtm.query({ client: trx })
        .where('id', origenIdPedido)
        .forUpdate()
        .first()
      const hijo = origen ? await hijoActivoDeOrigen(origen) : null
      const valido =
        !!origen &&
        origen.placa === placa &&
        origen.servicioId === servicio.id &&
        origen.estado === 'finalizado' &&
        origen.resultadoCertificacion === 'RECHAZADA' &&
        hijo === null
      if (!valido) {
        return {
          respuesta: response.conflict({
            code: 'SEGUNDA_VEZ_FORZADA_INVALIDA',
            message:
              'Solo se puede forzar la segunda vez sobre un turno RECHAZADO y finalizado de la misma placa y servicio que no tenga ya una segunda vez activa.',
            hijoActivoId: hijo,
          }),
        }
      }
      return {
        modo: {
          tipo: 'SEGUNDA_VEZ',
          origen: origen!,
          excepcion: 'FORZADA',
          excepcionPorId,
          motivo,
        },
      }
    }

    // ── Detección automática
    const ev = await evaluarVentanaSegundaVez(placa, servicio.id, ahora, trx)

    if (ev?.estado !== 'ABIERTA') {
      if (excepcion === 'NO_APLICADA' || origenIdPedido !== null) {
        return {
          respuesta: response.conflict({
            code: 'SEGUNDA_VEZ_NO_DISPONIBLE',
            message:
              'Esta placa ya no tiene una ventana de segunda vez abierta para este servicio.',
            ventana: ev ? serializarVentana(ev) : null,
          }),
        }
      }
      return { modo: null }
    }

    if (excepcion === 'NO_APLICADA') {
      return {
        modo: {
          tipo: 'NO_APLICADA',
          origen: ev.origen,
          excepcion: 'NO_APLICADA',
          excepcionPorId,
          motivo,
        },
      }
    }

    if (origenIdPedido !== ev.origen.id) {
      return {
        respuesta: response.conflict({
          code: 'SEGUNDA_VEZ_DISPONIBLE',
          message: `Esta placa tiene una segunda vez gratuita disponible hasta ${ev.hasta.toFormat('dd/LL/yyyy HH:mm')}. Confírmala para continuar.`,
          ventana: serializarVentana(ev),
        }),
      }
    }

    return {
      modo: {
        tipo: 'SEGUNDA_VEZ',
        origen: ev.origen,
        excepcion: null,
        excepcionPorId: null,
        motivo: null,
      },
    }
  }

  /**
   * Busca el turno no-cancelado que choca con (sedeId, servicioId, fecha, placa)
   * y devuelve el cuerpo del 409 DUPLICATE_DAY enriquecido con datos del turno
   * en conflicto (o null si no hay). Compartido entre el pre-chequeo de
   * update() y el catch de ER_DUP_ENTRY, para que ambos caminos den al
   * operador la misma info. Devuelve el cuerpo (no llama a response.conflict,
   * que devuelve void): el llamador hace `return response.conflict(cuerpo)`.
   */
  private async buscarConflictoDuplicado(opts: {
    sedeId: number
    servicioId: number
    fechaISO: string
    placa: string
    excludeTurnoId?: number
  }) {
    let query = Database.from('turnos_rtms as t')
      .leftJoin('usuarios as u', 'u.id', 't.funcionario_id')
      .where('t.sede_id', opts.sedeId)
      .andWhere('t.servicio_id', opts.servicioId)
      .andWhere('t.fecha', opts.fechaISO)
      .andWhere('t.placa', opts.placa)
      .whereNot('t.estado', 'cancelado')

    if (opts.excludeTurnoId !== undefined) {
      query = query.whereNot('t.id', opts.excludeTurnoId)
    }

    const turnoConflicto = await query
      .select('t.id as id', 't.turno_codigo as turno_codigo', 'u.nombres', 'u.apellidos')
      .first()

    if (!turnoConflicto) return null

    const nombreFuncionario =
      [turnoConflicto.nombres, turnoConflicto.apellidos].filter(Boolean).join(' ').trim() || null

    return {
      code: 'DUPLICATE_DAY',
      message: `Ya existe el turno ${turnoConflicto.turno_codigo} para esta placa y servicio hoy, creado por ${nombreFuncionario ?? 'otro usuario'}. Si ese turno es un error, cancélalo en la pantalla de turnos en vez de editarle el servicio a este.`,
      conflictoConTurnoId: turnoConflicto.id,
      conflictoConTurnoCodigo: turnoConflicto.turno_codigo,
      conflictoConFuncionario: nombreFuncionario,
    }
  }

  /** Actualizar turno */
  public async update({ params, request, response }: HttpContext) {
    let turno: TurnoRtm | null = null
    try {
      const raw = request.only([
        'placa',
        'telefono',
        'tipoVehiculo',
        'observaciones',
        'usuarioId',
        'horaSalida',
        'tiempoServicio',
        'estado',
        'servicioId',
        'servicioCodigo',
        'canal',
        'agenteCaptacionId',
        'clienteId',
        'vehiculoId',
        'fecha',
        'horaIngreso',
        'conductorId',
        'conductorTelefono',
        'conductorNombre',
        'asesorDetectadoId',
      ])

      const idNumericoUsuario = Number(raw.usuarioId)

      if (Number.isNaN(idNumericoUsuario) || idNumericoUsuario <= 0) {
        console.error('❌ [TURNO-UPDATE] ID inválido:', idNumericoUsuario)
        return response.badRequest({ message: 'usuarioId inválido' })
      }

      const usuarioActualizador = await Usuario.query()
        .where('id', idNumericoUsuario)
        .preload('sede')
        .first()

      console.log('🔍 [TURNO-UPDATE] Usuario:', {
        id: usuarioActualizador?.id,
        correo: usuarioActualizador?.correo,
        sedeId: usuarioActualizador?.sedeId,
      })
      if (!usuarioActualizador)
        return response.unauthorized({ message: `Usuario ${idNumericoUsuario} no encontrado` })

      turno = await TurnoRtm.find(params.id)
      if (!turno) return response.notFound({ message: 'Turno no encontrado' })

      let tipoVehiculoNext: TipoVehiculoDB | undefined
      if (raw.tipoVehiculo) {
        if (!VALID_TIPOS_VEHICULO.includes(raw.tipoVehiculo as TipoVehiculoDB)) {
          return response.badRequest({
            message: `tipoVehiculo inválido. Debe ser uno de: ${VALID_TIPOS_VEHICULO.join(', ')}`,
          })
        }
        tipoVehiculoNext = raw.tipoVehiculo as TipoVehiculoDB
      }

      let servicioIdNext: number | undefined
      let servicioCodigoNext: string | undefined
      if (raw.servicioId) {
        const sid = Number(raw.servicioId)
        if (Number.isNaN(sid))
          return response.badRequest({ message: 'servicioId debe ser numérico' })
        const s = await Servicio.find(sid)
        if (!s) return response.badRequest({ message: `Servicio id ${sid} no existe` })
        servicioIdNext = s.id
        servicioCodigoNext = s.codigoServicio
      } else if (raw.servicioCodigo) {
        const s = await Servicio.query()
          .where('codigo_servicio', String(raw.servicioCodigo))
          .first()
        if (!s)
          return response.badRequest({
            message: `Servicio código '${raw.servicioCodigo}' no existe`,
          })
        servicioIdNext = s.id
        servicioCodigoNext = s.codigoServicio
      }

      // ✅ FIX: Recalcular turno_numero_servicio cuando cambia el servicio
      let turnoNumeroServicioNext: number | undefined
      if (servicioIdNext && servicioIdNext !== turno.servicioId) {
        const fechaISO = (turno.fecha as DateTime).toISODate()!
        const rowSvc = await Database.from('turnos_rtms')
          .where('sede_id', turno.sedeId)
          .where('servicio_id', servicioIdNext)
          .where('fecha', fechaISO)
          .where('turno_numero_servicio', '>', 0)
          .whereNot('id', turno.id)
          .max('turno_numero_servicio as max')
          .first()

        turnoNumeroServicioNext = Number(rowSvc?.max ?? 0) + 1
        console.log(
          `🔄 Cambiando servicio ${turno.servicioId} → ${servicioIdNext}, nuevo turno_numero_servicio: ${turnoNumeroServicioNext}`
        )
      }

      let canalAtribucionNext: (CanalAtrib | null) | undefined
      if (raw.canal !== undefined) {
        canalAtribucionNext = normalizeCanal(raw.canal)
      }

      let medioBDNext: MedioEntero | undefined
      if (canalAtribucionNext) {
        medioBDNext = medioFromCanal(canalAtribucionNext)
      }

      let estadoVal: 'activo' | 'inactivo' | 'cancelado' | 'finalizado' | undefined
      if (raw.estado) {
        const ok = ['activo', 'inactivo', 'cancelado', 'finalizado']
        if (!ok.includes(raw.estado)) {
          return response.badRequest({
            message: `Estado inválido. Debe ser uno de: ${ok.join(', ')}`,
          })
        }
        estadoVal = raw.estado as any
      }

      let fechaNext: DateTime | undefined
      if (raw.fecha) {
        const f = DateTime.fromISO(String(raw.fecha), { zone: 'America/Bogota' })
        if (!f.isValid) return response.badRequest({ message: 'Fecha inválida (YYYY-MM-DD)' })
        fechaNext = f
      }
      let horaIngresoNext: string | undefined
      if (raw.horaIngreso) {
        const hi = parseHoraIngresoToHHmm(String(raw.horaIngreso))
        if (!hi)
          return response.badRequest({ message: 'Hora de ingreso inválida (HH:mm o HH:mm:ss)' })
        horaIngresoNext = hi
      }

      let conductorIdNext: number | null | undefined
      const conductorTelefono = normalizePhone(raw.conductorTelefono)

      if (raw.conductorId !== undefined) {
        conductorIdNext = Number(raw.conductorId) || null
      } else if (conductorTelefono || raw.conductorNombre) {
        let cExist: Conductor | null = null
        if (conductorTelefono) {
          cExist = await Conductor.query().where('telefono', conductorTelefono).first()
        }
        if (cExist) {
          conductorIdNext = cExist.id
        } else {
          const nuevoConductor = await Conductor.create({
            nombre: String(raw.conductorNombre || 'Conductor'),
            telefono: conductorTelefono || null,
          } as any)
          conductorIdNext = nuevoConductor.id
        }
      }

      const placaNext = raw.placa ? normalizePlaca(raw.placa)! : turno.placa
      const fechaEfectiva = fechaNext ?? (turno.fecha as DateTime)
      const servicioIdEfectivo = servicioIdNext ?? turno.servicioId
      const estadoEfectivo = estadoVal ?? turno.estado

      // ✅ FIX: si cambia servicioId, placa o fecha, revalidar que la nueva
      // combinación sede+fecha+servicio+placa no choque con otro turno no
      // cancelado (mismo criterio que dupDiario en store()).
      const cambiaClaveDedupe =
        servicioIdEfectivo !== turno.servicioId ||
        placaNext !== turno.placa ||
        fechaEfectiva.toISODate() !== (turno.fecha as DateTime).toISODate()

      // ── Segunda vez: placa/servicio/fecha no se cambian en una segunda vez
      // ni en un origen con segunda vez activa (rompería el vínculo
      // origen↔hija), el origen no se cancela/inhabilita con hija activa, y
      // una segunda vez cancelada no se reactiva si ya hay otra activa.
      const hijoActivoId = await hijoActivoDeOrigen(turno)
      if (cambiaClaveDedupe && (esTurnoSegundaVez(turno) || hijoActivoId)) {
        return response.conflict({
          code: 'SEGUNDA_VEZ_CAMPOS_BLOQUEADOS',
          message: esTurnoSegundaVez(turno)
            ? 'En un turno de segunda vez no se puede cambiar placa, servicio ni fecha.'
            : 'Este turno tiene una segunda vez activa: no se puede cambiar placa, servicio ni fecha.',
          hijoActivoId,
        })
      }
      if (
        hijoActivoId &&
        (estadoVal === 'cancelado' || estadoVal === 'inactivo') &&
        estadoVal !== turno.estado
      ) {
        return response.conflict(conflictoOrigenConHijoActivo(hijoActivoId))
      }
      if (estadoVal) {
        const conflictoSv = await this.conflictoReactivacionSegundaVez(turno, estadoVal)
        if (conflictoSv) return response.conflict(conflictoSv)
      }

      // ── RTM/PREV solo se finalizan por Certificación (resultado obligatorio):
      // el selector de estado de Editar turno no puede pasarlos a 'finalizado'.
      if (estadoVal === 'finalizado' && turno.estado !== 'finalizado') {
        const servicioActual = servicioCodigoNext ? null : await Servicio.find(turno.servicioId)
        const codigoServicioEfectivo = servicioCodigoNext ?? servicioActual?.codigoServicio
        if (aplicaSegundaVez(codigoServicioEfectivo)) {
          return response.conflict(conflictoFinalizarSinCertificacion(codigoServicioEfectivo))
        }
      }

      if (cambiaClaveDedupe && estadoEfectivo !== 'cancelado') {
        const conflicto = await this.buscarConflictoDuplicado({
          sedeId: turno.sedeId,
          servicioId: servicioIdEfectivo,
          fechaISO: fechaEfectiva.toISODate()!,
          placa: placaNext,
          excludeTurnoId: turno.id,
        })
        if (conflicto) return response.conflict(conflicto)
      }

      // ✅ FIX: regenerar turno_codigo cuando cambia el servicio, conservando
      // el sufijo/timestamp original y sustituyendo solo el prefijo.
      let turnoCodigoNext: string | undefined
      if (servicioIdNext && servicioIdNext !== turno.servicioId && servicioCodigoNext) {
        const partes = turno.turnoCodigo.split('-')
        const sufijo = partes.length > 1 ? partes.slice(1).join('-') : turno.turnoCodigo
        turnoCodigoNext = `${servicioCodigoNext}-${sufijo}`
      }

      turno.merge({
        placa: placaNext,
        tipoVehiculo: tipoVehiculoNext ?? turno.tipoVehiculo,
        observaciones: raw.observaciones ?? turno.observaciones ?? null,
        horaSalida: raw.horaSalida ?? turno.horaSalida ?? null,
        tiempoServicio: raw.tiempoServicio ?? turno.tiempoServicio ?? null,
        estado: estadoVal ?? turno.estado,
        servicioId: servicioIdNext ?? turno.servicioId,
        clienteId: raw.clienteId !== undefined ? Number(raw.clienteId) || null : turno.clienteId,
        vehiculoId:
          raw.vehiculoId !== undefined ? Number(raw.vehiculoId) || null : turno.vehiculoId,
        ...(fechaNext ? { fecha: fechaNext } : {}),
        ...(horaIngresoNext ? { horaIngreso: horaIngresoNext } : {}),
        ...(canalAtribucionNext !== undefined ? { canalAtribucion: canalAtribucionNext } : {}),
        ...(medioBDNext ? { medioEntero: medioBDNext } : {}),
        ...(raw.agenteCaptacionId !== undefined
          ? { agenteCaptacionId: Number(raw.agenteCaptacionId) || null }
          : {}),
        ...(conductorIdNext !== undefined ? { conductorId: conductorIdNext } : {}),
        // ✅ FIX: aplicar nuevo número de turno por servicio si cambió
        ...(turnoNumeroServicioNext !== undefined
          ? { turnoNumeroServicio: turnoNumeroServicioNext }
          : {}),
        ...(turnoCodigoNext ? { turnoCodigo: turnoCodigoNext } : {}),
      })

      await turno.save()
      await turno.load('usuario')
      await turno.load('sede')
      await turno.load('servicio')
      await turno.load('vehiculo')
      await turno.load('cliente')
      await turno.load('conductor')
      await turno.load('agenteCaptacion')
      await turno.load('captacionDateo', (q) => q.preload('agente').preload('convenio'))

      return response.ok(turno)
    } catch (error: any) {
      if (
        error?.code === 'ER_DUP_ENTRY' &&
        String(error?.sqlMessage ?? error?.message ?? '').includes(
          'uq_turno_activo_por_placa_servicio_dia'
        )
      ) {
        if (turno) {
          const conflicto = await this.buscarConflictoDuplicado({
            sedeId: turno.sedeId,
            servicioId: turno.servicioId,
            fechaISO: (turno.fecha as DateTime).toISODate()!,
            placa: turno.placa,
            excludeTurnoId: turno.id,
          })
          if (conflicto) return response.conflict(conflicto)
        }
        return response.conflict({
          code: 'DUPLICATE_DAY',
          message:
            'Ya existe otro turno activo o finalizado hoy para esta placa y servicio en esta sede.',
        })
      }
      console.error('Error al actualizar turno:', error)
      return response.internalServerError({ message: 'Error al actualizar el turno' })
    }
  }

  /** Activar turno */
  public async activar({ params, response, request }: HttpContext) {
    try {
      const { usuarioId } = request.only(['usuarioId'])
      if (!usuarioId) return response.unauthorized({ message: 'usuarioId requerido' })

      const idNumericoUsuario = Number(usuarioId)
      if (Number.isNaN(idNumericoUsuario))
        return response.badRequest({ message: 'usuarioId inválido' })
      const usuarioOperador = await Usuario.find(idNumericoUsuario)
      if (!usuarioOperador)
        return response.unauthorized({ message: `Usuario ${idNumericoUsuario} no encontrado` })

      const turno = await TurnoRtm.find(params.id)
      if (!turno) return response.notFound({ message: 'Turno no encontrado' })

      const conflictoSv = await this.conflictoReactivacionSegundaVez(turno, 'activo')
      if (conflictoSv) return response.conflict(conflictoSv)

      turno.estado = 'activo'
      await turno.save()
      return response.ok({ message: 'Turno activado', turnoId: turno.id })
    } catch (error) {
      console.error('Error al activar:', error)
      return response.internalServerError({ message: 'Error al activar el turno' })
    }
  }

  /** Cancelar turno */
  public async cancelar({ params, response, request }: HttpContext) {
    try {
      const { usuarioId, motivoCancelacion } = request.only(['usuarioId', 'motivoCancelacion'])
      if (!usuarioId) return response.unauthorized({ message: 'usuarioId requerido' })

      const idNumericoUsuario = Number(usuarioId)
      if (Number.isNaN(idNumericoUsuario))
        return response.badRequest({ message: 'usuarioId inválido' })
      const usuarioOperador = await Usuario.find(idNumericoUsuario)
      if (!usuarioOperador)
        return response.unauthorized({ message: `Usuario ${idNumericoUsuario} no encontrado` })

      const motivo = typeof motivoCancelacion === 'string' ? motivoCancelacion.trim() : ''
      if (motivo.length < 5) {
        return response.badRequest({
          message: 'Debes indicar el motivo de la cancelación (mínimo 5 caracteres).',
        })
      }

      const turno = await TurnoRtm.find(params.id)
      if (!turno) return response.notFound({ message: 'Turno no encontrado' })

      const hijoActivoId = await hijoActivoDeOrigen(turno)
      if (hijoActivoId) {
        return response.conflict(conflictoOrigenConHijoActivo(hijoActivoId))
      }

      turno.estado = 'cancelado'
      turno.motivoCancelacion = motivo
      turno.canceladoPorId = idNumericoUsuario
      turno.canceladoAt = DateTime.local().setZone('America/Bogota')

      if (turno.turnoNumero && turno.turnoNumero > 0) {
        turno.turnoNumero = -turno.turnoNumero
      }
      const tAny = turno as any
      if (tAny.turnoNumeroServicio && tAny.turnoNumeroServicio > 0) {
        tAny.turnoNumeroServicio = -tAny.turnoNumeroServicio
      }

      await turno.save()
      return response.ok({ message: 'Turno cancelado', turnoId: turno.id })
    } catch (error) {
      console.error('Error al cancelar:', error)
      return response.internalServerError({ message: 'Error al cancelar el turno' })
    }
  }

  /** Inhabilitar turno */
  public async destroy({ params, response, request }: HttpContext) {
    try {
      const { usuarioId } = request.only(['usuarioId'])
      if (!usuarioId) return response.unauthorized({ message: 'usuarioId requerido' })

      const idNumericoUsuario = Number(usuarioId)
      if (Number.isNaN(idNumericoUsuario))
        return response.badRequest({ message: 'usuarioId inválido' })
      const usuarioOperador = await Usuario.find(idNumericoUsuario)
      if (!usuarioOperador)
        return response.unauthorized({ message: `Usuario ${idNumericoUsuario} no encontrado` })

      const turno = await TurnoRtm.find(params.id)
      if (!turno) return response.notFound({ message: 'Turno no encontrado' })

      const hijoActivoId = await hijoActivoDeOrigen(turno)
      if (hijoActivoId) {
        return response.conflict(conflictoOrigenConHijoActivo(hijoActivoId))
      }

      turno.estado = 'inactivo'
      await turno.save()
      return response.ok({ message: 'Turno inhabilitado (soft delete)' })
    } catch (error) {
      console.error('Error al inhabilitar:', error)
      return response.internalServerError({ message: 'Error al inhabilitar el turno' })
    }
  }

  /** Registrar salida */
  public async registrarSalida({ params, response, request }: HttpContext) {
    try {
      const { usuarioId } = request.only(['usuarioId'])
      if (!usuarioId) return response.unauthorized({ message: 'usuarioId requerido' })

      const idNumericoUsuario = Number(usuarioId)
      if (Number.isNaN(idNumericoUsuario))
        return response.badRequest({ message: 'usuarioId inválido' })
      const usuarioOperador = await Usuario.find(idNumericoUsuario)
      if (!usuarioOperador)
        return response.unauthorized({ message: `Usuario ${idNumericoUsuario} no encontrado` })

      const turno = await TurnoRtm.query().where('id', params.id).preload('servicio').first()
      if (!turno) return response.notFound({ message: 'Turno no encontrado' })

      if (esTurnoSegundaVez(turno)) {
        return response.conflict(
          conflictoTurnoSegundaVez('registro de salida (pasa por Certificación)')
        )
      }
      // RTM/PREV solo se finalizan por Certificación (resultado obligatorio).
      if (aplicaSegundaVez(turno.servicio?.codigoServicio)) {
        return response.conflict(conflictoFinalizarSinCertificacion(turno.servicio?.codigoServicio))
      }

      const salida = DateTime.local().setZone('America/Bogota')

      let entrada = DateTime.fromFormat(turno.horaIngreso, 'HH:mm:ss', {
        zone: 'America/Bogota',
      })
      if (!entrada.isValid) {
        entrada = DateTime.fromFormat(turno.horaIngreso, 'HH:mm', { zone: 'America/Bogota' })
      }

      let diff = salida.diff(entrada, ['hours', 'minutes']).toObject()
      if ((diff.hours ?? 0) < 0 || (diff.minutes ?? 0) < 0) {
        diff = { hours: 0, minutes: 0 }
      }

      let tiempoServicioStr = ''
      if (diff.hours && diff.hours >= 1) tiempoServicioStr += `${Math.floor(diff.hours)} h `
      tiempoServicioStr += `${Math.round((diff.minutes ?? 0) % 60)} min`

      turno.horaSalida = salida.toFormat('HH:mm:ss')
      turno.tiempoServicio = tiempoServicioStr
      turno.estado = 'finalizado'
      await turno.save()

      // 🆕 Para servicios NO RTM (PREV, PERITAJE) → marcar dateo EXITOSO al finalizar turno
      // Regla compartida con Certificación (marcarDateoExitosoAlFinalizarNoRtm):
      // solo dateos del mismo servicio del turno.
      if ((turno as any).captacionDateoId) {
        try {
          const codigoServicio = turno.servicio?.codigoServicio ?? ''
          const dateoId = await marcarDateoExitosoAlFinalizarNoRtm(turno, codigoServicio)
          if (dateoId) {
            console.log(`✅ Dateo ${dateoId} marcado EXITOSO (turno ${codigoServicio} finalizado)`)
          }
        } catch (e) {
          console.error('❌ Error marcando EXITOSO en registrarSalida:', e)
        }
      }

      return response.ok({
        message: 'Hora de salida registrada',
        horaSalida: turno.horaSalida,
        tiempoServicio: turno.tiempoServicio,
        estado: turno.estado,
      })
    } catch (error) {
      console.error('Error al registrar salida:', error)
      return response.internalServerError({ message: 'Error al registrar salida' })
    }
  }

  /** Siguiente número de turno */
  public async siguienteTurno({ request, response }: HttpContext) {
    try {
      const { usuarioId, servicioId, servicioCodigo } = request.qs()

      if (!usuarioId) return response.badRequest({ message: 'usuarioId requerido' })
      const idNumericoUsuario = Number(usuarioId)
      if (Number.isNaN(idNumericoUsuario)) {
        return response.badRequest({ message: 'usuarioId inválido' })
      }

      const usuarioSolicitante = await Usuario.find(idNumericoUsuario)
      if (!usuarioSolicitante) {
        return response.badRequest({ message: `Usuario ${idNumericoUsuario} no encontrado` })
      }
      if (!usuarioSolicitante.sedeId) {
        return response.badRequest({ message: 'El usuario no tiene sede asignada' })
      }

      const hoy = DateTime.local().setZone('America/Bogota').toISODate()!

      // Hueco global disponible (slot más pequeño liberado por un cancelado)
      const slotsClamadosSig = Database.from('turnos_rtms')
        .select('reasignado_de_turno_id')
        .where('sede_id', usuarioSolicitante.sedeId)
        .where('fecha', hoy)
        .whereNotNull('reasignado_de_turno_id')

      const huecoGlobalSig = await Database.from('turnos_rtms')
        .select(Database.raw('ABS(turno_numero) AS slot_libre'))
        .where('sede_id', usuarioSolicitante.sedeId)
        .where('fecha', hoy)
        .where('estado', 'cancelado')
        .where('turno_numero', '<', 0)
        .whereNotIn('id', slotsClamadosSig)
        .orderByRaw('ABS(turno_numero) ASC')
        .limit(1)
        .first()

      let siguiente: number
      if (huecoGlobalSig?.slot_libre != null) {
        siguiente = Number(huecoGlobalSig.slot_libre)
      } else {
        const rowGlobal = await Database.from('turnos_rtms')
          .where('fecha', hoy)
          .andWhere('sede_id', usuarioSolicitante.sedeId)
          .where('turno_numero', '>', 0)
          .max('turno_numero as max')
          .first()
        siguiente = Number(rowGlobal?.max ?? 0) + 1
      }

      let siguientePorServicio: number | null = null
      if (servicioId || servicioCodigo) {
        let sid: number | null = null
        if (servicioId) {
          const s = await Servicio.find(Number(servicioId))
          if (!s) return response.badRequest({ message: `Servicio id ${servicioId} no existe` })
          sid = s.id
        } else if (servicioCodigo) {
          const s = await Servicio.query().where('codigo_servicio', String(servicioCodigo)).first()
          if (!s)
            return response.badRequest({
              message: `Servicio código '${servicioCodigo}' no existe`,
            })
          sid = s.id
        }

        const huecoSvcSig = await Database.from('turnos_rtms')
          .select(Database.raw('ABS(turno_numero_servicio) AS slot_svc_libre'))
          .where('sede_id', usuarioSolicitante.sedeId)
          .where('fecha', hoy)
          .where('servicio_id', sid!)
          .where('estado', 'cancelado')
          .where('turno_numero_servicio', '<', 0)
          .orderByRaw('ABS(turno_numero_servicio) ASC')
          .limit(1)
          .first()

        if (huecoSvcSig?.slot_svc_libre != null) {
          siguientePorServicio = Number(huecoSvcSig.slot_svc_libre)
        } else {
          const rowSvc = await Database.from('turnos_rtms')
            .where('fecha', hoy)
            .andWhere('sede_id', usuarioSolicitante.sedeId)
            .andWhere('servicio_id', sid!)
            .where('turno_numero_servicio', '>', 0)
            .max('turno_numero_servicio as max')
            .first()
          siguientePorServicio = Number(rowSvc?.max ?? 0) + 1
        }
      }

      return response.ok({
        siguiente,
        siguientePorServicio,
        sedeId: usuarioSolicitante.sedeId,
      })
    } catch (error) {
      console.error('Error en siguienteTurno:', error)
      return response.internalServerError({ message: 'Error al obtener el siguiente número' })
    }
  }

  /** Exportar Excel */
  public async exportExcel({ request, response }: HttpContext) {
    const {
      fechaInicio,
      fechaFin,
      servicioId,
      servicioCodigo,
      canalAtribucion,
      agenteId,
      agenteTipo,
    } = request.qs()

    try {
      if (!fechaInicio || !fechaFin) {
        return response.badRequest({
          message: 'fechaInicio y fechaFin son obligatorios (YYYY-MM-DD)',
        })
      }
      const fi = DateTime.fromISO(String(fechaInicio), { zone: 'America/Bogota' }).startOf('day')
      const ff = DateTime.fromISO(String(fechaFin), { zone: 'America/Bogota' }).endOf('day')
      if (!fi.isValid || !ff.isValid) {
        return response.badRequest({ message: 'Fechas inválidas. Use YYYY-MM-DD' })
      }

      const q = TurnoRtm.query()
        .preload('usuario')
        .preload('sede')
        .preload('servicio')
        .preload('agenteCaptacion')
        .preload('conductor')
        .preload('facturacionFuncionario')
        .preload('certificacionFuncionario')
        .whereBetween('fecha', [toMySQLDate(fi), toMySQLDate(ff)])

      if (servicioId) {
        const servicioIds = String(servicioId)
          .split(',')
          .map((id) => Number(id.trim()))
          .filter((n) => !Number.isNaN(n))
        if (servicioIds.length > 0) {
          q.whereIn('servicio_id', servicioIds)
        }
      } else if (servicioCodigo) {
        const codigos = String(servicioCodigo)
          .split(',')
          .map((c) => c.trim().toUpperCase())
        const servicios = await Servicio.query().whereIn('codigo_servicio', codigos)
        if (servicios.length > 0) {
          q.whereIn(
            'servicio_id',
            servicios.map((s) => s.id)
          )
        }
      }

      if (canalAtribucion) {
        const allowed: CanalAtrib[] = ['FACHADA', 'ASESOR', 'TELE', 'REDES', 'GOOGLE_ADS']
        const canales = String(canalAtribucion)
          .split(',')
          .map((c) => c.trim().toUpperCase())
          .filter((c) => allowed.includes(c as CanalAtrib))

        if (canales.length > 0) {
          q.whereIn('canal_atribucion', canales as CanalAtrib[])
        }
      }
      if (agenteId) q.where('agente_captacion_id', Number(agenteId))
      if (agenteTipo) {
        q.whereHas('agenteCaptacion', (qq) => qq.where('tipo', String(agenteTipo)))
      }

      const turnos = await q.orderBy('fecha', 'asc').orderBy('turno_numero', 'asc')

      const workbook = new ExcelJS.Workbook()
      const worksheet = workbook.addWorksheet('Reporte Turnos')

      worksheet.columns = [
        { header: 'Fecha', key: 'fecha', width: 14, style: { numFmt: 'yyyy-mm-dd' } },
        { header: 'Turno Global', key: 'turnoGlobal', width: 14 },
        { header: 'Turno Servicio', key: 'turnoServicio', width: 16 },
        { header: 'Servicio', key: 'servicio', width: 18 },
        // Marca operativa: la segunda vez (reinspección gratuita) se lista, pero no es ingreso.
        { header: '2ª vez', key: 'segundaVez', width: 8 },
        { header: 'Hora Ingreso', key: 'horaIngreso', width: 12 },
        { header: 'Hora Salida', key: 'horaSalida', width: 12 },
        { header: 'Tiempo Servicio', key: 'tiempoServicio', width: 16 },
        { header: 'Placa', key: 'placa', width: 12 },
        { header: 'Tipo Vehículo', key: 'tipoVehiculo', width: 18 },
        { header: 'Canal Atribución', key: 'canalAtribucion', width: 16 },
        { header: 'Agente', key: 'agente', width: 28 },
        { header: 'Observaciones', key: 'observaciones', width: 40 },
        { header: 'Estado', key: 'estado', width: 12 },
        { header: 'Responsable Puerta', key: 'usuario', width: 26 },
        { header: 'Sede', key: 'sede', width: 18 },
        { header: 'Conductor', key: 'conductor', width: 28 },
        { header: 'Hora Facturación', key: 'horaFacturacion', width: 16 },
        { header: 'Responsable Facturación', key: 'responsableFacturacion', width: 28 },
        { header: 'Hora Certificación', key: 'horaCertificacion', width: 16 },
        { header: 'Responsable Certificación', key: 'responsableCertificacion', width: 28 },
      ]

      turnos.forEach((t) => {
        const fechaExcel = t.fecha?.toJSDate ? t.fecha.toJSDate() : undefined
        const agente = (t as any).agenteCaptacion
          ? `${(t as any).agenteCaptacion.nombre} (${(t as any).agenteCaptacion.tipo})`
          : '-'

        const isCancelOrInactive = t.estado === 'cancelado' || t.estado === 'inactivo'

        const turnoGlobal = isCancelOrInactive ? '' : t.turnoNumero
        const turnoServicioRaw =
          (t as any).turnoNumeroServicio ?? (t as any).turno_numero_servicio ?? ''
        const turnoServicio = isCancelOrInactive ? '' : turnoServicioRaw

        const conductor = (t as any).conductor ? `${(t as any).conductor.nombre}` : '-'

        // Mismo mapeo de etapas que getEtapas() en TurnosDelDia.vue (Puerta ya
        // cubierta por Hora Ingreso/Usuario), fuente única: turno_etapas_service.
        // Certificación no aplica a SOAT, y los responsables se ocultan si el
        // turno quedó cancelado/inactivo.
        // Segunda vez: no aplica Facturación (se deja en blanco, como
        // Certificación en SOAT).
        const etapasTurno = getEtapasRequeridas(t.servicio?.codigoServicio, esTurnoSegundaVez(t))
        const esSOAT = !etapasTurno.includes('certificacion')
        const sinFacturacion = !etapasTurno.includes('facturacion')
        const facturacionFuncionario = (t as any).facturacionFuncionario
        const certificacionFuncionario = (t as any).certificacionFuncionario

        const horaFacturacion = sinFacturacion ? '' : t.horaFacturacion || '-'
        const responsableFacturacion = sinFacturacion
          ? ''
          : !isCancelOrInactive && facturacionFuncionario
            ? `${facturacionFuncionario.nombres} ${facturacionFuncionario.apellidos}`
            : '-'

        const horaCertificacion = esSOAT ? '' : t.horaSalida || '-'
        const responsableCertificacion = esSOAT
          ? ''
          : !isCancelOrInactive && certificacionFuncionario
            ? `${certificacionFuncionario.nombres} ${certificacionFuncionario.apellidos}`
            : '-'

        worksheet.addRow({
          fecha: fechaExcel,
          turnoGlobal,
          turnoServicio,
          servicio: t.servicio ? t.servicio.codigoServicio : '-',
          segundaVez: esTurnoSegundaVez(t) ? 'Sí' : '',
          horaIngreso: t.horaIngreso,
          horaSalida: t.horaSalida || '-',
          tiempoServicio: t.tiempoServicio || '-',
          placa: t.placa,
          tipoVehiculo: t.tipoVehiculo,
          // Los demás canales se exportan con su código (FACHADA, REDES…);
          // Google ADS con su nombre.
          canalAtribucion:
            (t as any).canalAtribucion === 'GOOGLE_ADS'
              ? 'Google ADS'
              : ((t as any).canalAtribucion ?? '-'),
          agente,
          observaciones: t.observaciones || '-',
          estado: t.estado,
          usuario: t.usuario ? `${t.usuario.nombres} ${t.usuario.apellidos}` : '-',
          sede: t.sede ? t.sede.nombre : '-',
          conductor,
          horaFacturacion,
          responsableFacturacion,
          horaCertificacion,
          responsableCertificacion,
        })
      })

      const buffer = await workbook.xlsx.writeBuffer()
      const fileName = `reporte_turnos_${DateTime.local()
        .setZone('America/Bogota')
        .toISODate()}.xlsx`

      response.header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      response.header('Content-Disposition', `attachment; filename="${fileName}"`)
      return response.send(buffer)
    } catch (error) {
      console.error('Error exportExcel:', error)
      return response.internalServerError({ message: 'Error al generar el Excel' })
    }
  }
}
