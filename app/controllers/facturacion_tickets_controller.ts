// app/controllers/facturacion_tickets_controller.ts — FRAGMENTO 1/3
import type { HttpContext } from '@adonisjs/core/http'
import { cuid } from '@adonisjs/core/helpers'
import app from '@adonisjs/core/services/app'
import { DateTime } from 'luxon'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'

import Database from '@adonisjs/lucid/services/db'
import FacturacionTicket, { type FactEstado } from '#models/facturacion_ticket'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import Servicio from '#models/servicio'
import Comision from '#models/comision'
import Descuento from '#models/descuento' // 🆕

/** Carpeta para subir tickets (local). */
const UPLOAD_BASE_DIR = app.makePath('uploads/tickets')

/** Ventana para considerar duplicado por contenido. */
const DUP_WINDOW_MINUTES = 60

/* ============================== Tipos DTO / Snapshots ============================== */

interface AgenteDTO {
  id: number
  nombre: string
  tipo?: string | null
}

interface ConvenioDTO {
  id: number
  codigo?: string | null
  nombre: string
}

interface UsuarioDTO {
  id: number
  nombres?: string | null
  apellidos?: string | null
}

interface SedeDTO {
  id: number
  nombre: string
}

interface ServicioDTO {
  id: number
  codigoServicio?: string | null
  nombreServicio?: string | null
}

interface DateoDTO {
  id: number
  canal: string
  agente: AgenteDTO | null
  asesorConvenio: AgenteDTO | null
  convenio: ConvenioDTO | null
}

interface TurnoDTO {
  id: number
  turnoNumero?: number | null
  turnoNumeroServicio?: number | null
  turnoCodigo?: string | null
  placa?: string | null
  estado?: string | null
  fecha?: string | null
  horaIngreso?: string | null
  horaSalida?: string | null
  tiempoServicio?: string | null
  tipoVehiculo?: string | null
  medioEntero?: string | null
  canalAtribucion?: string | null
  servicio: ServicioDTO | null
  usuario: UsuarioDTO | null
  sede: SedeDTO | null
  agenteCaptacion: AgenteDTO | null
  asesorConvenio: AgenteDTO | null
  convenio: ConvenioDTO | null
}

interface TurnoSnapshotReadable {
  turnoNumero?: number | null
  turnoNumeroServicio?: number | null
  turnoCodigo?: string | null
  placa?: string | null
  estado?: string | null
  fecha?: string | null
  horaIngreso?: string | null
  horaSalida?: string | null
  tiempoServicio?: string | null
  tipoVehiculo?: string | null
  medioEntero?: string | null
  canalAtribucion?: string | null
  servicioId?: number | null
  sedeId?: number | null
  agenteCaptacionId?: number | null
  $preloaded?: {
    servicio?: { id: number; codigoServicio?: string | null; nombreServicio?: string | null }
    usuario?: { id: number; nombres?: string | null; apellidos?: string | null }
    sede?: { id: number; nombre: string }
    agenteCaptacion?: { id: number; nombre: string; tipo?: string | null }
    captacionDateo?: {
      id: number
      canal: string
      agente?: { id: number; nombre: string; tipo?: string | null } | null
      asesorConvenio?: { id: number; nombre: string; tipo?: string | null } | null
      convenio?: { id: number; codigo?: string | null; nombre: string } | null
    }
  }
}

interface ComisionLiteDTO {
  id: number
  estado: 'PENDIENTE' | 'APROBADA' | 'PAGADA' | 'ANULADA'
  monto: number
  asesor?: { id: number; nombre: string } | null
  convenio?: { id: number; nombre: string } | null
}

// 🆕 Descuento aplicado en ticket
interface DescuentoAplicadoDTO {
  id: number
  codigo: string
  nombre: string
  montoAplicado: number
  autorizadoPor: { id: number; nombre: string } | null
}

interface TicketDTO {
  id: number
  estado: FactEstado
  hash: string
  filePath: string | null
  fileMime: string | null
  fileSize: number | null
  imageRotation: number
  createdAt: string
  updatedAt: string

  placa: string | null
  fechaPago: string | null
  total: number | null
  subtotal: number | null
  iva: number | null
  totalFactura: number | null
  totalSinDescuento: number | null
  vendedorText: string | null
  prefijo: string | null
  consecutivo: string | null

  nit?: string | null
  pin?: string | null
  marca?: string | null

  turnoId: number | null
  servicioId: number | null
  sedeId: number | null
  agenteId: number | null
  dateoId: number | null

  servicioCodigo: string | null
  servicioNombre: string | null
  tipoVehiculoSnapshot: string | null
  turnoGlobal: number | null
  turnoServicio: number | null
  turnoCodigo: string | null
  placaTurno: string | null
  sedeNombre: string | null
  funcionarioNombre: string | null
  canalAtribucion: string | null
  medioEntero: string | null

  confirmadoAt?: string | null
  confirmedById?: number | null

  turno: TurnoDTO | null
  dateo: DateoDTO | null

  comisiones?: ComisionLiteDTO[]

  // 🆕
  descuentoAplicado?: DescuentoAplicadoDTO | null
  confirmedBy?: { id: number; nombres?: string | null; apellidos?: string | null } | null
}

/* ============================== Controlador ============================== */

export default class FacturacionTicketsController {
  /**
   * GET /facturacion/tickets/:id/imagen
   */
  public async servirImagen({ params, response }: HttpContext) {
    const ticket = await FacturacionTicket.find(params.id)
    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })
    if (!ticket.filePath)
      return response.notFound({ message: 'El ticket no tiene imagen asociada' })

    try {
      const absolutePath = app.makePath(ticket.filePath)
      await fs.access(absolutePath)
      return response.header('Content-Type', ticket.fileMime || 'image/jpeg').download(absolutePath)
    } catch (err) {
      console.error('Error sirviendo imagen del ticket:', err)
      return response.notFound({ message: 'No se pudo cargar la imagen del ticket' })
    }
  }
  /** GET /facturacion/tickets */
  public async index({ request }: HttpContext) {
    const q = FacturacionTicket.query().orderBy('created_at', 'desc')

    const desde = request.input('desde') as string | undefined
    const hasta = request.input('hasta') as string | undefined
    const sedeId = toIntOrNull(request.input('sede_id'))
    const agenteId = toIntOrNull(request.input('agente_id'))
    const placa =
      (request.input('placa') as string | undefined)?.toUpperCase()?.replace(/\s+/g, '') || null
    const estado = request.input('estado') as FactEstado | undefined
    const turnoId = toIntOrNull(request.input('turno_id'))
    const dateoId = toIntOrNull(request.input('dateo_id'))
    const vendedor = request.input('vendedor') as string | undefined

    if (desde) {
      const d = DateTime.fromISO(desde).toSQL()
      if (d) q.where('created_at', '>=', d)
    }
    if (hasta) {
      const h = DateTime.fromISO(hasta).toSQL()
      if (h) q.where('created_at', '<=', h)
    }
    if (sedeId) q.where('sede_id', sedeId)
    if (agenteId) q.where('agente_id', agenteId)
    if (placa) q.where('placa', placa)
    if (estado) q.where('estado', estado)
    if (turnoId) q.where('turno_id', turnoId)
    if (dateoId) q.where('dateo_id', dateoId)
    if (vendedor && vendedor.trim().length >= 2)
      q.whereILike('vendedor_text', `%${vendedor.trim()}%`)

    const page = Number(request.input('page') || 1)
    const limit = Math.min(Number(request.input('limit') || 20), 100)
    const pag = await q.paginate(page, limit)

    const { meta, data } = pag.toJSON()
    const rows = data.map((t: any) => ({
      id: t.id,
      estado: t.estado,
      placa: t.placa ?? null,
      fecha_pago: t.fechaPago ?? null,
      total_factura: t.totalFactura ?? t.total ?? null,
      servicio_nombre: t.servicioNombre ?? null,
      sede_nombre: t.sedeNombre ?? null,
      vendedor_text: t.vendedorText ?? null,
      nit: t.nit ?? null,
      pin: t.pin ?? null,
      marca: t.marca ?? null,
      canal_atribucion: t.canalAtribucion ?? null,
      agente_comercial_nombre: t.agenteComercialNombre ?? null,
      convenio_nombre: t.convenioNombre ?? null,
      // 🆕
      descuento_id: t.descuentoId ?? null,
      descuento_monto_aplicado: t.descuentoMontoAplicado ?? null,
    }))

    return { meta, data: rows }
  }

  /** GET /facturacion/tickets/:id */
  public async show({ params, response }: HttpContext) {
    const ticket = await FacturacionTicket.query()
      .where('id', params.id)
      .preload('agente')
      .preload('sede')
      .preload('servicio')
      .preload('dateo', (q) => q.preload('agente').preload('asesorConvenio').preload('convenio'))
      .preload('turno', (q) => {
        q.preload('servicio')
          .preload('usuario')
          .preload('sede')
          .preload('agenteCaptacion')
          .preload('captacionDateo', (cq) =>
            cq.preload('agente').preload('asesorConvenio').preload('convenio')
          )
      })
      // 🆕
      .preload('descuento')
      .preload('autorizadoPor')
      .preload('confirmedBy')
      .firstOrFail()

    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })
    const dto = await this.getTicketDTOById(ticket.id)
    return dto
  }

  /** GET /facturacion/tickets/hash-exists/:hash */
  public async hashExists({ params }: HttpContext) {
    const dup = await FacturacionTicket.findBy('hash', params.hash)
    return { exists: !!dup }
  }

  /** GET /facturacion/tickets/duplicados */
  public async checkDuplicados({ request }: HttpContext) {
    const placa =
      (request.input('placa') as string | undefined)?.toUpperCase()?.replace(/\s+/g, '') || ''
    const total = toNumberOrZero(request.input('total'))
    const fechaIso = request.input('fecha_pago_iso') as string | undefined
    if (!placa || !total || !fechaIso) return { possible: false, count: 0 }

    const fecha = DateTime.fromISO(fechaIso)
    const from = fecha.minus({ minutes: DUP_WINDOW_MINUTES }).toSQL()
    const to = fecha.plus({ minutes: DUP_WINDOW_MINUTES }).toSQL()

    const countRow = await FacturacionTicket.query()
      .where('placa', placa)
      .where('total', total)
      .whereBetween('fecha_pago', [from!, to!])
      .count('* as total')
      .first()

    const n = Number(countRow?.$extras.total || 0)
    return { possible: n > 0, count: n }
  }

  /**
   * POST /facturacion/tickets
   */
  public async store({ request, auth, response }: HttpContext) {
    const file = request.file('archivo', {
      size: '8mb',
      extnames: ['jpg', 'jpeg', 'png', 'jfif', 'webp'],
    })
    if (!file) return response.badRequest({ message: 'archivo (image/*) requerido' })
    if (!file.isValid) return response.badRequest({ message: file.errors })

    const buffer = await fs.readFile(file.tmpPath!)
    const hash = digestSHA256(buffer)

    const turnoId = toIntOrNull(request.input('turno_id'))
    const dateoId = toIntOrNull(request.input('dateo_id'))
    const sedeId = toIntOrNull(request.input('sede_id'))
    const servicioId = toIntOrNull(request.input('servicio_id'))

    let esServicioSimplificado = false
    if (servicioId) {
      const s = await Servicio.find(servicioId)
      if (s) esServicioSimplificado = isSOAT(s.codigoServicio, s.nombreServicio)
    }

    if (!esServicioSimplificado) {
      const dup = await FacturacionTicket.findBy('hash', hash)
      if (dup) {
        return response.conflict({
          message: 'Este ticket ya fue cargado (hash duplicado)',
          id: dup.id,
        })
      }
    }

    const now = DateTime.now()
    const outDir = path.join(UPLOAD_BASE_DIR, String(now.year), String(now.month).padStart(2, '0'))
    await fs.mkdir(outDir, { recursive: true })
    const filename = `${cuid()}.${file.extname}`
    const filePath = path.join(outDir, filename)
    await fs.copyFile(file.tmpPath!, filePath)
    const imageRotation = Number(request.input('image_rotation') || 0)

    const ticket = new FacturacionTicket()
    ticket.hash = hash
    ticket.filePath = filePath.replace(app.makePath(), '')
    ticket.fileMime = file.type ?? null
    ticket.fileSize = buffer.length
    ticket.imageRotation = imageRotation
    ticket.estado = 'BORRADOR'
    ticket.createdById = auth.user?.id ?? null

    ticket.turnoId = turnoId
    ticket.dateoId = dateoId
    ticket.sedeId = sedeId
    ticket.servicioId = servicioId

    if (servicioId && esServicioSimplificado) {
      const s = await Servicio.find(servicioId)
      if (s) {
        ticket.servicioCodigo = s.codigoServicio ?? null
        ticket.servicioNombre = s.nombreServicio ?? null
      }
    }

    if (dateoId) {
      const dateo = await CaptacionDateo.query()
        .where('id', dateoId)
        .preload('agente')
        .preload('asesorConvenio')
        .preload('convenio')
        .first()

      if (dateo) {
        if (!ticket.placa && (dateo.placa || '').trim())
          ticket.placa = (dateo.placa || '').toUpperCase().replace(/\s+/g, '')
        ticket.agenteId = dateo.agenteId ?? ticket.agenteId ?? null
        ticket.captacionCanal = dateo.canal ?? null
        ticket.agenteComercialNombre = (dateo.agente as any)?.nombre ?? null
        ticket.asesorConvenioNombre = (dateo.asesorConvenio as any)?.nombre ?? null
        ticket.convenioNombre = (dateo.convenio as any)?.nombre ?? null
      }
    }

    let turno: TurnoRtm | null = null
    if (turnoId) {
      turno = await TurnoRtm.query()
        .where('id', turnoId)
        .preload('servicio')
        .preload('usuario')
        .preload('sede')
        .first()
    }

    if (turno) {
      const turnSnap = turno as unknown as TurnoSnapshotReadable
      if (!ticket.placa && (turnSnap.placa || '').trim())
        ticket.placa = (turnSnap.placa || '').toUpperCase().replace(/\s+/g, '')
      ticket.sedeId = ticket.sedeId || turnSnap.sedeId || null
      ticket.agenteId = ticket.agenteId || turnSnap.agenteCaptacionId || null
      ticket.servicioId = ticket.servicioId || turnSnap.servicioId || null
      await this.fillSnapshotsFromTurno(ticket, turno)
    } else if (ticket.servicioId && !esServicioSimplificado) {
      const s = await Servicio.find(ticket.servicioId)
      if (s) {
        ticket.servicioCodigo = s.codigoServicio ?? null
        ticket.servicioNombre = s.nombreServicio ?? null
      }
    }

    await ticket.save()
    return response.created(ticket)
  }

  /** POST /facturacion/tickets/:id/reocr */
  public async reocr({ params, response }: HttpContext) {
    const ticket = await FacturacionTicket.find(params.id)
    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })

    const esSOAT = isSOAT(ticket.servicioCodigo, ticket.servicioNombre)
    if (esSOAT) return response.ok({ message: 'Servicio simplificado no requiere OCR', ticket })

    const res = fakeOCR()
    ticket.ocrText = res.text
    ticket.ocrConfPlaca = res.confidence.placa
    ticket.ocrConfTotal = res.confidence.total
    ticket.ocrConfFecha = res.confidence.fecha
    ticket.ocrConfAgente = res.confidence.agente

    if (res.placa) ticket.placa = res.placa
    if (res.total) {
      ticket.total = res.total
      ticket.totalFactura = res.total
    }
    if (res.fechaHora) ticket.fechaPago = DateTime.fromISO(res.fechaHora)
    if (ticket.estado === 'BORRADOR') ticket.estado = 'OCR_LISTO'

    await ticket.save()
    return ticket
  }

  /** PATCH /facturacion/tickets/:id */
  public async update({ params, request, response }: HttpContext) {
    const ticket = await FacturacionTicket.find(params.id)
    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })

    const up = request.only([
      'placa',
      'total',
      'fecha_pago',
      'sede_id',
      'agente_id',
      'prefijo',
      'consecutivo',
      'forma_pago',
      'servicio_id',
      'doc_tipo',
      'doc_numero',
      'nombre',
      'telefono',
      'observaciones',
      'ocr_conf_baja_revisado',
      'image_rotation',
      'nit',
      'pin',
      'marca',
      'vendedor_text',
      'subtotal',
      'iva',
      'total_factura',
      'pago_consignacion',
      'pago_tarjeta',
      'pago_efectivo',
      'pago_cambio',
      'turno_id',
      'dateo_id',
      'vendedor',
      'ocr_campos',
      // 🆕
      'descuento_id',
      'autorizado_por_id',
      'descuento_monto_aplicado',
      'total_sin_descuento',
    ]) as Record<string, unknown>

    const esSOAT = isSOAT(ticket.servicioCodigo, ticket.servicioNombre)

    if ('placa' in up)
      ticket.placa = String(up.placa || '')
        .toUpperCase()
        .replace(/\s+/g, '')
    if ('total' in up) ticket.total = toNumberOrZero(up.total)

    if ('fecha_pago' in up) {
      if (up.fecha_pago) {
        const dt = DateTime.fromISO(String(up.fecha_pago))
        if (dt.isValid) {
          ticket.fechaPago = dt
        } else {
          return response.badRequest({ message: 'Fecha de pago inválida' })
        }
      } else {
        ticket.fechaPago = null
      }
    }

    if ('sede_id' in up) ticket.sedeId = toIntOrNull(up.sede_id)
    if ('agente_id' in up) ticket.agenteId = toIntOrNull(up.agente_id)
    if ('prefijo' in up) ticket.prefijo = nullIfEmpty(up.prefijo)
    if ('consecutivo' in up) ticket.consecutivo = nullIfEmpty(up.consecutivo)
    if ('forma_pago' in up) ticket.formaPago = nullIfEmpty(up.forma_pago) as any
    if ('servicio_id' in up) ticket.servicioId = toIntOrNull(up.servicio_id)
    if ('doc_tipo' in up) ticket.docTipo = nullIfEmpty(up.doc_tipo) as any
    if ('doc_numero' in up) ticket.docNumero = nullIfEmpty(up.doc_numero)
    if ('nombre' in up) ticket.nombre = nullIfEmpty(up.nombre)
    if ('telefono' in up) ticket.telefono = nullIfEmpty(up.telefono)
    if ('observaciones' in up) ticket.observaciones = nullIfEmpty(up.observaciones)
    if ('ocr_conf_baja_revisado' in up)
      ticket.ocrConfBajaRevisado = Boolean(up.ocr_conf_baja_revisado)
    if ('image_rotation' in up) ticket.imageRotation = Number(up.image_rotation) || 0

    if ('nit' in up) ticket.nit = nullIfEmpty(sanitizeNit(String(up.nit)))
    if ('pin' in up) ticket.pin = nullIfEmpty(String(up.pin))
    if ('marca' in up) ticket.marca = nullIfEmpty(String(up.marca))
    if ('vendedor_text' in up) ticket.vendedorText = nullIfEmpty(String(up.vendedor_text))
    if ('vendedor' in up && up.vendedor !== undefined && up.vendedor !== null)
      ticket.vendedorText = nullIfEmpty(String(up.vendedor))

    if ('subtotal' in up) ticket.subtotal = toNumberOrZero(up.subtotal)
    if ('iva' in up) ticket.iva = toNumberOrZero(up.iva)
    if ('total_factura' in up) ticket.totalFactura = toNumberOrZero(up.total_factura)
    if ('pago_consignacion' in up) ticket.pagoConsignacion = toNumberOrZero(up.pago_consignacion)
    if ('pago_tarjeta' in up) ticket.pagoTarjeta = toNumberOrZero(up.pago_tarjeta)
    if ('pago_efectivo' in up) ticket.pagoEfectivo = toNumberOrZero(up.pago_efectivo)
    if ('pago_cambio' in up) ticket.pagoCambio = toNumberOrZero(up.pago_cambio)

    // 🆕 Descuento informativo aplicado en caja
    if ('descuento_id' in up) {
      const dId = toIntOrNull(up.descuento_id)
      if (dId === null) {
        ticket.descuentoId = null
        ticket.descuentoMontoAplicado = null
        ticket.autorizadoPorId = null
      } else {
        const descuentoExiste = await Descuento.query()
          .where('id', dId)
          .where('activo', true)
          .first()
        if (!descuentoExiste) {
          return response.badRequest({ message: 'descuento_id no existe o está inactivo' })
        }
        // Validación especial INFORMATIVO_POLICIA: requiere las 3 fotos
        if (descuentoExiste.codigo === 'INFORMATIVO_POLICIA') {
          if (!ticket.documentosPoliciaCargados) {
            return response.badRequest({
              message:
                'Para aplicar el descuento INFORMATIVO_POLICIA se deben subir los 3 documentos',
              documentos_faltantes: ticket.documentosPoliciaFaltantes,
            })
          }
        }
        ticket.descuentoId = dId
      }
    }
    if ('autorizado_por_id' in up) ticket.autorizadoPorId = toIntOrNull(up.autorizado_por_id)
    if ('descuento_monto_aplicado' in up) {
      ticket.descuentoMontoAplicado =
        up.descuento_monto_aplicado !== null && up.descuento_monto_aplicado !== undefined
          ? toNumberOrZero(up.descuento_monto_aplicado)
          : null
    }

    // Recalcular total con descuento aplicado
    // Guardar total original y calcular total con descuento
    if (ticket.descuentoMontoAplicado && ticket.descuentoMontoAplicado > 0) {
      const totalBase = ticket.totalFactura || ticket.total || 0
      if (!ticket.totalSinDescuento && totalBase > 0) {
        ticket.totalSinDescuento = totalBase
      }
      const totalConDescuento = Math.max(
        0,
        (ticket.totalSinDescuento || totalBase) - ticket.descuentoMontoAplicado
      )
      ticket.totalFactura = totalConDescuento
      ticket.total = totalConDescuento
    }

    if (up.ocr_campos && typeof up.ocr_campos === 'object') {
      const c = up.ocr_campos as any
      if (c.vendedor) ticket.vendedorText = ticket.vendedorText ?? String(c.vendedor)
      if (c.prefijo) ticket.prefijo = ticket.prefijo ?? String(c.prefijo)
      if (c.consecutivo) ticket.consecutivo = ticket.consecutivo ?? String(c.consecutivo)
      if (c.nit) ticket.nit = ticket.nit ?? sanitizeNit(String(c.nit))
      if (c.pin) ticket.pin = ticket.pin ?? String(c.pin)
      if (c.marca) ticket.marca = ticket.marca ?? String(c.marca)

      const sub = Number(c.subtotal || 0)
      const iva = Number(c.iva || 0)
      const tf = Number(c.totalFactura || c.total || 0)
      if (!ticket.subtotal && sub) ticket.subtotal = sub
      if (!ticket.iva && iva) ticket.iva = iva
      if (!ticket.totalFactura && tf) ticket.totalFactura = tf
      if (!ticket.total && tf) ticket.total = tf

      if (!ticket.fechaPago && c.fechaHora) {
        const dt = DateTime.fromISO(String(c.fechaHora))
        if (dt.isValid) ticket.fechaPago = dt
      }
      if (!ticket.placa && c.placa) ticket.placa = String(c.placa).toUpperCase().replace(/\s+/g, '')
    }

    if (
      !esSOAT &&
      canConfirm(ticket, false) &&
      (ticket.estado === 'BORRADOR' || ticket.estado === 'OCR_LISTO')
    ) {
      ticket.estado = 'LISTA_CONFIRMAR'
    }

    if ('servicio_id' in up && ticket.servicioId) {
      const s = await Servicio.find(ticket.servicioId)
      if (s) {
        ticket.servicioCodigo = s.codigoServicio ?? null
        ticket.servicioNombre = s.nombreServicio ?? null
      }
    }

    const newTurnoId = toIntOrNull(up.turno_id)
    const newDateoId = toIntOrNull(up.dateo_id)
    if (newTurnoId && !ticket.turnoId) ticket.turnoId = newTurnoId
    if (newDateoId && !ticket.dateoId) ticket.dateoId = newDateoId

    if (ticket.turnoId) {
      const t = await TurnoRtm.query()
        .where('id', ticket.turnoId)
        .preload('servicio')
        .preload('usuario')
        .preload('sede')
        .first()
      if (t) await this.fillSnapshotsFromTurno(ticket, t)
    }

    if (ticket.dateoId) {
      const d = await CaptacionDateo.query()
        .where('id', ticket.dateoId)
        .preload('agente')
        .preload('asesorConvenio')
        .preload('convenio')
        .first()
      if (d) {
        ticket.captacionCanal = d.canal ?? ticket.captacionCanal ?? null
        ticket.agenteComercialNombre =
          (d.agente as any)?.nombre ?? ticket.agenteComercialNombre ?? null
        ticket.asesorConvenioNombre =
          (d.asesorConvenio as any)?.nombre ?? ticket.asesorConvenioNombre ?? null
        ticket.convenioNombre = (d.convenio as any)?.nombre ?? ticket.convenioNombre ?? null
      }
    }

    await ticket.save()
    return ticket
  }
  /**
   * POST /facturacion/tickets/:id/confirmar
   *
   * REGLAS DE COMISIÓN:
   *
   * ══════════════════════════════════════════════════════════
   * SIN CONVENIO — Comercial datea directo
   * ══════════════════════════════════════════════════════════
   *   🆕 Nuevo                → valor_nuevo_directo ($17.200)
   *   🆕 Nuevo + INFORMATIVO  → valor_dateo_recurrencia ($4.300) ← baja de categoría
   *   🔄 Recurrente           → valor_dateo_recurrencia
   *   💛 Recuperación         → valor_dateo_recuperacion
   *
   * ══════════════════════════════════════════════════════════
   * CON CONVENIO — Asesor CONVENIO datea él mismo
   * ══════════════════════════════════════════════════════════
   *   🆕 Nuevo       → incentivo ($14.000)
   *   🆕 Nuevo + INFORMATIVO_POLICIA (caja) → convenio $0
   *   🆕 Nuevo + INFORMATIVO_EMPLEADO (caja) → convenio $0
   *   🔄 Recurrente  + dató la última visita → incentivo
   *   🔄 Recurrente  + NO dató la última visita → valor_dateo_recurrencia
   *   💛 Recuperación → valor_dateo_recuperacion
   *
   * ══════════════════════════════════════════════════════════
   * CON CONVENIO — COMERCIAL datea
   * ══════════════════════════════════════════════════════════
   *   🆕 Nuevo       → comercial: valor_dateo ($8.600) + convenio: incentivo ($14.000)
   *   🆕 Nuevo + INFORMATIVO_POLICIA (caja) → comercial: $4.300 | convenio: $0
   *   🆕 Nuevo + INFORMATIVO_EMPLEADO (caja) → comercial: $4.300 | convenio: $0
   *   🔄 Recurrente  → comercial: valor_dateo_recurrencia + convenio: incentivo_global
   *   💛 Recuperación → comercial: valor_dateo_recuperacion + convenio: incentivo_global
   *
   * ══════════════════════════════════════════════════════════
   * 🆕 AVANCE (cualquier caso con convenio)
   * ══════════════════════════════════════════════════════════
   *   → montoConvenio = '0' (incentivo ya se aplicó como descuento en factura)
   *   → montoAsesor   = intacto (el comercial sí cobra su dateo)
   *   → esAvance = true en la comisión (trazabilidad contable)
   */
  public async confirmar({ params, request, response, auth }: HttpContext) {
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━')
    console.log('🟢 INICIO CONFIRMAR - Ticket ID:', params.id)

    const forzar = Boolean(request.input('forzar'))
    const ticket = await FacturacionTicket.find(params.id)
    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })

    const esSOAT = isSOAT(ticket.servicioCodigo, ticket.servicioNombre)

    // COMPLETAR desde dateo
    if (!ticket.agenteId && ticket.dateoId) {
      const d = await CaptacionDateo.find(ticket.dateoId)
      if (d) {
        const agenteIdFromDateo = (d as any)?.agenteId ?? (d as any)?.agente_id ?? null
        if (agenteIdFromDateo) ticket.agenteId = agenteIdFromDateo
      }
    }

    // COMPLETAR desde turno
    if (!ticket.sedeId && ticket.turnoId) {
      const t = await TurnoRtm.find(ticket.turnoId)
      if (t) {
        const sedeIdFromTurno = (t as any)?.sedeId ?? (t as any)?.sede_id ?? null
        if (sedeIdFromTurno) ticket.sedeId = sedeIdFromTurno
      }
    }

    if (!ticket.agenteId && ticket.turnoId) {
      const t = await TurnoRtm.find(ticket.turnoId)
      if (t) {
        const agenteIdFromTurno =
          (t as any)?.agenteCaptacionId ?? (t as any)?.agente_captacion_id ?? null
        if (agenteIdFromTurno) ticket.agenteId = agenteIdFromTurno
      }
    }

    await ticket.save()

    // VALIDACIÓN
    if (!esSOAT) {
      const puedeConfirmar = canConfirm(ticket, true)
      if (!puedeConfirmar)
        return response.badRequest({ message: 'Faltan campos obligatorios para confirmar' })
    }

    if (esSOAT && !ticket.filePath)
      return response.badRequest({
        message: 'Servicio simplificado requiere al menos la imagen de la factura',
      })

    if (!esSOAT) {
      const dup = await isContentDuplicate(ticket)
      ticket.duplicadoPorContenido = dup
      ticket.posibleDuplicadoAt = dup ? DateTime.now() : null
      if (dup && !forzar) {
        await ticket.save()
        return response.conflict({
          message: 'Posible duplicado por contenido (placa+total+fecha ±1h)',
          posibleDuplicado: true,
        })
      }
    }

    ticket.estado = 'CONFIRMADA'
    ticket.confirmadoAt = DateTime.now()
    ticket.confirmedById = auth.user?.id ?? null

    if (!ticket.agenteId && ticket.dateoId) {
      const d = await CaptacionDateo.find(ticket.dateoId)
      if (d?.agenteId) ticket.agenteId = d.agenteId
    }
    if (!ticket.sedeId && ticket.turnoId) {
      const t = await TurnoRtm.find(ticket.turnoId)
      if (t?.sedeId) ticket.sedeId = (t as unknown as { sedeId: number | null }).sedeId ?? null
    }
    if (!ticket.servicioId && ticket.turnoId) {
      const t = await TurnoRtm.find(ticket.turnoId)
      if (t?.servicioId)
        ticket.servicioId = (t as unknown as { servicioId: number | null }).servicioId ?? null
    }

    let turno: TurnoRtm | null = null
    if (ticket.turnoId) {
      turno = await TurnoRtm.query()
        .where('id', ticket.turnoId)
        .preload('servicio')
        .preload('usuario')
        .preload('sede')
        .first()
      if (turno) await this.fillSnapshotsFromTurno(ticket, turno)
    }

    if (!turno && ticket.servicioId) {
      const s = await Servicio.find(ticket.servicioId)
      if (s) {
        ticket.servicioCodigo = s.codigoServicio ?? null
        ticket.servicioNombre = s.nombreServicio ?? null
      }
    }

    await ticket.save()

    if (ticket.turnoId) {
      const turnoToUpdate = await TurnoRtm.query()
        .where('id', ticket.turnoId)
        .preload('servicio')
        .first()

      if (turnoToUpdate) {
        const nowBog = DateTime.local().setZone('America/Bogota')
        turnoToUpdate.tieneFacturacion = true
        turnoToUpdate.horaFacturacion = nowBog.toFormat('HH:mm:ss')
        turnoToUpdate.facturacionFuncionarioId = auth.user?.id ?? null

        const esServicioSimplificado = isSOAT(
          turnoToUpdate.servicio?.codigoServicio,
          turnoToUpdate.servicio?.nombreServicio
        )

        if (esServicioSimplificado && turnoToUpdate.estado === 'activo') {
          let entrada = DateTime.fromFormat(turnoToUpdate.horaIngreso, 'HH:mm:ss', {
            zone: 'America/Bogota',
          })
          if (!entrada.isValid)
            entrada = DateTime.fromFormat(turnoToUpdate.horaIngreso, 'HH:mm', {
              zone: 'America/Bogota',
            })

          let diff = nowBog.diff(entrada, ['hours', 'minutes']).toObject()
          if ((diff.hours ?? 0) < 0 || (diff.minutes ?? 0) < 0) diff = { hours: 0, minutes: 0 }

          let tiempoServicioStr = ''
          if (diff.hours && diff.hours >= 1) tiempoServicioStr += `${Math.floor(diff.hours)} h `
          tiempoServicioStr += `${Math.round((diff.minutes ?? 0) % 60)} min`

          turnoToUpdate.horaSalida = nowBog.toFormat('HH:mm:ss')
          turnoToUpdate.tiempoServicio = tiempoServicioStr
          turnoToUpdate.estado = 'finalizado'
        }

        await turnoToUpdate.save()
      }
    }

    if (!esSOAT) {
      try {
        await this.applyCommissionHook(ticket)
      } catch (err) {
        console.error('Commission hook failed:', err)
      }
    }

    // 🆕 Para SOAT → marcar dateo EXITOSO al confirmar ticket
    if (esSOAT && ticket.dateoId) {
      try {
        const dateoFinal = await CaptacionDateo.find(ticket.dateoId)
        if (dateoFinal && dateoFinal.resultado !== 'EXITOSO') {
          dateoFinal.resultado = 'EXITOSO'
          await dateoFinal.save()
          console.log(`✅ Dateo ${dateoFinal.id} marcado EXITOSO (ticket SOAT confirmado)`)
        }
      } catch (e) {
        console.error('❌ Error marcando EXITOSO en SOAT:', e)
      }
    }

    const dto = await this.getTicketDTOById(ticket.id)
    return dto
  }
  // ========================== Hook principal de comisiones ==========================

  private async applyCommissionHook(ticket: FacturacionTicket) {
    console.log('━━━━ applyCommissionHook ━━━━')
    console.log('ticket.id:', ticket.id)
    console.log('ticket.estado:', ticket.estado)
    console.log('ticket.servicioCodigo:', ticket.servicioCodigo)
    console.log('ticket.servicioNombre:', ticket.servicioNombre)
    console.log('ticket.dateoId:', ticket.dateoId)
    console.log('ticket.turnoId:', ticket.turnoId)
    console.log('ticket.descuentoId:', ticket.descuentoId)
    // 🔍 LOGS DIAGNÓSTICO AVANCE
    console.log('ticket.descuentoMontoAplicado:', ticket.descuentoMontoAplicado)
    console.log('ticket.tipoVehiculoSnapshot:', (ticket as any).tipoVehiculoSnapshot)

    if (ticket.estado !== 'CONFIRMADA') {
      console.log('❌ SALIDA: no es CONFIRMADA')
      return
    }

    const esRTM = isRTM(ticket.servicioCodigo, ticket.servicioNombre)
    console.log('esRTM:', esRTM)
    if (!esRTM) {
      console.log('❌ SALIDA: no es RTM')
      return
    }

    let turnoActual: TurnoRtm | null = null

    if (!ticket.dateoId && ticket.turnoId) {
      turnoActual = await TurnoRtm.find(ticket.turnoId)
      console.log('turnoActual.captacionDateoId:', (turnoActual as any)?.captacionDateoId)
      if ((turnoActual as any)?.captacionDateoId) {
        ticket.dateoId = (turnoActual as any).captacionDateoId
        await ticket.save()
      }
    }

    console.log('dateoId final:', ticket.dateoId)
    if (!ticket.dateoId) {
      console.log('❌ SALIDA: dateoId sigue null')
      return
    }

    const dateo = await CaptacionDateo.query()
      .where('id', ticket.dateoId)
      .preload('agente')
      .preload('asesorConvenio')
      .preload('convenio', (qConvenio) => {
        qConvenio.preload('asesorConvenio')
      })
      .first()

    if (!dateo) return

    // 🔍 LOG DIAGNÓSTICO AVANCE — leer flag esAvance del dateo
    console.log(
      'dateo.esAvance:',
      (dateo as any).esAvance,
      '| dateo.es_avance:',
      (dateo as any).es_avance
    )

    // Tipo de vehículo
    if (!turnoActual && ticket.turnoId) turnoActual = await TurnoRtm.find(ticket.turnoId)
    let turnoTipoVehiculo: string | null = null
    if (turnoActual) {
      const anyTurno = turnoActual as any
      turnoTipoVehiculo = anyTurno.tipoVehiculo ?? anyTurno.tipo_vehiculo ?? null
    }

    // ── Estado del cliente ──
    const esClienteRecurrente = Boolean((turnoActual as any)?.esRecurrente ?? false)
    const esClienteRecuperacion = Boolean((turnoActual as any)?.esRecuperacion ?? false)
    const esClienteNuevo = !esClienteRecurrente && !esClienteRecuperacion

    const tipoVehiculoComision = inferTipoVehiculoComision({
      ticketTipo: (ticket as any).tipoVehiculoSnapshot ?? null,
      turnoTipo: turnoTipoVehiculo,
    })

    const now = DateTime.now()
    const usuarioId = ticket.confirmedById ?? ticket.createdById ?? null

    // ── Leer ID real del asesor convenio ──
    let asesorConvenioIdReal: number | null = null
    if (dateo.convenioId && (dateo.convenio as any)?.$preloaded?.asesorConvenio) {
      asesorConvenioIdReal = (dateo.convenio as any).$preloaded.asesorConvenio.id
    }

    // ── Leer configs de comisión (incentivo, dateo nuevo, nuevo directo) ──
    const cfgValues = await resolveConfigComision({
      asesorId: dateo.agenteId,
      asesorConvenioId: asesorConvenioIdReal,
      tipoVehiculo: tipoVehiculoComision,
    })

    // ── Leer valores recurrente/recuperación ──
    const recValues = await resolveConfigRecurrencia(dateo.agenteId, tipoVehiculoComision)

    // 🆕 ── Detectar si hay descuento informativo ──
    // Prioridad: ticket (aplicado en caja) > dateo (pre-marcado por el comercial)
    const descuentoIdActivo = ticket.descuentoId ?? (dateo as any).descuentoId ?? null
    // Distinguir origen: caja (ticket.descuentoId) vs dateo pre-marcado
    const descuentoOrigenCaja = !!ticket.descuentoId && !(dateo as any).descuentoId
    let tieneInformativo = false
    let esInformativoPolicia = false
    let esInformativoEmpleado = false // 🆕
    let esAvancePropietario = false // 🆕 CAMBIO 1
    let esObsequio = false // 🆕 CAMBIO NUEVO
    let esInformativoSoatRtm = false // 🆕
    if (descuentoIdActivo) {
      const descuentoInfo = await Descuento.query()
        .where('id', descuentoIdActivo)
        .where('activo', true)
        .first()
      tieneInformativo = descuentoInfo !== null
      esInformativoPolicia = descuentoInfo?.codigo === 'INFORMATIVO_POLICIA'
      esInformativoEmpleado = descuentoInfo?.codigo === 'INFORMATIVO_EMPLEADO' // 🆕
      esAvancePropietario = descuentoInfo?.codigo === 'AVANCE_PROPIETARIO' // 🆕 CAMBIO 2
      esObsequio = descuentoInfo?.codigo === 'INFORMATIVO_OBSEQUIO' // 🆕 CAMBIO NUEVO
      esInformativoSoatRtm = descuentoInfo?.codigo === 'INFORMATIVO_SOAT_RTM' // 🆕
      console.log(
        `🏷️ Descuento informativo: ${tieneInformativo ? `${descuentoInfo!.nombre} (ID ${descuentoIdActivo})` : 'NO'} | esPolicia: ${esInformativoPolicia} | esEmpleado: ${esInformativoEmpleado} | esAvancePropietario: ${esAvancePropietario} | esObsequio: ${esObsequio} | origenCaja: ${descuentoOrigenCaja}`
      )
    } else {
      console.log('🏷️ Descuento informativo: NO')
    }

    // ══════════════════════════════════════════════════════════
    // 🆕 AVANCE — detectar y resolver monto según tipo vehículo
    // ══════════════════════════════════════════════════════════
    const esAvance = Boolean((dateo as any).esAvance ?? (dateo as any).es_avance ?? false)

    // Monto real del AVANCE:
    // 1. Si la cajera ingresó un monto explícito (descuentoMontoAplicado > 0) → usar ese
    // 2. Si no → auto-resolver desde tabla descuentos según tipo de vehículo
    //    MOTO    → descuento.valorMoto
    //    VEHICULO → descuento.valorCarro
    let montoAvance = 0
    if (esAvance && descuentoIdActivo) {
      const montoExplicito = Number(ticket.descuentoMontoAplicado ?? 0)
      if (montoExplicito > 0) {
        montoAvance = montoExplicito
        console.log(`🆕 AVANCE monto explícito (cajera): $${montoAvance}`)
      } else {
        // Auto-resolver desde la tabla descuentos por tipo de vehículo
        const descuentoRow = await Descuento.query()
          .where('id', descuentoIdActivo)
          .where('activo', true)
          .first()
        if (descuentoRow) {
          const esMoto = tipoVehiculoComision === 'MOTO'
          montoAvance = esMoto
            ? Number((descuentoRow as any).valorMoto ?? (descuentoRow as any).valor_moto ?? 0)
            : Number((descuentoRow as any).valorCarro ?? (descuentoRow as any).valor_carro ?? 0)
          console.log(
            `🆕 AVANCE auto-resuelto desde descuento "${descuentoRow.nombre}" | tipo: ${tipoVehiculoComision ?? 'desconocido'} | monto: $${montoAvance}`
          )
        }
      }
    }

    console.log(`🆕 esAvance: ${esAvance} | montoAvance: $${montoAvance}`)
    // ══════════════════════════════════════════════════════════

    console.log(
      `💰 Cliente: ${esClienteNuevo ? '🆕 NUEVO' : esClienteRecurrente ? '🔄 RECURRENTE' : '💛 RECUPERACIÓN'}`
    )

    // ── Verificar CONTINUIDAD ──
    const tuvoContinuidad = await verificarContinuidad({
      ultimoTurnoId:
        (turnoActual as any)?.ultimoTurnoId ?? (turnoActual as any)?.ultimo_turno_id ?? null,
      asesorConvenioIdActual: asesorConvenioIdReal,
      convenioIdActual: dateo.convenioId,
      placaTurno: (turnoActual as any)?.placa ?? ticket.placaTurno ?? null,
    })

    console.log(`🔗 Continuidad asesor convenio: ${tuvoContinuidad ? '✅ SÍ' : '❌ NO'}`)

    // ── Verificar duplicado ──
    const startDay = now.startOf('day').toSQL()
    const endDay = now.endOf('day').toSQL()

    const trx = await Database.transaction()
    try {
      const existingComision = await Comision.query({ client: trx })
        .where('captacion_dateo_id', dateo.id)
        .whereBetween('fecha_calculo', [startDay!, endDay!])
        .where('tipo_servicio', 'RTM')
        .first()

      if (existingComision) {
        console.log('⚠️ Ya existe una comisión para este dateo hoy')
        await trx.rollback()
        // Aun así marcar el dateo como EXITOSO
        if (dateo.resultado !== 'EXITOSO') {
          dateo.resultado = 'EXITOSO'
          await dateo.save()
          console.log(`✅ Dateo ${dateo.id} marcado EXITOSO (comisión duplicada)`)
        }
        return
      }

      // ════════════════════════════════════════════════════
      //  CASO 1: SIN CONVENIO — Comercial datea directo
      // ════════════════════════════════════════════════════
      if (!dateo.convenioId) {
        if (!dateo.agenteId) {
          console.warn('⚠️ Sin convenio y sin asesor')
          await trx.rollback()
          return
        }

        const c = new Comision()
        c.captacionDateoId = dateo.id
        c.asesorId = dateo.agenteId
        c.convenioId = null
        c.tipoServicio = 'RTM'
        c.estado = 'PENDIENTE'
        c.fechaCalculo = now
        c.calculadoPor = usuarioId
        c.porcentaje = '0'
        c.asesorSecundarioId = null
        c.base = '0'
        c.montoConvenio = '0'
        c.esAvance = false // Sin convenio: avance no aplica
        if (tipoVehiculoComision) (c as any).tipoVehiculo = tipoVehiculoComision

        if (esClienteNuevo) {
          if (tieneInformativo) {
            // 🆕 Nuevo + INFORMATIVO → baja de valorNuevoDirecto a valorRecurrente
            c.monto = String(recValues.valorRecurrente)
            c.montoAsesor = String(recValues.valorRecurrente)
            c.valorNuevoDirecto = '0'
            console.log(
              `✅ Sin convenio 🆕 NUEVO + INFORMATIVO → $${recValues.valorRecurrente} (bajó de $${cfgValues.valorNuevoDirecto})`
            )
          } else {
            // Nuevo directo sin descuento → valor_nuevo_directo
            c.monto = String(cfgValues.valorNuevoDirecto)
            c.montoAsesor = String(cfgValues.valorNuevoDirecto)
            c.valorNuevoDirecto = String(cfgValues.valorNuevoDirecto)
            console.log(`✅ Sin convenio 🆕 NUEVO DIRECTO → $${cfgValues.valorNuevoDirecto}`)
          }
        } else if (esClienteRecurrente) {
          c.monto = String(recValues.valorRecurrente)
          c.montoAsesor = String(recValues.valorRecurrente)
          c.valorNuevoDirecto = '0'
          console.log(`✅ Sin convenio 🔄 RECURRENTE → $${recValues.valorRecurrente}`)
        } else {
          c.monto = String(recValues.valorRecuperacion)
          c.montoAsesor = String(recValues.valorRecuperacion)
          c.valorNuevoDirecto = '0'
          console.log(`✅ Sin convenio 💛 RECUPERACIÓN → $${recValues.valorRecuperacion}`)
        }

        await c.useTransaction(trx).save()
      } else if (
        !dateo.agenteId ||
        dateo.agenteId === asesorConvenioIdReal ||
        dateo.canal === 'ASESOR_CONVENIO'
      ) {
        // ═══════════════════════════════════════════════════════════
        // CASO 2: Asesor convenio se datea a sí mismo
        // El dinero va SIEMPRE a montoAsesor (él es asesor Y convenio)
        // montoConvenio SIEMPRE es $0
        // ═══════════════════════════════════════════════════════════
        const c = new Comision()
        c.captacionDateoId = dateo.id
        c.asesorId = asesorConvenioIdReal
        c.convenioId = dateo.convenioId
        c.tipoServicio = 'RTM'
        c.estado = 'PENDIENTE'
        c.fechaCalculo = now
        c.calculadoPor = usuarioId
        c.porcentaje = '0'
        c.asesorSecundarioId = null
        c.valorNuevoDirecto = '0'
        c.montoConvenio = '0' // Siempre $0 en CASO 2
        c.esAvance = esAvance
        if (tipoVehiculoComision) (c as any).tipoVehiculo = tipoVehiculoComision

        if (esAvance) {
          // Con avance: el asesor convenio ya recibió su dinero como descuento
          // en la factura del cliente. No cobra comisión adicional.
          c.base = String(cfgValues.valorIncentivoPorTipo)
          c.monto = '0'
          c.montoAsesor = '0'
          c.descuentoMontoAplicado = montoAvance
          console.log(`✅ Convenio datea + AVANCE → $0 (ya cobró vía descuento en factura)`)
        } else if (
          (esInformativoPolicia ||
            esInformativoEmpleado ||
            esAvancePropietario ||
            esObsequio ||
            esInformativoSoatRtm) &&
          descuentoOrigenCaja
        ) {
          // Descuento especial aplicado en caja → $0
          c.base = '0'
          c.monto = '0'
          c.montoAsesor = '0'
          console.log(`✅ Convenio datea + DESCUENTO CAJA → $0`)
        } else if (esClienteNuevo) {
          // 2A — Nuevo: es continuidad automática → incentivo_base
          c.base = String(cfgValues.valorIncentivo)
          c.monto = String(cfgValues.valorIncentivo)
          c.montoAsesor = String(cfgValues.valorIncentivo)
          console.log(`✅ Convenio datea 🆕 NUEVO → asesor cobra $${cfgValues.valorIncentivo}`)
        } else if (esClienteRecurrente || esClienteRecuperacion) {
          if (tuvoContinuidad) {
            // 2B — Continuidad
            c.base = String(cfgValues.valorIncentivo)
            c.monto = String(cfgValues.valorIncentivo)
            c.montoAsesor = String(cfgValues.valorIncentivo)
            console.log(`✅ Convenio datea CONTINUIDAD → asesor cobra $${cfgValues.valorIncentivo}`)
          } else {
            // 2C/2D — Recurrente sin continuidad O Recuperación → dateo_recurrente
            // (recuperación usa el mismo valor que recurrente para asesor convenio)
            c.base = '0'
            c.monto = String(recValues.valorRecurrente)
            c.montoAsesor = String(recValues.valorRecurrente)
            const etiqueta = esClienteRecuperacion
              ? '💛 RECUPERACIÓN'
              : '🔄 RECURRENTE sin continuidad'
            console.log(
              `✅ Convenio datea ${etiqueta} → asesor cobra $${recValues.valorRecurrente}`
            )
          }
        }

        await c.useTransaction(trx).save()

        // ════════════════════════════════════════════════════
        //  CASO 3: CON CONVENIO — Comercial datea
        // ════════════════════════════════════════════════════
      } else {
        if (!dateo.agenteId) {
          console.warn('⚠️ Con convenio pero sin asesor comercial')
          await trx.rollback()
          return
        }

        const c = new Comision()
        c.captacionDateoId = dateo.id
        c.asesorId = dateo.agenteId
        c.convenioId = dateo.convenioId
        c.tipoServicio = 'RTM'
        c.estado = 'PENDIENTE'
        c.fechaCalculo = now
        c.calculadoPor = usuarioId
        c.porcentaje = '0'
        c.asesorSecundarioId = asesorConvenioIdReal
        c.valorNuevoDirecto = '0'
        c.esAvance = esAvance
        if (tipoVehiculoComision) (c as any).tipoVehiculo = tipoVehiculoComision

        if (esClienteNuevo) {
          c.base = String(cfgValues.valorIncentivoPorTipo)
          if (
            (esInformativoPolicia ||
              esInformativoEmpleado ||
              esAvancePropietario ||
              esObsequio ||
              esInformativoSoatRtm) &&
            descuentoOrigenCaja
          ) {
            // 🆕 CAMBIO 4
            // 🆕 INFORMATIVO_POLICIA / INFORMATIVO_EMPLEADO / AVANCE_PROPIETARIO / INFORMATIVO_OBSEQUIO aplicado en caja:
            // Comercial baja a valor dateo ($4.300), convenio queda en $0
            c.monto = String(recValues.valorRecurrente)
            c.montoAsesor = String(recValues.valorRecurrente)
            c.montoConvenio = '0'
            console.log(
              `✅ Comercial con convenio 🆕 NUEVO + INFORMATIVO_POLICIA/EMPLEADO/AVANCE_PROPIETARIO/OBSEQUIO (caja) → dateo $${recValues.valorRecurrente} | convenio $0`
            )
          } else if (esAvance) {
            // 🆕 AVANCE: montoConvenio = max(0, incentivo - montoAvance por tipo vehículo)
            c.monto = String(cfgValues.valorDateoNuevo)
            c.montoAsesor = String(cfgValues.valorDateoNuevo)
            const montoConvenioFinal = Math.max(0, cfgValues.valorIncentivoPorTipo - montoAvance)
            c.montoConvenio = String(montoConvenioFinal)
            c.descuentoMontoAplicado = montoAvance // 🆕
            console.log(
              `✅ Comercial con convenio 🆕 NUEVO + AVANCE → dateo $${cfgValues.valorDateoNuevo} + convenio $${montoConvenioFinal} (incentivo $${cfgValues.valorIncentivoPorTipo} - avance $${montoAvance})`
            )
          } else {
            c.monto = String(cfgValues.valorDateoNuevo)
            c.montoAsesor = String(cfgValues.valorDateoNuevo)
            c.montoConvenio = String(cfgValues.valorIncentivoPorTipo)
            console.log(
              `✅ Comercial con convenio 🆕 NUEVO → dateo $${cfgValues.valorDateoNuevo} + incentivo $${cfgValues.valorIncentivoPorTipo}`
            )
          }
        } else if (esClienteRecurrente) {
          // 3D/3E — Recurrente: comercial cobra dateo_via_convenio
          c.monto = String(cfgValues.valorDateoNuevo)
          c.montoAsesor = String(cfgValues.valorDateoNuevo)
          c.base = String(cfgValues.valorIncentivoPorTipo)
          if (esAvance) {
            const montoConvenioConAvance = Math.max(
              0,
              cfgValues.valorIncentivoPorTipo - montoAvance
            )
            c.montoConvenio = String(montoConvenioConAvance)
            c.descuentoMontoAplicado = montoAvance
            console.log(
              `✅ Comercial+convenio 🔄 RECURRENTE + AVANCE → dateo $${cfgValues.valorDateoNuevo} + convenio $${montoConvenioConAvance}`
            )
          } else {
            c.montoConvenio = String(cfgValues.valorIncentivoPorTipo)
            console.log(
              `✅ Comercial+convenio 🔄 RECURRENTE → dateo $${cfgValues.valorDateoNuevo} + convenio $${cfgValues.valorIncentivoPorTipo}`
            )
          }
        } else {
          // 3F/3G — Recuperación: comercial cobra dateo_via_convenio
          c.monto = String(cfgValues.valorDateoNuevo)
          c.montoAsesor = String(cfgValues.valorDateoNuevo)
          c.base = String(cfgValues.valorIncentivoPorTipo)
          if (esAvance) {
            const montoConvenioConAvance = Math.max(
              0,
              cfgValues.valorIncentivoPorTipo - montoAvance
            )
            c.montoConvenio = String(montoConvenioConAvance)
            c.descuentoMontoAplicado = montoAvance
            console.log(
              `✅ Comercial+convenio 💛 RECUPERACIÓN + AVANCE → dateo $${cfgValues.valorDateoNuevo} + convenio $${montoConvenioConAvance}`
            )
          } else {
            c.montoConvenio = String(cfgValues.valorIncentivoPorTipo)
            console.log(
              `✅ Comercial+convenio 💛 RECUPERACIÓN → dateo $${cfgValues.valorDateoNuevo} + convenio $${cfgValues.valorIncentivoPorTipo}`
            )
          }
        }
        await c.useTransaction(trx).save()
      }

      if (dateo.resultado !== 'EXITOSO') {
        dateo.resultado = 'EXITOSO'
        await dateo.useTransaction(trx).save()
      }

      await trx.commit()
      console.log('✅ Comisión guardada correctamente')
    } catch (err) {
      await trx.rollback()
      throw err
    } finally {
      // Siempre garantizar que el dateo quede EXITOSO si el ticket RTM fue confirmado
      try {
        const dateoFinal = await CaptacionDateo.find(dateo.id)
        if (dateoFinal && dateoFinal.resultado !== 'EXITOSO') {
          dateoFinal.resultado = 'EXITOSO'
          await dateoFinal.save()
          console.log(`✅ Dateo ${dateo.id} marcado EXITOSO (finally)`)
        }
      } catch (e) {
        console.error('❌ Error marcando dateo EXITOSO en finally:', e)
      }
    }
  }
  // ========================== Helpers privados ==========================

  private async fillSnapshotsFromTurno(ticket: FacturacionTicket, turno: TurnoRtm) {
    const t = turno as unknown as TurnoSnapshotReadable

    ticket.turnoNumeroGlobal = t.turnoNumero ?? ticket.turnoNumeroGlobal ?? null
    ticket.turnoNumeroServicio = t.turnoNumeroServicio ?? ticket.turnoNumeroServicio ?? null
    ticket.turnoCodigo = t.turnoCodigo ?? ticket.turnoCodigo ?? null
    ticket.tipoVehiculoSnapshot = t.tipoVehiculo ?? ticket.tipoVehiculoSnapshot ?? null
    ticket.placaTurno = t.placa ?? ticket.placaTurno ?? null
    ticket.canalAtribucion = t.canalAtribucion ?? ticket.canalAtribucion ?? null
    ticket.medioEntero = t.medioEntero ?? ticket.medioEntero ?? null

    const s = t.$preloaded?.servicio ?? null
    if (s) {
      ticket.servicioId = ticket.servicioId || s.id || null
      ticket.servicioCodigo = s.codigoServicio ?? ticket.servicioCodigo ?? null
      ticket.servicioNombre = s.nombreServicio ?? ticket.servicioNombre ?? null
    }

    const sede = t.$preloaded?.sede ?? null
    if (sede) ticket.sedeNombre = sede.nombre ?? ticket.sedeNombre ?? null

    const usuario = t.$preloaded?.usuario ?? null
    if (usuario) {
      const nombre = [usuario.nombres, usuario.apellidos].filter(Boolean).join(' ')
      ticket.funcionarioNombre = nombre || ticket.funcionarioNombre || null
    }
  }

  private async getTicketDTOById(id: number): Promise<TicketDTO> {
    const t = await FacturacionTicket.query()
      .where('id', id)
      .preload('servicio')
      .preload('sede')
      .preload('agente')
      .preload('dateo', (dq) => dq.preload('agente').preload('asesorConvenio').preload('convenio'))
      .preload('turno', (tq) =>
        tq
          .preload('servicio')
          .preload('usuario')
          .preload('sede')
          .preload('agenteCaptacion')
          .preload('captacionDateo', (cq) =>
            cq.preload('agente').preload('asesorConvenio').preload('convenio')
          )
      )
      .preload('descuento')
      .preload('autorizadoPor')
      .preload('confirmedBy')
      .firstOrFail()

    const dto = buildTicketDTO(t)

    const pre = (t as any).$preloaded || {}
    const dateoIdFromTurno = (pre.turno as any)?.captacionDateo?.id ?? null
    const dateoId: number | null = (t as any).dateoId ?? dateoIdFromTurno ?? null

    if (dateoId) {
      const comisiones = await Comision.query()
        .where('captacion_dateo_id', dateoId)
        .orderBy('fecha_calculo', 'desc')
        .preload('asesor')
        .preload('convenio')

      dto.comisiones = comisiones.map((c) => {
        const asesor = c.asesor as any
        const convenio = c.convenio as any
        return {
          id: c.id,
          estado: c.estado,
          monto: Number(c.monto ?? 0),
          asesor: asesor ? { id: asesor.id, nombre: asesor.nombre } : null,
          convenio: convenio ? { id: convenio.id, nombre: convenio.nombre } : null,
        }
      })
    }

    // 🆕 Poblar descuentoAplicado en el DTO
    const descuento = pre.descuento ?? null
    const autorizadoPor = pre.autorizadoPor ?? null
    const confirmedBy = pre.confirmedBy ?? null

    if (confirmedBy) {
      dto.confirmedBy = {
        id: confirmedBy.id,
        nombres: confirmedBy.nombres ?? null,
        apellidos: confirmedBy.apellidos ?? null,
      }
    }

    if (descuento && (t as any).descuentoMontoAplicado !== null) {
      dto.descuentoAplicado = {
        id: descuento.id,
        codigo: descuento.codigo,
        nombre: descuento.nombre,
        montoAplicado: Number((t as any).descuentoMontoAplicado ?? 0),
        autorizadoPor: autorizadoPor
          ? {
              id: autorizadoPor.id,
              nombre: [autorizadoPor.nombres, autorizadoPor.apellidos].filter(Boolean).join(' '),
            }
          : null,
      }
    } else {
      dto.descuentoAplicado = null
    }

    return dto
  }

  /**
   * POST /facturacion/tickets/:id/documentos-policia
   * Body: archivo (jpg/jpeg/png, máx 8mb) + tipo (carnet|tarjeta_propiedad|cedula)
   */
  public async subirDocumentoPolicia({ params, request, response }: HttpContext) {
    const ticket = await FacturacionTicket.find(params.id)
    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })

    if (ticket.estado === 'REVERTIDA') {
      return response.badRequest({
        message: 'No se pueden agregar documentos a un ticket revertido',
      })
    }

    const tipo = request.input('tipo') as string | undefined
    const tiposValidos = ['carnet', 'tarjeta_propiedad', 'cedula'] as const
    type TipoDoc = (typeof tiposValidos)[number]

    if (!tipo || !tiposValidos.includes(tipo as TipoDoc)) {
      return response.badRequest({
        message: `tipo inválido. Debe ser uno de: ${tiposValidos.join(', ')}`,
      })
    }

    const file = request.file('archivo', { size: '8mb', extnames: ['jpg', 'jpeg', 'png', 'jfif'] })
    if (!file) return response.badRequest({ message: 'archivo (image/*) requerido' })
    if (!file.isValid) return response.badRequest({ message: file.errors })

    const now = DateTime.now()
    const outDir = path.join(
      UPLOAD_BASE_DIR,
      'policia',
      String(now.year),
      String(now.month).padStart(2, '0')
    )
    await fs.mkdir(outDir, { recursive: true })

    const filename = `${cuid()}.${file.extname}`
    const filePath = path.join(outDir, filename)
    await fs.copyFile(file.tmpPath!, filePath)
    const relativePath = filePath.replace(app.makePath(), '')

    const campoMap: Record<TipoDoc, keyof FacturacionTicket> = {
      carnet: 'docCarnetPath',
      tarjeta_propiedad: 'docTarjetaPropiedadPath',
      cedula: 'docCedulaPath',
    }

    const campo = campoMap[tipo as TipoDoc]
    const pathAnterior = ticket[campo] as string | null

    if (pathAnterior) {
      try {
        await fs.unlink(app.makePath(pathAnterior))
      } catch {
        // Si no existe el archivo anterior no importa
      }
    }

    ;(ticket as any)[campo] = relativePath
    await ticket.save()

    return response.ok({
      success: true,
      message: `Documento '${tipo}' subido correctamente`,
      tipo,
      path: relativePath,
      documentos_completos: ticket.documentosPoliciaCargados,
      documentos_faltantes: ticket.documentosPoliciaFaltantes,
    })
  }

  /**
   * GET /facturacion/tickets/:id/documentos-policia/:tipo
   * tipo → carnet | tarjeta_propiedad | cedula
   */
  public async servirDocumentoPolicia({ params, response }: HttpContext) {
    const ticket = await FacturacionTicket.find(params.id)
    if (!ticket) return response.notFound({ message: 'Ticket no encontrado' })

    const campoMap: Record<string, keyof FacturacionTicket> = {
      carnet: 'docCarnetPath',
      tarjeta_propiedad: 'docTarjetaPropiedadPath',
      cedula: 'docCedulaPath',
    }

    const campo = campoMap[params.tipo]
    if (!campo) {
      return response.badRequest({
        message: 'tipo inválido. Debe ser: carnet, tarjeta_propiedad o cedula',
      })
    }

    const filePath = ticket[campo] as string | null
    if (!filePath) {
      return response.notFound({ message: `Documento '${params.tipo}' no encontrado` })
    }

    try {
      const absolutePath = app.makePath(filePath)
      await fs.access(absolutePath)
      return response.header('Content-Type', 'image/jpeg').download(absolutePath)
    } catch {
      return response.notFound({ message: `No se pudo cargar el documento '${params.tipo}'` })
    }
  }
}

// ============================== Utils ==============================

function isRTM(codigo?: string | null, nombre?: string | null): boolean {
  const c = (codigo || '').toUpperCase().trim()
  const n = (nombre || '').toUpperCase().trim()
  if (c.includes('RTM')) return true
  if (n.includes('RTM')) return true
  if (n.includes('TECNOMECANICA') || n.includes('TECNOMECÁNICA')) return true
  if (n.includes('REVISION') && n.includes('TECNICO')) return true
  return false
}

function isSOAT(codigo?: string | null, nombre?: string | null): boolean {
  const c = (codigo || '').toUpperCase().trim()
  const n = (nombre || '').toUpperCase().trim()
  if (c.includes('SOAT') || n.includes('SOAT')) return true
  if (c.includes('PREV') || n.includes('PREVENTIVA')) return true
  if (c.includes('PERI') || n.includes('PERITAJE')) return true
  return false
}

function digestSHA256(buffer: Buffer): string {
  const h = crypto.createHash('sha256')
  h.update(buffer)
  return h.digest('hex')
}

function toIntOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function toNumberOrZero(v: unknown): number {
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) ? n : 0
}

function nullIfEmpty(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim()
  return s.length ? s : null
}

function sanitizeNit(v: string): string {
  return String(v).replace(/[^\d\-\.]/g, '')
}

function placaValida(placa?: string | null): boolean {
  if (!placa) return false
  const rex = /^(?:[A-Z]{3}\d{3}|[A-Z]{3}\d{2}[A-Z]?|\d{3}[A-Z]{3})$/
  return rex.test(placa.toUpperCase())
}

function canConfirm(t: FacturacionTicket, _hard: boolean): boolean {
  const totalNum = t.total && t.total > 0 ? t.total : t.totalFactura || 0
  return (
    placaValida(t.placa) &&
    !!totalNum &&
    totalNum > 0 &&
    !!t.fechaPago &&
    (!!t.sedeId || !!t.agenteId)
  )
}

async function isContentDuplicate(t: FacturacionTicket): Promise<boolean> {
  const totalNum = t.total && t.total > 0 ? t.total : t.totalFactura || 0
  if (!t.placa || !totalNum || !t.fechaPago) return false
  const min = t.fechaPago.minus({ minutes: DUP_WINDOW_MINUTES }).toSQL()
  const max = t.fechaPago.plus({ minutes: DUP_WINDOW_MINUTES }).toSQL()

  const row = await FacturacionTicket.query()
    .whereNot('id', t.id || 0)
    .where('placa', t.placa)
    .where('total', totalNum)
    .whereBetween('fecha_pago', [min!, max!])
    .count('* as total')
  const n = Number(row[0]?.$extras.total || 0)
  return n > 0
}

/* =================== DTO / Serializadores =================== */

function serializeTurnoEnriquecido(turno: TurnoRtm): TurnoDTO {
  const t = turno as unknown as TurnoSnapshotReadable

  const servicio: ServicioDTO | null = t.$preloaded?.servicio
    ? {
        id: t.$preloaded.servicio.id,
        codigoServicio: t.$preloaded.servicio.codigoServicio ?? null,
        nombreServicio: t.$preloaded.servicio.nombreServicio ?? null,
      }
    : null

  const usuario: UsuarioDTO | null = t.$preloaded?.usuario
    ? {
        id: t.$preloaded.usuario.id,
        nombres: t.$preloaded.usuario.nombres ?? null,
        apellidos: t.$preloaded.usuario.apellidos ?? null,
      }
    : null

  const sede: SedeDTO | null = t.$preloaded?.sede
    ? { id: t.$preloaded.sede.id, nombre: t.$preloaded.sede.nombre }
    : null

  const agenteCaptacion: AgenteDTO | null = t.$preloaded?.agenteCaptacion
    ? {
        id: t.$preloaded.agenteCaptacion.id,
        nombre: t.$preloaded.agenteCaptacion.nombre,
        tipo: t.$preloaded.agenteCaptacion.tipo ?? null,
      }
    : null

  const dateo = t.$preloaded?.captacionDateo ?? null
  const asesorConvenio: AgenteDTO | null = dateo?.asesorConvenio
    ? {
        id: dateo.asesorConvenio.id,
        nombre: dateo.asesorConvenio.nombre,
        tipo: dateo.asesorConvenio.tipo ?? null,
      }
    : null

  const convenio: ConvenioDTO | null = dateo?.convenio
    ? {
        id: dateo.convenio.id,
        codigo: dateo.convenio.codigo ?? null,
        nombre: dateo.convenio.nombre,
      }
    : null

  return {
    id: (turno as unknown as { id: number }).id,
    turnoNumero: t.turnoNumero ?? null,
    turnoNumeroServicio: t.turnoNumeroServicio ?? null,
    turnoCodigo: t.turnoCodigo ?? null,
    placa: t.placa ?? null,
    estado: t.estado ?? null,
    fecha: t.fecha ?? null,
    horaIngreso: t.horaIngreso ?? null,
    horaSalida: t.horaSalida ?? null,
    tiempoServicio: t.tiempoServicio ?? null,
    tipoVehiculo: t.tipoVehiculo ?? null,
    medioEntero: t.medioEntero ?? null,
    canalAtribucion: t.canalAtribucion ?? null,
    servicio,
    usuario,
    sede,
    agenteCaptacion,
    asesorConvenio,
    convenio,
  }
}

function buildTicketDTO(ticket: FacturacionTicket): TicketDTO {
  const s = ticket.serialize() as any
  const pick = (camel: string, snake: string) => s[camel] ?? s[snake] ?? null

  const pre = (ticket as any).$preloaded || {}
  const turnoDTO: TurnoDTO | null = pre.turno
    ? serializeTurnoEnriquecido(pre.turno as TurnoRtm)
    : null
  const dateoFromTurno = (pre.turno as any)?.$preloaded?.captacionDateo ?? null

  const dateoEnriquecido: DateoDTO | null =
    s.dateo ??
    (dateoFromTurno
      ? {
          id: dateoFromTurno.id,
          canal: dateoFromTurno.canal,
          agente: dateoFromTurno.agente
            ? {
                id: dateoFromTurno.agente.id,
                nombre: dateoFromTurno.agente.nombre,
                tipo: dateoFromTurno.agente.tipo ?? null,
              }
            : null,
          asesorConvenio: dateoFromTurno.asesorConvenio
            ? {
                id: dateoFromTurno.asesorConvenio.id,
                nombre: dateoFromTurno.asesorConvenio.nombre,
                tipo: dateoFromTurno.asesorConvenio.tipo ?? null,
              }
            : null,
          convenio: dateoFromTurno.convenio
            ? {
                id: dateoFromTurno.convenio.id,
                codigo: dateoFromTurno.convenio.codigo ?? null,
                nombre: dateoFromTurno.convenio.nombre,
              }
            : null,
        }
      : null)

  const servicioCodigo =
    pick('servicioCodigo', 'servicio_codigo') ?? turnoDTO?.servicio?.codigoServicio ?? null
  const servicioNombre =
    pick('servicioNombre', 'servicio_nombre') ?? turnoDTO?.servicio?.nombreServicio ?? null
  const tipoVehiculoSnapshot =
    pick('tipoVehiculoSnapshot', 'tipo_vehiculo') ?? turnoDTO?.tipoVehiculo ?? null
  const turnoGlobal =
    pick('turnoNumeroGlobal', 'turno_numero_global') ?? turnoDTO?.turnoNumero ?? null
  const turnoServicio =
    pick('turnoNumeroServicio', 'turno_numero_servicio') ?? turnoDTO?.turnoNumeroServicio ?? null
  const turnoCodigo = pick('turnoCodigo', 'turno_codigo') ?? turnoDTO?.turnoCodigo ?? null
  const placaTurno = pick('placaTurno', 'placa_turno') ?? turnoDTO?.placa ?? null
  const sedeNombre = pick('sedeNombre', 'sede_nombre') ?? turnoDTO?.sede?.nombre ?? null
  const funcionarioNombre =
    pick('funcionarioNombre', 'funcionario_nombre') ??
    (turnoDTO?.usuario
      ? [turnoDTO.usuario.nombres, turnoDTO.usuario.apellidos].filter(Boolean).join(' ')
      : null)
  const canalAtribucion =
    pick('canalAtribucion', 'canal_atribucion') ?? turnoDTO?.canalAtribucion ?? null
  const medioEntero = pick('medioEntero', 'medio_entero') ?? turnoDTO?.medioEntero ?? null

  return {
    id: s.id,
    estado: s.estado,
    hash: s.hash,
    filePath: pick('filePath', 'file_path'),
    fileMime: pick('fileMime', 'file_mime'),
    fileSize: pick('fileSize', 'file_size'),
    imageRotation: pick('imageRotation', 'image_rotation'),
    createdAt: pick('createdAt', 'created_at'),
    updatedAt: pick('updatedAt', 'updated_at'),
    placa: s.placa ?? null,
    fechaPago: pick('fechaPago', 'fecha_pago'),
    total: s.total ?? null,
    subtotal: pick('subtotal', 'subtotal'),
    iva: pick('iva', 'iva'),
    totalFactura: pick('totalFactura', 'total_factura'),
    totalSinDescuento: pick('totalSinDescuento', 'total_sin_descuento'),
    vendedorText: pick('vendedorText', 'vendedor_text'),
    prefijo: s.prefijo ?? null,
    consecutivo: s.consecutivo ?? null,
    nit: s.nit ?? null,
    pin: s.pin ?? null,
    marca: s.marca ?? null,
    turnoId: pick('turnoId', 'turno_id'),
    servicioId: pick('servicioId', 'servicio_id'),
    sedeId: pick('sedeId', 'sede_id'),
    agenteId: pick('agenteId', 'agente_id'),
    dateoId: pick('dateoId', 'dateo_id'),
    servicioCodigo,
    servicioNombre,
    tipoVehiculoSnapshot,
    turnoGlobal,
    turnoServicio,
    turnoCodigo,
    placaTurno,
    sedeNombre,
    funcionarioNombre,
    canalAtribucion,
    medioEntero,
    confirmadoAt: pick('confirmadoAt', 'confirmado_at'),
    confirmedById: pick('confirmedById', 'confirmed_by_id'),
    turno: turnoDTO,
    dateo: dateoEnriquecido,
    descuentoAplicado: null,
  }
}

/* ======================= Helpers de configuración ======================= */

type TipoVehiculoComision = 'MOTO' | 'VEHICULO'

function inferTipoVehiculoComision(opts: {
  ticketTipo?: string | null
  turnoTipo?: string | null
}): TipoVehiculoComision | null {
  const normalize = (v?: string | null) => (v ?? '').toString().toUpperCase().trim()
  const txt = normalize(opts.ticketTipo) || normalize(opts.turnoTipo)
  if (!txt) return null
  if (txt.includes('MOTO')) return 'MOTO'
  return 'VEHICULO'
}

async function resolveConfigComision(params: {
  asesorId: number | null
  asesorConvenioId: number | null
  tipoVehiculo: TipoVehiculoComision | null
}): Promise<{
  valorIncentivo: number
  valorIncentivoPorTipo: number
  valorDateoNuevo: number
  valorNuevoDirecto: number
}> {
  const { asesorId, asesorConvenioId, tipoVehiculo } = params

  const num = (v: any) => {
    const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : 0
  }

  const tryFind = async (aId: number | null, tv: string | null) => {
    const q = Comision.query().where('es_config', true)
    if (aId === null) q.whereNull('asesor_id')
    else q.where('asesor_id', aId)
    if (tv === null) q.whereNull('tipo_vehiculo')
    else q.where('tipo_vehiculo', tv)
    return q.first()
  }

  // Búsqueda 1: config del COMERCIAL (dateo nuevo, nuevo directo)
  let rowComercial: Comision | null = null
  if (asesorId && tipoVehiculo) rowComercial = await tryFind(asesorId, tipoVehiculo)
  if (!rowComercial && asesorId) rowComercial = await tryFind(asesorId, null)
  if (!rowComercial && tipoVehiculo) rowComercial = await tryFind(null, tipoVehiculo)
  if (!rowComercial) rowComercial = await tryFind(null, null)

  // Búsqueda 2: incentivo — config personal del convenio (cualquier tipo), fallback global
  let rowIncentivo: Comision | null = null
  if (asesorConvenioId && tipoVehiculo) rowIncentivo = await tryFind(asesorConvenioId, tipoVehiculo)
  if (!rowIncentivo && asesorConvenioId) {
    // Buscar fila del convenio con CUALQUIER tipo de vehículo (MOTO o VEHICULO)
    // para extraer luego el campo correcto según tipo real del vehículo
    const rowConvenioMoto = await tryFind(asesorConvenioId, 'MOTO')
    const rowConvenioVehiculo = await tryFind(asesorConvenioId, 'VEHICULO')
    rowIncentivo = rowConvenioMoto ?? rowConvenioVehiculo ?? null
  }
  if (!rowIncentivo && tipoVehiculo) rowIncentivo = await tryFind(null, tipoVehiculo)
  if (!rowIncentivo) rowIncentivo = await tryFind(null, null)

  // Mantener rowGlobal solo para valorIncentivo base (fallback)
  let rowGlobal: Comision | null = null
  if (tipoVehiculo) rowGlobal = await tryFind(null, tipoVehiculo)
  if (!rowGlobal) rowGlobal = await tryFind(null, null)

  // Calcular incentivo por tipo
  // Prioridad: valorPlacaMoto/valorPlacaVehiculo específico > base
  // Si rowIncentivo es de VEHICULO pero el vehículo real es MOTO,
  // intenta leer valorPlacaMoto de esa fila antes de caer al base
  let valorIncentivoPorTipo = 0
  if (rowIncentivo) {
    if (tipoVehiculo === 'MOTO') {
      if (rowIncentivo.valorPlacaMoto !== null && rowIncentivo.valorPlacaMoto !== undefined) {
        valorIncentivoPorTipo = num(rowIncentivo.valorPlacaMoto)
      } else {
        // Intentar buscar otra fila del mismo convenio con tipo MOTO
        const rowMotoEspecifica = asesorConvenioId ? await tryFind(asesorConvenioId, 'MOTO') : null
        valorIncentivoPorTipo = rowMotoEspecifica
          ? rowMotoEspecifica.valorPlacaMoto !== null
            ? num(rowMotoEspecifica.valorPlacaMoto)
            : num(rowMotoEspecifica.base)
          : num(rowIncentivo.base)
      }
    } else if (tipoVehiculo === 'VEHICULO') {
      if (
        rowIncentivo.valorPlacaVehiculo !== null &&
        rowIncentivo.valorPlacaVehiculo !== undefined
      ) {
        valorIncentivoPorTipo = num(rowIncentivo.valorPlacaVehiculo)
      } else {
        const rowVehiculoEspecifica = asesorConvenioId
          ? await tryFind(asesorConvenioId, 'VEHICULO')
          : null
        valorIncentivoPorTipo = rowVehiculoEspecifica
          ? rowVehiculoEspecifica.valorPlacaVehiculo !== null
            ? num(rowVehiculoEspecifica.valorPlacaVehiculo)
            : num(rowVehiculoEspecifica.base)
          : num(rowIncentivo.base)
      }
    } else {
      valorIncentivoPorTipo = num(rowIncentivo.base)
    }
  }

  const valorIncentivo = rowIncentivo ? num(rowIncentivo.base) : 14000
  console.log(`   💰 resolveConfigComision`)
  console.log(
    `      COMERCIAL → fila: ${rowComercial?.asesorId ?? 'global'} | dateoNuevo: $${num(rowComercial?.monto)} | nuevoDirecto: $${num(rowComercial?.valorNuevoDirecto)}`
  )
  console.log(
    `      INCENTIVO → personal/global | base: $${valorIncentivo} | incentivoPorTipo: $${valorIncentivoPorTipo}`
  )

  return {
    valorIncentivo,
    valorIncentivoPorTipo,
    valorDateoNuevo: num(rowComercial?.monto),
    valorNuevoDirecto: num(rowComercial?.valorNuevoDirecto),
  }
}

async function resolveConfigRecurrencia(
  asesorId: number | null,
  tipoVehiculo: TipoVehiculoComision | null = null
): Promise<{
  valorRecurrente: number
  valorRecuperacion: number
}> {
  const esMoto = tipoVehiculo === 'MOTO'

  const globalCfg = await Database.from('configuracion_recurrencia_global')
    .orderBy('id', 'asc')
    .first()

  let valorRecurrente: number
  let valorRecuperacion: number

  if (esMoto) {
    valorRecurrente = Number(
      globalCfg?.valor_dateo_recurrencia_moto ?? globalCfg?.valor_dateo_recurrencia ?? 4300
    )
    valorRecuperacion = Number(
      globalCfg?.valor_dateo_recuperacion_moto ?? globalCfg?.valor_dateo_recuperacion ?? 8600
    )
  } else {
    valorRecurrente = Number(
      globalCfg?.valor_dateo_recurrencia_vehiculo ?? globalCfg?.valor_dateo_recurrencia ?? 4300
    )
    valorRecuperacion = Number(
      globalCfg?.valor_dateo_recuperacion_vehiculo ?? globalCfg?.valor_dateo_recuperacion ?? 8600
    )
  }

  if (asesorId) {
    const asesorCfg = await Database.from('configuracion_recurrencia_asesores')
      .where('asesor_id', asesorId)
      .where('recurrencia_habilitada', true)
      .first()

    if (asesorCfg?.valor_dateo_recurrencia)
      valorRecurrente = Number(asesorCfg.valor_dateo_recurrencia)
    if (asesorCfg?.valor_dateo_recuperacion)
      valorRecuperacion = Number(asesorCfg.valor_dateo_recuperacion)
  }

  console.log(
    `   💰 resolveConfigRecurrencia | tipoVehiculo: ${tipoVehiculo} | recurrente: $${valorRecurrente} | recuperacion: $${valorRecuperacion}`
  )

  return { valorRecurrente, valorRecuperacion }
}

async function verificarContinuidad(params: {
  ultimoTurnoId: number | null
  asesorConvenioIdActual: number | null
  convenioIdActual: number | null
  placaTurno?: string | null
}): Promise<boolean> {
  const { ultimoTurnoId, asesorConvenioIdActual, convenioIdActual, placaTurno } = params

  if (!convenioIdActual && !asesorConvenioIdActual) return false

  // Continuidad real: TODAS las visitas históricas del cliente deben haber
  // sido con este mismo convenio/asesor. Una sola visita sin él rompe la continuidad.

  // Obtener todos los turnos finalizados de esta placa (historia completa)
  let todosLosTurnos: any[] = []
  if (placaTurno) {
    todosLosTurnos = await Database.from('turnos_rtms')
      .where('placa', placaTurno)
      .where('estado', 'finalizado')
      .orderBy('fecha', 'asc')
      .select('id', 'captacion_dateo_id')
  } else if (ultimoTurnoId) {
    // Si no tenemos la placa, solo revisamos el último turno (comportamiento anterior)
    const turnoAnterior = await Database.from('turnos_rtms')
      .where('id', ultimoTurnoId)
      .select('captacion_dateo_id')
      .first()

    const dateoAnteriorId = turnoAnterior?.captacion_dateo_id ?? null
    if (!dateoAnteriorId) return false

    const dateoAnterior = await Database.from('captacion_dateos')
      .where('id', dateoAnteriorId)
      .select('convenio_id', 'agente_id')
      .first()

    if (!dateoAnterior) return false
    if (convenioIdActual && dateoAnterior.convenio_id === convenioIdActual) return true
    if (asesorConvenioIdActual && dateoAnterior.agente_id === asesorConvenioIdActual) return true
    return false
  }

  if (!todosLosTurnos.length) return false

  // Revisar TODOS los dateos históricos
  // Si alguna visita NO fue con este convenio/asesor → no hay continuidad
  for (const turno of todosLosTurnos) {
    const dateoId = turno.captacion_dateo_id
    if (!dateoId) return false // Visita sin dateo → rompe continuidad

    const dateo = await Database.from('captacion_dateos')
      .where('id', dateoId)
      .select('convenio_id', 'agente_id')
      .first()

    if (!dateo) return false

    const esteConvenio = convenioIdActual && dateo.convenio_id === convenioIdActual
    const esteAsesor = asesorConvenioIdActual && dateo.agente_id === asesorConvenioIdActual

    if (!esteConvenio && !esteAsesor) return false // Esta visita fue con otro → sin continuidad
  }

  return true // Todas las visitas fueron con este asesor/convenio
}

/* ======================== OCR Fake ======================== */

function fakeOCR(): {
  text: string
  confidence: { placa: number; total: number; fecha: number; agente: number }
  placa: string
  total: number
  fechaHora: string
} {
  const placas = ['ABC123', 'QQX91C', 'FDS456']
  const placa = placas[Math.floor(Math.random() * placas.length)]
  const totals = [90000, 120000, 150000, 307850]
  const total = totals[Math.floor(Math.random() * totals.length)]
  const fechaHora = DateTime.now().minus({ minutes: 5 }).toISO()

  return {
    text: `TICKET\nTOTAL: ${total}\nPLACA: ${placa}\nFECHA: ${fechaHora}`,
    confidence: { placa: 0.86, total: 0.92, fecha: 0.78, agente: 0.55 },
    placa,
    total,
    fechaHora: fechaHora || DateTime.now().toISO(),
  }
}
