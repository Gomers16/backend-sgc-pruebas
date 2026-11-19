// app/controllers/usuarios_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { cuid } from '@adonisjs/core/helpers'
import fs from 'node:fs/promises'
import path from 'node:path'

// Modelos
import Usuario from '#models/usuario'
import Rol from '#models/rol'
import RazonSocial from '#models/razon_social'
import Sede from '#models/sede'
import Cargo from '#models/cargo'
import EntidadSalud from '#models/entidad_salud'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import { normalizarId, validarGestionUsuario } from '#services/usuario_permisos_service'

/** Campos a seleccionar cuando se precarga el usuario actor */
const USER_SELECT = ['id', 'nombres', 'apellidos', 'correo'] as const

/** Helper para precargar TODO lo necesario en Usuario (evita duplicar lógica) */
function preloadUsuarioCompleto(loader: any) {
  loader
    .preload('rol')
    .preload('razonSocial')
    .preload('sede')
    .preload('cargo')
    .preload('eps')
    .preload('arl')
    .preload('afp')
    .preload('afc')
    .preload('ccf')
    .preload('contratos', (contractQuery: any) => {
      contractQuery
        .orderBy('fecha_inicio', 'desc')
        .preload('cargo')
        .preload('sede')
        .preload('eps')
        .preload('arl')
        .preload('afp')
        .preload('afc')
        .preload('ccf')
        .preload('eventos', (ev: any) => {
          ev.preload('usuario', (u: any) => u.select(USER_SELECT))
          ev.orderBy('created_at', 'desc')
        })
        .preload('pasos', (p: any) => {
          p.orderBy('created_at', 'desc')
          p.preload('usuario', (u: any) => u.select(USER_SELECT))
        })
        .preload('historialEstados', (historialQuery: any) => {
          historialQuery.orderBy('fecha_cambio', 'desc').preload('usuario')
        })
        .preload('cambios', (c: any) => {
          c.preload('usuario').orderBy('created_at', 'desc')
        })
    })
}

export default class UsuariosController {
  /**
   * Multi-sede Fase 0: aplica las reglas de usuario_permisos_service.
   * Resuelve el actor (rol + sede) y valida que rolId/sedeId existan.
   * Devuelve el resultado del guard o una respuesta de error ya enviada.
   */
  private async autorizarGestion(
    ctx: HttpContext,
    objetivo: Usuario | null,
    payload: { rolId?: unknown; sedeId?: unknown }
  ): Promise<{ ok: true; sedeId: number | null } | { ok: false }> {
    const { auth, response } = ctx
    const actor = auth.user!
    await actor.load('rol')

    const rolIdNuevo = normalizarId(payload.rolId)
    const sedeIdNueva = normalizarId(payload.sedeId)
    if (Number.isNaN(rolIdNuevo) || Number.isNaN(sedeIdNueva)) {
      response.unprocessableEntity({ message: 'rolId o sedeId inválido.' })
      return { ok: false }
    }

    let rolNuevo: string | null | undefined
    if (rolIdNuevo !== undefined && rolIdNuevo !== null) {
      const rol = await Rol.find(rolIdNuevo)
      if (!rol) {
        response.unprocessableEntity({ message: `El rol ${rolIdNuevo} no existe.` })
        return { ok: false }
      }
      rolNuevo = rol.nombre
    } else if (rolIdNuevo === null) {
      rolNuevo = null
    }

    if (sedeIdNueva !== undefined && sedeIdNueva !== null) {
      const sede = await Sede.find(sedeIdNueva)
      if (!sede) {
        response.unprocessableEntity({ message: `La sede ${sedeIdNueva} no existe.` })
        return { ok: false }
      }
    }

    if (objetivo) await objetivo.load('rol')
    const res = validarGestionUsuario(
      { rol: actor.rol?.nombre ?? null, sedeId: actor.sedeId ?? null },
      objetivo ? { rol: objetivo.rol?.nombre ?? null, sedeId: objetivo.sedeId ?? null } : null,
      { rol: rolNuevo, sedeId: sedeIdNueva as number | null | undefined }
    )
    if (!res.ok) {
      response.status(res.status).send({ message: res.message })
      return { ok: false }
    }
    return res
  }

  /**
   * ✅ Sincroniza agente con usuario (evita duplicados y protege tipos existentes)
   */
  private async syncAgenteConUsuario(user: Usuario) {
    try {
      // Determinar si el usuario debe tener agente
      const rol = await Rol.find(user.rolId)
      if (!rol) return

      const nombreRol = (rol.nombre || '').toUpperCase().trim()

      type TipoAsesor = 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'ASESOR_TELEMERCADEO'
      let tipo: TipoAsesor | null = null

      if (nombreRol === 'COMERCIAL' || nombreRol.includes('ASESOR COMERCIAL')) {
        tipo = 'ASESOR_COMERCIAL'
      } else if (nombreRol.includes('ASESOR CONVENIO')) {
        tipo = 'ASESOR_CONVENIO'
      } else if (nombreRol.includes('TELEMERCADEO') || nombreRol.includes('TELEMARKETING')) {
        tipo = 'ASESOR_TELEMERCADEO'
      }

      // Si el rol no requiere agente, no hacer nada
      if (!tipo) {
        console.log(`✅ Usuario ${user.id} no requiere agente (rol: ${nombreRol})`)
        return
      }

      // 🛡️ PROTECCIÓN MEJORADA: Buscar agente existente por usuarioId O por agenteId
      let agenteExistente: AgenteCaptacion | null = null

      // Opción 1: Buscar por usuarioId (debería estar siempre)
      agenteExistente = await AgenteCaptacion.query().where('usuario_id', user.id).first()

      // Opción 2: Si tiene agenteId pero no encontramos por usuarioId (datos inconsistentes)
      if (!agenteExistente && user.agenteId) {
        agenteExistente = await AgenteCaptacion.find(user.agenteId)
      }

      // Opción 3: Buscar por nombre exacto — evita crear duplicados cuando ya existe
      // un agente con ese nombre (ej: convenio creado manualmente sin usuario)
      if (!agenteExistente) {
        const nombreCompleto = `${user.nombres} ${user.apellidos}`.trim()
        const porNombre = await AgenteCaptacion.query()
          .whereRaw('TRIM(nombre) = ?', [nombreCompleto])
          .first()
        if (porNombre) {
          console.warn(
            `⚠️ Ya existe un agente con el nombre "${nombreCompleto}" (ID: ${porNombre.id}, Tipo: ${porNombre.tipo}). No se crea duplicado.`
          )
          return
        }
      }

      // Si existe y es de tipo diferente, NO sobrescribir
      if (agenteExistente && agenteExistente.tipo !== tipo) {
        console.warn(
          `⚠️ Usuario ${user.id} tiene agente tipo ${agenteExistente.tipo} pero rol indica ${tipo}. NO se sobrescribe.`
        )

        // Solo actualizar datos básicos
        agenteExistente.nombre = `${user.nombres} ${user.apellidos}`.trim()
        agenteExistente.telefono = user.celularPersonal
          ? String(user.celularPersonal).replace(/\D/g, '')
          : null
        agenteExistente.activo = user.estado === 'activo'

        // 🔧 ARREGLAR relación si no existe
        if (!agenteExistente.usuarioId) {
          agenteExistente.usuarioId = user.id
        }

        await agenteExistente.save()

        // 🔥 Si es ASESOR_CONVENIO, actualizar el convenio asociado
        if (agenteExistente.tipo === 'ASESOR_CONVENIO') {
          await this.actualizarConvenioDeAsesor(agenteExistente)
        }

        // Sincronizar relación bidireccional
        if (user.agenteId !== agenteExistente.id) {
          user.agenteId = agenteExistente.id
          await user.save()
        }

        console.log(
          `✅ Agente actualizado (sin cambio de tipo): ${agenteExistente.nombre} (ID: ${agenteExistente.id}, Tipo: ${agenteExistente.tipo})`
        )
        return
      }

      // ✅ Crear o actualizar con tipo correcto
      const nombreCompleto = `${user.nombres} ${user.apellidos}`.trim()
      const telefono = user.celularPersonal ? String(user.celularPersonal).replace(/\D/g, '') : null

      const agente = await AgenteCaptacion.updateOrCreate(
        { usuarioId: user.id },
        {
          tipo,
          nombre: nombreCompleto,
          telefono,
          activo: user.estado === 'activo',
        }
      )

      // 🔥 Si es ASESOR_CONVENIO, actualizar el convenio asociado
      if (agente.tipo === 'ASESOR_CONVENIO') {
        await this.actualizarConvenioDeAsesor(agente)
      }

      // Sincronizar relación bidireccional
      if (user.agenteId !== agente.id) {
        user.agenteId = agente.id
        await user.save()
      }

      console.log(`✅ Agente sincronizado: ${agente.nombre} (ID: ${agente.id}, Tipo: ${tipo})`)
    } catch (error: any) {
      console.error('[ERROR] No se pudo sincronizar agente con usuario:', error.message)
    }
  }

  /**
   * 🔥 Actualiza el convenio asociado al asesor convenio
   */
  private async actualizarConvenioDeAsesor(agente: AgenteCaptacion) {
    try {
      // Buscar convenio donde asesor_convenio_id = agente.id
      const convenio = await Convenio.query().where('asesor_convenio_id', agente.id).first()

      if (convenio) {
        // Actualizar nombre del convenio para que coincida con el agente
        convenio.nombre = agente.nombre
        await convenio.save()

        console.log(`✅ Convenio ${convenio.id} actualizado con nombre: ${agente.nombre}`)
      } else {
        console.warn(`⚠️ No se encontró convenio para asesor convenio ${agente.id}`)
      }
    } catch (error: any) {
      console.error('[ERROR] No se pudo actualizar convenio:', error.message)
    }
  }

  /** Lista de usuarios (opcionalmente filtrados por razón social) */
  public async index({ request, response }: HttpContext) {
    try {
      const razonSocialId = request.input('razon_social_id')

      const query = Usuario.query()
        .preload('rol')
        .preload('razonSocial')
        .preload('sede')
        .preload('cargo')
        .preload('eps')
        .preload('arl')
        .preload('afp')
        .preload('afc')
        .preload('ccf')
        .preload('contratos', (contractQuery: any) => {
          contractQuery
            .orderBy('fecha_inicio', 'desc')
            .preload('cargo')
            .preload('sede')
            .preload('eps')
            .preload('arl')
            .preload('afp')
            .preload('afc')
            .preload('ccf')
            .preload('eventos', (ev: any) => {
              ev.preload('usuario', (u: any) => u.select(...USER_SELECT))
              ev.orderBy('created_at', 'desc')
            })
            .preload('pasos', (p: any) => {
              p.orderBy('created_at', 'desc')
              p.preload('usuario', (u: any) => u.select(...USER_SELECT))
            })
            .preload('historialEstados', (historialQuery: any) => {
              historialQuery.orderBy('fecha_cambio', 'desc').preload('usuario')
            })
            .preload('cambios', (c: any) => {
              c.preload('usuario').orderBy('created_at', 'desc')
            })
        })

      if (razonSocialId) query.where('razon_social_id', razonSocialId)

      const users = await query.orderBy('id', 'asc')
      return response.ok(users)
    } catch (error: any) {
      console.error('Error al obtener usuarios:', error)
      return response.internalServerError({
        message: 'Error al obtener usuarios',
        error: error.message,
      })
    }
  }

  /** Usuario por ID (con contratos y relaciones completas) */
  public async show({ params, response }: HttpContext) {
    try {
      const usuario = await Usuario.query()
        .where('id', params.id)
        .preload('rol')
        .preload('razonSocial')
        .preload('sede')
        .preload('cargo')
        .preload('eps')
        .preload('arl')
        .preload('afp')
        .preload('afc')
        .preload('ccf')
        .preload('contratos', (contractQuery: any) => {
          contractQuery
            .orderBy('fecha_inicio', 'desc')
            .preload('cargo')
            .preload('sede')
            .preload('eps')
            .preload('arl')
            .preload('afp')
            .preload('afc')
            .preload('ccf')
            .preload('eventos', (ev: any) => {
              ev.preload('usuario', (u: any) => u.select(...USER_SELECT))
              ev.orderBy('created_at', 'desc')
            })
            .preload('pasos', (p: any) => {
              p.orderBy('created_at', 'desc')
              p.preload('usuario', (u: any) => u.select(...USER_SELECT))
            })
            .preload('historialEstados', (historialQuery: any) => {
              historialQuery.orderBy('fecha_cambio', 'desc').preload('usuario')
            })
            .preload('cambios', (c: any) => {
              c.preload('usuario').orderBy('created_at', 'desc')
            })
        })
        .firstOrFail()

      return response.ok(usuario)
    } catch (error: any) {
      console.error('Error al obtener usuario por ID:', error)
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Usuario no encontrado' })
      return response.internalServerError({
        message: 'Error al obtener usuario',
        error: error.message,
      })
    }
  }

  /** Crear usuario */
  public async store(ctx: HttpContext) {
    const { request, response } = ctx
    const payload = request.only([
      'nombres',
      'apellidos',
      'correo',
      'correoPersonal',
      'password',
      'rolId',
      'razonSocialId',
      'sedeId',
      'cargoId',
      'fotoPerfil',
      'direccion',
      'celularPersonal',
      'celularCorporativo',
      'centroCosto',
      'estado',
      'recomendaciones',
      'epsId',
      'arlId',
      'afpId',
      'afcId',
      'ccfId',
      'tipoSangre',
      'contactoEmergenciaNombre',
      'contactoEmergenciaTelefono',
    ])

    const permiso = await this.autorizarGestion(ctx, null, payload)
    if (!permiso.ok) return

    try {
      const user = await Usuario.create({
        ...payload,
        sedeId: permiso.sedeId ?? undefined,
        cargoId: payload.cargoId ?? null,
        epsId: payload.epsId ?? null,
        arlId: payload.arlId ?? null,
        afpId: payload.afpId ?? null,
        afcId: payload.afcId ?? null,
        ccfId: payload.ccfId ?? null,
      })

      // ✅ Usar el método de sincronización
      await this.syncAgenteConUsuario(user)

      await user.load((loader) => preloadUsuarioCompleto(loader))

      return response.created(user)
    } catch (error: any) {
      console.error('Error al crear usuario:', error)
      if (error.code === 'ER_DUP_ENTRY')
        return response.conflict({ message: 'El correo electrónico ya está registrado.' })
      return response.internalServerError({
        message: 'Error al crear usuario',
        error: error.message,
      })
    }
  }
  /** Actualizar usuario */
  public async update(ctx: HttpContext) {
    const { params, request, response } = ctx
    try {
      const user = await Usuario.findOrFail(params.id)

      const payload = request.only([
        'nombres',
        'apellidos',
        'correo',
        'correoPersonal',
        'password',
        'rolId',
        'razonSocialId',
        'sedeId',
        'cargoId',
        'fotoPerfil',
        'direccion',
        'celularPersonal',
        'celularCorporativo',
        'centroCosto',
        'estado',
        'recomendaciones',
        'epsId',
        'arlId',
        'afpId',
        'afcId',
        'ccfId',
        'tipoSangre',
        'contactoEmergenciaNombre',
        'contactoEmergenciaTelefono',
      ])

      // ✅ Filtrar campos undefined
      const cleanPayload: any = {}
      for (const key of Object.keys(payload)) {
        const value = (payload as any)[key]
        if (value !== undefined) {
          cleanPayload[key] = value
        }
      }

      const permiso = await this.autorizarGestion(ctx, user, cleanPayload)
      if (!permiso.ok) return
      if ('sedeId' in cleanPayload) cleanPayload.sedeId = permiso.sedeId

      user.merge(cleanPayload)
      await user.save()

      // ✅ Usar el método de sincronización con protección
      await this.syncAgenteConUsuario(user)

      await user.load((loader) => preloadUsuarioCompleto(loader))

      return response.ok(user)
    } catch (error: any) {
      console.error('Error al actualizar usuario:', error)
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Usuario a actualizar no encontrado.' })
      return response.internalServerError({
        message: 'Error al actualizar usuario',
        error: error.message,
      })
    }
  }

  /** Eliminar usuario */
  public async destroy(ctx: HttpContext) {
    const { params, response } = ctx
    try {
      const user = await Usuario.findOrFail(params.id)

      const permiso = await this.autorizarGestion(ctx, user, {})
      if (!permiso.ok) return

      if (user.fotoPerfil) {
        const oldPhotoRelativePath = user.fotoPerfil.replace(/^\//, '')
        const oldPhotoFullPath = path.join(app.publicPath(), oldPhotoRelativePath)
        try {
          await fs.unlink(oldPhotoFullPath)
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error('Error al eliminar foto perfil:', e)
        }
      }

      await user.delete()
      return response.ok({ message: 'Usuario eliminado correctamente' })
    } catch (error: any) {
      console.error('Error al eliminar usuario:', error)
      if (error.code === 'E_ROW_NOT_FOUND')
        return response.notFound({ message: 'Usuario a eliminar no encontrado.' })
      return response.internalServerError({
        message: 'Error al eliminar usuario',
        error: error.message,
      })
    }
  }

  /* ============ SELECTORES ============ */
  public async getRoles({ response }: HttpContext) {
    try {
      const roles = await Rol.query().select('id', 'nombre').orderBy('nombre', 'asc')
      return response.ok(roles)
    } catch {
      return response.internalServerError({ message: 'Error al obtener roles' })
    }
  }

  public async getRazonesSociales({ response }: HttpContext) {
    try {
      const razones = await RazonSocial.query().select('id', 'nombre').orderBy('nombre', 'asc')
      return response.ok(razones)
    } catch {
      return response.internalServerError({ message: 'Error al obtener razones sociales' })
    }
  }

  public async getSedes({ response }: HttpContext) {
    try {
      const sedes = await Sede.query().select('id', 'nombre').orderBy('nombre', 'asc')
      return response.ok(sedes)
    } catch {
      return response.internalServerError({ message: 'Error al obtener sedes' })
    }
  }

  public async getCargos({ response }: HttpContext) {
    try {
      const cargos = await Cargo.query().select('id', 'nombre').orderBy('nombre', 'asc')
      return response.ok(cargos)
    } catch {
      return response.internalServerError({ message: 'Error al obtener cargos' })
    }
  }

  public async getEntidadesSalud({ response }: HttpContext) {
    try {
      const entidades = await EntidadSalud.query()
        .select('id', 'nombre', 'tipo')
        .orderBy('nombre', 'asc')
      return response.ok(entidades)
    } catch {
      return response.internalServerError({ message: 'Error al obtener entidades de salud' })
    }
  }

  /** Subir foto de perfil */
  public async uploadProfilePicture(ctx: HttpContext) {
    const { request, response, params } = ctx
    const userId = params.id
    if (!userId) return response.badRequest({ message: 'Se requiere el ID del usuario.' })

    const user = await Usuario.findOrFail(userId)
    const permiso = await this.autorizarGestion(ctx, user, {})
    if (!permiso.ok) return
    const foto = request.file('foto', { size: '2mb', extnames: ['jpg', 'png', 'jpeg'] })

    if (!foto || !foto.isValid) {
      const error = foto?.errors[0]
      return response.badRequest({
        message: error?.message || 'No se adjuntó foto o el archivo es inválido.',
      })
    }
    if (!foto.tmpPath) {
      return response.internalServerError({
        message: 'No se pudo leer la ruta temporal del archivo.',
      })
    }

    const uploadDir = 'uploads/profile_pictures'
    const fileName = `${user.id}_${cuid()}.${foto.extname}`

    try {
      if (user.fotoPerfil) {
        const oldRel = user.fotoPerfil.replace(/^\//, '')
        const oldFull = path.join(app.publicPath(), oldRel)
        try {
          await fs.unlink(oldFull)
        } catch (e: any) {
          if (e.code !== 'ENOENT') console.error('Error al eliminar foto anterior:', e)
        }
      }

      const destinationDir = path.join(app.publicPath(), uploadDir)
      await fs.mkdir(destinationDir, { recursive: true })
      const newPhotoFullPath = path.join(destinationDir, fileName)
      await fs.copyFile(foto.tmpPath, newPhotoFullPath)

      user.fotoPerfil = `/${uploadDir}/${fileName}`
      await user.save()

      await user.load((loader) => preloadUsuarioCompleto(loader))

      return response.ok(user)
    } catch (error: any) {
      console.error('Error al subir la foto de perfil:', error)
      return response.internalServerError({
        message: 'Error al subir la foto de perfil',
        error: error.message,
      })
    }
  }
}
