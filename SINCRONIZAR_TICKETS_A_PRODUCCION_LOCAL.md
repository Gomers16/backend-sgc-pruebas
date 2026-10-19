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

## 9. Verificación 2026-10-19 y procedimiento final

> Verificación de solo lectura, hecha el 2026-10-19 después de escribir las secciones 1–8. **Donde esta sección contradice a las anteriores, manda esta.** No se copió, migró ni reinició nada.

### 9.1 Resultado de la verificación

**Estado de producción local**
- `C:\dev\backend-sgc`: HEAD `a6cf69f`, sin commits posteriores, sin cambios ni archivos sin seguimiento.
- `C:\dev\front-sgc`: HEAD `a6a95fd`, sin commits posteriores ni cambios. Solo hay dos archivos sin seguimiento, `deploy-front-casa.bat` y `deploy-front-oficina.bat`, que la copia no toca. **Por ellos no se puede usar `git clean` en el frontend.**

**Archivos** (backend `555a702..b4039c0`, frontend `0d077ac..4fb7a52`)
- Ningún archivo `M` es distinto de la base en producción local: **no hay nada que fusionar**.
- Ningún archivo `A` existe ya en producción local: **no se pisa nada**.
- No hay borrados (`D`).
- Backend: 14 `M` y 19 `A`. Frontend: 9 `M` y 12 `A`. La lista es la de la sección 2, más `SINCRONIZAR_TICKETS_A_PRODUCCION_LOCAL.md`.

**Dependencias**
- `package.json` y `package-lock.json` son idénticos en las dos instalaciones (backend y frontend) y no cambian en el rango.
- Producción local ya tiene instalados `exceljs@4.4.0`, `chart.js@4.5.0` y `vue-chartjs@5.3.2`.

**Columnas que salen del modelo** (`asignado_a_id`, `cerrado_at`, `requiere_aprobacion_financiera`)
- En producción local solo aparecen donde ya se sabía: modelos `Ticket`/`TipoTicket`, `preload('asignadoA')` en `tickets_controller.ts`, las migraciones `1787…` y los tipos de `ticketsService.ts` del frontend.
- No hay triggers, vistas ni rutinas en la BD que las nombren, ni tareas programadas (`node-cron`/`setInterval`) en `app/`, `start/` ni `commands/`.

**Cómo corre producción local**
- `ecosystem.config.cjs`: pm2, nombre `backend-sgc`, `script: './bin/server.ts'`. **Corre las fuentes TypeScript, no `build/`.**
- `build/` está viejo (no tiene `tickets_controller.js`) y no se usa. No hace falta `node ace build`: basta copiar y reiniciar.
- Al momento de la verificación **no había ningún proceso `node` corriendo** en la máquina.

### 9.2 Riesgos nuevos encontrados

1. **`C:\dev\backend-sgc-server` también apunta a la BD `sgc`.**
   - Es una copia de 2025-12 (`ec6a9ea`) con muchos archivos modificados sin commitear.
   - **No tiene `debeRespetarSinComision()`**: su hook de Facturación nunca respeta un "sin comisión", ni siquiera el del asesor.
   - Su `ecosystem.config.cjs` usa **el mismo nombre de pm2 (`backend-sgc`)**.
   - Si alguien la arranca contra esta BD, paga completo cualquier ticket aprobado "sin comisión", y un `pm2 restart backend-sgc` podría reiniciar la instalación equivocada.
   - **No arrancarla.** Antes de reiniciar, confirmar con `pm2 describe backend-sgc` que el `cwd` es `C:\dev\backend-sgc`.
2. **Corrección a la sección 4.2:** el Rep General de producción local, en el Caso 3, deja la comisión "sin cambios" (no toca `monto_convenio`). La única vía de pago indebido es el **hook diferido de Facturación** (`applyCommissionHook()`).
3. **Corrección a la sección 5:** no hay que compilar; producción local corre `bin/server.ts`.

### 9.3 El hook diferido: qué pagaría producción local HOY

En producción local (`facturacion_tickets_controller.ts`, rama Caso 3), `montoConvenio` sale tal cual de `calcularComision()`. Solo se fuerza `montoAsesor = 0`, y solo si `con_comision` es 0 (`debeRespetarSinComision()` devuelve un booleano que mira solo esa columna).

Configuración vigente:
- Global: `monto` (dateo nuevo del comercial) = **8.640** para vehículo y moto. Incentivo de convenio Caso 3 = `valor_placa_vehiculo` **20.000** o `valor_placa_moto` **15.000**.
- Las 4 filas propias de comerciales también tienen `monto` 8.640.
- 1.207 de los 1.218 convenios activos usan el incentivo global. Los otros 11 tienen fila propia con 0, así que su convenio cobra $0 en cualquier caso.

**Caso concreto:** comercial con convenio de incentivo global, vehículo, sin descuento ni avance, aprobado en pruebas fuera de ventana. Facturación se confirma **después**, desde producción local.

| Decisión en pruebas | Se guarda | Debería pagar (asesor / convenio) | Producción local paga HOY |
|---|---|---|---|
| Con comisión | `con_comision=1` | 8.640 / 20.000 | 8.640 / 20.000 ✔ |
| Sin comisión asesor | `con_comision=0`, convenio 1 | 0 / 20.000 | 0 / 20.000 ✔ |
| **Sin comisión convenio** | `con_comision=1`, convenio 0 | **8.640 / 0** | **8.640 / 20.000** ✘ (+20.000; moto +15.000) |
| **Ninguno** | `con_comision=0`, convenio 0 | **0 / 0** | **0 / 20.000** ✘ (+20.000; moto +15.000) |

Además, producción local no guarda la foto. Las estadísticas nuevas mostrarían esa comisión como "sin comisión convenio" con un "dejado de pagar" estimado de 20.000 que en realidad se pagó.

Si Facturación **ya estaba confirmada** al aprobar, la comisión la crea el `aprobar()` de pruebas y queda bien (8.640 / 0).

**Exposición hoy: 0 tickets.**
- La BD tiene 5 tickets (`TSTDEMO1-3`, `QWE123`, `YTR123`, de agosto), todos sin convenio, sin `canal` y **con el turno borrado**.
- Ninguno tiene `con_comision_convenio = 0`.
- El único pendiente (#12) está dentro de ventana, no tiene convenio y su turno no existe, así que `aprobar()` respondería 404.

### 9.4 Recomendación para cerrar la ventana

1. **Sincronizar antes de que se apruebe cualquier ticket real con convenio fuera de ventana.** Hoy la exposición es 0 y producción local no está corriendo, así que es el momento más seguro. Al sincronizar, el hook de producción local pasa a ser el nuevo y la ventana desaparece.
2. Hasta entonces, la regla operativa: **no aprobar desde pruebas** tickets fuera de ventana con convenio. Si se aprueba alguno, que no sea "sin comisión convenio" ni "ninguno" con Facturación sin confirmar.
3. No propongo bloquear las opciones de convenio en el frontend de pruebas. Sería código temporal que hay que quitar después, y con exposición 0 y la sincronización inmediata no aporta. Solo tendría sentido si la sincronización se aplaza varios días mientras se aprueban tickets reales desde pruebas.
4. Justo antes de copiar, repetir la consulta de exposición (paso 1 del procedimiento). Si devuelve filas, revisar esas comisiones a mano después de sincronizar.

### 9.5 Procedimiento final

Cada comando se muestra y se aprueba antes de correrlo. `PB`/`PF` = repos de pruebas, `LB=/c/dev/backend-sgc`, `LF=/c/dev/front-sgc`.

**Paso 0 — Previo (solo lectura)**
1. `git -C $LB status --short` y `git -C $LF status --short`: limpio, salvo los dos `.bat` del frontend.
2. `git -C $LB rev-parse HEAD` = `a6cf69f`; `git -C $LF rev-parse HEAD` = `a6a95fd`.
3. Repetir el bucle de la sección 9.1 (`git show <base>:<f> | diff -q - <destino>/<f>` para `M`, `test -e` para `A`): debe salir igual que ahora.
4. Consulta de exposición (SELECT): tickets `APROBADO` con `con_comision_convenio = 0` cuyo dateo aún no tenga comisión, y tickets `PENDIENTE` con convenio y fuera de ventana.
5. Respaldo de la BD: un `mysqldump` de las tablas de la sección 1. Esto **escribe un archivo**, así que necesita OK propio.
6. `pm2 describe backend-sgc`: confirmar que `cwd` = `C:\dev\backend-sgc` y no `backend-sgc-server`.

**Paso 1 — Copiar el backend**
- `cp` archivo por archivo, desde `PB` (en `b4039c0`) a `LB`, con la lista exacta de `git -C $PB diff --name-status 555a702 b4039c0` (14 `M` + 19 `A`). Crear las carpetas que falten.
- Verificar: `git -C $LB status --short` debe mostrar exactamente esos 33 archivos.

**Paso 2 — Verificar el backend (sin reiniciar todavía)**
- `npx tsc --noEmit` en `LB`.
- `node ace migration:status` en `LB`: 1796–1799 `completed` (batches 35–38), sin `corrupt` ni `pending`. Si aparece alguna `pending`, **parar**.
- **No** correr `migration:run` ni `migration:rollback`.

**Paso 3 — Reiniciar el backend**
- `pm2 restart backend-sgc`, o arrancarlo como se hace hoy si no está corriendo.
- Humo del backend (pruebas 1–3 de la sección 9.6) con el frontend todavía viejo.

**Paso 4 — Copiar y verificar el frontend**
- `cp` de los 9 `M` + 12 `A` de `git -C $PF diff --name-status 0d077ac 4fb7a52`.
- `git -C $LF status --short` = esos 21 archivos, más los dos `.bat`.
- `npx vue-tsc --build` y `npx vitest run` en `LF`, luego servirlo como se hace hoy.

**Paso 5 — Humo completo** (sección 9.6).

**Paso 6 — Commits locales**
- Un commit en `LB` y otro en `LF`, con mensajes que citen `b4039c0` y `4fb7a52`. **Sin push.**
- El despliegue al servidor remoto va aparte: allá las migraciones 1796–1799 **no** están corridas.

**Rollback (solo archivos; la BD no se toca)**
- *Antes del commit del paso 6:*
  - Archivos `M`: `git -C $LB restore --source=a6cf69f -- <lista de M>` y `git -C $LF restore --source=a6a95fd -- <lista de M>`.
  - Archivos `A`: `rm` uno por uno según la lista. **Nunca `git clean -fd`**: en el frontend borraría los `.bat`.
- *Después del commit:* `git -C $LB revert <commit>` y `git -C $LF revert <commit>`.
- Luego reiniciar el backend (`pm2 restart backend-sgc`, después de verificar el `cwd`) y servir el frontend como antes.
- Esperado tras el rollback: `migration:status` vuelve a marcar 1796–1799 como `corrupt`. Es normal. **No** hacer `migration:rollback`.

### 9.6 Pruebas de humo (después de copiar)

Usar una placa `TST…` y un turno de hoy creados para la prueba; no tocar tickets reales. Al final se borran esos datos (con OK).

1. **Arranque:** `pm2 describe backend-sgc` muestra `online` y el `cwd` correcto; el log no tiene errores de importación (`#services/ticket_acceso_service`, etc.).
2. **Bandeja:** `GET /api/tickets` como GERENCIA → 200 con `meta`. Como COMERCIAL → solo lo suyo. Como CONTABILIDAD → vacío.
3. **Ticket viejo:** abrir #4 (de producción local, sin turno) → detalle, decisión "régimen anterior" e historial "reconstruido", sin 500.
4. **Dateo:** turno de hoy sin dateo → 409 `REQUIERE_TICKET_DATEO` con `intento` → el botón lleva al formulario con "Datos del dateo".
5. **Crear y aprobar, camino diferido (cierra 9.3):** ticket Caso 3 fuera de ventana → aprobar "sin comisión para el convenio" con Facturación sin confirmar → confirmar Facturación **desde producción local** → comisión con `monto_asesor` = 8.640 y `monto_convenio` = 0, foto guardada (`monto_convenio_calculado` = 20.000) y eventos `CREADO`/`APROBADO`.
6. **Camino directo:** otro ticket con Facturación confirmada → aprobar "ninguno" → 0 / 0.
7. **Rechazar:** con motivo → sin dateo ni comisión, evento `RECHAZADO`. Sin motivo → el botón queda deshabilitado (y la API responde 400).
8. **Pantalla:** columna Turno "N° … · RTM", filtro por N° de turno + fecha, estadísticas (exacto/estimado), exportar a Excel, insignia de pendientes en el menú.
9. **Configuración de ventana:** leerla funciona. No cambiar valores reales.
10. **Limpieza:** borrar los datos de la placa de prueba (con OK) y confirmar que no quedó ningún ticket `TST…` pendiente.
