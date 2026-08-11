# Mapa del Sistema — Backend SGC (Turnos RTM)

> Documento de referencia generado para orientación rápida en futuras conversaciones. Organizado por **módulo de negocio**, no por carpeta técnica. Backend AdonisJS 6 + Lucid ORM, MySQL. Rutas centralizadas en `start/routes.ts`.
>
> Generado: 2026-08-10. Si el código cambia, este documento puede quedar desactualizado — verificar contra el código real antes de confiar ciegamente en detalles finos (nombres exactos de columnas, roles).

---
## RTM / Turnos del Día

**Propósito:** Es el corazón operativo del sistema: gestiona el ciclo de vida de cada turno de vehículo que llega a la sede a tomar un servicio (RTM, preventiva, peritaje, etc.), desde la creación del turno hasta su cierre, y clasifica automáticamente si el cliente es nuevo, recurrente o "en recuperación" para efectos de comisión.

**Controladores:**
- `app/controllers/turnos_rtms_controller.ts`
  - `GET /turnos-rtm` (roles: SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS, TRAMITADOR) — lista turnos con filtros (fecha, placa, tipoVehículo, estado, servicio, canal, agente, cliente, vehículo) y paginación; por defecto muestra últimos 7 días
  - `GET /turnos-rtm/siguiente-turno` — calcula el próximo número de turno (global y por servicio) considerando huecos liberados por cancelados
  - `GET /turnos-rtm/export-excel` (roles: ...OPERATIVO_TURNOS, sin TRAMITADOR) — exporta turnos a Excel
  - `POST /turnos-rtm` — crea un turno: valida usuario/sede, resuelve o crea vehículo/cliente/conductor, calcula número de turno (con reasignación de slots cancelados), vincula un dateo de captación vigente si existe (vía `buildReserva`), clasifica recurrencia/recuperación/continuidad (vía `evaluarContinuidad`), y auto-crea un dateo si detecta un asesor por teléfono
  - `PUT /turnos-rtm/:id` — actualiza datos del turno (incluye recálculo de `turnoNumeroServicio` si cambia el servicio)
  - `PUT /turnos-rtm/:id/salida` — registra hora de salida, calcula tiempo de servicio, pasa el turno a `finalizado`; si el servicio no es RTM y hay dateo vinculado, lo marca EXITOSO
  - `PATCH /turnos-rtm/:id/activar` — reactiva un turno
  - `PATCH /turnos-rtm/:id/cancelar` — cancela un turno (vuelve negativo su `turnoNumero`/`turnoNumeroServicio` para liberar el slot y permitir reasignación)
  - `PATCH /turnos-rtm/:id/inhabilitar` → método `destroy` — soft-delete (estado `inactivo`)
  - `GET /turnos-rtm/:id` — detalle de un turno con campos derivados (si tiene facturación confirmada, si tiene certificación, número de visita del vehículo e historial)
- `app/controllers/turnos_cierre_controller.ts`
  - `POST /turnos-rtm/:id/cerrar` (roles: ...OPERATIVO_TURNOS) — **acción de cierre integral**: finaliza el turno si no lo estaba, marca el dateo vinculado como EXITOSO, y crea la comisión PENDIENTE asociada (idempotente: si ya existe comisión para ese turno, no duplica)
- `app/controllers/historico_dateo_rtm_controller.ts`
  - `POST /historico-rtm/preview` (roles: SUPER_ADMIN, GERENCIA) — lee un Excel histórico de dateos RTM (multi-hoja) y devuelve estadísticas sin guardar nada
  - `POST /historico-rtm/importar` — importa ese histórico: normaliza nombres de titular (mapa de aliases hardcodeado por errores de tipeo), resuelve agente/convenio, crea `captacion_dateo` + `turno_rtm` retroactivos con `turnoNumero` negativo (para no chocar con la restricción de unicidad diaria)
- `app/controllers/continuidad_overrides_controller.ts`
  - `GET /continuidad/buscar` (roles: SUPER_ADMIN, GERENCIA) — busca por placa o cédula el historial de visitas de un vehículo y sus overrides de continuidad existentes
  - `POST /continuidad/overrides` — crea/actualiza (upsert) un override manual de continuidad para una combinación placa+asesor/convenio (`AUTOMATICO`, `FORZAR_SI`, `FORZAR_NO`)
- `app/controllers/rep_general_imports_controller.ts`
  - `POST /rtm/rep-general/import` (roles: ...OPERATIVO_TURNOS) — importa el archivo diario "Rep General" (CSV/Excel) o el histórico masivo "TECNOBASE": hace upsert de clientes/vehículos/conductores, crea o "empalma" turnos existentes, clasifica recurrencia/recuperación/continuidad por fila, y **recalcula el monto de comisiones PENDIENTES** ya creadas cuando cambia la clasificación

**Servicios:**
- `app/services/continuidad_service.ts` → `evaluarContinuidad()` — **única fuente de verdad** para decidir si la relación asesor-convenio↔placa está "CONTINUA", "ROTA" o "SIN_EVIDENCIA" (antes había 3 implementaciones divergentes en distintos controllers, fueron unificadas aquí). Reglas: recorre TODO el historial de turnos finalizados de la placa; una visita sin dateo vinculado rompe la continuidad; una visita con dateo de otro asesor/convenio rompe; dateos migrados con asesor/convenio en NULL anteriores al 2026-04-01 (`CORTE_DATOS_CONFIABLES`) se tratan como "sin evidencia" en vez de ruptura; un override manual en `continuidad_overrides` siempre tiene la última palabra. Se usa desde `turnos_rtms_controller.ts` (al crear turno) y `rep_general_imports_controller.ts` (al empalmar).

**Modelos / Tablas:**
- `turnos_rtms` (modelo `TurnoRtm`) — campos clave: `sedeId`, `funcionarioId` (quien creó), `facturacionFuncionarioId`, `certificacionFuncionarioId` (⚠️ ver nota de deuda técnica), `servicioId`, `vehiculoId`, `clienteId`, `conductorId`, `agenteCaptacionId`, `captacionDateoId`, `fecha`, `horaIngreso`/`horaSalida`, `turnoNumero`/`turnoNumeroServicio` (negativos = cancelado/hueco liberado), `placa`, `tipoVehiculo`, `estado` (`activo|inactivo|cancelado|finalizado`), `canalAtribucion`, `esRecurrente`, `esRecuperacion`, `estadoContinuidad`, `mesesDesdeUltimaVisita`, `esAvance`, `reasignadoDeTurnoId`, `repGeneralVerificado`
- `continuidad_overrides` (modelo `ContinuidadOverride`) — `placa`, `asesorConvenioId`, `convenioId`, `estado` (`AUTOMATICO|FORZAR_SI|FORZAR_NO`), `motivo`, `creadoPorId`
- `historico_meta_diario` (modelo `HistoricoMetaDiario`) — respaldo histórico diario cargado fuera de la app (2025 completo excepto mayo, y 2026 ene-may); `fecha`, `livianos`, `motos`, `total`. Se usa como *fallback* en el reporte de Meta Mensual cuando `turnos_rtms` no tiene datos reales de ese mes.
- `configuracion_meta_mensual` (modelo `ConfiguracionMetaMensual`) — `mes`, `anio`, `metaLivianos`, `metaMotos`, `pctCrecimientoReferencia`

**Relaciones con otros módulos:**
- Consume: **Captación** (`captacion_dateo`, `agente_captacion`, `asesor_convenio_asignacion`), **Vehículos y Clientes** (`vehiculo`, `cliente`, `conductor`), **Servicios** (`servicio`)
- Alimenta: **Comisiones** (el cierre de turno crea la comisión PENDIENTE; el import de Rep General recalcula montos de comisión), **Facturación** (`facturacion_ticket.turno_id`), **Certificaciones** (`certificacion.turno_id`), **Reportes Administrativos** (fuente principal de datos)

**Notas de deuda técnica detectadas:**
- **`certificacionFuncionarioId` — CORRECCIÓN respecto al entendimiento previo:** se creía que esta columna estaba muerta, pero al revisar el código **sí se escribe activamente**: `certificaciones_controller.ts` (`store()`, línea ~120) la puebla con `usuario?.id` cada vez que se registra una certificación (foto) y se finaliza el turno. También se precarga en `index`/`show` de `turnos_rtms_controller.ts`. No hay evidencia de que sea código muerto — parece funcionar como se espera (registra quién certificó el turno). Si en la práctica el dato sale vacío/incorrecto en producción, el problema no está en que nadie la escriba, sino en otra parte del flujo (revisar caso real). Ver también el mismo patrón simétrico en `facturacionFuncionarioId`, escrito por `facturacion_tickets_controller.ts` al confirmar un ticket — tampoco está muerto.
- Existen migraciones para `meta_comercial_asesor`, `historico_comercial_asesor` e `historico_comercial_vehiculo_mensual` que **no tienen modelo Lucid** en `app/models/` — se acceden probablemente vía query builder directo desde Comisiones/Reportes (pendiente de confirmar en esos módulos).
- La distinción "turno finalizado vs no-finalizado" es manual en cada query (`.where('estado', 'finalizado')`) — los commits recientes (`f15d28e`, `98899f0`) corrigieron reportes que contaban turnos no-finalizados por no aplicar este filtro. Cualquier reporte nuevo sobre `turnos_rtms` debe filtrar explícitamente por `estado = 'finalizado'` si busca medir producción real.
- `historico_dateo_rtm_controller.ts` tiene un mapa hardcodeado (`TITULAR_CANON`) de decenas de variaciones de nombres de asesores mal tipeados en Excels históricos — es deuda de datos, no de código, pero es frágil ante nuevos asesores/nuevas hojas.

---

## Contratos (RRHH / Talento Humano)

**Propósito:** Gestiona el ciclo de vida laboral de cada usuario/empleado: datos del contrato (tipo, término, salario, afiliaciones a EPS/ARL/AFP/AFC/CCF), sus documentos (contrato físico, recomendaciones médicas, soportes de afiliación), su historial de estados, sus "pasos" de onboarding/offboarding y eventos (incapacidades, licencias, vacaciones, disciplinarios).

**Controladores:**
- `app/controllers/contratos_controller.ts` (controlador más grande del módulo, ~2400 líneas)
  - `GET /contratos` (roles: SUPER_ADMIN, GERENCIA, TALENTO_HUMANO) — lista contratos
  - `GET /usuarios/:usuarioId/contratos` — contratos de un usuario específico
  - `POST /contratos` — crea contrato (registra `contrato_historial_estados` inicial)
  - `POST /contratos/anexar-fisico` — anexa contrato físico escaneado a uno ya existente
  - `GET /contratos/:id` — detalle con relaciones precargadas
  - `PATCH /contratos/:id` — actualización general; incluye "early-exit" cuando solo cambia el estado (crea registro en `contrato_historial_estados` si el estado cambió, valida reglas de `terminoContrato` según `tipoContrato`, exige `fechaTerminacion` cuando aplica)
  - `DELETE /contratos/:id` — elimina contrato
  - `GET /contratos/:id/archivo`, `GET /contratos/:id/archivo/meta`, `DELETE /contratos/:id/archivo` — descarga/metadata/borrado del contrato físico escaneado
  - `GET /contratos/:id/recomendacion/archivo`, `POST .../recomendacion/archivo` (`subirRecomendacionMedica`), `DELETE .../recomendacion/archivo`, `GET .../recomendacion/descargar` — CRUD del documento de recomendación médica
  - `GET /contratos/:id/afiliacion/:tipo/archivo`, `POST .../afiliacion/:tipo/archivo`, `DELETE .../afiliacion/:tipo/archivo` — CRUD de soportes por tipo de afiliación (EPS/ARL/AFP/AFC/CCF), cada uno con su propio path/nombre/mime/size en columnas dedicadas del contrato
  - `POST /contratos/:contratoId/salarios` (`storeSalario`, delega en `createSalario`) — registra un nuevo salario efectivo (histórico salarial)
  - `GET /contratos/:contratoId/salarios` (`listSalarios`) — historial de salarios
- `app/controllers/contrato_pasos_controller.ts` (bajo `/contratos/:contratoId/pasos`)
  - `GET /` (index) — lista pasos del contrato (fases: inicio/desarrollo/fin), ordenados por fase y orden
  - `POST /` (store) — crea un paso, con archivo adjunto opcional
  - `GET /:id` (show), `PUT /:id` (update, soporta reemplazar/borrar archivo), `DELETE /:id` (destroy)
- `app/controllers/contrato_evento_controller.ts` (bajo `/contratos/:contratoId/eventos`)
  - `GET /` (index) — lista eventos (incapacidad, suspensión, licencia, permiso, vacaciones, cesantías, disciplinario, terminación)
  - `POST /` (store), `PUT /:id` (update), `DELETE /:id` (destroy) — CRUD con documento adjunto opcional
- `app/controllers/contrato_cambios_controller.ts` (bajo `/contratos/:contratoId/cambios`)
  - `GET /` (index) — lista el log de cambios (`campo`, `oldValue`, `newValue`) de un contrato
  - `POST /` (store) — crea un registro de cambio manual

**Servicios:** Lógica de negocio vive directamente en el controlador (no hay servicio dedicado). `contratos_controller.ts` centraliza validaciones de negocio bastante complejas: reglas de `terminoContrato` permitido según `tipoContrato` (ej. `aprendizaje` solo admite `fijo`; `laboral` admite `indefinido`), exigencia condicional de `fechaTerminacion`, y sincronización de datos del usuario tras guardar contrato (`syncUsuarioTrasGuardarContrato`).

**Modelos / Tablas:**
- `contratos` (modelo `Contrato`) — campos clave: `usuarioId`, `razonSocialId`, `sedeId`, `cargoId`, `tipoContrato` (`laboral|temporal|prestacion|aprendizaje`), `terminoContrato` (`fijo|obra_o_labor_determinada|indefinido`), `estado` (`activo|inactivo`), `fechaInicio`/`fechaTerminacion`, `salario`, `epsId`/`arlId`/`afpId`/`afcId`/`ccfId` (FKs a `entidades_salud`), columnas dedicadas de archivo por cada afiliación (`epsDocPath`, `arlDocPath`, etc.), `nombreArchivoContratoFisico`/`rutaArchivoContratoFisico`, `tieneRecomendacionesMedicas`/`rutaArchivoRecomendacionMedica`, `motivoFinalizacion`, `actorId` (auditoría de quién crea/actualiza)
- `contrato_pasos` (modelo `ContratoPaso`) — `contratoId`, `fase` (`inicio|desarrollo|fin`), `nombrePaso`, `fecha`, `orden`, `completado`, `archivoUrl`, `usuarioId`
- `contrato_eventos` (modelo `ContratoEvento`) — `contratoId`, `tipo`, `subtipo`, `fechaInicio`/`fechaFin`, `descripcion`, `documentoUrl`, `usuarioId`
- `contrato_cambios` (modelo `ContratoCambio`) — `contratoId`, `usuarioId`, `campo`, `oldValue`, `newValue` (log de auditoría genérico)
- `contrato_historial_estados` (modelo `ContratoHistorialEstado`) — `contratoId`, `usuarioId`, `oldEstado`/`newEstado`, `fechaCambio`, `fechaInicioContrato`, `motivo`
- `contratos_salarios` (modelo `ContratoSalario`, tabla `contratos_salarios`) — `contratoId`, `salarioBasico`, `bonoSalarial`, `auxilioTransporte`, `auxilioNoSalarial`, `fechaEfectiva` (histórico salarial independiente del campo `salario` en `contratos`)

**Relaciones con otros módulos:** Depende de **Usuarios, Roles y Permisos** (`usuario`), **Catálogos Base** (`sede`, `cargo`, `razon_social`, `entidad_salud`). No es consumido por otros módulos de negocio operativo (RTM, Comisiones, etc.) — es autocontenido para RRHH.

**Notas de deuda técnica detectadas:**
- **`contrato_pasos_controller.ts`** (ya identificado por el equipo como no confiable): revisado a fondo (controller + modelo `ContratoPaso` + migración `1752612194078_create_contrato_pasos_table.ts`), la estructura es internamente consistente — no se encontró una inconsistencia de columnas/nombres que explique una falla evidente en el código estático. Un detalle sospechoso: la migración crea el enum `fase` con `useNative: true` y `enumName: 'contrato_pasos_fase_enum'`, una sintaxis pensada para Postgres (tipos ENUM nombrados); el proyecto corre sobre MySQL, donde ese patrón puede comportarse distinto a lo esperado. No se pudo confirmar en runtime — tratar este controller como no confiable tal como ya se sabía, y si se retoma, revisar primero el tipo real de la columna `fase` en la base de datos de producción.
- **Código muerto confirmado en `contratos_controller.ts`**: los métodos `cambiarEstado()` (línea ~1148) y `updateRecomendacionMedica()` / `uploadRecomendacionMedica()` (líneas ~1740 y ~1839) **no están registrados en `start/routes.ts`** y no son llamados desde ningún otro método del controlador — son inalcanzables. La lógica equivalente de cambio de estado (con su registro en `contrato_historial_estados`) ya vive duplicada dentro de `update()`, `store()` y `anexarFisico()`. `createSalario()` (línea 1914) SÍ se usa — `storeSalario()`, que es la que está ruteada, delega en ella.

---

## Vehículos y Clientes

**Propósito:** Maestro de vehículos (placa, marca, línea, clase) y de clientes (dueños), con vistas enriquecidas de historial de visitas por cliente/vehículo. Es el maestro de datos que consume RTM/Turnos, Captación y Trámites.

**Controladores:**
- `app/controllers/vehiculos_controller.ts`
  - `GET /vehiculos` — lista con filtros por texto libre (placa/marca/línea/modelo/color/matrícula), por `clase_codigo` y por teléfono del cliente dueño
  - `GET /vehiculos/:id` — detalle con clase y cliente precargados
  - `POST /vehiculos` — crea vehículo; valida unicidad de placa; resuelve clase por código o id; asocia cliente por teléfono si existe
  - `PUT /vehiculos/:id` — actualiza (soporta cambiar placa validando unicidad, cambiar cliente por id o por teléfono)
  - `DELETE /vehiculos/:id` — elimina físicamente (sin bloqueo si hay turnos asociados — ver deuda técnica)
- `app/controllers/clientes_controller.ts`
  - `GET /clientes` — lista/búsqueda por nombre, teléfono, documento, email, o por placa de un vehículo asociado
  - `GET /clientes/:id` — detalle simple
  - `POST /clientes` — crea cliente; valida unicidad de teléfono y de (docTipo+docNumero)
  - `PUT /clientes/:id` — actualiza; valida unicidad de teléfono/documento al cambiar
  - `DELETE /clientes/:id` — elimina, **bloqueado si el cliente tiene vehículos asociados**
  - `GET /clientes/:id/detalle` — vista enriquecida: vehículos del cliente, KPIs (nº visitas, última visita, días desde última visita, top servicios), última visita por vehículo, últimas 5 visitas con asesor/convenio asociado (cruza con `captacion_dateos` incluso cuando el turno no tiene `captacion_dateo_id` directo, buscando un dateo de un turno "hueco" ±7 días en la misma placa)
  - `GET /clientes/:id/historial` — historial paginado y filtrable de turnos del cliente (por servicio, sede, placa, estado, rango de fechas), con el mismo cruce de asesor/convenio vía `captacion_dateos`

**Servicios:** Lógica de negocio vive directamente en el controlador. `clientes_controller.ts` exporta además una función standalone `findOrCreateCliente()` (no es un servicio en `app/services/`, pero cumple ese rol) con la regla de prioridad de identidad: 1º documento, 2º teléfono (solo si el documento coincide o no hay conflicto), 3º crear nuevo — el email nunca se usa para buscar, solo como dato de contacto, y nunca se pisa si ya pertenece a otro cliente. Esta misma regla de negocio está *reimplementada* (no reutilizada) dentro de `rep_general_imports_controller.ts` y `turnos_rtms_controller.ts` (ver deuda técnica).

**Modelos / Tablas:**
- `vehiculos` (modelo `Vehiculo`) — `placa` (siempre en mayúsculas, única), `claseVehiculoId`, `marca`, `linea`, `modelo`, `color`, `matricula`, `clienteId` (dueño actual, opcional)
- `clientes` (modelo `Cliente`) — `nombre`, `docTipo`/`docNumero`, `telefono` (único, obligatorio), `email`, `ciudadId`
- `conductores` (modelo `Conductor`, tabla `conductores`) — `nombre`, `docTipo`/`docNumero`, `telefono`, `email`. **No tiene controller propio**: se crea/actualiza siempre "al vuelo" desde `turnos_rtms_controller.ts` (al crear/editar un turno) y desde `rep_general_imports_controller.ts` (al importar el Rep General diario) — no hay un CRUD administrativo dedicado a conductores.

**Relaciones con otros módulos:** Es maestro de datos consumido por **RTM/Turnos** (`turno_rtm.vehiculoId/clienteId/conductorId`), **Captación** (`captacion_dateo.placa`, `prospecto`), **Trámites RUNT** (datos de propietario/conductor en formularios). No depende de ningún otro módulo de negocio.

**Notas de deuda técnica detectadas:**
- La regla de "buscar/crear cliente" (prioridad documento → teléfono → nuevo, sin usar email como identificador) está **duplicada en al menos 3 lugares** con implementaciones ligeramente distintas: `findOrCreateCliente()` en `clientes_controller.ts`, `upsertClienteDesdeFila()` en `rep_general_imports_controller.ts`, y la lógica inline dentro de `turnos_rtms_controller.store()`. Un cambio en la regla de negocio (como el que ya se hizo con `continuidad_service.ts` para continuidad) requeriría tocar los 3 sitios.
- `DELETE /vehiculos/:id` borra físicamente sin verificar si existen `turnos_rtms` referenciando ese vehículo — el propio comentario en el código lo señala ("Si luego hay turnos que referencien vehículo, aquí se podría bloquear el delete"). Contrasta con `clientes_controller.destroy()`, que sí bloquea si hay vehículos asociados.

---

## Captación Comercial (Canales, Agentes, Prospectos, Convenios, Dateos)

**Propósito:** Es el módulo comercial: asesores (internos y de convenio) captan clientes potenciales a través de distintos canales (fachada, convenio, telemercadeo, redes) y registran "dateos" (contactos con una ventana de exclusividad temporal) que compiten por convertirse en un turno RTM real. También gestiona convenios (talleres/parqueaderos/personas que refieren clientes) y prospectos (leads con seguimiento de vencimientos SOAT/tecnomecánica).

**Controladores:**

*Agentes y canales*
- `app/controllers/agentes_captacion_controller.ts`
  - `GET /agentes-captacion` (roles varían por endpoint, ver abajo) — lista asesores/agentes
  - `GET /agentes-captacion/light` — listado liviano (para selects)
  - `GET /agentes-captacion/me` (no accesible a CONTABILIDAD) — el agente vinculado al usuario autenticado
  - `GET /agentes-captacion/:id` — ficha de un asesor
  - `POST /agentes-captacion`, `PUT /agentes-captacion/:id`, `DELETE /agentes-captacion/:id` (solo SUPER_ADMIN/GERENCIA) — CRUD
  - `GET /agentes-captacion/:id/resumen` — resumen de desempeño del asesor
  - `GET /agentes-captacion/:id/prospectos` — prospectos del asesor
  - `GET /agentes-captacion/by-user/:userId` — busca el agente asociado a un usuario del sistema
  - `GET /agentes-captacion/:id/dateos-comisiones` — dateos del asesor con su comisión ya calculada/unida por el backend (reemplaza un cruce que antes hacía el frontend manualmente)
  - `GET /agentes-captacion/:id/convenios` → delega en `agentes_convenios_controller.ts` (`listByAsesor`) — convenios vigentes asignados a un asesor (con soporte `light`/`vigente`)
- `app/controllers/captacion_canales_controller.ts` — CRUD de canales de captación (código, nombre, color, orden) con soft-delete/restore. **⚠️ No está montado en `start/routes.ts` — ver deuda técnica.**
- `app/controllers/agente_canal_membresias_controller.ts` — gestionaría la relación N:N agente↔canal (pivot `agente_canal_membresias`, con flags `is_default`/`activo`). **⚠️ Todo el archivo está comentado — ver deuda técnica.**

*Dateos*
- `app/controllers/captacion_dateos_controller.ts`
  - `GET /captacion-dateos` — lista dateos
  - `GET /captacion-dateos/verificar-placa` — chequea si una placa tiene un dateo vigente (exclusividad)
  - `GET|POST /captacion-dateos/config/exclusividad` — lee/actualiza las horas de exclusividad (`configuracion_reserva_dateos`, solo POST para SUPER_ADMIN/GERENCIA)
  - `GET /captacion-dateos/:id` — detalle
  - `POST /captacion-dateos` (no CONTABILIDAD) — crea un dateo
  - `POST /captacion-dateos/verificar-vencidos` — job manual para marcar dateos vencidos
  - `PUT /captacion-dateos/:id`, `DELETE /captacion-dateos/:id` (solo SUPER_ADMIN/GERENCIA)
  - `PATCH /captacion-dateos/:id/avance` (`toggleAvance`) — marca/desmarca el dateo como "avance" (el incentivo del convenio se aplica como descuento a la factura en vez de pagarse al asesor)
  - `GET /captacion-dateos/:id/comprobante-avance` — sirve el comprobante (screenshot) del avance
- `app/controllers/captacion_util_controller.ts`
  - `POST /captacion-dateos/auto-convenio` (`crearAutoPorConvenio`) — crea un dateo automático a partir de la base de datos de un convenio (sin pasar por el flujo manual de captura)

*Prospectos*
- `app/controllers/prospectos_controller.ts`
  - `GET /prospectos`, `POST /prospectos`, `GET /prospectos/:id`, `PUT|PATCH /prospectos/:id` — CRUD
  - `POST /prospectos/:id/asignar` — asigna un asesor al prospecto (infiere el asesor por `asesor_id` → por `asignado_por` → por el creador del prospecto; cierra la asignación activa previa)
  - `POST /prospectos/:id/retirar` — cierra la asignación activa
  - `POST /prospectos/:id/datear` — convierte el prospecto en un dateo
  - `GET /asesores/:id/resumen` (`resumenByAsesor`) — resumen de prospectos de un asesor
  - `GET /prospectos/by-placa` — busca prospecto por placa
  - `GET /prospectos/asesor/:id/list` — prospectos asignados a un asesor
- `app/controllers/asignaciones_prospectos_controller.ts` — implementa su propia versión de `asignar`/`retirar` sobre `asesor_prospecto_asignaciones`. **⚠️ No está montado — es una versión duplicada/huérfana de la lógica que realmente corre dentro de `prospectos_controller.ts`. Ver deuda técnica.**

*Convenios*
- `app/controllers/convenios_controller.ts`
  - `GET /convenios/buscar-por-nombre`, `GET /convenios/asignados` (del asesor autenticado), `GET /convenios/light`, `GET /convenios`
  - `POST /convenios` (no COMERCIAL) — crea convenio
  - `GET /convenios/:id`, `PATCH|PUT /convenios/:id` (no COMERCIAL)
  - `GET /convenios/:id/asesor-activo` — asesor de convenio actualmente asignado
  - `POST /convenios/:id/asignar` (`asignarAsesor`), `POST /convenios/:id/retirar` (`retirarAsesor`) — gestiona `asesor_convenio_asignaciones` (con flag `actualFlag` para garantizar una sola asignación activa por convenio)

**Servicios:**
- `app/services/reserva_dateo_service.ts` → `buildReserva()` / `getHorasExclusividad()` — calcula si un dateo sigue "vigente" (con exclusividad sobre esa placa/teléfono) o ya expiró. Regla: si el dateo ya fue consumido por un turno, la ventana es `consumidoAt + TTL_POST_CONSUMO_DIAS` (default 365 días, env); si no ha sido consumido, la ventana es `createdAt + horasExclusividad` (configurable en `configuracion_reserva_dateos`, default 60h, con caché en memoria de 15s). Esta función reemplazó implementaciones duplicadas que existían en `captacion_dateos_controller.ts`, `busquedas_controller.ts` y `turnos_rtms_controller.ts` — ahora las 3 leen el mismo valor. El modelo `CaptacionDateo` además expone sus propios getters computados `bloqueado`/`bloqueadoHasta` con la misma fórmula (duplicación menor, ver deuda técnica).

**Modelos / Tablas:**
- `agentes_captacions` (modelo `AgenteCaptacion`, tabla real `agentes_captacions`) — `usuarioId` (opcional: puede haber asesores sin usuario del sistema), `tipo` (`ASESOR_COMERCIAL|ASESOR_CONVENIO|ASESOR_TELEMERCADEO`), `nombre`, `telefono`, `docTipo/docNumero`, `activo`; relación N:N con `captacion_canales` vía pivot `agente_canal_membresias`
- `captacion_canales` (modelo `CaptacionCanal`) — `codigo`, `nombre`, `colorHex`, `activo`, `orden`, `deletedAt`
- `captacion_dateos` (modelo `CaptacionDateo`) — `canal`, `agenteId`, `placa`/`telefono`, `convenioId`/`asesorConvenioId`/`prospectoId`/`vehiculoId`/`clienteId`, `resultado` (`PENDIENTE|EN_PROCESO|EXITOSO|NO_EXITOSO|RE_DATEAR`), `consumidoTurnoId`/`consumidoAt`, `esAvance`/`comprobanteAvanceUrl`, `esClienteRecurrente`/`mesesDesdeUltimaVisita`, `descuentoId`, `aprobadoExcepcionPor`/`aprobadoExcepcionAt` (excepción RTM_VIGENTE aprobada por SUPER_ADMIN/GERENCIA)
- `prospectos` (modelo `Prospecto`) — `convenioId`, `placa`/`telefono`/`nombre`/`cedula`, vencimientos `soatVencimiento`/`tecnoVencimiento`/`preventivaVencimiento` (con computados de días restantes), `origen`, `creadoPor`, `archivado`
- `convenios` (modelo `Convenio`) — `tipo` (`PERSONA|TALLER|PARQUEADERO|LAVADERO`), `nombre`, `docTipo/docNumero`, `ciudadId`, `metodoPago`, `asesorConvenioId`, `ruta`/`subRuta`/`periodicidad`/`reporta` (campos importados de un Excel base), `estado` (`ACTIVO|INACTIVO|PROSPECTO`)
- `asesor_convenio_asignaciones` (modelo `AsesorConvenioAsignacion`) — `convenioId`, `asesorId`, `fechaAsignacion`/`fechaFin`, `activo`, `actualFlag` (garantiza una sola asignación activa por convenio)
- `asesor_prospecto_asignaciones` (modelo `AsesorProspectoAsignacion`) — análogo para prospectos
- `configuracion_reserva_dateos` (modelo `ConfiguracionReservaDateo`) — `horasExclusividad`
- `configuracion_recurrencia_global` (modelo `ConfiguracionRecurrenciaGlobal`) — `mesesMinimos`, valores base y por tipo de vehículo (moto/liviano) de comisión por dateo recurrente/recuperación
- `configuracion_recurrencia_asesores` (modelo `ConfiguracionRecurrenciaAsesor`) — overrides por asesor de los mismos valores, con `recurrenciaHabilitada` y `tipoVehiculo` (`MOTO|VEHICULO|AMBOS`)

**Relaciones con otros módulos:** Un dateo vigente se hereda al crear un turno (**RTM/Turnos**, ver `buildReserva`), y el cierre de un turno genera una **Comisión** con el asesor/convenio del dateo. `captacion_dateo.descuentoId` conecta con **Facturación** (`descuento`). `configuracion_recurrencia_*` es usada tanto por RTM (clasificación) como por **Comisiones** (montos). `agente_captacion.usuarioId` conecta con **Usuarios y Roles**.

**Notas de deuda técnica detectadas:**
- **`agente_canal_membresias_controller.ts` está completamente comentado** (todo el archivo, incluida la clase y el `export default`, vive dentro de un único bloque `/** ... **/`) — no exporta nada y no está montado en rutas. La gestión de canal↔agente que este archivo debería exponer (`GET/POST/PUT/DELETE` de membresías) parece no tener ninguna vía HTTP activa hoy; si el frontend necesita asignar canales a un agente, no hay endpoint funcionando para eso.
- **`captacion_canales_controller.ts`** (CRUD completo y bien implementado, con Vine validators) **no está registrado en `start/routes.ts`** — inaccesible desde el API. Junto con el punto anterior, sugiere que la gestión de canales de captación fue deprioritizada o el frontend la gestiona de otra forma no evidente en este backend.
- **`asignaciones_prospectos_controller.ts` (`asignar`/`retirar`) no está montado** — es una implementación huérfana y casi idéntica a los métodos `asignar`/`retirar` que sí están activos dentro de `prospectos_controller.ts`. Parece un refactor a medio hacer (se movió la lógica al controller principal pero no se borró el archivo viejo).
- La fórmula de "ventana de exclusividad/bloqueo" de un dateo está en dos sitios: `buildReserva()` en el servicio, y los getters `bloqueado`/`bloqueadoHasta` en `CaptacionDateo` (modelo) — mismo cálculo, dos implementaciones a mantener sincronizadas.

---

## Facturación

**Propósito:** Registra el paso de caja: confirma el pago/ticket de un turno ya atendido, aplica descuentos, y es el punto donde —para el flujo normal de un RTM— se dispara la generación de la comisión del asesor/convenio asociado.

**Controladores:**
- `app/controllers/facturacion_tickets_controller.ts` — gestiona los tickets de facturación por turno. Al **confirmar** un ticket (estado CONFIRMADA) sobre un turno de servicio RTM, genera automáticamente una comisión PENDIENTE reutilizando `comision_calculo_service` + `continuidad_service` (módulo RTM) — la misma cascada de resolución de config/recurrencia/continuidad/descuento que usa `captacion_dateos_controller.ts` (módulo Captación Comercial). **Diferencia clave de deduplicación**: aquí el dedup es "por ventana del día calendario" (evita crear una segunda comisión si se re-confirma el mismo ticket el mismo día), mientras que en `captacion_dateos_controller.ts` el dedup es "¿existió alguna vez una comisión no-config para este dateo?" (esa ruta corrige dateos días/semanas después del turno, y un dedup por día generaría duplicados al reeditar). Ambas rutas son el "espejo" una de la otra para el mismo evento de negocio (turno RTM exitoso) y deben mantenerse sincronizadas si cambia la lógica de cálculo.
- `app/controllers/comprobantes_pagos_controller.ts` — CRUD de comprobantes de pago (evidencia/soporte del pago de un ticket).
- `app/controllers/descuentos_controller.ts` — CRUD del catálogo de descuentos aplicables (códigos como AVANCE, POLICIA, EMPLEADO, OBSEQUIO, etc.) que se pueden marcar en un dateo o en un ticket de facturación.

**Servicios:** Ninguno dedicado — la lógica de generación de comisión vive duplicada dentro de `facturacion_tickets_controller.ts`, reutilizando las funciones de `comision_calculo_service.ts` y `continuidad_service.ts` (no hay un servicio propio de facturación).

**Modelos / Tablas:**
- `facturacion_tickets` (modelo `FacturacionTicket`) — `turno_id`, `estado` (ej. CONFIRMADA), montos/valores del ticket, tipo de vehículo del ticket (usado por `inferTipoVehiculoComision` con prioridad sobre el tipo del turno).
- `comprobantes_pago` (modelo `ComprobantePago`) — soporte/evidencia de pago vinculado a un ticket.
- `descuentos` (modelo `Descuento`) — `codigo`, `activo`; el código se usa en `calcularComision` (módulo Comisiones) para decidir si el monto queda en $0 (descuentos informativos como AVANCE).

**Relaciones con otros módulos:** Consume `turnos_rtms` (módulo RTM) para saber si el turno es RTM (`isRTM`) y su tipo de vehículo. Genera filas en `comisiones` (módulo Comisiones) — ver arriba el paralelismo con `captacion_dateos_controller.ts` (módulo Captación Comercial). Usa `Convenio.asesorConvenioId` (módulo Captación Comercial) para resolver el asesor convenio real. Es uno de los tres puntos de generación de comisiones del sistema, junto con `captacion_dateos_controller.ts` y `turnos_cierre_controller.ts` (ver PUNTOS DE INTEGRACIÓN CLAVE al final del documento).

---

## Comisiones y Liquidaciones

**Propósito:** Calcula, aprueba y paga las comisiones/incentivos de asesores comerciales y convenios, y agrupa los pagos ejecutados en lotes de "liquidación" para trazabilidad histórica. **Ojo:** este módulo mezcla dos conceptos de negocio distintos que comparten la palabra "liquidación" pero no tienen relación entre sí — se documentan juntos aquí solo porque comparten la palabra, no porque compartan datos:
1. **Liquidación de comisiones** (`liquidaciones`/`liquidacion_detalle`) — un lote de pago masivo a asesores/convenios, generado desde `comisiones_controller.ts`.
2. **Liquidación de trámite RUNT** (`tramite_liquidaciones`/`liquidacion_pagos`) — el desglose de costos (retención, derechos de traspaso, paz y salvo, honorarios, impuestos, etc.) que paga el **cliente** por un trámite, con sus abonos/pagos parciales. Pertenece conceptualmente al módulo Trámites RUNT, no a Comisiones — no confundir con lo anterior.

**Controladores:**

*Comisiones (`app/controllers/comisiones_controller.ts`)*
- `GET /comisiones` (SUPER_ADMIN, GERENCIA, CONTABILIDAD, COMERCIAL) — listado con filtros.
- `GET /comisiones/resumen` / `GET /comisiones/resumen-por-asesor` — agregados generales y por asesor.
- `GET /comisiones/metas-mensuales` — metas mensuales por asesor.
- `GET /comisiones/:id` (SUPER_ADMIN, GERENCIA, CONTABILIDAD) — detalle.
- `PATCH /comisiones/:id/editar` (`editar`) — edición manual de una comisión.
- `PATCH /comisiones/:id/valores` (`actualizarValores`) — ajusta montos puntuales de una comisión ya calculada.
- `POST /comisiones/:id/aprobar` — pasa una comisión PENDIENTE a APROBADA.
- `POST /comisiones/:id/pagar` — pasa una comisión a PAGADA (individual).
- `POST /comisiones/:id/anular` — anula una comisión no PAGADA, registrando motivo/observación.
- `POST /comisiones/pagar-masivo` (`pagarMasivo`) — acción en lote sobre un array de `ids`: `APROBAR` (solo afecta PENDIENTE) o `PAGAR` (afecta PENDIENTE/APROBADA, auto-aprobando si hacía falta). Cuando la acción es `PAGAR` y el lote incluye comisiones de servicio RTM, **crea automáticamente un registro `Liquidacion` + sus `LiquidacionDetalle`** (uno por cada pago ejecutado) como historial agrupado — el `tipo_origen` (`MODAL_LIQUIDAR|TABLA_GENERAL|PANEL_ASESOR`) lo declara el frontend según desde dónde se disparó la acción, porque el backend no puede inferirlo solo de los `ids`.
- `POST /comisiones` (`store`) (SUPER_ADMIN, GERENCIA, CONTABILIDAD) — creación manual.
- `GET/POST/PATCH/DELETE /comisiones/config[...]` — CRUD de configuración de comisión (filas `es_config=true` en la misma tabla `comisiones`, consumidas por `resolveConfigComision`).
- `POST /comisiones/simular` (`simularComision`) — dry-run que ejecuta `calcularComision` sin persistir.
- `GET/POST/PATCH/DELETE /comisiones/metas[...]` — CRUD de metas comerciales.
- `GET/POST /comisiones/recurrencia/config/global`, `GET/POST/DELETE /comisiones/recurrencia/config/asesores[...]` — configuración de recurrencia global y por asesor.

*Liquidación de trámite RUNT (`app/controllers/liquidacion_pagos_controller.ts` y `app/controllers/tramite_liquidaciones_controller.ts`)*
- `GET /tramites/:tramiteId/liquidacion` (`getByTramite`) — obtiene (o devuelve una plantilla vacía) el desglose de costos de un trámite.
- `PUT /tramites/:tramiteId/liquidacion` (`upsert`) — crea/actualiza los 9 conceptos de costo (`retencion`, `derechosTraspaso`, `pazSalvo`, `levantamientoPrenda`, `inscripcionPrenda`, `papeleria`, `honorarios`, `impuestoAnioActual`, `impuestoAniosVencidos`); rechaza valores negativos.
- `GET /tramites/:tramiteId/liquidacion/export-pdf` (`exportLiquidacionPdf`) — genera un PDF de la liquidación con logo, tabla de conceptos y estado de pago del trámite.
- `GET /tramites/liquidacion-historial` (`getHistorialTurno`) — historial de pagos/saldo de todos los trámites de un turno específico (sede+fecha+número de turno).
- `POST /tramites/liquidacion/:tramiteLiquidacionId/pago` (`registrarPago`) — registra un abono/pago parcial o total: valida que la liquidación tenga valores, que el monto no exceda el saldo pendiente, sube evidencia opcional (imagen/PDF), y genera un **PDF de comprobante de pago** (con historial de abonos y estado PAGADO/ABONO PARCIAL) que queda servible vía `GET /tramites/liquidacion-pago/:liquidacionPagoId/pdf` (`getPagoPdf`).
- `GET /tramites/reporte-caja` (`getReporteCaja`) — reporte de caja por rango de fechas: agrupa todos los pagos del período por liquidación/trámite, con saldo pendiente real (contra el historial completo, no solo el período) y totales desglosados por forma de pago.

**Servicios:**
- `app/services/comision_calculo_service.ts` — **el motor de cálculo de comisiones**, única fuente de verdad compartida por `facturacion_tickets_controller.ts` y el simulador dry-run (`POST /comisiones/simular`); `captacion_dateos_controller.ts` tiene su propia implementación paralela más simple que no pasa por este servicio (ver deuda técnica). Exporta:
  - `isRTM(codigo, nombre)` — heurística de texto (`RTM`, `TECNOMECANICA`, o "REVISION"+"TECNICO") para decidir si un servicio cuenta como RTM.
  - `inferTipoVehiculoComision({ticketTipo, turnoTipo})` — `MOTO` si el texto contiene "MOTO", si no `VEHICULO`; prioriza el tipo del ticket sobre el del turno.
  - `resolveConfigComision({asesorId, asesorConvenioId, tipoVehiculo})` — resuelve por cascada de especificidad decreciente (asesor+tipo → asesor sin tipo → tipo sin asesor → global) los valores: `valorDateoNuevo`/`valorNuevoDirecto` (config del comercial) y `valorIncentivo`/`valorIncentivoPorTipo`/`valorIncentivoCaso3` (config del incentivo del convenio, con la regla especial de que el Caso 3 —comercial+convenio— **nunca** cae al campo `base` propio del convenio, solo a Global, para no confundirlo con el valor de self-dateo del Caso 2).
  - `resolveConfigRecurrencia(asesorId, tipoVehiculo)` — resuelve `valorRecurrente`/`valorRecuperacion` (global por defecto moto/vehículo, con override por asesor si `recurrencia_habilitada`).
  - `calcularComision(params)` — función pura (sin BD) que implementa la matriz completa de reglas: **Caso 1 `SIN_CONVENIO`** (nuevo→`valorNuevoDirecto` o $0 si hay descuento informativo; recurrente/recuperación→`valorRecurrente`, siempre igual monto para ambos escenarios). **Caso 2 `CONVENIO_SELF`** (el propio asesor convenio datea: avance→$0 con `descuentoMontoAplicado`; descuento especial en caja→$0; nuevo→incentivo base con "continuidad automática"; recurrente/recuperación→incentivo base si `tuvoContinuidad`, si no cae a `valorRecurrente`). **Caso 3 `CONVENIO_COMERCIAL`** (un comercial datea a nombre de un convenio ajeno: paga doble — `montoAsesor` al comercial con `valorDateoNuevo`/`valorRecurrente` según escenario, y `montoConvenio` con `valorIncentivoCaso3`, salvo que haya avance o descuento especial en caja, donde `montoConvenio` queda en $0). Devuelve además `reglaAplicada` (string legible de qué rama se ejecutó) para depuración/auditoría.

**Modelos / Tablas:**
- `comisiones` (modelo `Comision`) — filas de dos tipos según `es_config`: `false` = comisión real (`captacion_dateo_id`/`turno_id`, `asesor_id`, `asesor_secundario_id`, `convenio_id`, `monto_asesor`, `monto_convenio`, `monto`, `base`, `estado` PENDIENTE/APROBADA/PAGADA/ANULADA, `aprobado_at/por`, `pagado_at/por`, `anulado_at/por`, `es_avance`, `descuento_monto_aplicado`); `true` = fila de configuración (sin `captacion_dateo_id`, con `valor_placa_moto`/`valor_placa_vehiculo`/`valor_nuevo_directo`/`base` como parámetros).
- `liquidaciones` (modelo `Liquidacion`) — `fecha_inicio`/`fecha_fin`, `tipo_origen` (MODAL_LIQUIDAR/TABLA_GENERAL/PANEL_ASESOR), `tipo_periodo` (solo si origen=MODAL_LIQUIDAR), `monto_total`, `cantidad_comisiones`, `usuario_id` (quién ejecutó el pago masivo).
- `liquidacion_detalle` (modelo `LiquidacionDetalle`) — `liquidacion_id`, `comision_id`, `monto` (snapshot del monto pagado de esa comisión en ese lote).
- `tramite_liquidaciones` (modelo `TramiteLiquidacion`) — `tramite_id` (1:1), los 9 conceptos de costo del trámite.
- `liquidacion_pagos` (modelo `LiquidacionPago`) — `tramite_liquidacion_id`, `fecha`, `monto`, `forma_pago`, `referencia_pago`, `evidencia_url`, `pdf_path` (comprobante generado).
- `configuracion_recurrencia_global` / `configuracion_recurrencia_asesor` — ver módulo Captación Comercial (compartidas).

**Relaciones con otros módulos:** Comisiones se generan desde **tres puntos distintos no unificados entre sí**: `captacion_dateos_controller.ts` (módulo Captación Comercial, dedup "¿existió alguna vez?"), `facturacion_tickets_controller.ts` (módulo Facturación, dedup por ventana del día calendario) y `turnos_cierre_controller.ts` (módulo RTM, cálculo simplificado sin `comision_calculo_service` — ver deuda técnica en RTM). Depende de `convenios`/`asesor_convenio_asignaciones` (módulo Captación Comercial) y de `continuidad_service` (módulo RTM) para resolver caso y continuidad. La liquidación de trámite RUNT depende de `tramites` (módulo Servicios/Trámites RUNT).

**Notas de deuda técnica detectadas:**
- `captacion_dateos_controller.ts` genera comisiones con una implementación **paralela y más simple** a `comision_calculo_service.ts` (no modela continuidad de la misma forma explícita) — confirmar si esto es intencional (dateo manual vs. flujo de caja) o deuda pendiente de unificar.
- El nombre "liquidación" se usa para dos entidades de negocio no relacionadas (pago a asesores vs. costo de trámite al cliente) — alto riesgo de confusión para quien lea el código o la base de datos sin este documento.

---

## Servicios, Tarifas y Trámites (RUNT)

**Propósito:** Mantiene el catálogo de servicios que presta la sede (RTM, preventiva, peritaje, trámites) y sus tarifas, y gestiona el flujo independiente de "trámites" administrativos ante RUNT (traspasos, matrículas, cambios, etc.) con su propio turno, checklist documental y formulario RUNT detallado.

**Controladores:**
- `app/controllers/servicios_controller.ts`
  - `GET /servicios` — catálogo simple de servicios (id/código/nombre) para selects
- `app/controllers/tarifas_servicios_controller.ts`
  - `GET /tarifas-servicios` — lista tarifas con código/nombre del servicio unido
  - `POST /tarifas-servicios` — crea/actualiza (upsert por `servicio_id`+`tipo_vehiculo`) valor base y total
  - `PUT /tarifas-servicios/:id`, `DELETE /tarifas-servicios/:id` — CRUD
- `app/controllers/tarifas_tramites_controller.ts`
  - `GET /tarifas/tramite?tipo=&clase=` — resuelve la tarifa vigente más específica para un trámite: primero busca `tipo_tramite`+`clase_vehiculo` exactos, si no hay cae a la tarifa genérica con `clase_vehiculo IS NULL`
- `app/controllers/tramites_controller.ts`
  - `GET /tramites/siguiente-numero` — próximo número de turno de trámites (independiente de la numeración de turnos RTM)
  - `GET /tramites` — listado
  - `GET /tramites/:id` — detalle
  - `POST /tramites` — crea un trámite con su propio turno consecutivo por sede+fecha (usa `FOR UPDATE` para evitar condiciones de carrera en la numeración, y códigos con milisegundos+random para evitar colisión); si ya existe un trámite con la misma cédula ese día en la sede, no bloquea pero devuelve una advertencia
  - `PUT /tramites/:id` — actualiza
  - `POST /tramites/:id/pago` (`registrarPago`) — registra el pago (forma de pago, fecha, referencia, evidencia adjunta), pasa `estadoPago` a `pagado`
  - `POST /tramites/:turnoNumero/agregar` (`agregarATurno`) — agrega un trámite adicional a un turno RTM ya existente (comparte turno/placa con un turno normal)
- `app/controllers/tramite_checklists_controller.ts`
  - `GET /tramites/checklist?sedeId=&fecha=&turnoNumero=` (`getByTurno`) — checklist documental de un turno (tarjeta de propiedad, SOAT, RUNT vendedor/comprador, antecedentes, prenda, cámara de comercio, etc.)
  - `PUT /tramites/checklist` (`upsert`) — crea o actualiza el checklist de un turno
- `app/controllers/formularios_runt_controller.ts`
  - `GET /tramites/:tramiteId/formulario-runt` (`show`), `PUT /tramites/:tramiteId/formulario-runt` (`upsert`) — formulario RUNT extendido (datos del vehículo, propietario, comprador si es traspaso, importación, alertas de hurto/embargo, regrabado de motor/chasis/serie, mandatario)
  - `GET /tramites/:tramiteId/mandato/export-excel`, `GET /tramites/:tramiteId/paquete/export-excel`, `GET /tramites/:tramiteId/formulario-runt/export-excel` — exportan a Excel el mandato, el "paquete completo" y el formulario RUNT respectivamente (formatos que RUNT/la notaría exige físicamente)

**Servicios:** Lógica de negocio vive directamente en los controladores (no hay servicio dedicado). El único patrón "tipo servicio" reutilizable es la resolución de tarifa vigente en `tarifas_tramites_controller.ts` (específica → genérica) y `TarifaServicio.findByServicioYTipo()` (método estático en el modelo, usado como helper equivalente para tarifas de servicio por tipo de vehículo).

**Modelos / Tablas:**
- `servicios` (modelo `Servicio`) — `codigoServicio` (`RTM|PREV|PERI|SOAT|TRAMITES`), `nombreServicio`. Es el catálogo raíz que referencian casi todos los demás módulos.
- `tarifas_servicios` (modelo `TarifaServicio`) — `servicioId`, `tipoVehiculo` (`MOTO|VEHICULO`), `valorBase`, `valorTotal`, `activo`, `vigenciaDesde`
- `tarifas_tramites` (modelo `TarifaTramite`) — `tipoTramite`, `claseVehiculo` (nullable = aplica a todas las clases), `valor`, `vigenciaDesde`
- `tramites` (modelo `Tramite`) — `sedeId`, `funcionarioId`, `servicioId`, datos del solicitante (`nombreCliente`, `cedula`, `telefono`, `email`), `turnoNumero`/`turnoCodigo` (numeración propia, no comparte secuencia con `turnos_rtms`), `placa`, `tipoTramite` (enum largo: MATRICULA_REGISTRO, TRASPASO, CAMBIO_COLOR, REGRABAR_MOTOR/CHASIS, etc.), `estado` (`en_espera|en_atencion|completado|cancelado`), `estadoPago`/`valorLiquidado`/`formaPagoCobro`/`evidenciaPagoUrl`, campos específicos de traspaso (`valorVehiculo`, `destrate`, `incluyeCompraventa`)
- `tramite_checklists` (modelo `TramiteChecklist`) — clave por `sedeId`+`fecha`+`turnoNumero` (no por `tramiteId` — ver relación con RTM abajo), ~13 booleans de documentos requeridos
- `formularios_runt` (modelo `FormularioRunt`) — `tramiteId` (1 a 1), decenas de campos del formulario oficial RUNT: vehículo, propietario, comprador, importación, alertas, regrabado, mandatario

**Relaciones con otros módulos:** `tramite.servicioId`/`tramite.sedeId`/`tramite.funcionarioId` conectan con **Servicios** y **Usuarios**. Curiosamente `tramite_checklists` se referencia por `sedeId`+`fecha`+`turnoNumero`, el mismo patrón de clave que usa `turnos_rtms` — sugiere que el checklist en realidad documenta el turno RTM (trámite asociado a un turno físico), no el registro de la tabla `tramites` en sí (que tiene su propia numeración independiente). `tarifas_tramites`/`tarifas_servicios` alimentan **Comisiones/Liquidaciones** (`tramite_liquidaciones`, `liquidacion_pagos`) para calcular lo que se le liquida al tramitador.

**Notas de deuda técnica detectadas:**
- Hay **dos numeraciones de turno independientes y paralelas** en el sistema: la de `turnos_rtms` (RTM/servicios operativos) y la de `tramites` (trámites RUNT), cada una con su propia secuencia por sede+fecha. `tramite_checklists` usa `turnoNumero`+`fecha`+`sedeId` como clave, lo cual es ambiguo si no se documenta explícitamente a cuál de las dos secuencias se refiere en cada caso de uso — un motivo más para no asumir nada sin verificar el frontend que consume este endpoint.
- `POST /tramites` no bloquea la creación de un trámite duplicado (misma cédula, misma sede, mismo día) — solo devuelve un campo `advertencia` informativo en la respuesta. Es una decisión de producto (permitir duplicados con aviso), no un bug, pero vale la pena saberlo si se espera que el backend rechace duplicados.

---

## Reportes Administrativos

**Propósito:** Es la capa de inteligencia de negocio: agrega datos de RTM, Facturación, Captación y Comisiones para producir los reportes gerenciales (producción, ingresos, retención, metas comerciales) y el "Súper Informe" consolidado en PDF. No tiene tablas propias de datos operativos — solo tablas de configuración de metas.

**Controlador:** `app/controllers/reportes_administrativos_controller.ts` — con diferencia el controlador más grande del sistema (~6100 líneas, ~40 endpoints). Todas las rutas cuelgan del prefijo `/reportes-admin` y requieren roles SUPER_ADMIN, GERENCIA o CONTABILIDAD. Se apoya en consultas SQL crudas (`Database.rawQuery`/`Database.from`) sobre `turnos_rtms`, `facturacion_tickets`, `comisiones`, `captacion_dateos`, `descuentos` — no hay modelos Lucid propios de este módulo.

**Endpoints (agrupados por sub-reporte):**

*Producción e ingresos*
- `GET /ingresos-canal` (`ingresosPorCanal`) — ingresos agrupados por canal de atribución
- `GET /produccion-lider` (`produccionPorLider`) — producción de turnos finalizados agrupada por líder/sede
- `GET /asesores` (`reporteAsesores`) — producción por asesor (comercial o convenio); el nombre se resuelve con `COALESCE(agente_comercial_nombre, asesor_convenio_nombre)` porque `facturacion_tickets` solo llena uno u otro según el canal
- `GET /detalle-asesor`, `GET /detalle-canal` — drill-down transaccional de los dos reportes anteriores
- `GET /retencion` (`retencionClientes`), `GET /detalle-retencion` — retención de clientes (clientes recurrentes vs. nuevos) y su detalle
- `GET /servicios` (`reporteServicios`) — producción por tipo de servicio

*Descuentos*
- `GET /descuentos-por-tipo`, `GET /descuentos-por-canal`, `GET /descuentos-por-autorizador`, `GET /detalle-descuentos` — desglose del catálogo de `descuentos` aplicado, por tipo/canal/quién lo autorizó, con detalle transaccional

*Comisiones y liquidación*
- `GET /comisiones` (`reporteComisiones`), `GET /detalle-comisiones` — resumen y detalle de comisiones generadas
- `GET /liquidacion-rtm`, `GET /liquidacion-rtm/excel` — liquidación RTM (lo que se le paga a cada asesor/convenio) y su export a Excel
- `GET /historial-liquidaciones`, `GET /historial-liquidaciones/:id`, `GET /historial-liquidaciones/excel` — historial de corridas de liquidación ya cerradas
- `GET /trazabilidad-rtm`, `GET /trazabilidad-rtm/excel` — traza turno→dateo→comisión→liquidación para auditoría

*Meta Mensual (producción operativa, en unidades de vehículo)*
- `GET|POST /meta-mensual/config` — lee/actualiza `configuracion_meta_mensual` (meta de livianos/motos por mes)
- `GET /meta-mensual/resumen`, `/diario`, `/semanal`, `/proyectado`, `/rango` — avance de la meta con distintos cortes temporales, con *fallback* a `historico_meta_diario` para meses sin datos reales en `turnos_rtms`
- `GET /super-informe/meta-mensual` (`metaMensualSuperInforme`) — bloque de Meta Mensual embebido en el Súper Informe

*Meta Comercial (por asesor, en pesos — distinto de Meta Mensual)*
- `GET|POST /meta-comercial/config` — lee/actualiza `meta_comercial_asesor` (tabla sin modelo Lucid, accedida vía query builder crudo)
- `GET /meta-comercial/resumen`, `/diario`, `/semanal`, `/proyectado` — avance de meta comercial en pesos por asesor tipo ASESOR_COMERCIAL, con proyección de cierre; fuente = `comisiones` para el mes en curso, o `historico_comercial_asesor`/`historico_comercial_vehiculo_mensual` (tablas sin modelo Lucid) para meses ya cerrados
- `GET /meta-comercial/detalle-vehiculo`, `GET /meta-comercial/ingreso-real-dateo` — drill-down por vehículo/dateo
- `GET /super-informe/meta-comercial` (`metaComercialSuperInforme`) — bloque de Meta Comercial embebido en el Súper Informe

*Súper Informe (PDF consolidado) y reconciliación*
- `GET /super-informe/pdf` (`superInformePdf`) — genera un PDF (vía `pdfkit`, según los imports) con múltiples secciones: Meta Mensual, Meta Comercial por Asesor, y más, cada una con su fuente de datos documentada en el propio código
- `GET /super-informe/reconciliacion-rtm` (`superInformeReconciliacionRtm`) — **reconciliación Facturación↔RTM**: parte cada turno RTM finalizado del rango (excluyendo placas `TST%` de prueba) en EXACTAMENTE una categoría mutuamente excluyente (`CON_FACTURA_RTM`, `TICKET_OTRO_SERVICIO`, el estado de su ticket más reciente si no está confirmado, o `SIN_TICKET`), de forma que `pendientes_total + con_factura_confirmada_rtm === turnos_reales_total` sea una garantía matemática del propio SQL, no una suma manual — pensado explícitamente para que Gerencia audite cuántos turnos RTM completados aún no tienen factura confirmada.

**Servicios:** Ninguno — toda la agregación vive en el controlador, con SQL crudo extensivo.

**Modelos / Tablas propias:** Ninguna con modelo Lucid. Escribe/lee directamente `configuracion_meta_mensual` (sí tiene modelo, ver módulo RTM), y las tablas sin modelo `meta_comercial_asesor`, `historico_comercial_asesor`, `historico_comercial_vehiculo_mensual` (confirmado con `Grep`: se acceden solo vía `Database.from(...)` en este controlador).

**Relaciones con otros módulos:** Es un consumidor puro — lee de **RTM** (`turnos_rtms`), **Facturación** (`facturacion_tickets`), **Captación** (`captacion_dateos`), **Comisiones** (`comisiones`), y usa `configuracion_meta_mensual`/`historico_meta_diario` (RTM) y `configuracion_recurrencia_*` (Captación) indirectamente a través de las mismas reglas de negocio ya aplicadas en esas tablas. Es el mejor punto de partida para entender cómo se cruzan todos los módulos operativos (ver PUNTOS DE INTEGRACIÓN CLAVE al final del documento).

**Notas de deuda técnica / observaciones:**
- Un solo controlador de ~6100 líneas y ~40 endpoints es, en sí mismo, la pieza de mayor riesgo de mantenimiento del backend: cualquier cambio en una regla de negocio compartida (ej. qué cuenta como "turno real", qué es una placa de prueba `TST%`) debe replicarse manualmente en cada método relevante, ya que no hay un helper único de "turnos reales del período" reutilizado por todos los reportes.
- Confirma la sospecha del módulo RTM: `meta_comercial_asesor`, `historico_comercial_asesor` e `historico_comercial_vehiculo_mensual` no tienen modelo Lucid — cualquier cambio de esquema en esas tablas no será detectado por el compilador de TypeScript, solo en runtime.

---

## Certificaciones

**Propósito:** Registra la evidencia fotográfica de que un turno fue certificado (revisado/aprobado físicamente) antes de finalizarlo — es el paso final de cierre de un turno cuando requiere una foto de respaldo.

**Controladores:**
- `app/controllers/certificaciones_controller.ts`
  - `POST /api/certificaciones` (`store`) — recibe `turno_id` + una imagen (jpg/jpeg/png, máx 8MB), la guarda en `uploads/certificaciones/`, crea el registro `Certificacion`, y **como efecto secundario finaliza el turno**: calcula `tiempoServicio` (diferencia entre `horaIngreso` y el momento de certificar), fija `horaSalida`, pasa `estado = 'finalizado'` y escribe `certificacionFuncionarioId` con el usuario autenticado que certificó.
  - `GET /api/certificaciones/turno/:turnoId` (`showByTurno`) — devuelve la certificación más reciente de un turno.

**Servicios:** Ninguno dedicado — lógica simple contenida en el controlador.

**Modelos / Tablas:**
- `certificaciones` (modelo `Certificacion`) — `turno_id` (FK con `ON DELETE CASCADE`), `usuario_id` (quien certificó, `ON DELETE SET NULL`), `imagen_path`, `observaciones`.

**Relaciones con otros módulos:** Pertenece por completo al ciclo de vida de un turno (módulo RTM): `Certificacion.turnoId` → `turnos_rtms`, y `store()` es una de las (al menos tres) rutas que pueden finalizar un turno (junto con `registrarSalida` en `turnos_rtms_controller.ts` y `cerrar` en `turnos_cierre_controller.ts` — no está confirmado si estas rutas son mutuamente excluyentes en el flujo real del frontend o si puede haber solapamiento).

**Nota importante — corrige una suposición previa:** se pensaba que `certificacion_funcionario_id` (en `turnos_rtms`) era una columna muerta. **No lo es**: `certificaciones_controller.store()` la escribe activamente cada vez que se certifica un turno (línea ~120, `certificacionFuncionarioId: usuario?.id ?? null`), y se precarga junto con `facturacionFuncionarioId` en `index`/`show` de `turnos_rtms_controller.ts` para mostrar quién certificó cada turno. Si en producción aparece vacía con más frecuencia de la esperada, la causa más probable es que el flujo de certificación (subir foto) simplemente no se usa siempre — no que el código no la escriba.

---

## Utilidades Transversales (Búsqueda, OCR, Uploads)

**Propósito:** Tres utilidades de soporte usadas por varios módulos operativos: una búsqueda unificada por placa/teléfono que sirve de "punto de entrada" al flujo comercial/RTM, lectura automática (OCR) de tiquetes de facturación externos, y almacenamiento genérico de imágenes subidas.

**Controladores:**
- `app/controllers/busquedas_controller.ts`
  - `GET /api/buscar?placa=|telefono=` (`unificada`) — el endpoint que probablemente dispara el frontend en el mostrador cuando llega un vehículo/cliente. Busca vehículo+cliente, y luego resuelve en cascada de prioridad: **(1)** si hay un dateo reciente aún vigente (`buildReserva`, módulo Captación Comercial) para esa placa/teléfono → devuelve `fuente: 'DATEO'` con el asesor/convenio sugerido; **(2)** si no, pero existe un prospecto con convenio asociado para esa placa/teléfono → **crea automáticamente un dateo nuevo** (`detectadoPorConvenio: true`) y devuelve `fuente: 'CONVENIO'`; **(3)** si nada de eso aplica, intenta detectar un asesor por el teléfono ingresado (búsqueda directa en `agentes_captacions.telefono`) y devuelve `fuente: 'FACHADA'` con `asesorDetectado`/`captacionSugerida` como sugerencia para que el operador decida el canal manualmente. También agrega `ultimaVisita` (último turno de esa placa/cliente, cualquier estado — no filtra por finalizado, ver deuda técnica) en todos los casos.
- `app/controllers/ocr_controller.ts`
  - `POST /api/ocr/parse-ticket` (`parseTicket`) — recibe una foto de un tiquete físico (probablemente del sistema TECNOBASE/caja) y extrae campos estructurados (placa, NIT, PIN, marca, vendedor, prefijo/consecutivo de factura, fecha/hora, subtotal, IVA, total) usando Tesseract.js. Tiene un extractor **especializado para el formato "Activautos"** (detecta la plantilla por texto `activautos.com|TIQUETE POS NO`) más un extractor genérico de respaldo. Combina dos estrategias: lectura de texto completo + lectura por regiones de interés (ROI, recortando la imagen alrededor de cada etiqueta) para mayor precisión, incluyendo un "multipass" con voto por mayoría dígito a dígito específicamente para el PIN (por la ambigüedad OCR 0↔8). Incluye heurísticas manuales para corregir errores típicos de OCR en fechas (años como "26XX"→"20XX", meses >12, días >31).
- `app/controllers/uploads_controller.ts`
  - `POST /api/uploads/images` (`uploadImage`) — sube una imagen genérica (jpg/jpeg/png/webp/heic/heif, máx 8MB) a `uploads/dateos/{año}/{mes}/{cuid}.ext` y devuelve su URL pública. Pese al nombre de carpeta (`dateos`), es un endpoint genérico reutilizado por cualquier flujo que necesite subir una imagen (no está atado únicamente a `captacion_dateos`).
  - `GET /api/uploads/*` (`serve`) — sirve cualquier archivo bajo `uploads/` por wildcard, con sanitización de segmentos de ruta para evitar path traversal (`../`).
  - `DELETE /api/uploads/*` (`remove`) — elimina un archivo subido por wildcard, con la misma sanitización.

**Servicios:** Ninguno dedicado — toda la lógica (incluida la del OCR, bastante extensa) vive dentro de los propios controladores.

**Modelos / Tablas:** Ninguno propio — `busquedas_controller.ts` opera sobre modelos de otros módulos (`Vehiculo`, `Cliente`, `CaptacionDateo`, `AgenteCaptacion`, `Prospecto`, `Convenio`, `AsesorConvenioAsignacion`, `TurnoRtm`); `ocr_controller.ts` y `uploads_controller.ts` no tocan la base de datos, solo el sistema de archivos.

**Relaciones con otros módulos:** `busquedas_controller.ts` es un punto de integración clave por sí mismo — cruza **Captación Comercial** (dateos, prospectos, convenios, agentes) con **Vehículos y Clientes** y **RTM** (última visita) en una sola respuesta, y puede **crear un `CaptacionDateo`** como efecto secundario de una simple búsqueda (caso `fuente: 'CONVENIO'`). `ocr_controller.ts` probablemente alimenta el flujo de **Facturación** (pre-llenar un ticket a partir de una foto), aunque no se encontró en este controller una escritura directa a `facturacion_tickets` — el resultado del OCR se devuelve al frontend para que este decida qué hacer con los campos extraídos.

**Notas de deuda técnica detectadas:**
- `getUltimaVisita()` en `busquedas_controller.ts` no filtra por `estado = 'finalizado'` (a diferencia de la recomendación general del módulo RTM) — puede devolver como "última visita" un turno `activo`/`cancelado`/`inactivo`, lo cual podría confundir al operador de mostrador sobre si el cliente realmente completó un servicio antes.
- El caso `fuente: 'CONVENIO'` de `unificada()` crea un `CaptacionDateo` como efecto secundario de un `GET` (una búsqueda) — no es una operación idempotente ni sigue la semántica REST esperada de un `GET`; repetir la misma búsqueda podría (dependiendo de la ventana de exclusividad) crear dateos adicionales si el primero no llega a bloquear a tiempo.

---

## Usuarios, Roles y Catálogos Base

**Propósito:** Autenticación, gestión de la ficha de cada usuario del sistema (empleado con acceso), su rol de acceso, y los catálogos de referencia simples (sedes, cargos, ciudades, razones sociales, entidades de salud, clases de vehículo) que alimentan selectores en todo el resto de módulos.

**Controladores:**

*Autenticación*
- `app/controllers/auth_controller.ts`
  - `POST /login` — autentica por `correo`+`password` (hash `scrypt` vía `withAuthFinder`), precarga `rol` y `agenteCaptacion`, y crea un token bearer (`Usuario.accessTokens`, prefijo `oat_`, expira en 30 días, tabla `auth_access_tokens`).
  - `GET /auth/me` — devuelve el usuario autenticado con `rol` y `agenteId`.
  - `logout` — revoca el token actual (método existe en el controller; **no se encontró ruta montada para `logout` en `start/routes.ts`** — ver deuda técnica).
  - `POST /forgot-password`, `POST /reset-password` — **están ruteadas pero NO implementadas**: ambos métodos son literalmente `throw new Error('Method not implemented.')`. Cualquier intento de recuperar contraseña por estas vías falla con error 500. Ver deuda técnica.

*Usuarios*
- `app/controllers/usuarios_controller.ts`
  - `GET /usuarios` (roles: SUPER_ADMIN, GERENCIA, TALENTO_HUMANO, OPERATIVO_TURNOS) — lista usuarios (filtrable por `razon_social_id`) con **todas** sus relaciones precargadas (rol, razón social, sede, cargo, EPS/ARL/AFP/AFC/CCF, y todos sus contratos con eventos/pasos/historial/cambios) — respuesta pesada por diseño.
  - `POST /usuarios` (SUPER_ADMIN, GERENCIA, TALENTO_HUMANO) — crea usuario; después de guardar, **sincroniza automáticamente un `AgenteCaptacion`** si el rol asignado es COMERCIAL/ASESOR CONVENIO/TELEMERCADEO (`syncAgenteConUsuario` — ver detalle abajo).
  - `GET /usuarios/:id`, `PUT /usuarios/:id` (mismos roles) — detalle/actualización; update también re-ejecuta `syncAgenteConUsuario`.
  - `DELETE /usuarios/:id` (solo SUPER_ADMIN, GERENCIA) — elimina usuario y su foto de perfil en disco.
  - `POST /usuarios/:id/upload-photo` (SUPER_ADMIN, GERENCIA, TALENTO_HUMANO) — sube/reemplaza foto de perfil.
  - Métodos selectores (`getRoles`, `getRazonesSociales`, `getSedes`, `getCargos`, `getEntidadesSalud`) — **no se encontraron rutas propias para estos métodos**; los selectores reales que expone `start/routes.ts` (`/roles`, `/razones-sociales`, `/sedes`, `/entidades-saluds`, `/cargos`) apuntan a los controladores dedicados de abajo, no a estos métodos de `UsuariosController` — parecen código muerto duplicado.
  - **`syncAgenteConUsuario()` (privado)** — lógica de negocio no trivial: si el nombre del rol asignado indica un perfil comercial, crea/actualiza el `AgenteCaptacion` vinculado 1:1 al usuario (por `usuarioId`, con fallbacks por `agenteId` guardado o por coincidencia exacta de nombre para no duplicar agentes creados manualmente). Si el agente ya existe con un `tipo` distinto al que ahora indica el rol, **no lo sobrescribe** (solo actualiza datos básicos) para evitar romper convenios ya vinculados. Si el agente es `ASESOR_CONVENIO`, además sincroniza el `nombre` del `Convenio` asociado (`asesor_convenio_id`) para que coincida con el nombre del usuario.
- `app/controllers/roles_controller.ts`
  - `GET /roles` — selector de roles (`id`, `nombre`), filtrable por texto.
  - `show` (por id) — **no está montado en rutas** (solo `index` vía el array `selectors` de `routes.ts`).
- Selectores simples de catálogo (patrón idéntico: `index()` devuelve `id`+`nombre` ordenado, montados vía el array `selectors` de `start/routes.ts` en `/roles`, `/razones-sociales`, `/sedes`, `/entidades-saluds`, `/ciudades`, `/cargos`):
  - `app/controllers/sedes_controller.ts`, `app/controllers/razones_sociales_controller.ts` (+ `GET /razones-sociales/:id/usuarios`), `app/controllers/cargos_controller.ts`, `app/controllers/ciudades_controller.ts` (+ `GET /ciudades/:id`), `app/controllers/entidades_saluds_controller.ts` (+ `GET /entidades-salud/:id`).
- `app/controllers/clases_vehiculos_controller.ts` — único catálogo base con CRUD completo (`GET/POST/PUT/DELETE /clases-vehiculo[/:id]`), no solo selector — probablemente porque las clases de vehículo (Liviano Particular/Taxi/Público/Motocicleta) se gestionan como datos de negocio, no solo de referencia estática.

**Servicios:** Ninguno dedicado.

**Modelos / Tablas:**
- `usuarios` (modelo `Usuario`, con mixin `withAuthFinder` de `@adonisjs/auth` para autenticación) — `razon_social_id`, `rol_id`, `cargo_id`, `sede_id`, `agente_id` (1:1 con `AgenteCaptacion`), `correo` (uid de login), `password` (hash scrypt, nunca serializado), `numero_documento`, `tipo_sangre`, contacto de emergencia, `eps_id`/`arl_id`/`afp_id`/`afc_id`/`ccf_id` (FKs a `entidades_salud`), `estado` (activo/inactivo).
- `roles` (modelo `Rol`) — solo `id`+`nombre`; la autorización real por endpoint compara este `nombre` (string, mayúsculas) contra una lista hardcodeada por ruta en `start/routes.ts` (`check_role_middleware.ts`) — ver deuda técnica sobre el sistema de permisos granular no usado.
- `permisos`/`items`/`permiso_items`/`rol_permiso_items` (modelos `Permiso`, `Item`, `PermisoItem`, `RolPermisoItem`) — modelan un sistema de permisos granular (rol × item × acción) que **no se encontró referenciado por ningún controller ni por `check_role_middleware.ts`** — parece infraestructura preparada pero no conectada al flujo real de autorización.
- `sedes` (modelo `Sede`), `cargos` (modelo `Cargo`), `ciudades` (modelo `Ciudad`), `razones_sociales` (modelo `RazonSocial`), `entidades_salud` (modelo `EntidadSalud`, con `tipo` para distinguir EPS/ARL/AFP/AFC/CCF), `clases_vehiculos` (modelo `ClaseVehiculo`) — catálogos de referencia, todos `id`+`nombre` (+ `tipo` en entidades de salud, + `codigo` en clases de vehículo).
- `password_resets` (modelo `PasswordReset`) — existe la tabla/modelo pero **no hay lógica que la use** (coherente con que `forgotPassword`/`resetPassword` no están implementados).

**Relaciones con otros módulos:** `usuario.rol_id` decide, vía `syncAgenteConUsuario`, si el usuario obtiene un `AgenteCaptacion` (módulo Captación Comercial). `sede_id`/`cargo_id`/`razon_social_id`/`entidad_salud_id` son consumidos masivamente por **Contratos (RRHH)**. `check_role_middleware.ts` protege prácticamente todas las rutas de todos los módulos comparando contra `roles.nombre`.

**Notas de deuda técnica detectadas:**
- **`auth_controller.forgotPassword()` y `resetPassword()` no están implementados** (`throw new Error('Method not implemented.')`) pese a estar montados en `POST /forgot-password` y `POST /reset-password` — cualquier intento de recuperación de contraseña por esta vía revienta con 500. El modelo `PasswordReset` existe pero no se usa en ningún lado.
- **Sistema de permisos granular sin conectar**: `permisos`/`items`/`permiso_items`/`rol_permiso_items` modelan control de acceso fino (rol × recurso × acción), pero la autorización real (`check_role_middleware.ts`) solo compara el nombre del rol contra un array hardcodeado por ruta en `start/routes.ts`. Cambiar permisos hoy requiere editar `routes.ts`, no las tablas de permisos.
- `UsuariosController` tiene métodos selectores (`getRoles`, `getRazonesSociales`, `getSedes`, `getCargos`, `getEntidadesSalud`) que duplican lo que ya hacen `roles_controller.ts`/`sedes_controller.ts`/etc., y no parecen estar montados en `start/routes.ts` — candidatos a código muerto, a confirmar contra el frontend real.
- `roles_controller.show()` (buscar rol por id) existe pero no está ruteado.
- `auth_controller.logout()` existe (revoca el token actual) pero no se encontró una ruta `POST /logout` montada en `start/routes.ts` — si el frontend cierra sesión, probablemente lo hace solo descartando el token en el cliente, sin revocarlo en el servidor.

---

## Puntos de Integración Clave

Estos son los sitios donde el comportamiento de un módulo solo se entiende mirando otro. Si vas a tocar cualquiera de estas piezas, lee ambos lados antes de cambiar algo.

**1. El ciclo central del negocio: RTM → Facturación → Comisión → Liquidación.**
Un turno se crea (**RTM**), se factura (**Facturación**, `POST /facturacion/tickets/:id/confirmar`), y esa confirmación dispara automáticamente una comisión (**Comisiones**) vía `comision_calculo_service.ts` + `continuidad_service.ts`. Esa comisión, cuando se paga en lote, genera un registro de `Liquidacion` (**Comisiones y Liquidaciones**). `turnos_cierre_controller.ts` (**RTM**) es un segundo camino que también crea la comisión al cerrar el turno directamente, sin pasar por facturación.

**2. Tres puntos de generación de comisiones, no unificados entre sí.**
`captacion_dateos_controller.ts` (Captación), `facturacion_tickets_controller.ts` (Facturación) y `turnos_cierre_controller.ts` (RTM) pueden crear una fila en `comisiones` para el mismo evento de negocio (un dateo que terminó en turno exitoso), cada uno con su propia regla de deduplicación:
   - Captación: "¿existió alguna vez una comisión no-config para este dateo?" (pensado para correcciones tardías).
   - Facturación: "¿ya se confirmó una comisión hoy para este ticket?" (ventana de día calendario).
   - RTM (`turnos_cierre_controller.ts`): cálculo simplificado, no pasa por `comision_calculo_service.ts`.
   Un cambio en la lógica de cálculo de comisión (ej. nueva regla de recurrencia) debe replicarse en los tres sitios o generará resultados distintos según por dónde se cerró el turno.

**3. `continuidad_service.ts` y `reserva_dateo_service.ts` como fuentes únicas de verdad — pero no totalmente.**
`evaluarContinuidad()` (RTM) es consumido por `turnos_rtms_controller.ts` y `rep_general_imports_controller.ts`, y sus resultados alimentan el cálculo de comisión (Caso 2/3 de `calcularComision`). `buildReserva()` (Captación) es consumido por `captacion_dateos_controller.ts`, `turnos_rtms_controller.ts` y `busquedas_controller.ts` (Utilidades) para decidir si un dateo sigue vigente. Ojo: `CaptacionDateo` (modelo) tiene sus propios getters `bloqueado`/`bloqueadoHasta` que reimplementan la misma fórmula que `buildReserva()` — dos lugares para la misma regla.

**4. Reportes Administrativos es el hub de lectura central.**
Un solo controlador (~6100 líneas) lee `turnos_rtms`, `facturacion_tickets`, `comisiones`, `captacion_dateos` y `descuentos` para producir todos los reportes gerenciales y el Súper Informe. Es el mejor lugar para ver cómo se cruzan los módulos operativos, pero también el de mayor riesgo: no hay un helper compartido de "turnos reales del período", así que la regla `estado='finalizado' AND placa NOT LIKE 'TST%'` está repetida manualmente en cada endpoint. Los commits `f15d28e` y `98899f0` corrigieron reportes que se habían olvidado de aplicarla — cualquier reporte nuevo sobre `turnos_rtms` debe replicarla.

**5. La discrepancia RTM↔Facturación es una feature documentada, no un bug a esconder.**
`GET /super-informe/reconciliacion-rtm` parte cada turno RTM finalizado en categorías mutuamente excluyentes (`CON_FACTURA_RTM`, `TICKET_OTRO_SERVICIO`, estado del ticket más reciente si no está confirmado, o `SIN_TICKET`) de forma que `pendientes_total + con_factura_confirmada_rtm === turnos_reales_total` sea garantía del propio SQL. Existe precisamente porque "turnos reales" (Meta Mensual, Producción por Líder) y "turnos con factura confirmada" (Ingresos por Canal, Retención, Descuentos) casi nunca coinciden exactamente, y Gerencia necesita ver por qué.

**6. "Ingreso RTM Generado" (Meta Comercial) ≠ Comisión real — miden cosas parecidas con números distintos.**
Meta Comercial mide unidades facturadas × una tarifa "Costo Base RTM" (fila `es_config=true` en `comisiones`, con fallback Global) para comparar contra la meta en pesos de cada asesor. Esto **no es** el monto que efectivamente calcula/paga `comision_calculo_service.ts`. Son dos números que conviven en la misma tabla `comisiones` y son fáciles de confundir si no se sabe que existen dos sistemas de medición distintos.

**7. Contratos y Usuarios pueden crear un `AgenteCaptacion` por dos caminos separados.**
`contratos_controller.ts` (`ensureAgenteYConvenioParaContrato`) y `usuarios_controller.ts` (`syncAgenteConUsuario`) implementan, cada uno por su cuenta, la regla "si el cargo/rol es de tipo asesor comercial/convenio/telemercadeo, crear o actualizar el `AgenteCaptacion` vinculado". No se verificó si ambos caminos producen exactamente el mismo resultado ante los mismos datos — es un candidato a probar antes de tocar cualquiera de los dos.

**8. La identidad de cliente ("buscar o crear") está triplicada.**
La regla de negocio "documento → teléfono → crear nuevo, nunca por email" vive en `findOrCreateCliente()` (Clientes), `upsertClienteDesdeFila()` (`rep_general_imports_controller.ts`, RTM) y lógica inline en `turnos_rtms_controller.store()` (RTM) — tres implementaciones a mantener sincronizadas.

**9. Dos numeraciones de turno paralelas e independientes.**
`turnos_rtms` (servicios operativos: RTM/SOAT/PREV/PERI) y `tramites` (RUNT) tienen cada una su propia secuencia por sede+fecha. `tramite_checklists` se referencia por `sedeId+fecha+turnoNumero`, el mismo patrón de clave que usa `turnos_rtms` — hay que confirmar contra el frontend a cuál de las dos secuencias se refiere en cada caso antes de asumir nada.

**10. `busquedas_controller.ts` (`GET /buscar`) es el punto de entrada comercial real.**
Cruza Captación (dateos/prospectos/convenios/agentes) + Vehículos/Clientes + RTM (última visita) en una sola respuesta al mostrador, y como efecto secundario **puede crear un `CaptacionDateo`** (caso `fuente: 'CONVENIO'`) — una búsqueda por `GET` que escribe en base de datos, sin la idempotencia que se esperaría de un `GET`.

**11. Los campos DECIMAL de Lucid vuelven como `string`, no `number`.**
Patrón repetido en `comision_calculo_service.ts` y `reportes_administrativos_controller.ts` (`valorRtmMoto`, `valorRtmVehiculo`, etc.) — hay que castear con `Number(...)` explícitamente en cada lectura o el resultado es concatenación de strings en vez de suma. Ya causó al menos un bug real corregido (`metaComercialDetalleVehiculo`).

---

## Archivos sin Uso / Deuda Técnica Conocida

Referencia rápida de cosas que YA SABEMOS que no hay que confiar en ellas, para no perder tiempo redescubriéndolas.

**Controladores muertos o huérfanos (no montados en `start/routes.ts`):**
- `captacion_canales_controller.ts` — CRUD completo y bien implementado, pero inaccesible desde el API.
- `agente_canal_membresias_controller.ts` — archivo entero comentado (incluida la clase y el `export default`); no hay ninguna vía HTTP activa para gestionar canal↔agente.
- `asignaciones_prospectos_controller.ts` — implementación huérfana de `asignar`/`retirar`, casi idéntica a la que sí corre dentro de `prospectos_controller.ts`. Parece un refactor a medio terminar.

**Métodos muertos dentro de controladores activos (no ruteados, no llamados internamente):**
- `contratos_controller.ts`: `cambiarEstado()` y `updateRecomendacionMedica()`/`uploadRecomendacionMedica()` — la lógica equivalente ya vive duplicada dentro de `update()`/`store()`/`anexarFisico()`.
- `usuarios_controller.ts`: `getRoles`, `getRazonesSociales`, `getSedes`, `getCargos`, `getEntidadesSalud` — duplican lo que ya hacen los controladores selectores dedicados.
- `roles_controller.ts`: `show()` no está ruteado.
- `auth_controller.ts`: `logout()` existe y funciona (revoca el token) pero no hay ruta `POST /logout` montada.

**Endpoints rotos en producción (montados pero no implementados):**
- `auth_controller.forgotPassword()` y `resetPassword()` — ambos son literalmente `throw new Error('Method not implemented.')`, montados en `POST /forgot-password` y `POST /reset-password`. Cualquier intento real de recuperar contraseña revienta con 500. El modelo `PasswordReset` existe pero no lo usa nadie.

**Infraestructura preparada pero no conectada:**
- Sistema de permisos granular (`permisos`, `items`, `permiso_items`, `rol_permiso_items`) — no está referenciado por `check_role_middleware.ts` ni por ningún controller. La autorización real de hoy es un array de nombres de rol hardcodeado por ruta en `start/routes.ts`. Cambiar quién puede hacer qué requiere tocar `routes.ts`, no estas tablas.
- Tablas sin modelo Lucid, accedidas solo con `Database.from(...)` en `reportes_administrativos_controller.ts`: `meta_comercial_asesor`, `historico_comercial_asesor`, `historico_comercial_vehiculo_mensual`. Cualquier cambio de esquema en ellas no lo detecta el compilador de TypeScript, solo el runtime.

**Sospechoso pero NO confirmado como roto (no asumir, verificar antes de tocar):**
- `contrato_pasos_controller.ts` — se creía "roto"; revisado a fondo (controller + modelo + migración) no se encontró una falla evidente en el análisis estático. El detalle real: la migración define el enum `fase` con `useNative: true`/`enumName`, sintaxis pensada para Postgres, corriendo sobre MySQL. No se confirmó en runtime — si se retoma este módulo, verificar primero el tipo real de la columna `fase` en la base de datos de producción antes de asumir nada.

**Corrección a una suposición previa (documentado aquí para que no se repita el error):**
- `certificacion_funcionario_id` (en `turnos_rtms`) **NO es una columna muerta** — se creía que sí, pero se confirmó que `certificaciones_controller.ts` la escribe activamente y `turnos_rtms_controller.ts` la precarga (`.preload('certificacionFuncionario')`) en `index`/`show` para mostrar quién certificó el turno.

**Decisiones de producto que parecen bugs pero no lo son (documentadas para no "arreglarlas" sin preguntar):**
- `POST /tramites` no bloquea duplicados (misma cédula/sede/día) — solo devuelve una `advertencia` informativa.
- `DELETE /vehiculos/:id` borra físicamente sin verificar si hay `turnos_rtms` asociados (a diferencia de `clientes_controller.destroy()`, que sí bloquea si hay vehículos asociados) — inconsistencia real entre los dos controladores, vale la pena confirmar si es intencional.
- El nombre "liquidación" se usa para dos entidades de negocio sin relación entre sí (pago a asesores vs. costo de trámite que paga el cliente) — alto riesgo de confusión al leer código o base de datos sin este documento.

