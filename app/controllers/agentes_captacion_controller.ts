// app/controllers/agentes_captacion_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import AgenteCaptacion from '#models/agente_captacion'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import AsesorProspectoAsignacion from '#models/asesor_prospecto_asignacion'
import Prospecto from '#models/prospecto'

// 👇 nuevos imports para la ficha comercial
import CaptacionDateo from '#models/captacion_dateo'
import Comision from '#models/comision'
import TurnoRtm from '#models/turno_rtm'
import Convenio from '#models/convenio'

/* ========= Helpers ========= */
function normalizePhone(value?: string) {
  return value ? value.replace(/\D/g, '') : value
}

const TIPOS = new Set(['ASESOR_COMERCIAL', 'ASESOR_CONVENIO', 'ASESOR_TELEMERCADEO'])
const DOC_TIPOS = new Set(['CC', 'NIT'])

/** ✅ Calcula activo:
 *  - COMERCIAL / TELEMERCADEO → LOWER(usuarios.estado) = 'activo'
 *  - CONVENIO → agentes_captacions.activo
 *  Devuelve SIEMPRE 1/0 para evitar ambigüedad con boolean/ints.
 */
const ACTIVO_CALC_SQL = `
  CASE
    WHEN agentes_captacions.tipo IN ('ASESOR_COMERCIAL','ASESOR_TELEMERCADEO')
      THEN CASE
        WHEN agentes_captacions.usuario_id IS NULL
          THEN CASE WHEN agentes_captacions.activo = TRUE THEN 1 ELSE 0 END
        WHEN LOWER(usuarios.estado) = 'activo' THEN 1
        ELSE 0
      END
    ELSE CASE WHEN agentes_captacions.activo = TRUE THEN 1 ELSE 0 END
  END
`

// ✅ ACTUALIZADO: Serializa con datos del usuario, contrato Y agente
function rowToPlainWithActivo(model: AgenteCaptacion) {
  const base = model.serialize() as any
  const extras = (model as any).$extras || {}

  const activo = Number(extras.activo_calc) === 1

  const result: any = { ...base, activo }

  // ✅ CORREO: del usuario (desde LEFT JOIN)
  if (extras.usuario_correo !== undefined) {
    result.email = extras.usuario_correo
    result.correo = extras.usuario_correo
  }

  if (extras.usuario_correo_personal !== undefined) {
    result.correoPersonal = extras.usuario_correo_personal
    result.emailPersonal = extras.usuario_correo_personal
  }

  // ✅ TELÉFONO: prioritario del usuario, fallback al agente
  if (extras.usuario_telefono) {
    result.telefono = extras.usuario_telefono
  } else if (base.telefono) {
    result.telefono = base.telefono
  }

  // ✅ DOCUMENTO: prioridad contrato > agente
  if (extras.contrato_documento) {
    result.doc_numero = extras.contrato_documento
    result.docNumero = extras.contrato_documento
    // Asumimos CC si viene del contrato
    if (!result.doc_tipo) {
      result.doc_tipo = 'CC'
      result.docTipo = 'CC'
    }
  } else if (base.doc_numero || base.docNumero) {
    result.doc_numero = base.doc_numero || base.docNumero
    result.docNumero = base.doc_numero || base.docNumero
  }

  // ✅ doc_tipo del agente (si existe)
  if (base.doc_tipo || base.docTipo) {
    result.doc_tipo = base.doc_tipo || base.docTipo
    result.docTipo = base.doc_tipo || base.docTipo
  }

  // 🔍 DEBUG: Log para verificar qué datos se están devolviendo
  console.log('🔍 rowToPlainWithActivo:', {
    id: result.id,
    nombre: result.nombre,
    email: result.email,
    correo: result.correo,
    doc_tipo: result.doc_tipo,
    doc_numero: result.doc_numero,
    telefono: result.telefono,
    activo: result.activo,
  })

  return result
}

export default class AgentesCaptacionController {
  /** GET /agentes-captacion/by-user/:userId */
  public async byUser({ params, response }: HttpContext) {
    const userId = Number(params.userId)
    if (!Number.isFinite(userId)) return response.badRequest({ message: 'userId inválido' })

    const row = await AgenteCaptacion.query()
      .where('agentes_captacions.usuario_id', userId)
      .leftJoin('usuarios', 'usuarios.id', 'agentes_captacions.usuario_id')
      .leftJoin('contratos', function () {
        this.on('contratos.usuario_id', '=', 'usuarios.id').andOnVal(
          'contratos.estado',
          '=',
          'activo'
        )
      })
      .select(
        'agentes_captacions.*',
        db.raw(`${ACTIVO_CALC_SQL} AS activo_calc`),
        'usuarios.correo AS usuario_correo',
        'usuarios.correo_personal AS usuario_correo_personal',
        'usuarios.celular_personal AS usuario_telefono',
        'contratos.identificacion AS contrato_documento'
      )
      .orderBy('contratos.fecha_inicio', 'desc')
      .first()

    if (!row) {
      return response.notFound({
        message: 'No hay agente de captación vinculado a este usuario',
        usuario_id: userId,
      })
    }

    return rowToPlainWithActivo(row)
  }

  /**
   * GET /agentes-captacion?page=1&perPage=20&q=juan&tipo=ASESOR_CONVENIO&activo=true
   */
  public async index({ request }: HttpContext) {
    const page = Number(request.input('page', 1))
    const perPage = Math.min(Number(request.input('perPage', 20)), 1000)
    const q = String(request.input('q', '') || '').trim()
    const tipo = String(request.input('tipo', '') || '').trim()
    const activoParam = request.input('activo')

    const SORTABLE = new Set([
      'id',
      'nombre',
      'tipo',
      'telefono',
      'doc_numero',
      'created_at',
      'updated_at',
    ])
    const sortByReq = String(request.input('sortBy', 'id')).trim()
    const sortBy = SORTABLE.has(sortByReq) ? sortByReq : 'id'
    const orderRaw = String(request.input('order', 'asc')).toLowerCase()
    const order: 'asc' | 'desc' = orderRaw === 'desc' ? 'desc' : 'asc'

    const qbuilder = AgenteCaptacion.query()
      .leftJoin('usuarios', 'usuarios.id', 'agentes_captacions.usuario_id')
      .leftJoin('contratos', function () {
        this.on('contratos.usuario_id', '=', 'usuarios.id').andOnVal(
          'contratos.estado',
          '=',
          'activo'
        )
      })
      .select(
        'agentes_captacions.*',
        db.raw(`${ACTIVO_CALC_SQL} AS activo_calc`),
        'usuarios.correo AS usuario_correo',
        'usuarios.correo_personal AS usuario_correo_personal',
        'usuarios.celular_personal AS usuario_telefono',
        'contratos.identificacion AS contrato_documento'
      )
      .orderBy(`agentes_captacions.${sortBy}`, order)

    if (q) {
      qbuilder.where((qb) => {
        qb.where('agentes_captacions.nombre', 'like', `%${q}%`)
          .orWhere('agentes_captacions.telefono', 'like', `%${q}%`)
          .orWhere('agentes_captacions.doc_numero', 'like', `%${q}%`)
      })
    }

    if (TIPOS.has(tipo)) {
      qbuilder.andWhere('agentes_captacions.tipo', tipo as any)
    }

    if (activoParam !== undefined && activoParam !== '') {
      const val = String(activoParam).toLowerCase()
      if (['true', '1', 'activo'].includes(val)) {
        qbuilder.andWhereRaw(`${ACTIVO_CALC_SQL} = 1`)
      } else if (['false', '0', 'inactivo'].includes(val)) {
        qbuilder.andWhereRaw(`${ACTIVO_CALC_SQL} = 0`)
      }
    }

    const paginator = await qbuilder.paginate(page, perPage)

    const data = paginator.all().map(rowToPlainWithActivo)
    const meta = paginator.getMeta()

    return { data, ...meta }
  }

  /** GET /agentes-captacion/:id */
  public async show({ params, response, auth }: HttpContext) {
    const row = await AgenteCaptacion.query()
      .where('agentes_captacions.id', params.id)
      .leftJoin('usuarios', 'usuarios.id', 'agentes_captacions.usuario_id')
      .leftJoin('contratos', function () {
        this.on('contratos.usuario_id', '=', 'usuarios.id').andOnVal(
          'contratos.estado',
          '=',
          'activo'
        )
      })
      .select(
        'agentes_captacions.*',
        db.raw(`${ACTIVO_CALC_SQL} AS activo_calc`),
        'usuarios.correo AS usuario_correo',
        'usuarios.correo_personal AS usuario_correo_personal',
        'usuarios.celular_personal AS usuario_telefono',
        'contratos.identificacion AS contrato_documento'
      )
      .orderBy('contratos.fecha_inicio', 'desc')
      .first()

    if (!row) return response.notFound({ message: 'Agente no encontrado' })

    // 🔐 VALIDACIÓN: Si es COMERCIAL, solo puede ver su propia ficha
    const userRole = auth.user?.rol?.nombre
    if (userRole === 'COMERCIAL') {
      if (!auth.user?.id) {
        return response.unauthorized({ message: 'Usuario no autenticado' })
      }

      const userAgenteRow = await db
        .from('agentes_captacions')
        .where('usuario_id', auth.user.id)
        .select('id')
        .first()

      const userAgenteId = userAgenteRow?.id

      console.log('🔍 Validación COMERCIAL:', {
        userRole,
        userId: auth.user.id,
        userAgenteId,
        requestedId: row.id,
        allowed: userAgenteId && Number(row.id) === Number(userAgenteId),
      })

      if (!userAgenteId || Number(row.id) !== Number(userAgenteId)) {
        return response.forbidden({
          message:
            'No tienes permiso para ver esta ficha comercial. Solo puedes ver tu propia ficha.',
        })
      }
    }

    return rowToPlainWithActivo(row)
  }

  /** GET /agentes-captacion/me */
  public async me({ auth, response }: HttpContext) {
    if (!auth?.user?.id) {
      return response.unauthorized({ message: 'No autenticado' })
    }

    const row = await AgenteCaptacion.query()
      .where('agentes_captacions.usuario_id', auth.user.id)
      .leftJoin('usuarios', 'usuarios.id', 'agentes_captacions.usuario_id')
      .leftJoin('contratos', function () {
        this.on('contratos.usuario_id', '=', 'usuarios.id').andOnVal(
          'contratos.estado',
          '=',
          'activo'
        )
      })
      .select(
        'agentes_captacions.*',
        db.raw(`${ACTIVO_CALC_SQL} AS activo_calc`),
        'usuarios.correo AS usuario_correo',
        'usuarios.correo_personal AS usuario_correo_personal',
        'usuarios.celular_personal AS usuario_telefono',
        'contratos.identificacion AS contrato_documento'
      )
      .orderBy('contratos.fecha_inicio', 'desc')
      .first()

    if (!row) {
      return response.notFound({
        message: 'No hay agente de captación vinculado a este usuario',
        usuario_id: auth.user.id,
      })
    }

    return rowToPlainWithActivo(row)
  }

  /** POST /agentes-captacion */
  public async store({ request, response }: HttpContext) {
    let {
      tipo,
      nombre,
      telefono,
      doc_tipo: docTipo,
      doc_numero: docNumero,
      activo,
      usuario_id: usuarioId,
    } = request.only([
      'tipo',
      'nombre',
      'telefono',
      'doc_tipo',
      'doc_numero',
      'activo',
      'usuario_id',
    ])

    if (!tipo || !TIPOS.has(tipo)) {
      return response.badRequest({
        message: 'tipo inválido (ASESOR_COMERCIAL | ASESOR_CONVENIO | ASESOR_TELEMERCADEO)',
      })
    }
    if (!nombre) return response.badRequest({ message: 'nombre es requerido' })

    telefono = normalizePhone(telefono)

    if (docTipo && !DOC_TIPOS.has(docTipo)) {
      return response.badRequest({ message: 'doc_tipo inválido (CC | NIT)' })
    }

    if (docTipo && docNumero) {
      const exists = await AgenteCaptacion.query()
        .where('doc_tipo', docTipo)
        .andWhere('doc_numero', String(docNumero).trim())
        .first()
      if (exists) return response.conflict({ message: 'Documento ya existe' })
    }

    const created = await AgenteCaptacion.create({
      tipo,
      nombre: String(nombre).trim(),
      telefono: telefono || null,
      docTipo: docTipo || null,
      docNumero: docNumero ? String(docNumero).trim() : null,
      usuarioId: usuarioId ?? null,
      activo: typeof activo === 'boolean' ? activo : true,
    })

    return response.created(created)
  }

  /** PUT /agentes-captacion/:id */
  public async update({ params, request, response }: HttpContext) {
    const item = await AgenteCaptacion.find(params.id)
    if (!item) return response.notFound({ message: 'Agente no encontrado' })

    const payload = request.only([
      'tipo',
      'nombre',
      'telefono',
      'doc_tipo',
      'doc_numero',
      'activo',
      'usuario_id',
    ])

    if (payload.tipo !== undefined) {
      if (!TIPOS.has(payload.tipo)) return response.badRequest({ message: 'tipo inválido' })
      item.tipo = payload.tipo
    }

    if (payload.nombre !== undefined) {
      if (!payload.nombre) return response.badRequest({ message: 'nombre no puede ser vacío' })
      item.nombre = String(payload.nombre).trim()
    }

    if (payload.telefono !== undefined) {
      item.telefono = normalizePhone(payload.telefono) || null
    }

    if (payload.usuario_id !== undefined) {
      item.usuarioId = payload.usuario_id ?? null
    }

    if (payload.doc_tipo !== undefined || payload.doc_numero !== undefined) {
      const newTipo = payload.doc_tipo ?? item.docTipo
      const newNum =
        payload.doc_numero !== undefined ? String(payload.doc_numero).trim() : item.docNumero

      if (newTipo && !DOC_TIPOS.has(newTipo)) {
        return response.badRequest({ message: 'doc_tipo inválido (CC | NIT)' })
      }

      if (newTipo && newNum) {
        const exists = await AgenteCaptacion.query()
          .where('doc_tipo', newTipo)
          .andWhere('doc_numero', newNum)
          .whereNot('id', item.id)
          .first()
        if (exists) return response.conflict({ message: 'Documento ya está en uso' })
        item.docTipo = newTipo
        item.docNumero = newNum
      } else {
        item.docTipo = newTipo || null
        item.docNumero = newNum || null
      }
    }

    if (payload.activo !== undefined && item.tipo === 'ASESOR_CONVENIO') {
      const v = String(payload.activo).toLowerCase()
      item.activo = ['true', '1'].includes(v)
        ? true
        : ['false', '0'].includes(v)
          ? false
          : item.activo
    }

    await item.save()
    return item
  }

  /** DELETE /agentes-captacion/:id */
  public async destroy({ params, response }: HttpContext) {
    const item = await AgenteCaptacion.find(params.id)
    if (!item) return response.notFound({ message: 'Agente no encontrado' })

    const [{ total }] = await db
      .from('captacion_dateos')
      .where('agente_id', params.id)
      .count('* as total')
      .catch(() => [{ total: 0 }])

    if (Number(total) > 0) {
      return response.conflict({
        message: 'No se puede eliminar: existen dateos asociados a este agente.',
      })
    }

    await item.delete()
    return response.noContent()
  }

  /** GET /agentes-captacion/:id/resumen */
  public async resumen({ params }: HttpContext) {
    const asesorId = Number(params.id)

    const convTotResult = await AsesorConvenioAsignacion.query()
      .where('asesor_id', asesorId)
      .count('* as total')

    const convTotStr = convTotResult[0].$extras.total

    const convVigResult = await AsesorConvenioAsignacion.query()
      .where('asesor_id', asesorId)
      .where('activo', true)
      .whereNull('fecha_fin')
      .count('* as total')
    const convVigStr = convVigResult[0].$extras.total

    const hoyIni = DateTime.now().startOf('day').toJSDate()
    const hoyFin = DateTime.now().endOf('day').toJSDate()
    const mesIni = DateTime.now().startOf('month').toJSDate()
    const mesFin = DateTime.now().endOf('month').toJSDate()

    const prosVigResult = await AsesorProspectoAsignacion.query()
      .where('asesor_id', asesorId)
      .where('activo', true)
      .whereNull('fecha_fin')
      .count('* as total')
    const prosVigStr = prosVigResult[0].$extras.total

    const prosHoyResult = await AsesorProspectoAsignacion.query()
      .where('asesor_id', asesorId)
      .whereBetween('fecha_asignacion', [hoyIni, hoyFin])
      .count('* as total')
    const prosHoyStr = prosHoyResult[0].$extras.total

    const prosMesResult = await AsesorProspectoAsignacion.query()
      .where('asesor_id', asesorId)
      .whereBetween('fecha_asignacion', [mesIni, mesFin])
      .count('* as total')
    const prosMesStr = prosMesResult[0].$extras.total

    return {
      convenios: {
        total: Number(convTotStr ?? 0),
        vigentes: Number(convVigStr ?? 0),
      },
      prospectos: {
        total: Number(prosVigStr ?? 0),
        vigentes: Number(prosVigStr ?? 0),
        hoy: Number(prosHoyStr ?? 0),
        mes: Number(prosMesStr ?? 0),
      },
    }
  }

  /** GET /agentes-captacion/:id/prospectos?vigente=1&q=... */
  public async prospectos({ params, request }: HttpContext) {
    const asesorId = Number(params.id)
    const vigente = String(request.input('vigente', '1')) === '1'
    const q = String(request.input('q', '') || '').trim()

    const query = Prospecto.query()
      .join('asesor_prospecto_asignaciones as apa', 'apa.prospecto_id', 'prospectos.id')
      .where('apa.asesor_id', asesorId)
      .select('prospectos.*')
      .orderBy('prospectos.updated_at', 'desc')

    if (vigente) query.where('apa.activo', true).whereNull('apa.fecha_fin')

    if (q) {
      const like = `%${q.toUpperCase()}%`
      query.where((sub) => {
        sub
          .whereRaw('UPPER(prospectos.placa) LIKE ?', [like])
          .orWhereRaw('UPPER(prospectos.nombre) LIKE ?', [like])
          .orWhere('prospectos.telefono', 'like', `%${q.replace(/\D+/g, '')}%`)
      })
    }

    return query.exec()
  }

  /** GET /agentes-captacion/light?activos=1&select=id,nombre,tipo&tipo=ASESOR_COMERCIAL */
  public async light({ request, response }: HttpContext) {
    const activos = String(request.input('activos', '1')) === '1'
    const tipo = String(request.input('tipo', '')).trim() //  NUEVO: Filtro por tipo

    const selectRaw = String(request.input('select', 'id,nombre,tipo'))
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)

    const cols = selectRaw.length ? selectRaw : ['id', 'nombre', 'tipo']

    let query = db
      .from('agentes_captacions')
      .leftJoin('usuarios', 'usuarios.id', 'agentes_captacions.usuario_id')
      .select(
        ...cols.map((c) => `agentes_captacions.${c}`),
        db.raw(`${ACTIVO_CALC_SQL} AS activo_calc`)
      )

    if (activos) {
      query = query.whereRaw(`${ACTIVO_CALC_SQL} = 1`)
    }

    // 🔥 NUEVO: Filtrar por tipo si se proporciona
    if (tipo && TIPOS.has(tipo)) {
      query = query.where('agentes_captacions.tipo', tipo)
    }

    const rows = await query

    const data = rows.map((r: any) => {
      const activo = Number(r.activo_calc) === 1
      return { ...r, activo }
    })

    return response.ok({ data })
  }

  /** GET /agentes-captacion/:id/convenios?vigente=1 */
  public async conveniosByAgente({ params, request }: HttpContext) {
    const asesorId = Number(params.id)
    const vigente = String(request.input('vigente', '1')) === '1'

    const rows = await db
      .from('convenios')
      .join('asesor_convenio_asignaciones as aca', 'aca.convenio_id', 'convenios.id')
      .where('aca.asesor_id', asesorId)
      .if(vigente, (qb) => qb.where('aca.activo', true).whereNull('aca.fecha_fin'))
      .select(
        'convenios.id',
        'convenios.nombre',
        'convenios.activo',
        'aca.activo as pivot_activo',
        'aca.fecha_inicio as pivot_fecha_inicio',
        'aca.fecha_fin as pivot_fecha_fin'
      )
      .orderBy('convenios.nombre', 'asc')

    return rows
  }

  /** ✅ NUEVO:
   * GET /agentes-captacion/:id/dateos-detalle?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
   * Devuelve los dateos del asesor + info del turno + monto de comisiones.
   */
  public async dateosDetalle({ params, request }: HttpContext) {
    const asesorId = Number(params.id)

    const desdeStr = request.input('desde') as string | undefined
    const hastaStr = request.input('hasta') as string | undefined

    let desdeSql: string | null = null
    let hastaSql: string | null = null

    if (desdeStr) {
      const d = DateTime.fromISO(desdeStr + 'T00:00:00')
      if (d.isValid) desdeSql = d.toSQL()
    }
    if (hastaStr) {
      const h = DateTime.fromISO(hastaStr + 'T23:59:59')
      if (h.isValid) hastaSql = h.toSQL()
    }

    const q = CaptacionDateo.query().where((qb) => {
      qb.where('asesor_id', asesorId)
        .orWhere('agente_id', asesorId)
        .orWhere('creado_por', asesorId)
        .orWhere('user_id', asesorId)
    })

    if (desdeSql) q.where('created_at', '>=', desdeSql)
    if (hastaSql) q.where('created_at', '<=', hastaSql)

    const dateos = await q

    const result = await Promise.all(
      dateos.map(async (d) => {
        const sumRow = await Comision.query()
          .where('captacion_dateo_id', d.id)
          .where('asesor_id', asesorId)
          .sum('monto as total')
          .first()

        const montoComision = Number(sumRow?.$extras.total || 0)

        const turno = await TurnoRtm.query()
          .where('captacion_dateo_id', d.id)
          .select(['id', 'turno_numero', 'turno_codigo', 'placa', 'estado'])
          .first()

        const tAny = turno as any
        const turnoId = turno?.id ?? null
        const turnoNumero = tAny?.turnoNumero ?? tAny?.turno_numero ?? null
        const turnoCodigo = tAny?.turnoCodigo ?? tAny?.turno_codigo ?? null
        const turnoEstado = tAny?.estado ?? null
        const turnoPlaca = tAny?.placa ?? null

        const r = String((d as any).resultado || '').toUpperCase()
        const exitosoFlag =
          (d as any).exitoso === true ||
          (d as any).consumidoExitoso === true ||
          ['EXITOSO', 'COMPLETADO', 'ATENDIDO', 'CONVERTIDO'].includes(r) ||
          montoComision > 0

        const createdAtIso = (d as any).createdAt?.toISO?.() ?? (d as any).created_at ?? null

        return {
          id: d.id,
          canal: (d as any).canal ?? null,
          placa: (d as any).placa ?? turnoPlaca ?? null,
          telefono: (d as any).telefono ?? null,
          resultado: (d as any).resultado ?? null,
          exitoso: exitosoFlag,
          turno_id: turnoId,
          turno_numero: turnoNumero,
          turno_codigo: turnoCodigo,
          turno_estado: turnoEstado,
          monto: montoComision,
          created_at: createdAtIso,
        }
      })
    )

    return { data: result }
  }

  /** ✅ NUEVO:
   * GET /agentes-captacion/:id/dateos-comisiones?page=&perPage=&desde=&hasta=
   *
   * Reemplaza el cruce manual que hacía el frontend (listDateos + listComisiones
   * con perPage=500, capado a 100 en el backend, perdiendo comisiones viejas).
   * Pagina los dateos del asesor con LIMIT/OFFSET real (sin tope artificial) y
   * les une la comisión ya calculada mediante 2 queries indexadas (no N+1):
   * 1) la página de dateos, 2) las comisiones de esos dateos puntuales.
   */
  public async dateosComisiones({ params, request, response }: HttpContext) {
    const asesorId = Number(params.id)
    const page = Number(request.input('page') || 1)
    const perPage = Math.min(Number(request.input('perPage') || 100), 500)
    const desdeStr = request.input('desde') as string | undefined
    const hastaStr = request.input('hasta') as string | undefined

    const agente = await AgenteCaptacion.find(asesorId)
    if (!agente) return response.notFound({ message: 'Asesor no encontrado' })

    const esRolConvenio = agente.tipo === 'ASESOR_CONVENIO'

    // El asesor convenio no tiene FK directa a `convenios`: se resuelve por
    // nombre, igual que /api/convenios/buscar-por-nombre (exacto y luego LIKE).
    let convenioId: number | null = null
    if (esRolConvenio) {
      const nombreNorm = agente.nombre.trim().replace(/\s+/g, ' ').toUpperCase()
      const normalizeSql =
        "UPPER(TRIM(REPLACE(REPLACE(REPLACE(nombre, '  ', ' '), '   ', ' '), '    ', ' ')))"

      let convenio = await Convenio.query()
        .whereRaw(`${normalizeSql} = ?`, [nombreNorm])
        .where('activo', true)
        .first()

      if (!convenio) {
        convenio = await Convenio.query()
          .whereRaw(`${normalizeSql} LIKE ?`, [`${nombreNorm}%`])
          .where('activo', true)
          .first()
      }
      convenioId = convenio?.id ?? null
    }

    const q = CaptacionDateo.query()
      .whereIn('canal', ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'])
      .where((qb) => {
        qb.where('agente_id', asesorId)
        if (convenioId !== null) qb.orWhere('convenio_id', convenioId)
      })
      .preload('agente')
      .preload('convenio', (cq) => cq.select(['id', 'nombre']))
      .preload('descuento')
      .orderBy('id', 'desc')

    if (desdeStr) q.where('created_at', '>=', `${desdeStr} 00:00:00`)
    if (hastaStr) q.where('created_at', '<=', `${hastaStr} 23:59:59`)

    const paginated = await q.paginate(page, perPage)
    const rows = paginated.all()

    // Info de turno (1 query indexada por página, no N+1)
    const turnoIds = Array.from(
      new Set(
        rows
          .map((d) => d.consumidoTurnoId)
          .filter((v): v is number => typeof v === 'number' && Number.isFinite(v))
      )
    )
    let turnosById: Record<number, any> = {}
    if (turnoIds.length) {
      const turnos = await TurnoRtm.query()
        .whereIn('id', turnoIds)
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

    // Comisiones de ESTA página de dateos (1 query indexada, no N+1).
    // Mismo filtro que usaba el frontend al unir listComisiones({asesorId})
    // con listComisiones({convenioId}): comisión propia O del convenio del asesor.
    const dateoIds = rows.map((d) => d.id)
    const comisionesByDateo: Record<number, Comision[]> = {}
    if (dateoIds.length) {
      const comisiones = await Comision.query()
        .whereIn('captacion_dateo_id', dateoIds)
        .where('tipo_servicio', 'RTM')
        .where((cq) => cq.where('es_config', false).orWhereNull('es_config'))
        .where((cq) => {
          cq.where('asesor_id', asesorId)
          if (convenioId !== null) cq.orWhere('convenio_id', convenioId)
        })
        .preload('asesor')
        .preload('convenio')

      for (const c of comisiones) {
        const key = c.captacionDateoId as number
        if (!comisionesByDateo[key]) comisionesByDateo[key] = []
        comisionesByDateo[key].push(c)
      }
    }

    const toNum = (v: string | number | null) => (v === null ? 0 : Number(v) || 0)
    const PRIORIDAD_ESTADO: Record<string, number> = {
      PAGADA: 4,
      APROBADA: 3,
      PENDIENTE: 2,
      ANULADA: 1,
    }

    const fmtBogotaAmPm = (dt: DateTime | null) =>
      dt ? dt.setZone('America/Bogota').toFormat('dd/LL/yy hh:mm a') : null

    const data = rows.map((d) => {
      const anyD: any = d
      const turno = d.consumidoTurnoId ? turnosById[d.consumidoTurnoId] : null
      const comisionesDelDateo = comisionesByDateo[d.id] || []

      let montoComision = 0
      let estadoComision: string | null = null
      const desgloseComision: { label: string; monto: number }[] = []
      const comisionesRaw: {
        id: number
        estado: string
        generado_at: string | null
        monto: number
      }[] = []

      for (const c of comisionesDelDateo) {
        const montoAsesor = c.montoAsesor !== null ? toNum(c.montoAsesor) : toNum(c.monto)
        const montoConvenio = c.montoConvenio !== null ? toNum(c.montoConvenio) : toNum(c.base)
        const nombreConvenio = (c as any).$preloaded?.convenio?.nombre ?? null
        const nombreAsesor = (c as any).$preloaded?.asesor?.nombre ?? 'Asesor'

        // montoRol = lo que le corresponde a ESTE asesor de ESTA fila de comisión
        // (puede sumar ambas partes si el asesor convenio se dateó a sí mismo).
        let montoRol = 0

        if (esRolConvenio) {
          const esConvenioDelAsesor = convenioId !== null && c.convenioId === convenioId
          const esAsesorQueDateo = c.asesorId === asesorId

          if (esConvenioDelAsesor) {
            montoRol += montoConvenio
            desgloseComision.push({
              label: `💼 ${nombreConvenio ?? 'Convenio'} (incentivo)`,
              monto: montoConvenio,
            })
          }
          if (esAsesorQueDateo) {
            montoRol += montoAsesor
            desgloseComision.push({ label: `📋 ${nombreAsesor} (dateo)`, monto: montoAsesor })
          }
        } else {
          const hayConvenio = c.convenioId !== null
          if (hayConvenio) {
            montoRol += montoAsesor
            desgloseComision.push({ label: `📋 ${nombreAsesor} (dateo)`, monto: montoAsesor })
          } else {
            montoRol += montoAsesor + montoConvenio
            desgloseComision.push({
              label: `🌟 ${nombreAsesor} (comisión)`,
              monto: montoAsesor + montoConvenio,
            })
          }
        }

        montoComision += montoRol
        comisionesRaw.push({
          id: c.id,
          estado: c.estado,
          generado_at: c.fechaCalculo ? c.fechaCalculo.toISO() : null,
          monto: montoRol,
        })

        const prio = PRIORIDAD_ESTADO[c.estado] || 0
        const prioActual = estadoComision ? PRIORIDAD_ESTADO[estadoComision] || 0 : -1
        if (prio > prioActual) estadoComision = c.estado
      }

      const descuentoRaw = anyD.$preloaded?.descuento ?? null
      const convenioRaw = anyD.$preloaded?.convenio ?? null
      const agenteRaw = anyD.$preloaded?.agente ?? null

      return {
        id: d.id,
        canal: 'ASESOR',
        placa: d.placa,
        telefono: d.telefono,
        origen: d.origen,
        observacion: d.observacion,
        resultado: d.resultado,
        liberado: d.liberado ?? false,
        imagen_url: d.imagenUrl ?? null,

        agente_id: d.agenteId,
        agente: agenteRaw
          ? { id: agenteRaw.id, nombre: agenteRaw.nombre, tipo: agenteRaw.tipo }
          : null,

        convenio_id: d.convenioId,
        convenio: convenioRaw ? { id: convenioRaw.id, nombre: convenioRaw.nombre } : null,

        descuento_id: d.descuentoId,
        descuento: descuentoRaw
          ? { id: descuentoRaw.id, codigo: descuentoRaw.codigo, nombre: descuentoRaw.nombre }
          : null,

        consumido_turno_id: d.consumidoTurnoId,
        consumido_at: d.consumidoAt ? d.consumidoAt.toISO() : null,

        es_avance: d.esAvance ?? false,
        comprobante_avance_url: d.comprobanteAvanceUrl ?? null,

        created_at: d.createdAt ? d.createdAt.toISO() : null,
        created_at_fmt: fmtBogotaAmPm(d.createdAt),
        updated_at: d.updatedAt ? d.updatedAt.toISO() : null,

        turnoInfo: turno
          ? {
              id: turno.id ?? null,
              fecha: turno.fecha?.toISODate ? turno.fecha.toISODate() : turno.fecha || null,
              numeroGlobal: turno.turnoNumero ?? null,
              numeroServicio: turno.turnoNumeroServicio ?? turno.turno_numero_servicio ?? null,
              estado: turno.estado ?? null,
              servicioCodigo: turno.$preloaded?.servicio?.codigoServicio ?? null,
              es_recurrente: turno.esRecurrente ?? turno.es_recurrente ?? null,
              es_recuperacion: turno.esRecuperacion ?? turno.es_recuperacion ?? null,
              meses_desde_ultima_visita:
                turno.mesesDesdeUltimaVisita ?? turno.meses_desde_ultima_visita ?? null,
            }
          : null,

        // 🆕 comisión ya calculada y unida por el backend (sin cruce en el navegador)
        monto_comision: montoComision,
        estado_comision: estadoComision,
        desglose_comision: desgloseComision,
        // fila(s) crudas de comisión (para historial de pagos: fecha/estado individual)
        comisiones: comisionesRaw,
      }
    })

    return response.ok({
      data,
      total: paginated.total,
      page: paginated.currentPage,
      perPage: paginated.perPage,
      lastPage: paginated.lastPage,
    })
  }
}
