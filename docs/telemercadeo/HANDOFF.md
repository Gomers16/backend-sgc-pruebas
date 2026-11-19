# Telemercadeo — Gestión y control: handoff

Estado al 2026-11-19. Repos: `backend-sgc-pruebas` y `front-sgc-pruebas`, rama `main`, con push.

- **Fase 1 (backend): completa.**
- **Fase 2 (frontend): completa**, con la corrección del gate por tipo de agente tras la revisión.
- **Pendiente:** el recorrido por la interfaz, a mano en el navegador (el recorrido de la Fase 2 se hizo contra la API de pruebas, ver abajo).
- **Nada sincronizado a producción local ni al servidor.**

> ## ⚠️ Aviso de sincronización a producción local
>
> - **Copiar las migraciones 1803–1809 junto con el código.** Las 7 tablas ya existen en la BD local, que es la **misma** que usa producción local; el repo de producción local necesita los archivos para que Lucid no las vea como "desconocidas".
> - **NO correr `migration:rollback` desde el repo de producción local.** Lucid falla con `E_MISSING_SCHEMA_FILES` si faltan archivos y, sobre la BD compartida, un rollback borraría las tablas que usa pruebas. `migration:run` sí es seguro.
> - En el servidor (BD remota), correr `migration:run` **antes** de `pm2 restart`.

## Commits

- **Backend:** `608a62e` migraciones y modelos, `daf9429` servicios, `466f4a8` endpoints, `39161bd` tests (2026-11-18); `f9aa41d` parche WIP y `19bcd35` handoff (documentos); `f9f49c4` dateo desde gestión, `04747a1` Excel y seguimiento, `3813981` cierre de la Fase 1, `beeaec8` `agente_id` en el seguimiento de la cola, `82c197b` mapa (2026-11-19); y el commit de esta actualización.
- **Frontend:** `45e1649` Fase 2, `224e081` mapa, `fe0e1c0` respaldo `agenteId || user.id`, y el commit del gate por tipo de agente.

## Línea base de la suite

- `main` antes de aplicar el parche: **381 pasan + 1 fails** (382). El "358" que figuraba antes era previo a `telemercadeo_gestion.spec.ts` (23 tests).
- Final de la Fase 1: **396 pasan + 1 fails** (397).
- El `fails` es el `.fails()` esperado del bug ticket SOAT→RTM (`tickets_excepcion_turno_soat.spec.ts`); Japa lo reporta como "regression".
- `tsc --noEmit` limpio.

## Hecho

- **Migraciones 1803–1809** (ya corridas en la BD local compartida; `down()` probado con rollback del lote y vuelto a subir):
  - `1803` `telemercadeo_origenes` (siembra RECURRENCIA, GOOGLE_ADS, REDES)
  - `1804` `telemercadeo_ciclos` (UNIQUE `placa, servicio_id, abierto_key`)
  - `1805` `telemercadeo_gestiones`
  - `1806` `telemercadeo_ciclo_autorizaciones`
  - `1807` `configuracion_seguimiento_tele_global` (max 3, vigencia 30 días)
  - `1808` `configuracion_seguimiento_tele_asesores`
  - `1809` `meta_telemercadeo_asesor`
  - Todas con `utf8mb4_unicode_ci` explícito.
- **Modelos:** `telemercadeo_ciclo`, `telemercadeo_gestion`, `configuracion_seguimiento_tele_global`, `configuracion_seguimiento_tele_asesor`.
- **Servicios:** `ventana_rtm_service` (ventana `DIAS_VENTANA_PRE_RTM`, ahora también usada por `store()`), `semaforo_service` (movido sin cambios desde `reportes_administrativos_controller`, que ahora lo importa), `telemercadeo_gestion_service`, `telemercadeo_resumen_service`.
- **Controlador y rutas** `/api/telemercadeo/*`: cola, catálogos, gestiones (listar / ver / evidencia / registrar), seguimiento, mi-resumen, resumen, resumen/excel, asesores, metas (GET/PUT), metas/copiar, ciclos/:id/autorizar-extra, config/max-seguimientos (+ asesores).
- **Cola:** `puede_datear_desde` con la ventana compartida; RTM vigente marcado con fecha en CLIENTES (`rtm_vigentes`); `seguimiento` por placa.
- **`uploads_controller`:** `carpeta=telemercadeo` devuelve `ruta` privada; GET/DELETE `/api/uploads/*` no sirven ni borran esa carpeta (también con `../`, `%2e%2e`, `%2f` y mayúsculas); segmentos con `%` o `\` → 404 (antes 500).
- **`auth_controller`:** `agenteTipo` en login y `me`. **`.gitignore`:** `uploads/telemercadeo/`.

## Pendientes del backend — todos hechos (2026-11-19)

1. ✅ Parche de `store()` aplicado (`git apply`); el archivo `store_gestion.patch` se eliminó. Con `telemercadeo_gestion_id`: agente del token, canal TELE, servicio de la gestión; cierre de dateos viejos + creación + vínculo en una sola transacción. Sin gestión, `store()` no cambia.
2. ✅ `telemercadeo_dateo_desde_gestion.spec.ts` (13 tests): canal/agente/servicio forzados aunque el body mande otros; gestión → DATEADO y ciclo cerrado DATEADO; 409 secuencial, en paralelo y en carrera dentro de la trx; 403 ajena / 403 comercial / 404 / 400 placa distinta; rollback si falla el INSERT; regresión sin gestión; **"caracteriza deuda conocida"** (ASESOR_TELEMERCADEO sin gestión → ASESOR_COMERCIAL).
3. ✅ Suites de dateos y tickets: 170 + 1 fails. Suite completa: 396 + 1 fails.
4. ✅ `vincularGestionConDateo` probado en la misma transacción: dentro de la trx se ven gestión DATEADO y ciclo cerrado; desde otra conexión no; tras rollback, ambos intactos.
5. ✅ `store()` no relee `agente_id` del body: la única lectura es al inicio y el bloque de gestión la sobrescribe con el agente del token.
6. ✅ Excel de resumen: el tope de la hoja "Gestiones" (`TELE_EXCEL_MAX_DETALLE`, 20.000 por defecto) ya no corta en silencio: aviso en rojo en "Resumen" y "Gestiones" y cabecera `X-Detalle-Truncado` (expuesta en CORS). Test con tope 1.
7. ✅ `GET /telemercadeo/seguimiento`: 403 `NO_ES_ASESOR_TELEMERCADEO` a quien no sea ASESOR_TELEMERCADEO, SUPER_ADMIN o GERENCIA. Test.
8. ✅ Residuos verificados en 0: placas `TLG%`, teléfonos `39911*`/`39912*`, clientes, vehículos, prospectos, agentes/usuarios "TEST TLG", metas/overrides/autorizaciones huérfanas, `uploads/telemercadeo/` vacío.
9. ✅ Checkpoint aprobado. Commits: `f9f49c4` (store + tests), `04747a1` (Excel + seguimiento).

## Archivos de la Fase 1 (desde `36208e4`)

**Nuevos**

- `database/migrations/1803000000000_create_telemercadeo_origenes_table.ts`
- `database/migrations/1804000000000_create_telemercadeo_ciclos_table.ts`
- `database/migrations/1805000000000_create_telemercadeo_gestiones_table.ts`
- `database/migrations/1806000000000_create_telemercadeo_ciclo_autorizaciones_table.ts`
- `database/migrations/1807000000000_create_configuracion_seguimiento_tele_global_table.ts`
- `database/migrations/1808000000000_create_configuracion_seguimiento_tele_asesores_table.ts`
- `database/migrations/1809000000000_create_meta_telemercadeo_asesor_table.ts`
- `app/models/telemercadeo_ciclo.ts`
- `app/models/telemercadeo_gestion.ts`
- `app/models/configuracion_seguimiento_tele_global.ts`
- `app/models/configuracion_seguimiento_tele_asesor.ts`
- `app/services/semaforo_service.ts`
- `app/services/telemercadeo_gestion_service.ts`
- `app/services/telemercadeo_resumen_service.ts`
- `app/services/ventana_rtm_service.ts`
- `tests/functional/telemercadeo_gestion.spec.ts`
- `tests/functional/telemercadeo_dateo_desde_gestion.spec.ts`
- `docs/telemercadeo/HANDOFF.md`

**Modificados**

- `.gitignore`
- `app/controllers/auth_controller.ts`
- `app/controllers/captacion_dateos_controller.ts`
- `app/controllers/reportes_administrativos_controller.ts`
- `app/controllers/telemercadeo_controller.ts`
- `app/controllers/uploads_controller.ts`
- `app/services/telemercadeo_cola_service.ts`
- `config/cors.ts`
- `start/routes.ts`
- `tests/functional/telemercadeo_cola.spec.ts`

## Fase 2 frontend — hecha (2026-11-19)

Detalle en `MAPA_DEL_SISTEMA_FRONTEND.md` 4.2, 4.9 y 8. Resumen:

- Vistas **Mi gestión** (`TelemercadeoMiGestion`) y **Control de Telemercadeo** (`TelemercadeoControl`: Resumen, Gestiones y ciclos, Metas y configuración).
- Cola: "Registrar gestión", columna Seguimiento, RTM vigente en Clientes y "Datear" con `gestion_id` cuando la gestión abierta es propia.
- `DateoCreate.vue` con `?gestion_id=` (canal TELE y servicio fijos, sin agente, `telemercadeo_gestion_id`).
- `DropzoneImagen.vue`, `telemercadeoService.ts` completo, `http.ts::downloadConCabeceras` (aditivo, con test).
- **Gate por tipo de agente** (corrección tras la revisión): "Mi gestión" y "Registrar gestión" solo para COMERCIAL con agente `ASESOR_TELEMERCADEO` (`agenteTipo`). Un comercial sin ese agente no ve el menú ni el botón, y si entra por URL a "Mi gestión" el guard de `main.ts` lo manda al dashboard (`meta.agenteTipo`). SUPER_ADMIN y GERENCIA ven Control y no registran gestiones. Reglas en `utils/permisosTelemercadeo.ts`, con tests.
- Post-login: ASESOR_TELEMERCADEO → "Mi gestión"; comercial sin agente → listado de dateos (antes abría la ficha con `user.id`).
- Vitest 341/341, `vue-tsc` limpio.

### Recorrido

- **Hecho (2026-11-19) contra la API de pruebas**, con las mismas llamadas y payloads de las vistas: registrar gestión con evidencia → "Seguimiento 1 de 3" → reintento idempotente sin duplicar → datear desde la gestión (canal TELE, gestión DATEADO, ciclo cerrado) → cifras en Control y Excel. 22/22 comprobaciones; datos de prueba borrados.
- **Pendiente: recorrerlo a mano en el navegador** (no hubo navegador en la sesión), incluido el gate: asesor de telemercadeo, comercial sin ese agente (sin menú ni botón, redirigido si entra por URL) y gerencia (Control).

### Dateo desde una gestión: convenio, descuento y avance

- **Hoy el frontend envía el dateo desde una gestión sin convenio, sin descuento y sin avance** (`payloadDateo.ts`). **Es una decisión del frontend, no una regla del backend.** Pendiente de definir con negocio; no se cambió.
- **Qué permite el backend:** `prepararDateoDesdeGestion` no mira convenio ni descuento, y `store()` pasa `convenio_id`, `descuento_id` y `es_avance` del body a `resolverIntentoDateo` (solo fuerza canal TELE, agente y servicio). Con canal TELE:
  - `convenio_id`: se acepta si el convenio está asignado activo al agente; si no, 403.
  - `descuento_id`: se acepta si existe y está activo (la regla "con convenio solo AVANCE" es solo para `ASESOR_COMERCIAL`).
  - `es_avance: true`: 400 (solo `ASESOR_COMERCIAL`/`ASESOR_CONVENIO`).
- Ninguno de estos casos tiene test en el backend.

## Decisiones ya tomadas

- Meta con `meta_gestiones`, `meta_dateos`, `meta_exitosos`, sin pesos. Meta no definida → sin semáforo (nunca 0%).
- Semáforo sobre dateos exitosos con ritmo prorrateado a los días transcurridos (la UI muestra "avance" y "ritmo"); periodo terminado o futuro → contra la meta completa.
- Seguimiento independiente del re-dateo, contado por cliente (placa + servicio) sumando asesores.
- 4º seguimiento solo por autorización de gerencia sobre el ciclo, con motivo obligatorio (quién y cuándo).
- Solo agentes ASESOR_TELEMERCADEO registran gestiones; comerciales → 403; SUPER_ADMIN/GERENCIA consultan, autorizan extras y administran metas y configuración.
- Canal TELE forzado solo con `telemercadeo_gestion_id`; el arreglo global en `resolverIntentoDateo` queda como deuda (revisar antes impacto en comisiones y Reporte de Asesores con el SELECT de producción).
- Dateo activo de otro asesor: la gestión se permite con aviso.
- Evidencias privadas en `uploads/telemercadeo/`, vistas por `GET /api/telemercadeo/gestiones/:id/evidencia`.
- Excel: se mantiene un tope de filas en el detalle (rango de hasta 2 años, ExcelJS en memoria), pero siempre avisado.

## Avisos de sincronización (cuando se pida)

- Backend y frontend juntos: el frontend nuevo usa endpoints de la Fase 1 y el campo `agente_id` de `beeaec8`.
- **Copiar las migraciones 1803–1809 junto con el código. NO correr `migration:rollback` desde producción local.** En el servidor, `migration:run` antes de `pm2 restart`.
- `DIAS_VENTANA_PRE_RTM`: 10 en pruebas (sin definir), 5 en producción local.
- Opcional: `TELE_EXCEL_MAX_DETALLE` (por defecto 20.000).

## Avisos y riesgos

- **Test de la carrera** (`telemercadeo_dateo_desde_gestion.spec.ts`, "carrera dentro de la transacción"): para saber que la petición ya está esperando el `FOR UPDATE`, cuenta las transacciones en `LOCK WAIT` de `information_schema.innodb_trx` en **toda la BD compartida**, no solo la suya. Si otra transacción ajena (producción local, otro proceso) está en LOCK WAIT en ese momento, el test puede soltar el bloqueo antes de tiempo. En ese caso la petición pasaría por la validación previa y respondería igual 409, así que el test no fallaría, pero no estaría probando el guard dentro de la transacción. Si se vuelve inestable, filtrar por `trx_mysql_thread_id` de la conexión del servidor.
- Ventana RTM: en pruebas `DIAS_VENTANA_PRE_RTM` no está definida (10); en producción local es 5.
- `DELETE /uploads/*` sigue abierto a cualquier usuario autenticado para las carpetas públicas: deuda fuera de esta entrega.
- Deuda: un ASESOR_TELEMERCADEO que datea sin gestión ni canal queda como ASESOR_COMERCIAL (test "caracteriza deuda conocida").
- SELECT para dimensionar dateos de telemercadeo mal clasificados (solo lectura, correr en producción):

  ```sql
  SELECT d.canal, COUNT(*)
  FROM captacion_dateos d
  JOIN agentes_captacions a ON a.id = d.agente_id
  WHERE a.tipo = 'ASESOR_TELEMERCADEO'
  GROUP BY d.canal;
  ```
