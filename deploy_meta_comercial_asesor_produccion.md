# Checklist de Despliegue a Producción — Meta Comercial por Asesor

> No encontré `deploy_meta_mensual_produccion.md` en ningún repo de este PC — según confirmaste, solo existe en el PC de la oficina y nunca se subió a git. Este documento se redactó desde cero con una estructura estándar de despliegue; si quieres, cuando tengas el original a mano lo alineamos.

## Resumen del cambio

Nuevo módulo de reportes: **Meta Comercial por Asesor** (Esteban Aguiar, Henry Suaza, Steven Cruz), con 4 endpoints (`resumen`, `diario`, `semanal`, `proyectado`) y 3 tablas nuevas. Corte real/histórico alineado con Meta Mensual RTM: **mes < junio/2026 → histórico (Excel reconciliado); mes >= junio/2026 → real (`comisiones`)**.

Commits relevantes en `backend-sgc-pruebas` (a portar/mergear a `backend-sgc`):
- `763c712` — feat: endpoints de Meta Comercial por Asesor (resumen/diario/semanal/proyectado)
- `e778712` — feat: detalle real por vehículo (feb-may) y corte alineado a junio/2026

---

## 0. Pre-requisitos (antes de tocar producción)

- [ ] Confirmar si Meta Mensual RTM ya está desplegado en producción o si este despliegue de Meta Comercial por Asesor va a incluirlo también (mismo archivo `reportes_administrativos_controller.ts`, cambios acumulados). Si RTM ya está en producción, este despliegue es solo el incremento de Meta Comercial; si no, hay que desplegar ambos juntos y seguir también el checklist de RTM (`deploy_meta_mensual_produccion.md`) en el mismo momento, para no dejar el controller en un estado mezclado.
- [ ] Confirmar que `backend-sgc` (producción) tiene el código de ambos commits arriba, con `META_COMERCIAL_CORTE_MES = 6` y `META_COMERCIAL_CORTE_ANIO = 2026` en `reportes_administrativos_controller.ts` (no `8`).
- [ ] Confirmar que `front-sgc` (producción) tiene `ReporteMetaComercialAsesor.vue` + el campo `nota`/`es_estimado` en `MetaComercialProyectadoResponse` (`reportesAdminService.ts`).
- [ ] **Verificar en `agentes_captacions` de producción** si Esteban Aguiar, Henry Suaza y Steven Cruz ya existen. Sus IDs en producción **casi seguro son distintos** a los de pruebas (735/734/736) — ya nos pasó entre oficina y casa. Si no existen, crearlos (`tipo='ASESOR_COMERCIAL'`) y anotar los IDs reales antes de continuar.
- [ ] Tener a mano el Excel reconciliado (histórico semanal + detalle mensual por vehículo, feb-may/2026) usado para cargar pruebas.

---

## 1. Migraciones (3 tablas nuevas)

```
database/migrations/1784400000000_create_meta_comercial_asesor_table.ts
database/migrations/1784400001000_create_historico_comercial_asesor_table.ts
database/migrations/1784500000000_create_historico_comercial_vehiculo_mensual_table.ts
```

- [ ] `node ace migration:status` — confirmar que las 3 aparecen como `pending`.
- [ ] `node ace migration:run`.
- [ ] `node ace migration:status` — las 3 deben quedar `completed`.
- [ ] `SELECT COUNT(*)` de las 3 tablas → deben dar **0** (vacías, recién creadas).

**Nota de troubleshooting (visto en pruebas, en este PC específico):** el entorno de desarrollo con `--hmr` ejecutó el `up()` de cada migración dos veces, causando un falso error "already exists" aunque la tabla sí quedó creada correctamente. Si esto se repite en producción (poco probable, ahí corre JS compilado, no `ts-node`/HMR):
1. Verificar con `SHOW CREATE TABLE <tabla>` que la estructura coincide con la migración.
2. Si coincide y está vacía, insertar manualmente el registro en `adonis_schema` (`name`, `batch` = siguiente número, `migration_time` = NOW()) en vez de reintentar `migration:run` a ciegas.

---

## 2. Carga de histórico — SOLO hasta mayo/2026

Con el corte en junio, **no cargar Excel para junio ni julio** — esos meses ya leen `comisiones` real en producción.

- [ ] **`historico_comercial_asesor`**: cargar únicamente las semanas de **febrero a mayo/2026** (cantidad por semana sábado→viernes, tipo `ASESOR_CONVENIO`/`ASESOR_COMERCIAL`). El set usado en pruebas tenía 73 filas incluyendo una semana de julio para Esteban (solo para simular ahí un mes histórico de prueba, antes de mover el corte) — **esa fila de julio no aplica en producción**, ahí julio ya es real.
- [ ] **`historico_comercial_vehiculo_mensual`**: 9 filas (Esteban+Henry feb/mar/abr/may, Steven solo mayo), con la tarifa real de carro/moto de cada mes (feb-mar: $216.043/$132.726; abr-may: $233.683/$141.339).
- [ ] **Usar los `asesor_id` reales de producción** en todos los INSERT — no los 735/734/736 de pruebas.
- [ ] Verificar `SELECT COUNT(*)` de las 2 tablas tras la carga (debe dar exactamente lo cargado, sin duplicados por unique constraint `asesor_id+mes+anio`).

---

## 3. ⚠️ Aviso crítico — Metas de junio y julio

Con el corte en junio, **junio y julio ya leen comisiones reales** directamente de `comisiones` (confirmado con datos reales en pruebas: Esteban $298.200, Henry $205.200, Steven $148.300 en junio). Pero **si no hay fila en `meta_comercial_asesor` para un asesor/mes, ese asesor no aparece con meta** — el reporte lo mostrará como `SIN_META` indefinidamente, aunque tenga plata real detrás.

- [ ] **Julio** — ya existen metas definidas y reconciliadas para este dataset: Esteban $35M, Henry $35M, Steven $5M. Cargarlas en `meta_comercial_asesor` (mes=7, anio=2026) con los IDs reales de producción.
- [ ] **Junio** — **no hay meta definida en ningún lado todavía** (quedó intencionalmente `SIN_META` durante las pruebas). Antes de dar el módulo por cerrado en producción:
  1. Conseguir de gerencia/negocio la meta de junio para los 3 asesores (o confirmar explícitamente que se deja sin meta ese mes, si así lo deciden).
  2. Insertar esas filas en `meta_comercial_asesor` (mes=6, anio=2026) — antes del despliegue si ya están definidas, o inmediatamente después si hay que esperar la cifra de negocio.
- [ ] Sin este paso, el módulo funciona técnicamente bien pero se ve "incompleto" para el usuario final en los dos meses donde más importa (los más recientes).

---

## 4. Verificación post-despliegue

Con sesión real (SUPER_ADMIN/GERENCIA/CONTABILIDAD) en producción:

- [ ] `GET /reportes-admin/meta-comercial/resumen?mes=6&anio=2026` — una vez cargada la meta de junio, Esteban/Henry/Steven deben aparecer con `fuente:"real"`, sus montos reales de comisión, y `pct_avance`/`semaforo` calculados contra la meta (no `SIN_META`).
- [ ] Mismo chequeo para `mes=7` (julio).
- [ ] `GET .../diario?mes=6&anio=2026&asesor_id=<id>` — debe traer `fuente:"real"` con desglose día a día (no `historico_sin_detalle_diario`).
- [ ] `GET .../semanal` y `.../proyectado` para junio/julio — confirmar que los 3 endpoints (resumen/semanal/proyectado) dan el mismo total mensual para un mismo asesor (mismo patrón de consistencia que validamos en pruebas).
- [ ] `GET .../resumen?mes=3|4|5&anio=2026` — confirmar `es_estimado:false` (detalle real por vehículo) y porcentajes en el rango ya validado (~85%-210%).
- [ ] `GET .../resumen?mes=2&anio=2026` — confirmar `semaforo:"SIN_META"` (no `ROJO`) y `pct_avance:null` para todos.
- [ ] Frontend: abrir **Reportes → Meta Comercial por Asesor**, sin errores de consola, KPIs/tabs cargan para al menos un asesor de cada mes clave (feb, mar-may, jun, jul).

---

## 5. Rollback

- [ ] Revertir el código: `git revert` de los commits mergeados (o quitar del merge/release si aún no se hizo deploy).
- [ ] Si hace falta revertir las tablas: `node ace migration:rollback` (elimina las 3 tablas nuevas — no afecta `comisiones`, `agentes_captacions` ni ninguna tabla existente). Solo hacerlo si no se ha cargado data real de negocio en `meta_comercial_asesor` que no se pueda volver a cargar fácilmente.

---

## 6. Notas / limitaciones conocidas

- Los `asesor_id` **no son portables entre entornos** — cada entorno (pruebas/producción) puede tener IDs distintos para el mismo asesor. Siempre verificar con `SELECT` antes de insertar.
- Feb-mayo usan pesos **reales** por tipo de vehículo con tarifa oficial de cada mes. Cualquier mes histórico sin fila en `historico_comercial_vehiculo_mensual` cae a tarifa plana **estimada** (`es_estimado:true`) — es comparativo contra meta, no cálculo de nómina.
- El corte (`META_COMERCIAL_CORTE_MES/ANIO`) es una constante de código, sin bandera de entorno — mismo comportamiento garantizado en pruebas y producción una vez desplegado el mismo commit.
