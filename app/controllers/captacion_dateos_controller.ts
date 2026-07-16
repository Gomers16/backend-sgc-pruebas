
// app/controllers/captacion_dateos_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import fs from 'node:fs/promises'
import CaptacionDateo, { Canal, Origen } from '#models/captacion_dateo'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import TurnoRtm from '#models/turno_rtm'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import Prospecto from '#models/prospecto'
import Descuento from '#models/descuento' // 🆕
import Servicio from '#models/servicio' // 🆕 servicio del dateo
import Comision from '#models/comision'
import { buildReserva, invalidateHorasExclusividadCache } from '#services/reserva_dateo_service'

/* ======================= Constantes / Tipos ======================= */
const CANALES_DB = ['FACHADA', 'ASESOR_COMERCIAL', 'ASESOR_CONVENIO', 'TELE', 'REDES'] as const
type CanalDb = (typeof CANALES_DB)[number]
const CANAL_ALIAS_ASESOR = ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'] as const

const ORIGENES = ['UI', 'WHATSAPP', 'IMPORT'] as const
type OrigenVal = (typeof ORIGENES)[number]

const RESULTADOS = ['PENDIENTE', 'EN_PROCESO', 'EXITOSO', 'NO_EXITOSO', 'RE_DATEAR'] as const
type Resultado = (typeof RESULTADOS)[number]

function normalizePlaca(v?: string | null) {
  return v ? v.replace(/[\s-]/g, '').toUpperCase() : (v ?? null)
}
function normalizePhone(v?: string | null) {
  return v ? v.replace(/\D/g, '') : (v ?? null)
}
function diasVentanaPreRtm() {
  return Number(process.env.DIAS_VENTANA_PRE_RTM ?? 10)
}
/** Reserva/ventana de exclusividad — ver #services/reserva_dateo_service */

/** Formato AM/PM Bogotá */
function fmtBogotaAmPm(iso?: string) {
  if (!iso) return ''
  return DateTime.fromISO(iso).setZone('America/Bogota').toFormat('dd/LL/yy hh:mm a')
}

/** Alias camelCase -> snake_case para el front */
function toSnake(row: any) {
  return {
    ...row,
    created_at: row.createdAt,
    created_at_fmt: fmtBogotaAmPm(row.createdAt),
    liberado: row.liberado ?? false,
    imagen_url: row.imagenUrl ?? null,
    imagen_mime: row.imagenMime ?? null,
    imagen_tamano_bytes: row.imagenTamanoBytes ?? null,
    imagen_hash: row.imagenHash ?? null,
    imagen_origen_id: row.imagenOrigenId ?? null,
    imagen_subida_por: row.imagenSubidaPor ?? null,
    consumido_turno_id: row.consumidoTurnoId ?? null,
    consumido_at: row.consumidoAt ?? null,
    // 🆕
    descuento_id: row.descuentoId ?? null,
    // ========== 🆕 AVANCE ==========
    es_avance: row.esAvance ?? false,
    comprobante_avance_url: row.comprobanteAvanceUrl ?? null,
    // ================================
    // 🆕 Excepción RTM_VIGENTE (SUPER_ADMIN / GERENCIA)
    aprobado_excepcion_por: row.aprobadoExcepcionPor ?? null,
    aprobado_excepcion_at: row.aprobadoExcepcionAt ?? null,
    aprobado_excepcion_por_nombre: row.aprobadoExcepcionUsuario
      ? `${row.aprobadoExcepcionUsuario.nombres ?? ''} ${row.aprobadoExcepcionUsuario.apellidos ?? ''}`.trim() ||
        null
      : null,
  }
}

/** Número opcional ('' → null) */
function readOptionalNumber(input: unknown): number | null {
  if (input === undefined || input === null) return null
  const s = String(input).trim()
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

/** 🔎 Construye el bloque turnoInfo para la UI */
function serializeTurnoInfo(t: any | null) {
  if (!t) return null
  const fechaISO = t.fecha?.toISODate ? t.fecha.toISODate() : t.fecha || null
  const numeroServicio = (t as any).turnoNumeroServicio ?? (t as any).turno_numero_servicio ?? null
  return {
    id: t.id ?? null,
    fecha: fechaISO,
    numeroGlobal: t.turnoNumero ?? null,
    numeroServicio: numeroServicio,
    estado: t.estado ?? null,
    servicioCodigo: (t as any).$preloaded?.servicio?.codigoServicio ?? null,
    // 🆕 Campos para clasificar tipo de cliente en ficha comercial
    es_recurrente: t.esRecurrente ?? t.es_recurrente ?? null,
    es_recuperacion: t.esRecuperacion ?? t.es_recuperacion ?? null,
    meses_desde_ultima_visita: t.mesesDesdeUltimaVisita ?? t.meses_desde_ultima_visita ?? null,
  }
}

export default class CaptacionDateosController {
  /**
   * GET /captacion-dateos/config/exclusividad
   * Devuelve las horas de exclusividad configuradas para buildReserva()
   * (bloqueo de placa/teléfono mientras el dateo esté sin consumir).
   */
  public async exclusividadConfigGet({ response }: HttpContext) {
    const { default: ConfiguracionReservaDateo } = await import(
      '#models/configuracion_reserva_dateo'
    )

    let config = await ConfiguracionReservaDateo.query().first()
    if (!config) {
      config = await ConfiguracionReservaDateo.create({ horasExclusividad: 60 } as any)
    }

    return response.ok({ horas_exclusividad: config.horasExclusividad })
  }

  /**
   * POST /captacion-dateos/config/exclusividad
   * Actualiza las horas de exclusividad. body: { horas_exclusividad }
   */
  public async exclusividadConfigUpsert({ request, response }: HttpContext) {
    const { default: ConfiguracionReservaDateo } = await import(
      '#models/configuracion_reserva_dateo'
    )

    const raw = request.input('horas_exclusividad')
    const horas = Math.trunc(Number(raw))
    if (!Number.isFinite(horas) || horas <= 0) {
      return response.badRequest({
        message: 'horas_exclusividad debe ser un número entero mayor a 0',
      })
    }

    let config = await ConfiguracionReservaDateo.query().first()
    if (!config) {
      config = await ConfiguracionReservaDateo.create({ horasExclusividad: horas } as any)
    } else {
      config.horasExclusividad = horas
      await config.save()
    }

    invalidateHorasExclusividadCache()

    return response.ok({ horas_exclusividad: config.horasExclusividad })
  }

  /**
   * POST /captacion-dateos/verificar-vencidos
   *
   * 🎯 PROPÓSITO:
   * Revisa dateos que cumplen TODAS estas condiciones:
   * 1. Estado PENDIENTE
   * 2. NO liberados (liberado = false)
   * 3. Llevan más de 72 horas desde su creación
   *
   * COMPORTAMIENTO:
   * - Si tiene prospecto_id → desarchiva prospecto + ELIMINA dateo
   * - Si NO tiene prospecto_id → marca como RE_DATEAR + libera
   */
  public async verificarVencidos({ response }: HttpContext) {
    const minutosVencimiento = 72 * 60

    console.log(`🔍 Buscando dateos vencidos (>= ${minutosVencimiento} minutos)`)

    const dateosVencidos = await CaptacionDateo.query()
      .where('resultado', 'PENDIENTE')
      .where('liberado', false)
      .whereRaw('TIMESTAMPDIFF(MINUTE, created_at, NOW()) >= ?', [minutosVencimiento])
      .preload('prospecto')

    console.log(`📊 Se encontraron ${dateosVencidos.length} dateo(s) vencido(s)`)

    let procesados = 0

    for (const dateo of dateosVencidos) {
      const trx = await db.transaction()
      try {
        if (dateo.prospecto) {
          dateo.prospecto.archivado = false
          await dateo.prospecto.useTransaction(trx).save()
          console.log(`✅ Prospecto ${dateo.prospecto.id} desarchivado`)

          const placaNormalizada = dateo.placa?.replace(/[\s-]/g, '').toUpperCase()
          if (placaNormalizada) {
            const resultadoPlaca = await Prospecto.query({ client: trx })
              .where('archivado', true)
              .whereRaw("REPLACE(REPLACE(UPPER(placa), '-', ''), ' ', '') = ?", [placaNormalizada])
              .update({ archivado: false })

            console.log(
              `✅ Se desarchivaron ${resultadoPlaca} prospecto(s) adicionales con placa ${placaNormalizada}`
            )
          }

          await dateo.useTransaction(trx).delete()
          console.log(`🗑️ Dateo ${dateo.id} eliminado (prospecto revertido)`)
        } else {
          dateo.liberado = true
          dateo.resultado = 'RE_DATEAR'
          const notaVencimiento = '[AUTO] Vencido por inactividad - Disponible para re-dateo'
          dateo.observacion = dateo.observacion
            ? `${dateo.observacion}\n${notaVencimiento}`
            : notaVencimiento
          await dateo.useTransaction(trx).save()
          console.log(`🔄 Dateo ${dateo.id} marcado como RE_DATEAR y liberado`)
        }

        await trx.commit()
        procesados++
      } catch (e) {
        await trx.rollback()
        console.error(`❌ Error procesando dateo ${dateo.id}:`, e)
      }
    }

    return response.ok({
      message: `Se procesaron ${procesados} dateo(s) vencido(s)`,
      procesados: dateosVencidos.length,
      exitosos: procesados,
      fallidos: dateosVencidos.length - procesados,
      total: dateosVencidos.length,
    })
  }

  /** GET /captacion-dateos */
  public async index({ request }: HttpContext) {
    const page = Number(request.input('page', 1))
    const perPage = Math.min(Number(request.input('perPage', 20)), 1000)

    const placa = normalizePlaca(request.input('placa') as string | undefined)
    const telefono = normalizePhone(request.input('telefono') as string | undefined)

    const canalReq = String(request.input('canal') || '').toUpperCase()
    const canalIsAsesor = canalReq === 'ASESOR'
    const canalDb: CanalDb | undefined = (CANALES_DB as readonly string[]).includes(canalReq)
      ? (canalReq as CanalDb)
      : undefined

    const agenteId = readOptionalNumber(
      (request.input('agente_id') ?? request.input('agenteId')) as unknown
    )
    const convenioId = readOptionalNumber(
      (request.input('convenio_id') ?? request.input('convenioId')) as unknown
    )

    const resultado = request.input('resultado') as Resultado | undefined
    const consumido = request.input('consumido') as 'true' | 'false' | undefined
    const desde = request.input('desde') as string | undefined
    const hasta = request.input('hasta') as string | undefined

    const sortBy = String(request.input('sortBy', 'id'))
    const order = String(request.input('order', 'desc')).toLowerCase() === 'asc' ? 'asc' : 'desc'
    const SORT_WHITELIST: Record<string, string> = {
      id: 'id',
      placa: 'placa',
      telefono: 'telefono',
      created_at: 'created_at',
      resultado: 'resultado',
      consumido_turno_id: 'consumido_turno_id',
    }
    const sortCol = SORT_WHITELIST[sortBy] || 'created_at'

    const q = CaptacionDateo.query()
      .preload('agente')
      .preload('convenio', (qb) => qb.select(['id', 'nombre']))
      .preload('descuento') // 🆕
      .preload('aprobadoExcepcionUsuario', (qb) => qb.select(['id', 'nombres', 'apellidos'])) // 🆕

    if (placa) q.andWhere('placa', placa)
    if (telefono) q.andWhere('telefono', telefono)

    if (canalIsAsesor) {
      q.whereIn('canal', CANAL_ALIAS_ASESOR as unknown as string[])
    } else if (canalDb) {
      q.andWhere('canal', canalDb)
    }

    if (agenteId !== null) q.andWhere('agente_id', agenteId)
    if (convenioId !== null) q.andWhere('convenio_id', convenioId)

    if (resultado && (RESULTADOS as readonly string[]).includes(resultado))
      q.andWhere('resultado', resultado)
    if (consumido === 'true') q.andWhereNotNull('consumido_turno_id')
    if (consumido === 'false') q.andWhereNull('consumido_turno_id')
    if (desde) q.andWhere('created_at', '>=', `${desde} 00:00:00`)
    if (hasta) q.andWhere('created_at', '<=', `${hasta} 23:59:59`)

    q.orderBy(sortCol, order as 'asc' | 'desc')

    const result = await q.paginate(page, perPage)
    const serialized = result.serialize().data as any[]

    const turnoIds = serialized
      .map((r) => r.consumidoTurnoId)
      .filter((v: unknown): v is number => typeof v === 'number' && Number.isFinite(v))

    let turnosById: Record<number, any> = {}
    if (turnoIds.length) {
      const uniq = Array.from(new Set(turnoIds))
      // 🆕 se agregan es_recurrente, es_recuperacion, meses_desde_ultima_visita al select
      const turnos = await TurnoRtm.query()
        .whereIn('id', uniq)
        .preload('servicio')
        .select([
          'id',
          'fecha',
          'turnoNumero',
          'turno_numero_servicio',
          'estado',
          'servicio_id',
          'es_recurrente',
          'es_recuperacion',
          'meses_desde_ultima_visita',
        ])
      turnosById = Object.fromEntries(turnos.map((t) => [t.id, t]))
    }

    const data = serialized.map((row: any) => {
      const base = {
        ...row,
        canal: (['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'] as const).includes(row.canal)
          ? 'ASESOR'
          : row.canal,
      }
      const snake = toSnake(base)
      const t = snake.consumido_turno_id ? turnosById[snake.consumido_turno_id] : null
      return {
        ...snake,
        turnoInfo: serializeTurnoInfo(t),
      }
    })

    return {
      data,
      total: result.total,
      page: result.currentPage,
      perPage: result.perPage,
      lastPage: result.lastPage,
    }
  }

  /** GET /captacion-dateos/:id */
  public async show({ params, response }: HttpContext) {
    const item = await CaptacionDateo.query()
      .where('id', params.id)
      .preload('agente')
      .preload('convenio', (qb) => qb.select(['id', 'nombre']))
      .preload('descuento') // 🆕
      .preload('aprobadoExcepcionUsuario', (qb) => qb.select(['id', 'nombres', 'apellidos'])) // 🆕
      .first()

    if (!item) return response.notFound({ message: 'Dateo no encontrado' })

    const out = item.serialize() as any
    out.canal = (['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'] as const).includes(out.canal)
      ? 'ASESOR'
      : out.canal

    let turnoInfo = null
    if (item.consumidoTurnoId) {
      // 🆕 se agregan es_recurrente, es_recuperacion, meses_desde_ultima_visita al select
      const t = await TurnoRtm.query()
        .where('id', item.consumidoTurnoId)
        .preload('servicio')
        .select([
          'id',
          'fecha',
          'turnoNumero',
          'turno_numero_servicio',
          'estado',
          'servicio_id',
          'es_recurrente',
          'es_recuperacion',
          'meses_desde_ultima_visita',
        ])
        .first()
      turnoInfo = serializeTurnoInfo(t)
    }

    const reserva = await buildReserva(item)
    return { ...toSnake(out), reserva, turnoInfo }
  }
  /**
   * POST /captacion-dateos
   */
  public async store({ request, response, auth }: HttpContext) {
    let agenteId = readOptionalNumber(
      (request.input('agente_id') ?? request.input('agenteId')) as unknown
    )

    let agente: AgenteCaptacion | null = null

    if (agenteId === null && auth.user) {
      agente = await AgenteCaptacion.findBy('usuarioId', auth.user.id)
      if (agente) {
        agenteId = agente.id
      }
    }

    let canalRaw = String(request.input('canal') || '').toUpperCase()
    if (!canalRaw) canalRaw = 'ASESOR'

    let canal: CanalDb

    if (canalRaw === 'ASESOR') {
      if (!agente && agenteId !== null) {
        agente = await AgenteCaptacion.find(agenteId)
      }

      const tipo = (agente?.tipo || '').toUpperCase()
      if (tipo === 'ASESOR_CONVENIO') {
        canal = 'ASESOR_CONVENIO'
      } else {
        canal = 'ASESOR_COMERCIAL'
      }
    } else if ((CANALES_DB as readonly string[]).includes(canalRaw)) {
      canal = canalRaw as CanalDb
    } else {
      return response.badRequest({ message: 'canal inválido' })
    }

    let convenioId = readOptionalNumber(
      (request.input('convenio_id') ?? request.input('convenioId')) as unknown
    )
    let convenio: Convenio | null = null

    if (convenioId !== null) {
      convenio = await Convenio.find(convenioId)
      if (!convenio) return response.badRequest({ message: 'convenio_id no existe' })
    }

    const placa = normalizePlaca(request.input('placa') as string | undefined)
    const telefono = normalizePhone(request.input('telefono') as string | undefined)
    const origen = request.input('origen') as OrigenVal
    const observacion = (request.input('observacion') as string | undefined) ?? null

    const imagenUrl = (request.input('imagen_url') as string | undefined) ?? null
    const imagenMime = (request.input('imagen_mime') as string | undefined) ?? null
    const imagenTamanoBytesRaw = request.input('imagen_tamano_bytes') as number | string | undefined
    const imagenTamanoBytes =
      imagenTamanoBytesRaw === undefined || imagenTamanoBytesRaw === null
        ? null
        : Number(imagenTamanoBytesRaw)
    const imagenHash = (request.input('imagen_hash') as string | undefined) ?? null
    const imagenOrigenId =
      (request.input('imagen_origen_id') as string | number | undefined) ?? null
    const imagenSubidaPor = readOptionalNumber(request.input('imagen_subida_por') as unknown)

    // 🆕 Descuento informativo pre-marcado por el comercial
    const descuentoIdRaw = readOptionalNumber(
      (request.input('descuento_id') ?? request.input('descuentoId')) as unknown
    )
    let descuentoId: number | null = null
    if (descuentoIdRaw !== null) {
      const descuentoExiste = await Descuento.query()
        .where('id', descuentoIdRaw)
        .where('activo', true)
        .first()
      if (!descuentoExiste) {
        return response.badRequest({ message: 'descuento_id no existe o está inactivo' })
      }
      descuentoId = descuentoIdRaw
    }

    // 🆕 Servicio para el que se datéa (opcional, default = RTM)
    const servicioDateoId = readOptionalNumber(
      (request.input('servicio_id') ?? request.input('servicioId')) as unknown
    )
    let servicioDateo: Servicio | null = null
    if (servicioDateoId !== null) {
      servicioDateo = await Servicio.find(servicioDateoId)
      if (!servicioDateo) {
        return response.badRequest({ message: 'servicio_id no existe' })
      }
    }
    // ========== 🆕 AVANCE ==========
    /**
     * es_avance:
     *   - Si es ASESOR_CONVENIO quien datéa → comprobante no es obligatorio (él mismo pide el avance)
     *   - Si es ASESOR_COMERCIAL quien datéa → comprobante_avance_url ES OBLIGATORIO
     */
    const esAvance = Boolean(
      request.input('es_avance') === true ||
        request.input('es_avance') === 'true' ||
        request.input('esAvance') === true ||
        request.input('esAvance') === 'true'
    )

    let comprobanteAvanceUrl: string | null =
      (request.input('comprobante_avance_url') as string | undefined) ?? null

    if (esAvance && canal === 'ASESOR_COMERCIAL' && !comprobanteAvanceUrl) {
      return response.badRequest({
        message:
          'comprobante_avance_url es obligatorio cuando el asesor comercial solicita un avance en nombre del convenio.',
      })
    }

    // Si el canal no es de asesor, avance no aplica
    if (esAvance && canal !== 'ASESOR_COMERCIAL' && canal !== 'ASESOR_CONVENIO') {
      return response.badRequest({
        message: 'es_avance solo aplica para canal ASESOR_COMERCIAL o ASESOR_CONVENIO.',
      })
    }
    // ========== FIN AVANCE ==========

    if (!ORIGENES.includes(origen)) {
      return response.badRequest({ message: 'origen inválido (UI | WHATSAPP | IMPORT)' })
    }
    if (!placa) {
      return response.badRequest({ message: 'La placa es obligatoria' })
    }

    if (
      (canal === 'ASESOR_COMERCIAL' || canal === 'ASESOR_CONVENIO' || canal === 'TELE') &&
      agenteId === null
    ) {
      return response.badRequest({ message: 'agente_id es requerido para canal ASESOR/TELE' })
    }

    if (agenteId !== null && !agente) {
      agente = await AgenteCaptacion.find(agenteId)
      if (!agente) return response.badRequest({ message: 'agente_id no existe' })
    }

    let asesorConvenioId: number | null = null

    if (agente && agente.tipo === 'ASESOR_CONVENIO') {
      canal = 'ASESOR_CONVENIO'

      // 🔥 Normalizar nombre: quitar múltiples espacios, trim, uppercase
      const nombreNormalizado = agente.nombre.trim().replace(/\s+/g, ' ').toUpperCase()

      console.log(`🔍 Buscando convenio para asesor: "${nombreNormalizado}"`)

      // 🔥 Buscar TODOS los convenios activos y comparar en JavaScript
      const conveniosActivos = await Convenio.query().where('activo', true).select(['id', 'nombre'])

      console.log(`📊 Se encontraron ${conveniosActivos.length} convenios activos`)

      const convenioDelAsesor = conveniosActivos.find((c) => {
        const nombreConvenioNormalizado = c.nombre.trim().replace(/\s+/g, ' ').toUpperCase()

        const coincide =
          nombreConvenioNormalizado === nombreNormalizado ||
          nombreConvenioNormalizado.startsWith(nombreNormalizado)

        if (coincide) {
          console.log(`✅ Convenio encontrado: "${c.nombre}" (ID: ${c.id})`)
        }

        return coincide
      })

      if (!convenioDelAsesor) {
        console.error(`❌ No se encontró convenio para: "${nombreNormalizado}"`)
        return response.unprocessableEntity({
          message: `El asesor convenio "${agente.nombre}" no tiene un convenio asociado activo. Verifica que exista un convenio que comience con "${agente.nombre}".`,
        })
      }

      if (convenioId !== null && convenioId !== convenioDelAsesor.id) {
        return response.forbidden({
          message:
            'No puede datear para un convenio distinto al que tiene asociado como asesor convenio.',
        })
      }

      convenioId = convenioDelAsesor.id
      convenio = await Convenio.find(convenioDelAsesor.id) // Cargar el convenio completo
      asesorConvenioId = agente.id

      console.log(`✅ Convenio asignado: ID ${convenioId}, Asesor ID ${asesorConvenioId}`)
    } else if (agente && canal === 'ASESOR_COMERCIAL') {
      if (convenioId !== null) {
        const asignacion = await AsesorConvenioAsignacion.query()
          .where('asesor_id', agente.id)
          .where('convenio_id', convenioId)
          .where('activo', true)
          .whereNull('fecha_fin')
          .first()

        if (!asignacion) {
          return response.forbidden({
            message:
              'Este asesor comercial no tiene asignado el convenio seleccionado. No puede datear para él.',
          })
        }
      }
    }

    const ultimo = await CaptacionDateo.query()
      .andWhere((q) => {
        q.orWhere('placa', placa!)
        if (telefono) q.orWhere('telefono', telefono)
      })
      .where('liberado', false)
      .preload('agente', (q) => q.select(['id', 'nombre', 'tipo']))
      .orderBy('created_at', 'desc')
      .first()

    if (ultimo) {
      const reserva = await buildReserva(ultimo)
      if (reserva.vigente) {
        const u = ultimo.serialize() as any
        return response.status(409).send({
          message: 'Ya existe un dateo activo para esta placa/teléfono dentro de la ventana.',
          dateoId: u.id,
          bloqueadoHasta: reserva.bloqueaHasta,
          por: u?.agente?.nombre ?? null,
        })
      }
    }

    // ========================================
    // 🚫 VALIDACIONES DE TURNO
    // ========================================

    // Código del servicio del dateo — se necesita en ambas validaciones
    const codigoServicioDateo = (servicioDateo?.codigoServicio ?? 'RTM').toUpperCase()
    const esDateoParaRtm = codigoServicioDateo === 'RTM'

    // VALIDACIÓN 1: Bloquear si hay turno ACTIVO hoy (el vehículo ya está en la sede)
    const hoyISO = DateTime.local().setZone('America/Bogota').toISODate()!

    const turnoActivoHoy = await TurnoRtm.query()
      .where('placa', placa!)
      .where('fecha', hoyISO)
      .whereIn('estado', ['activo', 'finalizado'])
      .preload('servicio')
      .orderBy('id', 'desc')
      .first()

    // Verificar si el usuario tiene rol privilegiado
    await auth.user!.load('rol')
    const rolNombre = auth.user!.rol?.nombre ?? ''
    const esPrivilegiado = ['SUPER_ADMIN', 'GERENCIA'].includes(rolNombre)

    if (turnoActivoHoy && !esPrivilegiado) {
      const codigoTurnoActivo = (turnoActivoHoy.servicio?.codigoServicio ?? '').toUpperCase()
      // Solo bloquear si el turno activo de hoy es del MISMO servicio que se quiere datear.
      // Caso de uso: cliente llega hoy por SOAT y el comercial lo datéa para RTM futuro → permitido.
      if (codigoTurnoActivo === codigoServicioDateo) {
        return response.conflict({
          code: 'TURNO_ACTIVO',
          message: `Esta placa ya tiene un turno activo de ${codigoTurnoActivo} hoy. El vehículo ya está en la sede, no se puede datear para el mismo servicio.`,
          turnoId: turnoActivoHoy.id,
          turnoNumero: turnoActivoHoy.turnoNumero,
          servicio: codigoTurnoActivo,
          estado: turnoActivoHoy.estado,
        })
      }
    }
    // VALIDACIÓN 2: Bloquear si tiene RTM vigente — solo aplica si el dateo es para RTM

    // 🆕 Excepción controlada para SUPER_ADMIN/GERENCIA: si confirman explícitamente,
    // se permite continuar aunque exceda la ventana de días permitida.
    const confirmarExcepcion =
      request.input('confirmar_excepcion') === true ||
      request.input('confirmar_excepcion') === 'true'

    let excepcionRtmAprobada = false

    if (esDateoParaRtm) {
      const lastRtmFinalizado = await TurnoRtm.query()
        .where('placa', placa!)
        .andWhere('estado', 'finalizado')
        .whereHas('servicio', (q) => {
          q.where('codigo_servicio', 'RTM')
        })
        .preload('servicio')
        .orderBy('fecha', 'desc')
        .first()

      if (lastRtmFinalizado) {
        const fechaUltimoRtm = lastRtmFinalizado.fecha as DateTime
        const caducaEl = fechaUltimoRtm.plus({ months: 12 }).startOf('day')
        const hoy = DateTime.local().setZone('America/Bogota').startOf('day')
        const ventanaPrevia = caducaEl.minus({ days: diasVentanaPreRtm() })

        if (hoy < ventanaPrevia) {
          const diasExcedidos = Math.ceil(ventanaPrevia.diff(hoy, 'days').days)

          if (esPrivilegiado && confirmarExcepcion) {
            // El admin ya confirmó la excepción: se deja continuar y se registra abajo.
            excepcionRtmAprobada = true
          } else if (esPrivilegiado) {
            return response.conflict({
              code: 'RTM_VIGENTE_EXCEPCION_DISPONIBLE',
              message: `Esta placa tiene RTM vigente hasta ${caducaEl.toFormat('dd/LL/yyyy')}. Excede el límite permitido por ${diasExcedidos} día(s).`,
              turnoId: lastRtmFinalizado.id,
              turnoNumero: lastRtmFinalizado.turnoNumero,
              fechaRtm: fechaUltimoRtm.toISODate(),
              validoHasta: caducaEl.toISODate(),
              diasRestantes: Math.ceil(caducaEl.diff(hoy, 'days').days),
              puedeDataearDesde: ventanaPrevia.toISODate(),
              diasExcedidos,
            })
          } else {
            return response.conflict({
              code: 'RTM_VIGENTE',
              message: `Esta placa tiene RTM vigente hasta ${caducaEl.toFormat('dd/LL/yyyy')}. Podrá datear a partir del ${ventanaPrevia.toFormat('dd/LL/yyyy')}.`,
              turnoId: lastRtmFinalizado.id,
              turnoNumero: lastRtmFinalizado.turnoNumero,
              fechaRtm: fechaUltimoRtm.toISODate(),
              validoHasta: caducaEl.toISODate(),
              diasRestantes: Math.ceil(caducaEl.diff(hoy, 'days').days),
              puedeDataearDesde: ventanaPrevia.toISODate(),
            })
          }
        }
      }
    }

    // ========================================
    // FIN VALIDACIONES DE TURNO
    // ========================================

    const created = await CaptacionDateo.create({
      canal: canal as Canal,
      agenteId,
      convenioId,
      asesorConvenioId,
      placa: placa!,
      telefono,
      origen: origen as Origen,
      observacion,
      resultado: 'PENDIENTE',
      imagenUrl,
      imagenMime,
      imagenTamanoBytes,
      imagenHash,
      imagenOrigenId: imagenOrigenId === null ? null : String(imagenOrigenId),
      imagenSubidaPor,
      descuentoId,
      servicioId: servicioDateoId,
      esAvance,
      comprobanteAvanceUrl: esAvance ? comprobanteAvanceUrl : null,
      // Si hay turno activo/finalizado hoy y el usuario es privilegiado → vincular directo
      // Si hay turno activo/finalizado hoy, el usuario es privilegiado
      // Y el turno es del mismo servicio que el dateo → vincular directo
      consumidoTurnoId:
        esPrivilegiado &&
        turnoActivoHoy &&
        (turnoActivoHoy.servicio?.codigoServicio ?? '').toUpperCase() === codigoServicioDateo
          ? turnoActivoHoy.id
          : undefined,
      consumidoAt:
        esPrivilegiado &&
        turnoActivoHoy &&
        (turnoActivoHoy.servicio?.codigoServicio ?? '').toUpperCase() === codigoServicioDateo
          ? DateTime.now()
          : undefined,
      // 🆕 Excepción RTM_VIGENTE: se registra quién (usuario logueado) aprobó, no el asesor
      aprobadoExcepcionPor: excepcionRtmAprobada ? auth.user!.id : undefined,
      aprobadoExcepcionAt: excepcionRtmAprobada ? DateTime.now() : undefined,
    })
    if (placa) {
      try {
        const prospectoEncontrado = await Prospecto.query()
          .where('archivado', false)
          .whereRaw("REPLACE(REPLACE(UPPER(placa), '-', ''), ' ', '') = ?", [placa])
          .first()

        if (prospectoEncontrado) {
          created.prospectoId = prospectoEncontrado.id
          await created.save()
          console.log(`🔗 Dateo ${created.id} vinculado con prospecto ${prospectoEncontrado.id}`)
        }

        const resultadoArch = await Prospecto.query()
          .where('archivado', false)
          .whereRaw("REPLACE(REPLACE(UPPER(placa), '-', ''), ' ', '') = ?", [placa])
          .update({ archivado: true })

        console.log(`✅ Se archivaron ${resultadoArch} prospecto(s) con placa ${placa}`)
      } catch (err) {
        console.error('❌ Error procesando prospectos con placa', placa, err)
      }
    }

    const out = created.serialize() as any
    out.canal = (['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'] as const).includes(out.canal)
      ? 'ASESOR'
      : out.canal
    return response.created(toSnake(out))
  }

  /**
   * PUT /captacion-dateos/:id
   */
  public async update({ params, request, response }: HttpContext) {
    const item = await CaptacionDateo.find(params.id)
    if (!item) return response.notFound({ message: 'Dateo no encontrado' })

    const placa = request.input('placa') as string | undefined
    const telefono = request.input('telefono') as string | undefined
    const canalRaw = request.input('canal') as string | undefined

    const observacion = request.input('observacion') as string | undefined
    const resultado = request.input('resultado') as Resultado | undefined

    const imagenUrl = request.input('imagen_url') as string | undefined
    const imagenMime = request.input('imagen_mime') as string | undefined
    const imagenTamanoBytesRaw = request.input('imagen_tamano_bytes') as number | string | undefined
    const imagenHash = request.input('imagen_hash') as string | undefined
    const imagenOrigenId = request.input('imagen_origen_id') as string | number | undefined
    const imagenSubidaPorRaw = request.input('imagen_subida_por') as unknown

    const consumidoTurnoIdRaw = request.input('consumido_turno_id') as unknown

    // 🆕 Descuento informativo (puede actualizarse o quitarse)
    const descuentoIdInput = request.input('descuento_id')
    if (descuentoIdInput !== undefined) {
      if (descuentoIdInput === null || descuentoIdInput === '') {
        item.descuentoId = null
      } else {
        const descuentoIdNum = readOptionalNumber(descuentoIdInput as unknown)
        if (descuentoIdNum !== null) {
          const descuentoExiste = await Descuento.query()
            .where('id', descuentoIdNum)
            .where('activo', true)
            .first()
          if (!descuentoExiste) {
            return response.badRequest({ message: 'descuento_id no existe o está inactivo' })
          }
          item.descuentoId = descuentoIdNum
        }
      }
    }

    // ========== 🆕 AVANCE: actualizar es_avance y comprobante ==========
    const esAvanceInput = request.input('es_avance') ?? request.input('esAvance')
    if (esAvanceInput !== undefined) {
      const nuevoEsAvance =
        esAvanceInput === true || esAvanceInput === 'true' || esAvanceInput === 1

      // Si se está activando el avance en un dateo de comercial, requiere comprobante
      if (nuevoEsAvance && !item.esAvance && item.canal === 'ASESOR_COMERCIAL') {
        const comprobanteInput =
          (request.input('comprobante_avance_url') as string | undefined) ??
          item.comprobanteAvanceUrl

        if (!comprobanteInput) {
          return response.badRequest({
            message:
              'comprobante_avance_url es obligatorio al activar avance para canal ASESOR_COMERCIAL.',
          })
        }
      }

      item.esAvance = nuevoEsAvance

      // Si se desactiva el avance, limpiar comprobante
      if (!nuevoEsAvance) {
        item.comprobanteAvanceUrl = null
      }
    }

    const comprobanteAvanceUrlInput = request.input('comprobante_avance_url') as string | undefined
    if (comprobanteAvanceUrlInput !== undefined) {
      item.comprobanteAvanceUrl = comprobanteAvanceUrlInput || null
    }
    // ========== FIN AVANCE ==========

    if (placa !== undefined) {
      item.placa = normalizePlaca(placa)

      const hace7Dias = DateTime.now().setZone('America/Bogota').minus({ days: 7 }).toISODate()!
      const turnoVinculado = await TurnoRtm.query()
        .where('placa', item.placa!)
        .where('fecha', '>=', hace7Dias)
        .orderBy('fecha', 'desc')
        .first()

      if (turnoVinculado) {
        item.consumidoTurnoId = turnoVinculado.id
        item.consumidoAt = DateTime.now()
        if (turnoVinculado.estado === 'finalizado') {
          item.resultado = 'EXITOSO'
        }
      }
    }

    if (telefono !== undefined) {
      item.telefono = normalizePhone(telefono)
    }

    if (canalRaw !== undefined) {
      const canalUpper = String(canalRaw).toUpperCase()

      if (canalUpper === 'ASESOR') {
        if (item.canal !== 'ASESOR_COMERCIAL' && item.canal !== 'ASESOR_CONVENIO') {
          item.canal = 'ASESOR_COMERCIAL'
        }
      } else if ((CANALES_DB as readonly string[]).includes(canalUpper)) {
        item.canal = canalUpper as CanalDb
      }
    }

    if (resultado !== undefined) {
      if (!(RESULTADOS as readonly string[]).includes(resultado)) {
        return response.badRequest({ message: 'resultado inválido' })
      }
      item.resultado = resultado
    }

    if (observacion !== undefined) item.observacion = observacion ?? null

    if (imagenUrl !== undefined) item.imagenUrl = imagenUrl || null
    if (imagenMime !== undefined) item.imagenMime = imagenMime || null
    if (imagenTamanoBytesRaw !== undefined) {
      item.imagenTamanoBytes =
        imagenTamanoBytesRaw === null ? null : Number(imagenTamanoBytesRaw as number | string)
    }
    if (imagenHash !== undefined) item.imagenHash = imagenHash || null
    if (imagenOrigenId !== undefined)
      item.imagenOrigenId = imagenOrigenId === null ? null : String(imagenOrigenId)
    if (imagenSubidaPorRaw !== undefined)
      item.imagenSubidaPor = readOptionalNumber(imagenSubidaPorRaw)

    if (consumidoTurnoIdRaw !== undefined) {
      const n = readOptionalNumber(consumidoTurnoIdRaw)
      if (n === null) {
        item.consumidoTurnoId = null
        item.consumidoAt = null
      } else {
        item.consumidoTurnoId = n
        // @ts-ignore
        item.consumidoAt = (item as any).$createDateTime(new Date().toISOString())
      }
    }

    await item.save()

    // Generar comisión PENDIENTE si el dateo quedó EXITOSO y no existe ya una
    if (item.resultado === 'EXITOSO' && item.consumidoTurnoId !== null) {
      const yaExisteComision = await Comision.query()
        .where('captacion_dateo_id', item.id)
        .where('es_config', false)
        .first()

      if (!yaExisteComision) {
        const turnoParaComision = await TurnoRtm.query()
          .where('id', item.consumidoTurnoId)
          .preload('servicio')
          .first()

        if (turnoParaComision) {
          const tipoServicio = (
            (turnoParaComision as any).servicio?.codigoServicio ?? 'RTM'
          ).toUpperCase()
          const tipoVehiculo: 'MOTO' | 'VEHICULO' = (
            turnoParaComision as any
          ).tipoVehiculo?.includes('Motocicleta')
            ? 'MOTO'
            : 'VEHICULO'

          // ── Leer configuración de comisión ──────────────────────────
          const toNum = (v: any) => {
            const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''))
            return Number.isFinite(n) ? n : 0
          }
          const tryFindCfg = (aId: number | null, tv: string | null) => {
            const q = Comision.query().where('es_config', true)
            if (aId === null) q.whereNull('asesor_id')
            else q.where('asesor_id', aId)
            if (tv === null) q.whereNull('tipo_vehiculo')
            else q.where('tipo_vehiculo', tv)
            return q.first()
          }

          const asesorId = item.agenteId
          const asesorConvenioId = item.asesorConvenioId

          let rowComercial: Comision | null = null
          if (asesorId && tipoVehiculo) rowComercial = await tryFindCfg(asesorId, tipoVehiculo)
          if (!rowComercial && asesorId) rowComercial = await tryFindCfg(asesorId, null)
          if (!rowComercial) rowComercial = await tryFindCfg(null, tipoVehiculo)
          if (!rowComercial) rowComercial = await tryFindCfg(null, null)

          let rowIncentivo: Comision | null = null
          if (asesorConvenioId) rowIncentivo = await tryFindCfg(asesorConvenioId, tipoVehiculo)
          if (!rowIncentivo && asesorConvenioId) {
            const m = await tryFindCfg(asesorConvenioId, 'MOTO')
            const v = await tryFindCfg(asesorConvenioId, 'VEHICULO')
            rowIncentivo = m ?? v ?? null
          }
          if (!rowIncentivo) rowIncentivo = await tryFindCfg(null, tipoVehiculo)
          if (!rowIncentivo) rowIncentivo = await tryFindCfg(null, null)

          let valorIncentivoPorTipo = 0
          if (rowIncentivo) {
            if (tipoVehiculo === 'MOTO') {
              valorIncentivoPorTipo =
                rowIncentivo.valorPlacaMoto !== null
                  ? toNum(rowIncentivo.valorPlacaMoto)
                  : toNum(rowIncentivo.base)
            } else {
              valorIncentivoPorTipo =
                rowIncentivo.valorPlacaVehiculo !== null
                  ? toNum(rowIncentivo.valorPlacaVehiculo)
                  : toNum(rowIncentivo.base)
            }
          }
          const valorIncentivo = rowIncentivo ? toNum(rowIncentivo.base) : 14000
          const valorDateoNuevo = toNum(rowComercial?.monto)
          const valorNuevoDirecto = toNum(rowComercial?.valorNuevoDirecto)

          // ── Leer configuración de recurrencia ───────────────────────
          const globalCfg = await db
            .from('configuracion_recurrencia_global')
            .orderBy('id', 'asc')
            .first()
          const esMoto = tipoVehiculo === 'MOTO'
          let valorRecurrente = Number(
            esMoto
              ? (globalCfg?.valor_dateo_recurrencia_moto ??
                  globalCfg?.valor_dateo_recurrencia ??
                  4300)
              : (globalCfg?.valor_dateo_recurrencia_vehiculo ??
                  globalCfg?.valor_dateo_recurrencia ??
                  4300)
          )
          let valorRecuperacion = Number(
            esMoto
              ? (globalCfg?.valor_dateo_recuperacion_moto ??
                  globalCfg?.valor_dateo_recuperacion ??
                  8600)
              : (globalCfg?.valor_dateo_recuperacion_vehiculo ??
                  globalCfg?.valor_dateo_recuperacion ??
                  8600)
          )
          if (asesorId) {
            const asesorCfg = await db
              .from('configuracion_recurrencia_asesores')
              .where('asesor_id', asesorId)
              .where('recurrencia_habilitada', true)
              .first()
            if (asesorCfg?.valor_dateo_recurrencia)
              valorRecurrente = Number(asesorCfg.valor_dateo_recurrencia)
            if (asesorCfg?.valor_dateo_recuperacion)
              valorRecuperacion = Number(asesorCfg.valor_dateo_recuperacion)
          }

          // ── Calcular montos según caso de negocio ───────────────────
          const esRecurrente = Boolean((turnoParaComision as any).esRecurrente)
          const esRecuperacion = Boolean((turnoParaComision as any).esRecuperacion)
          const esClienteNuevo = !esRecurrente && !esRecuperacion
          const esAsesorConvenio = item.canal === 'ASESOR_CONVENIO' || asesorId === asesorConvenioId

          let montoAsesor = 0
          let montoConvenio = 0
          let base = 0
          let valorNuevoDirectoFinal = 0

          if (!item.convenioId) {
            // CASO 1: Sin convenio — comercial datea directo
            montoConvenio = 0
            base = 0
            if (esClienteNuevo) {
              montoAsesor = valorNuevoDirecto
              valorNuevoDirectoFinal = valorNuevoDirecto
            } else if (esRecurrente) {
              montoAsesor = valorRecurrente
            } else {
              montoAsesor = valorRecuperacion
            }
          } else if (esAsesorConvenio) {
            // CASO 2: Asesor convenio se datea a sí mismo
            montoConvenio = 0
            if (item.esAvance) {
              montoAsesor = 0
              base = valorIncentivoPorTipo
            } else {
              montoAsesor = esClienteNuevo ? valorIncentivo : valorRecurrente
              base = valorIncentivo
            }
          } else {
            // CASO 3: Comercial + convenio
            base = valorIncentivoPorTipo
            montoAsesor = valorDateoNuevo
            montoConvenio = item.esAvance
              ? Math.max(0, valorIncentivoPorTipo - 0)
              : valorIncentivoPorTipo
          }

          // ── Crear la comisión ────────────────────────────────────────
          const comision = new Comision()
          comision.esConfig = false
          comision.captacionDateoId = item.id
          comision.asesorId = item.agenteId
          comision.convenioId = item.convenioId
          comision.asesorSecundarioId = item.asesorConvenioId
          comision.montoAsesor = String(montoAsesor)
          comision.montoConvenio = String(montoConvenio)
          comision.monto = String(montoAsesor)
          comision.base = String(base)
          comision.porcentaje = '0'
          comision.valorNuevoDirecto = String(valorNuevoDirectoFinal)
          comision.tipoServicio = tipoServicio as any
          ;(comision as any).tipoVehiculo = tipoVehiculo
          comision.estado = 'PENDIENTE'
          comision.fechaCalculo = DateTime.now()
          comision.metaRtm = 0
          comision.porcentajeComisionMeta = '0'
          comision.valorRtmMoto = 0
          comision.valorRtmVehiculo = 0
          comision.esAvance = item.esAvance ?? false
          await comision.save()
        }
      }
    }

    const out = item.serialize() as any
    out.canal = (['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'] as const).includes(out.canal)
      ? 'ASESOR'
      : out.canal

    let turnoInfo = null
    if (item.consumidoTurnoId) {
      // 🆕 se agregan es_recurrente, es_recuperacion, meses_desde_ultima_visita al select
      const t = await TurnoRtm.query()
        .where('id', item.consumidoTurnoId)
        .preload('servicio')
        .select([
          'id',
          'fecha',
          'turnoNumero',
          'turno_numero_servicio',
          'estado',
          'servicio_id',
          'es_recurrente',
          'es_recuperacion',
          'meses_desde_ultima_visita',
        ])
        .first()
      turnoInfo = serializeTurnoInfo(t)
    }

    const reserva = await buildReserva(item)
    return { ...toSnake(out), reserva, turnoInfo }
  }
  /** DELETE /captacion-dateos/:id */
  public async destroy({ params, response }: HttpContext) {
    const item = await CaptacionDateo.find(params.id)
    if (!item) return response.notFound({ message: 'Dateo no encontrado' })
    await item.delete()
    return response.noContent()
  }

  // ========== 🆕 AVANCE ==========

  /**
   * PATCH /captacion-dateos/:id/avance
   *
   * 🎯 PROPÓSITO:
   * Activa o desactiva el flag es_avance en un dateo existente.
   *
   * BODY:
   *   es_avance: boolean                    (requerido)
   *   comprobante_avance_url?: string        (obligatorio si es_avance=true y canal=ASESOR_COMERCIAL)
   *
   * REGLAS:
   *   - Solo se puede activar avance si el dateo aún NO fue consumido (sin turno asignado).
   *   - Si canal=ASESOR_COMERCIAL y se activa → comprobante obligatorio.
   *   - Si canal=ASESOR_CONVENIO → comprobante no requerido.
   *   - Al desactivar → se limpia comprobante_avance_url.
   */
  public async toggleAvance({ params, request, response }: HttpContext) {
    const item = await CaptacionDateo.find(params.id)
    if (!item) return response.notFound({ message: 'Dateo no encontrado' })

    // Solo se puede modificar avance si el dateo aún no fue consumido por un turno
    if (item.consumidoTurnoId) {
      return response.badRequest({
        message:
          'No se puede modificar es_avance en un dateo que ya fue consumido por un turno. El turno ya heredó el valor original.',
      })
    }

    const esAvanceInput = request.input('es_avance') ?? request.input('esAvance')
    if (esAvanceInput === undefined || esAvanceInput === null) {
      return response.badRequest({ message: 'El campo es_avance es obligatorio.' })
    }

    const nuevoEsAvance = esAvanceInput === true || esAvanceInput === 'true' || esAvanceInput === 1

    // Avance solo aplica para canales de asesor
    if (nuevoEsAvance && item.canal !== 'ASESOR_COMERCIAL' && item.canal !== 'ASESOR_CONVENIO') {
      return response.badRequest({
        message: 'es_avance solo aplica para canal ASESOR_COMERCIAL o ASESOR_CONVENIO.',
      })
    }

    const comprobanteInput = (request.input('comprobante_avance_url') as string | undefined) ?? null

    // Si se activa el avance y el canal es comercial → comprobante obligatorio
    if (nuevoEsAvance && item.canal === 'ASESOR_COMERCIAL') {
      const comprobanteEfectivo = comprobanteInput ?? item.comprobanteAvanceUrl
      if (!comprobanteEfectivo) {
        return response.badRequest({
          message:
            'comprobante_avance_url es obligatorio al activar avance para canal ASESOR_COMERCIAL.',
        })
      }
    }

    item.esAvance = nuevoEsAvance

    if (nuevoEsAvance) {
      // Actualizar comprobante solo si se envió en este request
      if (comprobanteInput !== null) {
        item.comprobanteAvanceUrl = comprobanteInput
      }
    } else {
      // Al desactivar avance → limpiar comprobante
      item.comprobanteAvanceUrl = null
    }

    await item.save()

    console.log(`🆕 toggleAvance dateo ${item.id}: esAvance=${item.esAvance}`)

    const out = item.serialize() as any
    out.canal = (['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'] as const).includes(out.canal)
      ? 'ASESOR'
      : out.canal

    return response.ok(toSnake(out))
  }

  /**
   * GET /captacion-dateos/:id/comprobante-avance
   *
   * 🎯 PROPÓSITO:
   * Sirve el archivo de comprobante de avance (screenshot WhatsApp).
   *
   * COMPORTAMIENTO:
   *   - Si comprobanteAvanceUrl es una URL externa (http/https) → redirect 302.
   *   - Si es una ruta local de disco → stream del archivo.
   *   - Si no tiene comprobante → 404.
   */
  public async servirComprobanteAvance({ params, response }: HttpContext) {
    const item = await CaptacionDateo.query()
      .where('id', params.id)
      .select(['id', 'es_avance', 'comprobante_avance_url'])
      .first()

    if (!item) return response.notFound({ message: 'Dateo no encontrado' })

    if (!item.esAvance) {
      return response.badRequest({ message: 'Este dateo no tiene avance activado.' })
    }

    if (!item.comprobanteAvanceUrl) {
      return response.notFound({ message: 'Este dateo no tiene comprobante de avance.' })
    }

    const url = item.comprobanteAvanceUrl

    // Si es URL externa → redirect
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return response.redirect(url)
    }

    // Si es ruta local → stream
    const rutaAbsoluta = app.makePath('storage', url)

    try {
      await fs.access(rutaAbsoluta)
    } catch {
      return response.notFound({ message: 'Archivo de comprobante no encontrado en disco.' })
    }

    // Detectar mime básico por extensión
    const ext = url.split('.').pop()?.toLowerCase() ?? ''
    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      webp: 'image/webp',
      gif: 'image/gif',
      pdf: 'application/pdf',
    }
    const contentType = mimeMap[ext] ?? 'application/octet-stream'

    response.header('Content-Type', contentType)
    return response.download(rutaAbsoluta)
  }

  // ========== FIN AVANCE ==========

  /** GET /captacion-dateos/verificar-placa */
  public async verificarPlaca({ request, response }: HttpContext) {
    const placa = normalizePlaca(request.input('placa') as string | undefined)
    if (!placa) return response.badRequest({ message: 'placa requerida' })

    const lastRtm = await TurnoRtm.query()
      .where('placa', placa)
      .andWhere('estado', 'finalizado')
      .whereHas('servicio', (q) => q.where('codigo_servicio', 'RTM'))
      .orderBy('fecha', 'desc')
      .first()

    if (!lastRtm) return response.ok({ rtm_vigente: false })

    const fechaUltimoRtm = lastRtm.fecha as DateTime
    const caducaEl = fechaUltimoRtm.plus({ months: 12 }).startOf('day')
    const hoy = DateTime.local().setZone('America/Bogota').startOf('day')
    const ventanaPrevia = caducaEl.minus({ days: diasVentanaPreRtm() })

    const rtmVigente = hoy < caducaEl
    const dentroDeVentana = rtmVigente && hoy >= ventanaPrevia

    return response.ok({
      rtm_vigente: rtmVigente,
      valido_hasta: caducaEl.toISODate(),
      puede_datear_desde: ventanaPrevia.toISODate(),
      dentro_de_ventana: dentroDeVentana,
      dias_restantes: rtmVigente ? Math.ceil(caducaEl.diff(hoy, 'days').days) : 0,
      fecha_rtm: fechaUltimoRtm.toISODate(),
    })
  }
}
