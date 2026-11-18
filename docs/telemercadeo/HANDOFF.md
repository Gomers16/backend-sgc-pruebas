# Telemercadeo — Gestión (Fase 1 backend): handoff

Estado al 2026-11-18. Repo: `backend-sgc-pruebas`, rama `main`. Nada sincronizado a producción local.

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
- **Servicios:** `ventana_rtm_service` (ventana `DIAS_VENTANA_PRE_RTM`), `semaforo_service` (movido sin cambios desde `reportes_administrativos_controller`, que ahora lo importa), `telemercadeo_gestion_service`, `telemercadeo_resumen_service`.
- **Controlador y rutas** `/api/telemercadeo/*`: cola, catálogos, gestiones (listar / ver / evidencia / registrar), seguimiento, mi-resumen, resumen, resumen/excel, asesores, metas (GET/PUT), metas/copiar, ciclos/:id/autorizar-extra, config/max-seguimientos (+ asesores).
- **Cola:** `puede_datear_desde` con la ventana compartida; RTM vigente marcado con fecha en CLIENTES (`rtm_vigentes`); `seguimiento` por placa.
- **`uploads_controller`:** `carpeta=telemercadeo` devuelve `ruta` privada; GET/DELETE `/api/uploads/*` no sirven ni borran esa carpeta (también con `../`, `%2e%2e`, `%2f` y mayúsculas); segmentos con `%` o `\` → 404 (antes 500).
- **`auth_controller`:** `agenteTipo` en login y `me`. **`.gitignore`:** `uploads/telemercadeo/`.
- **Tests:** 30/30 en verde (23 `telemercadeo_gestion.spec.ts` + 7 `telemercadeo_cola.spec.ts`). `tsc --noEmit` limpio.
- **Parche de `store()`:** `docs/telemercadeo/store_gestion.patch`, **NO aplicado** (`git apply --check` OK sobre `main`). `captacion_dateos_controller.ts` sin modificar.

## Pendiente backend (en orden)

1. Aplicar el parche: `git apply docs/telemercadeo/store_gestion.patch`.
2. Tests:
   - `telemercadeo_dateo_desde_gestion.spec.ts`: canal TELE y agente del token aunque el body mande otro; gestión → DATEADO y ciclo cerrado DATEADO; 409 con segundo dateo y en paralelo; 403 gestión ajena; 400 placa distinta; rollback si falla la creación.
   - Regresión de `store()` sin gestión (mismo comportamiento que hoy). Nombrar el test del canal por defecto de un `ASESOR_TELEMERCADEO` (queda `ASESOR_COMERCIAL`) como **"caracteriza deuda conocida"**.
3. Suites de dateos y tickets; luego la suite completa contra la línea base **358 pasan + 1 fails ("regression")**.
4. Mostrar el código de `prepararDateoDesdeGestion` y `vincularGestionConDateo` y probar que el ciclo cierra como DATEADO en la misma transacción.
5. Confirmar que `store()` no relee `agente_id` del body cuando llega `telemercadeo_gestion_id`.
6. Excel de resumen: hoy corta en silencio a 20.000 filas (`resumenExcel`, `limit(20000)`); quitar el corte o avisarlo.
7. `GET /telemercadeo/seguimiento`: limitar a ASESOR_TELEMERCADEO, SUPER_ADMIN y GERENCIA (403 al resto, hoy cualquier COMERCIAL entra) + test.
8. SELECT que confirme que los tests no dejaron residuos en la BD compartida (placas `TLG%`, usuarios/agentes "TEST TLG", metas y overrides de esos agentes, archivos en `uploads/telemercadeo/`).
9. Checkpoint del backend con la lista de archivos.

## Pendiente después del checkpoint

- **Fase 2 frontend:** "Mi gestión", "Control de Telemercadeo", botón "Registrar gestión" y estado de seguimiento en la cola, componente `DropzoneImagen`, permisos (`usePermissions.ts`), rutas con `meta.roles`, menú (`AppSidebar.vue`), redirección post-login por `agenteTipo` y corrección del respaldo `agenteId || user.id` de `AuthStore.ts:176` (commit separado).
- Actualizar ambos mapas (`MAPA_DEL_SISTEMA_BACKEND.md`, `MAPA_DEL_SISTEMA_FRONTEND.md`).

## Decisiones ya tomadas

- Meta con `meta_gestiones`, `meta_dateos`, `meta_exitosos`, sin pesos. Meta no definida → sin semáforo (nunca 0%).
- Semáforo sobre dateos exitosos con ritmo prorrateado a los días transcurridos (la UI muestra "avance" y "ritmo"); periodo terminado o futuro → contra la meta completa.
- Seguimiento independiente del re-dateo, contado por cliente (placa + servicio) sumando asesores.
- 4º seguimiento solo por autorización de gerencia sobre el ciclo, con motivo obligatorio (quién y cuándo).
- Solo agentes ASESOR_TELEMERCADEO registran gestiones; comerciales → 403; SUPER_ADMIN/GERENCIA consultan, autorizan extras y administran metas y configuración.
- Canal TELE forzado solo con `telemercadeo_gestion_id`; el arreglo global en `resolverIntentoDateo` queda como deuda (revisar antes impacto en comisiones y Reporte de Asesores con el SELECT de producción).
- Dateo activo de otro asesor: la gestión se permite con aviso.
- Evidencias privadas en `uploads/telemercadeo/`, vistas por `GET /api/telemercadeo/gestiones/:id/evidencia`.

## Avisos

- Las 7 tablas ya existen en la BD local **compartida con producción local**. Al sincronizar, copiar las migraciones 1803–1809 junto con el código. **No correr `migration:rollback` desde el repo de producción local** (Lucid falla con `E_MISSING_SCHEMA_FILES` si faltan los archivos; `migration:run` sí funciona).
- Ventana RTM: en pruebas `DIAS_VENTANA_PRE_RTM` no está definida (10); en producción local es 5.
- `DELETE /uploads/*` sigue abierto a cualquier usuario autenticado para las carpetas públicas: deuda fuera de esta entrega.
- SELECT para dimensionar dateos de telemercadeo mal clasificados (solo lectura, correr en producción):

  ```sql
  SELECT d.canal, COUNT(*)
  FROM captacion_dateos d
  JOIN agentes_captacions a ON a.id = d.agente_id
  WHERE a.tipo = 'ASESOR_TELEMERCADEO'
  GROUP BY d.canal;
  ```
