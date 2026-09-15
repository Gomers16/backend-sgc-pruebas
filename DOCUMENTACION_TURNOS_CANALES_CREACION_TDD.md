# Turnos: Canales, Creación y Turnos del Día — verificación profunda

> Complementa `DOCUMENTACION_MODULO_TURNOS.md`. Cada afirmación cita archivo:línea. Donde el código no bastó para responder, se dice explícitamente y se marca qué se necesitaría (datos reales, no disponibles o insuficientes en `-pruebas`).

---

# A) Canales de captación / canal de turno

## A.1 Hay CUATRO conceptos de "canal" distintos, no uno — verificado abriendo cada enum/campo

Esto es lo primero que hay que dejar claro, porque el nombre "canal" se reutiliza para cosas distintas:

| # | Campo / enum | Tabla | Valores reales (leídos de la migración/modelo) | Quién lo escribe |
|---|---|---|---|---|
| 1 | `turnos_rtms.canal_atribucion` | `turnos_rtms` | `'FACHADA' \| 'ASESOR' \| 'TELE' \| 'REDES'` — migración `1758647435984_create_turnos_rtms_table.ts:139` | `turnos_rtms_controller.ts::store()`/`update()` |
| 2 | `turnos_rtms.medio_entero` | `turnos_rtms` | `'Redes Sociales' \| 'Convenio o Referido Externo' \| 'Call Center' \| 'Fachada' \| 'Referido Interno' \| 'Asesor Comercial'` — migración línea 120-127 (nota: 2 valores del enum, `Convenio o Referido Externo` y `Referido Interno`, no los usa ningún código de escritura hoy — solo se escribe `Redes Sociales\|Call Center\|Fachada\|Asesor Comercial` vía `medioFromCanal()`, ver A.2) | Igual que #1, derivado 1:1 de él |
| 3 | `captacion_dateos.canal` | `captacion_dateos` | `'FACHADA' \| 'ASESOR_COMERCIAL' \| 'ASESOR_CONVENIO' \| 'TELE' \| 'REDES'` — `app/models/captacion_dateo.ts:16` | `captacion_dateos_controller.ts::store()`, `busquedas_controller.ts` (auto-dateo por convenio/asesor), `turnos_rtms_controller.ts::store()` (auto-dateo por teléfono) |
| 4 | `facturacion_tickets.captacion_canal` | `facturacion_tickets` | Copia textual de `captacion_dateos.canal` (mismo set de valores que #3) | `facturacion_tickets_controller.ts::store()/reocr()` (líneas 416 y 693, ver A.5) |

Además existe una tabla-catálogo **`captacion_canales`** (`codigo, nombre, descripcion, color_hex, activo, orden` — migración `1758646600000_create_captacion_canales_table.ts:9-14`, valores de ejemplo en el comentario: `FACHADA, ASESOR, TELEMERCADEO, REDES`) con su modelo (`captacion_canal.ts`) y un controlador CRUD completo (`captacion_canales_controller.ts`). **Verificado con grep en `start/routes.ts`: no hay ninguna ruta `captacion-canales` montada.** Es una tabla y un controlador que existen en el código pero son inalcanzables desde la API — confirma el hallazgo ya documentado en `MAPA_DEL_SISTEMA_BACKEND.md` ("Archivos sin Uso"). En el frontend, `captacionCanalesService.ts` apunta a esos endpoints inexistentes y **no lo importa ningún otro archivo de `src/`** (grep de `captacionCanalesService` en todo `front-sgc-pruebas/src` solo encuentra el archivo mismo) — dead en ambos lados, de punta a punta. **Ninguno de los 4 campos reales de la tabla anterior lee ni escribe esta tabla-catálogo.** Los valores de canal que sí se usan viven como enums de MySQL hardcodeados directamente en las columnas, no como filas de una tabla configurable.

**Confirmando tu premisa del MAPA_DEL_SISTEMA_FRONTEND.md**: el mapa dice que el canal de atribución del turno es Fachada/Asesor/Call Center/Redes — es exactamente el enum #1 (`canal_atribucion`), correcto tal cual.

## A.2 Cómo se traduce canal ↔ medioEntero (backend)

`turnos_rtms_controller.ts:80-94`:
```ts
function medioFromCanal(
  canal: CanalAtrib
): 'Fachada' | 'Redes Sociales' | 'Call Center' | 'Asesor Comercial' {
  switch (canal) {
    case 'REDES':
      return 'Redes Sociales'
    case 'TELE':
      return 'Call Center'
    case 'ASESOR':
      return 'Asesor Comercial'
    case 'FACHADA':
    default:
      return 'Fachada'
  }
}
```
Se llama en `store()` (línea 1056-1058, `if (canalAtribucion) { payload.medioEntero = medioFromCanal(canalAtribucion) }`) y en `update()` (línea 1352-1355). **Confirmado: `medioEntero` es un derivado 1:1 de `canal_atribucion`, nunca se decide de forma independiente en el backend.** Si `canalAtribucion` es `null` (turno sin canal detectado ni enviado), `medioEntero` se queda `null` — no hay un `default: 'Fachada'` aplicado a nivel de columna del turno (el `default` del `switch` de arriba solo corre si `canalAtribucion` ya tiene algún valor no-null).

`turnos_rtms_controller.ts:70-78` (normalización de canal recibido del frontend):
```ts
const normalizeCanal = (v?: string): CanalAtrib | null => {
  const x = (v || '').toUpperCase().trim()
  if (['FACHADA', 'ASESOR', 'TELE', 'REDES'].includes(x)) return x as CanalAtrib
  if (['REDES_SOCIALES', 'RRSS'].includes(x)) return 'REDES'
  if (['CALLCENTER', 'CALL_CENTER', 'TELEMERCADEO', 'TELEMARKETING', 'TELEFONO'].includes(x))
    return 'TELE'
  if (['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'].includes(x)) return 'ASESOR'
  return null
}
```
**Detalle no obvio**: esta función colapsa `ASESOR_COMERCIAL` y `ASESOR_CONVENIO` (el enum #3, de `captacion_dateos.canal`) a un único `'ASESOR'` (el enum #1). Es decir, **`turnos_rtms.canal_atribucion` es de menor granularidad que `captacion_dateos.canal`** — a nivel de turno se pierde la distinción de si el asesor era comercial o de convenio; esa distinción solo sobrevive en el dateo vinculado (`turno.captacionDateo.canal`) y en `facturacion_tickets.captacion_canal` (que copia el canal del dateo, no el del turno — ver A.5).

## A.3 Detección automática del canal al crear un turno — orden de prioridad exacto (frontend)

Toda la detección vive en `CrearTurno.vue::doSearch()` (líneas 1135-1253), disparada por `GET /api/buscar` (`busquedas_controller.ts::unificada()`). El backend de `/buscar` ya resuelve una única señal prioritaria (no manda varias para que el frontend elija) — el orden real de prioridad está en `busquedas_controller.ts`, no en el frontend:

```
busquedas_controller.ts::unificada() — orden de resolución, confirmado leyendo el método completo
1. (líneas 175-256) Dateo vigente por placa/teléfono (buildReserva().vigente === true)
     → fuente: 'DATEO', captacionSugerida.canal = canalSimple(dateo.canal)
2. (líneas 259-357) Si no hay dateo vigente: prospecto con convenio asignado
     → CREA un dateo automático ASESOR_CONVENIO en el momento (side-effect de un GET)
     → fuente: 'CONVENIO', captacionSugerida.canal = 'ASESOR'
3. (líneas 359-410) Si no hay dateo ni convenio: agente activo cuyo teléfono coincide EXACTO
   con el teléfono buscado (10 dígitos)
     → devuelto en el campo aparte `asesorDetectado` (NO en captacionSugerida)
4. (líneas 412-436) Sugerencia por teléfono (mismo agente que el punto 3, calculado de nuevo)
     → fuente: 'FACHADA', captacionSugerida = { canal: sugerenciaPorTelefono?.canal ?? 'ASESOR', agente }
     → SOLO se calcula si asesorDetectado (punto 3) fue null (`if (!asesorDetectado && telefono...)`)
5. (línea 437-452) Si nada de lo anterior aplicó: captacionSugerida = { canal: 'FACHADA', agente: null }
```
Copio el if/else exacto del punto 5, porque tiene una rama hermana no obvia:
```ts
busquedas_controller.ts:437-452
// 5. FACHADA
return response.ok({
  fuente: 'FACHADA',
  dateoId: null,
  vehiculo: serializeVehiculo(vehiculo),
  cliente: serializeCliente(cliente),
  dateoReciente: null,
  reserva: null,
  captacionSugerida: sugerenciaPorTelefono || { canal: 'FACHADA', agente: null },
  convenio: null,
  asesorAsignado: sugerenciaPorTelefono?.agente ?? null,
  origenBusqueda: placa ? 'placa' : 'telefono',
  detectadoPorConvenio: false,
  ultimaVisita,
  asesorDetectado, // 👈 NUEVA LÍNEA
})
```
`captacionSugerida` termina siendo `sugerenciaPorTelefono` (canal `'ASESOR'` o `'TELE'` según `agente.tipo`, ver líneas 418-436) si existe, o el objeto FACHADA por defecto si no. **`asesorDetectado` viaja siempre en la respuesta como campo aparte, esté o no vacío — y `CrearTurno.vue` no lo lee en ningún punto** (ver B, hallazgo de `asesorDetectadoId` muerto).

En el frontend, `CrearTurno.vue:1231-1245` consume el único campo `resp.captacionSugerida` (nunca compara contra `resp.dateoReciente` o `resp.asesorDetectado` para decidir por su cuenta — toma tal cual lo que ya decidió el backend):
```ts
CrearTurno.vue:1231-1245
if (resp?.captacionSugerida) {
  const canal = resp.captacionSugerida.canal
  const agente = resp.captacionSugerida.agente
  form.value.medioEntero = mapCanalToMedioEntero(canal)
  form.value._captacionCanal = canal
  form.value._captacionAgenteId = agente?.id ?? null
  form.value.asesorNombre = canal === 'ASESOR' ? (agente?.nombre ?? '') : null
} else {
  form.value.medioEntero = 'fachada'
  form.value._captacionCanal = null
  form.value._captacionAgenteId = null
  form.value.asesorNombre = null
}

form.value._dateoId = resp?.dateoReciente?.id ?? null
```

**Resumen de prioridad real, de mayor a menor**: dateo vigente > prospecto-con-convenio (auto-crea dateo) > agente activo con teléfono exacto > FACHADA. No hay ninguna combinación donde el frontend deba "elegir entre varias señales que aplican a la vez" — el backend ya entrega una sola, resuelta.

## A.4 ¿Se puede sobreescribir manualmente? — Confirmado: NO, de forma efectiva, una vez hay una búsqueda con resultado

Esto es un hallazgo nuevo, no documentado en ninguno de los dos MAPA existentes. El payload final que se manda al backend usa:
```ts
CrearTurno.vue:1463
const canal: CanalAtrib = form.value._captacionCanal ?? mapMedioEnteroToCanal(form.value.medioEntero)
```
`form.value._captacionCanal` es la variable interna que llenó `doSearch()` (A.3). El dropdown visible "¿Cómo nos conoció?" (`form.value.medioEntero`) **solo se usa como fuente del canal si `_captacionCanal` es `null`/`undefined`**. Verificado que no existe ningún watcher que sincronice `_captacionCanal` cuando el operador cambia el dropdown a mano:
```ts
CrearTurno.vue:1356-1360 — el ÚNICO watch sobre medioEntero
watch(() => form.value.medioEntero, () => {
  if (form.value.medioEntero !== 'asesor') {
    form.value.asesorNombre = null
  }
})
```
Solo limpia `asesorNombre`; nunca toca `_captacionCanal`. **Consecuencia real**: si una búsqueda (automática o manual) ya devolvió una `captacionSugerida` no-FACHADA, y el operador después cambia manualmente el dropdown "¿Cómo nos conoció?" (por ejemplo porque el cliente aclaró que en realidad no vino por ese medio), **el cambio del dropdown no tiene ningún efecto en lo que se envía al backend** — sigue viajando el canal auto-detectado. El dropdown solo decide el canal real cuando nunca hubo una búsqueda con resultado (placa/teléfono sin match, `captacionSugerida` ausente → cae al `else` de A.3 que sí deja `_captacionCanal = null`).

### Hallazgo corregido tras re-investigación: el mecanismo NO es el botón "Limpiar"

**Corrección explícita a una versión anterior de este documento**, que atribuía este riesgo al botón "Limpiar" (`resetBusqueda()`). Se re-investigó a fondo (grep de las 3 variables en todo el archivo, de los 4 `watch()` existentes, y trazado literal paso a paso) y **"Limpiar" resultó ser irrelevante para el mecanismo real** — se confirma abajo por qué.

`resetBusqueda()` completa, línea por línea (`CrearTurno.vue:1255-1261`):
```ts
function resetBusqueda() {
  telefonoBusqueda.value = ''
  busqueda.value = null
  form.value.medioEntero = null
  form.value.asesorNombre = null
  lastSearched.value = { placa: '', tel: '' }
}
```
Efectivamente no resetea `form.value.placa`, `_dateoId`, `_captacionCanal` ni `_captacionAgenteId`. **Pero esto no importa en la práctica**, porque `doSearch()` (única otra función que escribe esas 3 variables, junto con el reset completo `resetFormFields()`) las sobreescribe de forma **incondicional** cada vez que una búsqueda se completa con éxito — tanto si encuentra un dateo como si no (`CrearTurno.vue:1231-1245`: la rama `else` deja `_captacionCanal=null` y, fuera del if/else, `_dateoId` siempre se reasigna en la línea 1245). Es decir: **si tras "Limpiar" el operador vuelve a buscar (aunque sea la misma placa u otra), los 3 campos quedan correctamente refrescados sin importar qué haya dejado "Limpiar" sin tocar.** Trazado paso a paso (buscar A → Limpiar → buscar B → Guardar): el payload final para B no contiene `dateoId` ni `agenteCaptacionId` de A — la búsqueda de B los sobreescribe correctamente a `null`/`'FACHADA'`.

**El mecanismo real, confirmado, es otro**: el riesgo depende únicamente de si **el valor de `form.placa` cambia sin que llegue a completarse una nueva búsqueda para ese valor antes de enviar el formulario** — con o sin haber pasado por "Limpiar" en el camino (es irrelevante, porque "Limpiar" tampoco toca `form.placa`). Dos vías concretas, verificadas:

1. **Placa de moto (5 caracteres) sin pulsar "Buscar"**: el `watch()` automático de placa (`CrearTurno.vue:1346-1350`) solo dispara `doSearch(false)` si `PLACA_COMPLETA_AUTO_REGEX.test(p)` es verdadero, y esa regex exige el patrón de 6 caracteres (`CrearTurno.vue:793`). Una placa de 5 caracteres nunca cumple esa condición, así que el watch no hace nada; si el operador tampoco pulsa el botón "Buscar" ni Enter (los únicos otros disparadores de `doSearch()`), ninguna búsqueda corre para la placa nueva, y los `_dateoId`/`_captacionCanal`/`_captacionAgenteId` de la búsqueda ANTERIOR quedan intactos.
2. **Carrera con una búsqueda en curso**: el botón "Crear nuevo turno" solo se deshabilita por `isSubmitting`, nunca por `buscando` (`CrearTurno.vue:510-511: :loading="isSubmitting" :disabled="isSubmitting"`), y `openConfirmDialog()` no compara `form.placa` contra `lastSearched.placa` antes de permitir continuar. Un envío mientras una búsqueda automática sigue en vuelo usaría los valores de la búsqueda previa.

**Nota importante**: "Buscar por Placa" (línea 43) y "Placa del Vehículo" (línea 180) son literalmente el mismo `v-model="form.placa"` — no son dos campos independientes, así que no hay forma de editar "la placa del formulario" sin afectar también la caja de búsqueda ni viceversa.

**El backend no ofrece ninguna red de seguridad para este caso específico** — re-verificado en `turnos_rtms_controller.ts:805-828`: la validación del `dateoId` explícito solo llama a `dateoAplicaAServicio(dateoExplicito, servicio.id)`, que compara **exclusivamente el servicio**. No existe ninguna comparación de `dateoExplicito.placa` contra la `placa` del turno que se está creando en todo el método `store()`. Si el dateo stale de la placa A es del mismo servicio que el turno de la placa B y sigue vigente (`buildReserva()`), el backend lo vincularía sin objeción al turno de B.

**No confirmado con datos reales** — es una conclusión determinista de lectura de código (todo el mecanismo ocurre en JavaScript del navegador, antes de cualquier petición HTTP; no hay comportamiento de base de datos que lo confirme o refute). No es posible reconstruir con una consulta SQL si esto ya ocurrió en producción, porque ni `captacion_dateos` ni `turnos_rtms` guardan un histórico de "qué placa tenía el dateo en el momento exacto de vincularse" para poder cruzarlo contra la placa final del turno.

## A.5 Canal cuando el turno SÍ tiene dateo vinculado vs cuando NO lo tiene

Con dateo vinculado (`turnos_rtms_controller.ts::store()`, función interna `vincularDateoVigente()`, líneas 877-894):
```ts
turnos_rtms_controller.ts:877-894
const vincularDateoVigente = (d: CaptacionDateo) => {
  dateo = d
  dateoObservacion = d.observacion || null
  dateoImagenUrl = d.imagenUrl || null
  dateoCanal = d.canal || null

  const cRaw = (d as any).canal as string | undefined
  const cNorm = normalizeCanal(cRaw)
  if (cNorm && !canalAtribucion) {
    canalAtribucion = cNorm
  }
  if (!agenteCaptacionId) {
    agenteCaptacionId = (d as any).agenteId ?? (d as any).agente_id ?? null
  }

  captacionDateoId = d.id
  esAvanceHeredado = Boolean((d as any).esAvance ?? false)
}
```
**Detalle no obvio, confirmado por el `if (cNorm && !canalAtribucion)`**: el canal del dateo **solo sobreescribe** `canalAtribucion` si el turno todavía no traía uno (por ejemplo, si el frontend no envió `canal` en el payload). Si el frontend ya mandó un canal explícito (que es el caso normal, porque `CrearTurno.vue` siempre computa uno vía A.4), **el dateo NO pisa el canal que ya trae el turno** — solo aporta `dateoCanal` (columna separada, guarda el canal del dateo tal cual, para mostrarlo en UI) y `agenteCaptacionId` si faltaba. En la práctica, como el canal del turno casi siempre viene ya poblado desde el frontend (y ese canal, por A.3/A.4, en la mayoría de los casos con dateo YA es el mismo que trae el dateo, porque ambos derivan de la misma búsqueda), esto rara vez cambia el resultado — pero la condición existe.

Sin dateo vinculado: `canalAtribucion` queda con lo que haya mandado el frontend (auto-detectado o FACHADA), `dateoCanal`/`dateoObservacion`/`dateoImagenUrl`/`captacionDateoId` quedan `null`.

## A.6 Canal, comisiones y reportes

**Comisiones — verificado con grep de `canal` en `comision_calculo_service.ts`: cero resultados.** El motor de cálculo de comisión (`calcularComision()`) no usa el canal para nada — decide el monto por `caso` (`SIN_CONVENIO | CONVENIO_SELF | CONVENIO_COMERCIAL`, derivado de si el dateo tiene `convenioId` y si el `agenteId` del dateo coincide con el asesor del convenio) y `escenario` (`NUEVO | RECURRENTE | RECUPERACION`). El canal no es un input de ese cálculo en ningún punto.

**`ReporteIngresosCanal.vue`** (`/reportes-admin`, no es una vista de RTM pero el usuario preguntó por ella explícitamente): **no usa `turnos_rtms.canal_atribucion`.** Consume `GET /reportes-admin/ingresos-canal` → `reportes_administrativos_controller.ts::computeIngresosPorCanal()` (líneas 1650-1703), que agrupa por **`facturacion_tickets.captacion_canal`** (enum #4 de la tabla de A.1, copiado de `captacion_dateos.canal`, NO de `turnos_rtms.canal_atribucion`):
```ts
reportes_administrativos_controller.ts:1657-1670
const rows = (await Database.from('facturacion_tickets as ft')
  .join('turnos_rtms as t', 't.id', 'ft.turno_id')
  .where('ft.estado', 'CONFIRMADA')
  .where('ft.servicio_codigo', 'RTM')
  .where('t.estado', 'finalizado')
  .whereRaw("t.placa NOT LIKE 'TST%'")
  .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
  .select(Database.raw("COALESCE(ft.captacion_canal, 'FACHADA') as captacion_canal"))
  .count('* as cantidad')
  .sum('ft.total as total_bruto')
  .sum('ft.subtotal as total_neto')
  .avg('ft.total as promedio_ticket')
  .groupByRaw("COALESCE(ft.captacion_canal, 'FACHADA')")
  .orderBy('total_bruto', 'desc')) as any[]
```
**Filtrado explícitamente a `ft.servicio_codigo = 'RTM'` — excluye SOAT/PREV/PERI de este reporte por completo.** El comentario del propio código, línea 1755-1758 (dentro de `computeProduccionPorLider`, un método hermano que documenta el mismo criterio): *"SOAT/PREV/PERI no generan ticket en este entorno"*. **Esto contradice datos reales que ya verifiqué contra `-pruebas` en la sesión anterior**: hay 12 tickets `CONFIRMADA` de turnos PREV y 8 de PERI en esa misma base. El comentario del código está desactualizado o se refiere a otra cosa (posiblemente "no generan comisión", que sí es cierto, y alguien lo escribió confundiendo "ticket" con "comisión") — señalo esto como una discrepancia entre el comentario del código y los datos reales, no como un bug funcional de `computeIngresosPorCanal()` en sí (que de todas formas los excluiría igual por el filtro explícito `servicio_codigo='RTM'`, tenga o no razón el comentario).

`facturacion_tickets.captacion_canal` se llena así (`facturacion_tickets_controller.ts:404-421` en `store()`, y de nuevo en `685-700` en otro método — pego ambos completos por la regla de "if/else completo"):
```ts
facturacion_tickets_controller.ts:404-421 (store())
if (dateoId) {
  const dateo = await CaptacionDateo.query()
    .where('id', dateoId)
    .preload('agente')
    .preload('asesorConvenio')
    .preload('convenio')
    .first()

  if (dateo) {
    if (!ticket.placa && (dateo.placa || '').trim())
      ticket.placa = (dateo.placa || '').toUpperCase().replace(/\s+/g, '')
    ticket.agenteId = dateo.agenteId ?? ticket.agenteId ?? null
    ticket.captacionCanal = dateo.canal ?? null
    ticket.agenteComercialNombre = (dateo.agente as any)?.nombre ?? null
    ticket.asesorConvenioNombre = (dateo.asesorConvenio as any)?.nombre ?? null
    ticket.convenioNombre = (dateo.convenio as any)?.nombre ?? null
  }
}
```
```ts
facturacion_tickets_controller.ts:685-700 (segundo método, aplica cuando se re-vincula el dateo del ticket)
if (ticket.dateoId) {
  const d = await CaptacionDateo.query()
    .where('id', ticket.dateoId)
    .preload('agente')
    .preload('asesorConvenio')
    .preload('convenio')
    .first()
  if (d) {
    ticket.captacionCanal = d.canal ?? ticket.captacionCanal ?? null
    ticket.agenteComercialNombre =
      (d.agente as any)?.nombre ?? ticket.agenteComercialNombre ?? null
    ticket.asesorConvenioNombre =
      (d.asesorConvenio as any)?.nombre ?? ticket.asesorConvenioNombre ?? null
    ticket.convenioNombre = (d.convenio as any)?.nombre ?? ticket.convenioNombre ?? null
  }
}
```
**Ambas ramas solo corren `if (dateoId)`/`if (ticket.dateoId)`** — si el ticket no tiene dateo vinculado, `captacionCanal` queda `null`, y el reporte lo trata como `'FACHADA'` vía el `COALESCE(...,'FACHADA')` visto arriba. Consistente con el patrón "sin dateo = FACHADA" que se repite en todo el sistema.

**Hallazgo menor de UI**: `ReporteIngresosCanal.vue:243-249` define:
```ts
const CANAL_LABELS: Record<string, string> = {
  FACHADA: 'Fachada',
  ASESOR_COMERCIAL: 'Asesor Comercial',
  ASESOR_CONVENIO: 'Asesor Convenio',
  TELEMERCADEO: 'Telemercadeo',
  REDES: 'Redes / Marketing Digital',
}
```
La clave `TELEMERCADEO` no existe en el enum real de `captacion_dateos.canal` (que es `'TELE'`, confirmado en `captacion_dateo.ts:16`). Como el helper hace `CANAL_LABELS[c] ?? c`, un canal `'TELE'` real se mostraría como el string crudo `"TELE"` en vez de una etiqueta bonita — un mapeo con la clave equivocada, no un bug funcional (no rompe nada, solo se ve peor de lo previsto).

**`ContadorConvenios.vue`** (RTM, sí es del módulo que nos ocupa): agrupa por **`turnos_rtms.canal_atribucion`** (enum #1), vía `TurnosDelDiaService.fetchTurnos()`/`exportTurnosExcel*` con el parámetro `canalAtribucion` — confirmado en el informe del sub-agente de la sesión anterior y en `turnosdeldiaService.ts:380-497` (todas las funciones de exportación mapean sus "medios" seleccionados de vuelta a `canalAtribucion` antes de pedir el Excel). **Es decir, `ContadorConvenios.vue` y `ReporteIngresosCanal.vue` usan dos taxonomías de canal completamente distintas y no comparables directamente** (una por turno/`canal_atribucion`, la otra por ticket de facturación/`captacion_canal` heredado del dateo, y solo para RTM).

**El modal de estadísticas de `TurnosDelDia.vue`** usa una TERCERA fuente para su desglose "Canal de captación" — ni `canal_atribucion` ni `captacion_canal`, sino `turno.medioEntero` (enum #2), reclasificado en el propio frontend:
```ts
TurnosDelDia.vue:1540-1553
const mapMedioToCanalCaptacion = (
  medio: Turno['medioEntero']
): MedioCaptacionLabel => {
  if (!medio) return 'Otros'
  const m = medio.toString().toLowerCase()

  if (m.includes('redes')) return 'Redes Sociales'
  if (m.includes('call') || m.includes('tele')) return 'Call Center'
  if (m.includes('fachada')) return 'Fachada'
  if (m.includes('asesor')) return 'Asesor'
  if (m.includes('referido') || m.includes('convenio')) return 'Asesor'

  return 'Otros'
}
```
En la práctica coincide con `canal_atribucion` porque `medioEntero` es derivado 1:1 de él en el backend (A.2), pero es una tercera pieza de código que reimplementa la misma clasificación por su cuenta, sobre un campo distinto.

## A — Tabla de endpoints/archivos

| Pieza | Archivo(s) | Endpoint |
|---|---|---|
| Enum `canal_atribucion` del turno | `turnos_rtms_controller.ts:70-94`, migración `1758647435984` | `POST/PUT /turnos-rtm[/:id]` |
| Enum `canal` del dateo | `captacion_dateo.ts:16`, `captacion_dateos_controller.ts` | `POST/PUT /captacion-dateos[/:id]` |
| Catálogo `captacion_canales` (muerto) | `captacion_canales_controller.ts`, `captacion_canal.ts`, migración `1758646600000` | Ninguno montado |
| Detección automática | `busquedas_controller.ts::unificada()` | `GET /buscar` |
| Consumo en creación de turno | `CrearTurno.vue:1231-1245, 1356-1360, 1463` | — |
| Canal en facturación/reportes | `facturacion_tickets_controller.ts:404-421, 685-700`; `reportes_administrativos_controller.ts:1650-1703` | `GET /reportes-admin/ingresos-canal` |
| Canal en ContadorConvenios | `turnosdeldiaService.ts:380-497` | `GET /turnos-rtm/export-excel` |

## A — No pude verificar con certeza / requiere confirmación con datos reales

- **No pude confirmar en datos reales el escenario de "canal/dateo obsoleto por placa cambiada sin re-búsqueda"** (A.4, re-investigado y corregido — ya NO se atribuye al botón "Limpiar", ver el detalle) — es una conclusión de lectura estática de código, no observada en `-pruebas` ni en producción. Para confirmarla haría falta un log de aplicación (request bodies de `POST /turnos-rtm`) correlacionado con clics de UI, que no tengo forma de obtener desde aquí.
- **No pude confirmar con datos si el mapeo `CANAL_LABELS` de `ReporteIngresosCanal.vue` alguna vez mostró "TELE" crudo en pantalla** — necesitaría datos de canal `TELE` real en tickets confirmados de RTM en el rango consultado; no corrí esa consulta porque es tangencial a Turnos.
- El comentario "SOAT/PREV/PERI no generan ticket en este entorno" (`reportes_administrativos_controller.ts:1755-1758`) lo contrasté contra los conteos de `-pruebas` de la sesión anterior (12 PREV + 8 PERI `CONFIRMADA`) y es falso tal como está escrito — pero no tengo forma de saber si el comentario se refería a otra cosa (ej. un entorno más antiguo, o un tipo de ticket distinto) sin preguntar a quien lo escribió.

---

# B) Creación de turnos — flujo end-to-end

## B.1 Aclaración de alcance importante (corrige el encuadre de la pregunta)

Pediste el "flujo de decisión completo" de RTM vigente / dateo activo / `REQUIERE_TICKET_DATEO` / excepción de roles privilegiados **dentro de `store()` de turnos**. Verifiqué con grep exhaustivo sobre `turnos_rtms_controller.ts` completo:

```
grep "esPrivilegiado|confirmarExcepcion|REQUIERE_TICKET_DATEO|RTM_VIGENTE|DATEO_ACTIVO" turnos_rtms_controller.ts
→ 0 resultados
```

**Ninguno de esos 4 conceptos existe en `turnos_rtms_controller.ts`.** Viven exclusivamente en `captacion_dateos_controller.ts::store()`/`::redatear()` — es decir, se disparan al crear o re-datear un **dateo** (acción del módulo Comercial/Dateos), no al crear un **turno**. `CrearTurno.vue` nunca llama a `POST /captacion-dateos` ni a `POST /captacion-dateos/:id/redatear` — solo llama a `GET /buscar` (de solo lectura, salvo el side-effect de auto-crear un dateo por convenio, ver A.3 punto 2) y a `POST /turnos-rtm`. Por lo tanto: **crear un turno nunca puede fallar por `RTM_VIGENTE`, `DATEO_ACTIVO` ni `REQUIERE_TICKET_DATEO`, y no existe ninguna excepción de rol privilegiado en la creación de turnos.** Esto ya lo había señalado en el documento anterior; lo re-confirmo aquí con el grep en cero para que quede sin ambigüedad.

Lo que **sí** puede bloquear `POST /turnos-rtm` son 4 cosas, todas dentro de `turnos_rtms_controller.ts::store()`, sin ninguna excepción de rol en ninguna de ellas (tampoco tiene sentido buscar `esPrivilegiado` aquí: no existe la variable):

## B.2 Diagrama de decisión real de `store()` (texto), en el orden exacto en que corre el código

```
POST /turnos-rtm
│
├─ 1. ¿Faltan placa/tipoVehiculo/usuarioId/fecha/horaIngreso? ──sí──▶ 400
├─ 2. ¿usuarioId no resuelve a un Usuario con sede? ────────────sí──▶ 400
├─ 3. ¿servicioId/servicioCodigo no resuelve a un Servicio? ────sí──▶ 400
├─ 4. ¿tipoVehiculo fuera del enum? ─────────────────────────────sí──▶ 400
│
├─ 5. DUPLICATE_DAY (líneas 546-566)
│    ¿Ya existe, HOY, misma sede+servicio+placa, un turno con estado != 'cancelado'?
│    ──sí──▶ 409 DUPLICATE_DAY (sugiere reintentar mañana)
│    ──no──▶ continúa
│
├─ 6. WINDOW_BLOCK (líneas 568-596) — SOLO si servicio es RTM o SOAT (bloqueoMesesPorServicio)
│    ¿Existe un turno FINALIZADO previo de esta placa+servicio (cualquier sede)?
│      ──no──▶ continúa (cliente nuevo para este servicio, sin restricción)
│      ──sí──▶ vencimiento = últimaFecha + 12 meses; nextAllowed = vencimiento - 16 días
│              ¿fecha del turno nuevo < nextAllowed? ──sí──▶ 409 WINDOW_BLOCK (SIN excepción de rol)
│                                                     ──no──▶ continúa
│
├─ 7. Regla 1 — turno ABIERTO de un día ANTERIOR (líneas 598-645)
│    ¿Existe un turno 'activo' de esta placa+servicio+sede, de fecha != hoy?
│      ──no──▶ continúa
│      ──sí──▶ ¿tiene facturación Y/O certificación (evidencia)?
│               ──ninguna──▶ 409 OPEN_TURNO_SIN_EVIDENCIA (ofrece cancelarlo)
│               ──alguna──▶ 409 OPEN_TURNO_BLOQUEADO (exige completarlo o cancelarlo)
│
├─ 8. Cálculo de hueco/siguiente número (ver B.3) — no bloquea, solo asigna
│
├─ 9. Resolución de vehículo/cliente/conductor (crea si no existen)
│
├─ 10. VINCULACIÓN DE DATEO (ver B.4) — no bloquea nunca la creación del turno;
│      en el peor caso el turno se crea SIN dateo vinculado
│
├─ 11. Clasificación recurrencia/recuperación/continuidad
├─ 12. INSERT del turno
├─ 13. Auto-dateo por `asesorDetectadoId` (solo si servicio=RTM) — no bloquea
│
└─ 14. catch: si el INSERT choca con `uq_turno_activo_por_placa_servicio_dia`
       (índice único `dedupe_key`, condición de carrera) ──▶ 409 DUPLICATE_DAY
```

**Ninguna de las 4 validaciones que sí existen (5, 6, 7, 14) tiene una vía de excepción para SUPER_ADMIN/GERENCIA.** Esto contrasta con `captacion_dateos_controller.ts::store()`, donde la regla equivalente de vigencia RTM (`RTM_VIGENTE`) sí tiene excepción (`RTM_VIGENTE_EXCEPCION_DISPONIBLE`). **Es una discrepancia real entre los dos controladores para una regla de negocio casi idéntica** (vigencia de 12 meses de RTM), no documentada antes: un SUPER_ADMIN puede saltarse el bloqueo de RTM vigente al *datear*, pero no puede saltarse el bloqueo equivalente (`WINDOW_BLOCK`) al *crear el turno* directamente. Si el flujo de negocio real necesita crear turnos anticipados con aprobación de gerencia, hoy no hay forma de hacerlo vía `POST /turnos-rtm` — la única vía sería aprobar la excepción en Dateos y crear el turno con ese dateo ya vigente, lo cual **tampoco ayuda**, porque `WINDOW_BLOCK` se evalúa en `store()` de turnos ANTES de tocar dateos, y no depende de si hay un dateo vigente o no.

## B.3 Sistema de números de turno — cálculo y huecos, con certeza sobre la discrepancia de `/siguiente-turno`

**Dos consecutivos por turno**: `turnoNumero` (global, sede+día) y `turnoNumeroServicio` (sede+día+servicio). Cancelar invierte el signo (negativo = libre), liberando el hueco para reasignación (ver `DOCUMENTACION_MODULO_TURNOS.md` §1.6 para el detalle del índice único).

### Bloque real de `store()` (líneas 647-729), completo:
```ts
turnos_rtms_controller.ts:647-729
// ── Reasignación: slots liberados por cancelados del mismo día ──────
// Subquery: IDs de cancelados cuyo slot global ya fue reclamado
const slotsClamados = trx
  .from('turnos_rtms')
  .select('reasignado_de_turno_id')
  .where('sede_id', usuarioCreador.sedeId!)
  .where('fecha', hoyISO)
  .whereNotNull('reasignado_de_turno_id')

const huecoGlobal = await trx
  .from('turnos_rtms')
  .select('id')
  .select(Database.raw('ABS(turno_numero) AS slot_libre'))
  .where('sede_id', usuarioCreador.sedeId!)
  .where('fecha', hoyISO)
  .where('estado', 'cancelado')
  .where('turno_numero', '<', 0)
  .whereNotIn('id', slotsClamados)
  .whereRaw(
    'ABS(turno_numero) NOT IN (SELECT turno_numero FROM turnos_rtms WHERE sede_id = ? AND fecha = ? AND turno_numero > 0)',
    [usuarioCreador.sedeId!, hoyISO]
  )
  .orderByRaw('ABS(turno_numero) ASC')
  .limit(1)
  .forUpdate()
  .first()

const huecoServicio = await trx
  .from('turnos_rtms')
  .select(Database.raw('ABS(turno_numero_servicio) AS slot_svc_libre'))
  .where('sede_id', usuarioCreador.sedeId!)
  .where('fecha', hoyISO)
  .where('servicio_id', servicio.id)
  .where('estado', 'cancelado')
  .where('turno_numero_servicio', '<', 0)
  .whereRaw(
    'ABS(turno_numero_servicio) NOT IN (SELECT turno_numero_servicio FROM turnos_rtms WHERE sede_id = ? AND fecha = ? AND servicio_id = ? AND turno_numero_servicio > 0)',
    [usuarioCreador.sedeId!, hoyISO, servicio.id]
  )
  .orderByRaw('ABS(turno_numero_servicio) ASC')
  .limit(1)
  .forUpdate()
  .first()

let nextGlobal: number
let reasignadoDeTurnoId: number | null = null

if (huecoGlobal?.slot_libre != null) {
  nextGlobal = Number(huecoGlobal.slot_libre)
  reasignadoDeTurnoId = Number(huecoGlobal.id)
} else {
  const rowGlobal = await trx
    .from('turnos_rtms')
    .where('sede_id', usuarioCreador.sedeId!)
    .where('fecha', hoyISO)
    .where('turno_numero', '>', 0)
    .whereIn('estado', ['activo', 'finalizado'])
    .max('turno_numero as max')
    .forUpdate()
    .first()
  nextGlobal = Number(rowGlobal?.max ?? 0) + 1
}

let nextPorServicio: number

if (huecoServicio?.slot_svc_libre != null) {
  nextPorServicio = Number(huecoServicio.slot_svc_libre)
} else {
  const rowSvc = await trx
    .from('turnos_rtms')
    .where('sede_id', usuarioCreador.sedeId!)
    .where('servicio_id', servicio.id)
    .where('fecha', hoyISO)
    .where('turno_numero_servicio', '>', 0)
    .whereIn('estado', ['activo', 'finalizado'])
    .max('turno_numero_servicio as max')
    .forUpdate()
    .first()
  nextPorServicio = Number(rowSvc?.max ?? 0) + 1
}
```
**Nota que ya está en el código y confirmo yo también**: el hueco **por servicio** NUNCA registra a qué turno se le asignó (`reasignadoDeTurnoId` solo se llena desde `huecoGlobal.id`, línea 698 — no existe un campo equivalente `reasignadoDeTurnoServicioId`). Su única protección de concurrencia es el `forUpdate()` (bloquea la fila del cancelado mientras dura la transacción) + la exclusión "ya ocupado por un positivo". Esto significa: dos requests concurrentes de creación de turno para la MISMA sede+servicio+día podrían, en teoría, calcular el mismo `nextPorServicio` si el `forUpdate()` no alcanza a serializarlas correctamente contra el mismo hueco (el lock protege la fila leída, pero nada impide que la segunda transacción, tras esperar el commit de la primera, vuelva a encontrar el MISMO hueco porque nada lo marcó como usado). El único mecanismo de seguridad final sería el índice único `uq_turno_numero_servicio_activo_por_dia_sede` en el INSERT, que devolvería `ER_DUP_ENTRY` → 409 `DUPLICATE_DAY` (mensaje potencialmente confuso para ese caso, porque no es un duplicado real de placa sino una colisión de número). **No confirmado en runtime ni en datos — es una lectura estructural del código**, análoga en espíritu a la condición de carrera de `turno_codigo` que sí está documentada y confirmada en el MAPA.

### Bloque real de `siguienteTurno()` (líneas 1697-1769), completo:
```ts
turnos_rtms_controller.ts:1697-1769
const slotsClamadosSig = Database.from('turnos_rtms')
  .select('reasignado_de_turno_id')
  .where('sede_id', usuarioSolicitante.sedeId)
  .where('fecha', hoy)
  .whereNotNull('reasignado_de_turno_id')

const huecoGlobalSig = await Database.from('turnos_rtms')
  .select(Database.raw('ABS(turno_numero) AS slot_libre'))
  .where('sede_id', usuarioSolicitante.sedeId)
  .where('fecha', hoy)
  .where('estado', 'cancelado')
  .where('turno_numero', '<', 0)
  .whereNotIn('id', slotsClamadosSig)
  .orderByRaw('ABS(turno_numero) ASC')
  .limit(1)
  .first()

let siguiente: number
if (huecoGlobalSig?.slot_libre != null) {
  siguiente = Number(huecoGlobalSig.slot_libre)
} else {
  const rowGlobal = await Database.from('turnos_rtms')
    .where('fecha', hoy)
    .andWhere('sede_id', usuarioSolicitante.sedeId)
    .where('turno_numero', '>', 0)
    .whereIn('estado', ['activo', 'finalizado'])
    .max('turno_numero as max')
    .first()
  siguiente = Number(rowGlobal?.max ?? 0) + 1
}

let siguientePorServicio: number | null = null
if (servicioId || servicioCodigo) {
  // ...resuelve sid...
  const huecoSvcSig = await Database.from('turnos_rtms')
    .select(Database.raw('ABS(turno_numero_servicio) AS slot_svc_libre'))
    .where('sede_id', usuarioSolicitante.sedeId)
    .where('fecha', hoy)
    .where('servicio_id', sid!)
    .where('estado', 'cancelado')
    .where('turno_numero_servicio', '<', 0)
    .orderByRaw('ABS(turno_numero_servicio) ASC')
    .limit(1)
    .first()

  if (huecoSvcSig?.slot_svc_libre != null) {
    siguientePorServicio = Number(huecoSvcSig.slot_svc_libre)
  } else {
    const rowSvc = await Database.from('turnos_rtms')
      .where('fecha', hoy)
      .andWhere('sede_id', usuarioSolicitante.sedeId)
      .andWhere('servicio_id', sid!)
      .where('turno_numero_servicio', '>', 0)
      .whereIn('estado', ['activo', 'finalizado'])
      .max('turno_numero_servicio as max')
      .first()
    siguientePorServicio = Number(rowSvc?.max ?? 0) + 1
  }
}
```

### Comparación directa, punto por punto — respuesta cierta a "¿coincide exactamente?"

| | `store()` (real) | `siguienteTurno()` (preview) | ¿Coincide? |
|---|---|---|---|
| Hueco global — excluye reclamados (`reasignado_de_turno_id`) | Sí (`whereNotIn('id', slotsClamados)`) | Sí (`whereNotIn('id', slotsClamadosSig)`) | **Sí** |
| Hueco global — excluye slots ya ocupados por un positivo | Sí (`whereRaw ABS(...) NOT IN (...)`) | **No existe esa cláusula** | **No coincide** |
| Hueco global — lock de fila (`forUpdate`) | Sí | No (no aplica, es solo lectura) | Esperado, no es un defecto |
| Hueco por servicio — excluye reclamados | **No existe** (ni en store() ni en siguienteTurno()) | No existe | Coinciden en carecer de ella |
| Hueco por servicio — excluye slots ya ocupados por un positivo | Sí | **No existe esa cláusula** | **No coincide** |
| Hueco por servicio — lock de fila | Sí | No | Esperado |

**Respuesta directa y certera: NO, `/siguiente-turno` no replica exactamente la lógica de `store()`.** Faltan, en la previsualización, las dos cláusulas `whereRaw ABS(...) NOT IN (...)` (tanto la global como la de servicio) que sí tiene `store()`. En el caso general (sin huecos legado, sin condición de carrera) el número mostrado coincidirá porque ambas fórmulas de fallback (`MAX(...)+1`) son idénticas. La divergencia solo se manifiesta cuando existe un hueco candidato que además está "ya ocupado" por un turno positivo (turnos legado sin `reasignado_de_turno_id`, según el propio comentario del código en `store()` línea 665-666) — en ese caso específico, `/siguiente-turno` mostraría ese número como disponible mientras que `store()` lo saltaría y usaría otro.

## B.4 Vinculación turno↔dateo en el momento de creación — cuándo se escribe `captacion_dateo_id`

Reconfirmo el flujo completo (ya documentado en el archivo anterior, lo repito aquí con los bloques completos por la regla de rigor):

```
turnos_rtms_controller.ts:805-1022
1. ¿Llegó dateoId explícito y es numérico?
   ├─ sí → busca ese dateo, valida dateoAplicaAServicio(dateo, servicio.id)
   │        (dateoAplicaAServicio: reserva_dateo_service.ts:132-139 —
   │         compara SOLO dateo.servicioId === servicioId, NO compara placa)
   │        ├─ aplica → candidato = ese dateo
   │        └─ no aplica / no numérico → candidato = null, cae al fallback
   └─ no → candidato = null, cae al fallback

2. Si candidato sigue null: fallback por (placa O teléfono) + servicio_id igual,
   el más reciente por created_at (líneas 829-838)

3. Si hay candidato: buildReserva(candidato) → ¿vigente?
   ├─ sí → vincularDateoVigente(candidato) [ver A.5] — FIN
   └─ no → descarta candidato; Capa 1 (retry): repite el fallback del paso 2
            EXCLUYENDO ese id (líneas 912-920)
            ├─ encuentra otro vigente → vincularDateoVigente() — FIN
            └─ no encuentra → sigue sin dateo por ahora

4. Clasificación de recurrencia/continuidad (no afecta el vínculo de dateo)

5. Capa 2 (red de seguridad, líneas 1003-1022): SI a esta altura
   captacionDateoId sigue null, un ÚLTIMO intento: fallback por
   placa+servicio_id (sin filtrar por teléfono esta vez), vigente
   ├─ encuentra vigente → vincularDateoVigente() — FIN
   └─ no encuentra → el turno se crea con captacionDateoId = null
```

**Confirmado: `captacion_dateo_id` se escribe si y solo si, al final de las 3 oportunidades (explícito válido, fallback normal, retry, red de seguridad), queda un dateo cuyo `servicioId` coincide con el del turno Y cuya ventana de exclusividad (`buildReserva`) sigue vigente en el momento exacto de la creación.** Si ninguna de las 3 encuentra algo, el turno se crea sin dateo — **y esto NUNCA bloquea la creación** (a diferencia de lo que tu pregunta original parecía asumir con `REQUIERE_TICKET_DATEO` — ver B.1).

**Aclaración sobre `dateoAplicaAServicio()` y placa**: la función (`reserva_dateo_service.ts:132-139`) es:
```ts
export function dateoAplicaAServicio(
  dateo: { servicioId?: number | null } | null | undefined,
  servicioId: number | null | undefined
): boolean {
  if (!dateo) return false
  if (!servicioId) return false
  return dateo.servicioId === servicioId
}
```
Solo compara servicio. **No compara placa.** La protección contra vincular el dateo de una placa distinta la da el propio fallback (que sí filtra por placa/teléfono al buscar candidatos) — pero si un `dateoId` explícito llega desde el frontend (ver el riesgo de A.4: placa cambiada en el formulario sin que corra una nueva búsqueda antes del submit) apuntando a un dateo de OTRA placa pero MISMO servicio, `dateoAplicaAServicio()` por sí sola no lo detecta.

## B — Tabla de endpoints/archivos

| Paso | Endpoint | Controlador::método | Archivo:línea clave |
|---|---|---|---|
| Autocompletar | `GET /buscar` | `busquedas_controller.ts::unificada` | 145-453 |
| Previsualizar número | `GET /turnos-rtm/siguiente-turno` | `turnos_rtms_controller.ts::siguienteTurno` | 1677-1780 |
| Crear turno | `POST /turnos-rtm` | `turnos_rtms_controller.ts::store` | 415-1197 |
| Helper vigencia dateo | — | `reserva_dateo_service.ts::buildReserva` | 97-114 |
| Helper match servicio | — | `reserva_dateo_service.ts::dateoAplicaAServicio` | 132-139 |

## B — No pude verificar con certeza / requiere confirmación con datos reales

- **La condición de carrera del hueco por servicio (B.3)** es una deducción de lectura de código sobre el orden de locks/exclusiones — no reproducida en runtime ni encontrada en datos de `-pruebas`. Para confirmarla haría falta forzar dos inserciones concurrentes reales contra la misma sede+servicio+día con un hueco disponible, algo que no intenté por ser una prueba destructiva/de carga fuera del alcance de una consulta de solo lectura.
- **El riesgo de `_dateoId` obsoleto por cambiar la placa sin volver a buscar (A.4/B.4 — re-investigado y corregido, ya no se atribuye al botón "Limpiar")** tampoco lo confirmé con datos — necesitaría cruzar `turnos_rtms.captacion_dateo_id` contra `captacion_dateos.placa` buscando placas distintas entre turno y dateo vinculado, en una base con datos reales de operación (no sintéticos). Si quieres, puedo correr esa consulta contra `-pruebas`, advirtiendo de antemano que ese entorno tiene muy pocos turnos con dateo vinculado fuera de RTM (ya lo vimos: 0 para PREV/PERI) y que aunque aparezca "limpio" ahí no descarta el problema en producción.
- No verifiqué si existe alguna otra vía (aparte de `CrearTurno.vue`) que llame a `POST /turnos-rtm` con un `dateoId` arbitrario — por ejemplo, algún script de importación o integración externa — que pudiera estar más expuesta a este riesgo que el flujo manual de UI.

---

# C) Turnos del Día — cómo se muestra, filtra y calcula

## C.1 Qué trae el listado y de dónde

**Una sola llamada a datos por carga de pantalla**: `TurnosDelDia.vue::loadTurnosHoy()`, línea 1438-1453:
```ts
TurnosDelDia.vue:1438-1453
const loadTurnosHoy = async () => {
  isLoading.value = true
  try {
    const fechaISO = fechaSeleccionada.value

    const filters = { fecha: fechaISO }
    const data = (await TurnosDelDiaService.fetchTurnos(filters)) as unknown as Turno[]

    turnos.value = data.filter((turno) => {
      const turnoFechaNormalizada = turno.fecha
        ? new Date(turno.fecha).toISOString().slice(0, 10)
        : ''
      const esFechaSeleccionada = turnoFechaNormalizada === fechaISO
      const notInactivo = turno.estado !== 'inactivo'
      return esFechaSeleccionada && notInactivo
    })
    ...
```
Pega a `GET /api/turnos-rtm?fecha=<fechaSeleccionada>` (`turnos_rtms_controller.ts::index()`) — **el único filtro que viaja al servidor es la fecha.** Todo lo demás (servicio, placa, estado visual) se filtra **en el cliente**, sobre el array ya descargado de ese día. Nótese además el doble filtrado defensivo: aunque el backend ya filtra por `fecha`, el frontend vuelve a comparar `turno.fecha === fechaISO` y excluye `estado === 'inactivo'` (el backend sí puede devolver turnos `inactivo` en `index()`, ya que su filtro de estado es opcional — este descarte es puramente del cliente).

**Filtros disponibles en pantalla** (client-side, sobre `turnos.value`):
- `servicioFiltro` (`'TODOS' | 'RTM' | 'SOAT' | 'PREV' | 'PERI'`, línea 1069-1075).
- `busquedaPlaca` (substring, case-insensitive).
- `fechaSeleccionada` (este SÍ dispara un nuevo `GET` al cambiar, es el único filtro real de servidor).
- `estadoFiltro` (semáforo, clicable desde la leyenda) + `subFiltroIncompleto` (`FALTA_FACTURACION`/`FALTA_CERTIFICACION`, solo visible cuando `estadoFiltro === 'incompleto'`).

## C.2 Etapas visuales — de qué campos exactos se derivan

Fuente de verdad única: **el backend** (`turno_etapas_service.ts`, adjuntado a cada turno como `etapasRequeridas`/`etapasCompletadas`/`estadoVisual` por `computeCamposDerivados()` en `turnos_rtms_controller.ts::index()`/`show()`). El frontend NO recalcula el semáforo — solo re-deriva la lista de etapas a mostrar (nombre, hora, funcionario) a partir de campos crudos del turno, usando `etapasRequeridas` (un número) solo para decidir si mostrar la tarjeta de Certificación:

```ts
TurnosDelDia.vue:1479-1520
const getEtapas = (turno: Turno): Etapa[] => {
  const esSOAT = (turno.etapasRequeridas ?? 3) < 3

  const etapas: Etapa[] = [
    {
      key: `puerta-${turno.id}`,
      name: 'Puerta',
      completed: !!turno.horaIngreso,
      time: turno.horaIngreso,
      funcionario: turno.usuario
        ? `${turno.usuario.nombres} ${turno.usuario.apellidos}`
        : null
    },
    {
      key: `facturacion-${turno.id}`,
      name: 'Facturación',
      completed: !!turno.tieneFacturacion,
      time: turno.horaFacturacion ?? null,
      funcionario: turno.facturacionFuncionario
        ? `${turno.facturacionFuncionario.nombres} ${turno.facturacionFuncionario.apellidos}`
        : null
    },
  ]

  if (!esSOAT) {
    etapas.push({
      key: `certificacion-${turno.id}`,
      name: 'Certificación',
      completed: !!turno.horaSalida,
      time: turno.horaSalida,
      funcionario: turno.certificacionFuncionario
        ? `${turno.certificacionFuncionario.nombres} ${turno.certificacionFuncionario.apellidos}`
        : null
    })
  }

  return etapas
}
```
**Campos crudos exactos**: Puerta = `turnos_rtms.hora_ingreso IS NOT NULL`; Facturación = `turnos_rtms.tiene_facturacion` (poblado por `facturacion_tickets_controller.ts::confirmar()`); Certificación = `turnos_rtms.hora_salida IS NOT NULL` (poblado por `certificaciones_controller.ts::store()`, por `registrarSalida()`, o — hallazgo de la sesión anterior — por el auto-cierre de `confirmar()` cuando el servicio es SOAT/PREV/PERI y el turno seguía `activo`). La variable local se llama `esSOAT` pero, igual que en `facturacion_tickets_controller.ts`, el nombre no es literal: viene de `etapasRequeridas < 3`, y **`etapasRequeridas` es 2 solo para SOAT** según `turno_etapas_service.ts:22-32` (`SERVICIOS_SIN_CERTIFICACION = ['SOAT']`, únicamente ese código) — aquí sí verifiqué que el nombre coincide con el comportamiento real: la variable `esSOAT` de `TurnosDelDia.vue` es equivalente a "es literalmente SOAT", NO al `isSOAT()` de `facturacion_tickets_controller.ts` que también atrapa PREV/PERI. **Son dos funciones de clasificación con el mismo nombre de variable/función (`esSOAT`/`isSOAT`) y comportamiento distinto en dos archivos distintos** — justo el tipo de trampa que ya nos mordió una vez; la dejo remarcada explícitamente para que no se repita al construir algo nuevo sobre esto.

## C.3 Contadores de la leyenda — condiciones completas, no paráfrasis

Base común para TODOS los contadores (leyenda superior, modal de estadísticas, y desglose por servicio/canal) — respeta servicio+placa, **no** el filtro de estado:
```ts
TurnosDelDia.vue:1101-1113
const turnosParaContadores = computed(() => {
  return turnos.value.filter((t) => {
    const pasaServicio =
      servicioFiltro.value === 'TODOS' ||
      getServicioCodigo(t).toUpperCase() === servicioFiltro.value.toUpperCase()

    const pasaPlaca =
      !busquedaPlaca.value ||
      t.placa.toUpperCase().includes(busquedaPlaca.value.toUpperCase())

    return pasaServicio && pasaPlaca
  })
})
```
Contador de la leyenda (los 4 números clicables):
```ts
TurnosDelDia.vue:1138-1151
const resumenSemaforo = computed(() => {
  const res = {
    en_proceso: 0,
    incompleto: 0,
    finalizado: 0,
    cancelado: 0,
  }

  turnosParaContadores.value.forEach((t) => {
    res[getEstadoVisual(t)]++
  })

  return res
})
```
donde `getEstadoVisual` (línea 1398) es:
```ts
const getEstadoVisual = (turno: Turno): EstadoVisual => turno.estadoVisual ?? 'en_proceso'
```
**Es decir, el frontend no reimplementa ninguna condición propia de clasificación — usa tal cual el `estadoVisual` que ya calculó el backend** (`turno_etapas_service.ts::computeEtapasTurno()`, reglas exactas ya documentadas en `DOCUMENTACION_MODULO_TURNOS.md`: `cancelado` si `estado==='cancelado'`; `en_proceso` si ≤1 etapa completa; `incompleto` si ≥2 pero no todas; `finalizado` si todas). El único fallback local es `?? 'en_proceso'`, por si el backend no mandara el campo.

**Filtro al hacer clic en un contador** (`turnosFiltrados`, línea 1116-1128):
```ts
TurnosDelDia.vue:1116-1128
const turnosFiltrados = computed(() => {
  return turnosParaContadores.value.filter((t) => {
    const pasaEstado = estadoFiltro.value === 'TODOS' || getEstadoVisual(t) === estadoFiltro.value

    const pasaSubfiltro =
      estadoFiltro.value !== 'incompleto' ||
      subFiltroIncompleto.value === 'TODOS' ||
      (subFiltroIncompleto.value === 'FALTA_FACTURACION' && !t.tieneFacturacion && !!t.horaSalida) ||
      (subFiltroIncompleto.value === 'FALTA_CERTIFICACION' && !!t.tieneFacturacion && !t.horaSalida)

    return pasaEstado && pasaSubfiltro
  })
})
```
El sub-filtro "Falta facturación" exige explícitamente `!tieneFacturacion && horaSalida` (certificado pero no facturado — un caso borde real: certificar antes de facturar, posible porque, como ya está documentado, no hay orden forzado entre las dos etapas), y "Falta certificación" exige lo simétrico.

**Modal de estadísticas — confirmado que SIGUE respetando los filtros activos** (el fix documentado en el MAPA sigue vigente en el código actual, verificado línea por línea):
```ts
TurnosDelDia.vue:1215-1232 (conteoPorEstado)
const conteoPorEstado = computed(() => {
  const res = { enProceso: 0, incompletos: 0, finalizados: 0, cancelados: 0 }
  turnosParaContadores.value.forEach((t) => {
    const ev = getEstadoVisual(t)
    if (ev === 'en_proceso') res.enProceso++
    else if (ev === 'incompleto') res.incompletos++
    else if (ev === 'finalizado') res.finalizados++
    else if (ev === 'cancelado') res.cancelados++
  })
  return res
})
```
```ts
TurnosDelDia.vue:1241-1265 (servicioStats — desglose por servicio/tipo vehículo)
const servicioStats = computed(() => {
  const base: Record<string, { total: number; porTipo: Record<TipoVehiculoStatsKey, number> }> = {}
  turnosParaContadores.value.forEach((t) => {
    const servicio = getServicioCodigo(t) || 'SIN_SERVICIO'
    ...
    base[servicio].total++
    base[servicio].porTipo[tipoKey]++
  })
  return base
})
```
```ts
TurnosDelDia.vue:1563-1583 (calculateStats — tipo de vehículo + "canal de captación", en realidad medioEntero)
const calculateStats = () => {
  initTipoVehiculoStats()
  statsData.value.medioEntero = { 'Redes Sociales': 0, 'Call Center': 0, Fachada: 0, Asesor: 0, Otros: 0 }

  turnosParaContadores.value.forEach((turno) => {
    const tipoKey: TipoVehiculoStatsKey = ...
    statsData.value.tipoVehiculo[tipoKey]++
    const canal = mapMedioToCanalCaptacion(turno.medioEntero)
    statsData.value.medioEntero[canal]++
  })
}
```
**Las tres fuentes del modal (`conteoPorEstado`, `servicioStats`, `calculateStats`) iteran sobre `turnosParaContadores`, no sobre `turnos` crudo ni sobre `turnosFiltrados`.** Confirmado: el fix de agosto 2026 documentado en el MAPA sigue intacto en el código actual — si el operador tiene un filtro de servicio o placa activo en la grilla principal, el modal respeta ese recorte (correcto, es la intención), pero **ignora el filtro de estado/sub-filtro** (también correcto e intencional, es justamente para que los 4 números no colapsen).

## C.4 Descarga de Excel del día — y una discrepancia real con `MAPA_DEL_SISTEMA_FRONTEND.md`

```ts
TurnosDelDia.vue:1604-1636
const downloadExcelDia = async () => {
  isDownloadingExcel.value = true
  try {
    const today = new Date()
    ...
    const todayISO = `${year}-${month}-${day}`

    // 👇 Usa TurnosDelDiaService (fetch con Bearer token), NO window.open():
    // la API exige Authorization header y esta app no usa cookies de sesión,
    // así que abrir la URL directo en una pestaña nueva siempre devolvía 401.
    const { data, filename } = await TurnosDelDiaService.exportTurnosExcel({
      fechaInicio: todayISO,
      fechaFin: todayISO,
    })
    triggerBlobDownload(data, filename)
    showSnackbar('Excel del día descargado.', 'success')
  } catch (error) {
    ...
  } finally {
    isDownloadingExcel.value = false
  }
}
```
donde `triggerBlobDownload` (línea 1592-1602) es el patrón estándar de blob→`<a download>`→`revokeObjectURL`. Pide siempre el **día calendario actual** (calculado con `Intl.DateTimeFormat` en zona `America/Bogota`, no necesariamente el mismo que `fechaSeleccionada` si el operador está viendo otro día — el botón de descarga no respeta el selector de fecha de la pantalla, solo descarga "hoy").

**Discrepancia real con `MAPA_DEL_SISTEMA_FRONTEND.md` — la señalo explícitamente, no la reconcilio**: la sección 10.2 de ese documento dice: *"Evitar `window.open(url, '_blank')` directo a un endpoint API (usado solo en `TurnosDelDia.downloadExcelDia()`) — no funciona si el endpoint requiere Bearer token..."* — dando a entender que `downloadExcelDia()` **hoy usa** `window.open()`. **El código actual que acabo de leer NO usa `window.open()` en ningún punto de esta función** — usa `TurnosDelDiaService.exportTurnosExcel()` (que internamente pasa por `download()` de `http.ts`, con Bearer) y el patrón de blob. El propio comentario en el código (líneas 1621-1623) explica que se cambió exactamente por el motivo que el MAPA describe como problema (401 por falta de header). **Conclusión: el MAPA_DEL_SISTEMA_FRONTEND.md está desactualizado en este punto — el problema que describe ya fue corregido en el código, pero el documento no se actualizó.** No verifiqué la fecha de la última edición de esa sección del MAPA para saber cuándo se desincronizó.

## C — Tabla de endpoints/archivos

| Pieza | Archivo:línea | Endpoint |
|---|---|---|
| Carga principal | `TurnosDelDia.vue:1438-1453` | `GET /turnos-rtm?fecha=` |
| Semáforo/etapas (backend) | `turno_etapas_service.ts:19-79` | (calculado dentro de `index()`/`show()`) |
| Etapas (frontend) | `TurnosDelDia.vue:1479-1520` | — |
| Contadores leyenda | `TurnosDelDia.vue:1101-1151` | — |
| Modal estadísticas | `TurnosDelDia.vue:1215-1265, 1563-1583` | — |
| Excel del día | `TurnosDelDia.vue:1604-1636` → `turnosdeldiaService.ts:380-401` | `GET /turnos-rtm/export-excel` |

## C — No pude verificar con certeza / requiere confirmación con datos reales

- No corrí ninguna consulta a `-pruebas` para esta sección porque todo lo pedido (condiciones de clasificación, respeto de filtros en el modal, mecanismo de descarga) es lógica 100% de código/frontend, verificable por lectura — no depende de qué datos existan. No hay nada aquí que un dato real pudiera confirmar o refutar que el código ya no muestre con certeza.
- No verifiqué si `fechaSeleccionada` tiene algún control de UI para cambiar de día en esta pantalla (el código solo muestra que existe la variable y que dispara `loadTurnosHoy()` — no leí el template completo buscando el selector de fecha, así que no puedo confirmar si el operador puede navegar a días anteriores desde aquí o si `TurnosDelDia.vue` está pensado exclusivamente para "hoy").
