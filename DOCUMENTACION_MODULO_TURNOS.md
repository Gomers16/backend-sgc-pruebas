# Módulo TURNOS (RTM) — Documentación exhaustiva verificada contra código real

> Generado 2026-09-15. Verificado leyendo el código fuente completo de backend (`backend-sgc-pruebas`, AdonisJS 6 + Lucid + MySQL) y frontend (`front-sgc-pruebas`, Vue 3 + Vuetify 3 + TS + Pinia + vue-router). Los hallazgos de `MAPA_DEL_SISTEMA_BACKEND.md` y `MAPA_DEL_SISTEMA_FRONTEND.md` (documentos de referencia que ya mantiene este mismo proyecto) se usaron como puntos de partida y fueron **recontrastados contra el código actual**, no copiados a ciegas. Todo lo marcado como "confirmado" fue leído directamente en el archivo citado. Donde no pude verificar algo con certeza, lo digo explícitamente.

---

## 0. Alcance y archivos verificados

**Backend** (leídos completos):
- `app/controllers/turnos_rtms_controller.ts` (1957 líneas — `index`, `show`, `store`, `update`, `activar`, `cancelar`, `destroy`, `registrarSalida`, `siguienteTurno`, `exportExcel`)
- `app/controllers/turnos_cierre_controller.ts` (145 líneas — `cerrar`)
- `app/controllers/certificaciones_controller.ts` (`store`, `showByTurno`)
- `app/services/reserva_dateo_service.ts` (`buildReserva`, `dateoAplicaAServicio`, `buscarTurnoSinDateoHoy`, `dentroVentanaDateoTurno`, `getMinutosVentanaTicket`, `debeRespetarSinComision`, `getMaxRedateos`, `cerrarDateosViejosPorPlacaTelefono`)
- `app/services/turno_etapas_service.ts` (semáforo de etapas)
- `app/models/turno_rtm.ts`
- Secciones relevantes de `app/controllers/captacion_dateos_controller.ts`, `app/controllers/tickets_excepcion_dateo_controller.ts`, `app/controllers/busquedas_controller.ts`, `app/controllers/facturacion_tickets_controller.ts` (método `confirmar`/`applyCommissionHook`)
- `app/middleware/check_role_middleware.ts`
- Migraciones de `turnos_rtms` (creación, `dedupe_key`, cancelación, `turno_numero_activo`, `estado_continuidad`, `reasignado_de_turno_id`) y de `comisiones`
- `start/routes.ts` (rutas de turnos, certificaciones, dateos, tickets, facturación)
- `MAPA_DEL_SISTEMA_BACKEND.md` del propio repo (changelog verificado, no solo citado)

**Frontend** (leídos completos, directamente por mí o por un sub-agente de investigación cuyo informe línea-por-línea fue contrastado):
- `src/views/rtm/CrearTurno.vue`, `EditarTurno.vue`, `CertificacionTurnoView.vue` — leídos por mí, completos.
- `src/views/rtm/TurnosDelDia.vue`, `EstadoDeTurnos.vue`, `ContadorConvenios.vue`, `src/components/rtm/TurnoDetalleDialog.vue` — leídos completos por un sub-agente con instrucciones de citar archivo:línea; sus citas se usan tal cual abajo.
- `src/services/turnosdeldiaService.ts`, `certificacion_service.ts`, `busquedas_service.ts`, `repGeneralService.ts` — leídos completos por mí.
- `src/composables/usePermissions.ts` — leído completo por mí.
- `src/components/layout/AppSidebar.vue` (sección Turnos) — confirmado por grep + lectura puntual.
- `MAPA_DEL_SISTEMA_FRONTEND.md` del propio repo — usado como fuente secundaria ya verificada por sesiones anteriores, contrastada donde fue posible.

No pude leer con el mismo detalle: `rep_general_imports_controller.ts`, `historico_dateo_rtm_controller.ts`, `facturacion_tickets_controller.ts` completo (solo el método `confirmar`/`applyCommissionHook`), `continuidad_service.ts` completo (solo su rol vía el changelog y las llamadas que le hace `turnos_rtms_controller.ts`). Donde el documento se apoya en esas piezas lo indico como "según el changelog del propio repo", no como lectura directa mía.

---

## 1. Flujo de negocio de punta a punta

### 1.1 Creación del turno (Puerta)

Se crea desde `CrearTurno.vue` (`/rtm/crear-turno`) → `POST /api/turnos-rtm` → `turnos_rtms_controller.ts::store()`.

**Campos obligatorios** (backend, `store()` líneas ~418-446): `placa`, `tipoVehiculo`, `usuarioId`, `fecha`, `horaIngreso`. Falta cualquiera → 400. `servicioId` o `servicioCodigo` es obligatorio pero se valida aparte (400 si ninguno resuelve un `Servicio` real).

**Validaciones y normalizaciones**:
- `placa` se normaliza (`replace(/[\s-]/g,'').toUpperCase()`), igual que en todo el sistema (mismo criterio en `reserva_dateo_service.ts` y `captacion_dateos_controller.ts`).
- `tipoVehiculo` debe ser uno de `Liviano Particular | Liviano Taxi | Liviano Público | Motocicleta` (enum de BD).
- `usuarioId` debe existir y tener `sedeId` asignado — si no, 400 con mensaje explícito ("Tu usuario no tiene sede asignada").
- `horaIngreso` acepta `HH:mm` o `HH:mm:ss`.

**Autocompletado por placa/teléfono** (frontend, `CrearTurno.vue`): al escribir la placa (regex de 6 caracteres para autobúsqueda) o un teléfono de 10 dígitos, dispara `BusquedasService.unificada()` → `GET /api/buscar` (backend: `busquedas_controller.ts::unificada()`). Esa búsqueda unificada:
1. Busca vehículo/cliente por placa o teléfono.
2. Busca el dateo más reciente para esa placa/teléfono y calcula si sigue vigente (`buildReserva`).
3. Si hay dateo vigente → responde `fuente: 'DATEO'` con el dateo, su convenio, el agente y `servicioId`/`servicioCodigo` del dateo.
4. Si no hay dateo pero la placa/teléfono está en un `Prospecto` con convenio asignado → **crea automáticamente** un dateo `ASESOR_CONVENIO` (`resultado: 'PENDIENTE'`) y responde `fuente: 'CONVENIO'`.
5. Si no hay nada de lo anterior, intenta detectar un `AgenteCaptacion` activo cuyo teléfono coincida exactamente con el teléfono buscado (10 dígitos) → lo devuelve en `asesorDetectado` (branch `fuente: 'FACHADA'`).
6. Si nada aplica, responde `fuente: 'FACHADA'` con `captacionSugerida: {canal:'FACHADA'}`.

El frontend usa `resp.captacionSugerida.canal` para preseleccionar el "¿Cómo nos conoció?" del formulario, y guarda `resp.dateoReciente.id` como `_dateoId` para enviarlo como `dateoId` al crear el turno. **Confirmado: `resp.asesorDetectado` (paso 5) nunca se lee en `CrearTurno.vue`** — ver hallazgo en §7.

**Canal de captación**: se envía como `canal` (`FACHADA|ASESOR|TELE|REDES`) — el que trae `captacionSugerida`, o el que el operador elige manualmente en "¿Cómo nos conoció?" si no hubo sugerencia.

**Payload real enviado a `POST /api/turnos-rtm`** (armado en `turnosdeldiaService.ts::createTurno()`):
```
placa, tipoVehiculo, observaciones, fecha, horaIngreso, usuarioId, servicioId,
canal, servicioCodigo?, agenteCaptacionId?, clienteNombre?, clienteTelefono?,
clienteEmail?, dateoId?, conductorId?, conductorTelefono?, conductorNombre?,
asesorDetectadoId? (tipado en el servicio pero nunca poblado desde CrearTurno.vue),
convenioId? (agregado directo en CrearTurno.vue, fuera del tipo del servicio)
```
`convenioId` viaja en el JSON pero **el backend no lo lee** — `request.only([...])` de `store()` no incluye `convenioId` en su lista de campos permitidos, así que Adonis lo descarta en silencio. No es un error (el convenio real se deriva del dateo vinculado), pero es un campo "fantasma" en el contrato.

### 1.2 Resolución de vehículo/cliente/conductor

Si la placa ya tiene un `Vehiculo`, se reutiliza (y su `clienteId`/`claseVehiculoId`). Si no hay cliente pero llega un teléfono, busca un `Cliente` existente por teléfono o crea uno nuevo si además llega nombre/email. El conductor se resuelve igual (por `conductorId` explícito, o por teléfono, o se crea uno nuevo con el nombre dado).

### 1.3 Vinculación con un dateo comercial

Esta es la pieza más compleja de `store()`. Regla central (`dateoAplicaAServicio()` en `reserva_dateo_service.ts`): **un dateo solo se vincula/hereda/marca EXITOSO si su `servicioId` coincide exactamente con el `servicioId` del turno que se está creando**. Un dateo con `servicioId = NULL` (legado) no aplica a ningún servicio.

Orden de resolución:
1. Si el frontend mandó `dateoId` explícito y es numérico, se busca ese dateo y se valida `dateoAplicaAServicio()`. Si no aplica (servicio distinto) o el id no es numérico, se descarta silenciosamente y se cae al paso 2.
2. Fallback: se busca el dateo más reciente por `placa` (o `telefono`) + `servicio_id` igual al del turno.
3. Si el candidato de 1 o 2 existe, se valida su **vigencia** con `buildReserva()` (ver §3.2). Si no está vigente:
   - **Capa 1 (retry)**: se reintenta el mismo fallback del paso 2, excluyendo el dateo descartado, por si hay otro dateo vigente para esa misma placa+servicio.
4. **Capa 2 (red de seguridad)**: justo antes de armar el `payload` del turno, si a esta altura sigue sin haber `captacionDateoId`, se hace un último intento por placa+servicio (sin filtrar por vigencia previa — repite la misma consulta que el paso 2).
5. Si al final hay un dateo vinculado, se marca `resultado: 'EN_PROCESO'`, `consumidoTurnoId`/`consumidoAt` en el dateo, y el turno hereda `canalAtribucion`, `agenteCaptacionId`, `dateoObservacion`, `dateoImagenUrl`, `dateoCanal`, `esAvance` del dateo.
6. **Frontend**: si el dateo encontrado por la búsqueda unificada es de un servicio distinto al que el operador tiene seleccionado en el dropdown, se muestra una alerta visual (`v-alert` tipo warning: *"Este dateo fue registrado para {servicio}"*) — **confirmado que no bloquea el envío del formulario**, tal como describe el comentario del propio backend.

**Auto-dateo por teléfono detectado (`asesorDetectadoId`)**: si el servicio es RTM y llega `asesorDetectadoId` en el payload, el backend busca un dateo `PENDIENTE` de ese agente+placa para reutilizarlo, o si no existe crea uno nuevo (`ASESOR_COMERCIAL`/`ASESOR_CONVENIO` según el tipo del agente), cerrando primero cualquier dateo viejo en `RE_DATEAR` de esa misma placa/teléfono. **Hallazgo confirmado (§7): esta rama de código, sustancial, es hoy inalcanzable** — `CrearTurno.vue` nunca puebla `asesorDetectadoId` en el payload (ni siquiera lee el campo `asesorDetectado` que sí devuelve `GET /buscar` en su rama `fuente: 'FACHADA'`).

**Clasificación de recurrencia/recuperación**: si hay `clienteId`, se busca el último turno `finalizado` anterior de ese cliente. Con la fecha de esa última visita:
- Si el dateo vinculado es `ASESOR_CONVENIO`, se usa `evaluarContinuidad()` (`continuidad_service.ts`) para decidir `estadoContinuidad` (`CONTINUA|ROTA|SIN_EVIDENCIA`); `esRecurrente = (estadoContinuidad === 'ROTA')` en ese caso.
- En cualquier otro caso, `esRecurrente = mesesDesdeUltimaVisita < mesesMinimos` (config `configuracion_recurrencia_global`, default 24) y `esRecuperacion` es lo contrario.

### 1.4 Las 3 etapas: Puerta → Facturación → Certificación

La fuente única de verdad de qué etapas aplican y si están completas es `app/services/turno_etapas_service.ts`:

| Etapa | Se marca completa cuando... | Quién la completa | Excepción |
|---|---|---|---|
| **Puerta** | `horaIngreso` tiene valor | El operador que crea el turno (`POST /turnos-rtm`) | Siempre aplica |
| **Facturación** | `tieneFacturacion = true` | `POST /facturacion/tickets/:id/confirmar` (`facturacion_tickets_controller.ts::confirmar()`), que setea `tieneFacturacion`, `horaFacturacion`, `facturacionFuncionarioId` sobre el turno | Siempre aplica |
| **Certificación** | `horaSalida` tiene valor | `POST /api/certificaciones` (`certificaciones_controller.ts::store()`) — sube la evidencia FLUR y finaliza el turno en el mismo request | **No aplica a SOAT** (`SERVICIOS_SIN_CERTIFICACION = ['SOAT']`) |

El "semáforo" (`estadoVisual`) que ve el operador en `TurnosDelDia.vue` se calcula así (`computeEtapasTurno()`):
- `cancelado` → turno con `estado='cancelado'`.
- `en_proceso` (azul) → 0 o 1 etapa completa.
- `incompleto` (amarillo) → ≥2 etapas completas pero falta alguna requerida.
- `finalizado` (verde) → todas las etapas requeridas completas.

**Puntos no obvios verificados**:
- **No hay ningún orden forzado entre Facturación y Certificación.** Tanto en backend como en frontend: `certificaciones_controller.ts::store()` no comprueba `tieneFacturacion` antes de certificar, y en `CertificacionTurnoView.vue` el único requisito para habilitar el botón de certificar es tener una imagen seleccionada (`puedeConfirmar = !!turno && !!previewBlob && !saving`); si falta facturación solo se muestra un `v-alert` de advertencia no bloqueante. En `TurnosDelDia.vue` los links "Facturación"/"Certificación" de cada tarjeta navegan siempre, sin comprobar si la etapa anterior está completa.
- **Certificación y "cierre de turno" son la misma acción, y "salida" (`registrarSalida`, `PUT /:id/salida`) es un camino paralelo sin usar hoy.** El backend tiene DOS formas de poner `estado='finalizado'` con `horaSalida`: `registrarSalida()` (endpoint dedicado) y `certificaciones_controller.ts::store()` (que hace lo mismo inline al certificar). El frontend **solo usa la segunda vía** — `registrarSalida`, `activarTurno` e `inhabilitarTurno` están completamente implementados en `turnosdeldiaService.ts` pero **ningún componente del frontend los invoca** (confirmado por grep global). Además, `registrarSalida()` es la única de las dos rutas que, para servicios no-RTM, marca el dateo vinculado como `EXITOSO`; `certificaciones_controller.ts::store()` **no lo hace** — es decir, hoy en la práctica (dado que el frontend certifica siempre por `POST /certificaciones`, nunca por `PUT /:id/salida`) esa marca de `EXITOSO` al finalizar por certificación **no ocurre desde ese camino** para servicios no-RTM (ver hallazgo en §7, es una discrepancia real entre las dos rutas de finalización que no estaba documentada).
- **Certificar un turno SOAT no está bloqueado en la pantalla de certificación.** La regla "SOAT no certifica" solo está aplicada como omisión de UI (no se muestra el link "Certificación" para turnos SOAT en `TurnosDelDia.vue`/`TurnoDetalleDialog.vue`), pero `CertificacionTurnoView.vue` no tiene ninguna lógica de servicio — si alguien navega directo a `/rtm/certificacion/:id` de un turno SOAT, el formulario funciona sin aviso. Para SOAT, el "cierre" real ocurre en `facturacion_tickets_controller.ts::confirmar()`: si el servicio es SOAT y el turno está `activo`, la propia confirmación de facturación calcula `tiempoServicio`, fija `horaSalida` y pasa el turno a `finalizado` en el mismo request — y además marca el dateo `EXITOSO` ahí mismo si hay `dateoId` en el ticket.

### 1.5 Cancelación

`EditarTurno.vue` tiene un botón "Cancelar turno" → `PATCH /api/turnos-rtm/:id/cancelar` → `turnos_rtms_controller.ts::cancelar()`.

- **Motivo obligatorio**: mínimo 5 caracteres (`MOTIVO_CANCELACION_MIN_LEN`), validado tanto en frontend (regla del textarea + computed) como en backend (400 si falta o es muy corto). Se guarda `motivoCancelacion`, `canceladoPorId`, `canceladoAt`.
- **No hay bloqueo por evidencia**: se puede cancelar un turno que ya tiene facturación y/o certificación — el frontend solo muestra una advertencia reforzada (*"Cancelarlo puede implicar una devolución u otras consecuencias"*), no impide la acción.
- **No valida el estado actual del turno**: se puede cancelar un turno ya `finalizado` sin restricción (comportamiento preexistente, documentado como tal en el changelog del propio backend, no corregido).
- **El número de turno se "libera"**: si `turnoNumero`/`turnoNumeroServicio` eran positivos, se invierten a negativos (`-N`) — esto es lo que permite que `store()` los reasigne a un turno nuevo del mismo día (ver §1.6). Los turnos `cancelado` con número negativo quedan excluidos de los índices únicos activos (ver migración `1787000000007`).
- **El dateo vinculado NO se revierte.** Esto es un bug documentado y sin resolver en `MAPA_DEL_SISTEMA_BACKEND.md`: si el turno cancelado tenía `captacionDateoId` con `resultado='EN_PROCESO'` (o ya `EXITOSO`), cancelar el turno no lo regresa a `PENDIENTE`/`RE_DATEAR` ni libera el `consumidoTurnoId`. El dateo queda "consumido" por un turno que ya no existe operativamente, lo que puede seguir bloqueando esa placa+servicio bajo la ventana de exclusividad (`buildReserva()`) sin que haya un turno real en curso.
- **`destroy()` (inhabilitar, soft-delete) es distinto de cancelar**: pasa `estado='inactivo'`, sin motivo, sin trazabilidad, y **sin liberar el número de turno** (no se invierte a negativo) — un turno inhabilitado desperdicia su `turnoNumero`/`turnoNumeroServicio` para siempre, porque la lógica de huecos solo mira `estado='cancelado'` con número negativo. **Confirmado: ningún botón del frontend llama a `inhabilitarTurno()`** (función existe en el servicio, sin consumidor).
- **Discrepancia real entre `cancelar()` (endpoint dedicado) y `update()` (edición genérica), confirmada leyendo ambos métodos**: `EditarTurno.vue` también permite cambiar el campo "Estado del Turno" a `cancelado` directamente desde un `<v-select>` y guardar con el botón "Guardar cambios", que llama a `PUT /api/turnos-rtm/:id` → `turnos_rtms_controller.ts::update()`. Ese método **no exige motivo, no registra `canceladoPorId`/`canceladoAt`, y no invierte el signo de `turnoNumero`/`turnoNumeroServicio`**. Es decir, hay dos caminos de UI para dejar un turno en `cancelado`: uno con toda la trazabilidad y liberación de slot (el botón dedicado), y otro sin ninguna de las dos cosas (el dropdown de Estado + Guardar). Este segundo camino deja el turno "cancelado" con su número aún positivo y ocupando el slot permanentemente, exactamente como el caso de `destroy()`/inhabilitar. **Esto no está documentado en ninguno de los dos MAPA existentes** — es un hallazgo nuevo de esta revisión.

### 1.6 Reutilización de números de turno (huecos) y colisiones de índice único

Cada turno tiene dos consecutivos: `turnoNumero` (global, por sede+día) y `turnoNumeroServicio` (por sede+día+servicio). Cuando se cancela un turno, su número queda negativo y libre para reasignarse.

Al crear un turno nuevo (`store()`), antes de calcular el "siguiente número" se busca primero un **hueco**:
- **Hueco global**: el turno cancelado (`turno_numero < 0`) de menor `ABS(turno_numero)` del mismo día/sede que (a) no haya sido ya reclamado por otro turno (`reasignado_de_turno_id`) y (b) cuyo valor absoluto no coincida con un `turno_numero` positivo ya existente (cubre turnos viejos, previos a que existiera `reasignado_de_turno_id`). Se toma con `forUpdate()` dentro de una transacción.
- **Hueco por servicio**: análogo, pero filtrado también por `servicio_id`.
- Si no hay hueco, se toma `MAX(turno_numero) + 1` (o `MAX(turno_numero_servicio) + 1`) entre los turnos `activo`/`finalizado` del día.

El turno nuevo que reutiliza un hueco global guarda `reasignadoDeTurnoId` apuntando al turno cancelado cuyo slot ocupó, para que otro turno concurrente no reclame el mismo hueco dos veces.

**Colisión de índice único, ya corregida vía esquema (no vía código)**: los índices únicos originales (`sede_id, fecha, turno_numero` y `sede_id, fecha, servicio_id, turno_numero_servicio`) eran incondicionales, así que dos turnos cancelados con el mismo número original (uno negado hoy, otro negado en otro momento) podían colisionar al ambos valer `-N`. Se resolvió con columnas generadas STORED (`turno_numero_activo`, `turno_numero_servicio_activo`, `NULL` cuando el turno no es positivo) e índices únicos sobre esas columnas — MySQL permite múltiples `NULL` en un índice único, así que los cancelados ya no compiten entre sí. **Verificado en la migración `1787000000007_add_turno_numero_activo_unique_to_turnos_rtms_table.ts`.**

**Hallazgo nuevo de esta revisión — el endpoint de previsualización (`GET /siguiente-turno`) no replica exactamente la lógica de `store()`**: comparando ambos métodos línea por línea:
- La búsqueda de hueco **global** en `siguienteTurno()` excluye los slots ya reclamados (`reasignado_de_turno_id`, igual que `store()`), pero **no excluye** los que ya están físicamente ocupados por un `turno_numero` positivo (la comprobación `whereRaw ABS(...) NOT IN (SELECT ... WHERE turno_numero > 0)` que sí tiene `store()`).
- La búsqueda de hueco **por servicio** en `siguienteTurno()` no tiene ninguna de las dos exclusiones (ni `reasignado_de_turno_id` ni la de "ya ocupado").
- Tampoco usa `forUpdate()` (correcto, es solo lectura, pero significa que el número mostrado en pantalla es una estimación, no una reserva).

Consecuencia práctica: en el caso borde (turnos legado sin `reasignado_de_turno_id`, o carrera entre dos creaciones simultáneas) el número que `CrearTurno.vue` muestra como "siguiente" puede no coincidir con el que `store()` termina asignando realmente. No es un bug que rompa nada (el número real siempre lo decide `store()` con locking), pero el contador visual puede quedar desincronizado momentáneamente. No estaba documentado en los MAPA existentes.

**Race condition documentada y sin corregir (ya existía en `MAPA_DEL_SISTEMA_BACKEND.md`, verificada de nuevo)**: `turnoCodigo` se genera como `${servicio.codigoServicio}-${timestamp de segundo}` — si dos turnos del mismo servicio se crean en el mismo segundo exacto, el segundo `INSERT` falla por el índice único de `turno_codigo` (`ER_DUP_ENTRY`), devolviendo 500 en vez de un turno creado. Confirmado en runtime por el propio equipo en 2026-08-26 con un script de seed.

### 1.7 Certificación final (evidencia FLUR)

`POST /api/certificaciones` (`certificaciones_controller.ts::store()`), payload multipart: `turno_id`, `imagen` (JPG/PNG hasta 8MB, obligatoria), `observaciones` (opcional). En una sola operación:
1. Guarda el archivo en `uploads/certificaciones/`.
2. Crea el registro `Certificacion` (`turnoId`, `usuarioId` del autenticado, `imagenPath`, `observaciones`).
3. Calcula `tiempoServicio` (diferencia entre ahora y `horaIngreso`).
4. Actualiza el turno: `estado='finalizado'`, `horaSalida=ahora`, `tiempoServicio`, `certificacionFuncionarioId`.

**No marca el dateo como `EXITOSO`** (a diferencia de `registrarSalida()`, que sí lo hace para servicios no-RTM) — ver la discrepancia señalada en §1.4. `GET /api/certificaciones/turno/:turnoId` permite consultar si ya existe una certificación para mostrar la pantalla en modo solo-lectura.

---

## 2. Estados y transiciones

Estados posibles de `turnos_rtms.estado`: `activo | inactivo | cancelado | finalizado` (enum de BD, default `activo`).

| Transición | Disparada por | Efectos adicionales |
|---|---|---|
| *(crear)* → `activo` | `POST /turnos-rtm` | Turno queda operativo, en Puerta |
| `activo` → `finalizado` | `PUT /:id/salida` (registrarSalida) **o** `POST /certificaciones` **o**, si es SOAT, `POST /facturacion/tickets/:id/confirmar` | Fija `horaSalida`/`tiempoServicio`; marca dateo EXITOSO solo en la primera vía (no-RTM) y en la de facturación SOAT |
| cualquier estado → `cancelado` | `PATCH /:id/cancelar` (con motivo) **o** `PUT /:id` con `estado:'cancelado'` (sin motivo, sin trazabilidad — ver §1.5) | Invierte `turnoNumero`/`turnoNumeroServicio` a negativo **solo** en el primer camino |
| cualquier estado → `inactivo` | `PATCH /:id/inhabilitar` (destroy, soft-delete) | Sin trazabilidad, no libera el número |
| `inactivo`/cualquiera → `activo` | `PATCH /:id/activar` | Solo cambia el campo `estado`, sin validar nada más — **sin consumidores en el frontend actual** |

**No hay ninguna validación de máquina de estados en el backend**: cualquier transición es técnicamente posible vía `PUT /:id` (por ejemplo, pasar un turno `cancelado` a `finalizado` directamente editando el Estado en `EditarTurno.vue`) — no existe una tabla de transiciones permitidas ni un guard que la haga cumplir.

---

## 3. Reglas de negocio no obvias

### 3.1 Ventanas de renovación / alertas de vencimiento por servicio

Solo aplica a **RTM y SOAT** (`bloqueoMesesPorServicio()`: 12 meses de vigencia; para PREV/PERI la función devuelve 0, sin bloqueo de vigencia).

- **`WINDOW_BLOCK` al crear turno** (`store()`): si existe un turno `finalizado` previo de la misma placa+servicio, se calcula `vencimiento = últimaFecha + 12 meses`. La creación del turno nuevo se bloquea (409) si la fecha es anterior a `vencimiento - 16 días` — es decir, se permite crear el turno hasta 16 días antes del vencimiento, no antes. Este valor `16` está **hardcodeado como constante local** (`DIAS_VENTANA_PRE = 16`) dentro de `store()`, no viene de variable de entorno ni de configuración en BD.
- **Alerta visual equivalente en frontend** (`CrearTurno.vue::refreshAlertaVentanaServicio()`): replica el mismo criterio (12 meses, 16 días de ventana) consultando el último turno `finalizado` de esa placa+servicio vía `GET /turnos-rtm`. Es puramente informativa (chip warning), no bloquea el submit — el bloqueo real ocurre en el backend al enviar.
- **Hallazgo nuevo de esta revisión — hay una SEGUNDA ventana de "RTM vigente", con un valor distinto y una fuente distinta, en el módulo de Dateos.** `captacion_dateos_controller.ts` (al crear un dateo, no un turno) tiene su propio chequeo `RTM_VIGENTE`/`RTM_VIGENTE_EXCEPCION_DISPONIBLE`, que también usa 12 meses de vigencia pero con una ventana previa de **`DIAS_VENTANA_PRE_RTM` = 10 días por defecto, configurable por variable de entorno** (`diasVentanaPreRtm()`). Es decir: el sistema tiene dos reglas de "¿puedo dar servicio otra vez a esta placa antes de que venza el RTM?" con **valores distintos (10 vs 16 días) y mecanismos de configuración distintos (env var vs. constante hardcodeada)**, una para bloquear la creación de un *dateo* y otra para bloquear la creación de un *turno*. No encontré ninguna mención de esta discrepancia en `MAPA_DEL_SISTEMA_BACKEND.md` — parece no haber sido detectada antes.

### 3.2 Bloqueo de "dateo activo" con cadencia distinta por servicio

`buildReserva()` decide si un dateo sigue "bloqueando" esa placa+servicio para otro asesor:
- Si el dateo **no ha sido consumido** (`consumidoTurnoId`/`consumidoAt` nulos): vigente mientras no pasen `horasExclusividad` (config `configuracion_reserva_dateos`, default 60h) desde su creación (o desde su último re-dateo, `redateadoAt`).
- Si el dateo **ya fue consumido** (típicamente `EXITOSO`): vigente mientras no pasen `ttlPostConsumoDiasPorServicio(codigoServicio)` días desde `consumidoAt`:
  - **RTM y SOAT**: 365 días (`TTL_POST_CONSUMO_DIAS`, configurable).
  - **PREV y PERI**: **60 días** (`TTL_POST_CONSUMO_DIAS_PREV_PERI`, configurable) — mucho más corto, porque el ciclo real de recompra de Preventiva/Peritaje es más corto que el de RTM/SOAT (documentado con el caso real de la placa WTP333, bloqueada incorrectamente ~111 días con el TTL de 365 pensado para RTM).

### 3.3 `REQUIERE_TICKET_DATEO` y su integración con Tickets Internos

**Aclaración importante frente al planteamiento inicial**: este código **no lo emite `turnos_rtms_controller.ts::store()`** (la creación de un turno walk-in sin dateo nunca falla ni se bloquea por esto). Lo emiten `captacion_dateos_controller.ts::store()` y `::redatear()`, cuando alguien intenta **crear o re-datear un dateo** para una placa+servicio que ya tiene, hoy, un turno `activo`/`finalizado` **sin ningún dateo vinculado** (`captacion_dateo_id IS NULL`) — función compartida `buscarTurnoSinDateoHoy()`.

Es decir, el flujo real es: (1) un turno walk-in se crea sin problema, sin dateo; (2) más tarde, si un asesor intenta atribuirse ese cliente creando o re-dateando un dateo para esa misma placa+servicio, el sistema lo rechaza con 409 `REQUIERE_TICKET_DATEO` y lo obliga a pasar por un ticket de "Excepción de Dateo" (módulo Tickets Internos) para vincular el dateo retroactivamente con aprobación de gerencia.

**No existe ninguna excepción para roles privilegiados en este chequeo** — a diferencia de `RTM_VIGENTE`/`DATEO_ACTIVO` (ver §3.4), `esPrivilegiado` no tiene ningún efecto sobre `REQUIERE_TICKET_DATEO`: SUPER_ADMIN y GERENCIA están igual de bloqueados que un COMERCIAL normal, sin atajo de "continuar sin ticket".

**Flujo del ticket** (`tickets_excepcion_dateo_controller.ts`):
1. `POST /tickets-excepcion-dateo` (`crear`, roles COMERCIAL/SUPER_ADMIN/GERENCIA): requiere `turno_id`, `observacion`, y 3 evidencias fotográficas obligatorias (chat con cliente, grupo de WhatsApp, bloqueo/excepción) + 1 opcional (calamidad). Calcula y **persiste como snapshot** `dentro_ventana` (según `getMinutosVentanaTicket()` — cascada override por asesor → config global, default 60 min — comparado contra `turno.horaIngreso`). Ese snapshot no se recalcula después.
2. `PATCH /tickets-excepcion-dateo/:id/aprobar` (roles SUPER_ADMIN/GERENCIA): crea el `CaptacionDateo` retroactivo (con `servicioId = turno.servicioId`, obligatorio), lo vincula al turno, y calcula la comisión con el mismo motor que `facturacion_tickets_controller.ts::applyCommissionHook()` (duplicado a propósito, documentado como tal). Si el ticket quedó `dentroVentana=true` al crearse, la comisión es siempre completa. Si quedó fuera de ventana, quien aprueba elige `con_comision: true|false` — `false` fuerza `montoAsesor = '0'` (el convenio, si existe, cobra su parte normal igual).
3. `PATCH /tickets-excepcion-dateo/:id/rechazar`: cierra el ticket sin tocar turno/dateo/comisión.

**Frontend**: el modal `REQUIERE_TICKET_DATEO` con manejo específico (tono según `dentroVentana`, botón único "Crear ticket de excepción") vive en `DateoCreate.vue` (módulo Comercial → Dateos), **no en ninguna vista de Turnos**. Si este código llegara alguna vez como respuesta de una acción dentro del módulo Turnos, no tendría manejo dedicado.

### 3.4 Excepciones para roles privilegiados (SUPER_ADMIN/GERENCIA)

Existen dos —y solo dos— reglas de negocio con vía de excepción para roles privilegiados, ambas en `captacion_dateos_controller.ts::store()` (creación de dateo, no de turno):

- **`RTM_VIGENTE_EXCEPCION_DISPONIBLE`**: cuando la placa tiene RTM vigente y se intenta datear para RTM antes de la ventana permitida. Un usuario normal recibe 409 `RTM_VIGENTE` sin salida. Un SUPER_ADMIN/GERENCIA recibe primero 409 `RTM_VIGENTE_EXCEPCION_DISPONIBLE`; si reenvía la misma petición con `confirmar_excepcion: true`, se le deja continuar.
- **`DATEO_ACTIVO_EXCEPCION_DISPONIBLE`**: mismo patrón para el caso de "ya hay un dateo activo/exitoso vigente para esta placa+servicio". Un usuario normal recibe 409 `DATEO_ACTIVO`; un privilegiado recibe la variante `_EXCEPCION_DISPONIBLE` y puede confirmar con el mismo flag.

Ambas excepciones quedan registradas en `captacion_dateos.aprobado_excepcion_tipo` (`'RTM_VIGENTE'|'DATEO_ACTIVO'`), para poder distinguir cuál de las dos reglas se saltó. El frontend correspondiente (`DateoCreate.vue`) reenvía el mismo payload agregando `confirmar_excepcion: true` cuando el usuario confirma en el modal de excepción.

---

## 4. Endpoints reales

Todas las rutas están bajo el prefijo `/api` (`router.group(...).prefix('/api')` en `start/routes.ts`) y requieren `middleware.auth()` salvo donde se indica.

### Turnos (`turnos_rtms_controller.ts`)

| Método | Ruta | Controlador::método | Roles | Payload / notas |
|---|---|---|---|---|
| GET | `/turnos-rtm` | `index` | SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS, TRAMITADOR | qs: `fecha, placa, tipoVehiculo, estado, turnoNumero, fechaInicio, fechaFin, servicioId, servicioCodigo, canalAtribucion, agenteId, agenteTipo, clienteId, vehiculoId, page, perPage`. Sin filtros de fecha → últimos 7 días por defecto |
| GET | `/turnos-rtm/siguiente-turno` | `siguienteTurno` | ídem | qs: `usuarioId` (req.), `servicioId`\|`servicioCodigo` |
| GET | `/turnos-rtm/export-excel` | `exportExcel` | SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS (sin TRAMITADOR) | qs: `fechaInicio, fechaFin` (req.), `servicioId/servicioCodigo, canalAtribucion, agenteId, agenteTipo` |
| POST | `/turnos-rtm` | `store` | SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS, TRAMITADOR | body: ver §1.1 |
| POST | `/turnos-rtm/:id/cerrar` | `turnos_cierre_controller.ts::cerrar` | SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS | **Roto en runtime** (ver §6) y sin llamador en frontend |
| GET | `/turnos-rtm/:id` | `show` | SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS (sin TRAMITADOR) | — |
| PUT | `/turnos-rtm/:id` | `update` | ídem | body: `placa, telefono, tipoVehiculo, observaciones, usuarioId, horaSalida, tiempoServicio, estado, servicioId/servicioCodigo, canal, agenteCaptacionId, clienteId, vehiculoId, fecha, horaIngreso, conductorId, conductorTelefono, conductorNombre, asesorDetectadoId` |
| PUT | `/turnos-rtm/:id/salida` | `registrarSalida` | ídem | body: `usuarioId`. **Sin consumidores en el frontend actual** |
| PATCH | `/turnos-rtm/:id/activar` | `activar` | ídem | body: `usuarioId`. **Sin consumidores en el frontend actual** |
| PATCH | `/turnos-rtm/:id/cancelar` | `cancelar` | ídem | body: `usuarioId, motivoCancelacion` (mín. 5 caracteres) |
| PATCH | `/turnos-rtm/:id/inhabilitar` | `destroy` | ídem | body: `usuarioId`. **Sin consumidores en el frontend actual** |

### Certificaciones (`certificaciones_controller.ts`)

| Método | Ruta | Roles | Payload |
|---|---|---|---|
| POST | `/certificaciones` | SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS | multipart: `turno_id, imagen (obligatoria, jpg/jpeg/png, máx 8MB), observaciones?` |
| GET | `/certificaciones/turno/:turnoId` | SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS | — |

### Búsqueda unificada (`busquedas_controller.ts`)

| Método | Ruta | Roles | Notas |
|---|---|---|---|
| GET | `/buscar` | Cualquiera autenticado (sin `checkRole` específico en la ruta) | qs: `placa` o `telefono`. Ver §1.1 para el comportamiento completo |

### Integraciones directamente relevantes

| Método | Ruta | Controlador | Efecto sobre un turno |
|---|---|---|---|
| POST | `/facturacion/tickets/:id/confirmar` | `facturacion_tickets_controller.ts::confirmar` | Marca `tieneFacturacion=true`, `horaFacturacion`, `facturacionFuncionarioId`; si es SOAT y el turno está `activo`, además lo finaliza (`horaSalida`, `estado='finalizado'`) y marca el dateo EXITOSO ahí mismo |
| POST | `/captacion-dateos` | `captacion_dateos_controller.ts::store` | Puede rechazar con `TURNO_ACTIVO` si ya hay turno activo hoy del mismo servicio, o con `REQUIERE_TICKET_DATEO` si hay un turno de hoy sin dateo vinculado |
| POST | `/captacion-dateos/:id/redatear` | `captacion_dateos_controller.ts::redatear` | Puede rechazar si el dateo ya tiene un turno `activo`/`finalizado` vinculado, o con `REQUIERE_TICKET_DATEO` |
| POST | `/tickets-excepcion-dateo/:id/aprobar` | `tickets_excepcion_dateo_controller.ts::aprobar` | Crea y vincula retroactivamente un `captacion_dateo` a `turno.captacionDateoId` |
| POST | `/rtm/rep-general/import` | `rep_general_imports_controller.ts::import` | Crea/actualiza turnos retroactivos, marca `repGeneralVerificado`, reclasifica recurrencia/recuperación (no auditado línea por línea en esta revisión, según el changelog del propio repo) |

---

## 5. Integraciones con otros módulos

**Dateos (Captación Comercial) ↔ Turnos**: la relación es bidireccional y es el punto de integración más denso del sistema.
- Un turno puede *consumir* un dateo (al crearse, `store()`) o *generar la necesidad de uno* retroactivo (`REQUIERE_TICKET_DATEO`).
- Cancelar/inhabilitar un turno **no** libera el dateo que consumió (bug conocido, §1.5).
- `dateoAplicaAServicio()` es la única fuente de verdad, reutilizada en `store()`, `registrarSalida()`, `turnos_cierre_controller.ts::cerrar()`, `captacion_dateos_controller.ts::update()` y `comisiones_controller.ts::store()` — un cambio a esta regla afecta los 5 sitios a la vez.

**Facturación ↔ Turnos**: confirmar un ticket de facturación es lo único que marca la etapa "Facturación" como completa (`tieneFacturacion`), y para SOAT es además lo que cierra el turno por completo (ver §1.4). Un ticket de facturación referencia `turno_id`; si ese turno se cancela después de facturado, el ticket de facturación no se revierte (no verificado en detalle en esta revisión, pero no encontré ningún hook que lo haga).

**Comisiones ↔ Turnos**: según `MAPA_DEL_SISTEMA_BACKEND.md` (verificado que la afirmación sobre `comisiones.turno_id` es cierta, ver §6), hay **cuatro** puntos distintos que pueden generar una comisión ligada (indirectamente, vía `captacion_dateo_id`, nunca vía `turno_id` porque esa columna no existe) a un turno: `captacion_dateos_controller.ts::update()`, `comisiones_controller.ts::store()` (manual), `facturacion_tickets_controller.ts::applyCommissionHook()`, y `turnos_cierre_controller.ts::cerrar()` (este último roto e inalcanzable, ver §6). Cada uno con su propia regla de deduplicación — no unificada.

**Tickets Internos ↔ Turnos**: el único tipo de ticket sembrado hoy (`EXCEPCION_DATEO`) existe exclusivamente para resolver el caso "turno sin dateo vinculado" (§3.3). `TicketDetalleExcepcionDateo.turnoId` es la FK hacia `turnos_rtms`.

---

## 6. Roles y permisos: backend vs. frontend

**Backend** (`check_role_middleware.ts` + `start/routes.ts`): autorización simple, un array de roles de string hardcodeado por ruta, comparado contra el **único** rol del usuario (`usuario.rol.nombre`, no hay roles múltiples). No existe conexión con las tablas `permisos`/`items`/`permiso_items`/`rol_permiso_items` (existen en el esquema pero, según `MAPA_DEL_SISTEMA_BACKEND.md`, no las referencia ningún controller ni el middleware — no se pudo re-verificar esta ausencia línea por línea en esta sesión más allá de confirmar que `check_role_middleware.ts` no las menciona).

**Frontend**:
- `usePermissions.ts::can` es un conjunto de funciones que consultan `auth.hasAnyRole([...])` — puramente para mostrar/ocultar UI.
- **El router SÍ tiene un guard global** (`main.ts`, confirmado por el sub-agente), pero solo actúa sobre rutas que declaren `meta.requiresAuth`/`meta.roles`. **Ninguna ruta del módulo RTM declara esos metas** (a diferencia de, por ejemplo, las rutas de Trámites, que sí los declaran). Consecuencia real: cualquier usuario autenticado, sin importar su rol, puede navegar directamente por URL a `/rtm/crear-turno`, `/rtm/turnos-dia`, `/rtm/editar-turno/:id`, `/rtm/estado-turnos`, `/rtm/contador-captacion` o `/rtm/certificacion/:id` — la única protección real de "quién puede hacer qué" en RTM la impone el backend en cada endpoint, no el router del frontend.

**Discrepancias concretas encontradas** (comparando `usePermissions.ts` contra `start/routes.ts`):

| Función/rol | `usePermissions.ts` (frontend) | Backend (`checkRole`) | Discrepancia |
|---|---|---|---|
| Ver menú "Turnos" | `verTurnos()`: SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS | `GET /turnos-rtm` acepta también TRAMITADOR | **TRAMITADOR nunca ve el grupo "Turnos" en el sidebar** (`AppSidebar.vue`, el `v-if="can.verTurnos()"` envuelve todo el grupo, incluida la opción "Crear turno"), pese a que el propio `crearTurno()` sí lo incluye y el backend lo autoriza tanto a crear como a listar turnos. Un TRAMITADOR solo puede usar la función si conoce/teclea la URL directa (posible, porque no hay guard de router, ver arriba) |
| Crear turno | `crearTurno()`: SUPER_ADMIN, OPERATIVO_TURNOS, GERENCIA, TRAMITADOR | `POST /turnos-rtm`: mismos 4 roles | Coincide |
| Editar turno | `editarTurno()`: SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS | `PUT /turnos-rtm/:id`: mismos 3 (sin TRAMITADOR) | Coincide en la lista de roles, pero **`can.editarTurno()` no se usa en ningún lado del frontend** — el botón "Editar" de `TurnosDelDia.vue` no está condicionado por ningún `can.*`, así que hoy lo ve cualquiera que vea la tarjeta |
| Cerrar turno | `cerrarTurno()`: SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS | `POST /turnos-rtm/:id/cerrar`: mismos 3 | El permiso existe en ambos lados, pero el endpoint está roto (§7) y **ninguna vista del frontend invoca la función ni consulta el permiso** — muerto de punta a punta |
| Certificaciones | `crearCertificacion()`/`verCertificaciones()`: SUPER_ADMIN, GERENCIA, OPERATIVO_TURNOS | `POST /certificaciones` y `GET /certificaciones/turno/:id`: mismos 3 | Coincide en roles, pero `CertificacionTurnoView.vue` no hace ningún chequeo `can.*` — se apoya enteramente en el guard de router, que (ver arriba) no existe para esta ruta |

---

## 7. Deuda técnica y hallazgos

### 7.1 Ya documentados por el propio repo (recontrastados, siguen vigentes)

- **`turnos_cierre_controller.ts::cerrar()` (`POST /turnos-rtm/:id/cerrar`) está roto en runtime.** Verificado independientemente en esta sesión: revisé las 4 migraciones que tocan la tabla `comisiones` (`1759155000000_create_comisiones_table.ts`, `1781000000000_...lifecycle...`, `1786000000006_...descuento_caja...`, `1786000000009_...regla_aplicada...`) y **ninguna crea una columna `turno_id`**. La línea `Comision.query({client: trx}).where('turno_id', turno.id).first()` dentro de `cerrar()` referencia una columna inexistente — el endpoint fallaría con `Unknown column 'turno_id'` en el primer query, antes de finalizar el turno, marcar el dateo o crear ninguna comisión. Confirmado además (grep de `/cerrar` y de `cerrarTurno` en todo `front-sgc-pruebas/src`) que ningún botón ni servicio del frontend lo llama.
- **Cancelar/inhabilitar un turno no revierte el dateo vinculado.** Confirmado leyendo `cancelar()` y `destroy()` completos: ninguno de los dos toca `captacion_dateos`.
- **Bug de continuidad sin resolver** en `captacion_dateos_controller.ts::update()` (no re-auditado en detalle esta sesión, se toma del changelog del propio repo: no persiste `estado_continuidad` y cuenta el propio turno en su historial, produciendo falsos "ROTA"). Pendiente de aprobación explícita para arreglar por afectar comisiones ya pagadas.
- **Race condition de `turno_codigo`** por precisión de segundo (§1.6).

### 7.2 Hallazgos nuevos de esta revisión (no encontrados en `MAPA_DEL_SISTEMA_BACKEND.md` ni `MAPA_DEL_SISTEMA_FRONTEND.md`)

1. **Dos ventanas de "RTM vigente" distintas y no sincronizadas** entre `turnos_rtms_controller.ts::store()` (16 días, hardcodeado) y `captacion_dateos_controller.ts::store()` (10 días por defecto, configurable por env var `DIAS_VENTANA_PRE_RTM`). Ver §3.1.
2. **Dos formas de dejar un turno `cancelado` desde `EditarTurno.vue`**, una con trazabilidad completa y liberación de slot (botón "Cancelar turno" → `PATCH .../cancelar`) y otra sin ninguna de las dos cosas (dropdown "Estado del Turno" + "Guardar cambios" → `PUT /turnos-rtm/:id`, que no exige motivo ni invierte el número de turno). Ver §1.5.
3. **`asesorDetectadoId` es un campo muerto de punta a punta desde `CrearTurno.vue`**: el backend tiene una rama completa de "auto-dateo por teléfono detectado" en `store()` que depende de este campo, `busquedas_controller.ts` incluso devuelve `asesorDetectado` en su rama `FACHADA` específicamente para alimentarlo, pero `CrearTurno.vue` nunca lee `resp.asesorDetectado` ni puebla `asesorDetectadoId` en el payload. Es código de backend sustancial, hoy inalcanzable por la única vía de creación de turnos del frontend.
4. **`registrarSalida()` marca el dateo EXITOSO (no-RTM); `certificaciones_controller.ts::store()` no lo hace**, pese a que ambas rutas producen el mismo efecto visible (`estado='finalizado'` + `horaSalida`). Como el frontend certifica siempre por `POST /certificaciones` y nunca por `PUT /:id/salida`, esta marca de éxito del dateo al finalizar por certificación (para servicios no-RTM) no ocurre por ese camino hoy.
5. **`GET /turnos-rtm/siguiente-turno` no replica exactamente la lógica de exclusión de huecos de `store()`** (falta la exclusión de "ya ocupado por un turno_numero positivo" en ambas ramas, y falta también la exclusión por `reasignado_de_turno_id` en la rama por servicio) — el número "siguiente" que ve el operador en pantalla puede no coincidir con el que realmente se asigna al crear. Ver §1.6.
6. **`can.verTurnos()` excluye a TRAMITADOR, pero `can.crearTurno()` (y el backend) sí lo autorizan** — un TRAMITADOR queda sin acceso de menú al módulo completo de Turnos aunque backend lo autorice explícitamente a crear y listar turnos.
7. **Certificar un turno SOAT no tiene ningún guard en `CertificacionTurnoView.vue`** — la exclusión "SOAT no certifica" es solo una omisión de enlace en otras pantallas, no una regla aplicada en la propia vista de certificación.
8. **`TurnosDelDia.vue` y `TurnoDetalleDialog.vue` calculan "¿es SOAT?" con criterios distintos** — uno usa el campo numérico `etapasRequeridas` que manda el backend, el otro compara el string `servicioCodigo === 'SOAT'` a mano. Si se agrega otro servicio sin etapa de certificación en el futuro, estas dos vistas divergirían.
9. **`CrearTurno.vue`/`turnosdeldiaService.ts` no inspeccionan el campo `code` de los errores 409 de `store()`** (`DUPLICATE_DAY`, `WINDOW_BLOCK`, `OPEN_TURNO_SIN_EVIDENCIA`, `OPEN_TURNO_BLOQUEADO`) — solo muestran el `message` de texto en un snackbar genérico. El operador ve la explicación (los mensajes del backend son descriptivos), pero no hay ningún atajo de UI (por ejemplo, un botón para ir a cancelar el turno en conflicto) — tiene que ir manualmente a buscarlo.
10. **`ContadorConvenios.vue` no muestra convenios**: es un reporte de medios de captación + servicio; el nombre del archivo/ruta (`contador-captacion`) es un remanente de una versión anterior del componente.
11. **Código muerto adicional confirmado por el sub-agente**: `registrarSalida`, `activarTurno`, `inhabilitarTurno` en `turnosdeldiaService.ts` sin ningún llamador; ruta `/rtm/proximamente` referenciada desde `TurnosDelDia.vue` (acción `'continuar'`, nunca disparada desde el template) pero inexistente en el router; `can.editarTurno()` y `can.cerrarTurno()` sin consumidores.
12. **`convenioId` en el payload de creación de turno no está tipado** en `CreateTurnoPayload` (se agrega directo en `CrearTurno.vue`, fuera del contrato del servicio) y el backend lo ignora (no está en el `request.only([...])` de `store()`).

### 7.3 Cosas que el usuario planteó y que el código matiza o corrige

- **"La lógica de REQUIERE_TICKET_DATEO para turnos walk-in sin dateo vinculado"**: correcto en espíritu, pero el disparador no es la creación del turno — es el intento posterior de crear/re-datear un *dateo* para ese turno. Ver §3.3 para la distinción exacta.
- **`turnos_cierre_controller.ts` "documentado como roto/inalcanzable"**: confirmado con verificación independiente (no solo repetir el changelog) — la ruta existe y está montada (`POST /turnos-rtm/:id/cerrar`), pero el código revienta antes de hacer nada útil, y no hay ningún llamador en el frontend.
- **Los 4 servicios (RTM, SOAT, PREV, PERI)**: confirmados exactamente esos 4 códigos en `database/seeders/12_servicio_seeder.ts` (además existe un quinto "servicio" especial, `TRAMITES`, que en `CrearTurno.vue` desvía el formulario a un flujo de Trámites completamente distinto, fuera del alcance de `turnos_rtms`).

---

## 8. Lo que no pude verificar con certeza en esta sesión

- El contenido completo de `rep_general_imports_controller.ts` (importación masiva "Rep General"/"TECNOBASE") — me apoyé en el changelog del propio repo para describir sus efectos sobre `turnos_rtms`, sin leer el archivo línea por línea.
- El contenido completo de `continuidad_service.ts` — confirmé su rol y sus llamadores, pero no audité su lógica interna de "CONTINUA/ROTA/SIN_EVIDENCIA" directamente en esta sesión.
- `facturacion_tickets_controller.ts` más allá del método `confirmar()`/`applyCommissionHook()` — el archivo tiene 1845 líneas; no revisé el resto (validaciones de duplicados, OCR, etc.) por no ser el foco de Turnos.
- No pude confirmar en runtime (solo por lectura estática) que `turnos_cierre_controller.ts::cerrar()` efectivamente lanza el error de columna inexistente al ejecutarse — la conclusión se basa en que ninguna migración crea esa columna, lo cual es una inferencia muy sólida pero no una ejecución real observada en esta sesión.
- No verifiqué el archivo `router/index.ts` completo del frontend, solo las líneas relevantes a RTM que citó el sub-agente y confirmé por grep.
