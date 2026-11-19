// src/app/controllers/contratos_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Contrato from '#models/contrato'
import ContratoPaso from '#models/contrato_paso'
import ContratoHistorialEstado from '#models/contrato_historial_estado'
import ContratoSalario from '#models/contrato_salario'
import Usuario from '#models/usuario'
import ContratoCambio from '#models/contrato_cambio'
import EntidadSalud from '#models/entidad_salud'
import Sede from '#models/sede'
import Cargo from '#models/cargo'
import RazonSocial from '#models/razon_social'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import { normalizarId, validarSedeContrato } from '#services/usuario_permisos_service'

import app from '@adonisjs/core/services/app'
import { DateTime } from 'luxon'
import { cuid } from '@adonisjs/core/helpers'
import fs from 'node:fs/promises'
import path from 'node:path'
import db from '@adonisjs/lucid/services/db'

// descarga
import { createReadStream, existsSync, statSync } from 'node:fs'
import mime from 'mime-types'

type Estado = 'activo' | 'inactivo'
type TipoContrato = 'prestacion' | 'temporal' | 'laboral' | 'aprendizaje'

export default class ContratosController {
  /* ============================
   Helpers base (fechas, json, normalización, etc.)
  ============================ */

  private toIsoDate(value: any): string | null {
    if (!value) return null
    if (typeof value?.toISODate === 'function') return value.toISODate()
    if (typeof value === 'string') {
      const dt = DateTime.fromISO(value)
      return dt.isValid ? dt.toISODate() : null
    }
    if (value instanceof Date) return DateTime.fromJSDate(value).toISODate()
    return null
  }

  // ✅ DESPUÉS (mantiene fecha local)
  private toDateTime(value: any): DateTime | null {
    if (!value) return null
    if (typeof value?.toISO === 'function') return value as any
    if (typeof value === 'string') {
      // Formato YYYY-MM-DD → crear DateTime local sin conversión UTC
      const dt = DateTime.fromFormat(value, 'yyyy-MM-dd').startOf('day')
      return dt.isValid ? dt : null
    }
    if (value instanceof Date) return DateTime.fromJSDate(value)
    return null
  }

  private json(value: any): string {
    return JSON.stringify(value ?? null)
  }

  /** Actor (prioriza auth; luego header; luego body) */
  /**
   * Multi-sede Fase 0: el contrato copia su sede al usuario, así que aplica
   * las mismas reglas de sede que la gestión de usuarios
   * (usuario_permisos_service.validarSedeContrato). Devuelve el mensaje de
   * error o null si está permitido.
   */
  private async permisoSedeContrato(
    ctx: HttpContext,
    datos: { sedeContrato: unknown; sedeContratoActual: number | null; usuarioId: unknown }
  ): Promise<{ status: number; message: string } | null> {
    const actor = ctx.auth.user
    if (!actor) return { status: 401, message: 'No autenticado' }
    await actor.load('rol')

    const sedeContrato = normalizarId(datos.sedeContrato)
    if (Number.isNaN(sedeContrato)) return { status: 422, message: 'sedeId inválido.' }

    const usuarioId = normalizarId(datos.usuarioId)
    let usuario: { rol: string | null; sedeId: number | null } | null = null
    if (typeof usuarioId === 'number' && !Number.isNaN(usuarioId)) {
      const u = await Usuario.query().where('id', usuarioId).preload('rol').first()
      if (u) usuario = { rol: u.rol?.nombre ?? null, sedeId: u.sedeId ?? null }
    }

    const res = validarSedeContrato(
      { rol: actor.rol?.nombre ?? null, sedeId: actor.sedeId ?? null },
      {
        sedeContrato: sedeContrato ?? null,
        sedeContratoActual: datos.sedeContratoActual,
        usuario,
      }
    )
    return res.ok ? null : { status: res.status, message: res.message }
  }

  private getActorId(ctx: HttpContext): number | null {
    const { auth, request } = ctx
    const parse = (v: any) => {
      const n = Number(v)
      return Number.isFinite(n) && n > 0 ? n : null
    }
    return (
      parse(auth?.user?.id) ??
      parse(request.header('x-actor-id')) ??
      parse(request.input('actorId') ?? request.input('usuarioId')) ??
      null
    )
  }

  /** Envuelve IDs con {id,nombre} para tracking de cambios */
  private async wrapValueWithName(campo: string, val: any): Promise<any> {
    if (val === null || val === undefined || val === '') return null
    if (typeof val === 'object') return val
    const num = Number(val)
    if (!Number.isFinite(num)) return val

    switch (campo) {
      case 'epsId':
      case 'arlId':
      case 'afpId':
      case 'afcId':
      case 'ccfId': {
        const ent = await EntidadSalud.find(num)
        return { id: num, nombre: ent?.nombre ?? `#${num}` }
      }
      case 'sedeId': {
        const s = await Sede.find(num)
        return { id: num, nombre: s?.nombre ?? `#${num}` }
      }
      case 'cargoId': {
        const c = await Cargo.find(num)
        return { id: num, nombre: c?.nombre ?? `#${num}` }
      }
      case 'razonSocialId': {
        const r = await RazonSocial.find(num)
        return { id: num, nombre: r?.nombre ?? `#${num}` }
      }
      default:
        return val
    }
  }

  /** Normaliza a booleano o null */
  private toBoolOrNull(v: any): boolean | null {
    if (v === null || v === undefined) return null
    if (typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (typeof v === 'string') {
      const s = v.trim().toLowerCase()
      if (['true', '1', 'si', 'sí', 'yes', 'y'].includes(s)) return true
      if (['false', '0', 'no', 'n'].includes(s)) return false
      return s.length ? true : null
    }
    return !!v
  }

  // @ts-expect-error - Método reservado para uso futuro
  private allowedTerminosByTipo: Record<TipoContrato, string[]> = {
    prestacion: ['fijo', 'obra_o_labor_determinada'],
    temporal: ['obra_o_labor_determinada'],
    laboral: ['fijo', 'obra_o_labor_determinada', 'indefinido'],
    aprendizaje: ['fijo'],
  }

  /** Preloads comunes para listar/ver */
  private preloadRelations(query: any) {
    query
      .preload('usuario')
      .preload('sede')
      .preload('cargo')
      .preload('razonSocial')
      .preload('eps')
      .preload('arl')
      .preload('afp')
      .preload('afc')
      .preload('ccf')
      .preload('pasos', (q: any) => {
        q.preload('usuario', (uq: any) => {
          uq.select(['id', 'nombres', 'apellidos', 'correo'])
        })
          .orderByRaw(
            `
          CASE fase
            WHEN 'inicio' THEN 1
            WHEN 'desarrollo' THEN 2
            WHEN 'fin' THEN 3
            ELSE 4
          END
        `
          )
          .orderBy('orden', 'asc')
      })
      .preload('eventos', (q: any) => {
        q.preload('usuario', (uq: any) => {
          uq.select(['id', 'nombres', 'apellidos', 'correo'])
        }).orderBy('created_at', 'desc')
      })
      .preload('historialEstados', (q: any) => {
        q.preload('usuario').orderBy('fecha_cambio', 'desc')
      })
      .preload('salarios', (q: any) => {
        q.orderBy('fecha_efectiva', 'desc').limit(1)
      })
      .preload('cambios', (q: any) => {
        q.preload('usuario').orderBy('created_at', 'desc')
      })
  }
  /* ============================
   Helpers de archivos (MIME, ext, tamaño, nombres, paths)
  ============================ */

  /** Content-Type robusto desde el UploadedFile de Adonis */
  private getContentType(file: any): string {
    return file?.type && file?.subtype
      ? `${file.type}/${file.subtype}`
      : (file?.headers?.['content-type'] as string) || ''
  }

  /** Trata de deducir una extensión segura a partir del nombre o del MIME */
  private safeExtFrom(file: any, fallback = 'bin'): string {
    const ct = this.getContentType(file).toLowerCase()
    const fromCt = (mime.extension(ct) as string) || ''
    const fromName =
      (file?.extname as string) || (file?.clientName ? path.extname(file.clientName).slice(1) : '')
    return (fromName || fromCt || fallback).toLowerCase()
  }

  /** Permitidos para RECOMENDACIÓN MÉDICA */
  // ✅ MANTENER SOLO ESTA (línea ~264):
  private static readonly AFI_ALLOWED_MIMES = new Set<string>([
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/webp',
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ])

  // ✅ Y eliminar completamente la línea ~305 que dice:
  // private static readonly AFI_ALLOWED_MIMES = [ ... ]
  private static readonly REC_ALLOWED_EXTS = new Set<string>([
    'pdf',
    'doc',
    'docx',
    'jpg',
    'jpeg',
    'png',
    'webp',
  ])

  /** Meta simple desde ruta relativa */
  private fileMetaFromRelPath(
    rel: string | null | undefined
  ): { nombre: string; url: string } | null {
    if (!rel) return null
    const nombre = path.basename(rel)
    return { nombre, url: rel }
  }

  /* ============================
   Helpers de LOG / tracking de cambios
  ============================ */

  private async logArchivoSubido(
    contrato: Contrato,
    nombre: string,
    url: string,
    by: number | null
  ) {
    await ContratoCambio.create({
      contratoId: contrato.id,
      usuarioId: by, // ✅ CORRECTO - quien hizo el cambio
      campo: 'recomendacion_medica_archivo',
      oldValue: this.json(null),
      newValue: this.json({ nombre, url }),
    })
  }

  private async logArchivoReemplazado(
    contrato: Contrato,
    viejo: { nombre: string; url: string } | null,
    nuevo: { nombre: string; url: string },
    by: number | null
  ) {
    await ContratoCambio.create({
      contratoId: contrato.id,
      usuarioId: by, // ✅ CORRECTO
      campo: 'recomendacion_medica_archivo',
      oldValue: this.json(viejo),
      newValue: this.json(nuevo),
    })
  }

  private async logArchivoEliminado(
    contrato: Contrato,
    viejo: { nombre: string; url: string } | null,
    by: number | null
  ) {
    await ContratoCambio.create({
      contratoId: contrato.id,
      usuarioId: by, // ✅ CORRECTO
      campo: 'recomendacion_medica_archivo',
      oldValue: this.json(viejo),
      newValue: this.json(null),
    })
  }

  private async logContratoFisicoCambio(
    contrato: Contrato,
    oldMeta: { nombre: string; url: string } | null,
    newMeta: { nombre: string; url: string } | null,
    by: number | null
  ) {
    await ContratoCambio.create({
      contratoId: contrato.id,
      usuarioId: by, // ✅ CORRECTO
      campo: 'contrato_fisico_archivo',
      oldValue: this.json(oldMeta),
      newValue: this.json(newMeta),
    })
  }

  private async logContratoFisicoObservacion(
    contrato: Contrato,
    nota: string | null,
    by: number | null
  ) {
    if (!nota?.trim()) return
    await ContratoCambio.create({
      contratoId: contrato.id,
      usuarioId: by, // ✅ CORRECTO
      campo: 'contrato_fisico_archivo_observacion',
      oldValue: this.json(null),
      newValue: this.json({ nota: nota.trim() }),
    })
  }

  private async logCambioArchivo(
    contrato: Contrato,
    campo: string,
    viejo: { nombre: string; url: string } | null,
    nuevo: { nombre: string; url: string } | null,
    by: number | null
  ) {
    await ContratoCambio.create({
      contratoId: contrato.id,
      usuarioId: by, // ✅ CORRECTO
      campo,
      oldValue: this.json(viejo),
      newValue: this.json(nuevo),
    })
  }

  /* ============================
   Helpers para Afiliación (nombres de campos/dirs)
  ============================ */

  private static readonly TIPOS_AFILIACION = ['eps', 'arl', 'afp', 'afc', 'ccf'] as const

  private camposAfiContrato(tipo: (typeof ContratosController.TIPOS_AFILIACION)[number]) {
    return {
      path: `${tipo}DocPath` as const,
      nombre: `${tipo}DocNombre` as const,
      mime: `${tipo}DocMime` as const,
      size: `${tipo}DocSize` as const,
      dir: `uploads/contratos/afiliaciones/${tipo}`,
    }
  }

  // @ts-expect-error - Propiedad reservada para validación futura
  private static readonly AFI_ALLOWED_EXTS = new Set([
    'pdf',
    'jpg',
    'jpeg',
    'png',
    'webp',
    'doc',
    'docx',
  ])

  /* ============================
     Sincronización usuario
  ============================ */

  private async getContratoPrioritario(usuarioId: number): Promise<Contrato | null> {
    const activo = await Contrato.query()
      .where('usuarioId', usuarioId)
      .where('estado', 'activo' as Estado)
      .orderBy('fechaInicio', 'desc')
      .first()
    if (activo) return activo

    const masReciente = await Contrato.query()
      .where('usuarioId', usuarioId)
      .orderBy('fechaInicio', 'desc')
      .first()
    return masReciente ?? null
  }

  private copiarCamposContratoEnUsuario(src: Contrato, user: Usuario) {
    user.razonSocialId = src.razonSocialId
    user.sedeId = src.sedeId
    user.cargoId = src.cargoId
    if (src.centroCosto !== undefined && src.centroCosto !== null)
      user.centroCosto = src.centroCosto
    if (src.epsId !== null && src.epsId !== undefined) user.epsId = src.epsId
    if (src.arlId !== null && src.arlId !== undefined) user.arlId = src.arlId
    if (src.afpId !== null && src.afpId !== undefined) user.afpId = src.afpId
    if (src.afcId !== null && src.afcId !== undefined) user.afcId = src.afcId
    if (src.ccfId !== null && src.ccfId !== undefined) user.ccfId = src.ccfId
  }

  private async syncUsuarioTrasGuardarContrato(contrato: Contrato) {
    if (!contrato.usuarioId) return
    const user = await Usuario.find(contrato.usuarioId)
    if (!user) return

    if (contrato.estado === 'activo') {
      this.copiarCamposContratoEnUsuario(contrato, user)
      await user.save()
      return
    }

    const primary = await this.getContratoPrioritario(contrato.usuarioId)
    if (primary) {
      this.copiarCamposContratoEnUsuario(primary, user)
      await user.save()
    }
  }

  /**
   * Garantiza que, si el usuario del contrato es ASESOR,
   * exista:
   *  - un AgenteCaptacion ligado al usuario (COMERCIAL / CONVENIO / TELEMERCADEO)
   *  - y, si es ASESOR_CONVENIO, un Convenio ligado lógicamente al usuario
   *
   * Se llama DESPUÉS de crear el contrato (store / anexarFisico).
   */
  private async ensureAgenteYConvenioParaContrato(contrato: Contrato) {
    try {
      if (!contrato.usuarioId) return

      await contrato.load('usuario')
      await contrato.load('cargo')
      const usuario = contrato.usuario
      const cargo = contrato.cargo
      if (!usuario || !cargo) return

      const nombreCargo = (cargo.nombre || '').toUpperCase().trim()

      type TipoAsesor = 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'ASESOR_TELEMERCADEO'
      let tipo: TipoAsesor | null = null

      if (nombreCargo.includes('ASESOR COMERCIAL') || nombreCargo === 'COMERCIAL') {
        tipo = 'ASESOR_COMERCIAL'
      } else if (nombreCargo.includes('ASESOR CONVENIO')) {
        tipo = 'ASESOR_CONVENIO'
      } else if (nombreCargo.includes('TELEMERCADEO') || nombreCargo.includes('TELEMARKETING')) {
        tipo = 'ASESOR_TELEMERCADEO'
      }

      if (!tipo) return

      const telefonoUsuario =
        (usuario as any).celularPersonal ||
        (usuario as any).celularCorporativo ||
        (usuario as any).telefono ||
        (usuario as any).celular ||
        (usuario as any).telefono1 ||
        null

      const nombreAgente =
        (usuario as any).nombreCompleto ||
        (usuario as any).nombre ||
        `${(usuario as any).nombres ?? ''} ${(usuario as any).apellidos ?? ''}`.trim() ||
        `Usuario #${usuario.id}`

      try {
        // ✅ SOLUCIÓN: updateOrCreate evita el error de duplicado
        await AgenteCaptacion.updateOrCreate(
          { usuarioId: usuario.id },
          {
            tipo,
            nombre: nombreAgente,
            telefono: telefonoUsuario,
            activo: true,
          }
        )

        if (tipo !== 'ASESOR_CONVENIO') return

        const docNumeroUsuario =
          (usuario as any).numeroDocumento ||
          (usuario as any).numeroCedula ||
          (usuario as any).cedula ||
          (usuario as any).documento ||
          (usuario as any).identificacion ||
          null

        const docNumeroContrato = (contrato as any).identificacion
          ? String((contrato as any).identificacion)
          : null

        const docNumero = docNumeroUsuario || docNumeroContrato || null

        if (!docNumero) {
          console.warn(
            `[WARN] No se pudo crear Convenio para usuario ${usuario.id}: falta documento`
          )
          return
        }

        const docTipoUsuario = (usuario as any).tipoDocumento || (usuario as any).docTipo || 'CC'
        const direccionUsuario =
          (usuario as any).direccion ||
          (usuario as any).direccionResidencia ||
          (usuario as any).direccionDomicilio ||
          null

        const telefonoConvenio =
          (usuario as any).telefono ||
          (usuario as any).celular ||
          (usuario as any).celularPersonal ||
          (usuario as any).celularCorporativo ||
          null

        const whatsappConvenio =
          (usuario as any).whatsapp ||
          (usuario as any).telefono ||
          (usuario as any).celular ||
          (usuario as any).celularPersonal ||
          (usuario as any).celularCorporativo ||
          null

        const emailConvenio = (usuario as any).email || (usuario as any).correo || null

        const nombreConvenio =
          (usuario as any).nombreComercial ||
          (usuario as any).nombreCompleto ||
          (usuario as any).nombre ||
          `${(usuario as any).nombres ?? ''} ${(usuario as any).apellidos ?? ''}`.trim() ||
          `Convenio usuario #${usuario.id}`

        await Convenio.updateOrCreate(
          { docNumero },
          {
            tipo: 'PERSONA',
            nombre: nombreConvenio,
            docTipo: docTipoUsuario,
            telefono: telefonoConvenio,
            whatsapp: whatsappConvenio,
            email: emailConvenio,
            direccion: direccionUsuario,
            activo: true,
          }
        )
      } catch (innerError: any) {
        console.error('[ERROR] No se pudo crear AgenteCaptacion/Convenio:', innerError.message)
      }
    } catch (error: any) {
      console.error('[ERROR] ensureAgenteYConvenioParaContrato falló:', error.message)
    }
  }

  /* ============================
     CRUD contratos — index/show/usuario
  ============================ */

  public async index(ctx: HttpContext) {
    const { response } = ctx
    try {
      const query = Contrato.query()
      this.preloadRelations(query)
      const contratos = await query.orderBy('id', 'desc')
      return response.ok(contratos)
    } catch (error: any) {
      console.error('Error al obtener contratos:', error)
      return response.internalServerError({
        message: 'Error al obtener contratos',
        error: error.message,
      })
    }
  }

  public async show(ctx: HttpContext) {
    const { params, response } = ctx
    try {
      const query = Contrato.query().where('id', params.id)
      this.preloadRelations(query)
      const contrato = await query.firstOrFail()
      return response.ok(contrato)
    } catch (error: any) {
      console.error('Error al obtener contrato por ID:', error)
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      return response.internalServerError({
        message: 'Error al obtener contrato',
        error: error.message,
      })
    }
  }

  public async getContratosUsuario(ctx: HttpContext) {
    const { params, response } = ctx
    try {
      const usuarioId = params.usuarioId
      const query = Contrato.query().where('usuarioId', usuarioId)
      this.preloadRelations(query)
      const contratos = await query
        .orderBy('fechaInicio', 'asc') // antiguo → reciente
        .orderBy('id', 'asc') // desempate estable

      return response.ok(contratos)
    } catch (error: any) {
      console.error('Error al obtener contratos del usuario:', error)
      return response.internalServerError({
        message: 'Error al obtener contratos del usuario',
        error: error.message,
      })
    }
  }
  public async store(ctx: HttpContext) {
    const { request, response } = ctx
    const trx = await db.transaction()
    try {
      const actorId = this.getActorId(ctx)
      const allRequestData = request.all()

      if (!allRequestData.razonSocialId) {
        return response.badRequest({ message: "El campo 'razonSocialId' es obligatorio." })
      }

      const {
        pasos,
        salarioBasico,
        bonoSalarial,
        auxilioTransporte,
        auxilioNoSalarial,
        fechaFin,
        fechaFinalizacion,
        fechaTerminacion: fechaTermInput,
        ...contratoData
      } = allRequestData

      // Tipo contrato + validación término
      const tipo: TipoContrato = contratoData.tipoContrato
      const allowedTipos: TipoContrato[] = ['prestacion', 'temporal', 'laboral', 'aprendizaje']
      if (!allowedTipos.includes(tipo)) {
        await trx.rollback()
        return response.badRequest({ message: "Valor inválido para 'tipoContrato'." })
      }

      const baseRaw = salarioBasico ?? allRequestData.salario
      const baseNum = Number(baseRaw)
      if (!Number.isFinite(baseNum)) {
        await trx.rollback()
        return response.badRequest({
          message: "El campo 'salarioBasico' es obligatorio y debe ser numérico.",
        })
      }

      const nullIfEmpty = (v: any) => (v === '' || v === undefined ? null : v)

      const contratoDataNorm: any = {
        ...contratoData,
        usuarioId: nullIfEmpty(contratoData.usuarioId),
        razonSocialId: nullIfEmpty(contratoData.razonSocialId),
        sedeId: nullIfEmpty(contratoData.sedeId),
        cargoId: nullIfEmpty(contratoData.cargoId),
        epsId: nullIfEmpty(contratoData.epsId),
        arlId: nullIfEmpty(contratoData.arlId),
        afpId: nullIfEmpty(contratoData.afpId),
        afcId: nullIfEmpty(contratoData.afcId),
        ccfId: nullIfEmpty(contratoData.ccfId),
      }

      const denegado = await this.permisoSedeContrato(ctx, {
        sedeContrato: contratoDataNorm.sedeId,
        sedeContratoActual: null,
        usuarioId: contratoDataNorm.usuarioId,
      })
      if (denegado) {
        await trx.rollback()
        return response.status(denegado.status).send({ message: denegado.message })
      }

      // ✅ Nueva forma: sin conversión UTC
      let fechaInicioLuxon: DateTime | null = null
      if (contratoDataNorm.fechaInicio) {
        if (typeof contratoDataNorm.fechaInicio === 'string') {
          fechaInicioLuxon = DateTime.fromFormat(
            contratoDataNorm.fechaInicio,
            'yyyy-MM-dd'
          ).startOf('day')
        } else {
          fechaInicioLuxon = this.toDateTime(contratoDataNorm.fechaInicio)
        }
      }

      if (!fechaInicioLuxon || !fechaInicioLuxon.isValid) {
        await trx.rollback()
        return response.badRequest({ message: "La 'fechaInicio' es inválida o no fue enviada." })
      }

      const aliasFechaTerm = fechaTermInput ?? fechaFin ?? fechaFinalizacion ?? null

      const terminoNorm =
        (contratoDataNorm.terminoContrato === 'obra_o_labor'
          ? 'obra_o_labor_determinada'
          : contratoDataNorm.terminoContrato) ?? null

      let terminoEff: string | null = terminoNorm
      if (!terminoEff && tipo === 'laboral') terminoEff = 'indefinido'

      const allowedByTipo: Record<TipoContrato, string[]> = {
        prestacion: ['fijo', 'obra_o_labor_determinada'],
        temporal: ['obra_o_labor_determinada'],
        laboral: ['fijo', 'obra_o_labor_determinada', 'indefinido'],
        aprendizaje: ['fijo'],
      }
      if (terminoEff && !allowedByTipo[tipo].includes(terminoEff)) {
        await trx.rollback()
        return response.badRequest({ message: `'terminoContrato' inválido para tipo '${tipo}'.` })
      }

      const needsEnd =
        tipo === 'prestacion' ||
        tipo === 'aprendizaje' ||
        tipo === 'temporal' ||
        (tipo === 'laboral' && (terminoEff ?? '').toLowerCase() !== 'indefinido')
      if (needsEnd && !aliasFechaTerm) {
        await trx.rollback()
        return response.badRequest({
          message: "La 'fechaTerminacion' es obligatoria para el tipo de contrato enviado.",
        })
      }

      // ✅ Nueva forma: sin conversión UTC
      let fechaTerminacionLuxon: DateTime | null = null
      if (aliasFechaTerm) {
        if (typeof aliasFechaTerm === 'string') {
          fechaTerminacionLuxon = DateTime.fromFormat(aliasFechaTerm, 'yyyy-MM-dd').startOf('day')
        } else {
          fechaTerminacionLuxon = this.toDateTime(aliasFechaTerm)
        }
      }

      const contrato = await Contrato.create({
        ...contratoDataNorm,
        razonSocialId: contratoDataNorm.razonSocialId,
        fechaInicio: fechaInicioLuxon,
        fechaTerminacion: fechaTerminacionLuxon || null,
        estado: 'activo',
        salario: baseNum,
        terminoContrato: terminoEff,
      })

      await ContratoSalario.create({
        contratoId: contrato.id,
        salarioBasico: Number(salarioBasico) || baseNum,
        bonoSalarial: Number(bonoSalarial) || 0,
        auxilioTransporte: Number(auxilioTransporte) || 0,
        auxilioNoSalarial: Number(auxilioNoSalarial) || 0,
        fechaEfectiva: DateTime.now(),
      })

      // pasos (opcional)
      let pasosRecibidos: any[] = []
      if (Array.isArray(pasos)) pasosRecibidos = pasos
      else if (typeof pasos === 'string' && pasos.trim()) {
        try {
          pasosRecibidos = JSON.parse(pasos)
        } catch {}
      }

      const pasosParaGuardar: any[] = []
      if (Array.isArray(pasosRecibidos)) {
        for (const pasoData of pasosRecibidos) {
          pasosParaGuardar.push({
            contratoId: contrato.id,
            fase: pasoData.fase,
            nombrePaso: pasoData.nombrePaso,
            fecha: pasoData.fecha ? DateTime.fromISO(pasoData.fecha) : null,
            observacion: pasoData.observacion,
            orden: pasoData.orden,
            completado: !!pasoData.completado,
            archivoUrl: pasoData.archivoUrl || null,
          })
        }
      }
      if (pasosParaGuardar.length > 0) await ContratoPaso.createMany(pasosParaGuardar)

      // Historial: creación
      await ContratoHistorialEstado.create({
        contratoId: contrato.id,
        usuarioId: actorId ?? null,
        oldEstado: 'inactivo',
        newEstado: 'activo',
        fechaCambio: DateTime.now(),
        fechaInicioContrato: contrato.fechaInicio,
        motivo: 'Creación de contrato',
      })

      await ContratoCambio.create({
        contratoId: contrato.id,
        usuarioId: actorId, // ← CORRECTO
        campo: 'creacion',
        oldValue: this.json(null),
        newValue: this.json({ estado: 'activo' }),
      })

      await trx.commit()
      await this.syncUsuarioTrasGuardarContrato(contrato)
      // NUEVO: Garantizar agente + convenio si el usuario es ASESOR CONVENIO
      await this.ensureAgenteYConvenioParaContrato(contrato)

      await contrato.load((loader) => this.preloadRelations(loader))
      return response.created(contrato)
    } catch (error: any) {
      await trx.rollback()
      console.error('Error al crear contrato:', error)
      return response.internalServerError({
        message: 'Error al crear contrato',
        error: error.message,
      })
    }
  }

  public async anexarFisico(ctx: HttpContext) {
    const { request, response } = ctx
    const trx = await db.transaction()
    try {
      const actorId = this.getActorId(ctx)
      const contratoId = request.input('contratoId')

      // Validador local (PDF estricto para el contrato)
      const ensurePdfOrThrow = (file: any, maxBytes: number) => {
        if (!file || !file.tmpPath) {
          throw new Error('Archivo de contrato inválido o no adjunto.')
        }
        const ct = this.getContentType(file).toLowerCase()
        const ext = this.safeExtFrom(file, 'pdf')
        const isPdf = ct === 'application/pdf' || ext === 'pdf'
        if (!isPdf) throw new Error('Tipo de archivo no permitido: debe ser PDF.')
        const size = Number(file.size || 0)
        if (size > maxBytes) throw new Error('El PDF supera el tamaño máximo permitido (10MB).')
      }

      // ====== MODO A: anexar a contrato existente ======
      if (contratoId) {
        const contrato = await Contrato.findOrFail(contratoId)

        const archivoContrato =
          request.file('archivo') ||
          request.file('archivoContrato') ||
          request.file('archivoContratoFisico')
        ensurePdfOrThrow(archivoContrato, 25 * 1024 * 1024)

        const razonSocialId = request.input('razonSocialId')
        if (razonSocialId) contrato.razonSocialId = Number(razonSocialId)

        const oldMeta = this.fileMetaFromRelPath(contrato.rutaArchivoContratoFisico)

        // borra anterior si había
        if (contrato.rutaArchivoContratoFisico) {
          try {
            await fs.unlink(
              path.join(app.publicPath(), contrato.rutaArchivoContratoFisico.replace(/^\//, ''))
            )
          } catch (e: any) {
            if (e.code !== 'ENOENT') console.error('No se pudo eliminar archivo anterior:', e)
          }
        }

        // guarda nuevo PDF
        const uploadDir = 'uploads/contratos'
        const fileName = `${cuid()}.pdf`
        const destinationDir = path.join(app.publicPath(), uploadDir)
        await fs.mkdir(destinationDir, { recursive: true })
        await (archivoContrato as any).move(destinationDir, { name: fileName })

        contrato.nombreArchivoContratoFisico = fileName
        contrato.rutaArchivoContratoFisico = `/${uploadDir}/${fileName}`

        const observacionArchivo = String(request.input('observacionArchivo') ?? '').trim()
        await contrato.save()

        await this.logContratoFisicoCambio(
          contrato,
          oldMeta,
          { nombre: fileName, url: `/${uploadDir}/${fileName}` },
          actorId
        )
        await this.logContratoFisicoObservacion(contrato, observacionArchivo, actorId)

        // Recomendación médica opcional (SIN extnames, validación manual)
        const tieneRecRaw = request.input('tieneRecomendacionesMedicas')
        const tieneRec = tieneRecRaw === true || String(tieneRecRaw).toLowerCase() === 'true'

        if (tieneRec) {
          const archivoRec =
            request.file('archivoRecomendacionMedica') ||
            request.file('archivoRecomendacion') ||
            request.file('recomendacion')

          if (!archivoRec || !archivoRec.tmpPath) {
            throw new Error('Archivo de recomendación médica inválido o no adjunto.')
          }

          const recCT = this.getContentType(archivoRec).toLowerCase()
          const recExt = this.safeExtFrom(archivoRec, 'bin')
          const recMimeOk = !recCT || ContratosController.REC_ALLOWED_EXTS.has(recCT)
          const recExtOk = ContratosController.REC_ALLOWED_EXTS.has(recExt)
          if (!(recMimeOk || recExtOk)) {
            throw new Error(
              'Tipo de archivo de recomendación no permitido. Use pdf, doc, docx, jpg, jpeg, png, webp.'
            )
          }

          const oldMetaRec = this.fileMetaFromRelPath(contrato.rutaArchivoRecomendacionMedica)

          const recDir = 'uploads/recomendaciones_medicas'
          const recExtFinal = recExtOk ? recExt : (mime.extension(recCT) as string) || 'bin'
          const recName = `${cuid()}.${recExtFinal}`
          const recDest = path.join(app.publicPath(), recDir)
          await fs.mkdir(recDest, { recursive: true })
          await archivoRec.move(recDest, { name: recName })

          contrato.tieneRecomendacionesMedicas = true
          contrato.rutaArchivoRecomendacionMedica = `/${recDir}/${recName}`
          await contrato.save()

          if (oldMetaRec) {
            await this.logArchivoReemplazado(
              contrato,
              oldMetaRec,
              { nombre: recName, url: `/${recDir}/${recName}` },
              actorId
            )
          } else {
            await this.logArchivoSubido(contrato, recName, `/${recDir}/${recName}`, actorId)
          }
        }

        await trx.commit()
        await this.syncUsuarioTrasGuardarContrato(contrato)
        // Aunque aquí no se "crea" el contrato, por consistencia podemos asegurar agente+convenio
        await this.ensureAgenteYConvenioParaContrato(contrato)

        await contrato.load((loader) => this.preloadRelations(loader))
        return response.ok({ message: 'Archivo anexado correctamente', contrato })
      }

      // ====== MODO B: Crear + anexar en una sola llamada ======
      const allRequestData = request.all()
      if (!allRequestData.razonSocialId) {
        return response.badRequest({ message: "El campo 'razonSocialId' es obligatorio." })
      }

      const {
        pasos,
        salarioBasico,
        bonoSalarial,
        auxilioTransporte,
        auxilioNoSalarial,
        fechaFin,
        fechaFinalizacion,
        fechaTerminacion: fechaTermInput,
        tieneRecomendacionesMedicas,
        observacionArchivo,
        ...contratoData
      } = allRequestData

      const tipo: TipoContrato = contratoData.tipoContrato
      const allowedTipos: TipoContrato[] = ['prestacion', 'temporal', 'laboral', 'aprendizaje']
      if (!allowedTipos.includes(tipo)) {
        await trx.rollback()
        return response.badRequest({ message: "Valor inválido para 'tipoContrato'." })
      }

      const baseRaw = salarioBasico ?? allRequestData.salario
      const baseNum = Number(baseRaw)
      if (!Number.isFinite(baseNum)) {
        await trx.rollback()
        return response.badRequest({
          message: "El campo 'salarioBasico' es obligatorio y debe ser numérico.",
        })
      }

      if (!contratoData.sedeId) {
        await trx.rollback()
        return response.badRequest({ message: "El campo 'sedeId' es obligatorio." })
      }

      const aliasFechaTerm = fechaTermInput ?? fechaFin ?? fechaFinalizacion ?? null

      // ✅ Nueva forma: sin conversión UTC
      let fechaInicioLuxon: DateTime | null = null
      if (contratoData.fechaInicio) {
        if (typeof contratoData.fechaInicio === 'string') {
          fechaInicioLuxon = DateTime.fromFormat(contratoData.fechaInicio, 'yyyy-MM-dd').startOf(
            'day'
          )
        } else {
          fechaInicioLuxon = this.toDateTime(contratoData.fechaInicio)
        }
      }

      if (!fechaInicioLuxon || !fechaInicioLuxon.isValid) {
        await trx.rollback()
        return response.badRequest({ message: "La 'fechaInicio' es inválida o no fue enviada." })
      }

      const terminoNorm =
        (contratoData.terminoContrato === 'obra_o_labor'
          ? 'obra_o_labor_determinada'
          : contratoData.terminoContrato) ?? null
      let terminoEff: string | null = terminoNorm
      if (!terminoEff && tipo === 'laboral') terminoEff = 'indefinido'

      const allowedByTipo2: Record<TipoContrato, string[]> = {
        prestacion: ['fijo', 'obra_o_labor_determinada'],
        temporal: ['obra_o_labor_determinada'],
        laboral: ['fijo', 'obra_o_labor_determinada', 'indefinido'],
        aprendizaje: ['fijo'],
      }
      if (terminoEff && !allowedByTipo2[tipo].includes(terminoEff)) {
        await trx.rollback()
        return response.badRequest({ message: `'terminoContrato' inválido para tipo '${tipo}'.` })
      }

      const needsEnd =
        tipo === 'prestacion' ||
        tipo === 'aprendizaje' ||
        tipo === 'temporal' ||
        (tipo === 'laboral' && (terminoEff ?? '').toLowerCase() !== 'indefinido')
      if (needsEnd && !aliasFechaTerm) {
        await trx.rollback()
        return response.badRequest({
          message: "La 'fechaTerminacion' es obligatoria para el tipo de contrato enviado.",
        })
      }

      // PDF del contrato (obligatorio)
      const archivoContratoLegacy =
        request.file('archivo') ||
        request.file('archivoContrato') ||
        request.file('archivoContratoFisico')

      ensurePdfOrThrow(archivoContratoLegacy, 25 * 1024 * 1024) // 👈 25 MB

      // Guardar archivo contrato
      const uploadDir = 'uploads/contratos'
      const fileName = `${cuid()}.pdf`
      const destinationDir = path.join(app.publicPath(), uploadDir)
      await fs.mkdir(destinationDir, { recursive: true })
      await (archivoContratoLegacy as any).move(destinationDir, { name: fileName })
      const publicUrl = `/${uploadDir}/${fileName}`

      // ✅ Nueva forma: sin conversión UTC
      let fechaTerminacionLuxon: DateTime | null = null
      if (aliasFechaTerm) {
        if (typeof aliasFechaTerm === 'string') {
          fechaTerminacionLuxon = DateTime.fromFormat(aliasFechaTerm, 'yyyy-MM-dd').startOf('day')
        } else {
          fechaTerminacionLuxon = this.toDateTime(aliasFechaTerm)
        }
      }

      const contrato = await Contrato.create(
        {
          ...contratoData,
          razonSocialId: contratoData.razonSocialId,
          fechaInicio: fechaInicioLuxon,
          fechaTerminacion: fechaTerminacionLuxon || null,
          estado: 'activo',
          nombreArchivoContratoFisico: fileName,
          rutaArchivoContratoFisico: publicUrl,
          salario: baseNum,
          terminoContrato: terminoEff as 'fijo' | 'obra_o_labor_determinada' | 'indefinido' | null,
          tieneRecomendacionesMedicas: false,
          rutaArchivoRecomendacionMedica: null,
        },
        { client: trx }
      )

      await ContratoSalario.create(
        {
          contratoId: contrato.id,
          salarioBasico: Number(salarioBasico) || baseNum,
          bonoSalarial: Number(bonoSalarial) || 0,
          auxilioTransporte: Number(auxilioTransporte) || 0,
          auxilioNoSalarial: Number(auxilioNoSalarial) || 0,
          fechaEfectiva: DateTime.now(),
        },
        { client: trx }
      )

      await this.logContratoFisicoCambio(
        contrato,
        null,
        { nombre: fileName, url: publicUrl },
        actorId
      )
      await this.logContratoFisicoObservacion(contrato, String(observacionArchivo ?? ''), actorId)

      // Recomendación médica opcional
      const tieneRecRaw2 = tieneRecomendacionesMedicas
      const tieneRec2 = tieneRecRaw2 === true || String(tieneRecRaw2).toLowerCase() === 'true'
      if (tieneRec2) {
        const archivoRecomendacion =
          request.file('archivoRecomendacionMedica') ||
          request.file('archivoRecomendacion') ||
          request.file('recomendacion')

        if (!archivoRecomendacion || !archivoRecomendacion.tmpPath) {
          await trx.rollback()
          return response.badRequest({
            message: 'Archivo de recomendación médica inválido o no adjunto.',
          })
        }

        const recCT = this.getContentType(archivoRecomendacion).toLowerCase()
        const recExt = this.safeExtFrom(archivoRecomendacion, 'bin')
        const recMimeOk = !recCT || ContratosController.REC_ALLOWED_EXTS.has(recCT)
        const recExtOk = ContratosController.REC_ALLOWED_EXTS.has(recExt)
        if (!(recMimeOk || recExtOk)) {
          await trx.rollback()
          return response.badRequest({
            message:
              'Tipo de archivo de recomendación no permitido. Use pdf, doc, docx, jpg, jpeg, png, webp.',
          })
        }

        const recDir = 'uploads/recomendaciones_medicas'
        const recExtFinal = recExtOk ? recExt : (mime.extension(recCT) as string) || 'bin'
        const recName = `${cuid()}.${recExtFinal}`
        const recDest = path.join(app.publicPath(), recDir)
        await fs.mkdir(recDest, { recursive: true })
        await archivoRecomendacion.move(recDest, { name: recName })

        contrato.tieneRecomendacionesMedicas = true
        contrato.rutaArchivoRecomendacionMedica = `/${recDir}/${recName}`

        await this.logArchivoSubido(contrato, recName, `/${recDir}/${recName}`, actorId)
        await contrato.save()
      }

      // Historial: creación
      await ContratoHistorialEstado.create(
        {
          contratoId: contrato.id,
          usuarioId: actorId ?? null,
          oldEstado: 'inactivo',
          newEstado: 'activo',
          fechaCambio: DateTime.now(),
          fechaInicioContrato: contrato.fechaInicio,
          motivo: 'Creación de contrato',
        },
        { client: trx }
      )

      await ContratoCambio.create(
        {
          contratoId: contrato.id,
          usuarioId: contrato.usuarioId,
          campo: 'creacion',
          oldValue: this.json(null),
          newValue: this.json({ estado: 'activo', by: actorId ?? null }),
        },
        { client: trx }
      )

      await trx.commit()
      await this.syncUsuarioTrasGuardarContrato(contrato)
      // NUEVO: Garantizar agente + convenio si el usuario es ASESOR CONVENIO
      await this.ensureAgenteYConvenioParaContrato(contrato)

      await contrato.load((loader) => this.preloadRelations(loader))
      return response.created({ message: 'Contrato creado y anexado correctamente.', contrato })
    } catch (error: any) {
      await trx.rollback()
      console.error('Error en anexarFisico (crear y/o anexar):', error)
      return response.badRequest({
        message: error.message || 'Error al crear y anexar contrato físico',
      })
    }
  }

  public async cambiarEstado(ctx: HttpContext) {
    const { params, request, response } = ctx
    const trx = await db.transaction()
    try {
      const actorId = this.getActorId(ctx)
      const contrato = await Contrato.findOrFail(params.id)

      const estadoRaw = String(request.input('estado') ?? '').toLowerCase()
      const nuevoEstado: Estado =
        estadoRaw === 'activo' ? 'activo' : estadoRaw === 'inactivo' ? 'inactivo' : (null as any)
      if (!nuevoEstado)
        return response.badRequest({
          message: "Parámetro 'estado' inválido. Use 'activo' | 'inactivo'.",
        })

      const oldEstado = contrato.estado

      if (nuevoEstado === 'inactivo') {
        const aliasFechaTerm =
          request.input('fechaTerminacion') ??
          request.input('fechaFin') ??
          request.input('fechaFinalizacion') ??
          null

        const tipoEff: TipoContrato = contrato.tipoContrato as TipoContrato
        const incomingTerm =
          (contrato as any).terminoContrato === 'obra_o_labor'
            ? 'obra_o_labor_determinada'
            : (contrato as any).terminoContrato
        const terminoEff = incomingTerm ?? (tipoEff === 'laboral' ? 'indefinido' : null)

        const allowedByTipo: Record<TipoContrato, string[]> = {
          prestacion: ['fijo', 'obra_o_labor_determinada'],
          temporal: ['obra_o_labor_determinada'],
          laboral: ['fijo', 'obra_o_labor_determinada', 'indefinido'],
          aprendizaje: ['fijo'],
        }
        if (terminoEff && !allowedByTipo[tipoEff].includes(terminoEff)) {
          await trx.rollback()
          return response.badRequest({
            message: `'terminoContrato' inválido para tipo '${tipoEff}'.`,
          })
        }

        const requiereFin =
          tipoEff === 'prestacion' ||
          tipoEff === 'aprendizaje' ||
          tipoEff === 'temporal' ||
          (tipoEff === 'laboral' && (terminoEff ?? '').toLowerCase() !== 'indefinido')

        // ✅ Nueva forma: sin conversión UTC
        let fechaTermLuxon: DateTime | null = null
        if (aliasFechaTerm) {
          if (typeof aliasFechaTerm === 'string') {
            fechaTermLuxon = DateTime.fromFormat(aliasFechaTerm, 'yyyy-MM-dd').startOf('day')
          } else {
            fechaTermLuxon = this.toDateTime(aliasFechaTerm)
          }
        } else {
          fechaTermLuxon = contrato.fechaTerminacion ?? null
        }
        if (requiereFin && !fechaTermLuxon) {
          await trx.rollback()
          return response.badRequest({
            message: "La 'fechaTerminacion' es obligatoria para este contrato.",
          })
        }

        contrato.fechaTerminacion = fechaTermLuxon
        contrato.motivoFinalizacion =
          request.input('motivoFinalizacion') ?? contrato.motivoFinalizacion ?? null
      }

      contrato.estado = nuevoEstado
      await contrato.save()

      if (oldEstado !== nuevoEstado) {
        const fechaInicioHist = this.toDateTime(contrato.fechaInicio)
        await ContratoHistorialEstado.create(
          {
            contratoId: contrato.id,
            usuarioId: actorId ?? null,
            oldEstado,
            newEstado: nuevoEstado,
            fechaCambio: DateTime.now(),
            fechaInicioContrato: fechaInicioHist ?? null,
            motivo: nuevoEstado === 'inactivo' ? contrato.motivoFinalizacion : null,
          },
          { client: trx }
        )
      }

      await trx.commit()
      await this.syncUsuarioTrasGuardarContrato(contrato)
      await contrato.load((loader) => this.preloadRelations(loader))
      return response.ok(contrato)
    } catch (error: any) {
      await trx.rollback()
      console.error('Error al cambiar estado del contrato:', error)
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      return response.internalServerError({
        message: 'Error al cambiar estado del contrato',
        error: error.message,
      })
    }
  }

  /* =========================
     UPDATE (con early-exit para solo estado)
  ========================= */
  public async update(ctx: HttpContext) {
    const { params, request, response } = ctx
    const trx = await db.transaction()
    try {
      const actorId = this.getActorId(ctx)
      const contrato = await Contrato.findOrFail(params.id)
      const oldEstado = contrato.estado

      const raw = request.all()

      const denegado = await this.permisoSedeContrato(ctx, {
        sedeContrato: 'sedeId' in raw ? raw.sedeId : contrato.sedeId,
        sedeContratoActual: contrato.sedeId ?? null,
        usuarioId: contrato.usuarioId,
      })
      if (denegado) {
        await trx.rollback()
        return response.status(denegado.status).send({ message: denegado.message })
      }

      // --- Early-exit: solo toggle de estado (con motivo/fecha opcionales) ---
      const keys = Object.keys(raw)
      const soloEstado =
        keys.length > 0 &&
        keys.every((k) =>
          [
            'estado',
            'motivoFinalizacion',
            'fechaTerminacion',
            'fechaFin',
            'fechaFinalizacion',
          ].includes(k)
        )

      if (soloEstado) {
        const estadoRaw = String(raw.estado ?? '').toLowerCase()
        if (!['activo', 'inactivo'].includes(estadoRaw)) {
          await trx.rollback()
          return response.badRequest({
            message: "Parámetro 'estado' inválido. Use 'activo' | 'inactivo'.",
          })
        }
        const nuevoEstado = estadoRaw as Estado

        if (nuevoEstado === 'inactivo') {
          const aliasFechaTerm =
            raw.fechaTerminacion ?? raw.fechaFin ?? raw.fechaFinalizacion ?? null
          const tipoEff: TipoContrato = contrato.tipoContrato as TipoContrato
          const incomingTerm =
            (contrato as any).terminoContrato === 'obra_o_labor'
              ? 'obra_o_labor_determinada'
              : (contrato as any).terminoContrato
          const terminoEff = incomingTerm ?? (tipoEff === 'laboral' ? 'indefinido' : null)

          const allowedByTipo: Record<TipoContrato, string[]> = {
            prestacion: ['fijo', 'obra_o_labor_determinada'],
            temporal: ['obra_o_labor_determinada'],
            laboral: ['fijo', 'obra_o_labor_determinada', 'indefinido'],
            aprendizaje: ['fijo'],
          }
          if (terminoEff && !allowedByTipo[tipoEff].includes(terminoEff)) {
            await trx.rollback()
            return response.badRequest({
              message: `'terminoContrato' inválido para tipo '${tipoEff}'.`,
            })
          }

          const requiereFin =
            tipoEff === 'prestacion' ||
            tipoEff === 'aprendizaje' ||
            tipoEff === 'temporal' ||
            (tipoEff === 'laboral' && (terminoEff ?? '').toLowerCase() !== 'indefinido')

          const fechaTermLuxon =
            this.toDateTime(aliasFechaTerm) ?? contrato.fechaTerminacion ?? null
          if (requiereFin && !fechaTermLuxon) {
            await trx.rollback()
            return response.badRequest({
              message: "La 'fechaTerminacion' es obligatoria para este contrato.",
            })
          }

          contrato.fechaTerminacion = fechaTermLuxon
          contrato.motivoFinalizacion =
            raw.motivoFinalizacion ?? contrato.motivoFinalizacion ?? null
        }

        contrato.estado = nuevoEstado
        await contrato.save()

        if (oldEstado !== nuevoEstado) {
          const fechaInicioHist = this.toDateTime(contrato.fechaInicio)
          await ContratoHistorialEstado.create(
            {
              contratoId: contrato.id,
              usuarioId: actorId ?? null,
              oldEstado,
              newEstado: nuevoEstado,
              fechaCambio: DateTime.now(),
              fechaInicioContrato: fechaInicioHist ?? null,
              motivo: nuevoEstado === 'inactivo' ? contrato.motivoFinalizacion : null,
            },
            { client: trx }
          )
        }

        await trx.commit()
        await this.syncUsuarioTrasGuardarContrato(contrato)
        await contrato.load((loader) => this.preloadRelations(loader))
        return response.ok(contrato)
      }

      // ---------- Flujo COMPLETO (edición de campos del contrato) ----------
      const currentSalario = await ContratoSalario.query({ client: trx })
        .where('contratoId', contrato.id)
        .orderBy('fecha_efectiva', 'desc')
        .first()

      const before = {
        razonSocialId: contrato.razonSocialId,
        sedeId: contrato.sedeId,
        cargoId: contrato.cargoId,
        funcionesCargo: contrato.funcionesCargo,
        tipoContrato: contrato.tipoContrato,
        terminoContrato: (contrato as any).terminoContrato ?? null,
        fechaInicio: this.toIsoDate(contrato.fechaInicio),
        fechaTerminacion: this.toIsoDate(contrato.fechaTerminacion),
        periodoPrueba: (contrato as any).periodoPrueba ?? null,
        horarioTrabajo: (contrato as any).horarioTrabajo ?? null,
        centroCosto: contrato.centroCosto ?? null,
        epsId: contrato.epsId ?? null,
        arlId: contrato.arlId ?? null,
        afpId: contrato.afpId ?? null,
        afcId: contrato.afcId ?? null,
        ccfId: contrato.ccfId ?? null,
        estado: contrato.estado,
        motivoFinalizacion: contrato.motivoFinalizacion ?? null,
        tieneRecomendacionesMedicas: this.toBoolOrNull(
          (contrato as any).tieneRecomendacionesMedicas
        ),
        salarioBasico: currentSalario?.salarioBasico ?? null,
        bonoSalarial: currentSalario?.bonoSalarial ?? null,
        auxilioTransporte: currentSalario?.auxilioTransporte ?? null,
        auxilioNoSalarial: currentSalario?.auxilioNoSalarial ?? null,
      }

      const payload = request.only([
        'identificacion',
        'sedeId',
        'cargoId',
        'funcionesCargo',
        'tipoContrato',
        'terminoContrato',
        'fechaInicio',
        'fechaTerminacion',
        'periodoPrueba',
        'horarioTrabajo',
        'centroCosto',
        'epsId',
        'arlId',
        'afpId',
        'afcId',
        'ccfId',
        'estado',
        'motivoFinalizacion',
        'salarioBasico',
        'bonoSalarial',
        'auxilioTransporte',
        'auxilioNoSalarial',
        'tieneRecomendacionesMedicas',
        'razonSocialId',
        'eliminarRecomendacionMedica',
      ])

      const aliasFechaTerm = raw.fechaTerminacion ?? raw.fechaFin ?? raw.fechaFinalizacion

      const tipoEff: TipoContrato =
        (payload.tipoContrato as TipoContrato) ?? (contrato.tipoContrato as TipoContrato)
      const allowedTipos: TipoContrato[] = ['prestacion', 'temporal', 'laboral', 'aprendizaje']
      if (!allowedTipos.includes(tipoEff)) {
        await trx.rollback()
        return response.badRequest({ message: "Valor inválido para 'tipoContrato'." })
      }

      // término
      const incomingTerm =
        (payload.terminoContrato ?? (contrato as any).terminoContrato) === 'obra_o_labor'
          ? 'obra_o_labor_determinada'
          : (payload.terminoContrato ?? (contrato as any).terminoContrato)
      let terminoEff: string | null = incomingTerm ?? null
      if (!terminoEff && tipoEff === 'laboral') {
        terminoEff = 'indefinido'
      }
      const allowedByTipo: Record<TipoContrato, string[]> = {
        prestacion: ['fijo', 'obra_o_labor_determinada'],
        temporal: ['obra_o_labor_determinada'],
        laboral: ['fijo', 'obra_o_labor_determinada', 'indefinido'],
        aprendizaje: ['fijo'],
      }
      if (terminoEff && !allowedByTipo[tipoEff].includes(terminoEff)) {
        await trx.rollback()
        return response.badRequest({
          message: `'terminoContrato' inválido para tipo '${tipoEff}'.`,
        })
      }

      // ✅ fechas - sin conversión UTC
      if (payload.fechaInicio !== undefined && typeof payload.fechaInicio === 'string') {
        contrato.fechaInicio = DateTime.fromFormat(payload.fechaInicio, 'yyyy-MM-dd').startOf('day')
      }
      if (aliasFechaTerm !== undefined && typeof aliasFechaTerm === 'string') {
        contrato.fechaTerminacion = DateTime.fromFormat(aliasFechaTerm, 'yyyy-MM-dd').startOf('day')
      }

      // ✅ Nueva forma: sin conversión UTC
      let fechaTermDef: DateTime | null = null
      if (aliasFechaTerm !== undefined) {
        if (typeof aliasFechaTerm === 'string') {
          fechaTermDef = DateTime.fromFormat(aliasFechaTerm, 'yyyy-MM-dd').startOf('day')
        } else {
          fechaTermDef = this.toDateTime(aliasFechaTerm)
        }
      } else {
        fechaTermDef = contrato.fechaTerminacion ?? null
      }

      const requiresEnd =
        tipoEff === 'prestacion' ||
        tipoEff === 'aprendizaje' ||
        tipoEff === 'temporal' ||
        (tipoEff === 'laboral' && (terminoEff ?? '').toLowerCase() !== 'indefinido')
      if (requiresEnd && !fechaTermDef) {
        await trx.rollback()
        return response.badRequest({
          message: "La 'fechaTerminacion' es obligatoria para el tipo/termino de contrato actual.",
        })
      }

      const {
        salarioBasico,
        bonoSalarial,
        auxilioTransporte,
        auxilioNoSalarial,
        ...contratoPayload
      } = payload
      ;(contratoPayload as any).terminoContrato = terminoEff

      contrato.merge(contratoPayload)
      await contrato.save()

      // Recomendación médica en UPDATE (borrar / mantener)
      const reqQuiereEliminarRec =
        String(raw.eliminarRecomendacionMedica ?? '').toLowerCase() === 'true'
      if (reqQuiereEliminarRec && contrato.rutaArchivoRecomendacionMedica) {
        try {
          await fs.unlink(
            path.join(app.publicPath(), contrato.rutaArchivoRecomendacionMedica.replace(/^\//, ''))
          )
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error('No se pudo eliminar recomendación (update):', e)
        }
        contrato.rutaArchivoRecomendacionMedica = null
        ;(contrato as any).tieneRecomendacionesMedicas = false
        await contrato.save()
      }
      if (!reqQuiereEliminarRec && contrato.rutaArchivoRecomendacionMedica) {
        ;(contrato as any).tieneRecomendacionesMedicas = true
        await contrato.save()
      }

      // Salarios
      const sbRaw = salarioBasico
      const bsRaw = bonoSalarial
      const atRaw = auxilioTransporte
      const ansRaw = auxilioNoSalarial

      const sbSent = Object.prototype.hasOwnProperty.call(raw, 'salarioBasico')
      const bsSent = Object.prototype.hasOwnProperty.call(raw, 'bonoSalarial')
      const atSent = Object.prototype.hasOwnProperty.call(raw, 'auxilioTransporte')
      const ansSent = Object.prototype.hasOwnProperty.call(raw, 'auxilioNoSalarial')

      const salarioFueEnviado = sbSent || bsSent || atSent || ansSent
      let nuevoSalario: {
        salarioBasico: number
        bonoSalarial: number
        auxilioTransporte: number
        auxilioNoSalarial: number
      } | null = null

      if (salarioFueEnviado) {
        const currentBase = currentSalario || {
          salarioBasico: contrato.salario ?? 0,
          bonoSalarial: 0,
          auxilioTransporte: 0,
          auxilioNoSalarial: 0,
        }
        const toNumberOr = (v: any, fallback: number) => {
          if (v === undefined || v === '' || v === null) return fallback
          const n = Number(v)
          return Number.isFinite(n) ? n : fallback
        }

        const nuevo = {
          salarioBasico: toNumberOr(sbRaw, currentBase.salarioBasico),
          bonoSalarial: toNumberOr(bsRaw, currentBase.bonoSalarial),
          auxilioTransporte: toNumberOr(atRaw, currentBase.auxilioTransporte),
          auxilioNoSalarial: toNumberOr(ansRaw, currentBase.auxilioNoSalarial),
        }

        const hayCambio =
          !currentSalario ||
          currentSalario.salarioBasico !== nuevo.salarioBasico ||
          currentSalario.bonoSalarial !== nuevo.bonoSalarial ||
          currentSalario.auxilioTransporte !== nuevo.auxilioTransporte ||
          currentSalario.auxilioNoSalarial !== nuevo.auxilioNoSalarial

        if (hayCambio) {
          nuevoSalario = nuevo
          if (currentSalario) {
            currentSalario.merge({ ...nuevo, fechaEfectiva: DateTime.now() })
            await currentSalario.save()
          } else {
            await ContratoSalario.create(
              { contratoId: contrato.id, ...nuevo, fechaEfectiva: DateTime.now() },
              { client: trx }
            )
          }

          if (sbSent) {
            contrato.salario = nuevo.salarioBasico
            await contrato.save()
          }
        }
      }

      // ======= Historial de estado =======
      if (oldEstado !== contrato.estado) {
        const fechaInicioHist = this.toDateTime(contrato.fechaInicio)
        await ContratoHistorialEstado.create({
          contratoId: contrato.id,
          usuarioId: actorId ?? null,
          oldEstado,
          newEstado: contrato.estado,
          fechaCambio: DateTime.now(),
          fechaInicioContrato: fechaInicioHist ?? null,
          motivo: contrato.estado === 'inactivo' ? contrato.motivoFinalizacion : null,
        })
      }

      // Cambios de tracking
      const after = {
        razonSocialId: contrato.razonSocialId,
        sedeId: contrato.sedeId,
        cargoId: contrato.cargoId,
        funcionesCargo: contrato.funcionesCargo,
        tipoContrato: contrato.tipoContrato,
        terminoContrato: (contrato as any).terminoContrato ?? null,
        fechaInicio: this.toIsoDate(contrato.fechaInicio),
        fechaTerminacion: this.toIsoDate(contrato.fechaTerminacion),
        periodoPrueba: (contrato as any).periodoPrueba ?? null,
        horarioTrabajo: (contrato as any).horarioTrabajo ?? null,
        centroCosto: contrato.centroCosto ?? null,
        epsId: contrato.epsId ?? null,
        arlId: contrato.arlId ?? null,
        afpId: contrato.afpId ?? null,
        afcId: contrato.afcId ?? null,
        ccfId: contrato.ccfId ?? null,
        estado: contrato.estado,
        motivoFinalizacion: contrato.motivoFinalizacion ?? null,
        tieneRecomendacionesMedicas: this.toBoolOrNull(
          (contrato as any).tieneRecomendacionesMedicas
        ),
        salarioBasico: nuevoSalario
          ? nuevoSalario.salarioBasico
          : (currentSalario?.salarioBasico ?? null),
        bonoSalarial: nuevoSalario
          ? nuevoSalario.bonoSalarial
          : (currentSalario?.bonoSalarial ?? null),
        auxilioTransporte: nuevoSalario
          ? nuevoSalario.auxilioTransporte
          : (currentSalario?.auxilioTransporte ?? null),
        auxilioNoSalarial: nuevoSalario
          ? nuevoSalario.auxilioNoSalarial
          : (currentSalario?.auxilioNoSalarial ?? null),
      }

      const camposTrackeables: (keyof typeof after)[] = [
        'razonSocialId',
        'sedeId',
        'cargoId',
        'funcionesCargo',
        'tipoContrato',
        'terminoContrato',
        'fechaInicio',
        'fechaTerminacion',
        'periodoPrueba',
        'horarioTrabajo',
        'centroCosto',
        'epsId',
        'arlId',
        'afpId',
        'afcId',
        'ccfId',
        'estado',
        'motivoFinalizacion',
        'tieneRecomendacionesMedicas',
        'salarioBasico',
        'bonoSalarial',
        'auxilioTransporte',
        'auxilioNoSalarial',
      ]

      const cambios: Array<{
        contratoId: number
        usuarioId: number | null
        campo: string
        oldValue: any
        newValue: any
      }> = []

      const vinoEnPayloadFor = (campo: string) => {
        if (campo === 'salarioBasico')
          return Object.prototype.hasOwnProperty.call(raw, 'salarioBasico')
        if (campo === 'bonoSalarial')
          return Object.prototype.hasOwnProperty.call(raw, 'bonoSalarial')
        if (campo === 'auxilioTransporte')
          return Object.prototype.hasOwnProperty.call(raw, 'auxilioTransporte')
        if (campo === 'auxilioNoSalarial')
          return Object.prototype.hasOwnProperty.call(raw, 'auxilioNoSalarial')
        if (campo === 'fechaTerminacion')
          return (
            Object.prototype.hasOwnProperty.call(raw, 'fechaTerminacion') ||
            Object.prototype.hasOwnProperty.call(raw, 'fechaFin') ||
            Object.prototype.hasOwnProperty.call(raw, 'fechaFinalizacion')
          )
        if (campo === 'tieneRecomendacionesMedicas')
          return Object.prototype.hasOwnProperty.call(raw, 'tieneRecomendacionesMedicas')
        return Object.prototype.hasOwnProperty.call(raw, campo)
      }

      const estadoSeVolvioInactivo = oldEstado !== contrato.estado && contrato.estado === 'inactivo'

      for (const campo of camposTrackeables) {
        if (
          estadoSeVolvioInactivo &&
          (campo === 'fechaTerminacion' || campo === 'motivoFinalizacion')
        ) {
          continue
        }

        if (!vinoEnPayloadFor(String(campo))) continue
        let oldV = (before as any)[campo]
        let newV = (after as any)[campo]
        if (campo === 'tieneRecomendacionesMedicas') {
          oldV = this.toBoolOrNull(oldV)
          newV = this.toBoolOrNull(newV)
        }
        if ((oldV ?? null) === (newV ?? null)) continue

        const oldWrapped = await this.wrapValueWithName(String(campo), oldV)
        const newWrapped = await this.wrapValueWithName(String(campo), newV)

        cambios.push({
          contratoId: contrato.id,
          usuarioId: actorId, // ← CORRECTO
          campo: String(campo),
          oldValue: this.json(oldWrapped),
          newValue: this.json(newWrapped),
        })
      }

      if (cambios.length > 0) await ContratoCambio.createMany(cambios)

      await trx.commit()
      await this.syncUsuarioTrasGuardarContrato(contrato)
      await contrato.load((loader) => this.preloadRelations(loader))
      return response.ok(contrato)
    } catch (error: any) {
      await trx.rollback()
      console.error('Error al actualizar contrato:', error)
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado para actualizar' })
      return response.internalServerError({
        message: 'Error al actualizar contrato',
        error: error.message,
      })
    }
  }
  /* =========================
     Actualizar SOLO archivo de recomendación (reemplazo) — sin extnames
  ========================= */
  public async updateRecomendacionMedica(ctx: HttpContext) {
    const { params, request, response } = ctx
    const trx = await db.transaction()
    try {
      const actorId = this.getActorId(ctx)
      const contrato = await Contrato.findOrFail(params.id)

      const archivoRecomendacion =
        request.file('archivo') ||
        request.file('archivoRecomendacionMedica') ||
        request.file('recomendacion')

      if (!archivoRecomendacion || !archivoRecomendacion.tmpPath) {
        throw new Error('Archivo de recomendación médica inválido.')
      }

      const recCT = this.getContentType(archivoRecomendacion).toLowerCase()
      const recExt = this.safeExtFrom(archivoRecomendacion, 'bin')
      const recMimeOk = !recCT || ContratosController.REC_ALLOWED_EXTS.has(recCT)
      const recExtOk = ContratosController.REC_ALLOWED_EXTS.has(recExt)
      if (!(recMimeOk || recExtOk)) {
        throw new Error(
          'Tipo de archivo de recomendación no permitido. Use pdf, doc, docx, jpg, jpeg, png, webp.'
        )
      }

      const oldMeta = this.fileMetaFromRelPath(contrato.rutaArchivoRecomendacionMedica)

      if (contrato.rutaArchivoRecomendacionMedica) {
        try {
          await fs.unlink(
            path.join(app.publicPath(), contrato.rutaArchivoRecomendacionMedica.replace(/^\//, ''))
          )
        } catch (e: any) {
          if (e.code !== 'ENOENT')
            console.error('Error al eliminar archivo de recomendación anterior en update:', e)
        }
      }

      const recDir = 'uploads/recomendaciones_medicas'
      const recExtFinal = recExtOk ? recExt : (mime.extension(recCT) as string) || 'bin'
      const recName = `${cuid()}.${recExtFinal}`
      const recDest = path.join(app.publicPath(), recDir)
      await fs.mkdir(recDest, { recursive: true })
      await archivoRecomendacion.move(recDest, { name: recName })

      contrato.tieneRecomendacionesMedicas = true
      contrato.rutaArchivoRecomendacionMedica = `/${recDir}/${recName}`
      await contrato.save()

      if (oldMeta) {
        await this.logArchivoReemplazado(
          contrato,
          oldMeta,
          { nombre: recName, url: `/${recDir}/${recName}` },
          actorId
        )
      } else {
        await this.logArchivoSubido(contrato, recName, `/${recDir}/${recName}`, actorId)
      }

      await trx.commit()
      await contrato.load((loader) => this.preloadRelations(loader))
      return response.ok(contrato)
    } catch (error: any) {
      await trx.rollback()
      console.error('Error al actualizar el archivo de recomendación médica:', error)
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      return response.internalServerError({
        message: 'Error al actualizar el archivo de recomendación médica',
        error: error.message,
      })
    }
  }

  /* =========================
     DELETE contrato
  ========================= */
  public async destroy(ctx: HttpContext) {
    const { params, response } = ctx
    try {
      const contrato = await Contrato.findOrFail(params.id)
      await contrato.delete()
      return response.ok({ message: 'Contrato eliminado correctamente' })
    } catch (error: any) {
      console.error('Error al eliminar contrato:', error)
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado para eliminar' })
      return response.internalServerError({
        message: 'Error al eliminar contrato',
        error: error.message,
      })
    }
  }

  /* =========================
     PASOS: subir archivo (sin extnames)
  ========================= */
  public async uploadRecomendacionMedica(ctx: HttpContext) {
    const { params, request, response } = ctx
    try {
      const paso = await ContratoPaso.query().where('id', params.pasoId).firstOrFail()

      const archivo = request.file('archivo') || request.file('recomendacion')

      if (!archivo || !archivo.tmpPath) {
        throw new Error('Archivo de recomendación inválido.')
      }

      const ct = this.getContentType(archivo).toLowerCase()
      const ext = this.safeExtFrom(archivo, 'bin')
      const mimeOk = !ct || ContratosController.REC_ALLOWED_EXTS.has(ct) // reutilizamos set de recomendación
      const extOk = ContratosController.REC_ALLOWED_EXTS.has(ext)
      if (!(mimeOk || extOk)) {
        throw new Error('Tipo de archivo no permitido. Use pdf, doc, docx, jpg, jpeg, png, webp.')
      }

      if (paso.archivoUrl) {
        try {
          await fs.unlink(path.join(app.publicPath(), paso.archivoUrl.replace(/^\//, '')))
        } catch (unlinkError: any) {
          if (unlinkError.code !== 'ENOENT')
            console.error('Error al eliminar archivo anterior del paso:', unlinkError)
        }
      }

      const uploadDir = `uploads/pasos/${paso.contratoId}`
      const fileName = `${cuid()}.${extOk ? ext : (mime.extension(ct) as string) || 'bin'}`
      const publicPathDir = path.join(app.publicPath(), uploadDir)
      await fs.mkdir(publicPathDir, { recursive: true })

      await archivo.move(publicPathDir, { name: fileName })
      ;(paso as any).nombreArchivo = archivo.clientName || fileName
      paso.archivoUrl = `/${uploadDir}/${fileName}`

      await paso.save()

      return response.ok(paso)
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Paso de contrato no encontrado.' })
      console.error('Error al subir recomendación (paso):', error)
      return response.internalServerError({
        message: 'Error al subir recomendación',
        error: error.message,
      })
    }
  }

  /* =========================
     SALARIOS
  ========================= */
  public async storeSalario(ctx: HttpContext) {
    return this.createSalario(ctx)
  }

  public async listSalarios(ctx: HttpContext) {
    const { params, response } = ctx
    try {
      const salarios = await ContratoSalario.query()
        .where('contratoId', params.contratoId)
        .orderBy('fecha_efectiva', 'desc')

      return response.ok(salarios)
    } catch (error: any) {
      console.error('Error al listar salarios:', error)
      return response.internalServerError({
        message: 'Error al listar salarios',
        error: error.message,
      })
    }
  }

  public async createSalario(ctx: HttpContext) {
    const { params, request, response } = ctx
    try {
      const contrato = await Contrato.findOrFail(params.contratoId)

      const {
        salarioBasico = 0,
        bonoSalarial = 0,
        auxilioTransporte = 0,
        auxilioNoSalarial = 0,
        fechaEfectiva,
      } = request.only([
        'salarioBasico',
        'bonoSalarial',
        'auxilioTransporte',
        'auxilioNoSalarial',
        'fechaEfectiva',
      ])

      const baseNum = Number(salarioBasico)
      if (!Number.isFinite(baseNum)) {
        return response.badRequest({
          message: "El campo 'salarioBasico' es obligatorio y debe ser numérico.",
        })
      }

      const fecha = fechaEfectiva ? DateTime.fromISO(fechaEfectiva) : DateTime.now()

      const registro = await ContratoSalario.create({
        contratoId: contrato.id,
        salarioBasico: baseNum,
        bonoSalarial: Number(bonoSalarial) || 0,
        auxilioTransporte: Number(auxilioTransporte) || 0,
        auxilioNoSalarial: Number(auxilioNoSalarial) || 0,
        fechaEfectiva: fecha,
      })

      contrato.salario = baseNum
      await contrato.save()

      return response.created(registro)
    } catch (error: any) {
      console.error('Error al crear salario:', error)
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      return response.badRequest({ message: error.message || 'Error al crear salario' })
    }
  }

  /* =========================
     DESCARGA / META / DELETE de archivo contrato físico
  ========================= */
  public async descargarArchivo({ params, response, request }: HttpContext) {
    const contrato = await Contrato.findOrFail(params.id)

    const relativo = contrato.rutaArchivoContratoFisico
    if (!relativo) {
      return response.notFound({ message: 'Contrato sin archivo' })
    }

    const absPath = path.join(app.publicPath(), relativo.replace(/^\//, ''))
    if (!existsSync(absPath)) {
      return response.notFound({ message: 'Archivo no existe' })
    }

    const st = statSync(absPath)
    const contentType = (mime.lookup(absPath) as string) || 'application/octet-stream'
    const fileName = path.basename(absPath)

    const inlineRaw = String(
      request.input('inline') ?? (request.qs() as any)?.inline ?? ''
    ).toLowerCase()
    const viewInline = ['1', 'true', 'inline', 'si', 'sí'].includes(inlineRaw)

    response.header('Content-Type', contentType)
    response.header('Content-Length', String(st.size))
    response.header(
      'Content-Disposition',
      `${viewInline ? 'inline' : 'attachment'}; filename="${fileName}"`
    )

    return response.stream(createReadStream(absPath))
  }

  public async getArchivoContratoMeta({ params, response }: HttpContext) {
    try {
      const contrato = await Contrato.findOrFail(params.id)

      const relativo = contrato.rutaArchivoContratoFisico || null
      if (!relativo) {
        return response.ok({ contratoId: contrato.id, tieneArchivo: false, data: null })
      }

      const absPath = path.join(app.publicPath(), relativo.replace(/^\//, ''))
      if (!existsSync(absPath)) {
        contrato.merge({ rutaArchivoContratoFisico: null, nombreArchivoContratoFisico: null })
        await contrato.save()
        return response.ok({ contratoId: contrato.id, tieneArchivo: false, data: null })
      }

      const st = statSync(absPath)
      const fileName = path.basename(absPath)
      const contentType = (mime.lookup(absPath) as string) || 'application/pdf'

      return response.ok({
        contratoId: contrato.id,
        tieneArchivo: true,
        data: { url: relativo, nombreOriginal: fileName, mime: contentType, size: st.size },
      })
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      console.error('Error al obtener meta del archivo de contrato:', error)
      return response.internalServerError({
        message: 'Error al obtener meta del archivo de contrato',
        error: error.message,
      })
    }
  }

  public async eliminarArchivoContrato({ params, response, request }: HttpContext) {
    try {
      const actorId = this.getActorId({ request } as any)
      const contrato = await Contrato.findOrFail(params.id)

      const rel = contrato.rutaArchivoContratoFisico
      const old = this.fileMetaFromRelPath(rel)

      if (!rel) {
        return response.ok({ message: 'El contrato no tiene archivo para eliminar.' })
      }

      try {
        await fs.unlink(path.join(app.publicPath(), rel.replace(/^\//, '')))
      } catch (e: any) {
        if (e.code !== 'ENOENT') console.error('No se pudo eliminar archivo del contrato:', e)
      }

      contrato.merge({ rutaArchivoContratoFisico: null, nombreArchivoContratoFisico: null })
      await contrato.save()

      await this.logContratoFisicoCambio(contrato, old, null, actorId)
      await this.logContratoFisicoObservacion(
        contrato,
        String(request.input('observacionArchivo') ?? ''),
        actorId
      )

      return response.ok({ message: 'Archivo del contrato eliminado.' })
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      console.error('Error al eliminar archivo del contrato:', error)
      return response.internalServerError({
        message: 'Error al eliminar archivo del contrato',
        error: error.message,
      })
    }
  }

  /* ==========================================================
     Recomendación Médica por Contrato (CRUD de archivo) — sin extnames
  ========================================================== */
  public async getRecomendacionMedicaMeta({ params, response }: HttpContext) {
    try {
      const contrato = await Contrato.findOrFail(params.id)

      const relativo = contrato.rutaArchivoRecomendacionMedica || null
      if (!relativo) {
        return response.ok({ contratoId: contrato.id, tieneArchivo: false, data: null })
      }

      const absPath = path.join(app.publicPath(), relativo.replace(/^\//, ''))
      if (!existsSync(absPath)) {
        contrato.merge({ rutaArchivoRecomendacionMedica: null })
        await contrato.save()
        return response.ok({ contratoId: contrato.id, tieneArchivo: false, data: null })
      }

      const st = statSync(absPath)
      const fileName = path.basename(absPath)
      const contentType = (mime.lookup(absPath) as string) || 'application/octet-stream'

      return response.ok({
        contratoId: contrato.id,
        tieneArchivo: true,
        data: { url: relativo, nombreOriginal: fileName, mime: contentType, size: st.size },
      })
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      console.error('Error al obtener meta de recomendación médica:', error)
      return response.internalServerError({
        message: 'Error al obtener meta de recomendación médica',
        error: error.message,
      })
    }
  }

  public async subirRecomendacionMedica({ params, request, response }: HttpContext) {
    try {
      const actorId = this.getActorId({ request } as any)
      const contrato = await Contrato.findOrFail(params.id)

      const archivo =
        request.file('archivo') ||
        request.file('archivoRecomendacionMedica') ||
        request.file('recomendacion')

      if (!archivo || !archivo.tmpPath) {
        return response.badRequest({
          message: 'Archivo de recomendación inválido o no adjunto.',
        })
      }

      const recCT = this.getContentType(archivo).toLowerCase()
      const recExt = this.safeExtFrom(archivo, 'bin')
      const recMimeOk = !recCT || ContratosController.REC_ALLOWED_EXTS.has(recCT)
      const recExtOk = ContratosController.REC_ALLOWED_EXTS.has(recExt)
      if (!(recMimeOk || recExtOk)) {
        return response.badRequest({
          message:
            'Tipo de archivo de recomendación no permitido. Use pdf, doc, docx, jpg, jpeg, png, webp.',
        })
      }

      const oldMeta = this.fileMetaFromRelPath(contrato.rutaArchivoRecomendacionMedica)

      if (contrato.rutaArchivoRecomendacionMedica) {
        try {
          await fs.unlink(
            path.join(app.publicPath(), contrato.rutaArchivoRecomendacionMedica.replace(/^\//, ''))
          )
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error('No se pudo eliminar recomendación anterior:', e)
        }
      }

      const dir = 'uploads/recomendaciones_medicas'
      const finalExt = recExtOk ? recExt : (mime.extension(recCT) as string) || 'bin'
      const name = `${cuid()}.${finalExt}`
      const absDir = path.join(app.publicPath(), dir)
      await fs.mkdir(absDir, { recursive: true })
      await archivo.move(absDir, { name })

      contrato.merge({
        tieneRecomendacionesMedicas: true,
        rutaArchivoRecomendacionMedica: `/${dir}/${name}`,
      })
      await contrato.save()

      if (oldMeta) {
        await this.logArchivoReemplazado(
          contrato,
          oldMeta,
          { nombre: name, url: `/${dir}/${name}` },
          actorId
        )
      } else {
        await this.logArchivoSubido(contrato, name, `/${dir}/${name}`, actorId)
      }

      const absPath = path.join(absDir, name)
      const st = statSync(absPath)
      const contentType = (mime.lookup(absPath) as string) || 'application/octet-stream'

      return response.ok({
        contratoId: contrato.id,
        tieneArchivo: true,
        data: { url: `/${dir}/${name}`, nombreOriginal: name, mime: contentType, size: st.size },
      })
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      console.error('Error al subir recomendación médica:', error)
      return response.internalServerError({
        message: 'Error al subir recomendación médica',
        error: error.message,
      })
    }
  }

  public async eliminarRecomendacionMedica({ params, response, request }: HttpContext) {
    try {
      const actorId = this.getActorId({ request } as any)
      const contrato = await Contrato.findOrFail(params.id)

      const oldMeta = this.fileMetaFromRelPath(contrato.rutaArchivoRecomendacionMedica)

      if (contrato.rutaArchivoRecomendacionMedica) {
        try {
          await fs.unlink(
            path.join(app.publicPath(), contrato.rutaArchivoRecomendacionMedica.replace(/^\//, ''))
          )
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error('No se pudo eliminar archivo de recomendación:', e)
        }
      }

      contrato.merge({
        rutaArchivoRecomendacionMedica: null,
        tieneRecomendacionesMedicas: false,
      })
      await contrato.save()

      await this.logArchivoEliminado(contrato, oldMeta, actorId)

      return response.ok({ message: 'Archivo de recomendación médica eliminado.' })
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      console.error('Error al eliminar recomendación médica:', error)
      return response.internalServerError({
        message: 'Error al eliminar recomendación médica',
        error: error.message,
      })
    }
  }

  public async descargarRecomendacionMedica({ params, response }: HttpContext) {
    try {
      const contrato = await Contrato.findOrFail(params.id)
      const relativo = contrato.rutaArchivoRecomendacionMedica
      if (!relativo) {
        return response.notFound({
          message: 'El contrato no tiene archivo de recomendación médica.',
        })
      }

      const absPath = path.join(app.publicPath(), relativo.replace(/^\//, ''))
      if (!existsSync(absPath)) {
        return response.notFound({ message: 'Archivo de recomendación no existe' })
      }

      const st = statSync(absPath)
      const contentType = (mime.lookup(absPath) as string) || 'application/octet-stream'
      const fileName = path.basename(absPath)

      response.header('Content-Type', contentType)
      response.header('Content-Length', String(st.size))
      response.header('Content-Disposition', `attachment; filename="${fileName}"`)

      return response.stream(createReadStream(absPath))
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      console.error('Error al descargar recomendación médica:', error)
      return response.internalServerError({
        message: 'Error al descargar recomendación médica',
        error: error.message,
      })
    }
  }

  /* ==========================================================
     Archivos por Afiliación (CONTRATO) - META / SUBIR / ELIMINAR
  ========================================================== */
  public async getAfiliacionArchivo({ params, response }: HttpContext) {
    try {
      const contrato = await Contrato.findOrFail(params.id)
      const tipo = String(params.tipo || '').toLowerCase() as any
      if (!ContratosController.TIPOS_AFILIACION.includes(tipo)) {
        return response.badRequest({ message: 'Tipo de afiliación inválido.' })
      }

      const c = this.camposAfiContrato(tipo)
      const rel = (contrato as any)[c.path] as string | null
      if (!rel)
        return response.ok({ contratoId: contrato.id, tipo, tieneArchivo: false, data: null })

      const absPath = path.join(app.publicPath(), rel.replace(/^\//, ''))
      if (!existsSync(absPath)) {
        contrato.merge({
          [c.path]: null,
          [c.nombre]: null,
          [c.mime]: null,
          [c.size]: null,
        } as any)
        await contrato.save()
        return response.ok({ contratoId: contrato.id, tipo, tieneArchivo: false, data: null })
      }

      const st = statSync(absPath)
      const fileName = path.basename(absPath)
      const contentType = (mime.lookup(absPath) as string) || 'application/octet-stream'

      return response.ok({
        contratoId: contrato.id,
        tipo,
        tieneArchivo: true,
        data: { url: rel, nombreOriginal: fileName, mime: contentType, size: st.size },
      })
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      console.error('Error meta afiliación:', error)
      return response.internalServerError({
        message: 'Error al obtener meta de afiliación',
        error: error.message,
      })
    }
  }

  public async subirAfiliacionArchivo({ params, request, response }: HttpContext) {
    try {
      const actorId = this.getActorId({ request } as any)
      const contrato = await Contrato.findOrFail(params.id)
      const tipo = String(params.tipo || '').toLowerCase() as any
      if (!ContratosController.TIPOS_AFILIACION.includes(tipo)) {
        return response.badRequest({ message: 'Tipo de afiliación inválido.' })
      }

      const archivo = request.file('archivo')
      if (!archivo || !archivo.isValid || !archivo.tmpPath || !archivo.clientName) {
        return response.badRequest({ message: 'Archivo inválido o no enviado.' })
      }

      const contentType =
        archivo.type && archivo.subtype
          ? `${archivo.type}/${archivo.subtype}`
          : (archivo.headers?.['content-type'] as string) || ''
      if (!ContratosController.AFI_ALLOWED_MIMES.has(contentType)) {
        return response.badRequest({ message: 'Tipo de archivo no permitido.' })
      }

      const c = this.camposAfiContrato(tipo)
      const dir = path.join(app.publicPath(), c.dir, String(contrato.id))
      await fs.mkdir(dir, { recursive: true })

      const old = this.fileMetaFromRelPath((contrato as any)[c.path])

      if ((contrato as any)[c.path]) {
        try {
          await fs.unlink(
            path.join(app.publicPath(), String((contrato as any)[c.path]).replace(/^\//, ''))
          )
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error('No se pudo eliminar archivo anterior:', e)
        }
      }

      const name = `${cuid()}_${archivo.clientName}`
      await archivo.move(dir, { name })
      const rel = `${c.dir}/${contrato.id}/${name}`
      const st = statSync(path.join(dir, name))

      ;(contrato as any)[c.path] = `/${rel}`
      ;(contrato as any)[c.nombre] = archivo.clientName
      ;(contrato as any)[c.mime] = contentType
      ;(contrato as any)[c.size] = Number(st.size)
      await contrato.save()

      await this.logCambioArchivo(
        contrato,
        `${tipo}_afiliacion_archivo`,
        old,
        { nombre: name, url: `/${rel}` },
        actorId
      )

      return response.created({
        contratoId: contrato.id,
        tipo,
        tieneArchivo: true,
        data: {
          url: `/${rel}`,
          nombreOriginal: archivo.clientName,
          mime: contentType,
          size: st.size,
        },
      })
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      console.error('Error subir afiliación:', error)
      return response.internalServerError({
        message: 'Error al subir archivo de afiliación',
        error: error.message,
      })
    }
  }

  public async eliminarAfiliacionArchivo({ params, response, request }: HttpContext) {
    try {
      const actorId = this.getActorId({ request } as any)
      const contrato = await Contrato.findOrFail(params.id)
      const tipo = String(params.tipo || '').toLowerCase() as any
      if (!ContratosController.TIPOS_AFILIACION.includes(tipo)) {
        return response.badRequest({ message: 'Tipo de afiliación inválido.' })
      }

      const c = this.camposAfiContrato(tipo)
      const rel = (contrato as any)[c.path] as string | null
      const old = this.fileMetaFromRelPath(rel)

      if (rel) {
        try {
          await fs.unlink(path.join(app.publicPath(), rel.replace(/^\//, '')))
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error('No se pudo eliminar archivo:', e)
        }
      }

      ;(contrato as any)[c.path] = null
      ;(contrato as any)[c.nombre] = null
      ;(contrato as any)[c.mime] = null
      ;(contrato as any)[c.size] = null
      await contrato.save()

      await this.logCambioArchivo(contrato, `${tipo}_afiliacion_archivo`, old, null, actorId)

      return response.ok({ message: `Archivo de ${tipo.toUpperCase()} eliminado.` })
    } catch (error: any) {
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Contrato no encontrado' })
      console.error('Error eliminar afiliación:', error)
      return response.internalServerError({
        message: 'Error al eliminar archivo de afiliación',
        error: error.message,
      })
    }
  }
}
