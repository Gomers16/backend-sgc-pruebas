# Sincronizar Tickets (Fases 1–7) a producción local

> Documento de plan, 2026-10-19. **No se ha ejecutado nada.** Cada paso necesita aprobación explícita en el momento, y cada comando se muestra antes de correrlo, también las lecturas.

- **Origen:** `C:\Users\ggyt1\backend-sgc-pruebas` y `C:\Users\ggyt1\front-sgc-pruebas` (rama `main`).
- **Destino:** `C:\dev\backend-sgc` y `C:\dev\front-sgc` (producción local, en uso).
- **BD:** la misma (`sgc` en `127.0.0.1`) para las dos instalaciones. Las migraciones de este trabajo **ya están corridas** en esa BD.
- **Base de la sincronización anterior:** backend `555a702` ↔ producción local `a6cf69f`; frontend `0d077ac` ↔ producción local `a6a95fd`.
- **Hasta dónde llega este plan:** backend `555a702..` el commit que agrega este documento (código de la Fase 7 en `0da36a4`); frontend `0d077ac..4fb7a52`. Lista exacta: `git diff --name-status 555a702 HEAD` y `git diff --name-status 0d077ac 4fb7a52`.

## 1. Verificación previa (solo lectura)

Se hizo el 2026-10-19: **todos los archivos compartidos de producción local son idénticos a la base** (`555a702` / `0d077ac`): controladores de dateos, facturación, Rep General y tickets, `comision_calculo_service.ts`, `reserva_dateo_service.ts`, `start/routes.ts`, `AppSidebar.vue`, `usePermissions.ts`, `DateoCreate.vue`, vistas de tickets, `http.ts` y `package.json`. Por eso se puede **copiar sin fusionar**. Hay que repetir la verificación justo antes de copiar, porque producción local puede haber cambiado:

```bash
# backend (repetir con cada archivo M de la sección 2)
cd /c/Users/ggyt1/backend-sgc-pruebas
git show 555a702:app/controllers/facturacion_tickets_controller.ts | diff -q - /c/dev/backend-sgc/app/controllers/facturacion_tickets_controller.ts
# frontend
cd /c/Users/ggyt1/front-sgc-pruebas
git show 0d077ac:src/views/comercial/dateos/DateoCreate.vue | diff -q - /c/dev/front-sgc/src/views/comercial/dateos/DateoCreate.vue
```

Si algún archivo **difiere**, ese no se copia: se fusiona a mano y se revisa.

También antes de empezar: `git status` limpio en `C:\dev\backend-sgc` y `C:\dev\front-sgc`, y respaldo de la BD (como mínimo `tickets`, `tickets_detalle_excepcion_dateo`, `tickets_comentarios`, `ticket_eventos`, `captacion_dateos`, `comisiones`, `turnos_rtms`, `facturacion_tickets`).

No hacen falta dependencias nuevas: `exceljs` (backend) y `chart.js`/`vue-chartjs` (frontend) ya están en producción local.

## 2. Archivos a copiar

`A` = nuevo, `M` = reemplaza al de producción local (idéntico a la base, ver sección 1).

### Backend → `C:\dev\backend-sgc`

**Seguridad y acceso (Fase 1)**
- A `app/services/ticket_acceso_service.ts`
- M `app/controllers/tickets_controller.ts`
- M `app/controllers/tickets_excepcion_dateo_controller.ts`
- M `start/routes.ts`

**Intento de dateo y convenio (Fases 2–3)**
- A `app/services/intento_dateo_service.ts`
- M `app/controllers/captacion_dateos_controller.ts` (el 409 `REQUIERE_TICKET_DATEO` trae `intento`)
- A `database/migrations/1796000000000_add_intento_dateo_to_tickets_detalle_excepcion_dateo.ts`

**Decisión de comisión separada (Fase 4)**
- A `app/services/decision_comision_ticket_service.ts`
- M `app/services/comision_calculo_service.ts` (`decidirCasoComision()`)
- M `app/services/reserva_dateo_service.ts` (`debeRespetarSinComision()` → `{ asesor, convenio }`, foto)
- M `app/controllers/facturacion_tickets_controller.ts` (`applyCommissionHook()`: caso único y fuerza asesor y/o convenio)
- M `app/controllers/rep_general_imports_controller.ts` (respeta los dos flags)
- A `database/migrations/1797000000000_add_con_comision_asesor_convenio_to_tickets_detalle_excepcion_dateo.ts`

**Historial, filtros, estadísticas, exportación (Fase 5 + foto)**
- A `app/models/ticket_evento.ts`
- A `app/services/ticket_eventos_service.ts`
- A `app/services/tickets_consulta_service.ts`
- A `app/services/tickets_estadisticas_service.ts`
- A `database/migrations/1798000000000_create_ticket_eventos_table.ts`
- A `database/migrations/1799000000000_add_montos_calculados_to_tickets_detalle_excepcion_dateo.ts`

**Modelos**
- M `app/models/ticket_detalle_excepcion_dateo.ts`
- M `app/models/ticket.ts` (Fase 7: sin `asignadoA`/`cerradoAt`)
- M `app/models/tipo_ticket.ts` (Fase 7: sin `requiereAprobacionFinanciera`)

**Tests y documentación** (no cambian el comportamiento; se copian para que el repo quede igual)
- A `tests/functional/tickets_seguridad_e2e.spec.ts`, `tickets_intento_dateo_e2e.spec.ts`, `tickets_decision_comision_e2e.spec.ts`, `tickets_historial_estadisticas_e2e.spec.ts`, `tickets_cierre_e2e.spec.ts`
- M `tests/functional/tickets_excepcion_dateo_e2e.spec.ts`, `tests/functional/segunda_vez_flujo.spec.ts`
- A `tests/unit/decision_comision_ticket_service.spec.ts`; M `tests/unit/comision_calculo_service.spec.ts`
- M `MAPA_DEL_SISTEMA_BACKEND.md`; A este documento

### Frontend → `C:\dev\front-sgc`

**Bandeja, detalle y estadísticas**
- M `src/views/tickets/TicketsList.vue`
- M `src/views/tickets/TicketExcepcionDateoDetail.vue`
- A `src/views/tickets/TicketsEstadisticas.vue`
- A `src/views/tickets/filtrosTickets.ts`, `decisionComision.ts`, `resolucionTicket.ts`, `turnoVisible.ts`

**Creación del ticket con el intento de dateo**
- M `src/views/tickets/TicketExcepcionDateoCreate.vue`
- A `src/views/tickets/intentoDateo.ts`
- M `src/views/comercial/dateos/DateoCreate.vue`

**Servicio, permisos e insignia de pendientes**
- M `src/services/ticketsService.ts`
- M `src/composables/usePermissions.ts`
- A `src/composables/useTicketsPendientes.ts`
- M `src/components/layout/AppSidebar.vue`

**Tests y documentación**
- A `src/views/tickets/__tests__/` (5 specs) y `src/composables/__tests__/useTicketsPendientes.spec.ts`
- M `MAPA_DEL_SISTEMA_FRONTEND.md`

**No copiar** `public/videos/` (sin seguimiento, no es parte de este trabajo).

## 3. Migraciones 1796–1799: ya corridas en la BD compartida

| Migración | Batch | Qué agrega |
|---|---|---|
| `1796000000000` | 35 | Intento de dateo en `tickets_detalle_excepcion_dateo` (`canal`, `servicio_id`, `descuento_id`, `es_avance`, `comprobante_avance_url`, `telefono`, `convenio_id_original`), todo NULL o con default |
| `1797000000000` | 36 | `con_comision_asesor`, `con_comision_convenio` (copia de `con_comision`); **`con_comision` intacta** |
| `1798000000000` | 37 | Tabla `ticket_eventos` + backfill |
| `1799000000000` | 38 | `monto_asesor_calculado`, `monto_convenio_calculado` |

Todas son **aditivas**: producción local sigue funcionando con ellas (Lucid ignora las columnas que su modelo no declara).

**Qué ve producción local hoy** (sin los archivos de migración en su carpeta):
- `node ace migration:status` las marca como **`corrupt`** ("The migration file is missing on filesystem"). Es un aviso, no un error de la BD.
- `node ace migration:run` **no las toca** (solo corre archivos pendientes de su carpeta).
- `node ace migration:rollback` **falla** con `E_MISSING_SCHEMA_FILES`. **No correr rollback en producción local** mientras falten los archivos.

**Después de copiar los archivos:** `migration:status` debe mostrarlas como `completed` (batches 35–38) y `migration:run` no debe hacer nada. Si `migration:run` dice que va a correr alguna de ellas, **parar**: algo no cuadra con `adonis_schema`.

**Nunca hacer rollback de estas migraciones con datos reales:** su `down()` borra `ticket_eventos` (1798), las decisiones separadas (1797), la foto (1799) y el intento de dateo (1796).

## 4. Qué puede romperse mientras convivan las dos versiones

### 4.1 Lo que producción local escribe y el código nuevo lee: cubierto

| Producción local escribe | El código nuevo lo lee así | Cubierto por |
|---|---|---|
| Tickets sin intento (`canal` NULL, sin `convenio_id_original`) | `aprobar()` resuelve el intento como `store()`; el detalle y el caso se calculan igual | `tickets_intento_dateo_e2e` ("ticket viejo de asesor convenio") |
| Aprobados solo con `con_comision` (NULL dentro de ventana, 0/1 fuera) | `COALESCE(con_comision_asesor, con_comision)`; el convenio cobra | `tickets_decision_comision_e2e` ("como lo deja producción local"), `debeRespetarSinComision()` |
| Sin `ticket_eventos` | Línea de tiempo con eventos `sintetico` ("reconstruido") | `tickets_historial_estadisticas_e2e` (backfill y producción local) |
| Sin foto del valor calculado | "Dejado de pagar" **estimado** (no exacto) | `tickets_historial_estadisticas_e2e` |
| Comentarios sin evento | Evento `COMENTARIO` sintético | `lineaDeTiempoTicket()` |

**No encontré nada que producción local escriba y que el código nuevo no sepa leer.** Sí hay tres casos donde el código nuevo **lee bien un dato que producción local calculó distinto**:

1. **Caso que se muestra vs. caso con el que se pagó.** El `aprobar()` de producción local tiene el bug del asesor convenio: si el ticket no trae convenio, crea el dateo sin convenio y paga **Caso 1**. El detalle nuevo (`caso_comision`) resuelve el convenio propio del asesor convenio y muestra **Caso 2**. La etiqueta del caso no coincide con la comisión que quedó.
2. **Comisión sin descuento ni avance.** El `aprobar()` de producción local siempre manda `codigoDescuento: null` y `esAvance: false`. El código nuevo no recalcula esas comisiones: se leen tal como quedaron.
3. **Camino diferido de un dateo de producción local** (asesor convenio sin convenio): si Facturación lo confirma producción local, se paga Caso 1; si lo confirma pruebas, Caso 2.

### 4.2 Lo que el código nuevo escribe y producción local lee mal: **riesgo real hasta sincronizar**

Producción local es donde trabaja caja: confirma Facturación y sube el Rep General. Su `applyCommissionHook()` y su `recalcularComisionSiExiste()` solo miran `con_comision`, y con `con_comision = 0` solo ponen `monto_asesor` en $0.

| Aprobado en pruebas (fuera de ventana) | Se guarda | Si Facturación se confirma o el Rep General recalcula **en producción local** |
|---|---|---|
| Caso 1 con o sin comisión | `con_comision` = asesor | Correcto |
| Caso 2 con o sin comisión | `con_comision` = asesor | Correcto (en Caso 2 todo el dinero está en `monto_asesor`) |
| Caso 3 con comisión | `con_comision = 1` | Correcto |
| Caso 3 **sin comisión asesor** | `con_comision = 0` | Correcto (asesor en $0, convenio cobra) |
| Caso 3 **sin comisión convenio** | `con_comision = 1`, `con_comision_convenio = 0` | **Paga el convenio completo** |
| Caso 3 **sin comisión para ninguno** | `con_comision = 0`, `con_comision_convenio = 0` | **Paga el convenio completo** (el asesor sí queda en $0) |

En los dos casos marcados, además, producción local no guarda la foto. Las estadísticas nuevas dirían "sin comisión convenio" y contarían un "dejado de pagar" estimado que en realidad se pagó.

Si Facturación **ya estaba confirmada** cuando se aprobó en pruebas, la comisión nace en el `aprobar()` nuevo y es correcta. Solo después podría pisarla el Rep General de producción local en Casos 1/2, que no tocan el convenio.

Otros puntos:
- **Aprobar desde las dos instalaciones a la vez:** producción local no bloquea el ticket (`FOR UPDATE`). Un `aprobar()` de producción local y uno de pruebas simultáneos sobre el mismo ticket pueden crear **dos dateos**. La ventana es corta, pero existe.
- **Ticket creado en pruebas y aprobado en producción local:** producción local ignora el intento (descuento, avance, teléfono, canal) y solo escribe `con_comision`.
- **Detalle en el frontend de producción local:** compara `detalle.conComision === false/true`; con TINYINT (0/1) nunca se cumple y no muestra la decisión. Bug viejo de producción local que se corrige al sincronizar.

**Recomendación hasta sincronizar:** resolver los tickets reales **solo desde producción local**. Si se aprueba alguno desde pruebas, que no sea Caso 3 "sin comisión convenio" o "ninguno" con Facturación sin confirmar.

### 4.3 Ventana entre el backend y el frontend (backend nuevo + frontend viejo)

- `aprobar()` acepta el body viejo (`{ con_comision }`) en los tres casos: asesor = ese valor, convenio cobra. El frontend viejo sigue aprobando como siempre.
- `GET /tickets` responde `{ data, meta }`: el frontend viejo lee `data` y funciona, pero **solo muestra la primera página (50)**.
- El filtro viejo por estado `RESUELTO`/`CERRADO` sigue siendo válido (devuelve vacío).
- `crear()` es más estricto (turno de hoy activo o finalizado, evidencias de `/media/upload`); el frontend viejo ya sube por `/media/upload`.

Por eso conviene que la ventana sea corta: backend → verificar → frontend en la misma sesión.

## 5. Orden recomendado

1. **Previo** (sección 1): `git status` limpio en los dos destinos, `diff -q` de cada archivo `M`, respaldo de la BD y un momento con poca actividad de caja.
2. **Backend:** copiar la lista de la sección 2 a `C:\dev\backend-sgc`.
3. **Verificar el backend:**
   - `npx tsc --noEmit` en `C:\dev\backend-sgc`
   - `node ace migration:status` → 1796–1799 `completed`, ninguna `pending` ni `corrupt`
   - reiniciar el backend de producción local como se hace hoy
   - humo del backend (sección 6, puntos 1–4) con el frontend viejo
4. **Frontend:** copiar la lista a `C:\dev\front-sgc`, `npx vue-tsc --build` y `npx vitest run`, luego build/arranque como se hace hoy.
5. **Humo completo** (sección 6).
6. Commit local en los dos repos de producción local. **Push y despliegue al servidor: aparte y solo con aprobación.** Las migraciones 1796–1799 **no** están en la BD del servidor remoto; allá hay que respaldar y correrlas antes de reiniciar.

## 6. Pruebas de humo

Con una placa de prueba (`TST…`) y un turno de hoy, sin tocar tickets reales:
1. `GET /api/tickets` como GERENCIA → 200 con `meta`; como COMERCIAL solo lo suyo.
2. Abrir un ticket viejo (aprobado antes por producción local) → detalle, caso, decisión e historial "reconstruido" sin errores.
3. Dateo sobre un turno de hoy sin dateo → 409 `REQUIERE_TICKET_DATEO` con `intento`.
4. Crear el ticket → aprobar fuera de ventana (Caso 3, "sin comisión para el convenio") con Facturación confirmada → comisión con `monto_convenio = 0`, `con_comision_convenio = 0`, foto guardada, eventos `CREADO`/`APROBADO`.
5. Con Facturación **sin** confirmar: aprobar "sin comisión para ninguno" y luego confirmar Facturación desde producción local → `monto_asesor = 0` **y** `monto_convenio = 0` (prueba que el riesgo 4.2 quedó cerrado).
6. Rechazar otro ticket de prueba con motivo → sin dateo ni comisión.
7. Bandeja: columna Turno "N° … · RTM", filtro por N° de turno + fecha, estadísticas y exportar a Excel.
8. Borrar los datos de prueba.

## 7. Cómo revertir

- **Código:** `git checkout -- .` y `git clean` de los archivos nuevos en `C:\dev\backend-sgc` / `C:\dev\front-sgc` (antes del commit), o `git revert` del commit de sincronización. Reiniciar.
- **BD: no revertir.** Las migraciones son aditivas y la versión anterior funciona con ellas. Hacer rollback borraría datos (sección 3). Si se revierte el código, `migration:status` vuelve a marcar 1796–1799 como `corrupt`, y eso es esperado.
- Lo que se haya aprobado con el código nuevo queda bien guardado. La versión vieja lo lee por `con_comision`, con el riesgo de la sección 4.2.

## 8. Cuándo es seguro borrar `con_comision` y las columnas sin uso

Ninguna se borra en este plan. Condiciones:

| Columna / valor | Condición para borrarla |
|---|---|
| `tickets.asignado_a_id`, `tickets.cerrado_at` | Producción local sincronizada (su modelo y su `preload('asignadoA')` ya no existen) **y** el servidor remoto desplegado con el mismo código. 0 filas con valor al 2026-10-19. |
| `tipos_ticket.requiere_aprobacion_financiera` | Igual. Ojo: la migración seed `1787000000006` la escribe; la migración de borrado va aparte y no se edita la vieja. |
| `tickets.estado` ENUM `RESUELTO`/`CERRADO` | Igual, más verificar 0 filas con esos estados y quitarlos de `ESTADOS_TICKET`. |
| `tickets_detalle_excepcion_dateo.con_comision` | Producción local y servidor sincronizados, más una migración que copie `con_comision` a las columnas nuevas en los tickets que solo la tengan (la regla de `sqlCopiaConComision` de 1797), más quitar los `COALESCE`/respaldos del código (`tickets_consulta_service.ts`, `debeRespetarSinComision()`, `lineaDeTiempoTicket()`, `resolucionTicket.ts`) y la escritura en `aprobar()`. |

Las migraciones destructivas van solo después de sincronizar y con aprobación explícita.
