// app/controllers/prospectos_controller.ts
// ✅ CORREGIDO: Permite que SUPER_ADMIN cree prospectos para cualquier asesor

import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import db from '@adonisjs/lucid/services/db'

import Prospecto from '#models/prospecto'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import AsesorProspectoAsignacion from '#models/asesor_prospecto_asignacion'
import AgenteCaptacion from '#models/agente_captacion'
import CaptacionDateo from '#models/captacion_dateo'

function normPlaca(raw?: string | null): string | null {
  if (!raw) return null
  return raw.toUpperCase().replace(/[\s-]+/g, '')
}
function normTel(raw?: string | null): string | null {
  if (!raw) return null
  return raw.replace(/\D+/g, '')
}

function userDisplayName(u: {
  nombres?: string | null
  apellidos?: string | null
  nombre?: string | null
  correo?: string | null
  email?: string | null
  id?: number | null
}): string {
  const nCompleto = [u?.nombres, u?.apellidos].filter(Boolean).join(' ').trim()
  return nCompleto || u?.nombre || u?.correo || u?.email || (u?.id ? `Usuario #${u.id}` : '—')
}

type DocResumen = {
  estado: 'sin_datos' | 'vigente' | 'vencido'
  vencimiento: string | null
  dias_restantes: number | null
}
function docStatus(venc?: DateTime | null): DocResumen {
  const hoy = DateTime.now().startOf('day')
  if (!venc || !venc.isValid) {
    return { estado: 'sin_datos', vencimiento: null, dias_restantes: null }
  }
  const diff = Math.ceil(venc.diff(hoy, 'days').days)
  return {
    estado: diff >= 0 ? 'vigente' : 'vencido',
    vencimiento: venc.toISODate()!,
    dias_restantes: diff,
  }
}

export default class ProspectosController {
  /** GET /api/prospectos/:id */
  public async show({ params, response }: HttpContext) {
    const id = Number(params.id)
    if (!Number.isFinite(id)) return response.badRequest({ message: 'ID inválido' })

    const p = await Prospecto.query()
      .where('id', id)
      .preload('creador')
      .preload('convenio')
      .preload('asignaciones', (q) =>
        q
          .where('activo', true)
          .whereNull('fecha_fin')
          .orderBy('fecha_asignacion', 'desc')
          .preload('asesor')
      )
      .first()

    if (!p) return response.notFound({ message: 'Prospecto no encontrado', id })

    const data = p.serialize()

    let creadorOut: {
      id: number | null
      nombre: string
      tipo: string | null
      fuente: 'USUARIO' | 'SISTEMA' | 'ASESOR' | null
    } | null = null
    const creadorModel = (p as any).creador as Parameters<typeof userDisplayName>[0] | undefined
    if (creadorModel) {
      creadorOut = {
        id: creadorModel.id ?? null,
        nombre: userDisplayName(creadorModel),
        tipo: null,
        fuente: null,
      }
    } else if (p.origen === 'IMPORT') {
      creadorOut = { id: null, nombre: 'Importación', tipo: null, fuente: null }
    } else if (p.asignaciones?.length) {
      const a = p.asignaciones[0]?.asesor as
        | { id?: number | null; nombre?: string | null }
        | undefined
      if (a) creadorOut = { id: a.id ?? null, nombre: a.nombre ?? '—', tipo: null, fuente: null }
    }

    const soat = docStatus(p.soatVencimiento)
    const rtm = docStatus(p.tecnoVencimiento)
    const hoy = DateTime.now().startOf('day')

    const preventiva: DocResumen = !p.preventivaVencimiento
      ? {
          estado: p.preventivaVigente ? 'vigente' : 'sin_datos',
          vencimiento: null,
          dias_restantes: null,
        }
      : {
          estado:
            Math.ceil(p.preventivaVencimiento.diff(hoy, 'days').days) >= 0 ? 'vigente' : 'vencido',
          vencimiento: p.preventivaVencimiento.toISODate()!,
          dias_restantes: Math.ceil(p.preventivaVencimiento.diff(hoy, 'days').days),
        }

    const peritaje = p.peritajeUltimaFecha
      ? { estado: 'registrado', fecha: p.peritajeUltimaFecha.toISODate() }
      : { estado: 'sin_datos', fecha: null as string | null }

    const activa = (p.asignaciones || []).find((a) => a.activo && !a.fechaFin) || null
    const asignacionOut = activa
      ? {
          ...activa.serialize(),
          fecha_asignacion: activa.fechaAsignacion?.toISO() ?? p.createdAt?.toISO() ?? null,
        }
      : null

    return {
      ...data,
      creador: creadorOut,
      soat_vigente: p.soatVigente ?? null,
      soat_vencimiento: p.soatVencimiento?.toISODate() ?? null,
      tecno_vigente: p.tecnoVigente ?? null,
      tecno_vencimiento: p.tecnoVencimiento?.toISODate() ?? null,
      dias_soat_restantes: p.diasSoatRestantes ?? null,
      dias_tecno_restantes: p.diasTecnoRestantes ?? null,
      created_at: p.createdAt?.toISO() ?? null,
      updated_at: p.updatedAt?.toISO() ?? null,
      asignacion_activa: asignacionOut,
      resumenVigencias: { soat, rtm, preventiva, peritaje },
    }
  }

  /** GET /api/prospectos/by-placa?placa=ABC123 */
  public async findByPlaca({ request, response }: HttpContext) {
    const placaRaw = String(request.input('placa') ?? '')
    const placa = normPlaca(placaRaw)
    if (!placa) return response.badRequest({ message: 'placa es requerida' })

    const p = await Prospecto.query()
      .where('archivado', false)
      .whereRaw("REPLACE(UPPER(placa), '-', '') = ?", [placa])
      .orderBy('updated_at', 'desc')
      .preload('creador')
      .preload('convenio')
      .preload('asignaciones', (q) =>
        q
          .where('activo', true)
          .whereNull('fecha_fin')
          .orderBy('fecha_asignacion', 'desc')
          .preload('asesor')
      )
      .first()

    if (!p) return response.ok({ exists: false })

    const soat = docStatus(p.soatVencimiento)
    const rtm = docStatus(p.tecnoVencimiento)
    const hoy = DateTime.now().startOf('day')

    const preventiva: DocResumen = !p.preventivaVencimiento
      ? {
          estado: p.preventivaVigente ? 'vigente' : 'sin_datos',
          vencimiento: null,
          dias_restantes: null,
        }
      : {
          estado:
            Math.ceil(p.preventivaVencimiento.diff(hoy, 'days').days) >= 0 ? 'vigente' : 'vencido',
          vencimiento: p.preventivaVencimiento.toISODate()!,
          dias_restantes: Math.ceil(p.preventivaVencimiento.diff(hoy, 'days').days),
        }

    const peritaje = p.peritajeUltimaFecha
      ? { estado: 'registrado', fecha: p.peritajeUltimaFecha.toISODate() }
      : { estado: 'sin_datos', fecha: null as string | null }

    const activa = (p.asignaciones || []).find((a) => a.activo && !a.fechaFin) || null
    const asignacionOut = activa
      ? {
          ...activa.serialize(),
          fecha_asignacion: activa.fechaAsignacion?.toISO() ?? p.createdAt?.toISO() ?? null,
        }
      : null

    const creadorModel = (p as any).creador as Parameters<typeof userDisplayName>[0] | undefined
    const creadorOut = creadorModel
      ? { id: creadorModel.id ?? null, nombre: userDisplayName(creadorModel) }
      : null

    return response.ok({
      exists: true,
      id: p.id,
      placa: p.placa,
      telefono: p.telefono,
      nombre: p.nombre,
      origen: p.origen,
      creado_por: creadorOut,
      created_at: p.createdAt?.toISO() ?? null,
      asignacion_activa: asignacionOut,
      resumenVigencias: { soat, rtm, preventiva, peritaje },
    })
  }

  /** POST /api/prospectos  (placa requerida pero YA NO única) */
  public async store({ request, response, auth }: HttpContext) {
    const body = request.only([
      'placa',
      'telefono',
      'nombre',
      'cedula',
      'convenioId',
      'origen',
      'soatVigente',
      'soatVencimiento',
      'tecnoVigente',
      'tecnoVencimiento',
      'preventivaVigente',
      'preventivaVencimiento',
      'peritajeUltimaFecha',
      'observaciones',
      'creadoPor',
      'creado_por',
      'asesor_agente_id', // ✅ NUEVO: Leer del frontend
      'asesorAgenteId', // ✅ NUEVO: Alternativa camelCase
    ])

    const placa = normPlaca(body.placa)
    const telefono = normTel(body.telefono)
    const nombre = (body.nombre ?? '').trim()
    const cedula = body.cedula ? String(body.cedula).trim() : null

    // 🔒 Campos obligatorios
    if (!placa || !telefono || !nombre || !cedula) {
      return response.badRequest({
        message: 'placa, telefono, nombre y cedula son obligatorios',
        details: { placa: !!placa, telefono: !!telefono, nombre: !!nombre, cedula: !!cedula },
      })
    }

    // ✅ YA NO HAY VALIDACIÓN DE PLACA ÚNICA AQUÍ
    // Se permiten duplicados para competencia entre asesores

    const soatVenc = body.soatVencimiento ? DateTime.fromISO(body.soatVencimiento) : null
    const tecnoVenc = body.tecnoVencimiento ? DateTime.fromISO(body.tecnoVencimiento) : null
    const prevVenc = body.preventivaVencimiento
      ? DateTime.fromISO(body.preventivaVencimiento)
      : null
    const periUlt = body.peritajeUltimaFecha ? DateTime.fromISO(body.peritajeUltimaFecha) : null

    const creadorIdNum = Number(auth?.user?.id ?? body.creadoPor ?? body.creado_por)
    const creadoPor = Number.isFinite(creadorIdNum) ? creadorIdNum : null

    if (!creadoPor) {
      return response.badRequest({
        message: 'No se pudo determinar el usuario creador (creadoPor).',
      })
    }

    // ✅ NUEVA LÓGICA: Determinar el asesor asignado
    let asesorAgenteId: number | null = null

    // 1. Si viene asesor_agente_id en el body (frontend lo envía), usar ese
    const asesorFromBody = Number(body.asesor_agente_id ?? body.asesorAgenteId)
    if (Number.isFinite(asesorFromBody) && asesorFromBody > 0) {
      console.log('✅ [Backend] Usando asesor_agente_id del body:', asesorFromBody)
      asesorAgenteId = asesorFromBody

      // Validar que el asesor exista
      const asesorExiste = await AgenteCaptacion.query()
        .where('id', asesorAgenteId)
        .where('activo', true)
        .first()

      if (!asesorExiste) {
        return response.badRequest({
          message: `El asesor con ID ${asesorAgenteId} no existe o no está activo`,
          details: { asesor_agente_id: asesorAgenteId },
        })
      }
    } else {
      // 2. Si no viene, intentar buscar el agente del usuario creador (COMERCIAL)
      console.log('⚠️ [Backend] No viene asesor_agente_id, buscando agente del usuario:', creadoPor)
      const agenteCreador = await AgenteCaptacion.query()
        .where('usuario_id', creadoPor)
        .where('activo', true)
        .first()

      if (!agenteCreador) {
        return response.badRequest({
          message:
            'El usuario creador no tiene un Agente de Captación activo configurado y no se especificó asesor_agente_id',
          details: { creadoPor, asesor_agente_id: body.asesor_agente_id },
        })
      }

      asesorAgenteId = agenteCreador.id
      console.log('✅ [Backend] Usando agente del usuario creador:', asesorAgenteId)
    }

    const trx = await db.transaction()
    try {
      const prospecto = await Prospecto.create(
        {
          convenioId: body.convenioId ?? null,
          placa,
          telefono,
          nombre,
          cedula,
          origen: (body.origen as Prospecto['origen']) ?? 'OTRO',
          creadoPor,
          soatVigente: !!body.soatVigente,
          soatVencimiento: soatVenc && soatVenc.isValid ? soatVenc : null,
          tecnoVigente: !!body.tecnoVigente,
          tecnoVencimiento: tecnoVenc && tecnoVenc.isValid ? tecnoVenc : null,
          preventivaVigente: !!body.preventivaVigente,
          preventivaVencimiento: prevVenc && prevVenc.isValid ? prevVenc : null,
          peritajeUltimaFecha: periUlt && periUlt.isValid ? periUlt : null,
          observaciones: body.observaciones ?? null,
        } as any,
        { client: trx }
      )

      console.log('✅ [Backend] Prospecto creado:', prospecto.id)
      console.log('✅ [Backend] Asignando a asesor:', asesorAgenteId)

      await AsesorProspectoAsignacion.create(
        {
          asesorId: Number(asesorAgenteId),
          prospectoId: prospecto.id,
          asignadoPor: creadoPor,
          fechaAsignacion: DateTime.now(),
          fechaFin: null,
          motivoFin: null,
          activo: true,
        } as any,
        { client: trx }
      )

      await trx.commit()

      const full = await Prospecto.query()
        .where('id', prospecto.id)
        .preload('creador')
        .preload('asignaciones', (q) =>
          q
            .where('activo', true)
            .whereNull('fecha_fin')
            .orderBy('fecha_asignacion', 'desc')
            .preload('asesor')
        )
        .first()

      console.log('✅ [Backend] Prospecto creado y asignado exitosamente')
      return response.created(full ?? prospecto)
    } catch (e) {
      await trx.rollback()
      console.error('❌ [Backend] Error creando prospecto:', e)
      return response.internalServerError({ message: 'Error creando prospecto', error: String(e) })
    }
  }

  /** PATCH /api/prospectos/:id  (YA NO valida duplicados) */
  public async update({ request, params, response }: HttpContext) {
    const id = Number(params.id)
    const prospecto = await Prospecto.find(id)
    if (!prospecto) return response.notFound({ message: 'Prospecto no encontrado' })

    const body = request.only([
      'placa',
      'telefono',
      'nombre',
      'cedula',
      'convenioId',
      'origen',
      'soatVigente',
      'soatVencimiento',
      'tecnoVigente',
      'tecnoVencimiento',
      'observaciones',
      'preventivaVigente',
      'preventivaVencimiento',
      'peritajeUltimaFecha',
    ])

    if (body.placa !== undefined) {
      const nueva = normPlaca(body.placa)
      if (!nueva) {
        return response.badRequest({ message: 'placa es obligatoria y no puede ser vacía' })
      }

      // ✅ YA NO SE VALIDA SI LA PLACA ESTÁ DUPLICADA
      // Se permite cambiar a una placa que ya existe en otros prospectos
      prospecto.placa = nueva
    }

    if (body.telefono !== undefined) prospecto.telefono = normTel(body.telefono)
    if (body.nombre !== undefined) prospecto.nombre = (body.nombre ?? null)?.trim() || null
    if (body.cedula !== undefined)
      prospecto.cedula = body.cedula ? String(body.cedula).trim() : null
    if (body.convenioId !== undefined) prospecto.convenioId = body.convenioId ?? null
    if (body.origen !== undefined) prospecto.origen = body.origen as any

    if (body.soatVigente !== undefined) prospecto.soatVigente = !!body.soatVigente
    if (body.soatVencimiento !== undefined) {
      const d = body.soatVencimiento ? DateTime.fromISO(body.soatVencimiento) : null
      prospecto.soatVencimiento = d && d.isValid ? d : null
    }
    if (body.tecnoVigente !== undefined) prospecto.tecnoVigente = !!body.tecnoVigente
    if (body.tecnoVencimiento !== undefined) {
      const d = body.tecnoVencimiento ? DateTime.fromISO(body.tecnoVencimiento) : null
      prospecto.tecnoVencimiento = d && d.isValid ? d : null
    }
    if (body.observaciones !== undefined) prospecto.observaciones = body.observaciones ?? null

    if (body.preventivaVigente !== undefined) prospecto.preventivaVigente = !!body.preventivaVigente
    if (body.preventivaVencimiento !== undefined) {
      const d = body.preventivaVencimiento ? DateTime.fromISO(body.preventivaVencimiento) : null
      prospecto.preventivaVencimiento = d && d.isValid ? d : null
    }
    if (body.peritajeUltimaFecha !== undefined) {
      const d = body.peritajeUltimaFecha ? DateTime.fromISO(body.peritajeUltimaFecha) : null
      prospecto.peritajeUltimaFecha = d && d.isValid ? d : null
    }

    await prospecto.save()
    return prospecto
  }

  /** GET /api/prospectos */
  public async index({ request }: HttpContext) {
    const q = request.qs()

    // 🔹 filtros nuevos desde la vista
    const placaRaw = q.placa ? String(q.placa).trim() : ''
    const telefonoRaw = q.telefono ? String(q.telefono).trim() : ''
    const nombreRaw = q.nombre ? String(q.nombre).trim() : ''
    const cedulaRaw = q.cedula ? String(q.cedula).trim() : ''
    const convenioId = q.convenioId ?? q.convenio_id
    const asesorId = q.asesorId ?? q.asesor_id
    const desdeStr = q.desde ? String(q.desde) : ''
    const hastaStr = q.hasta ? String(q.hasta) : ''

    // 🔹 filtros legacy que ya usabas en otras partes
    const creadoPor = q.creadoPor ?? q.creado_por
    const vencenEnDias = Number(q.vencenEnDias)
    const soat = String(q.soat ?? '').toLowerCase() === 'true'
    const tecno = String(q.tecno ?? '').toLowerCase() === 'true'
    const term = String(q.q ?? '').trim() // buscador libre opcional

    const vigenteRaw = q.vigente ?? q.vigente_num
    const vigente =
      vigenteRaw === undefined
        ? undefined
        : String(vigenteRaw) === 'true' || String(vigenteRaw) === '1'

    const page = Number(q.page ?? 1)
    const perPage = Math.min(Number(q.perPage ?? 20), 1000)
    const sortBy = String(q.sortBy ?? 'updated_at')
    const order: 'asc' | 'desc' = String(q.order ?? 'desc').toLowerCase() === 'asc' ? 'asc' : 'desc'

    const hoy = DateTime.now().startOf('day')
    const hastaVence =
      !Number.isNaN(vencenEnDias) && vencenEnDias > 0 ? hoy.plus({ days: vencenEnDias }) : null

    const query = Prospecto.query()
      .where('archivado', false) // 👈 NO mostramos archivados
      // 👇 AQUI PRELOADEAMOS LA ASIGNACIÓN ACTIVA CON SU ASESOR
      .preload('asignaciones', (qAsig) =>
        qAsig
          .where('activo', true)
          .whereNull('fecha_fin')
          .orderBy('fecha_asignacion', 'desc')
          .preload('asesor')
      )

    /* =========================
     FILTROS BÁSICOS
  ========================== */

    // placa normalizada (ABC123 → ABC123 / ab c-123 etc)
    if (placaRaw) {
      const placaNorm = normPlaca(placaRaw)
      if (placaNorm) {
        query.whereRaw("REPLACE(UPPER(placa), '-', '') = ?", [placaNorm])
      }
    }

    // teléfono: solo dígitos y like
    if (telefonoRaw) {
      const tel = normTel(telefonoRaw)
      if (tel) {
        query.where('telefono', 'like', `%${tel}%`)
      }
    }

    // nombre del cliente
    if (nombreRaw) {
      const like = `%${nombreRaw.toUpperCase()}%`
      query.whereRaw('UPPER(nombre) LIKE ?', [like])
    }

    // convenio directo en el prospecto
    if (convenioId) {
      query.where('convenio_id', Number(convenioId))
    }

    // prospectos creados por un usuario concreto
    if (creadoPor) {
      query.where('creado_por', Number(creadoPor))
    }

    // rango de fechas por created_at (desde / hasta)
    if (desdeStr) {
      const d = DateTime.fromISO(desdeStr, { zone: 'local' })
      if (d.isValid) {
        query.where('created_at', '>=', d.startOf('day').toSQL()!)
      }
    }
    if (hastaStr) {
      const h = DateTime.fromISO(hastaStr, { zone: 'local' })
      if (h.isValid) {
        query.where('created_at', '<=', h.endOf('day').toSQL()!)
      }
    }

    /* =========================
     VENCEN SOAT / RTM EN N DÍAS
  ========================== */
    if (hastaVence && (soat || tecno)) {
      query.where((grp) => {
        if (soat) {
          grp.where((sub) => {
            sub
              .where('soat_vigente', true)
              .whereNotNull('soat_vencimiento')
              .whereBetween('soat_vencimiento', [hoy.toISODate()!, hastaVence.toISODate()!])
          })
        }
        if (tecno) {
          grp.orWhere((sub) => {
            sub
              .where('tecno_vigente', true)
              .whereNotNull('tecno_vencimiento')
              .whereBetween('tecno_vencimiento', [hoy.toISODate()!, hastaVence.toISODate()!])
          })
        }
      })
    }

    /* =========================
    BUSCADOR LIBRE (q)
  ========================== */
    // cedula exacta o parcial
    if (cedulaRaw) {
      query.where('cedula', 'like', `%${cedulaRaw}%`)
    }
    if (term) {
      const like = `%${term.toUpperCase()}%`
      const telTerm = term.replace(/\D+/g, '')
      query.where((sub) => {
        sub.whereRaw('UPPER(placa) LIKE ?', [like]).orWhereRaw('UPPER(nombre) LIKE ?', [like])
        if (telTerm) {
          sub.orWhere('telefono', 'like', `%${telTerm}%`)
        }
        if (telTerm) {
          sub.orWhere('cedula', 'like', `%${telTerm}%`)
        }
      })
    }

    /* =========================
     ASIGNACIONES (asesor / vigente)
  ========================== */

    if (vigente !== undefined) {
      if (vigente) {
        query.whereExists((sub) => {
          sub
            .from('asesor_prospecto_asignaciones')
            .whereColumn('asesor_prospecto_asignaciones.prospecto_id', 'prospectos.id')
            .where('activo', true)
            .whereNull('fecha_fin')
        })
      } else {
        query.whereNotExists((sub) => {
          sub
            .from('asesor_prospecto_asignaciones')
            .whereColumn('asesor_prospecto_asignaciones.prospecto_id', 'prospectos.id')
            .where('activo', true)
            .whereNull('fecha_fin')
        })
      }
    }

    if (asesorId) {
      query.whereExists((sub) => {
        sub
          .from('asesor_prospecto_asignaciones')
          .whereColumn('asesor_prospecto_asignaciones.prospecto_id', 'prospectos.id')
          .where('asesor_id', Number(asesorId))
          .where('activo', true)
          .whereNull('fecha_fin')
      })
    }

    /* =========================
     ORDEN Y PAGINACIÓN
  ========================== */
    query.orderBy(sortBy, order)

    const paginator = await query.paginate(page, perPage)
    return {
      data: paginator.all().map((p) => p.serialize()),
      total: paginator.total,
      page: paginator.currentPage,
      perPage: paginator.perPage,
      lastPage: paginator.lastPage,
    }
  }

  /** GET /api/asesores/:id/resumen (legacy) */
  public async resumenByAsesor({ params }: HttpContext) {
    const asesorId = Number(params.id)

    const r1 = await AsesorConvenioAsignacion.query().where('asesor_id', asesorId).count('*')
    const asignTotStr = Number((r1[0] as any)['count(*)'] ?? 0)

    const r2 = await AsesorConvenioAsignacion.query()
      .where('asesor_id', asesorId)
      .where('activo', true)
      .whereNull('fecha_fin')
      .count('*')
    const vigStr = Number((r2[0] as any)['count(*)'] ?? 0)

    const hoyIni = DateTime.now().startOf('day')
    const hoyFin = DateTime.now().endOf('day')
    const mesIni = DateTime.now().startOf('month')
    const mesFin = DateTime.now().endOf('month')

    const base = AsesorProspectoAsignacion.query()
      .where('asesor_id', asesorId)
      .where('activo', true)

    const rTot = await base.clone().count('*')
    const totStr = Number((rTot[0] as any)['count(*)'] ?? 0)

    const rHoy = await base
      .clone()
      .whereBetween('fecha_asignacion', [hoyIni.toJSDate(), hoyFin.toJSDate()])
      .count('*')
    const hoyStr = Number((rHoy[0] as any)['count(*)'] ?? 0)

    const rMes = await base
      .clone()
      .whereBetween('fecha_asignacion', [mesIni.toJSDate(), mesFin.toJSDate()])
      .count('*')
    const mesStr = Number((rMes[0] as any)['count(*)'] ?? 0)

    return {
      convenios: { vigentes: vigStr, asignaciones: asignTotStr, total: asignTotStr },
      prospectos: { total: totStr, hoy: hoyStr, mes: mesStr },
    }
  }

  /** GET /api/prospectos/asesor/:id/list */
  public async listByAsesor({ params, request }: HttpContext) {
    const asesorId = Number(params.id)
    const vigente = String(request.input('vigente', '1'))
    const q = Prospecto.query()
      .join('asesor_prospecto_asignaciones as apa', 'apa.prospecto_id', 'prospectos.id')
      .where('apa.asesor_id', asesorId)
      .where('prospectos.archivado', false)
      .select('prospectos.*')
      .orderBy('prospectos.updated_at', 'desc')
      .limit(500)

    if (vigente === '1') q.andWhere('apa.activo', true).andWhereNull('apa.fecha_fin')

    return await q
  }

  /** POST /api/prospectos/:id/asignar */
  public async asignar({ params, request, auth, response }: HttpContext) {
    const prospectoId = Number(params.id)
    const asesorId = Number(request.input('asesor_id') ?? request.input('asesorId'))
    const motivoFin = request.input('motivo_fin') as string | undefined
    if (!prospectoId || !asesorId)
      return response.badRequest({ message: 'prospecto_id y asesor_id son requeridos' })

    const trx = await db.transaction()
    try {
      const activa = await AsesorProspectoAsignacion.query({ client: trx })
        .where('prospecto_id', prospectoId)
        .where('activo', true)
        .whereNull('fecha_fin')
        .first()

      if (activa) {
        activa.merge({
          activo: false,
          fechaFin: DateTime.now(),
          motivoFin: motivoFin ?? 'Reasignación',
        } as any)
        await activa.save()
      }

      const nueva = await AsesorProspectoAsignacion.create(
        {
          prospectoId,
          asesorId,
          asignadoPor: auth?.user?.id ?? null,
          fechaAsignacion: DateTime.now(),
          activo: true,
        } as any,
        { client: trx }
      )

      await trx.commit()
      return response.created({ message: 'Asignación creada', id: nueva.id })
    } catch (e) {
      await trx.rollback()
      return response.internalServerError({ message: 'Error al asignar', error: String(e) })
    }
  }

  /** POST /api/prospectos/:id/retirar */
  public async retirar({ params, request, response }: HttpContext) {
    const prospectoId = Number(params.id)
    const motivo = request.input('motivo') as string | undefined

    const activa = await AsesorProspectoAsignacion.query()
      .where('prospecto_id', prospectoId)
      .where('activo', true)
      .whereNull('fecha_fin')
      .first()

    if (!activa) return response.badRequest({ message: 'No existe asignación activa' })

    activa.merge({
      activo: false,
      fechaFin: DateTime.now(),
      motivoFin: motivo ?? 'Retiro manual',
    } as any)
    await activa.save()
    return { message: 'Asignación cerrada' }
  }

  /** POST /api/prospectos/:id/datear */
  public async datear({ params, response }: HttpContext) {
    const prospectoId = Number(params.id)
    if (!Number.isFinite(prospectoId)) {
      return response.badRequest({ message: 'ID inválido' })
    }

    const prospecto = await Prospecto.query()
      .where('id', prospectoId)
      .where('archivado', false)
      .preload('asignaciones', (q) =>
        q.where('activo', true).whereNull('fecha_fin').orderBy('fecha_asignacion', 'desc')
      )
      .first()

    if (!prospecto) {
      return response.notFound({ message: 'Prospecto no encontrado o ya archivado' })
    }

    const hoy = DateTime.now().startOf('day')
    const tecno = prospecto.tecnoVencimiento
    if (!tecno || !tecno.isValid || tecno.diff(hoy, 'days').days >= 0) {
      return response.badRequest({
        message: 'La RTM aún no está vencida; no se puede datear este prospecto.',
      })
    }

    const asignacionActiva = (prospecto.asignaciones || []).find((a) => a.activo && !a.fechaFin)

    if (!asignacionActiva) {
      return response.badRequest({
        message: 'El prospecto no tiene un asesor asignado actualmente.',
      })
    }

    const asesorId = asignacionActiva.asesorId
    const asesor = await AgenteCaptacion.find(asesorId)
    if (!asesor) {
      return response.badRequest({
        message: 'No se encontró el agente de captación asignado al prospecto.',
      })
    }

    const trx = await db.transaction()
    try {
      const dateo = await CaptacionDateo.create(
        {
          prospectoId: prospecto.id,
          placa: prospecto.placa,
          telefono: prospecto.telefono,
          clienteNombre: prospecto.nombre,
          convenioId: prospecto.convenioId ?? null,
          agenteId: asesor.id,
          canal: asesor.tipo || 'ASESOR_COMERCIAL',
          resultado: 'PENDIENTE',
          origen: 'UI',
        } as any,
        { client: trx }
      )

      // 1️⃣ Archivar el prospecto original
      prospecto.archivado = true
      await prospecto.useTransaction(trx).save()

      // 2️⃣ Archivar TODOS los prospectos duplicados con la misma placa
      const placaNormalizada = prospecto.placa?.replace(/[\s-]/g, '').toUpperCase()
      if (placaNormalizada) {
        await Prospecto.query({ client: trx })
          .where('archivado', false)
          .whereRaw("REPLACE(REPLACE(UPPER(placa), '-', ''), ' ', '') = ?", [placaNormalizada])
          .update({ archivado: true })
      }

      await trx.commit()
      return response.created({
        message: 'Prospecto dateado correctamente',
        dateo_id: dateo.id,
      })
    } catch (e) {
      await trx.rollback()
      return response.internalServerError({
        message: 'Error al datear prospecto',
        error: String(e),
      })
    }
  }
}
