// start/routes.ts
// updated: reporte-caja sin sedeId
import router from '@adonisjs/core/services/router'
import { middleware } from './kernel.js'

// Salud
router.get('/', async () => {
  return { message: 'Bienvenido a la API de Turnos RTM' }
})

// --- API ---
router
  .group(() => {
    /* ========================== AUTENTICACIÓN ========================== */
    router.post('/login', async (ctx) => {
      const { default: AuthController } = await import('#controllers/auth_controller')
      return new AuthController().login(ctx)
    })
    router.post('/forgot-password', async (ctx) => {
      const { default: AuthController } = await import('#controllers/auth_controller')
      return new AuthController().forgotPassword(ctx)
    })
    router.post('/reset-password', async (ctx) => {
      const { default: AuthController } = await import('#controllers/auth_controller')
      return new AuthController().resetPassword(ctx)
    })
    router
      .get('/auth/me', async (ctx) => {
        const { default: AuthController } = await import('#controllers/auth_controller')
        return new AuthController().me(ctx)
      })
      .use(middleware.auth())

    /* ======================== BÚSQUEDA UNIFICADA ======================= */
    router.get('/buscar', async (ctx) => {
      const { default: BusquedasController } = await import('#controllers/busquedas_controller')
      return new BusquedasController().unificada(ctx)
    })

    /* ============================== TURNOS ============================= */
    router
      .get('/turnos-rtm', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .get('/turnos-rtm/siguiente-turno', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().siguienteTurno(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .get('/turnos-rtm/export-excel', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().exportExcel(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'] }),
      ])

    router
      .post('/turnos-rtm', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .post('/turnos-rtm/:id/cerrar', async (ctx) => {
        const { default: TurnosCierreController } = await import(
          '../app/controllers/turnos_cierre_controller.js'
        )
        return new TurnosCierreController().cerrar(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'] }),
      ])

    router
      .get('/turnos-rtm/:id', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'] }),
      ])

    router
      .put('/turnos-rtm/:id', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'] }),
      ])

    router
      .put('/turnos-rtm/:id/salida', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().registrarSalida(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'] }),
      ])

    router
      .patch('/turnos-rtm/:id/activar', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().activar(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'] }),
      ])

    router
      .patch('/turnos-rtm/:id/cancelar', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().cancelar(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'] }),
      ])

    router
      .patch('/turnos-rtm/:id/inhabilitar', async (ctx) => {
        const { default: TurnosRtmController } = await import('#controllers/turnos_rtms_controller')
        return new TurnosRtmController().destroy(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'] }),
      ])

    /* =========================== REP GENERAL RTM ======================= */
    router
      .post('/rtm/rep-general/import', async (ctx) => {
        const { default: RepGeneralImportController } = await import(
          '#controllers/rep_general_imports_controller'
        )
        return new RepGeneralImportController().import(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'] }),
      ])

    /* ============================== USUARIOS =========================== */
    router
      .get('/usuarios', async (ctx) => {
        const { default: UsuariosController } = await import('#controllers/usuarios_controller')
        return new UsuariosController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO', 'OPERATIVO_TURNOS'],
        }), // 👈 agregado
      ])

    router
      .post('/usuarios', async (ctx) => {
        const { default: UsuariosController } = await import('#controllers/usuarios_controller')
        return new UsuariosController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .get('/usuarios/:id', async (ctx) => {
        const { default: UsuariosController } = await import('#controllers/usuarios_controller')
        return new UsuariosController().show(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .put('/usuarios/:id', async (ctx) => {
        const { default: UsuariosController } = await import('#controllers/usuarios_controller')
        return new UsuariosController().update(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .delete('/usuarios/:id', async (ctx) => {
        const { default: UsuariosController } = await import('#controllers/usuarios_controller')
        return new UsuariosController().destroy(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] }), // Solo admin y gerencia pueden eliminar
      ])

    router
      .post('/usuarios/:id/upload-photo', async (ctx) => {
        const { default: UsuariosController } = await import('#controllers/usuarios_controller')
        return new UsuariosController().uploadProfilePicture(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])
    /* ============================== SELECTORES ========================= */
    const selectors = [
      { path: 'roles', controller: '#controllers/roles_controller' },
      { path: 'razones-sociales', controller: '#controllers/razones_sociales_controller' },
      { path: 'sedes', controller: '#controllers/sedes_controller' },
      { path: 'entidades-saluds', controller: '#controllers/entidades_saluds_controller' },
      { path: 'servicios', controller: '#controllers/servicios_controller' },
      { path: 'ciudades', controller: '#controllers/ciudades_controller' },
      { path: 'cargos', controller: '#controllers/cargos_controller' },
    ] as const

    for (const { path, controller } of selectors) {
      router.get(`/${path}`, async (ctx) => {
        const { default: Ctrl } = await import(controller)
        return new Ctrl().index(ctx)
      })
    }

    router.get('/razones-sociales/:id/usuarios', async (ctx) => {
      const { default: Ctrl } = await import('#controllers/razones_sociales_controller')
      return new Ctrl().usuarios(ctx)
    })

    /* ============================ ENTIDADES SALUD ====================== */
    router.get('/entidades-salud/:id', async (ctx) => {
      const { default: EntidadesSaludsController } = await import(
        '#controllers/entidades_saluds_controller'
      )
      return new EntidadesSaludsController().show(ctx)
    })

    /* =============================== CONTRATOS ========================= */
    router
      .get('/contratos', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .get('/usuarios/:usuarioId/contratos', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().getContratosUsuario(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .post('/contratos', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .post('/contratos/anexar-fisico', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().anexarFisico(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .get('/contratos/:id', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().show(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .patch('/contratos/:id', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().update(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .delete('/contratos/:id', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().destroy(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .get('/contratos/:id/archivo', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().descargarArchivo(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .get('/contratos/:id/archivo/meta', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().getArchivoContratoMeta(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .delete('/contratos/:id/archivo', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().eliminarArchivoContrato(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .get('/contratos/:id/recomendacion/archivo', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().getRecomendacionMedicaMeta(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .post('/contratos/:id/recomendacion/archivo', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().subirRecomendacionMedica(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .delete('/contratos/:id/recomendacion/archivo', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().eliminarRecomendacionMedica(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .get('/contratos/:id/recomendacion/descargar', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().descargarRecomendacionMedica(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .get('/contratos/:id/afiliacion/:tipo/archivo', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().getAfiliacionArchivo(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .post('/contratos/:id/afiliacion/:tipo/archivo', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().subirAfiliacionArchivo(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .delete('/contratos/:id/afiliacion/:tipo/archivo', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().eliminarAfiliacionArchivo(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .group(() => {
        router.get('/', async (ctx) => {
          const { default: ContratoPasosController } = await import(
            '#controllers/contrato_pasos_controller'
          )
          return new ContratoPasosController().index(ctx)
        })
        router.post('/', async (ctx) => {
          const { default: ContratoPasosController } = await import(
            '#controllers/contrato_pasos_controller'
          )
          return new ContratoPasosController().store(ctx)
        })
        router.get('/:id', async (ctx) => {
          const { default: ContratoPasosController } = await import(
            '#controllers/contrato_pasos_controller'
          )
          return new ContratoPasosController().show(ctx)
        })
        router.put('/:id', async (ctx) => {
          const { default: ContratoPasosController } = await import(
            '#controllers/contrato_pasos_controller'
          )
          return new ContratoPasosController().update(ctx)
        })
        router.delete('/:id', async (ctx) => {
          const { default: ContratoPasosController } = await import(
            '#controllers/contrato_pasos_controller'
          )
          return new ContratoPasosController().destroy(ctx)
        })
      })
      .prefix('/contratos/:contratoId/pasos')
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .group(() => {
        router.get('/', async (ctx) => {
          const { default: ContratoEventoController } = await import(
            '#controllers/contrato_evento_controller'
          )
          return new ContratoEventoController().index(ctx)
        })
        router.post('/', async (ctx) => {
          const { default: ContratoEventoController } = await import(
            '#controllers/contrato_evento_controller'
          )
          return new ContratoEventoController().store(ctx)
        })
        router.put('/:id', async (ctx) => {
          const { default: ContratoEventoController } = await import(
            '#controllers/contrato_evento_controller'
          )
          return new ContratoEventoController().update(ctx)
        })
        router.delete('/:id', async (ctx) => {
          const { default: ContratoEventoController } = await import(
            '#controllers/contrato_evento_controller'
          )
          return new ContratoEventoController().destroy(ctx)
        })
      })
      .prefix('/contratos/:contratoId/eventos')
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .group(() => {
        router.get('/', async (ctx) => {
          const { default: ContratoCambiosController } = await import(
            '#controllers/contrato_cambios_controller'
          )
          return new ContratoCambiosController().index(ctx)
        })
        router.post('/', async (ctx) => {
          const { default: ContratoCambiosController } = await import(
            '#controllers/contrato_cambios_controller'
          )
          return new ContratoCambiosController().store(ctx)
        })
      })
      .prefix('/contratos/:contratoId/cambios')
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .post('/contratos/:contratoId/salarios', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().storeSalario(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])

    router
      .get('/contratos/:contratoId/salarios', async (ctx) => {
        const { default: ContratosController } = await import('#controllers/contratos_controller')
        return new ContratosController().listSalarios(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'TALENTO_HUMANO'] }),
      ])
    /* =============================== CIUDADES ========================== */
    router.get('/ciudades/:id', async (ctx) => {
      const { default: CiudadesController } = await import('#controllers/ciudades_controller')
      return new CiudadesController().show(ctx)
    })

    /* ========================= CLASES DE VEHÍCULO ====================== */
    router.get('/clases-vehiculo', async (ctx) => {
      const { default: ClasesVehiculosController } = await import(
        '#controllers/clases_vehiculos_controller'
      )
      return new ClasesVehiculosController().index(ctx)
    })
    router.get('/clases-vehiculo/:id', async (ctx) => {
      const { default: ClasesVehiculosController } = await import(
        '#controllers/clases_vehiculos_controller'
      )
      return new ClasesVehiculosController().show(ctx)
    })
    router.post('/clases-vehiculo', async (ctx) => {
      const { default: ClasesVehiculosController } = await import(
        '#controllers/clases_vehiculos_controller'
      )
      return new ClasesVehiculosController().store(ctx)
    })
    router.put('/clases-vehiculo/:id', async (ctx) => {
      const { default: ClasesVehiculosController } = await import(
        '#controllers/clases_vehiculos_controller'
      )
      return new ClasesVehiculosController().update(ctx)
    })
    router.delete('/clases-vehiculo/:id', async (ctx) => {
      const { default: ClasesVehiculosController } = await import(
        '#controllers/clases_vehiculos_controller'
      )
      return new ClasesVehiculosController().destroy(ctx)
    })

    /* ================================ CLIENTES ========================= */
    router.get('/clientes', async (ctx) => {
      const { default: ClientesController } = await import('#controllers/clientes_controller')
      return new ClientesController().index(ctx)
    })
    router.get('/clientes/:id', async (ctx) => {
      const { default: ClientesController } = await import('#controllers/clientes_controller')
      return new ClientesController().show(ctx)
    })
    router.post('/clientes', async (ctx) => {
      const { default: ClientesController } = await import('#controllers/clientes_controller')
      return new ClientesController().store(ctx)
    })
    router.put('/clientes/:id', async (ctx) => {
      const { default: ClientesController } = await import('#controllers/clientes_controller')
      return new ClientesController().update(ctx)
    })
    router.delete('/clientes/:id', async (ctx) => {
      const { default: ClientesController } = await import('#controllers/clientes_controller')
      return new ClientesController().destroy(ctx)
    })

    router.get('/clientes/:id/detalle', async (ctx) => {
      const { default: ClientesController } = await import('#controllers/clientes_controller')
      return new ClientesController().detalle(ctx)
    })
    router.get('/clientes/:id/historial', async (ctx) => {
      const { default: ClientesController } = await import('#controllers/clientes_controller')
      return new ClientesController().historial(ctx)
    })

    /* ================================ VEHÍCULOS ======================== */
    router.get('/vehiculos', async (ctx) => {
      const { default: VehiculosController } = await import('#controllers/vehiculos_controller')
      return new VehiculosController().index(ctx)
    })
    router.get('/vehiculos/:id', async (ctx) => {
      const { default: VehiculosController } = await import('#controllers/vehiculos_controller')
      return new VehiculosController().show(ctx)
    })
    router.post('/vehiculos', async (ctx) => {
      const { default: VehiculosController } = await import('#controllers/vehiculos_controller')
      return new VehiculosController().store(ctx)
    })
    router.put('/vehiculos/:id', async (ctx) => {
      const { default: VehiculosController } = await import('#controllers/vehiculos_controller')
      return new VehiculosController().update(ctx)
    })
    router.delete('/vehiculos/:id', async (ctx) => {
      const { default: VehiculosController } = await import('#controllers/vehiculos_controller')
      return new VehiculosController().destroy(ctx)
    })
    /* ========================= AGENTES CAPTACIÓN ======================= */

    router
      .get('/agentes-captacion', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .get('/agentes-captacion/light', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().light(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }), // ✅ AGREGADO COMERCIAL
      ])
    // ❌ CONTABILIDAD NO puede ver /me (no tiene agente asignado)
    router
      .get('/agentes-captacion/me', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().me(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'COMERCIAL'] }),
      ])

    // ✅ CONTABILIDAD SÍ puede ver fichas individuales de asesores
    router
      .get('/agentes-captacion/:id', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .post('/agentes-captacion', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().store(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .put('/agentes-captacion/:id', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .delete('/agentes-captacion/:id', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().destroy(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    // ✅ CONTABILIDAD SÍ puede ver resumen de asesor
    router
      .get('/agentes-captacion/:id/resumen', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().resumen(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    // ✅ CONTABILIDAD SÍ puede ver prospectos de asesor
    router
      .get('/agentes-captacion/:id/prospectos', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().prospectos(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .get('/agentes-captacion/by-user/:userId', async (ctx) => {
        const { default: AgentesCaptacionController } = await import(
          '#controllers/agentes_captacion_controller'
        )
        return new AgentesCaptacionController().byUser(ctx)
      })
      .where('userId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    // ✅ CONTABILIDAD SÍ puede ver convenios de asesor
    router
      .get('/agentes-captacion/:id/convenios', async (ctx) => {
        const { default: AgentesConveniosController } = await import(
          '#controllers/agentes_convenios_controller'
        )
        return new AgentesConveniosController().listByAsesor(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])
    /* ============================== DATEOS ============================= */

    router
      .get('/captacion-dateos', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .get('/captacion-dateos/verificar-placa', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().verificarPlaca(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    // ⏱ Configuración de horas de exclusividad del dateo (buildReserva)
    router
      .get('/captacion-dateos/config/exclusividad', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().exclusividadConfigGet(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .post('/captacion-dateos/config/exclusividad', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().exclusividadConfigUpsert(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] }),
      ])

    router
      .get('/captacion-dateos/:id', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    // ❌ CONTABILIDAD NO puede crear dateos
    router
      .post('/captacion-dateos', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'COMERCIAL'] }),
      ])

    // ❌ CONTABILIDAD NO puede verificar vencidos
    router
      .post('/captacion-dateos/verificar-vencidos', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().verificarVencidos(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'COMERCIAL'] }),
      ])

    router
      .put('/captacion-dateos/:id', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .delete('/captacion-dateos/:id', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().destroy(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .post('/captacion-dateos/auto-convenio', async (ctx) => {
        const { default: CaptacionUtilController } = await import(
          '#controllers/captacion_util_controller'
        )
        return new CaptacionUtilController().crearAutoPorConvenio(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])
    router
      .patch('/captacion-dateos/:id/avance', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().toggleAvance(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'COMERCIAL'] }),
      ])

    router
      .get('/captacion-dateos/:id/comprobante-avance', async (ctx) => {
        const { default: CaptacionDateosController } = await import(
          '#controllers/captacion_dateos_controller'
        )
        return new CaptacionDateosController().servirComprobanteAvance(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'],
        }),
      ])
    /* =============================== PROSPECTOS ======================== */

    router
      .get('/prospectos', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .post('/prospectos', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .get('/prospectos/:id', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .put('/prospectos/:id', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .patch('/prospectos/:id', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .post('/prospectos/:id/asignar', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().asignar(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .post('/prospectos/:id/retirar', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().retirar(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .post('/prospectos/:id/datear', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().datear(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .get('/asesores/:id/resumen', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().resumenByAsesor(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .get('/prospectos/by-placa', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().findByPlaca(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .get('/prospectos/asesor/:id/list', async (ctx) => {
        const { default: ProspectosController } = await import('#controllers/prospectos_controller')
        return new ProspectosController().listByAsesor(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])
    /* =============================== CONVENIOS ========================= */

    router
      .get('/convenios/buscar-por-nombre', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().buscarPorNombre(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'],
        }),
      ])

    router
      .get('/convenios/asignados', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().asignadosPorAsesor(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }),
      ])

    router
      .get('/convenios/light', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().light(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }), // ✅ AGREGADO
      ])

    router
      .get('/convenios', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'] }), // ✅ AGREGADO
      ])

    router
      .post('/convenios', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .get('/convenios/:id', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .patch('/convenios/:id', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    // 👇 AGREGAR ESTA RUTA PUT
    router
      .put('/convenios/:id', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .get('/convenios/:id/asesor-activo', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().asesorActivo(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'],
        }),
      ])

    router
      .post('/convenios/:id/asignar', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().asignarAsesor(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .post('/convenios/:id/retirar', async (ctx) => {
        const { default: ConveniosController } = await import('#controllers/convenios_controller')
        return new ConveniosController().retirarAsesor(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])
    /* =============================== COMISIONES ======================== */

    router
      .get('/comisiones/config', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().configsIndex(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .post('/comisiones/config', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().configsUpsert(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .patch('/comisiones/config/:id', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().configsUpdate(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .delete('/comisiones/config/:id', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().configsDestroy(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .get('/comisiones', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'],
        }),
      ])

    router
      .get('/comisiones/resumen', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().resumen(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'],
        }),
      ])

    router
      .post('/comisiones', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'],
        }),
      ])

    router
      .get('/comisiones/metas-mensuales', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().metasMensuales(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'],
        }),
      ])

    router
      .get('/comisiones/metas', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().metasIndex(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .post('/comisiones/metas', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().metasUpsert(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .patch('/comisiones/metas/:id', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().metasUpdate(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .delete('/comisiones/metas/:id', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().metasDestroy(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    /* ============== 🔄 CONFIGURACIÓN DE RECURRENCIAS (NUEVO) ============== */

    // Configuración global
    router
      .get('/comisiones/recurrencia/config/global', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().recurrenciaConfigGlobalGet(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .post('/comisiones/recurrencia/config/global', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().recurrenciaConfigGlobalUpsert(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    // Configuración por asesor
    router
      .get('/comisiones/recurrencia/config/asesores', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().recurrenciaConfigAsesoresIndex(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .post('/comisiones/recurrencia/config/asesores', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().recurrenciaConfigAsesoresUpsert(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .delete('/comisiones/recurrencia/config/asesores/:id', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().recurrenciaConfigAsesoresDelete(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    /* ============== FIN CONFIGURACIÓN DE RECURRENCIAS ============== */

    router
      .get('/comisiones/:id', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])
    router
      .patch('/comisiones/:id/editar', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().editar(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])
    router
      .patch('/comisiones/:id/valores', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().actualizarValores(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .post('/comisiones/:id/aprobar', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().aprobar(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .post('/comisiones/:id/pagar', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().pagar(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .post('/comisiones/:id/anular', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().anular(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .post('/comisiones/pagar-masivo', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().pagarMasivo(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .get('/comisiones/resumen-por-asesor', async (ctx) => {
        const { default: ComisionesController } = await import('#controllers/comisiones_controller')
        return new ComisionesController().resumenPorAsesor(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    /* =============================== DESCUENTOS ======================== */

    router
      .get('/descuentos', async (ctx) => {
        const { default: DescuentosController } = await import('#controllers/descuentos_controller')
        return new DescuentosController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'],
        }),
      ])

    router
      .get('/descuentos/activos', async (ctx) => {
        const { default: DescuentosController } = await import('#controllers/descuentos_controller')
        return new DescuentosController().activos(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL', 'OPERATIVO_TURNOS'], // 👈 agregado
        }),
      ])
    router
      .get('/descuentos/historial', async (ctx) => {
        const { default: DescuentosController } = await import('#controllers/descuentos_controller')
        return new DescuentosController().historial(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'],
        }),
      ])

    router
      .get('/descuentos/:id', async (ctx) => {
        const { default: DescuentosController } = await import('#controllers/descuentos_controller')
        return new DescuentosController().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'COMERCIAL'],
        }),
      ])

    router
      .post('/descuentos', async (ctx) => {
        const { default: DescuentosController } = await import('#controllers/descuentos_controller')
        return new DescuentosController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'],
        }),
      ])

    router
      .put('/descuentos/:id', async (ctx) => {
        const { default: DescuentosController } = await import('#controllers/descuentos_controller')
        return new DescuentosController().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'],
        }),
      ])

    router
      .delete('/descuentos/:id', async (ctx) => {
        const { default: DescuentosController } = await import('#controllers/descuentos_controller')
        return new DescuentosController().destroy(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA'],
        }),
      ])
    /* ============================ FACTURACIÓN ========================== */

    router
      .get('/facturacion/tickets', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'OPERATIVO_TURNOS'],
        }),
      ])

    router
      .get('/facturacion/tickets/:id', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'OPERATIVO_TURNOS'],
        }),
      ])

    router
      .get('/facturacion/tickets/hash-exists/:hash', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().hashExists(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'OPERATIVO_TURNOS'],
        }),
      ])

    router
      .get('/facturacion/tickets/duplicados', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().checkDuplicados(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'OPERATIVO_TURNOS'],
        }),
      ])

    router
      .post('/facturacion/tickets', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'],
        }),
      ])

    router
      .post('/facturacion/tickets/:id/reocr', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().reocr(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'OPERATIVO_TURNOS'],
        }),
      ])

    router
      .patch('/facturacion/tickets/:id', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'OPERATIVO_TURNOS'],
        }),
      ])

    router
      .post('/facturacion/tickets/:id/confirmar', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().confirmar(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'OPERATIVO_TURNOS'],
        }),
      ])
    router
      .get('/facturacion/tickets/:id/imagen', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().servirImagen(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'OPERATIVO_TURNOS'],
        }),
      ])

    // 🆕 Documentos verificación INFORMATIVO_POLICIA
    router
      .post('/facturacion/tickets/:id/documentos-policia', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().subirDocumentoPolicia(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'],
        }),
      ])

    router
      .get('/facturacion/tickets/:id/documentos-policia/:tipo', async (ctx) => {
        const { default: Facturacion } = await import('#controllers/facturacion_tickets_controller')
        return new Facturacion().servirDocumentoPolicia(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD', 'OPERATIVO_TURNOS'],
        }),
      ])

    /* ============================ CERTIFICACIONES ====================== */
    /* ============================= TARIFAS TRÁMITES ==================== */

    router
      .get('/tarifas/tramite', async (ctx) => {
        const { default: TarifasTramitesController } = await import(
          '#controllers/tarifas_tramites_controller'
        )
        return new TarifasTramitesController().byTipoClase(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    /* ================================ TRÁMITES ========================= */

    router
      .get('/tramites/siguiente-numero', async (ctx) => {
        const { default: TramitesController } = await import('#controllers/tramites_controller')
        return new TramitesController().siguienteNumero(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    /* ========================== CHECKLIST DE DOCUMENTOS ================ */

    router
      .get('/tramites/checklist', async (ctx) => {
        const { default: TramiteChecklistsController } = await import(
          '#controllers/tramite_checklists_controller'
        )
        return new TramiteChecklistsController().getByTurno(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .put('/tramites/checklist', async (ctx) => {
        const { default: TramiteChecklistsController } = await import(
          '#controllers/tramite_checklists_controller'
        )
        return new TramiteChecklistsController().upsert(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .get('/tramites/liquidacion-historial', async (ctx) => {
        const { default: LiquidacionPagosController } = await import(
          '#controllers/liquidacion_pagos_controller'
        )
        return new LiquidacionPagosController().getHistorialTurno(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .get('/tramites', async (ctx) => {
        const { default: TramitesController } = await import('#controllers/tramites_controller')
        return new TramitesController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .get('/tramites/:id', async (ctx) => {
        const { default: TramitesController } = await import('#controllers/tramites_controller')
        return new TramitesController().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .post('/tramites', async (ctx) => {
        const { default: TramitesController } = await import('#controllers/tramites_controller')
        return new TramitesController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .put('/tramites/:id', async (ctx) => {
        const { default: TramitesController } = await import('#controllers/tramites_controller')
        return new TramitesController().update(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .post('/tramites/:id/pago', async (ctx) => {
        const { default: TramitesController } = await import('#controllers/tramites_controller')
        return new TramitesController().registrarPago(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .post('/tramites/:turnoNumero/agregar', async (ctx) => {
        const { default: TramitesController } = await import('#controllers/tramites_controller')
        return new TramitesController().agregarATurno(ctx)
      })
      .where('turnoNumero', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    /* ========================== MANDATO ================================ */

    router
      .get('/tramites/:tramiteId/mandato/export-excel', async (ctx) => {
        const { default: FormulariosRuntController } = await import(
          '#controllers/formularios_runt_controller'
        )
        return new FormulariosRuntController().exportMandatoExcel(ctx)
      })
      .where('tramiteId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    /* ======================== PAQUETE COMPLETO ========================= */

    router
      .get('/tramites/:tramiteId/paquete/export-excel', async (ctx) => {
        const { default: FormulariosRuntController } = await import(
          '#controllers/formularios_runt_controller'
        )
        return new FormulariosRuntController().exportPaqueteCompleto(ctx)
      })
      .where('tramiteId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    /* ========================== FORMULARIO RUNT ======================== */

    router
      .get('/tramites/:tramiteId/formulario-runt/export-excel', async (ctx) => {
        const { default: FormulariosRuntController } = await import(
          '#controllers/formularios_runt_controller'
        )
        return new FormulariosRuntController().exportExcel(ctx)
      })
      .where('tramiteId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .get('/tramites/:tramiteId/formulario-runt', async (ctx) => {
        const { default: FormulariosRuntController } = await import(
          '#controllers/formularios_runt_controller'
        )
        return new FormulariosRuntController().show(ctx)
      })
      .where('tramiteId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .put('/tramites/:tramiteId/formulario-runt', async (ctx) => {
        const { default: FormulariosRuntController } = await import(
          '#controllers/formularios_runt_controller'
        )
        return new FormulariosRuntController().upsert(ctx)
      })
      .where('tramiteId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    /* ============================ LIQUIDACIÓN ========================== */

    router
      .get('/tramites/:tramiteId/liquidacion', async (ctx) => {
        const { default: TramiteLiquidacionesController } = await import(
          '#controllers/tramite_liquidaciones_controller'
        )
        return new TramiteLiquidacionesController().getByTramite(ctx)
      })
      .where('tramiteId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .put('/tramites/:tramiteId/liquidacion', async (ctx) => {
        const { default: TramiteLiquidacionesController } = await import(
          '#controllers/tramite_liquidaciones_controller'
        )
        return new TramiteLiquidacionesController().upsert(ctx)
      })
      .where('tramiteId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .get('/tramites/:tramiteId/liquidacion/export-pdf', async (ctx) => {
        const { default: TramiteLiquidacionesController } = await import(
          '#controllers/tramite_liquidaciones_controller'
        )
        return new TramiteLiquidacionesController().exportLiquidacionPdf(ctx)
      })
      .where('tramiteId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .post('/tramites/liquidacion/:tramiteLiquidacionId/pago', async (ctx) => {
        const { default: LiquidacionPagosController } = await import(
          '#controllers/liquidacion_pagos_controller'
        )
        return new LiquidacionPagosController().registrarPago(ctx)
      })
      .where('tramiteLiquidacionId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .get('/tramites/liquidacion-pago/:liquidacionPagoId/pdf', async (ctx) => {
        const { default: LiquidacionPagosController } = await import(
          '#controllers/liquidacion_pagos_controller'
        )
        return new LiquidacionPagosController().getPagoPdf(ctx)
      })
      .where('liquidacionPagoId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    router
      .get('/tramites/reporte-caja', async (ctx) => {
        const { default: LiquidacionPagosController } = await import(
          '#controllers/liquidacion_pagos_controller'
        )
        return new LiquidacionPagosController().getReporteCaja(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR'] }),
      ])

    /* ============================ CERTIFICACIONES ====================== */
    /* ============================ CERTIFICACIONES ====================== */

    router
      .post('/certificaciones', async (ctx) => {
        const { default: CertificacionesController } = await import(
          '#controllers/certificaciones_controller'
        )
        return new CertificacionesController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'],
        }),
      ])

    router
      .get('/certificaciones/turno/:turnoId', async (ctx) => {
        const { default: CertificacionesController } = await import(
          '#controllers/certificaciones_controller'
        )
        return new CertificacionesController().showByTurno(ctx)
      })
      .where('turnoId', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({
          roles: ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS'],
        }),
      ])

    /* =============================== OCR (BACKEND) ===================== */

    router.post('/ocr/parse-ticket', async (ctx) => {
      const { default: OcrController } = await import('#controllers/ocr_controller')
      return new OcrController().parseTicket(ctx)
    })

    /* ======================== COMPROBANTES DE PAGO ===================== */

    router
      .get('/comprobantes-pago', async (ctx) => {
        const { default: ComprobantesPagoController } = await import(
          '#controllers/comprobantes_pagos_controller'
        )
        return new ComprobantesPagoController().index(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .post('/comprobantes-pago', async (ctx) => {
        const { default: ComprobantesPagoController } = await import(
          '#controllers/comprobantes_pagos_controller'
        )
        return new ComprobantesPagoController().store(ctx)
      })
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .get('/comprobantes-pago/:id', async (ctx) => {
        const { default: ComprobantesPagoController } = await import(
          '#controllers/comprobantes_pagos_controller'
        )
        return new ComprobantesPagoController().show(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .patch('/comprobantes-pago/:id/evidencia', async (ctx) => {
        const { default: ComprobantesPagoController } = await import(
          '#controllers/comprobantes_pagos_controller'
        )
        return new ComprobantesPagoController().subirEvidencia(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    router
      .delete('/comprobantes-pago/:id/evidencia', async (ctx) => {
        const { default: ComprobantesPagoController } = await import(
          '#controllers/comprobantes_pagos_controller'
        )
        return new ComprobantesPagoController().eliminarEvidencia(ctx)
      })
      .where('id', /^[0-9]+$/)
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    /* ================================ UPLOADS ========================== */

    router.post('/media/upload', async (ctx) => {
      const { default: UploadsController } = await import('#controllers/uploads_controller')
      return new UploadsController().uploadImage(ctx)
    })
    router.get('/uploads/*', async (ctx) => {
      const { default: UploadsController } = await import('#controllers/uploads_controller')
      return new UploadsController().serve(ctx)
    })
    router.delete('/uploads/*', async (ctx) => {
      const { default: UploadsController } = await import('#controllers/uploads_controller')
      return new UploadsController().remove(ctx)
    })
    /* ======================== HISTÓRICO RTM =========================== */

    router
      .post('/historico-rtm/preview', async (ctx) => {
        const { default: HistoricoDateoRtmController } = await import(
          '#controllers/historico_dateo_rtm_controller'
        )
        return new HistoricoDateoRtmController().preview(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    router
      .post('/historico-rtm/importar', async (ctx) => {
        const { default: HistoricoDateoRtmController } = await import(
          '#controllers/historico_dateo_rtm_controller'
        )
        return new HistoricoDateoRtmController().importar(ctx)
      })
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])

    /* ======================== REPORTES ADMINISTRATIVOS ================= */
    router
      .group(() => {
        router.get('/ingresos-canal', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().ingresosPorCanal(ctx)
        })
        router.get('/produccion-lider', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().produccionPorLider(ctx)
        })
        router.get('/asesores', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().reporteAsesores(ctx)
        })
        router.get('/detalle-asesor', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().detallePorAsesor(ctx)
        })
        router.get('/detalle-canal', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().detallePorCanal(ctx)
        })
        router.get('/retencion', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().retencionClientes(ctx)
        })
        router.get('/detalle-retencion', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().detallePorRetencion(ctx)
        })
        router.get('/servicios', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().reporteServicios(ctx)
        })
        router.get('/descuentos-por-tipo', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().descuentosPorTipo(ctx)
        })
        router.get('/descuentos-por-canal', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().descuentosPorCanal(ctx)
        })
        router.get('/descuentos-por-autorizador', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().descuentosPorAutorizador(ctx)
        })
        router.get('/detalle-descuentos', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().detalleDescuentos(ctx)
        })
        router.get('/comisiones', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().reporteComisiones(ctx)
        })
        router.get('/detalle-comisiones', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().detalleComisiones(ctx)
        })
        router.get('/liquidacion-rtm', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().liquidacionRtm(ctx)
        })
        router.get('/liquidacion-rtm/excel', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().liquidacionRtmExcel(ctx)
        })
        router.get('/historial-liquidaciones/excel', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().historialLiquidacionesExcel(ctx)
        })
        router.get('/historial-liquidaciones', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().historialLiquidaciones(ctx)
        })
        router.get('/historial-liquidaciones/:id', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().historialLiquidacionDetalle(ctx)
        })
        router.get('/trazabilidad-rtm', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().trazabilidadRtm(ctx)
        })
        router.get('/trazabilidad-rtm/excel', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().trazabilidadRtmExcel(ctx)
        })
        router.get('/meta-mensual/config', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaMensualConfigGet(ctx)
        })
        router.post('/meta-mensual/config', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaMensualConfigUpsert(ctx)
        })
        router.get('/meta-mensual/resumen', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaMensualResumen(ctx)
        })
        router.get('/meta-mensual/diario', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaMensualDiario(ctx)
        })
        router.get('/meta-mensual/semanal', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaMensualSemanal(ctx)
        })
        router.get('/meta-mensual/proyectado', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaMensualProyectado(ctx)
        })
        router.get('/meta-mensual/rango', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaMensualRango(ctx)
        })
        router.get('/super-informe/meta-mensual', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaMensualSuperInforme(ctx)
        })
        router.get('/meta-comercial/resumen', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaComercialResumen(ctx)
        })
        router.get('/meta-comercial/diario', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaComercialDiario(ctx)
        })
        router.get('/meta-comercial/semanal', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaComercialSemanal(ctx)
        })
        router.get('/meta-comercial/proyectado', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaComercialProyectado(ctx)
        })
        router.get('/meta-comercial/detalle-vehiculo', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaComercialDetalleVehiculo(ctx)
        })
        router.get('/meta-comercial/ingreso-real-dateo', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaComercialIngresoRealDateo(ctx)
        })
        router.get('/super-informe/meta-comercial', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().metaComercialSuperInforme(ctx)
        })
        router.get('/super-informe/pdf', async (ctx) => {
          const { default: ReportesAdministrativosController } = await import(
            '#controllers/reportes_administrativos_controller'
          )
          return new ReportesAdministrativosController().superInformePdf(ctx)
        })
      })
      .prefix('/reportes-admin')
      .use([
        middleware.auth(),
        middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA', 'CONTABILIDAD'] }),
      ])

    /* ======================== TARIFAS POR SERVICIO ====================== */
    router
      .group(() => {
        router.get('/', async (ctx) => {
          const { default: TarifasServiciosController } = await import(
            '#controllers/tarifas_servicios_controller'
          )
          return new TarifasServiciosController().index(ctx)
        })
        router.post('/', async (ctx) => {
          const { default: TarifasServiciosController } = await import(
            '#controllers/tarifas_servicios_controller'
          )
          return new TarifasServiciosController().store(ctx)
        })
        router.put('/:id', async (ctx) => {
          const { default: TarifasServiciosController } = await import(
            '#controllers/tarifas_servicios_controller'
          )
          return new TarifasServiciosController().update(ctx)
        })
        router.delete('/:id', async (ctx) => {
          const { default: TarifasServiciosController } = await import(
            '#controllers/tarifas_servicios_controller'
          )
          return new TarifasServiciosController().destroy(ctx)
        })
      })
      .prefix('/tarifas-servicios')
      .use([middleware.auth(), middleware.checkRole({ roles: ['SUPER_ADMIN', 'GERENCIA'] })])
  })
  .prefix('/api')
