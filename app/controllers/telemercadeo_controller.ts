// app/controllers/telemercadeo_controller.ts
import { aplicarSede, sedeParaEscritura, configParaEditar, scopeActual } from '#services/sede_scope'
import { estadoAgenteEnSede, sqlAsesorDeLaSede } from '#services/visibilidad_sede'
import fs from 'node:fs'
import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import ExcelJS from 'exceljs'
import Database from '@adonisjs/lucid/services/db'
import {
  FILTROS_CLIENTES,
  LISTAS,
  ORDENES_CLIENTES,
  RANGOS_POR_VENCER,
  obtenerColaTelemercadeo,
  type ListaCola,
  type OrdenClientes,
} from '#services/telemercadeo_cola_service'
import {
  RESULTADOS_ELEGIBLES,
  MEDIOS_GESTION,
  RESULTADOS_GESTION,
} from '#models/telemercadeo_gestion'
import ConfiguracionSeguimientoTeleGlobal from '#models/configuracion_seguimiento_tele_global'
import ConfiguracionSeguimientoTeleAsesor from '#models/configuracion_seguimiento_tele_asesor'
import {
  TIPO_AGENTE_TELE,
  ZONA_TELE,
  agenteTelemercadeoDeUsuario,
  autorizarExtra,
  avisosGestion,
  esRutaEvidenciaTele,
  estadoSeguimiento,
  getConfigSeguimientoTele,
  getMaxSeguimientos,
  getMinMaxSeguimientos,
  limiteDelCiclo,
  normalizarPlacaTele,
  normalizarTelefonoTele,
  registrarGestion,
  rutaAbsolutaEvidencia,
} from '#services/telemercadeo_gestion_service'
import {
  copiarMetas,
  guardarMetas,
  listarMetas,
  miResumen,
  parseRango,
  resumenTelemercadeo,
  type Rango,
} from '#services/telemercadeo_resumen_service'

const PER_PAGE_DEFAULT = 25
const PER_PAGE_MAX = 100
const ROLES_CONTROL = ['SUPER_ADMIN', 'GERENCIA']
/** Tope de filas de la hoja "Gestiones" del Excel; si se supera se avisa (nunca en silencio). */
const maxDetalleExcel = () => Number(process.env.TELE_EXCEL_MAX_DETALLE ?? 20000)

const MEDIO_LABEL: Record<string, string> = {
  LLAMADA: 'Llamada',
  WHATSAPP: 'WhatsApp',
  SMS: 'Mensaje de texto',
  CORREO: 'Correo',
}
const RESULTADO_LABEL: Record<string, string> = {
  SIN_RESPUESTA: 'Sin respuesta',
  NUMERO_EQUIVOCADO: 'Número equivocado',
  VOLVER_A_LLAMAR: 'Volver a llamar',
  INTERESADO: 'Interesado',
  NO_INTERESADO: 'No interesado',
  YA_REALIZADO: 'Ya lo realizó',
  DATEADO: 'Dateado',
}

async function rolDe(auth: HttpContext['auth']) {
  await auth.user!.load('rol')
  return String(auth.user!.rol?.nombre ?? '').toUpperCase()
}

const paginacion = (request: HttpContext['request']) => {
  const page = Math.max(1, Number.parseInt(request.input('page'), 10) || 1)
  const perPage = Math.min(
    PER_PAGE_MAX,
    Math.max(1, Number.parseInt(request.input('per_page'), 10) || PER_PAGE_DEFAULT)
  )
  return { page, perPage }
}

const fechaISO = (v: unknown): string | null => {
  if (!v) return null
  const dt =
    v instanceof Date ? DateTime.fromJSDate(v) : DateTime.fromSQL(String(v), { zone: ZONA_TELE })
  return dt.isValid ? dt.setZone(ZONA_TELE).toISO() : null
}
const fechaDia = (v: unknown): string | null => {
  if (!v) return null
  if (v instanceof Date) return DateTime.fromJSDate(v).toISODate()
  return String(v).substring(0, 10)
}

const parseMesAnio = (mesRaw: unknown, anioRaw: unknown) => {
  const hoy = DateTime.now().setZone(ZONA_TELE)
  const mes = mesRaw === undefined || mesRaw === null || mesRaw === '' ? hoy.month : Number(mesRaw)
  const anio =
    anioRaw === undefined || anioRaw === null || anioRaw === '' ? hoy.year : Number(anioRaw)
  if (
    !Number.isInteger(mes) ||
    mes < 1 ||
    mes > 12 ||
    !Number.isInteger(anio) ||
    anio < 2020 ||
    anio > 2100
  ) {
    return { error: 'mes (1-12) y anio inválidos' as const }
  }
  return { mes, anio }
}

export default class TelemercadeoController {
  /* ═════════════════════════ Cola (solo lectura) ═════════════════════════ */

  /** GET /api/telemercadeo/cola — ver telemercadeo_cola_service.ts. */
  public async cola({ request, response, auth }: HttpContext) {
    const lista = String(request.input('lista') || 'POR_VENCER').toUpperCase() as ListaCola
    if (!LISTAS.includes(lista)) {
      return response.badRequest({ message: `lista debe ser ${LISTAS.join(', ')}` })
    }

    const rangosValidos: readonly string[] =
      lista === 'CLIENTES' ? FILTROS_CLIENTES : RANGOS_POR_VENCER
    const rangoRaw = request.input('rango')
    const rango = rangoRaw ? String(rangoRaw).toUpperCase() : null
    if (rango && !rangosValidos.includes(rango)) {
      return response.badRequest({ message: `rango debe ser ${rangosValidos.join(', ')}` })
    }

    const orden = String(request.input('orden') || 'ANTIGUEDAD').toUpperCase() as OrdenClientes
    if (!ORDENES_CLIENTES.includes(orden)) {
      return response.badRequest({ message: `orden debe ser ${ORDENES_CLIENTES.join(', ')}` })
    }

    const { page, perPage } = paginacion(request)
    const qRaw = request.input('q')
    const q = qRaw ? String(qRaw).trim() || null : null

    // El límite de seguimientos que se muestra es el del asesor que consulta.
    const agente = auth.user ? await agenteTelemercadeoDeUsuario(auth.user.id) : null

    return response.ok(
      await obtenerColaTelemercadeo({
        lista,
        rango,
        q,
        orden,
        page,
        perPage,
        agenteId: agente?.id ?? null,
      })
    )
  }

  /* ═════════════════════════ Catálogos ═════════════════════════ */

  /** GET /api/telemercadeo/catalogos — orígenes activos, medios y resultados. */
  public async catalogos({ response }: HttpContext) {
    const origenes = await Database.from('telemercadeo_origenes')
      .where('activo', true)
      .orderBy('orden')
      .select('id', 'codigo', 'nombre')
    return response.ok({
      origenes,
      medios: MEDIOS_GESTION.map((v) => ({ value: v, title: MEDIO_LABEL[v] })),
      resultados: RESULTADOS_ELEGIBLES.map((v) => ({ value: v, title: RESULTADO_LABEL[v] })),
    })
  }

  /* ═════════════════════════ Gestiones ═════════════════════════ */

  /**
   * Agente cuyo historial se consulta: un asesor siempre el suyo (aunque
   * mande agente_id); SUPER_ADMIN/GERENCIA el que pidan (o todos).
   */
  private async alcance(
    ctx: HttpContext
  ): Promise<{ agenteId: number | null } | { error: number; message: string }> {
    const rol = await rolDe(ctx.auth)
    if (ROLES_CONTROL.includes(rol)) {
      const raw = ctx.request.input('agente_id')
      if (raw === undefined || raw === null || raw === '') return { agenteId: null }
      const id = Number(raw)
      return Number.isInteger(id) ? { agenteId: id } : { error: 400, message: 'agente_id inválido' }
    }
    const agente = await agenteTelemercadeoDeUsuario(ctx.auth.user!.id)
    if (!agente) {
      return { error: 403, message: 'Tu usuario no tiene un agente de Telemercadeo asociado.' }
    }
    return { agenteId: agente.id }
  }

  /**
   * GET /api/telemercadeo/gestiones
   * Filtros: desde, hasta (AAAA-MM-DD, Bogotá), placa, medio, origen_id,
   * resultado, agente_id (solo SUPER_ADMIN/GERENCIA), pendientes=1, page, per_page.
   */
  public async gestiones(ctx: HttpContext) {
    const { request, response } = ctx
    const alc = await this.alcance(ctx)
    if ('error' in alc) return response.status(alc.error).send({ message: alc.message })

    const pendientes = ['1', 'true'].includes(String(request.input('pendientes') ?? ''))
    let rango: Rango | null = null
    if (request.input('desde') || request.input('hasta')) {
      const r = parseRango(request.input('desde'), request.input('hasta'))
      if ('error' in r) return response.badRequest({ message: r.error })
      rango = r
    }

    // sede: aplicarSede(q, 'g.sede_id') tras los filtros (abajo)
    const q = Database.from('telemercadeo_gestiones as g')
      .join('agentes_captacions as a', 'a.id', 'g.agente_id')
      .join('telemercadeo_origenes as o', 'o.id', 'g.origen_id')
      .join('telemercadeo_ciclos as c', 'c.id', 'g.ciclo_id') // sede: joins por FK de g; aplicarSede(q, g.sede_id) abajo
      .join('servicios as s', 's.id', 'g.servicio_id')
      .leftJoin('captacion_dateos as d', 'd.id', 'g.captacion_dateo_id') // sede: joins por FK de g; aplicarSede(q, g.sede_id) abajo
      .leftJoin('clientes as cl', 'cl.id', 'g.cliente_id')

    if (alc.agenteId !== null) q.where('g.agente_id', alc.agenteId)
    if (rango)
      q.where('g.created_at', '>=', rango.inicioSql).where('g.created_at', '<', rango.finSql)

    const placa = normalizarPlacaTele(request.input('placa'))
    if (placa) q.where('g.placa', 'like', `%${placa.replace(/[\\%_]/g, '\\$&')}%`)

    const medio = String(request.input('medio') ?? '').toUpperCase()
    if (medio) {
      if (!(MEDIOS_GESTION as readonly string[]).includes(medio)) {
        return response.badRequest({ message: 'medio inválido' })
      }
      q.where('g.medio', medio)
    }
    const resultado = String(request.input('resultado') ?? '').toUpperCase()
    if (resultado) {
      if (!(RESULTADOS_GESTION as readonly string[]).includes(resultado)) {
        return response.badRequest({ message: 'resultado inválido' })
      }
      q.where('g.resultado', resultado)
    }
    const origenId = request.input('origen_id')
    if (origenId !== undefined && origenId !== null && origenId !== '') {
      q.where('g.origen_id', Number(origenId))
    }

    // Pendientes de seguimiento: última gestión de un ciclo abierto, con un
    // resultado que pide volver a contactar y fecha de contacto vencida o sin fecha.
    if (pendientes) {
      const hoy = DateTime.now().setZone(ZONA_TELE).toISODate()!
      q.where('c.abierto_key', 1)
        .whereRaw('g.numero_en_ciclo = c.numero_gestiones')
        .whereIn('g.resultado', ['SIN_RESPUESTA', 'VOLVER_A_LLAMAR', 'INTERESADO'])
        .where((w) =>
          w.whereNull('g.proximo_contacto_at').orWhere('g.proximo_contacto_at', '<=', hoy)
        )
    }

    // Multi-sede: solo gestiones de la sede activa (al final: agrupa lo anterior).
    aplicarSede(q, 'g.sede_id')
    const { page, perPage } = paginacion(request)
    const [{ total }] = await q.clone().count('* as total')
    const rows = await q
      .select(
        'g.*',
        'a.nombre as agente_nombre',
        'o.nombre as origen_nombre',
        'o.codigo as origen_codigo',
        's.codigo_servicio',
        'c.numero_gestiones as ciclo_numero_gestiones',
        'c.extras_autorizados as ciclo_extras',
        'c.abierto_key as ciclo_abierto_key',
        'c.cerrado_motivo as ciclo_cerrado_motivo',
        'd.resultado as dateo_resultado',
        'cl.nombre as cliente_nombre'
      )
      .orderBy(pendientes ? 'g.proximo_contacto_at' : 'g.created_at', pendientes ? 'asc' : 'desc')
      .orderBy('g.id', 'desc')
      .limit(perPage)
      .offset((page - 1) * perPage)

    const maxPorAgente = new Map<number, number>()
    for (const id of new Set(rows.map((r: any) => Number(r.agente_id)))) {
      maxPorAgente.set(id, await getMaxSeguimientos(id))
    }

    const minMax = await getMinMaxSeguimientos()

    const totalN = Number(total)
    return response.ok({
      data: rows.map((r: any) =>
        this.serializarGestion(r, maxPorAgente.get(Number(r.agente_id)) ?? 3, minMax)
      ),
      meta: {
        total: totalN,
        current_page: page,
        per_page: perPage,
        last_page: Math.max(1, Math.ceil(totalN / perPage)),
      },
    })
  }

  /** Sede activa para nombres de archivo: "Bogota", "Ibague", "Todas". */
  private async etiquetaSede(): Promise<string> {
    const s = scopeActual()
    if (!s || s === 'sin_filtro' || s.todas || s.sedeIds.length !== 1) return 'Todas'
    const sede = await Database.from('sedes').where('id', s.sedeIds[0]).select('nombre').first()
    return (
      String(sede?.nombre ?? '')
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[^A-Za-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '') || `Sede_${s.sedeIds[0]}`
    )
  }

  private serializarGestion(r: any, max: number, minMax: number) {
    const extras = Number(r.ciclo_extras ?? 0)
    const abierto = r.ciclo_abierto_key !== null && Boolean(r.ciclo_abierto_key)
    return {
      id: Number(r.id),
      created_at: fechaISO(r.created_at),
      agente_id: Number(r.agente_id),
      agente_nombre: r.agente_nombre ?? null,
      placa: r.placa,
      telefono: r.telefono ?? null,
      cliente_id: r.cliente_id ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      servicio_id: Number(r.servicio_id),
      servicio_codigo: r.codigo_servicio ?? null,
      medio: r.medio,
      origen_id: Number(r.origen_id),
      origen_nombre: r.origen_nombre ?? null,
      resultado: r.resultado,
      observacion: r.observacion ?? null,
      proximo_contacto_at: fechaDia(r.proximo_contacto_at),
      captacion_dateo_id: r.captacion_dateo_id ?? null,
      dateo_resultado: r.dateo_resultado ?? null,
      evidencia_url: `/api/telemercadeo/gestiones/${r.id}/evidencia`,
      seguimiento: {
        ciclo_id: Number(r.ciclo_id),
        numero_en_ciclo: Number(r.numero_en_ciclo),
        // Ciclo cerrado: sin límite (el actual no es el que regía entonces).
        limite: abierto ? limiteDelCiclo(max, extras, minMax) : null,
        // Menor límite entre los asesores de la sede: desde aquí alguien está bloqueado.
        limite_minimo: abierto ? minMax + extras : null,
        ciclo_abierto: abierto,
        cerrado_motivo: r.ciclo_cerrado_motivo ?? null,
      },
    }
  }

  /** Lectura de una gestión con el mismo alcance que el listado. */
  private async gestionVisible(ctx: HttpContext, id: number) {
    const rol = await rolDe(ctx.auth)
    // Multi-sede: una gestión de otra sede → 404.
    const row = await aplicarSede(
      Database.from('telemercadeo_gestiones').where('id', id),
      'sede_id'
    ).first()
    if (!row) return { error: 404, message: 'Gestión no encontrada' } as const
    if (ROLES_CONTROL.includes(rol)) return { row }
    const agente = await agenteTelemercadeoDeUsuario(ctx.auth.user!.id)
    if (!agente || agente.id !== Number(row.agente_id)) {
      return { error: 403, message: 'No puedes ver esta gestión.' } as const
    }
    return { row }
  }

  /** GET /api/telemercadeo/gestiones/:id */
  public async gestion(ctx: HttpContext) {
    const id = Number(ctx.params.id)
    const vis = await this.gestionVisible(ctx, id)
    if ('error' in vis) return ctx.response.status(vis.error!).send({ message: vis.message })
    // sede: por id de una gestión ya validada en la sede activa (gestionVisible)
    const r = await Database.from('telemercadeo_gestiones as g')
      .join('agentes_captacions as a', 'a.id', 'g.agente_id')
      .join('telemercadeo_origenes as o', 'o.id', 'g.origen_id')
      .join('telemercadeo_ciclos as c', 'c.id', 'g.ciclo_id') // sede: joins por FK de una gestión ya validada en la sede
      .join('servicios as s', 's.id', 'g.servicio_id')
      .leftJoin('captacion_dateos as d', 'd.id', 'g.captacion_dateo_id') // sede: joins por FK de una gestión ya validada en la sede
      .leftJoin('clientes as cl', 'cl.id', 'g.cliente_id')
      .where('g.id', id)
      .select(
        'g.*',
        'a.nombre as agente_nombre',
        'o.nombre as origen_nombre',
        's.codigo_servicio',
        'c.extras_autorizados as ciclo_extras',
        'c.abierto_key as ciclo_abierto_key',
        'c.cerrado_motivo as ciclo_cerrado_motivo',
        'd.resultado as dateo_resultado',
        'cl.nombre as cliente_nombre'
      )
      .first()
    return ctx.response.ok(
      this.serializarGestion(
        r,
        await getMaxSeguimientos(Number(r.agente_id)),
        await getMinMaxSeguimientos()
      )
    )
  }

  /**
   * GET /api/telemercadeo/gestiones/:id/evidencia — la imagen privada.
   * Solo el asesor dueño o SUPER_ADMIN/GERENCIA (autenticado, nunca pública).
   */
  public async evidencia(ctx: HttpContext) {
    const vis = await this.gestionVisible(ctx, Number(ctx.params.id))
    if ('error' in vis) return ctx.response.status(vis.error!).send({ message: vis.message })
    const ruta = vis.row.evidencia_ruta
    if (!esRutaEvidenciaTele(ruta))
      return ctx.response.notFound({ message: 'Evidencia no disponible' })
    const abs = rutaAbsolutaEvidencia(ruta)
    if (!fs.existsSync(abs)) return ctx.response.notFound({ message: 'Evidencia no disponible' })
    ctx.response.header('Cache-Control', 'private, no-store')
    return ctx.response.download(abs)
  }

  /**
   * POST /api/telemercadeo/gestiones — solo un agente ASESOR_TELEMERCADEO
   * (rol COMERCIAL) y siempre a su nombre. 201 nueva / 200 reenvío idempotente.
   */
  public async registrar({ request, response, auth }: HttpContext) {
    sedeParaEscritura() // "todas" no escribe (400)
    const agente = await agenteTelemercadeoDeUsuario(auth.user!.id)
    if (!agente) {
      return response.forbidden({
        code: 'NO_ES_ASESOR_TELEMERCADEO',
        message: 'Solo los asesores de Telemercadeo pueden registrar gestiones.',
      })
    }
    const res = await registrarGestion(
      agente,
      auth.user!.id,
      request.only([
        'placa',
        'telefono',
        'servicio_id',
        'medio',
        'origen_id',
        'resultado',
        'evidencia_ruta',
        'observacion',
        'proximo_contacto_at',
        'idempotency_key',
      ]) as any
    )
    if (!res.ok) return response.status(res.status).send(res.body)

    const avisos = await avisosGestion({
      placa: res.gestion.placa,
      telefono: res.gestion.telefono,
      servicioId: res.gestion.servicioId,
      agenteId: agente.id,
    })
    // sede: por id de la gestión recién creada en la sede activa
    const r = await Database.from('telemercadeo_gestiones as g')
      .join('agentes_captacions as a', 'a.id', 'g.agente_id')
      .join('telemercadeo_origenes as o', 'o.id', 'g.origen_id')
      .join('telemercadeo_ciclos as c', 'c.id', 'g.ciclo_id') // sede: joins por FK de una gestión ya validada en la sede
      .join('servicios as s', 's.id', 'g.servicio_id')
      .leftJoin('captacion_dateos as d', 'd.id', 'g.captacion_dateo_id') // sede: joins por FK de una gestión ya validada en la sede
      .leftJoin('clientes as cl', 'cl.id', 'g.cliente_id')
      .where('g.id', res.gestion.id)
      .select(
        'g.*',
        'a.nombre as agente_nombre',
        'o.nombre as origen_nombre',
        's.codigo_servicio',
        'c.extras_autorizados as ciclo_extras',
        'c.abierto_key as ciclo_abierto_key',
        'c.cerrado_motivo as ciclo_cerrado_motivo',
        'd.resultado as dateo_resultado',
        'cl.nombre as cliente_nombre'
      )
      .first()

    return response.status(res.repetida ? 200 : 201).send({
      gestion: this.serializarGestion(r, res.seguimiento.max, await getMinMaxSeguimientos()),
      seguimiento: res.seguimiento,
      avisos,
      repetida: res.repetida,
    })
  }

  /**
   * GET /api/telemercadeo/seguimiento?placa=&servicio_id=
   * Para el formulario: cliente/vehículo, estado del ciclo (n/limite),
   * gestiones del ciclo vigente y avisos (dateo activo / RTM vigente).
   */
  public async seguimiento(ctx: HttpContext) {
    const { request, response, auth } = ctx
    // Solo asesores de Telemercadeo y control (SUPER_ADMIN/GERENCIA): un
    // COMERCIAL sin agente de Telemercadeo no ve el historial de gestiones.
    const agente = await agenteTelemercadeoDeUsuario(auth.user!.id)
    if (!agente && !ROLES_CONTROL.includes(await rolDe(auth))) {
      return response.forbidden({
        code: 'NO_ES_ASESOR_TELEMERCADEO',
        message: 'Solo los asesores de Telemercadeo pueden consultar el seguimiento.',
      })
    }

    const placa = normalizarPlacaTele(request.input('placa'))
    if (!/^[A-Z0-9]{4,10}$/.test(placa)) return response.badRequest({ message: 'Placa inválida' })

    let servicioId = Number(request.input('servicio_id'))
    if (!Number.isInteger(servicioId) || servicioId <= 0) {
      const rtm = await Database.from('servicios').where('codigo_servicio', 'RTM').first()
      servicioId = rtm?.id
    }
    if (!servicioId) return response.badRequest({ message: 'servicio_id inválido' })

    const vehiculo = await Database.from('vehiculos').where('placa', placa).first()
    const cliente = vehiculo?.cliente_id
      ? await Database.from('clientes')
          .where('id', vehiculo.cliente_id)
          .select('id', 'nombre', 'telefono', 'doc_tipo', 'doc_numero')
          .first()
      : null
    const telefono =
      normalizarTelefonoTele(request.input('telefono')) ?? normalizarTelefonoTele(cliente?.telefono)

    const estado = await estadoSeguimiento(placa, servicioId, agente?.id ?? null)
    const gestionesCiclo = estado.ciclo_id
      ? // sede: gestiones de un ciclo de la sede activa (estadoSeguimiento usa el mixin)
        await Database.from('telemercadeo_gestiones as g')
          .join('agentes_captacions as a', 'a.id', 'g.agente_id')
          .join('telemercadeo_origenes as o', 'o.id', 'g.origen_id')
          .where('g.ciclo_id', estado.ciclo_id)
          .orderBy('g.numero_en_ciclo', 'asc')
          .select(
            'g.id',
            'g.numero_en_ciclo',
            'g.created_at',
            'g.medio',
            'g.resultado',
            'g.observacion',
            'a.nombre as agente_nombre',
            'o.nombre as origen_nombre'
          )
      : []

    return response.ok({
      placa,
      servicio_id: servicioId,
      vehiculo: vehiculo
        ? {
            id: vehiculo.id,
            marca: vehiculo.marca ?? null,
            linea: vehiculo.linea ?? null,
            modelo: vehiculo.modelo ?? null,
          }
        : null,
      cliente: cliente
        ? {
            id: cliente.id,
            nombre: cliente.nombre,
            telefono: cliente.telefono ?? null,
            documento: cliente.doc_numero
              ? [cliente.doc_tipo, cliente.doc_numero].filter(Boolean).join(' ')
              : null,
          }
        : null,
      seguimiento: estado,
      gestiones_ciclo: gestionesCiclo.map((g: any) => ({
        id: Number(g.id),
        numero_en_ciclo: Number(g.numero_en_ciclo),
        created_at: fechaISO(g.created_at),
        medio: g.medio,
        resultado: g.resultado,
        observacion: g.observacion ?? null,
        agente_nombre: g.agente_nombre ?? null,
        origen_nombre: g.origen_nombre ?? null,
      })),
      avisos: await avisosGestion({ placa, telefono, servicioId, agenteId: agente?.id ?? null }),
    })
  }

  /** GET /api/telemercadeo/mi-resumen?mes=&anio= — meta y KPIs del propio asesor. */
  public async miResumen({ request, response, auth }: HttpContext) {
    const agente = await agenteTelemercadeoDeUsuario(auth.user!.id)
    if (!agente) {
      return response.forbidden({
        code: 'NO_ES_ASESOR_TELEMERCADEO',
        message: 'Tu usuario no tiene un agente de Telemercadeo asociado.',
      })
    }
    const ma = parseMesAnio(request.input('mes'), request.input('anio'))
    if ('error' in ma) return response.badRequest({ message: ma.error })
    return response.ok({
      agente: { id: agente.id, nombre: agente.nombre },
      ...(await miResumen(agente.id, ma.mes, ma.anio)),
    })
  }

  /* ═════════════════════════ Control (SUPER_ADMIN / GERENCIA) ═════════════════════════ */

  /** GET /api/telemercadeo/resumen?desde=&hasta=&agente_id= */
  public async resumen({ request, response }: HttpContext) {
    const r = parseRango(request.input('desde'), request.input('hasta'))
    if ('error' in r) return response.badRequest({ message: r.error })
    const raw = request.input('agente_id')
    const agenteId = raw === undefined || raw === null || raw === '' ? null : Number(raw)
    if (agenteId !== null && !Number.isInteger(agenteId)) {
      return response.badRequest({ message: 'agente_id inválido' })
    }
    return response.ok(await resumenTelemercadeo(r, agenteId))
  }

  /** GET /api/telemercadeo/resumen/excel?desde=&hasta=&agente_id= */
  public async resumenExcel({ request, response }: HttpContext) {
    const r = parseRango(request.input('desde'), request.input('hasta'))
    if ('error' in r) return response.badRequest({ message: r.error })
    const raw = request.input('agente_id')
    const agenteId = raw === undefined || raw === null || raw === '' ? null : Number(raw)
    if (agenteId !== null && !Number.isInteger(agenteId)) {
      return response.badRequest({ message: 'agente_id inválido' })
    }
    const res = await resumenTelemercadeo(r, agenteId)

    const maxDetalle = maxDetalleExcel()
    const detalleQ = Database.from('telemercadeo_gestiones as g')
      .join('agentes_captacions as a', 'a.id', 'g.agente_id')
      .join('telemercadeo_origenes as o', 'o.id', 'g.origen_id')
      .join('servicios as s', 's.id', 'g.servicio_id')
      .leftJoin('captacion_dateos as d', 'd.id', 'g.captacion_dateo_id')
      .leftJoin('clientes as cl', 'cl.id', 'g.cliente_id')
      .where((q) => aplicarSede(q, 'g.sede_id'))
      .where('g.created_at', '>=', r.inicioSql)
      .where('g.created_at', '<', r.finSql)
      .orderBy('g.created_at', 'asc')
      .orderBy('g.id', 'asc')
      .limit(maxDetalle + 1)
      .select(
        'g.id',
        'g.created_at',
        'g.placa',
        'g.telefono',
        'g.medio',
        'g.resultado',
        'g.numero_en_ciclo',
        'g.observacion',
        'g.captacion_dateo_id',
        'a.nombre as agente_nombre',
        'o.nombre as origen_nombre',
        's.codigo_servicio',
        'd.resultado as dateo_resultado',
        'cl.nombre as cliente_nombre'
      )
    if (agenteId !== null) detalleQ.where('g.agente_id', agenteId)
    const detalleTodo = (await detalleQ) as any[]
    const truncado = detalleTodo.length > maxDetalle
    const detalle = truncado ? detalleTodo.slice(0, maxDetalle) : detalleTodo
    const avisoTruncado = `⚠️ La hoja "Gestiones" muestra solo las primeras ${maxDetalle.toLocaleString('es-CO')} gestiones de ${res.totales.gestiones.toLocaleString('es-CO')}. Reduce el rango o filtra por asesor para ver el detalle completo.`

    const wb = new ExcelJS.Workbook()
    const negrita = (row: ExcelJS.Row) => (row.font = { bold: true })
    const pct = (v: number | null) => (v === null ? '—' : `${v}%`)

    const ws = wb.addWorksheet('Resumen')
    ws.columns = [
      { width: 34 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 16 },
    ]
    ws.addRow([`Telemercadeo — Resumen (${r.desde} a ${r.hasta})`]).font = { bold: true, size: 13 }
    if (truncado) ws.addRow([avisoTruncado]).font = { bold: true, color: { argb: 'FFC00000' } }
    ws.addRow([])
    negrita(ws.addRow(['Embudo', 'Cantidad', 'Tasa']))
    const t = res.totales
    ws.addRow(['Gestiones', t.gestiones, ''])
    ws.addRow(['Dateos', t.dateos, pct(t.tasa_dateo)])
    ws.addRow(['Dateos exitosos', t.exitosos, pct(t.tasa_exito_sobre_dateos)])
    ws.addRow(['Turnos logrados', t.turnos, pct(t.tasa_turno_sobre_gestiones)])
    ws.addRow([])
    negrita(ws.addRow(['Por medio de contacto', 'Gestiones', 'Dateos', 'Exitosos']))
    for (const m of res.por_medio)
      ws.addRow([MEDIO_LABEL[m.medio] ?? m.medio, m.gestiones, m.dateos, m.exitosos])
    ws.addRow([])
    negrita(ws.addRow(['Por canal de origen', 'Gestiones', 'Dateos', 'Exitosos', 'Conversión']))
    for (const o of res.por_origen) {
      ws.addRow([o.nombre, o.gestiones, o.dateos, o.exitosos, pct(o.tasa_exito_sobre_gestiones)])
    }
    ws.addRow([])
    negrita(ws.addRow(['Por resultado', 'Gestiones']))
    for (const x of res.por_resultado)
      ws.addRow([RESULTADO_LABEL[x.resultado] ?? x.resultado, x.gestiones])

    const wa = wb.addWorksheet('Por asesor')
    wa.columns = [
      { width: 32 },
      { width: 12 },
      { width: 10 },
      { width: 10 },
      { width: 10 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 14 },
      { width: 12 },
    ]
    negrita(
      wa.addRow([
        'Asesor',
        'Gestiones',
        'Dateos',
        'Exitosos',
        'Turnos',
        'Conversión',
        'Meta exitosos',
        'Avance',
        'Faltante',
        'Semáforo',
      ])
    )
    for (const a of res.por_asesor) {
      const m = a.metas.exitosos
      wa.addRow([
        a.nombre,
        a.gestiones,
        a.dateos,
        a.exitosos,
        a.turnos,
        pct(a.tasa_exito_sobre_gestiones),
        m.meta ?? 'Sin meta',
        m.meta === null ? '—' : pct(m.pct),
        m.faltante ?? '—',
        m.semaforo === 'SIN_META' ? 'Sin meta' : m.semaforo,
      ])
    }

    const wd = wb.addWorksheet('Gestiones')
    wd.columns = [
      { width: 18 },
      { width: 26 },
      { width: 10 },
      { width: 26 },
      { width: 14 },
      { width: 8 },
      { width: 16 },
      { width: 18 },
      { width: 18 },
      { width: 6 },
      { width: 10 },
      { width: 14 },
      { width: 40 },
    ]
    if (truncado) wd.addRow([avisoTruncado]).font = { bold: true, color: { argb: 'FFC00000' } }
    negrita(
      wd.addRow([
        'Fecha',
        'Asesor',
        'Placa',
        'Cliente',
        'Teléfono',
        'Servicio',
        'Medio',
        'Origen',
        'Resultado',
        'Seg.',
        'Dateo',
        'Estado dateo',
        'Observación',
      ])
    )
    for (const g of detalle) {
      const f = fechaISO(g.created_at)
      wd.addRow([
        f ? DateTime.fromISO(f).setZone(ZONA_TELE).toFormat('dd/LL/yyyy HH:mm') : '',
        g.agente_nombre,
        g.placa,
        g.cliente_nombre ?? '',
        g.telefono ?? '',
        g.codigo_servicio ?? '',
        MEDIO_LABEL[g.medio] ?? g.medio,
        g.origen_nombre,
        RESULTADO_LABEL[g.resultado] ?? g.resultado,
        Number(g.numero_en_ciclo),
        g.captacion_dateo_id ?? '',
        g.dateo_resultado ?? '',
        g.observacion ?? '',
      ])
    }

    const buffer = await wb.xlsx.writeBuffer()
    const nombre = `Telemercadeo_${await this.etiquetaSede()}_${r.desde.replace(/-/g, '')}_a_${r.hasta.replace(/-/g, '')}.xlsx`
    response.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    response.header('Content-Disposition', `attachment; filename="${nombre}"`)
    if (truncado) response.header('X-Detalle-Truncado', String(maxDetalle))
    return response.send(Buffer.from(buffer as ArrayBuffer))
  }

  /** GET /api/telemercadeo/metas?mes=&anio= */
  public async metas({ request, response }: HttpContext) {
    const ma = parseMesAnio(request.input('mes'), request.input('anio'))
    if ('error' in ma) return response.badRequest({ message: ma.error })
    return response.ok({ mes: ma.mes, anio: ma.anio, data: await listarMetas(ma.mes, ma.anio) })
  }

  /** PUT /api/telemercadeo/metas { mes, anio, metas: [{ asesor_id, meta_gestiones, meta_dateos, meta_exitosos }] } */
  public async guardarMetas({ request, response }: HttpContext) {
    sedeParaEscritura() // "todas" no escribe (400)
    const ma = parseMesAnio(request.input('mes'), request.input('anio'))
    if ('error' in ma) return response.badRequest({ message: ma.error })
    const res = await guardarMetas(ma.mes, ma.anio, request.input('metas'))
    if ('error' in res) return response.badRequest({ message: res.error })
    return response.ok({ mes: ma.mes, anio: ma.anio, data: res.data })
  }

  /** POST /api/telemercadeo/metas/copiar { desde_mes, desde_anio, hacia_mes, hacia_anio, sobrescribir } */
  public async copiarMetas({ request, response }: HttpContext) {
    sedeParaEscritura() // "todas" no escribe (400)
    const desde = parseMesAnio(request.input('desde_mes'), request.input('desde_anio'))
    const hacia = parseMesAnio(request.input('hacia_mes'), request.input('hacia_anio'))
    if ('error' in desde || 'error' in hacia) {
      return response.badRequest({
        message: 'desde_mes/desde_anio y hacia_mes/hacia_anio son obligatorios y válidos',
      })
    }
    if (!request.input('desde_mes') || !request.input('hacia_mes')) {
      return response.badRequest({ message: 'desde_mes y hacia_mes son obligatorios' })
    }
    const sobrescribir = [true, 'true', 1, '1'].includes(request.input('sobrescribir'))
    const res = await copiarMetas(desde, hacia, sobrescribir)
    if ('error' in res) return response.badRequest({ message: res.error })
    return response.ok({
      mes: hacia.mes,
      anio: hacia.anio,
      copiadas: res.copiadas,
      omitidas: res.omitidas,
      data: res.data,
    })
  }

  /** POST /api/telemercadeo/ciclos/:id/autorizar-extra { motivo } */
  public async autorizarExtra({ params, request, response, auth }: HttpContext) {
    sedeParaEscritura() // "todas" no escribe (400)
    const res = await autorizarExtra(Number(params.id), auth.user!.id, request.input('motivo'))
    if (!res.ok) return response.status(res.status).send(res.body)
    const autorizaciones = await Database.from('telemercadeo_ciclo_autorizaciones as x') // sede: ciclo validado por autorizarExtra (TelemercadeoCiclo con mixin)
      .leftJoin('usuarios as u', 'u.id', 'x.usuario_id') // sede: ciclo validado por autorizarExtra (TelemercadeoCiclo con mixin)
      .where('x.ciclo_id', res.ciclo.id)
      .orderBy('x.id', 'asc')
      .select('x.id', 'x.motivo', 'x.created_at', 'x.usuario_id', 'u.nombres', 'u.apellidos')
    return response.ok({
      ciclo_id: res.ciclo.id,
      extras_autorizados: res.ciclo.extrasAutorizados,
      numero_gestiones: res.ciclo.numeroGestiones,
      autorizaciones: autorizaciones.map((a: any) => ({
        id: Number(a.id),
        motivo: a.motivo,
        created_at: fechaISO(a.created_at),
        usuario_id: Number(a.usuario_id),
        usuario_nombre: [a.nombres, a.apellidos].filter(Boolean).join(' ') || null,
      })),
    })
  }

  /* ═════════════════════════ Configuración (patrón max-redateos) ═════════════════════════ */

  /** GET /api/telemercadeo/config/max-seguimientos */
  public async configGet({ response }: HttpContext) {
    const cfg = await getConfigSeguimientoTele()
    return response.ok({
      max_seguimientos: cfg.maxSeguimientos,
      dias_vigencia_ciclo: cfg.diasVigenciaCiclo,
    })
  }

  /** POST /api/telemercadeo/config/max-seguimientos { max_seguimientos?, dias_vigencia_ciclo? } */
  public async configUpsert({ request, response }: HttpContext) {
    sedeParaEscritura() // "todas" no escribe (400)
    const entero = (v: unknown) =>
      v === undefined || v === null || v === '' ? undefined : Math.trunc(Number(v))
    const max = entero(request.input('max_seguimientos'))
    const dias = entero(request.input('dias_vigencia_ciclo'))
    if (max === undefined && dias === undefined) {
      return response.badRequest({ message: 'Envía max_seguimientos y/o dias_vigencia_ciclo' })
    }
    if (max !== undefined && (!Number.isFinite(max) || max <= 0 || max > 50)) {
      return response.badRequest({ message: 'max_seguimientos debe ser un entero entre 1 y 50' })
    }
    if (dias !== undefined && (!Number.isFinite(dias) || dias <= 0 || dias > 365)) {
      return response.badRequest({
        message: 'dias_vigencia_ciclo debe ser un entero entre 1 y 365',
      })
    }
    await getConfigSeguimientoTele()
    const cfg = (await configParaEditar(ConfiguracionSeguimientoTeleGlobal))!
    if (max !== undefined) cfg.maxSeguimientos = max
    if (dias !== undefined) cfg.diasVigenciaCiclo = dias
    await cfg.save()
    return response.ok({
      max_seguimientos: cfg.maxSeguimientos,
      dias_vigencia_ciclo: cfg.diasVigenciaCiclo,
    })
  }

  /** GET /api/telemercadeo/config/max-seguimientos/asesores */
  public async configAsesoresIndex({ response }: HttpContext) {
    const configs = await ConfiguracionSeguimientoTeleAsesor.query()
      .whereRaw(sqlAsesorDeLaSede('asesor_id'))
      .preload('asesor')
    return response.ok({
      data: configs.map((c) => ({
        id: c.id,
        asesor_id: c.asesorId,
        asesor_nombre: c.asesor?.nombre ?? null,
        max_seguimientos: c.maxSeguimientos,
      })),
    })
  }

  /** POST /api/telemercadeo/config/max-seguimientos/asesores { asesor_id, max_seguimientos } (null = usa el global) */
  public async configAsesoresUpsert({ request, response }: HttpContext) {
    sedeParaEscritura() // "todas" no escribe (400)
    const asesorId = Number(request.input('asesor_id'))
    if (!Number.isInteger(asesorId) || asesorId <= 0) {
      return response.badRequest({ message: 'asesor_id es requerido' })
    }
    // sede: el asesor ya se validó en la sede activa (estadoAgenteEnSede, abajo/arriba)
    const agente = await Database.from('agentes_captacions')
      .where('id', asesorId)
      .where('tipo', TIPO_AGENTE_TELE)
      .first()
    if (!agente) return response.badRequest({ message: 'El asesor debe ser de Telemercadeo' })

    const raw = request.input('max_seguimientos')
    let max: number | null = null
    if (raw !== null && raw !== undefined && raw !== '') {
      max = Math.trunc(Number(raw))
      if (!Number.isFinite(max) || max <= 0 || max > 50) {
        return response.badRequest({
          message: 'max_seguimientos debe ser un entero entre 1 y 50, o null para usar el global',
        })
      }
    }
    {
      const visAsesor = await estadoAgenteEnSede(Number(asesorId))
      if (visAsesor === 'otra') {
        return response.conflict({
          code: 'AGENTE_OTRA_SEDE',
          message: 'El asesor pertenece a otra sede.',
        })
      }
      if (visAsesor === 'no') return response.notFound({ message: 'Asesor no encontrado' })
    }
    let cfg = await ConfiguracionSeguimientoTeleAsesor.query().where('asesor_id', asesorId).first()
    if (!cfg)
      cfg = await ConfiguracionSeguimientoTeleAsesor.create({ asesorId, maxSeguimientos: max })
    else {
      cfg.maxSeguimientos = max
      await cfg.save()
    }
    return response.ok({
      id: cfg.id,
      asesor_id: cfg.asesorId,
      max_seguimientos: cfg.maxSeguimientos,
    })
  }

  /** DELETE /api/telemercadeo/config/max-seguimientos/asesores/:id */
  public async configAsesoresDelete({ params, response }: HttpContext) {
    sedeParaEscritura() // "todas" no escribe (400)
    const cfg = await ConfiguracionSeguimientoTeleAsesor.find(params.id)
    if (!cfg) return response.notFound({ message: 'Configuración no encontrada' })
    await cfg.delete()
    return response.ok({ message: 'Configuración eliminada correctamente' })
  }

  /** GET /api/telemercadeo/asesores — agentes de Telemercadeo (para filtros y metas). */
  public async asesores({ response }: HttpContext) {
    const rows = await Database.from('agentes_captacions')
      .where((q) => aplicarSede(q, 'agentes_captacions.sede_id'))
      .where('tipo', TIPO_AGENTE_TELE)
      .orderBy('nombre')
      .select('id', 'nombre', 'activo', 'usuario_id')
    return response.ok({
      data: rows.map((r: any) => ({
        id: Number(r.id),
        nombre: r.nombre,
        activo: Boolean(r.activo),
        usuario_id: r.usuario_id ?? null,
      })),
    })
  }
}
