// app/controllers/tramites_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import app from '@adonisjs/core/services/app'
import { mkdir } from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'

import Tramite, { type EstadoTramite } from '#models/tramite'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'

const toMySQLDate = (dt: DateTime) => dt.toFormat('yyyy-LL-dd')

export const TIPOS_TRAMITE = [
  'MATRICULA_REGISTRO',
  'TRASPASO',
  'TRASLADO_MATRICULA_REGISTRO',
  'RADICADO_MATRICULA_REGISTRO',
  'CAMBIO_COLOR',
  'CAMBIO_SERVICIO',
  'REGRABAR_MOTOR',
  'REGRABAR_CHASIS',
  'TRANSFORMACION',
  'DUPLICADO_LICENCIA_TRANSITO',
  'INSCRIPCION_PRENDA',
  'LEVANTA_PRENDA',
  'CANCELACION_MATRICULA_REGISTRO',
  'CAMBIO_PLACAS',
  'DUPLICADO_PLACAS',
  'REMATRICULA',
  'CAMBIO_CARROCERIA',
  'OTROS',
] as const

export const ESTADOS_TRAMITE = ['en_espera', 'en_atencion', 'completado', 'cancelado'] as const

// FIX 4: máquina de estados — sólo estas transiciones son válidas
const TRANSICIONES_VALIDAS: Record<EstadoTramite, EstadoTramite[]> = {
  en_espera: ['en_atencion', 'cancelado'],
  en_atencion: ['completado', 'cancelado'],
  completado: [],
  cancelado: [],
}

function validateTransicion(actual: EstadoTramite, nuevo: EstadoTramite): string | null {
  if (!TRANSICIONES_VALIDAS[actual].includes(nuevo)) {
    return `Transición inválida: no se puede pasar de '${actual}' a '${nuevo}'`
  }
  return null
}

export default class TramitesController {
  /** GET /tramites  — lista con filtros */
  public async index({ request, response }: HttpContext) {
    const {
      fecha,
      fechaInicio,
      fechaFin,
      estado,
      tipoTramite,
      cedula,
      page = 1,
      perPage = 50,
    } = request.qs()

    try {
      const query = Tramite.query().preload('funcionario').preload('sede').preload('servicio')

      // Filtro por defecto: hoy
      if (!fecha && !fechaInicio && !fechaFin) {
        const hoy = DateTime.local().setZone('America/Bogota')
        query.where('fecha', toMySQLDate(hoy))
      }

      if (fechaInicio && fechaFin) {
        const fi = DateTime.fromISO(String(fechaInicio), { zone: 'America/Bogota' })
        const ff = DateTime.fromISO(String(fechaFin), { zone: 'America/Bogota' })
        if (!fi.isValid || !ff.isValid) return response.badRequest({ message: 'Fechas inválidas' })
        query.whereBetween('fecha', [toMySQLDate(fi), toMySQLDate(ff)])
      } else if (fecha) {
        const f = DateTime.fromISO(String(fecha), { zone: 'America/Bogota' })
        if (!f.isValid) return response.badRequest({ message: 'Fecha inválida' })
        query.where('fecha', toMySQLDate(f))
      }

      if (estado) {
        if (!ESTADOS_TRAMITE.includes(estado))
          return response.badRequest({ message: 'estado inválido' })
        query.where('estado', estado)
      }
      if (tipoTramite) {
        if (!TIPOS_TRAMITE.includes(tipoTramite))
          return response.badRequest({ message: 'tipoTramite inválido' })
        query.where('tipo_tramite', tipoTramite)
      }
      if (cedula) {
        query.whereRaw('cedula LIKE ?', [`%${String(cedula)}%`])
      }

      const pageNum = Math.max(1, Number(page) || 1)
      const limit = Math.min(100, Math.max(10, Number(perPage) || 50))

      const result = await query.orderBy('turno_numero', 'asc').paginate(pageNum, limit)

      return response.ok(result)
    } catch (error) {
      console.error('Error en index tramites:', error)
      return response.internalServerError({ message: 'Error al obtener trámites' })
    }
  }

  /** GET /tramites/:id */
  public async show({ params, response }: HttpContext) {
    try {
      const tramite = await Tramite.query()
        .where('id', Number(params.id))
        .preload('funcionario')
        .preload('sede')
        .preload('servicio')
        .first()

      if (!tramite) return response.notFound({ message: 'Trámite no encontrado' })
      return response.ok(tramite)
    } catch (error) {
      console.error('Error en show tramite:', error)
      return response.internalServerError({ message: 'Error al obtener el trámite' })
    }
  }

  /** POST /tramites  — crear desde ventanilla */
  public async store({ request, response }: HttpContext) {
    const trx = await Database.transaction()
    try {
      const raw = request.only([
        'usuarioId',
        'servicioId',
        'nombreCliente',
        'cedula',
        'telefono',
        'email',
        'placa',
        'tipoTramite',
        'observaciones',
        'fecha',
        'horaIngreso',
      ])

      // Validaciones básicas
      if (!raw.usuarioId || !raw.servicioId || !raw.nombreCliente || !raw.cedula) {
        await trx.rollback()
        return response.badRequest({
          message: 'Campos obligatorios: usuarioId, servicioId, nombreCliente, cedula',
        })
      }

      const usuario = await Usuario.query({ client: trx })
        .where('id', Number(raw.usuarioId))
        .preload('sede')
        .first()

      if (!usuario || !usuario.sedeId) {
        await trx.rollback()
        return response.badRequest({
          message: !usuario
            ? `Usuario ${raw.usuarioId} no encontrado`
            : 'Tu usuario no tiene sede asignada',
        })
      }

      const servicio = await Servicio.find(Number(raw.servicioId))
      if (!servicio) {
        await trx.rollback()
        return response.badRequest({ message: 'Servicio no encontrado' })
      }

      const fechaGuardar = raw.fecha
        ? DateTime.fromISO(raw.fecha, { zone: 'America/Bogota' })
        : DateTime.local().setZone('America/Bogota')

      const horaIngreso =
        raw.horaIngreso || DateTime.local().setZone('America/Bogota').toFormat('HH:mm')

      const hoyISO = fechaGuardar.toISODate()!

      const cedulaNorm = String(raw.cedula).replace(/\D/g, '')
      const tramiteExistente = await Tramite.query({ client: trx })
        .where('sede_id', usuario.sedeId)
        .where('fecha', hoyISO)
        .where('cedula', cedulaNorm)
        .first()

      // FIX 1: FOR UPDATE bloquea la lectura del máximo hasta que el INSERT confirme,
      // eliminando la race condition en creaciones concurrentes para la misma sede+fecha.
      const rowMax = await trx
        .from('tramites')
        .where('sede_id', usuario.sedeId)
        .where('fecha', hoyISO)
        .forUpdate()
        .max('turno_numero as max')
        .first()

      const turnoNumero = Number(rowMax?.max ?? 0) + 1

      // FIX 2: milisegundos (SSS) + 4 chars aleatorios eliminan colisiones
      // de turnoCodigo cuando dos trámites se crean dentro del mismo segundo.
      const nowBog = DateTime.local().setZone('America/Bogota')
      const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
      const turnoCodigo = `TRM-${nowBog.toFormat('yyyyMMddHHmmssSSS')}-${rand}`

      const tramite = await Tramite.create(
        {
          sedeId: usuario.sedeId,
          funcionarioId: usuario.id,
          servicioId: servicio.id,
          nombreCliente: String(raw.nombreCliente).trim(),
          cedula: String(raw.cedula).replace(/\D/g, ''),
          telefono: raw.telefono ? String(raw.telefono).replace(/\D/g, '') : null,
          email: raw.email || null,
          placa: raw.placa ? String(raw.placa).toUpperCase().trim() : null,
          tipoTramite: raw.tipoTramite || null,
          observaciones: raw.observaciones || null,
          fecha: fechaGuardar,
          horaIngreso,
          turnoNumero,
          turnoCodigo,
          estado: 'en_espera',
        } as any,
        { client: trx }
      )

      await trx.commit()

      await tramite.load('funcionario')
      await tramite.load('sede')
      await tramite.load('servicio')

      const payload: Record<string, unknown> = tramite.serialize()
      if (tramiteExistente) {
        payload.advertencia = `Ya existe un trámite con esta cédula hoy (Turno #${tramiteExistente.turnoNumero} — ${tramiteExistente.nombreCliente})`
      }
      return response.created(payload)
    } catch (error) {
      try {
        await (trx as any).rollback()
      } catch {}
      console.error('Error al crear trámite:', error)
      return response.internalServerError({
        message: 'Error al crear el trámite',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** POST /tramites/:turnoNumero/agregar — agrega un trámite a un turno existente */
  public async agregarATurno({ params, request, response }: HttpContext) {
    const trx = await Database.transaction()
    try {
      const turnoNumero = Number(params.turnoNumero)
      const raw = request.only([
        'usuarioId',
        'servicioId',
        'nombreCliente',
        'cedula',
        'telefono',
        'email',
        'placa',
        'tipoTramite',
        'observaciones',
        'fecha',
        'horaIngreso',
      ])

      if (!raw.usuarioId || !raw.servicioId || !raw.nombreCliente || !raw.cedula) {
        await trx.rollback()
        return response.badRequest({
          message: 'Campos obligatorios: usuarioId, servicioId, nombreCliente, cedula',
        })
      }

      const usuario = await Usuario.query({ client: trx })
        .where('id', Number(raw.usuarioId))
        .preload('sede')
        .first()

      if (!usuario || !usuario.sedeId) {
        await trx.rollback()
        return response.badRequest({
          message: !usuario
            ? `Usuario ${raw.usuarioId} no encontrado`
            : 'Tu usuario no tiene sede asignada',
        })
      }

      const servicio = await Servicio.find(Number(raw.servicioId))
      if (!servicio) {
        await trx.rollback()
        return response.badRequest({ message: 'Servicio no encontrado' })
      }

      const fechaGuardar = raw.fecha
        ? DateTime.fromISO(raw.fecha, { zone: 'America/Bogota' })
        : DateTime.local().setZone('America/Bogota')

      const hoyISO = fechaGuardar.toISODate()!
      const horaIngreso =
        raw.horaIngreso || DateTime.local().setZone('America/Bogota').toFormat('HH:mm')

      const tramiteRef = await trx
        .from('tramites')
        .where('sede_id', usuario.sedeId)
        .where('fecha', hoyISO)
        .where('turno_numero', turnoNumero)
        .select('turno_codigo')
        .first()

      if (!tramiteRef) {
        await trx.rollback()
        return response.notFound({
          message: `No existe el turno #${turnoNumero} para la sede y fecha indicadas`,
        })
      }

      const tramite = await Tramite.create(
        {
          sedeId: usuario.sedeId,
          funcionarioId: usuario.id,
          servicioId: servicio.id,
          nombreCliente: String(raw.nombreCliente).trim(),
          cedula: String(raw.cedula).replace(/\D/g, ''),
          telefono: raw.telefono ? String(raw.telefono).replace(/\D/g, '') : null,
          email: raw.email || null,
          placa: raw.placa ? String(raw.placa).toUpperCase().trim() : null,
          tipoTramite: raw.tipoTramite || null,
          observaciones: raw.observaciones || null,
          fecha: fechaGuardar,
          horaIngreso,
          turnoNumero,
          turnoCodigo: tramiteRef.turno_codigo,
          estado: 'en_espera',
        } as any,
        { client: trx }
      )

      await trx.commit()

      await tramite.load('funcionario')
      await tramite.load('sede')
      await tramite.load('servicio')

      return response.created(tramite)
    } catch (error) {
      try {
        await (trx as any).rollback()
      } catch {}
      console.error('Error al agregar trámite al turno:', error)
      return response.internalServerError({
        message: 'Error al agregar el trámite',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  /** PUT /tramites/:id  — categorizar / actualizar */
  public async update({ params, request, response }: HttpContext) {
    try {
      // FIX 5: usuarioId se eliminó — llegaba al body pero nunca se procesaba
      const raw = request.only(['tipoTramite', 'estado', 'observaciones', 'resultado', 'placa', 'incluyeCompraventa'])

      const tramite = await Tramite.find(Number(params.id))
      if (!tramite) return response.notFound({ message: 'Trámite no encontrado' })

      if (raw.tipoTramite && !TIPOS_TRAMITE.includes(raw.tipoTramite)) {
        return response.badRequest({ message: 'tipoTramite inválido' })
      }
      if (raw.estado && !ESTADOS_TRAMITE.includes(raw.estado)) {
        return response.badRequest({ message: 'estado inválido' })
      }

      // FIX 4: rechazar transiciones no permitidas por la máquina de estados
      if (raw.estado && raw.estado !== tramite.estado) {
        const errorTransicion = validateTransicion(tramite.estado, raw.estado)
        if (errorTransicion) return response.unprocessableEntity({ message: errorTransicion })
      }

      const nowBog = DateTime.local().setZone('America/Bogota')

      // Registrar hora de atención automáticamente
      if (raw.estado === 'en_atencion' && !tramite.horaAtencion) {
        tramite.horaAtencion = nowBog.toFormat('HH:mm:ss')
      }

      // Registrar hora de fin y calcular tiempo
      if ((raw.estado === 'completado' || raw.estado === 'cancelado') && !tramite.horaFin) {
        tramite.horaFin = nowBog.toFormat('HH:mm:ss')

        if (tramite.horaAtencion) {
          const entrada = DateTime.fromFormat(tramite.horaAtencion, 'HH:mm:ss', {
            zone: 'America/Bogota',
          })
          const diff = nowBog.diff(entrada, ['hours', 'minutes']).toObject()
          let t = ''
          if ((diff.hours ?? 0) >= 1) t += `${Math.floor(diff.hours!)} h `
          t += `${Math.round((diff.minutes ?? 0) % 60)} min`
          tramite.tiempoAtencion = t
        }
      }

      // Si el tipo efectivo (tras el update) no es TRASPASO, forzar incluyeCompraventa = false
      const effectiveTipo = raw.tipoTramite ?? tramite.tipoTramite

      tramite.merge({
        ...(raw.tipoTramite ? { tipoTramite: raw.tipoTramite } : {}),
        ...(raw.estado ? { estado: raw.estado } : {}),
        ...(raw.observaciones !== undefined ? { observaciones: raw.observaciones } : {}),
        ...(raw.resultado !== undefined ? { resultado: raw.resultado } : {}),
        ...(raw.placa !== undefined
          ? { placa: raw.placa ? String(raw.placa).toUpperCase().trim() : null }
          : {}),
        ...(effectiveTipo && effectiveTipo !== 'TRASPASO'
          ? { incluyeCompraventa: false }
          : (raw.incluyeCompraventa !== undefined ? { incluyeCompraventa: raw.incluyeCompraventa } : {})),
      })

      await tramite.save()
      await tramite.load('funcionario')
      await tramite.load('sede')
      await tramite.load('servicio')

      return response.ok(tramite)
    } catch (error) {
      console.error('Error al actualizar trámite:', error)
      return response.internalServerError({ message: 'Error al actualizar el trámite' })
    }
  }

  /** POST /tramites/:id/pago */
  public async registrarPago({ params, request, response }: HttpContext) {
    try {
      const tramite = await Tramite.find(Number(params.id))
      if (!tramite) return response.notFound({ message: 'Trámite no encontrado' })

      const formaPagoCobro  = request.input('formaPagoCobro')  as string | undefined
      const fechaPagoRaw    = request.input('fechaPago')        as string | undefined
      const referenciaPago  = request.input('referenciaPago')   as string | undefined
      const valorLiquidado  = request.input('valorLiquidado')

      if (!formaPagoCobro || !fechaPagoRaw) {
        return response.badRequest({ message: 'formaPagoCobro y fechaPago son requeridos' })
      }

      const fechaPago = DateTime.fromISO(fechaPagoRaw, { zone: 'America/Bogota' })
      if (!fechaPago.isValid) {
        return response.badRequest({ message: 'fechaPago inválida — use formato YYYY-MM-DD' })
      }

      let evidenciaPagoUrl: string | null = null
      const evidencia = request.file('evidencia', { size: '10mb', extnames: ['jpg', 'jpeg', 'png', 'pdf', 'webp'] })

      if (evidencia && evidencia.tmpPath) {
        if (evidencia.hasErrors) {
          return response.badRequest({ message: evidencia.errors[0]?.message ?? 'Archivo inválido' })
        }
        const pagoDir = app.makePath('uploads', 'pagos')
        await mkdir(pagoDir, { recursive: true })
        const ext  = evidencia.extname ?? 'png'
        const name = `pago-tramite-${tramite.id}-${Date.now()}.${ext}`
        const dest = `${pagoDir}/${name}`
        await pipeline(createReadStream(evidencia.tmpPath), createWriteStream(dest))
        evidenciaPagoUrl = `/api/uploads/pagos/${name}`
      }

      tramite.merge({
        estadoPago:     'pagado',
        formaPagoCobro,
        fechaPago,
        referenciaPago:  referenciaPago ?? null,
        evidenciaPagoUrl,
        ...(valorLiquidado != null ? { valorLiquidado: Number(valorLiquidado) } : {}),
      })
      await tramite.save()

      await tramite.load('funcionario')
      await tramite.load('sede')
      await tramite.load('servicio')

      return response.ok(tramite)
    } catch (error) {
      console.error('Error en registrarPago:', error)
      return response.internalServerError({ message: 'Error al registrar el pago' })
    }
  }

  /** GET /tramites/siguiente-numero */
  public async siguienteNumero({ request, response }: HttpContext) {
    try {
      const { usuarioId } = request.qs()
      const usuario = await Usuario.find(Number(usuarioId))
      if (!usuario?.sedeId) return response.badRequest({ message: 'Usuario sin sede' })

      const hoy = DateTime.local().setZone('America/Bogota').toISODate()!
      const row = await Database.from('tramites')
        .where('sede_id', usuario.sedeId)
        .where('fecha', hoy)
        .max('turno_numero as max')
        .first()

      return response.ok({ siguiente: Number(row?.max ?? 0) + 1, sedeId: usuario.sedeId })
    } catch (error) {
      console.error('Error siguiente numero:', error)
      return response.internalServerError({ message: 'Error al obtener el número' })
    }
  }
}
