// app/Controllers/Http/clientes_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import Cliente from '#models/cliente'
import Vehiculo from '#models/vehiculo'
import TurnoRtm from '#models/turno_rtm'

function normalizePhone(value?: string): string | undefined {
  if (!value) return value
  return value.replace(/\D/g, '')
}

function toBogotaDateTime(v: unknown): DateTime | null {
  if (!v) return null
  if (v instanceof Date) {
    return DateTime.fromJSDate(v, { zone: 'America/Bogota' }).startOf('day')
  }
  const s = String(v)
  const dt =
    s.length <= 10
      ? DateTime.fromFormat(s, 'yyyy-LL-dd', { zone: 'America/Bogota' })
      : DateTime.fromISO(s, { zone: 'America/Bogota' })
  return dt.isValid ? dt.startOf('day') : null
}

/**
 * Busca o crea un cliente usando la siguiente prioridad:
 *  1° DOCUMENTO  → más confiable, nunca se repite
 *  2° TELÉFONO   → solo si el documento también coincide (evita teléfonos falsos/compartidos)
 *  3° CREAR NUEVO → email solo si nadie más lo tiene, si no queda null
 *
 * ⛔ EMAIL nunca se usa para buscar — es un dato de contacto, no un identificador único.
 */
export async function findOrCreateCliente(data: {
  docTipo?: string | null
  docNumero?: string | null
  telefono?: string | null
  email?: string | null
  nombre?: string | null
  ciudadId?: number | null
}): Promise<{ cliente: InstanceType<typeof Cliente>; creado: boolean }> {
  const docTipo = data.docTipo?.trim() || null
  const docNumero = data.docNumero?.trim() || null
  const telefono = normalizePhone(data.telefono || '') || undefined
  const emailRaw = data.email?.trim().toLowerCase() || null
  const nombre = data.nombre?.trim() || null

  let cliente: InstanceType<typeof Cliente> | null = null

  // ── 1° PRIORIDAD: DOCUMENTO ──────────────────────────────────────────────
  if (docTipo && docNumero) {
    cliente = await Cliente.query()
      .where('doc_tipo', docTipo)
      .andWhere('doc_numero', docNumero)
      .first()

    if (cliente) {
      if (!cliente.nombre && nombre) cliente.nombre = nombre
      if (!cliente.telefono && telefono) cliente.telefono = telefono
      if (!cliente.email && emailRaw) {
        const emailEnUso = await Cliente.query()
          .whereRaw('LOWER(email) = ?', [emailRaw])
          .whereNot('id', cliente.id)
          .first()
        if (!emailEnUso) cliente.email = emailRaw
      }
      await cliente.save()
      return { cliente, creado: false }
    }
  }

  // ── 2° PRIORIDAD: TELÉFONO ───────────────────────────────────────────────
  // Solo usar si el documento también coincide. Evita fusionar personas distintas
  // que comparten teléfono falso (ej: 3333333333) o el teléfono de otra persona.
  if (!cliente && telefono) {
    const porTelefono = await Cliente.findBy('telefono', telefono)
    if (porTelefono) {
      const docCoincide =
        !docNumero || !porTelefono.docNumero || porTelefono.docNumero === docNumero
      if (docCoincide) {
        cliente = porTelefono
        if (!cliente.nombre && nombre) cliente.nombre = nombre
        if (!cliente.docTipo && docTipo) cliente.docTipo = docTipo
        if (!cliente.docNumero && docNumero) cliente.docNumero = docNumero
        if (!cliente.email && emailRaw) {
          const emailEnUso = await Cliente.query()
            .whereRaw('LOWER(email) = ?', [emailRaw])
            .whereNot('id', cliente.id)
            .first()
          if (!emailEnUso) cliente.email = emailRaw
        }
        await cliente.save()
        return { cliente, creado: false }
      }
    }
  }

  // ── 3° CREAR CLIENTE NUEVO ───────────────────────────────────────────────
  // Email solo se asigna si nadie más lo tiene
  let emailFinal: string | null = emailRaw
  if (emailRaw) {
    const emailEnUso = await Cliente.query().whereRaw('LOWER(email) = ?', [emailRaw]).first()
    if (emailEnUso) emailFinal = null
  }

  cliente = await Cliente.create({
    nombre: nombre || null,
    docTipo: docTipo || null,
    docNumero: docNumero || null,
    telefono: telefono ?? '',
    email: emailFinal,
    ciudadId: data.ciudadId ?? null,
  })

  return { cliente, creado: true }
}

export default class ClientesController {
  /** GET /clientes?page=1&perPage=20&q=... */
  public async index({ request, response }: HttpContext) {
    const page = Number(request.input('page', 1))
    const perPage = Math.min(Number(request.input('perPage', 20)), 100)
    const q = String(request.input('q', '')).trim()

    try {
      const query = Cliente.query().orderBy('id', 'desc')

      if (q) {
        const searchTerm = q
        const cleanSearch = searchTerm.toUpperCase().replace(/[^A-Z0-9]/g, '')

        const vehiculosConPlaca = await Vehiculo.query()
          .whereRaw("REPLACE(REPLACE(UPPER(placa), '-', ''), ' ', '') LIKE ?", [`%${cleanSearch}%`])
          .select('cliente_id')
          .whereNotNull('cliente_id')

        const clienteIdsConPlaca = vehiculosConPlaca
          .map((v) => v.clienteId ?? (v as any).cliente_id)
          .filter((id) => id !== null && id !== undefined) as number[]

        query.where((builder) => {
          builder
            .whereRaw('LOWER(nombre) LIKE ?', [`%${searchTerm.toLowerCase()}%`])
            .orWhereRaw('telefono LIKE ?', [`%${searchTerm}%`])
            .orWhereRaw('doc_numero LIKE ?', [`%${searchTerm}%`])
            .orWhereRaw('email LIKE ?', [`%${searchTerm.toLowerCase()}%`])

          if (clienteIdsConPlaca.length > 0) {
            builder.orWhereIn('id', clienteIdsConPlaca)
          }
        })
      }

      const paginatedResult = await query.paginate(page, perPage)

      return response.ok({
        data: paginatedResult.all(),
        meta: paginatedResult.getMeta(),
      })
    } catch (error) {
      console.error('Error en index clientes:', error)
      return response.internalServerError({ message: 'Error al obtener clientes' })
    }
  }

  /** GET /clientes/:id */
  public async show({ params, response }: HttpContext) {
    const item = await Cliente.find(params.id)
    if (!item) return response.notFound({ message: 'Cliente no encontrado' })
    return item
  }

  /** POST /clientes */
  public async store({ request, response }: HttpContext) {
    const {
      nombre,
      doc_tipo: docTipo,
      doc_numero: docNumero,
      telefono: rawTelefono,
      email,
      ciudad_id: ciudadId,
    } = request.only(['nombre', 'doc_tipo', 'doc_numero', 'telefono', 'email', 'ciudad_id'])

    const telefono = normalizePhone(rawTelefono) || ''
    if (!telefono) return response.badRequest({ message: 'telefono es requerido' })

    const telExists = await Cliente.findBy('telefono', telefono)
    if (telExists) return response.conflict({ message: 'El teléfono ya existe' })

    if (docTipo && docNumero) {
      const docExists = await Cliente.query()
        .where('doc_tipo', docTipo)
        .andWhere('doc_numero', docNumero)
        .first()
      if (docExists) return response.conflict({ message: 'Documento ya existe' })
    }

    const created = await Cliente.create({
      nombre: nombre?.trim() || null,
      docTipo: docTipo || null,
      docNumero: docNumero?.trim() || null,
      telefono,
      email: email?.trim() || null,
      ciudadId: ciudadId ?? null,
    })

    return response.created(created)
  }

  /** PUT /clientes/:id */
  public async update({ params, request, response }: HttpContext) {
    const item = await Cliente.find(params.id)
    if (!item) return response.notFound({ message: 'Cliente no encontrado' })

    const {
      nombre,
      doc_tipo: docTipo,
      doc_numero: docNumero,
      telefono: rawTelefono,
      email,
      ciudad_id: ciudadId,
    } = request.only(['nombre', 'doc_tipo', 'doc_numero', 'telefono', 'email', 'ciudad_id'])

    if (typeof nombre === 'string') item.nombre = nombre.trim() || null
    if (typeof email === 'string') item.email = email.trim() || null
    if (ciudadId !== undefined) item.ciudadId = ciudadId ?? null

    if (rawTelefono !== undefined) {
      const newTel = normalizePhone(rawTelefono) || null
      if (!newTel) return response.badRequest({ message: 'telefono no puede ser vacío' })
      if (newTel !== item.telefono) {
        const telExists = await Cliente.query()
          .where('telefono', newTel)
          .whereNot('id', item.id)
          .first()
        if (telExists) return response.conflict({ message: 'El teléfono ya está en uso' })
        item.telefono = newTel
      }
    }

    if (docTipo !== undefined || docNumero !== undefined) {
      const newTipo = docTipo ?? item.docTipo
      const newNumero = docNumero?.trim() ?? item.docNumero
      if (newTipo && newNumero) {
        const docExists = await Cliente.query()
          .where('doc_tipo', newTipo)
          .andWhere('doc_numero', newNumero)
          .whereNot('id', item.id)
          .first()
        if (docExists) return response.conflict({ message: 'Documento ya está en uso' })
        item.docTipo = newTipo
        item.docNumero = newNumero
      } else {
        item.docTipo = newTipo || null
        item.docNumero = newNumero || null
      }
    }

    await item.save()
    return item
  }

  /** DELETE /clientes/:id */
  public async destroy({ params, response }: HttpContext) {
    const item = await Cliente.find(params.id)
    if (!item) return response.notFound({ message: 'Cliente no encontrado' })

    const [{ total }] = await db
      .from('vehiculos')
      .where('cliente_id', params.id)
      .count('* as total')
    if (Number(total) > 0) {
      return response.conflict({
        message: 'No se puede eliminar: existen vehículos asociados a este cliente.',
      })
    }

    await item.delete()
    return response.noContent()
  }

  // ===================== VISTAS ENRIQUECIDAS =====================

  /** GET /clientes/:id/detalle */
  public async detalle({ params, response }: HttpContext) {
    const id = Number(params.id)
    const cliente = await Cliente.find(id)
    if (!cliente) return response.notFound({ message: 'Cliente no encontrado' })

    const vehiculos = await Vehiculo.query().where('cliente_id', id).preload('clase')
    const placasCliente = vehiculos.map((v) => v.placa).filter(Boolean)

    const base = db
      .from('turnos_rtms as t')
      .leftJoin('vehiculos as v', 'v.id', 't.vehiculo_id')
      .where((qb) => {
        qb.where('t.cliente_id', id).orWhere('v.cliente_id', id)
        if (placasCliente.length > 0) {
          qb.orWhereIn('t.placa', placasCliente)
        }
      })

    const [{ total_visitas: totalVisitas, ultima }] = await base
      .clone()
      .count('* as total_visitas')
      .max('t.fecha as ultima')

    const last = toBogotaDateTime(ultima)
    const today = DateTime.now().setZone('America/Bogota').startOf('day')
    const diasDesdeUltimaVisita =
      last && last.isValid
        ? String(Math.max(0, Math.floor(today.diff(last, 'days').days ?? 0)))
        : null

    const serviciosTopRaw = await base
      .clone()
      .select('t.servicio_id')
      .count('* as cnt')
      .groupBy('t.servicio_id')
      .orderBy('cnt', 'desc')
      .limit(5)

    const ultimasPorVehiculo: Array<{
      vehiculoId: number
      placa: string
      fecha: string | null
      servicioNombre: string | null
      estado: string | null
      sedeNombre: string | null
    }> = []

    for (const v of vehiculos) {
      const t = await TurnoRtm.query()
        .where((qb) => {
          qb.where('vehiculo_id', v.id).orWhere('placa', v.placa)
        })
        .orderBy('fecha', 'desc')
        .orderBy('turno_numero', 'desc')
        .preload('servicio')
        .preload('sede')
        .first()

      ultimasPorVehiculo.push({
        vehiculoId: v.id,
        placa: v.placa,
        fecha: t?.fecha ? t.fecha.toISODate() : null,
        servicioNombre: (t as any)?.$preloaded?.servicio?.nombreServicio ?? null,
        estado: t?.estado ?? null,
        sedeNombre: (t as any)?.$preloaded?.sede?.nombre ?? null,
      })
    }

    const recientes = await base
      .clone()
      .leftJoin('servicios as s', 's.id', 't.servicio_id')
      .leftJoin('sedes as se', 'se.id', 't.sede_id')
      .joinRaw(
        `LEFT JOIN captacion_dateos as cd ON cd.id = COALESCE(
  t.captacion_dateo_id,
  (
    SELECT t2.captacion_dateo_id
    FROM turnos_rtms t2
    WHERE t2.placa = t.placa
    AND t2.turno_numero < 0
    AND t2.captacion_dateo_id IS NOT NULL
    AND ABS(DATEDIFF(t2.fecha, t.fecha)) <= 7
    ORDER BY ABS(DATEDIFF(t2.fecha, t.fecha))
    LIMIT 1
  )
)`
      )
      .leftJoin('agentes_captacions as ac', 'ac.id', 'cd.agente_id')
      .leftJoin('convenios as cv', 'cv.id', 'cd.convenio_id')
      .select([
        't.id',
        't.fecha',
        't.turno_numero',
        't.placa',
        't.estado',
        's.nombre_servicio as servicioNombre',
        'se.nombre as sedeNombre',
        'ac.nombre as asesorNombre',
        'cv.nombre as convenioNombre',
        'cv.establecimiento as convenioEstablecimiento',
        't.es_recurrente as esRecurrente',
        't.es_recuperacion as esRecuperacion',
      ])
      .where('t.turno_numero', '>=', 0)
      .orderBy('t.fecha', 'desc')
      .orderBy('t.turno_numero', 'desc')
      .limit(5)

    const metricas = {
      vehiculos_count: vehiculos.length,
      visitas_count: Number(totalVisitas ?? 0),
      ultima_visita_at: last && last.isValid ? last.toISODate() : null,
      dias_desde_ultima_visita: diasDesdeUltimaVisita,
      servicios_top: (serviciosTopRaw || []).map((r: any) => ({
        servicio_id: Number(r.servicio_id ?? r.servicioId ?? r['t.servicio_id']),
        cnt: Number(r.cnt ?? r['count'] ?? r.$extras?.cnt ?? 0),
      })),
    }

    return response.ok({
      cliente,
      vehiculos: vehiculos.map((v) => ({
        id: v.id,
        placa: v.placa,
        marca: v.marca,
        linea: v.linea,
        modelo: v.modelo,
        color: v.color,
        matricula: v.matricula,
        clase: v.$preloaded?.clase
          ? { id: v.claseVehiculoId, nombre: (v.$preloaded as any).clase?.nombre }
          : undefined,
      })),
      metricas,
      kpis: metricas,
      ultimas_por_vehiculo: ultimasPorVehiculo,
      visitas_recientes: recientes,
    })
  }

  /** GET /clientes/:id/historial */
  public async historial({ params, request, response }: HttpContext) {
    const id = Number(params.id)
    const page = Number(request.input('page', 1))
    const perPage = Math.min(Number(request.input('perPage', 20)), 100)

    const servicioId = request.input('servicioId')
    const servicioCodigo = request.input('servicioCodigo')
    const sedeId = request.input('sedeId')
    const placa = String(request.input('placa', '')).trim()
    const desde = request.input('desde')
    const hasta = request.input('hasta')
    const estado = request.input('estado')

    let q = db
      .from('turnos_rtms as t')
      .leftJoin('vehiculos as v', 'v.id', 't.vehiculo_id')
      .leftJoin('servicios as s', 's.id', 't.servicio_id')
      .leftJoin('sedes as se', 'se.id', 't.sede_id')
      .joinRaw(
        `LEFT JOIN captacion_dateos as cd ON cd.id = COALESCE(
  t.captacion_dateo_id,
  (
    SELECT t2.captacion_dateo_id
    FROM turnos_rtms t2
    WHERE t2.placa = t.placa
    AND t2.turno_numero < 0
    AND t2.captacion_dateo_id IS NOT NULL
    AND ABS(DATEDIFF(t2.fecha, t.fecha)) <= 7
    ORDER BY ABS(DATEDIFF(t2.fecha, t.fecha))
    LIMIT 1
  )
)`
      )
      .leftJoin('agentes_captacions as ac', 'ac.id', 'cd.agente_id')
      .leftJoin('convenios as cv', 'cv.id', 'cd.convenio_id')
      .where((qb) => {
        qb.where('t.cliente_id', id).orWhere('v.cliente_id', id)
      })
      .select([
        't.id',
        't.fecha',
        't.hora_ingreso as horaIngreso',
        't.hora_salida as horaSalida',
        't.tiempo_servicio as tiempoServicio',
        't.turno_numero as turnoNumero',
        't.turno_numero_servicio as turnoNumeroServicio',
        't.turno_codigo as turnoCodigo',
        't.placa',
        't.tipo_vehiculo as tipoVehiculo',
        't.estado',
        't.medio_entero as medioEntero',
        't.canal_atribucion as canalAtribucion',
        't.observaciones',
        's.codigo_servicio as servicioCodigo',
        's.nombre_servicio as servicioNombre',
        'se.nombre as sedeNombre',
        'ac.nombre as asesorNombre',
        'cv.nombre as convenioNombre',
        'cv.establecimiento as convenioEstablecimiento',
        't.es_recurrente as esRecurrente',
        't.es_recuperacion as esRecuperacion',
      ])
      .orderBy('t.fecha', 'desc')
      .orderBy('t.turno_numero', 'desc')

    if (servicioId) q = q.where('t.servicio_id', Number(servicioId))
    if (servicioCodigo) q = q.where('s.codigo_servicio', String(servicioCodigo))
    if (sedeId) q = q.where('t.sede_id', Number(sedeId))
    if (placa) q = q.whereRaw('LOWER(t.placa) like ?', [`%${placa.toLowerCase()}%`])
    if (estado) q = q.where('t.estado', String(estado))
    if (desde) q = q.where('t.fecha', '>=', String(desde))
    if (hasta) q = q.where('t.fecha', '<=', String(hasta))

    const countRow = await q.clone().clearSelect().count('* as total').first()
    const total = Number((countRow as any)?.total ?? 0)

    const rows = await q
      .clone()
      .offset((page - 1) * perPage)
      .limit(perPage)

    return response.ok({
      data: rows,
      page,
      perPage,
      total,
      lastPage: Math.ceil(total / perPage),
    })
  }
}
