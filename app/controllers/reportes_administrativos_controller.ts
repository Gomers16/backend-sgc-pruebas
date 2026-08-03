// app/controllers/reportes_administrativos_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Database from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import ExcelJS from 'exceljs'
import PdfkitTable from 'pdfkit-table'

const PDFDocument = PdfkitTable as any

import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import ConfiguracionMetaMensual from '#models/configuracion_meta_mensual'
import Liquidacion from '#models/liquidacion'
import Comision from '#models/comision'

/**
 * `facturacion_tickets` no tiene columna `fecha`; el filtro de rango se
 * aplica sobre DATE(created_at), que es el campo siempre poblado.
 */
function parseRangoFechas(request: HttpContext['request']): {
  fechaInicio: string
  fechaFin: string
  error?: string
} {
  const fechaInicio = request.input('fecha_inicio') as string | undefined
  const fechaFin = request.input('fecha_fin') as string | undefined

  if (!fechaInicio || !fechaFin) {
    return {
      fechaInicio: '',
      fechaFin: '',
      error: 'fecha_inicio y fecha_fin son requeridos (formato YYYY-MM-DD)',
    }
  }

  const di = DateTime.fromISO(fechaInicio)
  const df = DateTime.fromISO(fechaFin)
  if (!di.isValid || !df.isValid) {
    return { fechaInicio: '', fechaFin: '', error: 'fecha_inicio o fecha_fin inválida' }
  }
  if (di > df) {
    return { fechaInicio: '', fechaFin: '', error: 'fecha_inicio no puede ser mayor que fecha_fin' }
  }

  return { fechaInicio, fechaFin }
}

/** Convierte un GROUP_CONCAT(...) de MySQL ("1,2,3" | null | "") en number[]. */
function parseIdList(raw: unknown): number[] {
  if (!raw) return []
  return String(raw)
    .split(',')
    .filter((s) => s.length > 0)
    .map(Number)
}

/* ======================== META MENSUAL — HELPERS ======================== */

/**
 * Clasifica turnos_rtms.tipo_vehiculo en las 2 categorías del reporte
 * Meta Mensual. Catálogo actual: 'Liviano Particular' | 'Liviano Taxi' |
 * 'Liviano Público' → LIVIANO; 'Motocicleta' → MOTO. Cualquier otro valor
 * no cuenta hacia ninguna meta.
 *
 * Los fragmentos SQL usados en las consultas agregadas (SQL_CASE_LIVIANOS /
 * SQL_CASE_MOTOS) deben reflejar exactamente esta misma regla.
 */
function bucketTipoVehiculo(tipoVehiculo: string | null | undefined): 'LIVIANO' | 'MOTO' | null {
  if (!tipoVehiculo) return null
  const t = tipoVehiculo.trim().toUpperCase()
  if (t.startsWith('LIVIANO')) return 'LIVIANO'
  if (t === 'MOTOCICLETA') return 'MOTO'
  return null
}

/**
 * Misma clasificación que bucketTipoVehiculo() pero con las etiquetas
 * CARRO/MOTO que usa el reporte de Ingreso Real por Dateo (facturacion_tickets
 * es un snapshot de texto libre, no un enum).
 */
function tipoVehiculoCarroMoto(tipoVehiculo: string | null | undefined): 'CARRO' | 'MOTO' | null {
  if (!tipoVehiculo) return null
  const t = tipoVehiculo.trim().toUpperCase()
  if (t.startsWith('LIVIANO')) return 'CARRO'
  if (t === 'MOTOCICLETA') return 'MOTO'
  return null
}

/**
 * Dado un día cualquiera, retorna el inicio (sábado) y fin (viernes
 * siguiente) de su semana comercial sábado→viernes (NO es semana ISO).
 */
function semanaSabadoViernes(fecha: DateTime): { inicio: DateTime; fin: DateTime } {
  // Luxon: weekday 1=lunes...7=domingo. Offset en días desde el sábado
  // anterior (0 si `fecha` ya es sábado).
  const offsetDesdeSabado = (((fecha.weekday - 6) % 7) + 7) % 7
  const inicio = fecha.startOf('day').minus({ days: offsetDesdeSabado })
  const fin = inicio.plus({ days: 6 })
  return { inicio, fin }
}

interface ConteoDiarioMeta {
  fecha: string // YYYY-MM-DD
  livianos: number
  motos: number
  total: number
}

/**
 * Conteo diario (zero-filled, un registro por cada día del mes, sin huecos)
 * de turnos RTM finalizados para un mes/año, separado en livianos/motos.
 *
 * Regla de fuente — CORTE POR FECHA FIJO (ya no por disponibilidad de datos):
 *   1. Meses ANTERIORES a junio 2026 (2025 completo + 2026 ene-may) →
 *      SIEMPRE historico_meta_diario. Si ese mes no tiene filas cargadas
 *      (ej. mayo/2025), se retorna `dias: []` y `fuente: 'sin_datos'`.
 *   2. Meses junio 2026 en adelante → SIEMPRE turnos_rtms (excluyendo
 *      placas de prueba TST%), incluso si no tiene ningún
 *      registro ese mes — nunca cae a historico_meta_diario.
 */
const FUENTE_CORTE_MES = 6
const FUENTE_CORTE_ANIO = 2026
// Solo TST% corresponde a datos de prueba reales (seeders); FIX% y NEW%
// se eliminaron porque coincidían con placas reales de producción (ej.
// NEW11A), excluyendo turnos válidos del conteo de Meta Mensual.
const FILTRO_PLACAS_PRUEBA = "placa NOT LIKE 'TST%'"

function esFuenteReal(mes: number, anio: number): boolean {
  return anio > FUENTE_CORTE_ANIO || (anio === FUENTE_CORTE_ANIO && mes >= FUENTE_CORTE_MES)
}

/**
 * Corte de Meta Comercial por Asesor — mismo mes/año que el corte de Meta
 * Mensual RTM (FUENTE_CORTE_MES/ANIO arriba), aunque se mantiene como
 * constante independiente por si en el futuro necesitan desacoplarse de
 * nuevo.
 */
const META_COMERCIAL_CORTE_MES = 6
const META_COMERCIAL_CORTE_ANIO = 2026

/**
 * Tarifa PLANA usada solo para convertir cantidad histórica → pesos
 * ESTIMADOS en este reporte (comparación contra meta, no cálculo de nómina).
 * NO tiene relación con comisiones.es_config ni con el motor real de
 * comisiones — ese sigue funcionando exactamente igual.
 */
const VALOR_ESTIMADO_ASESOR_COMERCIAL = 17280
const VALOR_ESTIMADO_ASESOR_CONVENIO = 8640

function esFuenteRealComercial(mes: number, anio: number): boolean {
  return (
    anio > META_COMERCIAL_CORTE_ANIO ||
    (anio === META_COMERCIAL_CORTE_ANIO && mes >= META_COMERCIAL_CORTE_MES)
  )
}

async function obtenerConteoDiarioConFallback(
  mes: number,
  anio: number
): Promise<{ dias: ConteoDiarioMeta[]; fuente: 'real' | 'historico' | 'sin_datos' }> {
  let rowsRaw: any[] = []
  let fuente: 'real' | 'historico' | 'sin_datos' = 'sin_datos'

  if (esFuenteReal(mes, anio)) {
    fuente = 'real'
    // Join a servicios + filtro codigo_servicio='RTM': turnos_rtms mezcla RTM
    // con SOAT/PREV/PERI (mismo motivo que en computeProduccionPorLider /
    // computeReporteServicios — SOAT/PREV/PERI no generan ticket en este
    // entorno, pero sí generan fila en turnos_rtms, así que sin este filtro
    // la Meta Mensual cuenta de más).
    const rows = (await Database.from('turnos_rtms as t')
      .join('servicios as s', 's.id', 't.servicio_id')
      .where('t.estado', 'finalizado')
      .where('s.codigo_servicio', 'RTM')
      .whereRaw(FILTRO_PLACAS_PRUEBA)
      .whereRaw('MONTH(t.fecha) = ? AND YEAR(t.fecha) = ?', [mes, anio])
      .select(Database.raw("DATE_FORMAT(t.fecha, '%Y-%m-%d') as fecha"), 't.tipo_vehiculo')) as any[]

    const agregados = new Map<string, ConteoDiarioMeta>()
    for (const r of rows) {
      const bucket = bucketTipoVehiculo(r.tipo_vehiculo)
      if (!bucket) continue // valor de tipo_vehiculo fuera del catálogo esperado, no cuenta
      const entry = agregados.get(r.fecha) ?? {
        fecha: r.fecha,
        livianos: 0,
        motos: 0,
        total: 0,
      }
      if (bucket === 'LIVIANO') entry.livianos += 1
      else entry.motos += 1
      entry.total += 1
      agregados.set(r.fecha, entry)
    }
    rowsRaw = Array.from(agregados.values())
  } else {
    const rowsHistorico = (await Database.from('historico_meta_diario')
      .whereRaw('MONTH(fecha) = ? AND YEAR(fecha) = ?', [mes, anio])
      .select(
        Database.raw("DATE_FORMAT(fecha, '%Y-%m-%d') as fecha"),
        'livianos',
        'motos',
        'total'
      )) as any[]
    if (rowsHistorico.length > 0) {
      fuente = 'historico'
      rowsRaw = rowsHistorico
    }
  }

  if (fuente === 'sin_datos') {
    return { dias: [], fuente }
  }

  const mapa = new Map<string, ConteoDiarioMeta>()
  for (const r of rowsRaw) {
    mapa.set(r.fecha, {
      fecha: r.fecha,
      livianos: Number(r.livianos) || 0,
      motos: Number(r.motos) || 0,
      total: Number(r.total) || 0,
    })
  }

  const diasDelMes = DateTime.fromObject({ year: anio, month: mes }).daysInMonth as number
  const dias: ConteoDiarioMeta[] = []
  for (let d = 1; d <= diasDelMes; d++) {
    const fechaStr = DateTime.fromObject({ year: anio, month: mes, day: d }).toISODate() as string
    dias.push(mapa.get(fechaStr) ?? { fecha: fechaStr, livianos: 0, motos: 0, total: 0 })
  }

  return { dias, fuente }
}

/**
 * Semáforo genérico: >=100% verde, >=90% amarillo, resto rojo.
 * Umbral no especificado por el negocio — asunción documentada en el
 * resumen de implementación.
 *
 * `pct === null` significa "meta no configurada" (ver calcularPct) — se
 * retorna el estado neutro 'SIN_META' en vez de tratarlo como ROJO, para
 * no confundir "sin meta" con "va mal".
 */
function calcularSemaforo(pct: number | null): 'VERDE' | 'AMARILLO' | 'ROJO' | 'SIN_META' {
  if (pct === null) return 'SIN_META'
  if (pct >= 100) return 'VERDE'
  if (pct >= 90) return 'AMARILLO'
  return 'ROJO'
}

function calcularPct(avance: number, meta: number): number | null {
  return meta > 0 ? Math.round((avance / meta) * 1000) / 10 : null
}

/**
 * Obtiene la fila de configuración de un mes/año, creándola con metas en 0
 * si no existe. Usa INSERT ... ON DUPLICATE KEY UPDATE (atómico a nivel de
 * fila en MySQL) en vez de "SELECT, si no existe INSERT", porque el
 * frontend dispara resumen/diario/semanal/proyectado en paralelo para el
 * mismo mes/año — un "buscar y crear" ingenuo pierde la carrera: dos
 * peticiones concurrentes pueden ver ambas "no existe" y chocar contra el
 * índice único (mes, anio) con "Duplicate entry".
 */
async function obtenerOCrearConfigMensual(
  mes: number,
  anio: number
): Promise<ConfiguracionMetaMensual> {
  await Database.rawQuery(
    `INSERT INTO configuracion_meta_mensual
       (mes, anio, meta_livianos, meta_motos, pct_crecimiento_referencia, created_at, updated_at)
     VALUES (?, ?, 0, 0, 0, NOW(), NOW())
     ON DUPLICATE KEY UPDATE id = id`,
    [mes, anio]
  )

  const config = await ConfiguracionMetaMensual.query().where('mes', mes).where('anio', anio).first()
  if (!config) {
    throw new Error(`No se pudo obtener/crear configuracion_meta_mensual para ${mes}/${anio}`)
  }
  return config
}

interface MetaMensualVentanaResultado {
  mes: number
  anio: number
  fecha_inicio: string
  fecha_fin: string
  dias_del_rango: number
  dias_del_rango_transcurridos: number
  fuente_datos: 'real' | 'historico' | 'sin_datos'
  real: { livianos: number; motos: number; total: number }
  meta_mes: { livianos: number; motos: number; total: number }
  pct_real_sobre_meta_mes: number | null
  proyeccion: { livianos: number; motos: number; total: number }
  pct_proyeccion_sobre_meta_mes: number | null
}

/**
 * Cálculo compartido por metaMensualRango() (endpoint standalone, un solo
 * mes) y metaMensualSuperInforme() (para el tramo del mes en curso cuando
 * el rango del Súper Informe cruza meses). `fechaInicio`/`fechaFin` DEBEN
 * caer dentro de `mes`/`anio` — el caller es responsable de esa validación
 * (o de pasar ya el sub-rango recortado al mes correspondiente).
 *
 * Real generado en el rango, comparado contra la meta del mes completo, más
 * una proyección de cierre basada en el ritmo diario observado en ESE rango
 * (capando a hoy si `fechaFin` cae en el futuro, para no diluir el
 * promedio con días que aún no han ocurrido).
 */
async function calcularMetaMensualVentana(
  fechaInicio: string,
  fechaFin: string,
  mes: number,
  anio: number
): Promise<MetaMensualVentanaResultado> {
  const di = DateTime.fromISO(fechaInicio)

  const config = await obtenerOCrearConfigMensual(mes, anio)
  const metaLivianos = config.metaLivianos
  const metaMotos = config.metaMotos
  const metaTotal = metaLivianos + metaMotos

  const { dias, fuente } = await obtenerConteoDiarioConFallback(mes, anio)
  const diasRango = dias.filter((d) => d.fecha >= fechaInicio && d.fecha <= fechaFin)

  const realLivianos = diasRango.reduce((acc, d) => acc + d.livianos, 0)
  const realMotos = diasRango.reduce((acc, d) => acc + d.motos, 0)
  const realTotal = realLivianos + realMotos

  const hoyISO = DateTime.now().toISODate() as string
  const finParaPromedio = fechaFin > hoyISO ? hoyISO : fechaFin
  const diasParaPromedio =
    finParaPromedio < fechaInicio
      ? 0
      : Math.floor(DateTime.fromISO(finParaPromedio).diff(di, 'days').days) + 1

  const promedioDiarioLivianos = diasParaPromedio > 0 ? realLivianos / diasParaPromedio : 0
  const promedioDiarioMotos = diasParaPromedio > 0 ? realMotos / diasParaPromedio : 0

  const diasDelMes = DateTime.fromObject({ year: anio, month: mes }).daysInMonth as number
  const proyeccionLivianos = Math.round(promedioDiarioLivianos * diasDelMes)
  const proyeccionMotos = Math.round(promedioDiarioMotos * diasDelMes)
  const proyeccionTotal = proyeccionLivianos + proyeccionMotos

  return {
    mes,
    anio,
    fecha_inicio: fechaInicio,
    fecha_fin: fechaFin,
    dias_del_rango: diasRango.length,
    dias_del_rango_transcurridos: diasParaPromedio,
    fuente_datos: fuente,
    real: { livianos: realLivianos, motos: realMotos, total: realTotal },
    meta_mes: { livianos: metaLivianos, motos: metaMotos, total: metaTotal },
    pct_real_sobre_meta_mes: calcularPct(realTotal, metaTotal),
    proyeccion: { livianos: proyeccionLivianos, motos: proyeccionMotos, total: proyeccionTotal },
    pct_proyeccion_sobre_meta_mes: calcularPct(proyeccionTotal, metaTotal),
  }
}

/** Lista de {mes, anio} (orden cronológico) tocados por [fechaInicio, fechaFin]. */
function mesesEnRango(fechaInicio: string, fechaFin: string): { mes: number; anio: number }[] {
  const meses: { mes: number; anio: number }[] = []
  let cursor = DateTime.fromISO(fechaInicio).startOf('month')
  const finMes = DateTime.fromISO(fechaFin).startOf('month')
  while (cursor <= finMes) {
    meses.push({ mes: cursor.month, anio: cursor.year })
    cursor = cursor.plus({ months: 1 })
  }
  return meses
}

/**
 * Comparativo interanual del Súper Informe — real del mismo rango de
 * fechas pero un año atrás (mismo día/mes, `anio - 1` en cada mes tocado),
 * reutilizando obtenerConteoDiarioConFallback() con el mismo criterio de
 * ventana que ya usa el cálculo del año en curso. Independiente del `caso`
 * (un_mes_actual/cruce_con_mes_actual/solo_cerrados) — sirve para los 3.
 */
async function calcularRealAnioAnteriorPorRango(
  fechaInicio: string,
  fechaFin: string,
  meses: { mes: number; anio: number }[]
): Promise<{ livianos: number; motos: number; total: number }> {
  const fechaInicioAnt = DateTime.fromISO(fechaInicio).minus({ years: 1 }).toISODate() as string
  const fechaFinAnt = DateTime.fromISO(fechaFin).minus({ years: 1 }).toISODate() as string

  let livianos = 0
  let motos = 0
  for (const { mes, anio } of meses) {
    const anioAnt = anio - 1
    const inicioMes = DateTime.fromObject({ year: anioAnt, month: mes, day: 1 }).toISODate() as string
    const finMes = (
      DateTime.fromObject({ year: anioAnt, month: mes, day: 1 }).endOf('month').toISODate()
    ) as string
    const ventanaInicio = fechaInicioAnt > inicioMes ? fechaInicioAnt : inicioMes
    const ventanaFin = fechaFinAnt < finMes ? fechaFinAnt : finMes
    if (ventanaFin < ventanaInicio) continue

    const { dias } = await obtenerConteoDiarioConFallback(mes, anioAnt)
    const diasVentana = dias.filter((d) => d.fecha >= ventanaInicio && d.fecha <= ventanaFin)
    livianos += diasVentana.reduce((acc, d) => acc + d.livianos, 0)
    motos += diasVentana.reduce((acc, d) => acc + d.motos, 0)
  }
  return { livianos, motos, total: livianos + motos }
}

/** Variación absoluta y % de `actual` contra `anterior` (null si no hay base). */
function calcularVariacion(
  actual: number,
  anterior: number
): { variacion_abs: number; variacion_pct: number | null } {
  return {
    variacion_abs: actual - anterior,
    variacion_pct: anterior > 0 ? Math.round(((actual - anterior) / anterior) * 1000) / 10 : null,
  }
}

/**
 * Rango "inmediatamente anterior" a [fechaInicio, fechaFin]: mismo número de
 * días, terminando el día antes de fechaInicio. Usado para el comparativo
 * de Ingresos por Canal (no existía ningún comparativo temporal para este
 * reporte antes de este cambio).
 */
function calcularRangoAnterior(fechaInicio: string, fechaFin: string): { inicio: string; fin: string } {
  const dias = Math.floor(DateTime.fromISO(fechaFin).diff(DateTime.fromISO(fechaInicio), 'days').days) + 1
  const fin = DateTime.fromISO(fechaInicio).minus({ days: 1 })
  const inicio = fin.minus({ days: dias - 1 })
  return { inicio: inicio.toISODate() as string, fin: fin.toISODate() as string }
}

/**
 * Costo Base RTM Global (comisiones es_config=true, asesor_id IS NULL) —
 * mismo patrón/fila que ya usa metasMensuales() en comisiones_controller.ts
 * como fallback cuando un asesor no tiene override propio.
 */
async function obtenerCostoBaseRtmGlobal(): Promise<{ moto: number; vehiculo: number }> {
  const globalCfg = await Comision.query()
    .where('es_config', true)
    .whereNull('asesor_id')
    .where((wb) => wb.where('valor_rtm_moto', '>', 0).orWhere('valor_rtm_vehiculo', '>', 0))
    .first()
  return {
    moto: globalCfg?.valorRtmMoto ?? 0,
    vehiculo: globalCfg?.valorRtmVehiculo ?? 0,
  }
}

/* ======================== SÚPER INFORME — PDF ======================== */
// Mismo patrón visual que liquidacion_pagos_controller.ts / tramite_liquidaciones_controller.ts
// (pdfkit + pdfkit-table, color de marca #1a3c5e).

const SI_COLOR_MARCA = '#1a3c5e'
const SI_COLOR_GRIS = '#666666'
const SI_ANCHO_UTIL = 512 // 612pt (LETTER) - 2*50 de margen
const SI_MARGEN_X = 50

const formatPesoPdf = (valor: number | null | undefined): string =>
  `$ ${new Intl.NumberFormat('es-CO').format(Math.round(valor ?? 0))}`

const formatNumPdf = (valor: number | null | undefined): string =>
  valor === null || valor === undefined ? '—' : new Intl.NumberFormat('es-CO').format(valor)

const formatPctPdf = (valor: number | null | undefined): string =>
  valor === null || valor === undefined ? '—' : `${valor}%`

const formatFechaLargaPdf = (fechaIso: string): string =>
  DateTime.fromISO(fechaIso).setLocale('es').toFormat("d 'de' MMMM 'de' yyyy")

const MESES_LABEL_PDF = [
  'Enero', 'Febrero', 'Marzo', 'Abril', 'Mayo', 'Junio',
  'Julio', 'Agosto', 'Septiembre', 'Octubre', 'Noviembre', 'Diciembre',
]

/** Franja de color con el título de la sección (ej. "1. Meta Mensual"). */
function siDibujarTituloSeccion(doc: any, numero: number, titulo: string, subtitulo?: string) {
  if (doc.y > doc.page.height - 150) doc.addPage()
  const y = doc.y
  doc.rect(SI_MARGEN_X, y, SI_ANCHO_UTIL, 28).fill(SI_COLOR_MARCA)
  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(13)
    .text(`${numero}. ${titulo}`, SI_MARGEN_X + 12, y + 8)
  doc.fillColor('#000000')
  doc.y = y + 28 + 10
  if (subtitulo) {
    doc.font('Helvetica').fontSize(8).fillColor(SI_COLOR_GRIS).text(subtitulo, SI_MARGEN_X, doc.y, {
      width: SI_ANCHO_UTIL,
    })
    doc.fillColor('#000000')
    doc.moveDown(0.6)
  }
}

/** Fila de KPIs en texto (label chico arriba, valor grande en color de marca abajo), 3 por fila. */
function siDibujarKpis(doc: any, items: { label: string; value: string; color?: string }[]) {
  const porFila = 3
  const colWidth = SI_ANCHO_UTIL / porFila
  for (let i = 0; i < items.length; i += porFila) {
    const fila = items.slice(i, i + porFila)
    const y = doc.y
    fila.forEach((item, idx) => {
      const x = SI_MARGEN_X + idx * colWidth
      doc.font('Helvetica').fontSize(8).fillColor(SI_COLOR_GRIS).text(item.label, x, y, { width: colWidth - 10 })
      doc
        .font('Helvetica-Bold')
        .fontSize(12)
        .fillColor(item.color ?? SI_COLOR_MARCA)
        .text(item.value, x, y + 11, { width: colWidth - 10 })
    })
    doc.y = y + 36
  }
  doc.fillColor('#000000')
}

/** Color hex asociado a cada estado de calcularSemaforo(), para KPIs con semáforo visual. */
const SI_SEMAFORO_COLOR: Record<'VERDE' | 'AMARILLO' | 'ROJO' | 'SIN_META', string> = {
  VERDE: '#1e7e34',
  AMARILLO: '#b8860b',
  ROJO: '#c0392b',
  SIN_META: SI_COLOR_GRIS,
}
const SI_SEMAFORO_LABEL: Record<'VERDE' | 'AMARILLO' | 'ROJO' | 'SIN_META', string> = {
  VERDE: 'Verde',
  AMARILLO: 'Amarillo',
  ROJO: 'Rojo',
  SIN_META: 'Sin meta',
}

/** Título chico de sub-tabla dentro de una sección (ej. "Por Canal"). */
function siDibujarSubtitulo(doc: any, texto: string) {
  if (doc.y > doc.page.height - 100) doc.addPage()
  doc.font('Helvetica-Bold').fontSize(10).fillColor(SI_COLOR_MARCA).text(texto, SI_MARGEN_X, doc.y)
  doc.fillColor('#000000')
  doc.moveDown(0.3)
}

/** Dibuja una tabla con el estilo estándar (encabezado blanco sobre color de marca, totales en negrita). */
async function siDibujarTabla(
  doc: any,
  headers: { label: string; property: string; width: number; align?: 'left' | 'right' | 'center' }[],
  filas: Record<string, string | number>[],
  filaTotalIndex: number | null = null
) {
  // pdfkit-table solo lee headerColor/headerOpacity de CADA objeto de
  // columna (dh.headerColor dentro de document.js), no de la opción global
  // `headerColor` pasada a .table() — por eso el color de marca no se
  // aplicaba y addBackground() caía a su default ("grey", opacity 0.1),
  // el gris clarísimo casi ilegible que se veía. Se inyecta en cada columna.
  const headersConColor = headers.map((h) => ({
    ...h,
    headerColor: SI_COLOR_MARCA,
    headerOpacity: 1,
  }))
  await doc.table(
    { headers: headersConColor, datas: filas },
    {
      prepareHeader: () => doc.font('Helvetica-Bold').fontSize(8).fillColor('#ffffff'),
      prepareRow: (_row: any, _col: number, indexRow: number) => {
        const esTotal = filaTotalIndex !== null && indexRow === filaTotalIndex
        doc
          .font(esTotal ? 'Helvetica-Bold' : 'Helvetica')
          .fontSize(8)
          .fillColor('#000000')
      },
      columnSpacing: 4,
      padding: 5,
    }
  )
  doc.fillColor('#000000')
}

function siDibujarPortada(
  doc: any,
  opts: { fechaInicio: string; fechaFin: string; generadoPor: string; fechaGeneracion: string }
) {
  doc.rect(0, 0, doc.page.width, 200).fill(SI_COLOR_MARCA)

  doc
    .fillColor('#ffffff')
    .font('Helvetica-Bold')
    .fontSize(24)
    .text('Súper Informe', SI_MARGEN_X, 100, { align: 'center', width: doc.page.width - 100 })
  doc
    .font('Helvetica')
    .fontSize(13)
    .text('Reporte Consolidado', SI_MARGEN_X, 133, { align: 'center', width: doc.page.width - 100 })

  doc.fillColor('#000000')
  doc.y = 320

  doc
    .font('Helvetica-Bold')
    .fontSize(11)
    .fillColor(SI_COLOR_GRIS)
    .text('Rango del informe', SI_MARGEN_X, doc.y, { align: 'center', width: doc.page.width - 100 })
  doc.moveDown(0.4)
  doc
    .font('Helvetica-Bold')
    .fontSize(15)
    .fillColor(SI_COLOR_MARCA)
    .text(
      `${formatFechaLargaPdf(opts.fechaInicio)}  —  ${formatFechaLargaPdf(opts.fechaFin)}`,
      SI_MARGEN_X,
      doc.y,
      { align: 'center', width: doc.page.width - 100 }
    )

  doc.moveDown(2.5)
  doc
    .font('Helvetica')
    .fontSize(10)
    .fillColor(SI_COLOR_GRIS)
    .text(`Generado el ${opts.fechaGeneracion}`, SI_MARGEN_X, doc.y, {
      align: 'center',
      width: doc.page.width - 100,
    })
  doc.moveDown(0.3)
  doc.text(`Por: ${opts.generadoPor}`, SI_MARGEN_X, doc.y, {
    align: 'center',
    width: doc.page.width - 100,
  })

  doc.moveDown(3)
  doc
    .fontSize(9)
    .fillColor('#999999')
    .text(
      'Secciones: Meta Mensual · Meta Comercial por Asesor · Ingresos por Canal · Servicios (RTM) · ' +
        'Retención de Clientes · Descuentos · Producción por Líder',
      SI_MARGEN_X + 20,
      doc.y,
      { align: 'center', width: doc.page.width - 140 }
    )

  doc.fillColor('#000000')
}

const SI_CANAL_LABELS: Record<string, string> = {
  FACHADA: 'Fachada',
  ASESOR_COMERCIAL: 'Asesor Comercial',
  ASESOR_CONVENIO: 'Asesor Convenio',
  TELEMERCADEO: 'Telemercadeo',
  REDES: 'Redes / Marketing Digital',
}
const siNombreCanal = (canal: string) => SI_CANAL_LABELS[canal] ?? canal

const SI_CANALES_CANONICOS = ['FACHADA', 'ASESOR_COMERCIAL', 'ASESOR_CONVENIO', 'TELEMERCADEO', 'REDES']

/**
 * Completa una tabla "por canal" para que SIEMPRE aparezcan los 5 canales
 * canónicos, aunque no tengan datos en el rango (fila en ceros) — pedido
 * explícito para el Súper Informe. No afecta los reportes individuales en
 * pantalla (esos solo muestran los canales que sí tienen datos).
 */
function siCompletarCanales<T extends { canal: string }>(rows: T[], filaVacia: (canal: string) => T): T[] {
  const porCanal = new Map(rows.map((r) => [r.canal, r]))
  return SI_CANALES_CANONICOS.map((canal) => porCanal.get(canal) ?? filaVacia(canal))
}

/**
 * Construye el PDF completo del Súper Informe: portada + 7 secciones (una
 * por página), reutilizando los datos ya calculados/verificados por los
 * compute*() de cada reporte — este builder solo dibuja, no vuelve a
 * calcular nada.
 */
type SuperInformeDatos = {
  fechaInicio: string
  fechaFin: string
  generadoPor: string
  // Orden nuevo del Súper Informe: Meta Mensual, Meta Comercial, Ingresos
  // por Canal, Servicios, Retención, Descuentos, Producción por Líder.
  metaMensual: Awaited<ReturnType<ReportesAdministrativosController['computeMetaMensualSuperInforme']>>
  metaComercial: Awaited<ReturnType<ReportesAdministrativosController['computeMetaComercialSuperInforme']>>
  ingresosCanal: Awaited<ReturnType<ReportesAdministrativosController['computeIngresosPorCanal']>>
  ingresosCanalAnterior: Awaited<ReturnType<ReportesAdministrativosController['computeIngresosPorCanal']>>
  servicios: Awaited<ReturnType<ReportesAdministrativosController['computeReporteServicios']>>
  retencion: Awaited<ReturnType<ReportesAdministrativosController['computeRetencionClientes']>>
  descuentosTipo: Awaited<ReturnType<ReportesAdministrativosController['computeDescuentosPorTipo']>>
  descuentosCanal: Awaited<ReturnType<ReportesAdministrativosController['computeDescuentosPorCanal']>>
  descuentosAutorizador: Awaited<
    ReturnType<ReportesAdministrativosController['computeDescuentosPorAutorizador']>
  >
  produccionLider: Awaited<ReturnType<ReportesAdministrativosController['computeProduccionPorLider']>>
}

/**
 * Dibuja la portada + las 7 secciones (todo EXCEPTO el pie de página) sobre
 * un `doc` ya creado. Se usa dos veces desde construirSuperInformePdf():
 * una pasada "sonda" (para saber cuántas páginas físicas va a ocupar,
 * incluyendo el desborde automático de las tablas largas) y una pasada real
 * que sí incluye el pie de página en cada hoja — necesario porque
 * switchToPage()/bufferedPageRange() después de dibujar todo el contenido
 * no reposiciona el cursor de forma confiable con pdfkit-table y termina
 * agregando una página en blanco por cada pie de página añadido.
 */
async function dibujarContenidoSuperInforme(doc: any, datos: SuperInformeDatos, fechaGeneracion: string) {
  // ===== Portada =====
  siDibujarPortada(doc, {
    fechaInicio: datos.fechaInicio,
    fechaFin: datos.fechaFin,
    generadoPor: datos.generadoPor,
    fechaGeneracion,
  })

  const CASO_LABEL: Record<string, string> = {
    un_mes_actual: 'Rango dentro de un mismo mes en curso.',
    cruce_con_mes_actual: 'El rango cruza meses ya cerrados con el mes en curso — meta y real sumados de todos los meses tocados; la proyección aplica solo al tramo del mes en curso.',
    solo_cerrados: 'El rango cruza solo meses ya cerrados — se muestra real vs. meta combinada, sin proyección.',
  }

  // ===== 1. Meta Mensual =====
  doc.addPage()
  const mm = datos.metaMensual
  siDibujarTituloSeccion(
    doc,
    1,
    'Meta Mensual',
    'Avance de turnos RTM (livianos + motos) contra la meta configurada del mes, con proyección de cierre y comparativo contra el mismo rango del año anterior. Fuente: turnos_rtms (o histórico en meses cerrados) vs. configuracion_meta_mensual.'
  )
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(SI_COLOR_GRIS).text(CASO_LABEL[mm.caso], SI_MARGEN_X, doc.y, { width: SI_ANCHO_UTIL })
  doc.fillColor('#000000')
  doc.moveDown(0.4)
  siDibujarKpis(doc, [
    { label: 'Real del rango', value: formatNumPdf(mm.real_total.total) },
    { label: 'Meta del mes completo', value: formatNumPdf(mm.meta_total.total) },
    {
      label: '% de la meta del mes',
      value: `${formatPctPdf(mm.pct_real_sobre_meta)} (${SI_SEMAFORO_LABEL[mm.semaforo]})`,
      color: SI_SEMAFORO_COLOR[mm.semaforo],
    },
    {
      label: 'Livianos (real / meta)',
      value: `${formatNumPdf(mm.real_total.livianos)} / ${formatNumPdf(mm.meta_total.livianos)}`,
    },
    {
      label: 'Motos (real / meta)',
      value: `${formatNumPdf(mm.real_total.motos)} / ${formatNumPdf(mm.meta_total.motos)}`,
    },
    {
      label: 'Proyección de cierre del mes',
      value: mm.proyeccion_total ? formatNumPdf(mm.proyeccion_total.total) : 'No aplica',
    },
    { label: '% de la meta proyectado', value: formatPctPdf(mm.pct_proyeccion_sobre_meta) },
    { label: 'Mismo rango, año anterior', value: formatNumPdf(mm.real_anio_anterior.total) },
    {
      label: 'Variación interanual',
      value: `${mm.variacion_abs >= 0 ? '+' : ''}${formatNumPdf(mm.variacion_abs)} (${formatPctPdf(mm.variacion_pct)})`,
      color: mm.variacion_abs >= 0 ? '#1e7e34' : '#c0392b',
    },
  ])
  doc.moveDown(0.5)
  siDibujarSubtitulo(doc, 'Detalle por mes tocado')
  await siDibujarTabla(
    doc,
    [
      { label: 'Mes', property: 'mes', width: 110 },
      { label: 'Meta', property: 'meta', width: 130, align: 'right' },
      { label: 'Real', property: 'real', width: 130, align: 'right' },
      { label: '% Avance', property: 'pct', width: 90, align: 'right' },
    ],
    mm.detalle_por_mes.map((m) => ({
      mes: `${MESES_LABEL_PDF[m.mes - 1]} ${m.anio}${m.es_mes_actual ? ' (actual)' : ''}`,
      meta: formatNumPdf(m.meta.total),
      real: formatNumPdf(m.real.total),
      pct: formatPctPdf(calcularPct(m.real.total, m.meta.total)),
    }))
  )

  // ===== 2. Meta Comercial por Asesor =====
  doc.addPage()
  const mc = datos.metaComercial
  siDibujarTituloSeccion(
    doc,
    2,
    'Meta Comercial por Asesor',
    'Avance de meta comercial (en pesos) por asesor tipo Asesor Comercial, con proyección de cierre individual y desglose de comisión pagada vs. pendiente de pago. Fuente: comisiones (o histórico en meses cerrados) vs. meta_comercial_asesor.'
  )
  doc.font('Helvetica-Oblique').fontSize(8).fillColor(SI_COLOR_GRIS).text(CASO_LABEL[mc.caso], SI_MARGEN_X, doc.y, { width: SI_ANCHO_UTIL })
  doc.fillColor('#000000')
  doc.moveDown(0.3)
  if (mc.nota) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(7)
      .fillColor(SI_COLOR_GRIS)
      .text(mc.nota, SI_MARGEN_X, doc.y, { width: SI_ANCHO_UTIL })
    doc.fillColor('#000000')
    doc.moveDown(0.4)
  }
  siDibujarKpis(doc, [
    {
      label: 'Total General',
      value: `${formatPesoPdf(mc.kpis.pesos_total)} / ${mc.kpis.meta_pesos === null ? 'Sin meta' : formatPesoPdf(mc.kpis.meta_pesos)}`,
    },
    { label: 'Convenio', value: formatPesoPdf(mc.kpis.pesos_convenio) },
    { label: 'Propio (Comercial)', value: formatPesoPdf(mc.kpis.pesos_comercial) },
    {
      label: 'Proyección de cierre',
      value: mc.kpis.proyeccion_cierre === null ? '—' : formatPesoPdf(mc.kpis.proyeccion_cierre),
    },
  ])
  doc.moveDown(0.5)
  siDibujarSubtitulo(doc, 'Detalle por asesor')
  if (!mc.comision_estado_disponible) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(7)
      .fillColor(SI_COLOR_GRIS)
      .text(
        'El desglose Comisión Pagada / Pendiente no está disponible en meses históricos — se muestra "N/D" en esos casos.',
        SI_MARGEN_X,
        doc.y,
        { width: SI_ANCHO_UTIL }
      )
    doc.fillColor('#000000')
    doc.moveDown(0.3)
  }
  await siDibujarTabla(
    doc,
    [
      { label: 'Asesor', property: 'asesor', width: 78 },
      { label: 'Total', property: 'total', width: 55, align: 'right' },
      { label: 'Meta', property: 'meta', width: 55, align: 'right' },
      { label: '% Avance', property: 'pctAvance', width: 40, align: 'right' },
      { label: 'Cumplió', property: 'cumplio', width: 36, align: 'center' },
      { label: 'Faltante', property: 'faltante', width: 55, align: 'right' },
      { label: 'Proy. Cierre', property: 'proyeccion', width: 55, align: 'right' },
      { label: 'Com. Pagada', property: 'comisionPagada', width: 55, align: 'right' },
      { label: 'Com. Pendiente', property: 'comisionPendiente', width: 58, align: 'right' },
    ],
    mc.asesores.map((a) => ({
      asesor: a.asesor_nombre,
      total: formatPesoPdf(a.pesos_total),
      meta: a.meta_pesos === null ? 'Sin meta' : formatPesoPdf(a.meta_pesos),
      pctAvance: a.pct_avance === null ? '—' : formatPctPdf(a.pct_avance),
      cumplio: a.cumplio === null ? '—' : a.cumplio ? 'Sí' : 'No',
      faltante: a.faltante === null ? '—' : formatPesoPdf(a.faltante),
      proyeccion: formatPesoPdf(a.proyeccion_cierre),
      comisionPagada: mc.comision_estado_disponible ? formatPesoPdf(a.comision_pagada) : 'N/D',
      comisionPendiente: mc.comision_estado_disponible ? formatPesoPdf(a.comision_pendiente) : 'N/D',
    }))
  )
  doc
    .font('Helvetica-Oblique')
    .fontSize(7)
    .fillColor(SI_COLOR_GRIS)
    .text(
      'Desglose Convenio vs. Propio disponible en el reporte individual "Meta Comercial por Asesor". "Faltante" se limita a 0 cuando ya se cumplió la meta.',
      SI_MARGEN_X,
      doc.y,
      { width: SI_ANCHO_UTIL }
    )
  doc.fillColor('#000000')

  // ===== 2b. Meta Comercial por Asesor — Unidades (vehículos) =====
  doc.moveDown(0.8)
  siDibujarSubtitulo(doc, 'Unidades (vehículos)')
  await siDibujarTabla(
    doc,
    [
      { label: 'Asesor', property: 'asesor', width: 160 },
      { label: 'Meta (Veh)', property: 'meta', width: 88, align: 'right' },
      { label: 'Motos', property: 'motos', width: 88, align: 'right' },
      { label: 'Vehículos', property: 'vehiculos', width: 88, align: 'right' },
      { label: 'Faltante (Veh)', property: 'faltante', width: 88, align: 'right' },
    ],
    mc.asesores.map((a) => ({
      asesor: a.asesor_nombre,
      meta: a.meta_vehiculos === null ? 'Sin meta' : formatNumPdf(a.meta_vehiculos),
      motos: formatNumPdf(a.logrado_motos),
      vehiculos: formatNumPdf(a.logrado_vehiculos),
      faltante: a.faltante_vehiculos === null ? '—' : formatNumPdf(a.faltante_vehiculos),
    }))
  )
  doc
    .font('Helvetica-Oblique')
    .fontSize(7)
    .fillColor(SI_COLOR_GRIS)
    .text(
      'Motos/Vehículos = unidades facturadas atribuidas al asesor (facturacion_tickets), no filas de comisiones. En meses históricos sin detalle por tipo de vehículo cargado, ese mes no aporta a este desglose (sí sigue sumando en el total $ de arriba).',
      SI_MARGEN_X,
      doc.y,
      { width: SI_ANCHO_UTIL }
    )
  doc.fillColor('#000000')

  // ===== 2c. Meta Comercial por Asesor — Ingreso RTM Generado por Asesor =====
  doc.moveDown(0.8)
  siDibujarSubtitulo(doc, 'Ingreso RTM Generado por Asesor')
  await siDibujarTabla(
    doc,
    [
      { label: 'Asesor', property: 'asesor', width: 120 },
      { label: 'Motos', property: 'motos', width: 62, align: 'right' },
      { label: 'Vehículos', property: 'vehiculos', width: 62, align: 'right' },
      { label: 'Costo Base Moto', property: 'costoBaseMoto', width: 90, align: 'right' },
      { label: 'Costo Base Vehículo', property: 'costoBaseVehiculo', width: 90, align: 'right' },
      { label: 'Ingreso RTM Generado', property: 'ingreso', width: 88, align: 'right' },
    ],
    mc.asesores.map((a) => ({
      asesor: a.asesor_nombre,
      motos: formatNumPdf(a.logrado_motos),
      vehiculos: formatNumPdf(a.logrado_vehiculos),
      costoBaseMoto: a.costo_base_moto === null ? '—' : formatPesoPdf(a.costo_base_moto),
      costoBaseVehiculo: a.costo_base_vehiculo === null ? '—' : formatPesoPdf(a.costo_base_vehiculo),
      ingreso: formatPesoPdf(a.ingreso_rtm_generado),
    }))
  )
  doc
    .font('Helvetica-Oblique')
    .fontSize(7)
    .fillColor(SI_COLOR_GRIS)
    .text(
      'Ingreso RTM Generado = el ingreso real que el asesor trajo al negocio (unidades × Costo Base), NO su comisión — la comisión ganada sigue en la tabla de arriba, sin cambios. Costo Base: en meses reales, config individual del asesor (con fallback al valor Global si no tiene override propio); en meses históricos, la tarifa real de ese asesor/mes. En rangos que cruzan varios meses con tarifas distintas, las columnas Costo Base muestran el valor del mes más reciente tocado — el Ingreso sí se calcula mes a mes con la tarifa correspondiente.',
      SI_MARGEN_X,
      doc.y,
      { width: SI_ANCHO_UTIL }
    )
  doc.fillColor('#000000')

  // ===== 2d. Meta Comercial por Asesor — Descuentos dados (Comercial + Convenio) =====
  if (mc.descuentosPorAsesor.length > 0) {
    doc.moveDown(0.8)
    siDibujarSubtitulo(doc, 'Descuentos dados por asesor (Comercial y Convenio)')
    await siDibujarTabla(
      doc,
      [
        { label: 'Asesor', property: 'asesor', width: 200 },
        { label: 'Tipo', property: 'tipo', width: 172 },
        { label: 'Cantidad', property: 'cantidad', width: 70, align: 'right' },
        { label: 'Total', property: 'total', width: 70, align: 'right' },
      ],
      mc.descuentosPorAsesor.map((d) => ({
        asesor: d.asesor_nombre,
        tipo: d.nombre,
        cantidad: formatNumPdf(d.cantidad),
        total: formatPesoPdf(d.total_descuentos),
      }))
    )
  }

  // ===== 3. Ingresos por Canal =====
  doc.addPage()
  siDibujarTituloSeccion(
    doc,
    3,
    'Ingresos por Canal',
    'Vehículos facturados e ingresos por canal de captación (RTM, estado CONFIRMADA), comparado contra el período inmediatamente anterior de igual duración. Fuente: facturacion_tickets.'
  )
  const filasIngresosCanal = siCompletarCanales(datos.ingresosCanal.por_canal, (canal) => ({
    canal,
    cantidad: 0,
    total_bruto: 0,
    total_neto: 0,
    promedio_ticket: 0,
  }))
  const canalAnteriorMap = new Map(datos.ingresosCanalAnterior.por_canal.map((c) => [c.canal, c]))
  doc
    .font('Helvetica-Oblique')
    .fontSize(7)
    .fillColor(SI_COLOR_GRIS)
    .text(
      `Período anterior comparado: ${formatFechaLargaPdf(datos.ingresosCanalAnterior.fecha_inicio)} — ${formatFechaLargaPdf(datos.ingresosCanalAnterior.fecha_fin)}.`,
      SI_MARGEN_X,
      doc.y,
      { width: SI_ANCHO_UTIL }
    )
  doc.fillColor('#000000')
  doc.moveDown(0.4)
  await siDibujarTabla(
    doc,
    [
      { label: 'Canal', property: 'canal', width: 108 },
      { label: 'Vehículos', property: 'vehiculos', width: 50, align: 'right' },
      { label: 'Total Bruto', property: 'totalBruto', width: 76, align: 'right' },
      { label: 'Total Neto', property: 'totalNeto', width: 76, align: 'right' },
      { label: 'Prom. Ticket', property: 'promedio', width: 62, align: 'right' },
      { label: 'Var. vs. Anterior', property: 'variacion', width: 78, align: 'right' },
      { label: '% del Total', property: 'pctTotal', width: 62, align: 'right' },
    ],
    [
      ...filasIngresosCanal.map((c) => {
        const anterior = canalAnteriorMap.get(c.canal)
        const variacion = calcularVariacion(c.total_bruto, anterior?.total_bruto ?? 0)
        const pctTotal = datos.ingresosCanal.totales.total_bruto > 0
          ? Math.round((c.total_bruto / datos.ingresosCanal.totales.total_bruto) * 10000) / 100
          : 0
        return {
          canal: siNombreCanal(c.canal),
          vehiculos: formatNumPdf(c.cantidad),
          totalBruto: formatPesoPdf(c.total_bruto),
          totalNeto: formatPesoPdf(c.total_neto),
          promedio: formatPesoPdf(c.promedio_ticket),
          variacion: `${variacion.variacion_abs >= 0 ? '+' : ''}${formatPctPdf(variacion.variacion_pct)}`,
          pctTotal: formatPctPdf(pctTotal),
        }
      }),
      {
        canal: 'Totales',
        vehiculos: formatNumPdf(datos.ingresosCanal.totales.cantidad),
        totalBruto: formatPesoPdf(datos.ingresosCanal.totales.total_bruto),
        totalNeto: formatPesoPdf(datos.ingresosCanal.totales.total_neto),
        promedio: formatPesoPdf(datos.ingresosCanal.totales.promedio_ticket),
        variacion: formatPctPdf(
          calcularVariacion(
            datos.ingresosCanal.totales.total_bruto,
            datos.ingresosCanalAnterior.totales.total_bruto
          ).variacion_pct
        ),
        pctTotal: formatPctPdf(100),
      },
    ],
    filasIngresosCanal.length
  )

  // ===== 4. Servicios (RTM) =====
  doc.addPage()
  siDibujarTituloSeccion(
    doc,
    4,
    'Servicios (RTM)',
    'Turnos y facturación por servicio y tipo de vehículo: valor Estimado (turnos × tarifa configurada), Costo Base (referencia interna RTM) y valor Real cobrado (post-descuento, directo de la factura). Fuente: turnos_rtms + facturacion_tickets + tarifas_servicios + comisiones.'
  )

  // Inserta una fila "TOTAL" (Moto + Vehículo) después de cada grupo de
  // filas del mismo servicio — mismo criterio que filasConSubtotal en
  // ReporteServicios.vue (el detalle ya viene ordenado por servicio).
  const filasServicios: {
    servicio: string
    tipo: string
    turnos: string
    estBruto: string
    estNeto: string
    costoBase: string
    realBruto: string
    realNeto: string
  }[] = []
  let siIdx = 0
  const siDetalle = datos.servicios.detalle
  while (siIdx < siDetalle.length) {
    const codigo = siDetalle[siIdx].codigo_servicio
    const grupo = []
    while (siIdx < siDetalle.length && siDetalle[siIdx].codigo_servicio === codigo) {
      grupo.push(siDetalle[siIdx])
      siIdx++
    }
    for (const d of grupo) {
      filasServicios.push({
        servicio: `${d.codigo_servicio} - ${d.nombre_servicio}`,
        tipo: d.tipo_vehiculo === 'MOTO' ? 'Moto' : 'Vehículo',
        turnos: formatNumPdf(d.turnos),
        estBruto: formatPesoPdf(d.total_generado),
        estNeto: formatPesoPdf(d.total_neto),
        costoBase: formatPesoPdf(d.costo_base),
        realBruto: formatPesoPdf(d.valor_real_bruto),
        realNeto: formatPesoPdf(d.valor_real_neto),
      })
    }
    if (grupo.length > 1) {
      filasServicios.push({
        servicio: `${grupo[0].nombre_servicio} · Total`,
        tipo: '',
        turnos: formatNumPdf(grupo.reduce((acc, r) => acc + r.turnos, 0)),
        estBruto: formatPesoPdf(grupo.reduce((acc, r) => acc + r.total_generado, 0)),
        estNeto: formatPesoPdf(grupo.reduce((acc, r) => acc + r.total_neto, 0)),
        costoBase: formatPesoPdf(grupo.reduce((acc, r) => acc + r.costo_base, 0)),
        realBruto: formatPesoPdf(grupo.reduce((acc, r) => acc + r.valor_real_bruto, 0)),
        realNeto: formatPesoPdf(grupo.reduce((acc, r) => acc + r.valor_real_neto, 0)),
      })
    }
  }
  filasServicios.push({
    servicio: 'Totales',
    tipo: '',
    turnos: formatNumPdf(datos.servicios.totales.turnos),
    estBruto: formatPesoPdf(datos.servicios.totales.total_generado),
    estNeto: formatPesoPdf(datos.servicios.totales.total_neto),
    costoBase: formatPesoPdf(datos.servicios.totales.costo_base),
    realBruto: formatPesoPdf(datos.servicios.totales.valor_real_bruto),
    realNeto: formatPesoPdf(datos.servicios.totales.valor_real_neto),
  })

  await siDibujarTabla(
    doc,
    [
      { label: 'Servicio', property: 'servicio', width: 100 },
      { label: 'Tipo', property: 'tipo', width: 40 },
      { label: 'Turnos', property: 'turnos', width: 42, align: 'right' },
      { label: 'Est. Bruto', property: 'estBruto', width: 62, align: 'right' },
      { label: 'Est. Neto', property: 'estNeto', width: 58, align: 'right' },
      { label: 'Costo Base', property: 'costoBase', width: 62, align: 'right' },
      { label: 'Real Bruto', property: 'realBruto', width: 74, align: 'right' },
      { label: 'Real Neto', property: 'realNeto', width: 74, align: 'right' },
    ],
    filasServicios,
    filasServicios.length - 1
  )
  doc
    .font('Helvetica-Oblique')
    .fontSize(7)
    .fillColor(SI_COLOR_GRIS)
    .text(
      'Estimado = turnos × tarifa configurada (servicios sin tarifa muestran $0). Costo Base = turnos × valor RTM Global de referencia (comisiones, config general) — solo aplica a filas RTM, no ajustado por override individual de asesor. Real = directo de la factura, ya refleja descuentos aplicados.',
      SI_MARGEN_X,
      doc.y,
      { width: SI_ANCHO_UTIL }
    )
  doc.fillColor('#000000')

  // ===== 5. Retención de Clientes =====
  doc.addPage()
  siDibujarTituloSeccion(
    doc,
    5,
    'Retención de Clientes',
    `Clientes Nuevos, Recurrentes y Recuperados en el rango, por canal y por mes. Meses mínimos para recurrencia: ${datos.retencion.meses_minimos}. Fuente: turnos_rtms + facturacion_tickets + clientes.`
  )
  siDibujarKpis(doc, [
    { label: 'Nuevos', value: `${formatNumPdf(datos.retencion.resumen.nuevos.cantidad)} (${formatPctPdf(datos.retencion.resumen.nuevos.porcentaje)}) — ${formatPesoPdf(datos.retencion.resumen.nuevos.total_bruto)}` },
    { label: 'Recurrentes', value: `${formatNumPdf(datos.retencion.resumen.recurrentes.cantidad)} (${formatPctPdf(datos.retencion.resumen.recurrentes.porcentaje)}) — ${formatPesoPdf(datos.retencion.resumen.recurrentes.total_bruto)}` },
    { label: 'Recuperaciones', value: `${formatNumPdf(datos.retencion.resumen.recuperaciones.cantidad)} (${formatPctPdf(datos.retencion.resumen.recuperaciones.porcentaje)}) — ${formatPesoPdf(datos.retencion.resumen.recuperaciones.total_bruto)}` },
  ])
  doc.moveDown(0.5)
  siDibujarSubtitulo(doc, 'Por Canal')
  const filasRetencionCanal = siCompletarCanales(datos.retencion.por_canal, (canal) => ({
    canal,
    nuevos: 0,
    recurrentes: 0,
    recuperaciones: 0,
    total: 0,
    total_bruto: 0,
    porcentaje: 0,
  }))
  await siDibujarTabla(
    doc,
    [
      { label: 'Canal', property: 'canal', width: 120 },
      { label: 'Nuevos', property: 'nuevos', width: 65, align: 'right' },
      { label: 'Recur.', property: 'recurrentes', width: 65, align: 'right' },
      { label: 'Recup.', property: 'recuperaciones', width: 65, align: 'right' },
      { label: 'Total', property: 'total', width: 65, align: 'right' },
      { label: 'Total Bruto', property: 'totalBruto', width: 65, align: 'right' },
      { label: '% del Total', property: 'pct', width: 67, align: 'right' },
    ],
    filasRetencionCanal.map((c) => ({
      canal: siNombreCanal(c.canal),
      nuevos: formatNumPdf(c.nuevos),
      recurrentes: formatNumPdf(c.recurrentes),
      recuperaciones: formatNumPdf(c.recuperaciones),
      total: formatNumPdf(c.total),
      totalBruto: formatPesoPdf(c.total_bruto),
      pct: formatPctPdf(c.porcentaje),
    }))
  )
  doc.moveDown(0.8)
  siDibujarSubtitulo(doc, 'Por Mes')
  await siDibujarTabla(
    doc,
    [
      { label: 'Mes', property: 'mes', width: 120 },
      { label: 'Nuevos', property: 'nuevos', width: 95, align: 'right' },
      { label: 'Recurrentes', property: 'recurrentes', width: 95, align: 'right' },
      { label: 'Recuperaciones', property: 'recuperaciones', width: 100, align: 'right' },
      { label: 'Total', property: 'total', width: 102, align: 'right' },
    ],
    datos.retencion.por_mes.map((m) => ({
      mes: m.mes,
      nuevos: formatNumPdf(m.nuevos),
      recurrentes: formatNumPdf(m.recurrentes),
      recuperaciones: formatNumPdf(m.recuperaciones),
      total: formatNumPdf(m.total),
    }))
  )

  // ===== 6. Descuentos =====
  doc.addPage()
  siDibujarTituloSeccion(
    doc,
    6,
    'Descuentos',
    'Descuentos aplicados a facturación RTM confirmada, agrupados por tipo, canal y quién autorizó. Fuente: facturacion_tickets + descuentos + usuarios.'
  )
  siDibujarSubtitulo(doc, 'Por Tipo')
  await siDibujarTabla(
    doc,
    [
      { label: 'Código', property: 'codigo', width: 60 },
      { label: 'Tipo de descuento', property: 'tipo', width: 150 },
      { label: 'Cantidad', property: 'cantidad', width: 80, align: 'right' },
      { label: 'Total descuento', property: 'total', width: 120, align: 'right' },
      { label: 'Promedio', property: 'promedio', width: 102, align: 'right' },
    ],
    datos.descuentosTipo.por_tipo.map((t) => ({
      codigo: t.codigo,
      tipo: t.nombre,
      cantidad: formatNumPdf(t.cantidad),
      total: formatPesoPdf(t.total_descuentos),
      promedio: formatPesoPdf(t.promedio),
    }))
  )
  const descripcionesTipo = datos.descuentosTipo.por_tipo.filter((t) => t.descripcion)
  if (descripcionesTipo.length > 0) {
    doc.moveDown(0.3)
    doc.font('Helvetica-Oblique').fontSize(7).fillColor(SI_COLOR_GRIS)
    for (const t of descripcionesTipo) {
      doc.text(`${t.nombre}: ${t.descripcion}`, SI_MARGEN_X, doc.y, { width: SI_ANCHO_UTIL })
    }
    doc.fillColor('#000000')
  }
  doc.moveDown(0.8)
  siDibujarSubtitulo(doc, 'Por Canal')
  const filasDescuentosCanal = siCompletarCanales(datos.descuentosCanal.por_canal, (canal) => ({
    canal,
    cantidad: 0,
    total_descuentos: 0,
    tipos_usados: 0,
    porcentaje: 0,
  }))
  await siDibujarTabla(
    doc,
    [
      { label: 'Canal', property: 'canal', width: 120 },
      { label: 'Cantidad', property: 'cantidad', width: 75, align: 'right' },
      { label: 'Total descuento', property: 'total', width: 110, align: 'right' },
      { label: 'Tipos usados', property: 'tiposUsados', width: 75, align: 'right' },
      { label: '% del Total', property: 'pct', width: 132, align: 'right' },
    ],
    filasDescuentosCanal.map((c) => ({
      canal: siNombreCanal(c.canal),
      cantidad: formatNumPdf(c.cantidad),
      total: formatPesoPdf(c.total_descuentos),
      tiposUsados: formatNumPdf(c.tipos_usados),
      pct: formatPctPdf(c.porcentaje),
    }))
  )
  doc.moveDown(0.8)
  siDibujarSubtitulo(doc, 'Por Autorizador (Top 15 por monto)')
  const SI_TOP_N_AUTORIZADORES = 15
  const autorizadoresOrdenados = [...datos.descuentosAutorizador.por_autorizador].sort(
    (a, b) => b.total_descuentos - a.total_descuentos
  )
  const topAutorizadores = autorizadoresOrdenados.slice(0, SI_TOP_N_AUTORIZADORES)
  const restoAutorizadores = autorizadoresOrdenados.slice(SI_TOP_N_AUTORIZADORES)

  const filasAutorizador = topAutorizadores.map((a) => ({
    nombre: a.nombre,
    cantidad: formatNumPdf(a.cantidad),
    total: formatPesoPdf(a.total_descuentos),
  }))
  if (restoAutorizadores.length > 0) {
    const sumaResto = restoAutorizadores.reduce((acc, a) => acc + a.total_descuentos, 0)
    const cantidadResto = restoAutorizadores.reduce((acc, a) => acc + a.cantidad, 0)
    filasAutorizador.push({
      nombre: `Otros (${restoAutorizadores.length} autorizadores)`,
      cantidad: formatNumPdf(cantidadResto),
      total: formatPesoPdf(sumaResto),
    })
  }

  await siDibujarTabla(
    doc,
    [
      { label: 'Autorizador', property: 'nombre', width: 240 },
      { label: 'Cantidad', property: 'cantidad', width: 130, align: 'right' },
      { label: 'Total Descuento', property: 'total', width: 142, align: 'right' },
    ],
    filasAutorizador,
    restoAutorizadores.length > 0 ? filasAutorizador.length - 1 : null
  )
  if (restoAutorizadores.length > 0) {
    doc
      .font('Helvetica-Oblique')
      .fontSize(7)
      .fillColor(SI_COLOR_GRIS)
      .text('Detalle completo disponible en el reporte de Descuentos (pestaña Por Autorizador).', SI_MARGEN_X, doc.y, {
        width: SI_ANCHO_UTIL,
      })
    doc.fillColor('#000000')
    doc.moveDown(0.3)
  }

  // ===== 7. Producción por Líder =====
  doc.addPage()
  siDibujarTituloSeccion(
    doc,
    7,
    'Producción por Líder',
    'Producción agregada por sede y líder comercial. Fuente: turnos_rtms + facturacion_tickets + usuarios.'
  )
  await siDibujarTabla(
    doc,
    [
      { label: 'Sede', property: 'sede', width: 60 },
      { label: 'Líder', property: 'lider', width: 95 },
      { label: 'RTM', property: 'rtm', width: 40, align: 'right' },
      { label: 'SOAT', property: 'soat', width: 40, align: 'right' },
      { label: 'PREV', property: 'prev', width: 40, align: 'right' },
      { label: 'PERI', property: 'peri', width: 40, align: 'right' },
      { label: 'Vehículos', property: 'vehiculos', width: 55, align: 'right' },
      { label: 'Total Bruto', property: 'totalBruto', width: 71, align: 'right' },
      { label: 'Total Neto', property: 'totalNeto', width: 71, align: 'right' },
    ],
    datos.produccionLider.por_sede.map((s) => ({
      sede: s.sede_nombre ?? '—',
      lider: s.lider_nombre,
      rtm: formatNumPdf(s.turnos_rtm),
      soat: formatNumPdf(s.turnos_soat),
      prev: formatNumPdf(s.turnos_prev),
      peri: formatNumPdf(s.turnos_peri),
      vehiculos: formatNumPdf(s.vehiculos),
      totalBruto: formatPesoPdf(s.total_bruto),
      totalNeto: formatPesoPdf(s.total_neto),
    }))
  )
  doc
    .font('Helvetica-Oblique')
    .fontSize(7)
    .fillColor(SI_COLOR_GRIS)
    .text(
      'RTM/SOAT/PREV/PERI = turnos atendidos (turnos_rtms). Vehículos/Total Bruto/Total Neto = facturación confirmada. Pueden no coincidir.',
      SI_MARGEN_X,
      doc.y,
      { width: SI_ANCHO_UTIL }
    )
  doc.fillColor('#000000')
}

/**
 * Construye el PDF completo en 2 pasadas:
 *  1. Pasada sonda (nunca se serializa) — solo para saber cuántas páginas
 *     físicas ocupa el contenido, incluyendo el desborde automático de
 *     tablas largas (ej. "Por Autorizador" en Descuentos).
 *  2. Pasada real — agrega el pie de página EN EL MOMENTO en que cada
 *     página se crea (evento 'pageAdded'), ya con el total de páginas
 *     conocido de la pasada 1. Evita switchToPage()/bufferedPageRange()
 *     después del hecho, que con pdfkit-table termina creando una página en
 *     blanco extra por cada pie de página añadido.
 */
async function construirSuperInformePdf(datos: SuperInformeDatos): Promise<Buffer> {
  const fechaGeneracion = DateTime.now().setLocale('es').toFormat("d 'de' MMMM 'de' yyyy, h:mm a")

  const docSonda = new PDFDocument({ margin: 50, size: 'LETTER', bufferPages: true })
  await dibujarContenidoSuperInforme(docSonda, datos, fechaGeneracion)
  const totalPaginas = docSonda.bufferedPageRange().count

  const doc = new PDFDocument({ margin: 50, size: 'LETTER', bufferPages: true })
  // OJO: la página 1 (portada), creada por el constructor con
  // autoFirstPage:true, NO dispara 'pageAdded' (el listener se registra
  // después de crear el doc) — por eso nunca lleva pie de página sin
  // necesidad de un skip explícito, y el número mostrado es
  // paginaActual+1 (paginaActual cuenta páginas AÑADIDAS después de la 1ª).
  let paginaActual = 0
  doc.on('pageAdded', () => {
    paginaActual++
    const numeroPagina = paginaActual + 1
    const { x: savedX, y: savedY } = doc
    const savedBottomMargin = doc.page.margins.bottom
    doc.page.margins.bottom = 0 // evita que pdfkit dispare continueOnNewPage() al escribir en el margen inferior
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor('#999999')
      .text(
        `Página ${numeroPagina} de ${totalPaginas}   —   Generado el ${fechaGeneracion}`,
        SI_MARGEN_X,
        doc.page.height - 40,
        { align: 'center', width: doc.page.width - 100, lineBreak: false }
      )
    doc.fillColor('#000000')
    doc.page.margins.bottom = savedBottomMargin
    doc.x = savedX
    doc.y = savedY
  })
  await dibujarContenidoSuperInforme(doc, datos, fechaGeneracion)

  return await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = []
    doc.on('data', (chunk: Buffer) => chunks.push(chunk))
    doc.on('end', () => resolve(Buffer.concat(chunks)))
    doc.on('error', reject)
    doc.end()
  })
}

export default class ReportesAdministrativosController {
  /**
   * GET /reportes-admin/ingresos-canal?fecha_inicio=&fecha_fin=
   * Ingresos por canal de captación (facturacion_tickets, estado CONFIRMADA).
   */
  public async ingresosPorCanal({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeIngresosPorCanal(fechaInicio, fechaFin)
  }

  /** Cálculo compartido por ingresosPorCanal() y el Súper Informe. */
  private async computeIngresosPorCanal(fechaInicio: string, fechaFin: string) {
    const rows = (await Database.from('facturacion_tickets')
      .where('estado', 'CONFIRMADA')
      .where('servicio_codigo', 'RTM')
      .whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select(Database.raw("COALESCE(captacion_canal, 'FACHADA') as captacion_canal"))
      .count('* as cantidad')
      .sum('total as total_bruto')
      .sum('subtotal as total_neto')
      .avg('total as promedio_ticket')
      .groupByRaw("COALESCE(captacion_canal, 'FACHADA')")
      .orderBy('total_bruto', 'desc')) as any[]

    const porCanal = rows.map((r) => ({
      canal: r.captacion_canal,
      cantidad: Number(r.cantidad),
      total_bruto: Number(r.total_bruto) || 0,
      total_neto: Number(r.total_neto) || 0,
      promedio_ticket: Number(r.promedio_ticket) || 0,
    }))

    const totales = porCanal.reduce(
      (acc, r) => ({
        cantidad: acc.cantidad + r.cantidad,
        total_bruto: acc.total_bruto + r.total_bruto,
        total_neto: acc.total_neto + r.total_neto,
      }),
      { cantidad: 0, total_bruto: 0, total_neto: 0 }
    )

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_canal: porCanal,
      totales: {
        canal: 'TOTAL',
        cantidad: totales.cantidad,
        total_bruto: totales.total_bruto,
        total_neto: totales.total_neto,
        promedio_ticket: totales.cantidad
          ? Math.round((totales.total_bruto / totales.cantidad) * 100) / 100
          : 0,
      },
    }
  }

  /**
   * GET /reportes-admin/produccion-lider?fecha_inicio=&fecha_fin=
   * Producción por sede + líder de sede (usuarios.cargo.nombre = 'LIDER DE SEDE').
   */
  public async produccionPorLider({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeProduccionPorLider(fechaInicio, fechaFin)
  }

  /** Cálculo compartido por produccionPorLider() y el Súper Informe. */
  private async computeProduccionPorLider(fechaInicio: string, fechaFin: string) {
    const rows = (await Database.from('facturacion_tickets')
      .where('estado', 'CONFIRMADA')
      .whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('sede_id', 'sede_nombre')
      .count('* as vehiculos')
      .sum('total as total_bruto')
      .sum('subtotal as total_neto')
      .groupBy('sede_id', 'sede_nombre')
      .orderBy('total_bruto', 'desc')) as any[]

    const sedeIds = [...new Set(rows.map((r) => r.sede_id).filter((v) => v !== null))] as number[]

    const lideres = sedeIds.length
      ? await Usuario.query()
          .whereHas('cargo', (q) => q.where('nombre', 'LIDER DE SEDE'))
          .whereIn('sede_id', sedeIds)
          .where('estado', 'activo')
      : []

    const liderPorSede = new Map<number, string>()
    for (const u of lideres) {
      if (u.sedeId && !liderPorSede.has(u.sedeId)) {
        liderPorSede.set(u.sedeId, `${u.nombres} ${u.apellidos}`)
      }
    }

    // ===== Desglose por servicio (RTM/SOAT/PREV/PERI) =====
    // Turnos ATENDIDOS (turnos_rtms), no facturación: SOAT/PREV/PERI no generan
    // ticket en este entorno (ver reporteServicios), así que facturacion_tickets
    // no sirve para este conteo. Vehículos/Total Bruto/Total Neto de arriba
    // siguen siendo de facturacion_tickets — por eso pueden no coincidir.
    const turnosPorServicio = (await Database.from('turnos_rtms as t')
      .join('servicios as s', 's.id', 't.servicio_id')
      .whereRaw('DATE(t.fecha) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .whereRaw("t.placa NOT LIKE 'TST%'")
      .select('t.sede_id', 's.codigo_servicio')
      .count('* as turnos')
      .groupBy('t.sede_id', 's.codigo_servicio')) as any[]

    const SERVICIOS_DESGLOSE = ['RTM', 'SOAT', 'PREV', 'PERI'] as const
    const serviciosPorSede = new Map<number, Record<(typeof SERVICIOS_DESGLOSE)[number], number>>()
    for (const r of turnosPorServicio) {
      const sedeId = r.sede_id === null ? null : Number(r.sede_id)
      if (sedeId === null) continue
      if (!serviciosPorSede.has(sedeId)) {
        serviciosPorSede.set(sedeId, { RTM: 0, SOAT: 0, PREV: 0, PERI: 0 })
      }
      const codigo = String(r.codigo_servicio).toUpperCase() as (typeof SERVICIOS_DESGLOSE)[number]
      if (SERVICIOS_DESGLOSE.includes(codigo)) {
        serviciosPorSede.get(sedeId)![codigo] = Number(r.turnos)
      }
    }

    const porSede = rows.map((r) => {
      const sedeId = r.sede_id === null ? null : Number(r.sede_id)
      const servicios = (sedeId !== null && serviciosPorSede.get(sedeId)) || {
        RTM: 0,
        SOAT: 0,
        PREV: 0,
        PERI: 0,
      }
      return {
        sede_nombre: r.sede_nombre,
        lider_nombre: sedeId !== null
          ? (liderPorSede.get(sedeId) ?? 'Sin líder asignado')
          : 'Sin líder asignado',
        vehiculos: Number(r.vehiculos),
        total_bruto: Number(r.total_bruto) || 0,
        total_neto: Number(r.total_neto) || 0,
        turnos_rtm: servicios.RTM,
        turnos_soat: servicios.SOAT,
        turnos_prev: servicios.PREV,
        turnos_peri: servicios.PERI,
      }
    })

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_sede: porSede,
    }
  }

  /**
   * GET /reportes-admin/asesores?fecha_inicio=&fecha_fin=
   * Producción por asesor (comercial o convenio).
   * nombre = COALESCE(agente_comercial_nombre, asesor_convenio_nombre):
   * en facturacion_tickets, agente_comercial_nombre solo se llena para
   * canal ASESOR_COMERCIAL; para ASESOR_CONVENIO el nombre vive en
   * asesor_convenio_nombre.
   */
  public async reporteAsesores({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const rows = (await Database.from('facturacion_tickets')
      .whereIn('captacion_canal', ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'])
      .where('estado', 'CONFIRMADA')
      .where('servicio_codigo', 'RTM')
      .whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .whereNotNull('agente_id')
      .select('agente_id', 'captacion_canal')
      .select(
        Database.raw(
          'COALESCE(MAX(agente_comercial_nombre), MAX(asesor_convenio_nombre)) as nombre'
        )
      )
      .select(
        Database.raw(
          'SUM(CASE WHEN convenio_nombre IS NULL THEN 1 ELSE 0 END) as vehiculos_directos'
        )
      )
      .select(
        Database.raw(
          'SUM(CASE WHEN convenio_nombre IS NOT NULL THEN 1 ELSE 0 END) as vehiculos_convenio'
        )
      )
      .count('* as total_vehiculos')
      .sum('total as total_bruto')
      .sum('subtotal as total_neto')
      .groupBy('agente_id', 'captacion_canal')
      .orderBy('total_vehiculos', 'desc')) as any[]

    const asesores = rows.map((r) => ({
      agente_id: Number(r.agente_id),
      nombre: r.nombre,
      canal: r.captacion_canal,
      vehiculos_directos: Number(r.vehiculos_directos) || 0,
      vehiculos_convenio: Number(r.vehiculos_convenio) || 0,
      total_vehiculos: Number(r.total_vehiculos),
      total_bruto: Number(r.total_bruto) || 0,
      total_neto: Number(r.total_neto) || 0,
    }))

    // ===== Convenio (solo tickets captados por ASESOR_COMERCIAL — los de
    // ASESOR_CONVENIO ya están en el segmento "Asesor Convenio", no se duplican) =====
    const convenioRows = (await Database.from('facturacion_tickets')
      .where('estado', 'CONFIRMADA')
      .where('servicio_codigo', 'RTM')
      .whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .where('captacion_canal', 'ASESOR_COMERCIAL')
      .whereNotNull('convenio_nombre')
      .select('convenio_nombre')
      .select(
        Database.raw(
          "GROUP_CONCAT(DISTINCT agente_comercial_nombre ORDER BY agente_comercial_nombre SEPARATOR ', ') as asesores"
        )
      )
      .count('* as total_vehiculos')
      .sum('total as total_bruto')
      .sum('subtotal as total_neto')
      .groupBy('convenio_nombre')
      .orderBy('total_bruto', 'desc')) as any[]

    const convenios = convenioRows.map((r) => ({
      convenio_nombre: r.convenio_nombre,
      asesores: r.asesores ?? '',
      total_vehiculos: Number(r.total_vehiculos),
      total_bruto: Number(r.total_bruto) || 0,
      total_neto: Number(r.total_neto) || 0,
    }))

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      asesores,
      convenios,
    }
  }

  /**
   * GET /reportes-admin/detalle-asesor?fecha_inicio=&fecha_fin=&agente_id=&canal=
   * Placas facturadas por un asesor/canal puntual (drill-down de /asesores).
   */
  public async detallePorAsesor({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const agenteId = request.input('agente_id') as string | number | undefined
    const canal = request.input('canal') as string | undefined

    if (!agenteId || !canal) {
      return response.badRequest({ message: 'agente_id y canal son requeridos' })
    }

    const rows = (await Database.from('facturacion_tickets as ft')
      .leftJoin('turnos_rtms as t', 't.id', 'ft.turno_id')
      .leftJoin('clientes as c', 'c.id', 't.cliente_id')
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .where('ft.agente_id', agenteId)
      .where('ft.captacion_canal', canal)
      .select(
        'ft.placa',
        'ft.captacion_canal',
        'ft.agente_comercial_nombre',
        'ft.asesor_convenio_nombre',
        'ft.convenio_nombre',
        'ft.total',
        'ft.subtotal',
        Database.raw('DATE(ft.created_at) as fecha'),
        'ft.tipo_vehiculo',
        'ft.servicio_codigo',
        // Cliente — NULL si aún no se subió el RepGeneral (turno sin cliente_id o cliente sin nombre)
        'c.nombre as cliente_nombre',
        'c.doc_numero as cliente_documento'
      )
      .orderBy('ft.created_at', 'desc')) as any[]

    const agente = await AgenteCaptacion.find(Number(agenteId))
    const nombreDeTicket = rows[0]?.agente_comercial_nombre ?? rows[0]?.asesor_convenio_nombre ?? null
    const nombre = agente?.nombre ?? nombreDeTicket ?? '—'

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      total: Number(r.total) || 0,
      subtotal: Number(r.subtotal) || 0,
      tipo_vehiculo: r.tipo_vehiculo,
      convenio_nombre: r.convenio_nombre ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totalBruto = detalle.reduce((acc, d) => acc + d.total, 0)

    return {
      agente_id: Number(agenteId),
      nombre,
      canal,
      total_vehiculos: detalle.length,
      total_bruto: totalBruto,
      detalle,
    }
  }

  /**
   * GET /reportes-admin/detalle-canal?fecha_inicio=&fecha_fin=&canal=
   * Placas facturadas de un canal puntual (drill-down de /ingresos-canal).
   */
  public async detallePorCanal({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const canal = request.input('canal') as string | undefined
    if (!canal) return response.badRequest({ message: 'canal es requerido' })

    const rows = (await Database.from('facturacion_tickets as ft')
      .leftJoin('turnos_rtms as t', 't.id', 'ft.turno_id')
      .leftJoin('clientes as c', 'c.id', 't.cliente_id')
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .where((q) => {
        if (canal === 'FACHADA') {
          q.where('ft.captacion_canal', 'FACHADA').orWhereNull('ft.captacion_canal')
        } else {
          q.where('ft.captacion_canal', canal)
        }
      })
      .select(
        'ft.placa',
        'ft.captacion_canal',
        'ft.agente_comercial_nombre',
        'ft.asesor_convenio_nombre',
        'ft.convenio_nombre',
        'ft.total',
        'ft.subtotal',
        Database.raw('DATE(ft.created_at) as fecha'),
        'ft.tipo_vehiculo',
        // Cliente — NULL si aún no se subió el RepGeneral (turno sin cliente_id o cliente sin nombre)
        'c.nombre as cliente_nombre',
        'c.doc_numero as cliente_documento'
      )
      .orderBy('ft.created_at', 'desc')) as any[]

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      total: Number(r.total) || 0,
      subtotal: Number(r.subtotal) || 0,
      agente_comercial_nombre: r.agente_comercial_nombre ?? null,
      asesor_convenio_nombre: r.asesor_convenio_nombre ?? null,
      convenio_nombre: r.convenio_nombre ?? null,
      tipo_vehiculo: r.tipo_vehiculo,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totalBruto = detalle.reduce((acc, d) => acc + d.total, 0)

    return {
      canal,
      total_vehiculos: detalle.length,
      total_bruto: totalBruto,
      detalle,
    }
  }

  /**
   * GET /reportes-admin/retencion?fecha_inicio=&fecha_fin=
   * Clasifica los turnos facturados (CONFIRMADA) del rango en NUEVO / RECURRENTE /
   * RECUPERACION según las columnas de retención de turnos_rtms:
   *   - NUEVO: meses_desde_ultima_visita IS NULL
   *   - RECURRENTE: es_recurrente = 1
   *   - RECUPERACION: es_recuperacion = 1
   * El filtro de rango se aplica sobre turnos_rtms.fecha (fecha real del turno).
   */
  public async retencionClientes({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeRetencionClientes(fechaInicio, fechaFin)
  }

  /** Cálculo compartido por retencionClientes() y el Súper Informe. */
  private async computeRetencionClientes(fechaInicio: string, fechaFin: string) {
    const configRecurrencia = await Database.from('configuracion_recurrencia_global')
      .select('meses_minimos')
      .first()
    const mesesMinimos = configRecurrencia ? Number(configRecurrencia.meses_minimos) : 24

    const CLASIFICACION_SQL = `
      CASE
        WHEN t.meses_desde_ultima_visita IS NULL THEN 'NUEVO'
        WHEN t.es_recurrente = 1 THEN 'RECURRENTE'
        WHEN t.es_recuperacion = 1 THEN 'RECUPERACION'
        ELSE 'NUEVO'
      END
    `

    const baseQuery = () =>
      Database.from('turnos_rtms as t')
        .innerJoin('facturacion_tickets as ft', 'ft.turno_id', 't.id')
        .where('ft.estado', 'CONFIRMADA')
        .where('ft.servicio_codigo', 'RTM')
        .whereBetween('t.fecha', [fechaInicio, fechaFin])

    // ----- Resumen general (NUEVO / RECURRENTE / RECUPERACION) -----
    const resumenRows = (await baseQuery()
      .select(Database.raw(`${CLASIFICACION_SQL} as categoria`))
      .count('* as cantidad')
      .sum('ft.total as total_bruto')
      .groupByRaw(CLASIFICACION_SQL)) as any[]

    const resumenBase = { NUEVO: 0, RECURRENTE: 0, RECUPERACION: 0 }
    const cantidadPorCategoria = { ...resumenBase }
    const brutoPorCategoria = { ...resumenBase }
    for (const r of resumenRows) {
      const categoria = r.categoria as 'NUEVO' | 'RECURRENTE' | 'RECUPERACION'
      cantidadPorCategoria[categoria] = Number(r.cantidad)
      brutoPorCategoria[categoria] = Number(r.total_bruto) || 0
    }

    const totalCantidad =
      cantidadPorCategoria.NUEVO + cantidadPorCategoria.RECURRENTE + cantidadPorCategoria.RECUPERACION
    const totalBruto =
      brutoPorCategoria.NUEVO + brutoPorCategoria.RECURRENTE + brutoPorCategoria.RECUPERACION

    const porcentaje = (cantidad: number) =>
      totalCantidad ? Math.round((cantidad / totalCantidad) * 10000) / 100 : 0

    const resumen = {
      nuevos: {
        cantidad: cantidadPorCategoria.NUEVO,
        total_bruto: brutoPorCategoria.NUEVO,
        porcentaje: porcentaje(cantidadPorCategoria.NUEVO),
      },
      recurrentes: {
        cantidad: cantidadPorCategoria.RECURRENTE,
        total_bruto: brutoPorCategoria.RECURRENTE,
        porcentaje: porcentaje(cantidadPorCategoria.RECURRENTE),
      },
      recuperaciones: {
        cantidad: cantidadPorCategoria.RECUPERACION,
        total_bruto: brutoPorCategoria.RECUPERACION,
        porcentaje: porcentaje(cantidadPorCategoria.RECUPERACION),
      },
      total: {
        cantidad: totalCantidad,
        total_bruto: totalBruto,
      },
    }

    // ----- Por canal -----
    const canalRows = (await baseQuery()
      .select(
        Database.raw("COALESCE(ft.captacion_canal, 'FACHADA') as canal"),
        Database.raw(`${CLASIFICACION_SQL} as categoria`)
      )
      .count('* as cantidad')
      .sum('ft.total as total_bruto')
      .groupByRaw("COALESCE(ft.captacion_canal, 'FACHADA')")
      .groupByRaw(CLASIFICACION_SQL)) as any[]

    const canalMap = new Map<
      string,
      { canal: string; nuevos: number; recurrentes: number; recuperaciones: number; total: number; total_bruto: number }
    >()
    for (const r of canalRows) {
      const canal = r.canal
      if (!canalMap.has(canal)) {
        canalMap.set(canal, {
          canal,
          nuevos: 0,
          recurrentes: 0,
          recuperaciones: 0,
          total: 0,
          total_bruto: 0,
        })
      }
      const entry = canalMap.get(canal)!
      const cantidad = Number(r.cantidad)
      const bruto = Number(r.total_bruto) || 0
      if (r.categoria === 'NUEVO') entry.nuevos += cantidad
      else if (r.categoria === 'RECURRENTE') entry.recurrentes += cantidad
      else if (r.categoria === 'RECUPERACION') entry.recuperaciones += cantidad
      entry.total += cantidad
      entry.total_bruto += bruto
    }

    const porCanal = [...canalMap.values()]
      .sort((a, b) => b.total - a.total)
      .map((c) => ({
        ...c,
        porcentaje: totalCantidad ? Math.round((c.total / totalCantidad) * 10000) / 100 : 0,
      }))

    // ----- Por mes -----
    const mesRows = (await baseQuery()
      .select(
        Database.raw(`DATE_FORMAT(t.fecha, '%Y-%m') as mes`),
        Database.raw(`${CLASIFICACION_SQL} as categoria`)
      )
      .count('* as cantidad')
      .groupByRaw(`DATE_FORMAT(t.fecha, '%Y-%m')`)
      .groupByRaw(CLASIFICACION_SQL)
      .orderByRaw(`DATE_FORMAT(t.fecha, '%Y-%m')`)) as any[]

    const mesMap = new Map<
      string,
      { mes: string; nuevos: number; recurrentes: number; recuperaciones: number; total: number }
    >()
    for (const r of mesRows) {
      const mes = r.mes as string
      if (!mesMap.has(mes)) {
        mesMap.set(mes, { mes, nuevos: 0, recurrentes: 0, recuperaciones: 0, total: 0 })
      }
      const entry = mesMap.get(mes)!
      const cantidad = Number(r.cantidad)
      if (r.categoria === 'NUEVO') entry.nuevos += cantidad
      else if (r.categoria === 'RECURRENTE') entry.recurrentes += cantidad
      else if (r.categoria === 'RECUPERACION') entry.recuperaciones += cantidad
      entry.total += cantidad
    }

    const porMes = [...mesMap.values()].sort((a, b) => a.mes.localeCompare(b.mes))

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      meses_minimos: mesesMinimos,
      resumen,
      por_canal: porCanal,
      por_mes: porMes,
    }
  }

  /**
   * GET /reportes-admin/detalle-retencion?fecha_inicio=&fecha_fin=&categoria=&canal=
   * Drill-down de /retencion: placas + clientes de una categoría (y opcionalmente
   * un canal) puntual.
   */
  public async detallePorRetencion({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const categoria = request.input('categoria') as string | undefined
    const canal = request.input('canal') as string | undefined

    const categoriasValidas = ['NUEVO', 'RECURRENTE', 'RECUPERACION']
    if (!categoria || !categoriasValidas.includes(categoria)) {
      return response.badRequest({
        message: 'categoria es requerida y debe ser NUEVO, RECURRENTE o RECUPERACION',
      })
    }

    const query = Database.from('facturacion_tickets as ft')
      .innerJoin('turnos_rtms as t', 't.id', 'ft.turno_id')
      .leftJoin('clientes as c', 'c.id', 't.cliente_id')
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .whereBetween('t.fecha', [fechaInicio, fechaFin])

    if (categoria === 'NUEVO') query.whereNull('t.meses_desde_ultima_visita')
    else if (categoria === 'RECURRENTE') query.where('t.es_recurrente', 1)
    else query.where('t.es_recuperacion', 1)

    if (canal === 'FACHADA') {
      query.where((q) => q.where('ft.captacion_canal', 'FACHADA').orWhereNull('ft.captacion_canal'))
    } else if (canal) {
      query.where('ft.captacion_canal', canal)
    }

    const rows = (await query
      .select(
        'ft.placa',
        Database.raw('DATE(t.fecha) as fecha'),
        Database.raw("COALESCE(ft.captacion_canal, 'FACHADA') as captacion_canal"),
        'ft.total',
        'ft.subtotal',
        'ft.tipo_vehiculo',
        'ft.agente_comercial_nombre',
        'ft.asesor_convenio_nombre',
        'ft.convenio_nombre',
        't.meses_desde_ultima_visita',
        't.fecha_ultima_visita',
        'c.nombre as cliente_nombre',
        'c.doc_numero as cliente_documento'
      )
      .orderBy('t.fecha', 'desc')) as any[]

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      tipo_vehiculo: r.tipo_vehiculo ?? null,
      total: Number(r.total) || 0,
      captacion_canal: r.captacion_canal,
      agente_comercial_nombre: r.agente_comercial_nombre ?? null,
      asesor_convenio_nombre: r.asesor_convenio_nombre ?? null,
      convenio_nombre: r.convenio_nombre ?? null,
      meses_desde_ultima_visita: r.meses_desde_ultima_visita ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totalBruto = detalle.reduce((acc, d) => acc + d.total, 0)

    return {
      categoria,
      canal: canal ?? 'TODOS',
      total_vehiculos: detalle.length,
      total_bruto: totalBruto,
      detalle,
    }
  }

  /**
   * GET /reportes-admin/servicios?fecha_inicio=&fecha_fin=
   * Cruza turnos_rtms (todos los servicios: RTM/SOAT/PREV/PERI) con tarifas_servicios
   * para estimar ingresos por servicio, sin depender de facturacion_tickets
   * (SOAT/PREV/PERI no generan ticket en este entorno).
   */
  public async reporteServicios({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeReporteServicios(fechaInicio, fechaFin)
  }

  /** Cálculo compartido por reporteServicios() y el Súper Informe. */
  private async computeReporteServicios(fechaInicio: string, fechaFin: string) {
    const sql = `
      SELECT
        s.id as servicio_id,
        s.codigo_servicio,
        s.nombre_servicio,
        CASE
          WHEN LOWER(t.tipo_vehiculo) LIKE '%moto%' THEN 'MOTO'
          ELSE 'VEHICULO'
        END as tipo_vehiculo_clasificado,
        COUNT(*) as turnos,
        MAX(ts.valor_base) as valor_base,
        MAX(ts.valor_total) as valor_total,
        COALESCE(SUM(ft.total), 0) as valor_real_bruto,
        COALESCE(SUM(ft.subtotal), 0) as valor_real_neto
      FROM turnos_rtms t
      JOIN servicios s ON s.id = t.servicio_id
      LEFT JOIN facturacion_tickets ft
        ON ft.turno_id = t.id
        AND ft.estado = 'CONFIRMADA'
      LEFT JOIN tarifas_servicios ts
        ON ts.servicio_id = t.servicio_id
        AND ts.tipo_vehiculo = CASE
          WHEN LOWER(t.tipo_vehiculo) LIKE '%moto%' THEN 'MOTO'
          ELSE 'VEHICULO'
        END
        AND ts.activo = 1
      WHERE t.estado = 'finalizado'
        AND DATE(t.fecha) BETWEEN ? AND ?
        AND t.placa NOT LIKE 'TST%'
      GROUP BY s.id, s.codigo_servicio, s.nombre_servicio, tipo_vehiculo_clasificado
      ORDER BY s.id ASC, tipo_vehiculo_clasificado ASC
    `

    const result = (await Database.rawQuery(sql, [fechaInicio, fechaFin])) as unknown as [any[]]
    const rows = result[0]

    // Costo Base RTM (valor Global de referencia — comisiones es_config=true,
    // asesor_id IS NULL). Solo aplica a filas RTM: valor_rtm_moto/vehiculo es
    // un concepto específico de RTM, no de SOAT/PREV/PERI.
    const costoBaseGlobal = await obtenerCostoBaseRtmGlobal()

    const detalle = rows.map((r) => {
      const turnos = Number(r.turnos)
      const valorUnitario = Number(r.valor_total) || 0
      const valorBase = Number(r.valor_base) || 0
      const esRTM = r.codigo_servicio === 'RTM'
      const costoBaseUnitario = r.tipo_vehiculo_clasificado === 'MOTO' ? costoBaseGlobal.moto : costoBaseGlobal.vehiculo
      return {
        codigo_servicio: r.codigo_servicio,
        nombre_servicio: r.nombre_servicio,
        tipo_vehiculo: r.tipo_vehiculo_clasificado,
        turnos,
        valor_unitario: valorUnitario,
        total_generado: turnos * valorUnitario,
        total_neto: turnos * valorBase,
        // Costo Base = turnos × valor Global de referencia RTM (moto o
        // vehículo). No ajustado por override individual de asesor — ver
        // nota en el PDF. $0 para servicios que no son RTM.
        costo_base: esRTM ? turnos * costoBaseUnitario : 0,
        // Valor REAL cobrado (post-descuento), directo de la factura —
        // distinto de total_generado/total_neto arriba, que son estimados
        // (turnos × tarifa configurada). Puede diferir si hay descuentos
        // aplicados o la tarifa configurada no refleja lo realmente cobrado.
        valor_real_bruto: Number(r.valor_real_bruto) || 0,
        valor_real_neto: Number(r.valor_real_neto) || 0,
      }
    })

    const totales = detalle.reduce(
      (acc, d) => ({
        turnos: acc.turnos + d.turnos,
        total_generado: acc.total_generado + d.total_generado,
        total_neto: acc.total_neto + d.total_neto,
        costo_base: acc.costo_base + d.costo_base,
        valor_real_bruto: acc.valor_real_bruto + d.valor_real_bruto,
        valor_real_neto: acc.valor_real_neto + d.valor_real_neto,
      }),
      { turnos: 0, total_generado: 0, total_neto: 0, costo_base: 0, valor_real_bruto: 0, valor_real_neto: 0 }
    )

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      detalle,
      totales,
    }
  }

  /**
   * GET /reportes-admin/descuentos-por-tipo?fecha_inicio=&fecha_fin=
   * Descuentos aplicados agrupados por tipo de descuento.
   */
  public async descuentosPorTipo({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeDescuentosPorTipo(fechaInicio, fechaFin)
  }

  /** Cálculo compartido por descuentosPorTipo() y el Súper Informe. */
  private async computeDescuentosPorTipo(fechaInicio: string, fechaFin: string) {
    const rows = (await Database.from('facturacion_tickets as ft')
      .join('descuentos as d', 'd.id', 'ft.descuento_id')
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .whereNotNull('ft.descuento_id')
      .where('ft.descuento_monto_aplicado', '>', 0)
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('d.codigo', 'd.nombre', 'd.descripcion')
      .count('* as cantidad')
      .sum('ft.descuento_monto_aplicado as total_descuentos')
      .avg('ft.descuento_monto_aplicado as promedio')
      .groupBy('d.id', 'd.codigo', 'd.nombre', 'd.descripcion')
      .orderBy('cantidad', 'desc')) as any[]

    const porTipo = rows.map((r) => ({
      codigo: r.codigo,
      nombre: r.nombre,
      descripcion: r.descripcion ?? null,
      cantidad: Number(r.cantidad),
      total_descuentos: Number(r.total_descuentos) || 0,
      promedio: Number(r.promedio) || 0,
    }))

    const totales = porTipo.reduce(
      (acc, r) => ({
        cantidad: acc.cantidad + r.cantidad,
        total_descuentos: acc.total_descuentos + r.total_descuentos,
      }),
      { cantidad: 0, total_descuentos: 0 }
    )

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_tipo: porTipo,
      totales,
    }
  }

  /**
   * GET /reportes-admin/descuentos-por-canal?fecha_inicio=&fecha_fin=
   * Descuentos aplicados agrupados por canal de captación.
   */
  public async descuentosPorCanal({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeDescuentosPorCanal(fechaInicio, fechaFin)
  }

  /** Cálculo compartido por descuentosPorCanal() y el Súper Informe. */
  private async computeDescuentosPorCanal(fechaInicio: string, fechaFin: string) {
    const rows = (await Database.from('facturacion_tickets as ft')
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .whereNotNull('ft.descuento_id')
      .where('ft.descuento_monto_aplicado', '>', 0)
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select(Database.raw("COALESCE(ft.captacion_canal, 'FACHADA') as canal"))
      .count('* as cantidad')
      .sum('ft.descuento_monto_aplicado as total_descuentos')
      .countDistinct('ft.descuento_id as tipos_usados')
      .groupByRaw("COALESCE(ft.captacion_canal, 'FACHADA')")
      .orderBy('cantidad', 'desc')) as any[]

    const porCanalBase = rows.map((r) => ({
      canal: r.canal,
      cantidad: Number(r.cantidad),
      total_descuentos: Number(r.total_descuentos) || 0,
      tipos_usados: Number(r.tipos_usados),
    }))

    const totales = porCanalBase.reduce(
      (acc, r) => ({
        cantidad: acc.cantidad + r.cantidad,
        total_descuentos: acc.total_descuentos + r.total_descuentos,
      }),
      { cantidad: 0, total_descuentos: 0 }
    )

    const porCanal = porCanalBase.map((c) => ({
      ...c,
      porcentaje: totales.total_descuentos
        ? Math.round((c.total_descuentos / totales.total_descuentos) * 10000) / 100
        : 0,
    }))

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_canal: porCanal,
      totales,
    }
  }

  /**
   * GET /reportes-admin/descuentos-por-autorizador?fecha_inicio=&fecha_fin=
   * Descuentos aplicados agrupados por usuario que autorizó (caja).
   */
  public async descuentosPorAutorizador({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeDescuentosPorAutorizador(fechaInicio, fechaFin)
  }

  /** Cálculo compartido por descuentosPorAutorizador() y el Súper Informe. */
  private async computeDescuentosPorAutorizador(fechaInicio: string, fechaFin: string) {
    const rows = (await Database.from('facturacion_tickets as ft')
      .join('usuarios as u', 'u.id', 'ft.autorizado_por_id')
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .whereNotNull('ft.descuento_id')
      .where('ft.descuento_monto_aplicado', '>', 0)
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('u.id as usuario_id')
      .select(Database.raw(`CONCAT(u.nombres, ' ', u.apellidos) as nombre`))
      .count('* as cantidad')
      .sum('ft.descuento_monto_aplicado as total_descuentos')
      .groupBy('u.id', 'u.nombres', 'u.apellidos')
      .orderBy('cantidad', 'desc')) as any[]

    const porAutorizador = rows.map((r) => ({
      usuario_id: Number(r.usuario_id),
      nombre: r.nombre,
      cantidad: Number(r.cantidad),
      total_descuentos: Number(r.total_descuentos) || 0,
    }))

    const totales = porAutorizador.reduce(
      (acc, r) => ({
        cantidad: acc.cantidad + r.cantidad,
        total_descuentos: acc.total_descuentos + r.total_descuentos,
      }),
      { cantidad: 0, total_descuentos: 0 }
    )

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      por_autorizador: porAutorizador,
      totales,
    }
  }

  /**
   * GET /reportes-admin/detalle-descuentos?fecha_inicio=&fecha_fin=&tipo=&canal=
   * Drill-down de los 3 reportes de descuentos: placas con descuento aplicado,
   * filtrable opcionalmente por tipo (codigo del descuento) y/o canal.
   */
  public async detalleDescuentos({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const tipo = (request.input('tipo') as string | undefined) || null
    const canal = (request.input('canal') as string | undefined) || null

    const query = Database.from('facturacion_tickets as ft')
      .join('descuentos as d', 'd.id', 'ft.descuento_id')
      .leftJoin('usuarios as u', 'u.id', 'ft.autorizado_por_id')
      .leftJoin('turnos_rtms as t', 't.id', 'ft.turno_id')
      .leftJoin('clientes as c', 'c.id', 't.cliente_id')
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .whereNotNull('ft.descuento_id')
      .where('ft.descuento_monto_aplicado', '>', 0)
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])

    if (tipo) query.where('d.codigo', tipo)
    if (canal) query.where('ft.captacion_canal', canal)

    const rows = (await query
      .select(
        'ft.placa',
        Database.raw('DATE(ft.created_at) as fecha'),
        'ft.captacion_canal',
        'ft.tipo_vehiculo',
        'ft.total',
        'ft.total_sin_descuento',
        'ft.descuento_monto_aplicado',
        'd.codigo as descuento_codigo',
        'd.nombre as descuento_nombre',
        'ft.agente_comercial_nombre',
        'ft.asesor_convenio_nombre',
        'ft.convenio_nombre',
        Database.raw(`CONCAT(u.nombres, ' ', u.apellidos) as autorizador_nombre`),
        'c.nombre as cliente_nombre',
        'c.doc_numero as cliente_documento'
      )
      .orderBy('ft.created_at', 'desc')) as any[]

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      captacion_canal: r.captacion_canal,
      tipo_vehiculo: r.tipo_vehiculo ?? null,
      total: Number(r.total) || 0,
      total_sin_descuento: Number(r.total_sin_descuento) || 0,
      descuento_monto_aplicado: Number(r.descuento_monto_aplicado) || 0,
      descuento_codigo: r.descuento_codigo,
      descuento_nombre: r.descuento_nombre,
      agente_comercial_nombre: r.agente_comercial_nombre ?? null,
      asesor_convenio_nombre: r.asesor_convenio_nombre ?? null,
      convenio_nombre: r.convenio_nombre ?? null,
      autorizador_nombre: r.autorizador_nombre ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totalDescuentos = detalle.reduce((acc, d) => acc + d.descuento_monto_aplicado, 0)

    return {
      filtros: { tipo, canal },
      total_vehiculos: detalle.length,
      total_descuentos: totalDescuentos,
      detalle,
    }
  }

  /**
   * GET /reportes-admin/comisiones?fecha_inicio=&fecha_fin=&estado=
   * 3 tabs con datos ya agrupados por el tipo de fila que necesita cada uno:
   *  - comerciales: asesor tipo ASESOR_COMERCIAL, agrupado por asesor
   *  - asesores_convenio: asesor tipo ASESOR_CONVENIO, agrupado por asesor+convenio
   *  - convenios: agrupado por convenio+asesor, SOLO asesor comercial (los de
   *    ASESOR_CONVENIO ya están en asesores_convenio, no se duplican aquí)
   *
   * El `estado` filtra las 3 tablas de tabs, pero NUNCA el resumen/KPIs
   * (resumen.por_estado se calcula siempre sobre el rango completo, sin
   * filtrar por estado, para que los 4 KPIs se mantengan globales).
   */
  public async reporteComisiones({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const estado = (request.input('estado') as string | undefined) || null

    // ===== KPIs globales (siempre sin filtro de estado) =====
    const resumenRows = (await Database.from('comisiones')
      .where('es_config', false)
      .where('tipo_servicio', 'RTM')
      .whereRaw('DATE(fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('estado')
      .count('* as cantidad')
      .sum('monto as monto')
      .groupBy('estado')) as any[]

    const porEstado: Record<string, { cantidad: number; monto: number }> = {
      PENDIENTE: { cantidad: 0, monto: 0 },
      APROBADA: { cantidad: 0, monto: 0 },
      PAGADA: { cantidad: 0, monto: 0 },
      ANULADA: { cantidad: 0, monto: 0 },
    }
    let totalComisiones = 0
    let totalMonto = 0
    for (const r of resumenRows) {
      const cantidad = Number(r.cantidad)
      const monto = Number(r.monto) || 0
      porEstado[r.estado] = { cantidad, monto }
      totalComisiones += cantidad
      totalMonto += monto
    }

    // ===== Tab 1: Asesor Comercial =====
    const qComerciales = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .where('c.es_config', false)
      .where('c.tipo_servicio', 'RTM')
      .where('a.tipo', 'ASESOR_COMERCIAL')
      .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
    if (estado) qComerciales.where('c.estado', estado)

    const comercialesRows = (await qComerciales
      .select('a.id as asesor_id', 'a.nombre as asesor_nombre')
      .select(Database.raw('GROUP_CONCAT(DISTINCT c.estado) as estados'))
      .count('* as cantidad_vehiculos')
      .sum('c.monto_asesor as total_asesor')
      .groupBy('a.id', 'a.nombre')
      .orderBy('total_asesor', 'desc')) as any[]

    const comerciales = comercialesRows.map((r) => ({
      asesor_id: Number(r.asesor_id),
      asesor_nombre: r.asesor_nombre,
      cantidad_vehiculos: Number(r.cantidad_vehiculos),
      total_asesor: Number(r.total_asesor) || 0,
      estados: String(r.estados ?? ''),
    }))

    // ===== Tab 2: Asesor Convenio =====
    const qAsesoresConvenio = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .leftJoin('convenios as conv', 'conv.id', 'c.convenio_id')
      .where('c.es_config', false)
      .where('c.tipo_servicio', 'RTM')
      .where('a.tipo', 'ASESOR_CONVENIO')
      .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
    if (estado) qAsesoresConvenio.where('c.estado', estado)

    const asesoresConvenioRows = (await qAsesoresConvenio
      .select('a.id as asesor_id', 'a.nombre as asesor_nombre', 'conv.nombre as convenio_nombre')
      .select(Database.raw('GROUP_CONCAT(DISTINCT c.estado) as estados'))
      .count('* as cantidad_vehiculos')
      .sum('c.monto_asesor as total_asesor')
      .sum('c.monto_convenio as total_convenio')
      .sum('c.monto as total_comision')
      .groupBy('a.id', 'a.nombre', 'conv.id', 'conv.nombre')
      .orderBy('total_comision', 'desc')) as any[]

    const asesoresConvenio = asesoresConvenioRows.map((r) => ({
      asesor_id: Number(r.asesor_id),
      asesor_nombre: r.asesor_nombre,
      convenio_nombre: r.convenio_nombre ?? null,
      cantidad_vehiculos: Number(r.cantidad_vehiculos),
      total_asesor: Number(r.total_asesor) || 0,
      total_convenio: Number(r.total_convenio) || 0,
      total_comision: Number(r.total_comision) || 0,
      estados: String(r.estados ?? ''),
    }))

    // ===== Tab 3: Convenio (solo asesor comercial referenciando un convenio —
    // los asesores tipo ASESOR_CONVENIO ya están en el Tab 2, no se duplican aquí) =====
    const qConvenios = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .join('convenios as conv', 'conv.id', 'c.convenio_id')
      .where('c.es_config', false)
      .where('c.tipo_servicio', 'RTM')
      .where('a.tipo', 'ASESOR_COMERCIAL')
      .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
    if (estado) qConvenios.where('c.estado', estado)

    const conveniosRows = (await qConvenios
      .select(
        'conv.id as convenio_id',
        'conv.nombre as convenio_nombre',
        'a.nombre as asesor_comercial_nombre'
      )
      .select(Database.raw('GROUP_CONCAT(DISTINCT c.estado) as estados'))
      .count('* as cantidad_vehiculos')
      .sum('c.monto_convenio as total_convenio')
      .groupBy('conv.id', 'conv.nombre', 'a.id', 'a.nombre')
      .orderBy('total_convenio', 'desc')) as any[]

    const convenios = conveniosRows.map((r) => ({
      convenio_id: Number(r.convenio_id),
      convenio_nombre: r.convenio_nombre,
      asesor_comercial_nombre: r.asesor_comercial_nombre,
      cantidad_vehiculos: Number(r.cantidad_vehiculos),
      total_convenio: Number(r.total_convenio) || 0,
      estados: String(r.estados ?? ''),
    }))

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      resumen: {
        total_comisiones: totalComisiones,
        total_monto: totalMonto,
        por_estado: porEstado,
      },
      comerciales,
      asesores_convenio: asesoresConvenio,
      convenios,
    }
  }

  /**
   * GET /reportes-admin/detalle-comisiones?fecha_inicio=&fecha_fin=&asesor_id=|convenio_id=&estado=
   * Drill-down por placa. Acepta asesor_id (tabs Asesor Comercial / Asesor
   * Convenio) o convenio_id (tab Convenio) — se requiere al menos uno.
   * `estado` es opcional: si se omite (caso normal del drill-down) trae
   * todas las placas del rango sin filtrar, para que el usuario vea el
   * estado real de cada una (incluye filas "Mixto" en las tablas resumen).
   *
   * `tipo_cliente` no es una columna de `comisiones` — se deriva del turno
   * vinculado (mismo criterio que /reportes-admin/retencion). `tipo_comision`
   * no existe como columna en ningún lado del esquema ni se usa en el
   * frontend, así que no se agrega (evita inventar un dato falso).
   */
  public async detalleComisiones({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const asesorIdRaw = request.input('asesor_id') as string | number | undefined
    const convenioIdRaw = request.input('convenio_id') as string | number | undefined
    const asesorId = asesorIdRaw ? Number(asesorIdRaw) : null
    const convenioId = convenioIdRaw ? Number(convenioIdRaw) : null

    if (!asesorId && !convenioId) {
      return response.badRequest({ message: 'asesor_id o convenio_id es requerido' })
    }

    const estado = (request.input('estado') as string | undefined) || null

    const query = Database.from('comisiones as c')
      .join('captacion_dateos as cd', 'cd.id', 'c.captacion_dateo_id')
      .join('turnos_rtms as t', 't.id', 'cd.consumido_turno_id')
      .join('agentes_captacions as ag', 'ag.id', 'c.asesor_id')
      .leftJoin('convenios as conv', 'conv.id', 'c.convenio_id')
      .leftJoin('clientes as cl', 'cl.id', 't.cliente_id')
      .where('c.es_config', false)
      .where('c.tipo_servicio', 'RTM')
      .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])

    if (asesorId) query.where('c.asesor_id', asesorId)
    if (convenioId) query.where('c.convenio_id', convenioId)
    if (estado) query.where('c.estado', estado)

    const rows = (await query
      .select(
        't.placa',
        Database.raw('DATE(c.fecha_calculo) as fecha'),
        'ag.nombre as asesor_nombre',
        'c.estado',
        'c.monto_asesor',
        'c.monto_convenio',
        'c.monto as total_comision',
        'conv.nombre as convenio_nombre',
        'c.pagado_at',
        Database.raw(`
          CASE
            WHEN t.meses_desde_ultima_visita IS NULL THEN 'NUEVO'
            WHEN t.es_recurrente = 1 THEN 'RECURRENTE'
            WHEN t.es_recuperacion = 1 THEN 'RECUPERACION'
            ELSE 'NUEVO'
          END as tipo_cliente
        `),
        'cl.nombre as cliente_nombre',
        'cl.doc_numero as cliente_documento'
      )
      .orderBy('c.fecha_calculo', 'desc')) as any[]

    const asesor = asesorId ? await AgenteCaptacion.find(asesorId) : null
    const convenio = convenioId ? await Convenio.find(convenioId) : null

    const detalle = rows.map((r) => ({
      placa: r.placa,
      fecha: r.fecha,
      asesor_nombre: r.asesor_nombre,
      estado: r.estado,
      monto_asesor: Number(r.monto_asesor) || 0,
      monto_convenio: Number(r.monto_convenio) || 0,
      total_comision: Number(r.total_comision) || 0,
      convenio_nombre: r.convenio_nombre ?? null,
      tipo_cliente: r.tipo_cliente ?? null,
      pagado_at: r.pagado_at ?? null,
      cliente_nombre: r.cliente_nombre ?? null,
      cliente_documento: r.cliente_documento ?? null,
    }))

    const totales = detalle.reduce(
      (acc, d) => ({
        total_asesor: acc.total_asesor + d.monto_asesor,
        total_convenio: acc.total_convenio + d.monto_convenio,
        total_comision: acc.total_comision + d.total_comision,
      }),
      { total_asesor: 0, total_convenio: 0, total_comision: 0 }
    )

    return {
      asesor_id: asesorId,
      asesor_nombre: asesor?.nombre ?? null,
      convenio_id: convenioId,
      convenio_nombre: convenio?.nombre ?? null,
      total_vehiculos: detalle.length,
      total_asesor: totales.total_asesor,
      total_convenio: totales.total_convenio,
      total_comision: totales.total_comision,
      detalle,
    }
  }

  /**
   * Construye las 3 secciones de desglose individual (Asesor Comercial,
   * Asesor Convenio, Convenio) sobre `comisiones`. Es la misma agregación
   * que usa reporteComisiones(), parametrizada para poder:
   *  - filtrar por tipoServicio (ej. 'RTM' para el modal de Liquidación),
   *    sin afectar a reporteComisiones() que sigue trayendo todos los
   *    servicios (no se le pasa este parámetro).
   *  - opcionalmente exponer los ids de comisión de cada fila
   *    (comision_ids / comision_ids_pagables), necesarios para poder
   *    seleccionar y pagar puntualmente desde el modal de Liquidación.
   *    reporteComisiones() no pide esto (incluirIds=false) para no crecer
   *    el payload de un reporte de solo lectura que ya se usa para exportar.
   */
  private async buildDesgloseComisiones(opts: {
    fechaInicio: string
    fechaFin: string
    estado: string | null
    tipoServicio?: string
    incluirIds?: boolean
  }) {
    const { fechaInicio, fechaFin, estado, tipoServicio, incluirIds } = opts

    const aplicarFiltrosComunes = (q: ReturnType<typeof Database.from>) => {
      q.where('c.es_config', false).whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [
        fechaInicio,
        fechaFin,
      ])
      if (tipoServicio) q.where('c.tipo_servicio', tipoServicio)
      if (estado) q.where('c.estado', estado)
    }
    const idsSelect = incluirIds
      ? [
          Database.raw('GROUP_CONCAT(DISTINCT c.id) as comision_ids'),
          Database.raw(
            `GROUP_CONCAT(DISTINCT CASE WHEN c.estado IN ('PENDIENTE','APROBADA') THEN c.id END) as comision_ids_pagables`
          ),
          // Monto real a pagar de esta fila: solo la porción PENDIENTE/APROBADA,
          // NO el total_asesor/total_convenio de la fila (que incluye también
          // lo ya PAGADA/ANULADA). Mismo criterio que calcTotalItem() en el
          // frontend (monto_asesor + monto_convenio = monto).
          Database.raw(
            `SUM(CASE WHEN c.estado IN ('PENDIENTE','APROBADA') THEN c.monto ELSE 0 END) as monto_pagable`
          ),
        ]
      : []

    // ===== Asesor Comercial =====
    const qComerciales = Database.from('comisiones as c').join(
      'agentes_captacions as a',
      'a.id',
      'c.asesor_id'
    )
    aplicarFiltrosComunes(qComerciales)
    qComerciales.where('a.tipo', 'ASESOR_COMERCIAL')

    const comercialesRows = (await qComerciales
      .select('a.id as asesor_id', 'a.nombre as asesor_nombre')
      .select(Database.raw('GROUP_CONCAT(DISTINCT c.estado) as estados'))
      .select(...idsSelect)
      .count('* as cantidad_vehiculos')
      .sum('c.monto_asesor as total_asesor')
      .groupBy('a.id', 'a.nombre')
      .orderBy('total_asesor', 'desc')) as any[]

    const comerciales = comercialesRows.map((r) => ({
      asesor_id: Number(r.asesor_id),
      asesor_nombre: r.asesor_nombre,
      cantidad_vehiculos: Number(r.cantidad_vehiculos),
      total_asesor: Number(r.total_asesor) || 0,
      estados: String(r.estados ?? ''),
      ...(incluirIds
        ? {
            comision_ids: parseIdList(r.comision_ids),
            comision_ids_pagables: parseIdList(r.comision_ids_pagables),
            monto_pagable: Number(r.monto_pagable) || 0,
          }
        : {}),
    }))

    // ===== Asesor Convenio =====
    const qAsesoresConvenio = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .leftJoin('convenios as conv', 'conv.id', 'c.convenio_id')
    aplicarFiltrosComunes(qAsesoresConvenio)
    qAsesoresConvenio.where('a.tipo', 'ASESOR_CONVENIO')

    const asesoresConvenioRows = (await qAsesoresConvenio
      .select('a.id as asesor_id', 'a.nombre as asesor_nombre', 'conv.nombre as convenio_nombre')
      .select(Database.raw('GROUP_CONCAT(DISTINCT c.estado) as estados'))
      .select(...idsSelect)
      .count('* as cantidad_vehiculos')
      .sum('c.monto_asesor as total_asesor')
      .sum('c.monto_convenio as total_convenio')
      .sum('c.monto as total_comision')
      .groupBy('a.id', 'a.nombre', 'conv.id', 'conv.nombre')
      .orderBy('total_comision', 'desc')) as any[]

    const asesoresConvenio = asesoresConvenioRows.map((r) => ({
      asesor_id: Number(r.asesor_id),
      asesor_nombre: r.asesor_nombre,
      convenio_nombre: r.convenio_nombre ?? null,
      cantidad_vehiculos: Number(r.cantidad_vehiculos),
      total_asesor: Number(r.total_asesor) || 0,
      total_convenio: Number(r.total_convenio) || 0,
      total_comision: Number(r.total_comision) || 0,
      estados: String(r.estados ?? ''),
      ...(incluirIds
        ? {
            comision_ids: parseIdList(r.comision_ids),
            comision_ids_pagables: parseIdList(r.comision_ids_pagables),
            monto_pagable: Number(r.monto_pagable) || 0,
          }
        : {}),
    }))

    // ===== Convenio (solo asesor comercial referenciando un convenio —
    // los asesores tipo ASESOR_CONVENIO ya están arriba, no se duplican) =====
    const qConvenios = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .join('convenios as conv', 'conv.id', 'c.convenio_id')
    aplicarFiltrosComunes(qConvenios)
    qConvenios.where('a.tipo', 'ASESOR_COMERCIAL')

    const conveniosRows = (await qConvenios
      .select(
        'conv.id as convenio_id',
        'conv.nombre as convenio_nombre',
        'a.nombre as asesor_comercial_nombre'
      )
      .select(Database.raw('GROUP_CONCAT(DISTINCT c.estado) as estados'))
      .select(...idsSelect)
      .count('* as cantidad_vehiculos')
      .sum('c.monto_convenio as total_convenio')
      .groupBy('conv.id', 'conv.nombre', 'a.id', 'a.nombre')
      .orderBy('total_convenio', 'desc')) as any[]

    const convenios = conveniosRows.map((r) => ({
      convenio_id: Number(r.convenio_id),
      convenio_nombre: r.convenio_nombre,
      asesor_comercial_nombre: r.asesor_comercial_nombre,
      cantidad_vehiculos: Number(r.cantidad_vehiculos),
      total_convenio: Number(r.total_convenio) || 0,
      estados: String(r.estados ?? ''),
      ...(incluirIds
        ? {
            comision_ids: parseIdList(r.comision_ids),
            comision_ids_pagables: parseIdList(r.comision_ids_pagables),
            monto_pagable: Number(r.monto_pagable) || 0,
          }
        : {}),
    }))

    return { comerciales, asesoresConvenio, convenios }
  }

  /**
   * GET /reportes-admin/liquidacion-rtm?fecha_inicio=&fecha_fin=
   * Modal de Liquidación RTM (ComisionesList.vue → botón "Liquidar"):
   * comisiones de tipo_servicio='RTM' únicamente, con:
   *  - resumen general del periodo,
   *  - desglose por canal de captación (captacion_dateos.canal: FACHADA,
   *    ASESOR_COMERCIAL, ASESOR_CONVENIO, TELE, REDES) con cantidad/monto/%,
   *  - las mismas 3 secciones individuales de reporteComisiones() pero
   *    filtradas a RTM y con los ids de comisión expuestos (comision_ids /
   *    comision_ids_pagables) para habilitar selección y pago puntual.
   */
  /**
   * Facturación REAL por canal de captación para turnos RTM confirmados en
   * un rango (facturacion_tickets, NO comisiones). A diferencia del
   * desglose de comisiones, esto SI incluye FACHADA/TELE/REDES: turnos sin
   * asesor comercial/convenio asociado no generan fila en `comisiones`
   * (monto $0 ahí), pero SI generaron dinero real cobrado al cliente en
   * facturacion_tickets. Mismo patrón/fuente que ingresosPorCanal(), acotado
   * a servicio_codigo='RTM'. El % es sobre el total facturado del propio
   * desglose (no sobre el resumen de comisiones, que es otra fuente).
   */
  private async buildPorCanalFacturacionRtm(fechaInicio: string, fechaFin: string) {
    const rows = (await Database.from('facturacion_tickets as ft')
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select(Database.raw("COALESCE(ft.captacion_canal, 'FACHADA') as canal"))
      .count('* as cantidad')
      .sum('ft.total as monto')
      .groupByRaw("COALESCE(ft.captacion_canal, 'FACHADA')")
      .orderBy('monto', 'desc')) as any[]

    const totalMonto = rows.reduce((acc, r) => acc + (Number(r.monto) || 0), 0)

    const porCanal = rows.map((r) => {
      const monto = Number(r.monto) || 0
      return {
        canal: r.canal,
        cantidad: Number(r.cantidad),
        monto,
        porcentaje: totalMonto > 0 ? Number(((monto / totalMonto) * 100).toFixed(2)) : 0,
      }
    })

    return { porCanal, totalMonto }
  }

  /** Cálculo compartido por liquidacionRtm() (JSON) y liquidacionRtmExcel() (.xlsx). */
  private async computeLiquidacionRtmData(fechaInicio: string, fechaFin: string) {
    // ===== Resumen general (solo RTM, basado en comisiones — sin cambios) =====
    const resumenRows = (await Database.from('comisiones')
      .where('es_config', false)
      .where('tipo_servicio', 'RTM')
      .whereRaw('DATE(fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .count('* as cantidad')
      .sum('monto as monto')
      .first()) as any

    const totalComisiones = Number(resumenRows?.cantidad) || 0
    const totalMonto = Number(resumenRows?.monto) || 0

    // ===== Por canal de captación (facturación real, incluye FACHADA/TELE/REDES) =====
    const { porCanal } = await this.buildPorCanalFacturacionRtm(fechaInicio, fechaFin)

    // ===== 3 secciones individuales, filtradas a RTM, con ids =====
    const { comerciales, asesoresConvenio, convenios } = await this.buildDesgloseComisiones({
      fechaInicio,
      fechaFin,
      estado: null,
      tipoServicio: 'RTM',
      incluirIds: true,
    })

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      resumen: { total_comisiones: totalComisiones, total_monto: totalMonto },
      por_canal: porCanal,
      comerciales,
      asesores_convenio: asesoresConvenio,
      convenios,
    }
  }

  public async liquidacionRtm({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeLiquidacionRtmData(fechaInicio, fechaFin)
  }

  /** GET /reportes-admin/liquidacion-rtm/excel?fecha_inicio=&fecha_fin= */
  public async liquidacionRtmExcel({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const data = await this.computeLiquidacionRtmData(fechaInicio, fechaFin)
    const buffer = await this.buildLiquidacionWorkbookBuffer(data, 'Total generado RTM en el período')

    const fileName = `Liquidacion_RTM_${fechaInicio}_${fechaFin}.xlsx`
    response.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    response.header('Content-Disposition', `attachment; filename="${fileName}"`)
    return response.send(buffer)
  }

  /**
   * GET /reportes-admin/historial-liquidaciones?page=&per_page=&fecha_inicio=&fecha_fin=
   * Lista paginada de eventos de liquidación (cabecera de cada pago
   * ejecutado, desde cualquiera de los 3 orígenes). El filtro de fecha
   * opcional aplica sobre la fecha en que se ejecutó el pago (created_at),
   * no sobre el período cubierto por las comisiones pagadas.
   */
  public async historialLiquidaciones({ request }: HttpContext) {
    const page = Math.max(1, Number(request.input('page', 1)) || 1)
    const perPage = Math.min(100, Math.max(1, Number(request.input('per_page', 20)) || 20))
    const fechaInicio = request.input('fecha_inicio') as string | undefined
    const fechaFin = request.input('fecha_fin') as string | undefined

    const query = Liquidacion.query().preload('usuario').orderBy('created_at', 'desc')

    if (fechaInicio && fechaFin) {
      query.whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
    }

    const paginated = await query.paginate(page, perPage)
    const meta = paginated.getMeta()
    const data = paginated.all().map((l) => ({
      id: l.id,
      fecha_evento: l.createdAt.toISODate(),
      fecha_inicio: l.fechaInicio.toISODate(),
      fecha_fin: l.fechaFin.toISODate(),
      tipo_origen: l.tipoOrigen,
      tipo_periodo: l.tipoPeriodo,
      monto_total: Number(l.montoTotal),
      cantidad_comisiones: l.cantidadComisiones,
      usuario: l.usuario ? `${l.usuario.nombres} ${l.usuario.apellidos}`.trim() : null,
    }))

    return {
      data,
      total: meta.total,
      page: meta.currentPage,
      perPage: meta.perPage,
    }
  }

  /**
   * GET /reportes-admin/historial-liquidaciones/:id
   * Detalle de comisiones incluidas en un evento de liquidación puntual
   * (para la fila expandible del historial).
   */
  public async historialLiquidacionDetalle({ params, response }: HttpContext) {
    const liquidacion = await Liquidacion.query()
      .where('id', params.id)
      .preload('usuario')
      .first()
    if (!liquidacion) return response.notFound({ message: 'Liquidación no encontrada' })

    const detalle = (await Database.from('liquidacion_detalle as ld')
      .join('comisiones as c', 'c.id', 'ld.comision_id')
      .leftJoin('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .leftJoin('convenios as conv', 'conv.id', 'c.convenio_id')
      .where('ld.liquidacion_id', params.id)
      .select(
        'c.id as comision_id',
        'c.tipo_vehiculo',
        'c.fecha_calculo',
        'c.estado',
        'a.nombre as asesor_nombre',
        'conv.nombre as convenio_nombre',
        'ld.monto'
      )
      .orderBy('c.fecha_calculo', 'asc')) as any[]

    return {
      liquidacion: {
        id: liquidacion.id,
        fecha_evento: liquidacion.createdAt.toISODate(),
        fecha_inicio: liquidacion.fechaInicio.toISODate(),
        fecha_fin: liquidacion.fechaFin.toISODate(),
        tipo_origen: liquidacion.tipoOrigen,
        tipo_periodo: liquidacion.tipoPeriodo,
        monto_total: Number(liquidacion.montoTotal),
        cantidad_comisiones: liquidacion.cantidadComisiones,
        usuario: liquidacion.usuario
          ? `${liquidacion.usuario.nombres} ${liquidacion.usuario.apellidos}`.trim()
          : null,
      },
      detalle: detalle.map((d) => ({
        comision_id: Number(d.comision_id),
        tipo_vehiculo: d.tipo_vehiculo,
        fecha_calculo: d.fecha_calculo,
        estado: d.estado,
        asesor_nombre: d.asesor_nombre ?? null,
        convenio_nombre: d.convenio_nombre ?? null,
        monto: Number(d.monto) || 0,
      })),
    }
  }

  /**
   * GET /reportes-admin/historial-liquidaciones/excel?fecha_inicio=&fecha_fin=
   * Exporta TODOS los eventos que cumplan el filtro (sin paginar — a
   * diferencia de historialLiquidaciones(), que sí pagina para la tabla en
   * pantalla).
   */
  public async historialLiquidacionesExcel({ request, response }: HttpContext) {
    const fechaInicio = request.input('fecha_inicio') as string | undefined
    const fechaFin = request.input('fecha_fin') as string | undefined

    const query = Liquidacion.query().preload('usuario').orderBy('created_at', 'desc')
    if (fechaInicio && fechaFin) {
      query.whereRaw('DATE(created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
    }
    const rows = await query

    const ORIGEN_LABELS: Record<string, string> = {
      MODAL_LIQUIDAR: 'Modal Liquidar',
      TABLA_GENERAL: 'Tabla general',
      PANEL_ASESOR: 'Panel por asesor',
    }

    const workbook = new ExcelJS.Workbook()
    const ws = workbook.addWorksheet('Historial de Liquidaciones')
    ws.columns = [{ width: 14 }, { width: 18 }, { width: 12 }, { width: 16 }, { width: 22 }, { width: 26 }]
    ws.addRow(['Fecha', 'Origen', 'Periodo', 'Monto total', 'Cantidad de comisiones', 'Usuario']).font = {
      bold: true,
    }

    rows.forEach((l) => {
      ws.addRow([
        l.createdAt.toISODate() ?? '',
        ORIGEN_LABELS[l.tipoOrigen] ?? l.tipoOrigen,
        l.tipoPeriodo ?? '—',
        Number(l.montoTotal),
        l.cantidadComisiones,
        l.usuario ? `${l.usuario.nombres} ${l.usuario.apellidos}`.trim() : '—',
      ])
    })

    const buffer = await workbook.xlsx.writeBuffer()
    const fileName = `Historial_Liquidaciones_${DateTime.now().toISODate()}.xlsx`
    response.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    response.header('Content-Disposition', `attachment; filename="${fileName}"`)
    return response.send(buffer)
  }

  /**
   * GET /reportes-admin/trazabilidad-rtm?fecha_inicio=&fecha_fin=
   * Trazabilidad histórica agregada, SOLO sobre comisiones RTM en estado
   * PAGADA (no pendiente/aprobada), para rangos largos (3-5 meses, año en
   * curso, o manual). Reutiliza buildDesgloseComisiones con estado fijo
   * en 'PAGADA' — mismas 3 secciones que el modal de Liquidación RTM.
   */
  /** Cálculo compartido por trazabilidadRtm() (JSON) y trazabilidadRtmExcel() (.xlsx). */
  private async computeTrazabilidadRtmData(fechaInicio: string, fechaFin: string) {
    const resumenRow = (await Database.from('comisiones')
      .where('es_config', false)
      .where('tipo_servicio', 'RTM')
      .where('estado', 'PAGADA')
      .whereRaw('DATE(fecha_calculo) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .count('* as cantidad')
      .sum('monto as monto')
      .first()) as any

    const { comerciales, asesoresConvenio, convenios } = await this.buildDesgloseComisiones({
      fechaInicio,
      fechaFin,
      estado: 'PAGADA',
      tipoServicio: 'RTM',
      incluirIds: false,
    })

    // Por canal de captación: facturación REAL generada (facturacion_tickets),
    // SIN filtrar por estado de comisión — a diferencia de las 3 secciones de
    // arriba, que sí filtran solo lo PAGADA. Por eso el frontend lo etiqueta
    // como "generado" en vez de "pagado".
    const { porCanal } = await this.buildPorCanalFacturacionRtm(fechaInicio, fechaFin)

    return {
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      resumen: {
        total_comisiones: Number(resumenRow?.cantidad) || 0,
        total_monto: Number(resumenRow?.monto) || 0,
      },
      por_canal: porCanal,
      comerciales,
      asesores_convenio: asesoresConvenio,
      convenios,
    }
  }

  public async trazabilidadRtm({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeTrazabilidadRtmData(fechaInicio, fechaFin)
  }

  /** GET /reportes-admin/trazabilidad-rtm/excel?fecha_inicio=&fecha_fin= */
  public async trazabilidadRtmExcel({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const data = await this.computeTrazabilidadRtmData(fechaInicio, fechaFin)
    const buffer = await this.buildLiquidacionWorkbookBuffer(data, 'Total pagado RTM en el rango')

    const fileName = `Trazabilidad_RTM_${fechaInicio}_${fechaFin}.xlsx`
    response.header(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    )
    response.header('Content-Disposition', `attachment; filename="${fileName}"`)
    return response.send(buffer)
  }

  /**
   * Excel de una sola hoja con las secciones apiladas (título, resumen, por
   * canal, y las 3 secciones de comisiones), compartido por liquidacionRtm y
   * trazabilidadRtm — mismo layout que ya usan ambas vistas en pantalla.
   * Usa exceljs (ya instalado y usado en turnos_rtms_controller.ts) porque a
   * diferencia de 'xlsx' (SheetJS community, usado en el frontend), sí
   * soporta escribir negrita real en las celdas.
   */
  private async buildLiquidacionWorkbookBuffer(
    data: {
      fecha_inicio: string
      fecha_fin: string
      resumen: { total_comisiones: number; total_monto: number }
      por_canal: { canal: string; cantidad: number; monto: number; porcentaje: number }[]
      comerciales: { asesor_nombre: string; cantidad_vehiculos: number; total_asesor: number; estados: string }[]
      asesores_convenio: {
        asesor_nombre: string
        convenio_nombre: string | null
        cantidad_vehiculos: number
        total_asesor: number
        total_convenio: number
        estados: string
      }[]
      convenios: {
        convenio_nombre: string
        asesor_comercial_nombre: string
        cantidad_vehiculos: number
        total_convenio: number
        estados: string
      }[]
    },
    tituloTotal: string
  ) {
    const CANAL_LABELS: Record<string, string> = {
      FACHADA: 'Fachada',
      ASESOR_COMERCIAL: 'Asesor Comercial',
      ASESOR_CONVENIO: 'Asesor Convenio',
      TELE: 'Telemercadeo',
      TELEMERCADEO: 'Telemercadeo',
      REDES: 'Redes / Marketing Digital',
    }

    const workbook = new ExcelJS.Workbook()
    const ws = workbook.addWorksheet('Liquidación RTM')
    ws.columns = [{ width: 34 }, { width: 26 }, { width: 16 }, { width: 16 }, { width: 16 }, { width: 26 }]

    const seccion = (titulo: string) => {
      ws.addRow([titulo]).font = { bold: true }
    }
    const encabezadoFila = (valores: (string | number)[]) => {
      ws.addRow(valores).font = { bold: true }
    }

    ws.addRow([`Liquidación RTM — ${data.fecha_inicio} a ${data.fecha_fin}`]).font = { bold: true, size: 13 }
    ws.addRow([])

    seccion('Resumen general')
    ws.addRow([tituloTotal, data.resumen.total_monto])
    ws.addRow(['Cantidad de comisiones', data.resumen.total_comisiones])
    ws.addRow([])

    seccion('Por canal de captación')
    encabezadoFila(['Canal', 'Turnos', 'Monto', '%'])
    data.por_canal.forEach((c) => ws.addRow([CANAL_LABELS[c.canal] ?? c.canal, c.cantidad, c.monto, c.porcentaje]))
    ws.addRow([])

    seccion('Asesores Comerciales')
    encabezadoFila(['Asesor', 'Turnos', 'Monto', 'Estados'])
    data.comerciales.forEach((r) => ws.addRow([r.asesor_nombre, r.cantidad_vehiculos, r.total_asesor, r.estados]))
    ws.addRow([])

    seccion('Asesores Convenio')
    encabezadoFila(['Asesor', 'Convenio', 'Turnos', 'Monto asesor', 'Monto convenio', 'Estados'])
    data.asesores_convenio.forEach((r) =>
      ws.addRow([
        r.asesor_nombre,
        r.convenio_nombre ?? '—',
        r.cantidad_vehiculos,
        r.total_asesor,
        r.total_convenio,
        r.estados,
      ])
    )
    ws.addRow([])

    seccion('Convenios')
    encabezadoFila(['Convenio', 'Asesor comercial', 'Turnos', 'Monto convenio', 'Estados'])
    data.convenios.forEach((r) =>
      ws.addRow([r.convenio_nombre, r.asesor_comercial_nombre, r.cantidad_vehiculos, r.total_convenio, r.estados])
    )

    return await workbook.xlsx.writeBuffer()
  }

  /* ======================== META MENSUAL ======================== */

  private parseMesAnio(request: HttpContext['request']): {
    mes: number
    anio: number
    error?: string
  } {
    const now = DateTime.now()
    const mes = Number(request.input('mes', now.month))
    const anio = Number(request.input('anio', now.year))

    if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
      return { mes: 0, anio: 0, error: 'mes inválido (1-12)' }
    }
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
      return { mes: 0, anio: 0, error: 'anio inválido' }
    }
    return { mes, anio }
  }

  /**
   * GET /reportes-admin/meta-mensual/config?mes=&anio=
   * Config del mes consultado (default: mes/año actual). Crea la fila con
   * metas en 0 si aún no existe (mismo patrón que las config singleton).
   */
  public async metaMensualConfigGet({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const config = await obtenerOCrearConfigMensual(mes, anio)

    return response.ok({
      mes: config.mes,
      anio: config.anio,
      meta_livianos: config.metaLivianos,
      meta_motos: config.metaMotos,
      meta_total: config.metaLivianos + config.metaMotos,
      pct_crecimiento_referencia: Number(config.pctCrecimientoReferencia),
    })
  }

  /**
   * POST /reportes-admin/meta-mensual/config
   * body: { mes, anio, meta_livianos, meta_motos, pct_crecimiento_referencia }
   * Upsert por (mes, anio) — crea o actualiza la fila de ese mes.
   */
  public async metaMensualConfigUpsert({ request, response }: HttpContext) {
    const payload = request.only([
      'mes',
      'anio',
      'meta_livianos',
      'meta_motos',
      'pct_crecimiento_referencia',
    ])

    const mes = Number(payload.mes)
    const anio = Number(payload.anio)
    if (!Number.isInteger(mes) || mes < 1 || mes > 12) {
      return response.badRequest({ message: 'mes inválido (1-12)' })
    }
    if (!Number.isInteger(anio) || anio < 2000 || anio > 2100) {
      return response.badRequest({ message: 'anio inválido' })
    }

    const metaLivianos = Math.max(0, Math.trunc(Number(payload.meta_livianos) || 0))
    const metaMotos = Math.max(0, Math.trunc(Number(payload.meta_motos) || 0))
    const pctCrecimientoReferencia = Number(payload.pct_crecimiento_referencia) || 0

    let config = await ConfiguracionMetaMensual.query()
      .where('mes', mes)
      .where('anio', anio)
      .first()

    if (!config) {
      config = new ConfiguracionMetaMensual()
      config.mes = mes
      config.anio = anio
    }
    config.metaLivianos = metaLivianos
    config.metaMotos = metaMotos
    config.pctCrecimientoReferencia = pctCrecimientoReferencia
    await config.save()

    return response.ok({
      mes: config.mes,
      anio: config.anio,
      meta_livianos: config.metaLivianos,
      meta_motos: config.metaMotos,
      meta_total: config.metaLivianos + config.metaMotos,
      pct_crecimiento_referencia: Number(config.pctCrecimientoReferencia),
    })
  }

  /**
   * GET /reportes-admin/meta-mensual/resumen?mes=&anio=
   * KPIs (Total General, Livianos, Motos, Proyección de cierre) + semáforo
   * general y por pestaña.
   *
   * Semáforos — regla no especificada por negocio, asunción documentada:
   *   - "meta" usa avance acumulado / meta total (cuánto se lleva vs falta,
   *     tal como se muestra en la pestaña Meta).
   *   - "diario" y "semanal" usan el RITMO: avance acumulado / meta
   *     prorateada a la fecha (avance vs. donde deberíamos ir hoy si el
   *     ritmo fuera lineal) — así no marcan rojo todo el mes por defecto.
   *   - "general" y "proyectado" usan la proyección de cierre completa vs.
   *     la meta del mes.
   */
  public async metaMensualResumen({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const config = await obtenerOCrearConfigMensual(mes, anio)
    const metaLivianos = config.metaLivianos
    const metaMotos = config.metaMotos
    const metaTotal = metaLivianos + metaMotos

    const { dias, fuente } = await obtenerConteoDiarioConFallback(mes, anio)

    const now = DateTime.now()
    const esMesActual = mes === now.month && anio === now.year
    const diasDelMes = DateTime.fromObject({ year: anio, month: mes }).daysInMonth as number
    const diasTranscurridos = esMesActual ? now.day : diasDelMes
    const diasElapsed = dias.slice(0, Math.min(diasTranscurridos, dias.length))

    const avanceLivianos = diasElapsed.reduce((acc, d) => acc + d.livianos, 0)
    const avanceMotos = diasElapsed.reduce((acc, d) => acc + d.motos, 0)
    const avanceTotal = avanceLivianos + avanceMotos

    const promedioDiarioLivianos = diasTranscurridos > 0 ? avanceLivianos / diasTranscurridos : 0
    const promedioDiarioMotos = diasTranscurridos > 0 ? avanceMotos / diasTranscurridos : 0
    const proyeccionLivianos = Math.round(promedioDiarioLivianos * diasDelMes)
    const proyeccionMotos = Math.round(promedioDiarioMotos * diasDelMes)
    const proyeccionTotal = proyeccionLivianos + proyeccionMotos

    const pctProyeccionTotal = calcularPct(proyeccionTotal, metaTotal)
    const metaTotalProrateada = metaTotal * (diasTranscurridos / Math.max(1, diasDelMes))
    const pctRitmo = calcularPct(avanceTotal, Math.round(metaTotalProrateada))

    return response.ok({
      mes,
      anio,
      fuente_datos: fuente,
      dias_transcurridos: diasTranscurridos,
      dias_del_mes: diasDelMes,
      kpis: {
        total_general: {
          meta: metaTotal,
          avance: avanceTotal,
          pct_avance: calcularPct(avanceTotal, metaTotal),
          proyeccion_cierre: proyeccionTotal,
          pct_proyeccion: pctProyeccionTotal,
        },
        livianos: {
          meta: metaLivianos,
          avance: avanceLivianos,
          pct_avance: calcularPct(avanceLivianos, metaLivianos),
          proyeccion_cierre: proyeccionLivianos,
          pct_proyeccion: calcularPct(proyeccionLivianos, metaLivianos),
        },
        motos: {
          meta: metaMotos,
          avance: avanceMotos,
          pct_avance: calcularPct(avanceMotos, metaMotos),
          proyeccion_cierre: proyeccionMotos,
          pct_proyeccion: calcularPct(proyeccionMotos, metaMotos),
        },
      },
      semaforo: {
        general: calcularSemaforo(pctProyeccionTotal),
        diario: calcularSemaforo(pctRitmo),
        semanal: calcularSemaforo(pctRitmo),
        meta: calcularSemaforo(calcularPct(avanceTotal, metaTotal)),
        proyectado: calcularSemaforo(pctProyeccionTotal),
      },
    })
  }

  /**
   * GET /reportes-admin/meta-mensual/diario?mes=&anio=
   * Día a día del mes consultado: cantidad, acumulado, % vs meta, y
   * diferencia contra el mismo día del año anterior (real u histórico).
   */
  public async metaMensualDiario({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const config = await ConfiguracionMetaMensual.query()
      .where('mes', mes)
      .where('anio', anio)
      .first()
    const metaTotal = config ? config.metaLivianos + config.metaMotos : 0

    const { dias, fuente } = await obtenerConteoDiarioConFallback(mes, anio)
    const { dias: diasAnioAnterior, fuente: fuenteAnioAnterior } =
      await obtenerConteoDiarioConFallback(mes, anio - 1)

    const mapaAnioAnterior = new Map(diasAnioAnterior.map((d) => [d.fecha.slice(8, 10), d]))

    let acumuladoLivianos = 0
    let acumuladoMotos = 0

    const detalle = dias.map((d) => {
      acumuladoLivianos += d.livianos
      acumuladoMotos += d.motos
      const acumuladoTotal = acumuladoLivianos + acumuladoMotos

      const diaNum = d.fecha.slice(8, 10)
      const diaAnioAnterior = mapaAnioAnterior.get(diaNum)
      const totalAnioAnterior = diaAnioAnterior ? diaAnioAnterior.total : null

      return {
        fecha: d.fecha,
        livianos: d.livianos,
        motos: d.motos,
        total: d.total,
        acumulado_livianos: acumuladoLivianos,
        acumulado_motos: acumuladoMotos,
        acumulado_total: acumuladoTotal,
        pct_vs_meta: calcularPct(acumuladoTotal, metaTotal),
        total_anio_anterior: totalAnioAnterior,
        diferencia_vs_anio_anterior: totalAnioAnterior === null ? null : d.total - totalAnioAnterior,
      }
    })

    return response.ok({
      mes,
      anio,
      fuente_datos: fuente,
      fuente_datos_anio_anterior: fuenteAnioAnterior,
      meta_total: metaTotal,
      dias: detalle,
    })
  }

  /**
   * GET /reportes-admin/meta-mensual/semanal?mes=&anio=
   * Agrupa el mes en semanas sábado→viernes. Cada semana se compara
   * contra la meta TOTAL del mes (sin prorratear entre semanas), tanto
   * para livianos como para motos — igual que el Excel de referencia.
   * Las semanas que cruzan el límite del mes solo suman los días que
   * caen dentro del mes consultado.
   */
  public async metaMensualSemanal({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const config = await ConfiguracionMetaMensual.query()
      .where('mes', mes)
      .where('anio', anio)
      .first()
    const metaLivianos = config?.metaLivianos ?? 0
    const metaMotos = config?.metaMotos ?? 0

    const { dias, fuente } = await obtenerConteoDiarioConFallback(mes, anio)

    const semanasMap = new Map<
      string,
      { inicio: string; fin: string; livianos: number; motos: number; total: number }
    >()

    for (const d of dias) {
      const fechaDt = DateTime.fromISO(d.fecha)
      const { inicio, fin } = semanaSabadoViernes(fechaDt)
      const key = inicio.toISODate() as string
      if (!semanasMap.has(key)) {
        semanasMap.set(key, {
          inicio: key,
          fin: fin.toISODate() as string,
          livianos: 0,
          motos: 0,
          total: 0,
        })
      }
      const semana = semanasMap.get(key)!
      semana.livianos += d.livianos
      semana.motos += d.motos
      semana.total += d.total
    }

    const semanas = Array.from(semanasMap.values())
      .sort((a, b) => a.inicio.localeCompare(b.inicio))
      .map((s) => ({
        ...s,
        pct_livianos: calcularPct(s.livianos, metaLivianos),
        pct_motos: calcularPct(s.motos, metaMotos),
      }))

    return response.ok({
      mes,
      anio,
      fuente_datos: fuente,
      meta_livianos: metaLivianos,
      meta_motos: metaMotos,
      meta_total: metaLivianos + metaMotos,
      semanas,
    })
  }

  /**
   * GET /reportes-admin/meta-mensual/proyectado?mes=&anio=
   * Promedio diario acumulado y proyección de cierre, día a día, solo
   * para los días ya transcurridos del mes (no incluye días futuros del
   * mes en curso, para no diluir el promedio con ceros que aún no
   * ocurrieron).
   */
  public async metaMensualProyectado({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const config = await ConfiguracionMetaMensual.query()
      .where('mes', mes)
      .where('anio', anio)
      .first()
    const metaLivianos = config?.metaLivianos ?? 0
    const metaMotos = config?.metaMotos ?? 0
    const metaTotal = metaLivianos + metaMotos

    const { dias, fuente } = await obtenerConteoDiarioConFallback(mes, anio)

    const now = DateTime.now()
    const esMesActual = mes === now.month && anio === now.year
    const diasDelMes = DateTime.fromObject({ year: anio, month: mes }).daysInMonth as number
    const diasTranscurridos = esMesActual ? now.day : diasDelMes
    const diasElapsed = dias.slice(0, Math.min(diasTranscurridos, dias.length))

    let acumuladoLivianos = 0
    let acumuladoMotos = 0

    const detalle = diasElapsed.map((d, idx) => {
      acumuladoLivianos += d.livianos
      acumuladoMotos += d.motos
      const n = idx + 1

      const promedioDiarioLivianos = acumuladoLivianos / n
      const promedioDiarioMotos = acumuladoMotos / n
      const proyeccionLivianos = Math.round(promedioDiarioLivianos * diasDelMes)
      const proyeccionMotos = Math.round(promedioDiarioMotos * diasDelMes)

      return {
        fecha: d.fecha,
        acumulado_livianos: acumuladoLivianos,
        acumulado_motos: acumuladoMotos,
        promedio_diario_livianos: Math.round(promedioDiarioLivianos * 100) / 100,
        promedio_diario_motos: Math.round(promedioDiarioMotos * 100) / 100,
        proyeccion_cierre_livianos: proyeccionLivianos,
        proyeccion_cierre_motos: proyeccionMotos,
        proyeccion_cierre_total: proyeccionLivianos + proyeccionMotos,
      }
    })

    const ultimo = detalle[detalle.length - 1] ?? null

    return response.ok({
      mes,
      anio,
      fuente_datos: fuente,
      dias_transcurridos: diasTranscurridos,
      dias_del_mes: diasDelMes,
      meta_livianos: metaLivianos,
      meta_motos: metaMotos,
      meta_total: metaTotal,
      resumen: ultimo
        ? {
            promedio_diario_livianos: ultimo.promedio_diario_livianos,
            promedio_diario_motos: ultimo.promedio_diario_motos,
            proyeccion_cierre_livianos: ultimo.proyeccion_cierre_livianos,
            proyeccion_cierre_motos: ultimo.proyeccion_cierre_motos,
            proyeccion_cierre_total: ultimo.proyeccion_cierre_total,
            pct_proyeccion_total: calcularPct(ultimo.proyeccion_cierre_total, metaTotal),
          }
        : null,
      dias: detalle,
    })
  }

  /**
   * GET /reportes-admin/meta-mensual/rango?fecha_inicio=&fecha_fin=
   * Real generado en un rango específico (debe caer dentro de un solo mes
   * calendario, porque la meta se configura por mes) comparado contra la
   * meta del mes completo, más una proyección de cierre basada en el ritmo
   * diario observado en ESE rango — a diferencia de metaMensualProyectado(),
   * que usa el ritmo del mes completo a la fecha.
   */
  public async metaMensualRango({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const di = DateTime.fromISO(fechaInicio)
    const df = DateTime.fromISO(fechaFin)
    if (di.month !== df.month || di.year !== df.year) {
      return response.badRequest({
        message:
          'El rango debe caer dentro de un mismo mes calendario, porque la meta se configura por mes. Elige fecha_inicio y fecha_fin dentro del mismo mes y año.',
      })
    }

    const resultado = await calcularMetaMensualVentana(fechaInicio, fechaFin, di.month, di.year)
    return response.ok(resultado)
  }

  /**
   * GET /reportes-admin/super-informe/meta-mensual?fecha_inicio=&fecha_fin=
   * Variante de metaMensualRango() para el Súper Informe: SÍ admite rangos
   * que crucen meses (a diferencia del endpoint standalone), sumando meta y
   * real de todos los meses tocados. 3 casos:
   *  1. Un solo mes y es el mes en curso → idéntico a metaMensualRango().
   *  2. Cruza meses ya cerrados + el mes en curso → meta y real se suman de
   *     TODOS los meses tocados; la proyección de cierre solo aplica al
   *     tramo del mes en curso (con su propio ritmo, vía
   *     calcularMetaMensualVentana) y se suma al real ya cerrado de los
   *     meses anteriores.
   *  3. Cruza solo meses ya cerrados (ninguno es el mes en curso) → sin
   *     proyección (no hay nada en curso que proyectar), solo real vs.
   *     meta combinada.
   */
  public async metaMensualSuperInforme({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeMetaMensualSuperInforme(fechaInicio, fechaFin)
  }

  /** Cálculo compartido por metaMensualSuperInforme() y el PDF del Súper Informe. */
  private async computeMetaMensualSuperInforme(fechaInicio: string, fechaFin: string) {
    const meses = mesesEnRango(fechaInicio, fechaFin)
    const now = DateTime.now()
    const mesActualIdx = meses.findIndex((m) => m.mes === now.month && m.anio === now.year)
    const esCasoUnMesActual = meses.length === 1 && mesActualIdx === 0

    // Comparativo interanual — mismo cálculo para los 3 casos (ver
    // calcularRealAnioAnteriorPorRango arriba), no depende del `caso`.
    const realAnioAnterior = await calcularRealAnioAnteriorPorRango(fechaInicio, fechaFin, meses)

    // ===== Caso 1: idéntico al endpoint standalone =====
    if (esCasoUnMesActual) {
      const resultado = await calcularMetaMensualVentana(
        fechaInicio,
        fechaFin,
        meses[0].mes,
        meses[0].anio
      )
      return {
        caso: 'un_mes_actual' as const,
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin,
        meses_tocados: meses,
        meta_total: resultado.meta_mes,
        real_total: resultado.real,
        pct_real_sobre_meta: resultado.pct_real_sobre_meta_mes,
        semaforo: calcularSemaforo(resultado.pct_real_sobre_meta_mes),
        proyeccion_total: resultado.proyeccion,
        pct_proyeccion_sobre_meta: resultado.pct_proyeccion_sobre_meta_mes,
        real_anio_anterior: realAnioAnterior,
        ...calcularVariacion(resultado.real.total, realAnioAnterior.total),
        detalle_por_mes: [
          {
            mes: meses[0].mes,
            anio: meses[0].anio,
            es_mes_actual: true,
            meta: resultado.meta_mes,
            real: resultado.real,
          },
        ],
      }
    }

    // ===== Real + meta por mes tocado (intersección con [fechaInicio, fechaFin]) =====
    const detallePorMes: {
      mes: number
      anio: number
      es_mes_actual: boolean
      meta: { livianos: number; motos: number; total: number }
      real: { livianos: number; motos: number; total: number }
    }[] = []

    for (let i = 0; i < meses.length; i++) {
      const { mes, anio } = meses[i]
      const esMesActual = i === mesActualIdx

      const inicioMes = DateTime.fromObject({ year: anio, month: mes, day: 1 }).toISODate() as string
      const finMes = (DateTime.fromObject({ year: anio, month: mes, day: 1 }).endOf('month').toISODate()) as string
      const ventanaInicio = fechaInicio > inicioMes ? fechaInicio : inicioMes
      const ventanaFin = fechaFin < finMes ? fechaFin : finMes

      const config = await obtenerOCrearConfigMensual(mes, anio)
      const meta = {
        livianos: config.metaLivianos,
        motos: config.metaMotos,
        total: config.metaLivianos + config.metaMotos,
      }

      const { dias } = await obtenerConteoDiarioConFallback(mes, anio)
      const diasVentana = dias.filter((d) => d.fecha >= ventanaInicio && d.fecha <= ventanaFin)
      const realLivianos = diasVentana.reduce((acc, d) => acc + d.livianos, 0)
      const realMotos = diasVentana.reduce((acc, d) => acc + d.motos, 0)

      detallePorMes.push({
        mes,
        anio,
        es_mes_actual: esMesActual,
        meta,
        real: { livianos: realLivianos, motos: realMotos, total: realLivianos + realMotos },
      })
    }

    const metaTotal = detallePorMes.reduce(
      (acc, m) => ({
        livianos: acc.livianos + m.meta.livianos,
        motos: acc.motos + m.meta.motos,
        total: acc.total + m.meta.total,
      }),
      { livianos: 0, motos: 0, total: 0 }
    )

    // ===== Caso 3: solo meses ya cerrados — sin proyección =====
    if (mesActualIdx === -1) {
      const realTotal = detallePorMes.reduce(
        (acc, m) => ({
          livianos: acc.livianos + m.real.livianos,
          motos: acc.motos + m.real.motos,
          total: acc.total + m.real.total,
        }),
        { livianos: 0, motos: 0, total: 0 }
      )

      return {
        caso: 'solo_cerrados' as const,
        fecha_inicio: fechaInicio,
        fecha_fin: fechaFin,
        meses_tocados: meses,
        meta_total: metaTotal,
        real_total: realTotal,
        pct_real_sobre_meta: calcularPct(realTotal.total, metaTotal.total),
        semaforo: calcularSemaforo(calcularPct(realTotal.total, metaTotal.total)),
        proyeccion_total: null,
        pct_proyeccion_sobre_meta: null,
        real_anio_anterior: realAnioAnterior,
        ...calcularVariacion(realTotal.total, realAnioAnterior.total),
        detalle_por_mes: detallePorMes,
      }
    }

    // ===== Caso 2: cruza meses cerrados + el mes en curso =====
    const mesActual = meses[mesActualIdx]
    const inicioMesActual = DateTime.fromObject({
      year: mesActual.anio,
      month: mesActual.mes,
      day: 1,
    }).toISODate() as string
    const ventanaActualInicio = fechaInicio > inicioMesActual ? fechaInicio : inicioMesActual

    const resultadoMesActual = await calcularMetaMensualVentana(
      ventanaActualInicio,
      fechaFin,
      mesActual.mes,
      mesActual.anio
    )

    const realCerrados = detallePorMes
      .filter((m) => !m.es_mes_actual)
      .reduce(
        (acc, m) => ({
          livianos: acc.livianos + m.real.livianos,
          motos: acc.motos + m.real.motos,
          total: acc.total + m.real.total,
        }),
        { livianos: 0, motos: 0, total: 0 }
      )

    const realTotal = {
      livianos: realCerrados.livianos + resultadoMesActual.real.livianos,
      motos: realCerrados.motos + resultadoMesActual.real.motos,
      total: realCerrados.total + resultadoMesActual.real.total,
    }
    const proyeccionTotal = {
      livianos: realCerrados.livianos + resultadoMesActual.proyeccion.livianos,
      motos: realCerrados.motos + resultadoMesActual.proyeccion.motos,
      total: realCerrados.total + resultadoMesActual.proyeccion.total,
    }

    // El detalle del mes actual refleja SOLO su tramo dentro del rango
    // (ventanaActualInicio..fechaFin), no el mes completo — consistente
    // con "real" ya siendo el mismo que resultadoMesActual.real.
    const detalleFinal = detallePorMes.map((m) =>
      m.es_mes_actual ? { ...m, real: resultadoMesActual.real } : m
    )

    return {
      caso: 'cruce_con_mes_actual' as const,
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      meses_tocados: meses,
      meta_total: metaTotal,
      real_total: realTotal,
      pct_real_sobre_meta: calcularPct(realTotal.total, metaTotal.total),
      semaforo: calcularSemaforo(calcularPct(realTotal.total, metaTotal.total)),
      proyeccion_total: proyeccionTotal,
      pct_proyeccion_sobre_meta: calcularPct(proyeccionTotal.total, metaTotal.total),
      real_anio_anterior: realAnioAnterior,
      ...calcularVariacion(realTotal.total, realAnioAnterior.total),
      detalle_por_mes: detalleFinal,
    }
  }

  /**
   * GET /reportes-admin/meta-comercial/resumen?mes=&anio=
   * Meta Comercial por Asesor: cantidad/pesos por asesor para el mes
   * consultado, con el mismo patrón de corte real/histórico que Meta
   * Mensual RTM (obtenerConteoDiarioConFallback), pero con su propio corte
   * (META_COMERCIAL_CORTE_MES/ANIO) e independiente del motor real de
   * comisiones:
   *  - mes >= corte → SUM(comisiones.monto_asesor) real, agrupado por
   *    agentes_captacions.tipo (ASESOR_COMERCIAL/ASESOR_CONVENIO).
   *  - mes < corte, CON fila en historico_comercial_vehiculo_mensual →
   *    cálculo real por tipo de vehículo con la tarifa vigente de ese mes
   *    (feb-may/2026, reconciliado contra el Excel), es_estimado=false.
   *  - mes < corte, SIN esa fila → SUM(historico_comercial_asesor.cantidad)
   *    convertido a pesos ESTIMADOS con tarifa plana
   *    (VALOR_ESTIMADO_ASESOR_*), marcado es_estimado=true para que el
   *    frontend lo distinga visualmente.
   */
  public async metaComercialResumen({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const esReal = esFuenteRealComercial(mes, anio)

    const metaRows = (await Database.from('meta_comercial_asesor')
      .where({ mes, anio })
      .select('asesor_id', 'meta_pesos', 'meta_vehiculos')) as {
      asesor_id: number
      meta_pesos: string
      meta_vehiculos: number | null
    }[]

    const metaMap = new Map(metaRows.map((r) => [Number(r.asesor_id), Number(r.meta_pesos)]))
    const metaVehiculosMap = new Map(
      metaRows.map((r) => [Number(r.asesor_id), r.meta_vehiculos === null ? null : Number(r.meta_vehiculos)])
    )
    const idsConMeta = metaRows.map((r) => Number(r.asesor_id))

    let idsConDatos: number[] = []
    if (esReal) {
      const rows = (await Database.from('comisiones')
        .where('es_config', false)
        .where('tipo_servicio', 'RTM')
        .whereIn('estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
        .whereRaw('MONTH(fecha_calculo) = ? AND YEAR(fecha_calculo) = ?', [mes, anio])
        .whereNotNull('asesor_id')
        .distinct('asesor_id')
        .select('asesor_id')) as { asesor_id: number }[]
      idsConDatos = rows.map((r) => Number(r.asesor_id))
    } else {
      const rows = (await Database.from('historico_comercial_asesor')
        .whereRaw('MONTH(fecha_inicio) = ? AND YEAR(fecha_inicio) = ?', [mes, anio])
        .distinct('asesor_id')
        .select('asesor_id')) as { asesor_id: number }[]
      idsConDatos = rows.map((r) => Number(r.asesor_id))
    }

    const asesorIds = Array.from(new Set([...idsConMeta, ...idsConDatos]))

    if (asesorIds.length === 0) {
      return response.ok({ mes, anio, fuente: esReal ? 'real' : 'historico', asesores: [] })
    }

    const asesores = await AgenteCaptacion.query().whereIn('id', asesorIds).select('id', 'nombre')
    const nombreMap = new Map(asesores.map((a) => [a.id, a.nombre]))

    const porAsesor = new Map<number, { convenio: number; comercial: number }>()

    if (esReal) {
      const agregados = (await Database.from('comisiones as c')
        .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
        .whereIn('c.asesor_id', asesorIds)
        .where('c.es_config', false)
        .where('c.tipo_servicio', 'RTM')
        .whereIn('c.estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
        .whereRaw('MONTH(c.fecha_calculo) = ? AND YEAR(c.fecha_calculo) = ?', [mes, anio])
        .select('c.asesor_id', 'a.tipo')
        .sum('c.monto_asesor as total')
        .groupBy('c.asesor_id', 'a.tipo')) as { asesor_id: number; tipo: string; total: string }[]

      for (const r of agregados) {
        const id = Number(r.asesor_id)
        const cur = porAsesor.get(id) ?? { convenio: 0, comercial: 0 }
        if (r.tipo === 'ASESOR_CONVENIO') cur.convenio += Number(r.total)
        else cur.comercial += Number(r.total)
        porAsesor.set(id, cur)
      }
    } else {
      const agregados = (await Database.from('historico_comercial_asesor')
        .whereIn('asesor_id', asesorIds)
        .whereRaw('MONTH(fecha_inicio) = ? AND YEAR(fecha_inicio) = ?', [mes, anio])
        .select('asesor_id', 'tipo')
        .sum('cantidad as total')
        .groupBy('asesor_id', 'tipo')) as { asesor_id: number; tipo: string; total: string }[]

      for (const r of agregados) {
        const id = Number(r.asesor_id)
        const cur = porAsesor.get(id) ?? { convenio: 0, comercial: 0 }
        const cantidad = Number(r.total)
        if (r.tipo === 'ASESOR_CONVENIO') cur.convenio += cantidad
        else cur.comercial += cantidad
        porAsesor.set(id, cur)
      }
    }

    // Detalle por tipo de vehículo (feb-may/2026, reconciliado contra el
    // Excel) — cuando exista fila aquí para el asesor/mes, reemplaza la
    // tarifa plana estimada por el cálculo real con tarifa vigente de ese
    // mes. Meses sin fila (jul/2026 en adelante, hasta que se cargue su
    // propio detalle) siguen usando VALOR_ESTIMADO_ASESOR_*.
    const vehiculoDetalleMap = new Map<
      number,
      {
        livianos_convenio: number
        motos_convenio: number
        livianos_propio: number
        motos_propio: number
        tarifa_carro: number
        tarifa_moto: number
      }
    >()
    if (!esReal) {
      const detalleRows = (await Database.from('historico_comercial_vehiculo_mensual')
        .whereIn('asesor_id', asesorIds)
        .where({ mes, anio })
        .select(
          'asesor_id',
          'livianos_convenio',
          'motos_convenio',
          'livianos_propio',
          'motos_propio',
          'tarifa_carro',
          'tarifa_moto'
        )) as any[]

      for (const r of detalleRows) {
        vehiculoDetalleMap.set(Number(r.asesor_id), {
          livianos_convenio: Number(r.livianos_convenio),
          motos_convenio: Number(r.motos_convenio),
          livianos_propio: Number(r.livianos_propio),
          motos_propio: Number(r.motos_propio),
          tarifa_carro: Number(r.tarifa_carro),
          tarifa_moto: Number(r.tarifa_moto),
        })
      }
    }

    const asesoresOut = asesorIds.map((id) => {
      const v = porAsesor.get(id) ?? { convenio: 0, comercial: 0 }
      const meta = metaMap.has(id) ? metaMap.get(id)! : null
      const vd = vehiculoDetalleMap.get(id)

      let pesosConvenio: number
      let pesosComercial: number
      let cantidadConvenio: number | null
      let cantidadComercial: number | null
      let esEstimado: boolean

      if (esReal) {
        // v.convenio/v.comercial ya están en pesos reales (SUM monto_asesor)
        pesosConvenio = v.convenio
        pesosComercial = v.comercial
        cantidadConvenio = null
        cantidadComercial = null
        esEstimado = false
      } else if (vd) {
        // Detalle real por tipo de vehículo con tarifa vigente del mes.
        cantidadConvenio = vd.livianos_convenio + vd.motos_convenio
        cantidadComercial = vd.livianos_propio + vd.motos_propio
        pesosConvenio = vd.livianos_convenio * vd.tarifa_carro + vd.motos_convenio * vd.tarifa_moto
        pesosComercial = vd.livianos_propio * vd.tarifa_carro + vd.motos_propio * vd.tarifa_moto
        esEstimado = false
      } else {
        // v.convenio/v.comercial son CANTIDADES → convertir a pesos estimados
        cantidadConvenio = v.convenio
        cantidadComercial = v.comercial
        pesosConvenio = v.convenio * VALOR_ESTIMADO_ASESOR_CONVENIO
        pesosComercial = v.comercial * VALOR_ESTIMADO_ASESOR_COMERCIAL
        esEstimado = true
      }

      const pesosTotal = pesosConvenio + pesosComercial
      const pct = meta !== null ? calcularPct(pesosTotal, meta) : null
      const metaVehiculos = metaVehiculosMap.get(id) ?? null
      const logradoVehiculos = cantidadConvenio !== null && cantidadComercial !== null
        ? cantidadConvenio + cantidadComercial
        : null

      return {
        asesor_id: id,
        asesor_nombre: nombreMap.get(id) ?? '—',
        fuente: esReal ? 'real' : 'historico',
        es_estimado: esEstimado,
        cantidad_convenio: cantidadConvenio,
        cantidad_comercial: cantidadComercial,
        pesos_convenio: pesosConvenio,
        pesos_comercial: pesosComercial,
        pesos_total: pesosTotal,
        meta_pesos: meta,
        pct_avance: pct,
        semaforo: calcularSemaforo(pct),
        // Meta en unidades — solo se expone acá el dato crudo (meta y, si el
        // mes es histórico, el logrado ya calculado arriba). En meses
        // reales no hay "logrado en vehículos" en este endpoint (usa
        // comisiones, que no cuenta 1 fila por vehículo) — el Súper Informe
        // sí lo calcula aparte contra facturacion_tickets.
        meta_vehiculos: metaVehiculos,
        logrado_vehiculos: logradoVehiculos,
      }
    })

    asesoresOut.sort((a, b) => a.asesor_nombre.localeCompare(b.asesor_nombre))

    // La nota del conjunto refleja la MEZCLA real de es_estimado entre los
    // asesores devueltos — antes decía "tarifa plana" siempre que el mes
    // fuera histórico, aunque todos (o algunos) tuvieran detalle real por
    // vehículo (feb-may/2026). Ninguno estimado → mensaje transparente de
    // cálculo real; todos estimados → tarifa plana (mensaje original);
    // mezcla → aviso explícito de que no es uniforme.
    const totalAsesores = asesoresOut.length
    const estimadosCount = asesoresOut.filter((a) => a.es_estimado).length
    const esEstimadoGlobal = totalAsesores > 0 && estimadosCount === totalAsesores

    let notaGlobal: string | null = null
    if (!esReal && totalAsesores > 0) {
      if (estimadosCount === 0) {
        notaGlobal = 'Cálculo real por tipo de vehículo con la tarifa vigente de cada mes — no es cálculo de nómina.'
      } else if (estimadosCount === totalAsesores) {
        notaGlobal = `Pesos estimados con tarifa plana ($${VALOR_ESTIMADO_ASESOR_COMERCIAL.toLocaleString('es-CO')} propio / $${VALOR_ESTIMADO_ASESOR_CONVENIO.toLocaleString('es-CO')} convenio por captación) — no es cálculo de nómina.`
      } else {
        notaGlobal = 'Cálculo mixto: algunos asesores usan tarifa real por tipo de vehículo y otros tarifa plana estimada (ver detalle por asesor) — no es cálculo de nómina.'
      }
    }

    return response.ok({
      mes,
      anio,
      fuente: esReal ? 'real' : 'historico',
      es_estimado: esEstimadoGlobal,
      nota: notaGlobal,
      asesores: asesoresOut,
    })
  }

  /**
   * GET /reportes-admin/super-informe/meta-comercial?fecha_inicio=&fecha_fin=
   * Variante "bulk" (todos los asesores en una sola respuesta) y con rango
   * libre fecha_inicio/fecha_fin de metaComercialResumen(), pensada para el
   * Súper Informe. Resuelve mes/año con la misma lógica de 3 casos que
   * metaMensualSuperInforme() (un mes actual / cruce con el mes actual /
   * solo meses cerrados), y agrega por asesor: meta, avance, % avance,
   * descuentos dados (mismo cruce que metaComercialIngresoRealDateo() pero
   * agregado por asesor en vez de filtrado a uno), cantidad de
   * livianos/motos, y proyección de cierre (solo para el tramo del mes en
   * curso, igual que metaMensualSuperInforme() — sumada al avance ya
   * cerrado de los meses anteriores).
   *
   * Limitación conocida: para meses históricos (antes de
   * META_COMERCIAL_CORTE_MES/ANIO) el avance y el desglose de vehículo NO
   * tienen granularidad diaria (historico_comercial_asesor /
   * historico_comercial_vehiculo_mensual son totales MENSUALES) — para esos
   * meses se usa el total del mes completo aunque el rango solo toque una
   * parte de ese mes, y no hay descuentos históricos por asesor (quedan en
   * 0). Se expone en `advertencias`.
   */
  public async metaComercialSuperInforme({ request, response }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })
    return await this.computeMetaComercialSuperInforme(fechaInicio, fechaFin)
  }

  /** Cálculo compartido por metaComercialSuperInforme() y el PDF del Súper Informe. */
  /**
   * Descuentos dados por cada asesor (Comercial y Convenio) en el rango,
   * agrupados por tipo de descuento — usado solo por el Súper Informe
   * (sección Meta Comercial por Asesor, bloque "Descuentos dados por
   * asesor"). El "autorizador" de un descuento
   * (facturacion_tickets.autorizado_por_id, ver
   * computeDescuentosPorAutorizador()) es quien lo aprobó en caja, NO el
   * asesor que generó el turno/factura — ese es facturacion_tickets.agente_id
   * (mismo campo que ya usa reporteAsesores()). El `idsPermitidos` que
   * recibe puede ser un universo más amplio que el resto de esta función
   * (que solo cubre ASESOR_COMERCIAL) — este bloque en particular incluye
   * también ASESOR_CONVENIO. Sin cambio de esquema: es una consulta nueva
   * sobre datos ya existentes.
   */
  private async computeDescuentosPorAsesorComercial(
    fechaInicio: string,
    fechaFin: string,
    idsPermitidos: number[]
  ): Promise<
    Map<number, { descuentos: { codigo: string; nombre: string; cantidad: number; total_descuentos: number }[]; total: number }>
  > {
    const resultado = new Map<
      number,
      { descuentos: { codigo: string; nombre: string; cantidad: number; total_descuentos: number }[]; total: number }
    >()
    if (idsPermitidos.length === 0) return resultado

    const rows = (await Database.from('facturacion_tickets as ft')
      .join('descuentos as d', 'd.id', 'ft.descuento_id')
      .whereIn('ft.agente_id', idsPermitidos)
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .whereNotNull('ft.descuento_id')
      .where('ft.descuento_monto_aplicado', '>', 0)
      .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [fechaInicio, fechaFin])
      .select('ft.agente_id', 'd.codigo', 'd.nombre')
      .count('* as cantidad')
      .sum('ft.descuento_monto_aplicado as total_descuentos')
      .groupBy('ft.agente_id', 'd.id', 'd.codigo', 'd.nombre')
      .orderBy('ft.agente_id', 'asc')) as {
      agente_id: number
      codigo: string
      nombre: string
      cantidad: string
      total_descuentos: string
    }[]

    for (const r of rows) {
      const id = Number(r.agente_id)
      if (!resultado.has(id)) resultado.set(id, { descuentos: [], total: 0 })
      const entry = resultado.get(id)!
      const totalDescuento = Number(r.total_descuentos) || 0
      entry.descuentos.push({
        codigo: r.codigo,
        nombre: r.nombre,
        cantidad: Number(r.cantidad),
        total_descuentos: totalDescuento,
      })
      entry.total += totalDescuento
    }
    return resultado
  }

  private async computeMetaComercialSuperInforme(fechaInicio: string, fechaFin: string) {
    const meses = mesesEnRango(fechaInicio, fechaFin)
    const now = DateTime.now()
    const mesActualIdx = meses.findIndex((m) => m.mes === now.month && m.anio === now.year)
    const caso: 'un_mes_actual' | 'cruce_con_mes_actual' | 'solo_cerrados' =
      meses.length === 1 && mesActualIdx === 0
        ? 'un_mes_actual'
        : mesActualIdx === -1
          ? 'solo_cerrados'
          : 'cruce_con_mes_actual'

    // Universo de asesores permitidos: SOLO tipo='ASESOR_COMERCIAL' (pedido
    // explícito para el Súper Informe — excluye ASESOR_CONVENIO por completo,
    // a diferencia de metaComercialResumen() que incluye ambos tipos).
    const asesoresComerciales = await AgenteCaptacion.query()
      .where('tipo', 'ASESOR_COMERCIAL')
      .select('id', 'nombre')
    const idsPermitidos = asesoresComerciales.map((a) => a.id)
    const nombreMap = new Map(asesoresComerciales.map((a) => [a.id, a.nombre]))

    // Costo Base RTM (moto/vehículo) por asesor — para "Ingreso RTM
    // Generado". Meses reales: config individual del asesor (comisiones
    // es_config=true), con fallback al valor Global si no tiene override
    // propio — mismo mecanismo que ya usa metasMensuales() en
    // comisiones_controller.ts. Meses históricos: tarifa_moto/tarifa_carro
    // de historico_comercial_vehiculo_mensual (ya se consulta más abajo).
    const costoBaseGlobal = await obtenerCostoBaseRtmGlobal()
    const costoBaseConfigRows = idsPermitidos.length
      ? await Comision.query()
          .where('es_config', true)
          .whereIn('asesor_id', idsPermitidos)
          .where((wb) => wb.where('valor_rtm_moto', '>', 0).orWhere('valor_rtm_vehiculo', '>', 0))
      : []
    const costoBasePorAsesor = new Map<number, { moto: number; vehiculo: number }>()
    for (const c of costoBaseConfigRows) {
      if (c.asesorId === null) continue
      costoBasePorAsesor.set(c.asesorId, {
        moto: c.valorRtmMoto || costoBaseGlobal.moto,
        vehiculo: c.valorRtmVehiculo || costoBaseGlobal.vehiculo,
      })
    }
    const obtenerCostoBaseAsesor = (asesorId: number) => costoBasePorAsesor.get(asesorId) ?? costoBaseGlobal

    // Descuentos dados por cada asesor — universo AMPLIADO (Comercial +
    // Convenio, pedido explícito para este bloque), a diferencia del resto
    // de la función que solo cubre ASESOR_COMERCIAL. Rango completo, no por
    // mes (los descuentos no distinguen fuente real/histórica como el resto
    // de esta función, siempre salen de facturacion_tickets).
    const asesoresParaDescuentos = await AgenteCaptacion.query()
      .whereIn('tipo', ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'])
      .select('id', 'nombre')
    const idsParaDescuentos = asesoresParaDescuentos.map((a) => a.id)
    const nombreMapDescuentos = new Map(asesoresParaDescuentos.map((a) => [a.id, a.nombre]))

    const descuentosPorAsesorMap = await this.computeDescuentosPorAsesorComercial(
      fechaInicio,
      fechaFin,
      idsParaDescuentos
    )
    // Aplanado listo para tabla (Asesor | Tipo | Cantidad | Total), ordenado
    // por asesor y luego por monto descendente dentro de cada asesor.
    const descuentosPorAsesor: {
      asesor_id: number
      asesor_nombre: string
      codigo: string
      nombre: string
      cantidad: number
      total_descuentos: number
    }[] = []
    for (const [id, entry] of descuentosPorAsesorMap) {
      const asesorNombre = nombreMapDescuentos.get(id) ?? '—'
      for (const d of entry.descuentos) {
        descuentosPorAsesor.push({
          asesor_id: id,
          asesor_nombre: asesorNombre,
          codigo: d.codigo,
          nombre: d.nombre,
          cantidad: d.cantidad,
          total_descuentos: d.total_descuentos,
        })
      }
    }
    descuentosPorAsesor.sort(
      (a, b) => a.asesor_nombre.localeCompare(b.asesor_nombre) || b.total_descuentos - a.total_descuentos
    )

    type Acum = {
      metaPesos: number | null
      metaVehiculos: number | null
      // Antes "cantidadVehiculos" (un solo número, moto+vehículo sumados) —
      // ahora separado en las 2 categorías, pedido explícito para la tabla
      // "Unidades (vehículos)" y para "Ingreso RTM Generado".
      logradoMotos: number
      logradoVehiculos: number
      pesosConvenio: number
      pesosComercial: number
      comisionPagada: number
      comisionPendiente: number
      // Ingreso RTM Generado = Σ por mes de (motos_del_mes × costoBaseMoto +
      // vehiculos_del_mes × costoBaseVehiculo) — costoBase puede variar mes
      // a mes en rangos históricos, por eso se acumula dentro del loop de
      // meses, no al final con un solo costoBase fijo.
      ingresoRtmGenerado: number
      // Último costoBase usado (para mostrarlo en la tabla) — en rangos que
      // cruzan varios meses con tarifas distintas, es el del mes más
      // reciente tocado, no necesariamente uniforme en todo el rango.
      ultimoCostoBaseMoto: number | null
      ultimoCostoBaseVehiculo: number | null
    }
    const acumPorAsesor = new Map<number, Acum>()
    const asegurar = (id: number): Acum => {
      if (!acumPorAsesor.has(id)) {
        acumPorAsesor.set(id, {
          metaPesos: null,
          metaVehiculos: null,
          logradoMotos: 0,
          logradoVehiculos: 0,
          pesosConvenio: 0,
          pesosComercial: 0,
          comisionPagada: 0,
          comisionPendiente: 0,
          ingresoRtmGenerado: 0,
          ultimoCostoBaseMoto: null,
          ultimoCostoBaseVehiculo: null,
        })
      }
      return acumPorAsesor.get(id)!
    }

    let esRealTodosLosMeses = true
    let esEstimadoAlgunMes = false

    if (idsPermitidos.length > 0) {
      for (const { mes, anio } of meses) {
        const inicioMes = DateTime.fromObject({ year: anio, month: mes, day: 1 }).toISODate() as string
        const finMes = (
          DateTime.fromObject({ year: anio, month: mes, day: 1 }).endOf('month').toISODate()
        ) as string
        const ventanaInicio = fechaInicio > inicioMes ? fechaInicio : inicioMes
        const ventanaFin = fechaFin < finMes ? fechaFin : finMes
        const esReal = esFuenteRealComercial(mes, anio)
        if (!esReal) esRealTodosLosMeses = false

        // ── Meta del mes (solo asesores comerciales) ──
        const metaRows = (await Database.from('meta_comercial_asesor')
          .where({ mes, anio })
          .whereIn('asesor_id', idsPermitidos)
          .select('asesor_id', 'meta_pesos', 'meta_vehiculos')) as {
          asesor_id: number
          meta_pesos: string
          meta_vehiculos: number | null
        }[]
        for (const r of metaRows) {
          const acc = asegurar(Number(r.asesor_id))
          acc.metaPesos = (acc.metaPesos ?? 0) + Number(r.meta_pesos)
          if (r.meta_vehiculos !== null) {
            acc.metaVehiculos = (acc.metaVehiculos ?? 0) + Number(r.meta_vehiculos)
          }
        }

        if (esReal) {
          // ── Vehículos logrados (real) — facturacion_tickets, NO comisiones:
          // comisiones solo genera una fila por "dateo exitoso"
          // (captacion_dateos_controller.ts), no por cada vehículo facturado
          // — subestimaría fuertemente el conteo (verificado: ~20 filas de
          // comisiones vs. ~114 vehículos reales en facturacion_tickets para
          // un mismo asesor/mes). agente_id ya es el mismo universo que
          // reporteAsesores() usa para "vehículos atendidos por el asesor".
          // Agrupado también por tipo de vehículo (join a turnos_rtms vía
          // turno_id, misma clasificación MOTO/VEHICULO que usa Servicios)
          // para poder separar "Unidades" en Motos/Vehículos y calcular
          // Ingreso RTM Generado por categoría.
          const vehiculosRows = (await Database.from('facturacion_tickets as ft')
            .join('turnos_rtms as t', 't.id', 'ft.turno_id')
            .whereIn('ft.agente_id', idsPermitidos)
            .where('ft.estado', 'CONFIRMADA')
            .where('ft.servicio_codigo', 'RTM')
            .whereRaw('DATE(ft.created_at) BETWEEN ? AND ?', [ventanaInicio, ventanaFin])
            .select(
              'ft.agente_id',
              Database.raw(
                "CASE WHEN LOWER(t.tipo_vehiculo) LIKE '%moto%' THEN 'MOTO' ELSE 'VEHICULO' END as tipo_clasificado"
              )
            )
            .count('* as cantidad')
            .groupBy('ft.agente_id', 'tipo_clasificado')) as {
            agente_id: number
            tipo_clasificado: 'MOTO' | 'VEHICULO'
            cantidad: string
          }[]
          for (const r of vehiculosRows) {
            const acc = asegurar(Number(r.agente_id))
            const cantidad = Number(r.cantidad) || 0
            const costoBase = obtenerCostoBaseAsesor(Number(r.agente_id))
            if (r.tipo_clasificado === 'MOTO') {
              acc.logradoMotos += cantidad
              acc.ingresoRtmGenerado += cantidad * costoBase.moto
              acc.ultimoCostoBaseMoto = costoBase.moto
            } else {
              acc.logradoVehiculos += cantidad
              acc.ingresoRtmGenerado += cantidad * costoBase.vehiculo
              acc.ultimoCostoBaseVehiculo = costoBase.vehiculo
            }
          }
          // Ya filtrado a solo ASESOR_COMERCIAL: todo el monto va a "comercial"
          // (mismo criterio de clasificación por tipo de agente que usa
          // metaComercialResumen() para el mes en curso).
          // Agrupado también por estado (una sola query) para poder
          // desglosar Pagada (estado='PAGADA') vs. Pendiente de pago
          // (PENDIENTE+APROBADA) sin correr una segunda consulta — ANULADA
          // ya queda excluida por el whereIn de arriba.
          const rows = (await Database.from('comisiones as c')
            .whereIn('c.asesor_id', idsPermitidos)
            .where('c.es_config', false)
            .where('c.tipo_servicio', 'RTM')
            .whereIn('c.estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
            .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [ventanaInicio, ventanaFin])
            .select('c.asesor_id', 'c.estado')
            .sum('c.monto_asesor as total')
            .groupBy('c.asesor_id', 'c.estado')) as { asesor_id: number; estado: string; total: string }[]
          for (const r of rows) {
            const acc = asegurar(Number(r.asesor_id))
            const monto = Number(r.total) || 0
            acc.pesosComercial += monto
            if (r.estado === 'PAGADA') acc.comisionPagada += monto
            else acc.comisionPendiente += monto
          }
        } else {
          // Histórico: aquí "tipo" SÍ es un atributo por registro
          // (historico_comercial_asesor.tipo), independiente del tipo fijo
          // del agente — puede reflejar captación por convenio aun para un
          // asesor cuya clasificación general es ASESOR_COMERCIAL.
          const historicoRows = (await Database.from('historico_comercial_asesor')
            .whereRaw('MONTH(fecha_inicio) = ? AND YEAR(fecha_inicio) = ?', [mes, anio])
            .whereIn('asesor_id', idsPermitidos)
            .select('asesor_id', 'tipo')
            .sum('cantidad as total')
            .groupBy('asesor_id', 'tipo')) as { asesor_id: number; tipo: string; total: string }[]

          const detalleVehiculo = (await Database.from('historico_comercial_vehiculo_mensual')
            .where({ mes, anio })
            .whereIn('asesor_id', idsPermitidos)
            .select(
              'asesor_id',
              'livianos_convenio',
              'motos_convenio',
              'livianos_propio',
              'motos_propio',
              'tarifa_carro',
              'tarifa_moto'
            )) as any[]
          const detalleMap = new Map(detalleVehiculo.map((d) => [Number(d.asesor_id), d]))

          const cantidadPorAsesor = new Map<number, { convenio: number; comercial: number }>()
          for (const r of historicoRows) {
            const id = Number(r.asesor_id)
            const cur = cantidadPorAsesor.get(id) ?? { convenio: 0, comercial: 0 }
            if (r.tipo === 'ASESOR_CONVENIO') cur.convenio += Number(r.total)
            else cur.comercial += Number(r.total)
            cantidadPorAsesor.set(id, cur)
          }

          for (const [id, cantidades] of cantidadPorAsesor) {
            const acc = asegurar(id)
            const vd = detalleMap.get(id)
            if (vd) {
              const tarifaCarro = Number(vd.tarifa_carro)
              const tarifaMoto = Number(vd.tarifa_moto)
              acc.pesosConvenio += Number(vd.livianos_convenio) * tarifaCarro + Number(vd.motos_convenio) * tarifaMoto
              acc.pesosComercial += Number(vd.livianos_propio) * tarifaCarro + Number(vd.motos_propio) * tarifaMoto
              // "Unidades" e "Ingreso RTM Generado" históricos: SOLO la
              // porción propia (livianos_propio/motos_propio), pedido
              // explícito — no incluye la porción convenio de esta misma
              // fila. tarifa_carro/tarifa_moto ES el Costo Base histórico
              // de ese asesor/mes (ya reconciliado contra Excel).
              const motosPropio = Number(vd.motos_propio)
              const vehiculosPropio = Number(vd.livianos_propio)
              acc.logradoMotos += motosPropio
              acc.logradoVehiculos += vehiculosPropio
              acc.ingresoRtmGenerado += motosPropio * tarifaMoto + vehiculosPropio * tarifaCarro
              acc.ultimoCostoBaseMoto = tarifaMoto
              acc.ultimoCostoBaseVehiculo = tarifaCarro
            } else {
              acc.pesosConvenio += cantidades.convenio * VALOR_ESTIMADO_ASESOR_CONVENIO
              acc.pesosComercial += cantidades.comercial * VALOR_ESTIMADO_ASESOR_COMERCIAL
              // Sin fila en historico_comercial_vehiculo_mensual no hay
              // desglose moto/vehículo ni tarifa real disponible para ese
              // mes — "Unidades" e "Ingreso RTM Generado" quedan sin
              // contribución de este mes (no se estima con tarifa plana,
              // a diferencia de pesosConvenio/pesosComercial arriba).
              esEstimadoAlgunMes = true
            }
          }
        }
      }
    }

    // ── Proyección de cierre POR ASESOR — misma fórmula ya validada de
    // metaComercialProyectado(asesor_id) (promedio diario del tramo del mes
    // en curso × días del mes, sumado al avance ya cerrado de meses
    // anteriores), pero corrida en 2 consultas agrupadas por asesor_id en
    // vez de N llamadas individuales al endpoint. En meses históricos no se
    // extrapola (se usa el total ya conocido), igual que antes. ──
    const proyeccionPorAsesor = new Map<number, number>()
    if (caso !== 'solo_cerrados' && idsPermitidos.length > 0) {
      const mesActual = meses[mesActualIdx]
      const inicioMesActual = DateTime.fromObject({
        year: mesActual.anio,
        month: mesActual.mes,
        day: 1,
      }).toISODate() as string
      const finMesActual = (
        DateTime.fromObject({ year: mesActual.anio, month: mesActual.mes, day: 1 }).endOf('month').toISODate()
      ) as string
      const ventanaActualInicio = fechaInicio > inicioMesActual ? fechaInicio : inicioMesActual
      const ventanaActualFin = fechaFin < finMesActual ? fechaFin : finMesActual

      if (esFuenteRealComercial(mesActual.mes, mesActual.anio)) {
        const hoyISO = now.toISODate() as string
        const finParaPromedio = ventanaActualFin > hoyISO ? hoyISO : ventanaActualFin
        const diasParaPromedio =
          finParaPromedio < ventanaActualInicio
            ? 0
            : Math.floor(
                DateTime.fromISO(finParaPromedio).diff(DateTime.fromISO(ventanaActualInicio), 'days').days
              ) + 1
        const diasDelMesActual = DateTime.fromObject({
          year: mesActual.anio,
          month: mesActual.mes,
        }).daysInMonth as number

        const rowsVentanaPromedio = (await Database.from('comisiones as c')
          .whereIn('c.asesor_id', idsPermitidos)
          .where('c.es_config', false)
          .where('c.tipo_servicio', 'RTM')
          .whereIn('c.estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
          .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [ventanaActualInicio, finParaPromedio])
          .select('c.asesor_id')
          .sum('c.monto_asesor as total')
          .groupBy('c.asesor_id')) as { asesor_id: number; total: string }[]
        const avanceVentanaPromedioPorAsesor = new Map<number, number>(
          rowsVentanaPromedio.map((r) => [Number(r.asesor_id), Number(r.total) || 0])
        )

        const rowsMesActualCompleto = (await Database.from('comisiones as c')
          .whereIn('c.asesor_id', idsPermitidos)
          .where('c.es_config', false)
          .where('c.tipo_servicio', 'RTM')
          .whereIn('c.estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
          .whereRaw('DATE(c.fecha_calculo) BETWEEN ? AND ?', [ventanaActualInicio, ventanaActualFin])
          .select('c.asesor_id')
          .sum('c.monto_asesor as total')
          .groupBy('c.asesor_id')) as { asesor_id: number; total: string }[]
        const avanceMesActualAgregadoPorAsesor = new Map<number, number>(
          rowsMesActualCompleto.map((r) => [Number(r.asesor_id), Number(r.total) || 0])
        )

        for (const [id, acc] of acumPorAsesor) {
          const pesosTotalAsesor = acc.pesosConvenio + acc.pesosComercial
          const avanceVentanaAsesor = avanceVentanaPromedioPorAsesor.get(id) ?? 0
          const avanceMesActualAsesor = avanceMesActualAgregadoPorAsesor.get(id) ?? 0
          const promedioDiarioAsesor = diasParaPromedio > 0 ? avanceVentanaAsesor / diasParaPromedio : 0
          const proyeccionMesActualAsesor = Math.round(promedioDiarioAsesor * diasDelMesActual)
          const avanceCerradosAsesor = pesosTotalAsesor - avanceMesActualAsesor
          proyeccionPorAsesor.set(id, avanceCerradosAsesor + proyeccionMesActualAsesor)
        }
      }
      // Mes actual histórico (no debería pasar en la práctica): el mapa
      // queda vacío y cada asesor cae al fallback pesos_total (sin
      // extrapolación), igual que el KPI agregado.
    }

    const asesoresOut = [...acumPorAsesor.entries()]
      .map(([id, acc]) => {
        const pesosTotal = acc.pesosConvenio + acc.pesosComercial
        const pctAvance = acc.metaPesos !== null ? calcularPct(pesosTotal, acc.metaPesos) : null
        return {
          asesor_id: id,
          asesor_nombre: nombreMap.get(id) ?? '—',
          pesos_convenio: acc.pesosConvenio,
          pesos_comercial: acc.pesosComercial,
          pesos_total: pesosTotal,
          meta_pesos: acc.metaPesos,
          pct_avance: pctAvance,
          cumplio: pctAvance !== null ? pctAvance >= 100 : null,
          faltante: acc.metaPesos !== null ? Math.max(acc.metaPesos - pesosTotal, 0) : null,
          proyeccion_cierre: proyeccionPorAsesor.get(id) ?? pesosTotal,
          comision_pagada: acc.comisionPagada,
          comision_pendiente: acc.comisionPendiente,
          meta_vehiculos: acc.metaVehiculos,
          logrado_motos: acc.logradoMotos,
          logrado_vehiculos: acc.logradoVehiculos,
          faltante_vehiculos:
            acc.metaVehiculos !== null
              ? Math.max(acc.metaVehiculos - (acc.logradoMotos + acc.logradoVehiculos), 0)
              : null,
          costo_base_moto: acc.ultimoCostoBaseMoto,
          costo_base_vehiculo: acc.ultimoCostoBaseVehiculo,
          ingreso_rtm_generado: acc.ingresoRtmGenerado,
        }
      })
      .sort((a, b) => a.asesor_nombre.localeCompare(b.asesor_nombre))

    // ── Agregados para las 4 KPI cards (igual que "todos" en pantalla, sin
    // asesor_id seleccionado) ──
    const totalConvenio = asesoresOut.reduce((acc, a) => acc + a.pesos_convenio, 0)
    const totalComercial = asesoresOut.reduce((acc, a) => acc + a.pesos_comercial, 0)
    const totalMeta = asesoresOut.reduce<number | null>(
      (acc, a) => (a.meta_pesos === null ? acc : (acc ?? 0) + a.meta_pesos),
      null
    )
    const totalPesos = totalConvenio + totalComercial
    const pctAvanceTotal = totalMeta !== null ? calcularPct(totalPesos, totalMeta) : null

    // Proyección global = suma de las proyecciones por asesor ya calculadas
    // arriba (matemáticamente idéntico al cálculo agregado anterior, que
    // sumaba una sola consulta global en vez de N filas por asesor).
    const proyeccionCierreTotal: number | null =
      caso !== 'solo_cerrados' && proyeccionPorAsesor.size > 0
        ? asesoresOut.reduce((acc, a) => acc + a.proyeccion_cierre, 0)
        : totalPesos
    const pctProyeccionTotal = totalMeta !== null && proyeccionCierreTotal !== null
      ? calcularPct(proyeccionCierreTotal, totalMeta)
      : null

    let nota: string | null = null
    if (!esRealTodosLosMeses) {
      nota = esEstimadoAlgunMes
        ? `Incluye meses históricos con pesos estimados con tarifa plana ($${VALOR_ESTIMADO_ASESOR_COMERCIAL.toLocaleString('es-CO')} propio / $${VALOR_ESTIMADO_ASESOR_CONVENIO.toLocaleString('es-CO')} convenio por captación) donde no había desglose por tipo de vehículo cargado — no es cálculo de nómina.`
        : 'Incluye meses históricos calculados con tarifa vigente por tipo de vehículo — no es cálculo de nómina.'
    }

    return {
      caso,
      fecha_inicio: fechaInicio,
      fecha_fin: fechaFin,
      meses_tocados: meses,
      nota,
      // Si algún mes tocado es histórico, comision_pagada/comision_pendiente
      // por asesor puede quedar incompleta (el histórico no registra estado
      // de pago) — este flag le dice al front/PDF si el desglose es confiable.
      comision_estado_disponible: esRealTodosLosMeses,
      kpis: {
        pesos_total: totalPesos,
        meta_pesos: totalMeta,
        pct_avance: pctAvanceTotal,
        pesos_convenio: totalConvenio,
        pesos_comercial: totalComercial,
        proyeccion_cierre: proyeccionCierreTotal,
        pct_proyeccion: pctProyeccionTotal,
      },
      asesores: asesoresOut,
      // Universo AMPLIADO (Comercial + Convenio) — no confundir con
      // `asesores` arriba, que solo cubre ASESOR_COMERCIAL.
      descuentosPorAsesor,
    }
  }

  /**
   * Helper compartido: resuelve asesor_id opcional del query string y, si
   * viene, valida que exista. Si no viene, los métodos de abajo agregan
   * TODOS los asesores con datos ese mes (comportamiento "todos").
   */
  private async resolveAsesorFiltro(
    request: HttpContext['request']
  ): Promise<{ asesorId: number | null; asesorNombre: string | null; error?: string }> {
    const raw = request.input('asesor_id')
    if (raw === undefined || raw === null || raw === '') {
      return { asesorId: null, asesorNombre: null }
    }
    const asesorId = Number(raw)
    if (!Number.isInteger(asesorId) || asesorId <= 0) {
      return { asesorId: null, asesorNombre: null, error: 'asesor_id inválido' }
    }
    const asesor = await AgenteCaptacion.find(asesorId)
    if (!asesor) return { asesorId: null, asesorNombre: null, error: 'asesor_id no existe' }
    return { asesorId, asesorNombre: asesor.nombre }
  }

  /**
   * GET /reportes-admin/meta-comercial/diario?mes=&anio=&asesor_id=
   * SOLO tiene sentido para meses reales (mes >= META_COMERCIAL_CORTE) —
   * el histórico del Excel es semanal, no diario. Para meses históricos
   * devuelve fuente='historico_sin_detalle_diario' y dias=[].
   * asesor_id opcional: si no viene, agrega TODOS los asesores con
   * comisiones ese mes.
   */
  public async metaComercialDiario({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const { asesorId, asesorNombre, error: asesorError } = await this.resolveAsesorFiltro(request)
    if (asesorError) return response.badRequest({ message: asesorError })

    const esReal = esFuenteRealComercial(mes, anio)

    const metaPesos = await this.metaPesosDelMes(asesorId, mes, anio)

    if (!esReal) {
      return response.ok({
        mes,
        anio,
        asesor_id: asesorId,
        asesor_nombre: asesorNombre,
        fuente: 'historico_sin_detalle_diario',
        nota: `El histórico cargado desde Excel es semanal, no diario — no existe detalle día a día antes de ${META_COMERCIAL_CORTE_MES}/${META_COMERCIAL_CORTE_ANIO}. Usa la pestaña Semanal para este mes.`,
        meta_pesos: metaPesos,
        dias: [],
      })
    }

    const query = Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .where('c.es_config', false)
      .where('c.tipo_servicio', 'RTM')
      .whereIn('c.estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
      .whereRaw('MONTH(c.fecha_calculo) = ? AND YEAR(c.fecha_calculo) = ?', [mes, anio])
      .select(Database.raw("DATE_FORMAT(c.fecha_calculo, '%Y-%m-%d') as fecha"), 'a.tipo', 'c.tipo_vehiculo')
      .count('* as cantidad')
      .sum('c.monto_asesor as total')
      .groupBy('fecha', 'a.tipo', 'c.tipo_vehiculo')

    if (asesorId) query.andWhere('c.asesor_id', asesorId)

    const rows = (await query) as {
      fecha: string
      tipo: string
      tipo_vehiculo: string | null
      total: string
      cantidad: string
    }[]

    const porDia = new Map<
      string,
      {
        convenio: number
        comercial: number
        cantidadConvenio: number
        cantidadComercial: number
        motos: number
        carros: number
      }
    >()
    for (const r of rows) {
      const cur = porDia.get(r.fecha) ?? {
        convenio: 0,
        comercial: 0,
        cantidadConvenio: 0,
        cantidadComercial: 0,
        motos: 0,
        carros: 0,
      }
      const cantidad = Number(r.cantidad)
      if (r.tipo === 'ASESOR_CONVENIO') {
        cur.convenio += Number(r.total)
        cur.cantidadConvenio += cantidad
      } else {
        cur.comercial += Number(r.total)
        cur.cantidadComercial += cantidad
      }
      if (r.tipo_vehiculo === 'MOTO') cur.motos += cantidad
      else if (r.tipo_vehiculo === 'VEHICULO') cur.carros += cantidad
      porDia.set(r.fecha, cur)
    }

    const diasDelMes = DateTime.fromObject({ year: anio, month: mes }).daysInMonth as number
    let acumConvenio = 0
    let acumComercial = 0
    const dias = []
    for (let d = 1; d <= diasDelMes; d++) {
      const fechaStr = DateTime.fromObject({ year: anio, month: mes, day: d }).toISODate() as string
      const v = porDia.get(fechaStr) ?? {
        convenio: 0,
        comercial: 0,
        cantidadConvenio: 0,
        cantidadComercial: 0,
        motos: 0,
        carros: 0,
      }
      acumConvenio += v.convenio
      acumComercial += v.comercial
      const acumuladoTotal = acumConvenio + acumComercial
      dias.push({
        fecha: fechaStr,
        cantidad_total: v.motos + v.carros,
        cantidad_motos: v.motos,
        cantidad_carros: v.carros,
        cantidad_convenio: v.cantidadConvenio,
        cantidad_comercial: v.cantidadComercial,
        pesos_convenio: v.convenio,
        pesos_comercial: v.comercial,
        pesos_total: v.convenio + v.comercial,
        acumulado_convenio: acumConvenio,
        acumulado_comercial: acumComercial,
        acumulado_total: acumuladoTotal,
        pct_vs_meta: calcularPct(acumuladoTotal, metaPesos ?? 0),
      })
    }

    return response.ok({
      mes,
      anio,
      asesor_id: asesorId,
      asesor_nombre: asesorNombre,
      fuente: 'real',
      nota: null,
      meta_pesos: metaPesos,
      dias,
    })
  }

  /**
   * Semanas históricas (mes < corte comercial) con pesos por tipo
   * (convenio/comercial), prorrateando el total mensual real por tipo de
   * vehículo (historico_comercial_vehiculo_mensual) según la proporción de
   * cantidad semanal de cada asesor sobre su total mensual — o, si el
   * asesor/mes no tiene fila de detalle, con la tarifa plana estimada
   * (VALOR_ESTIMADO_ASESOR_*), igual que antes. Compartido por
   * metaComercialSemanal y metaComercialProyectado (rama histórica) para no
   * duplicar el prorrateo.
   *
   * esEstimado=true solo cuando NINGÚN asesor relevante tiene fila de
   * detalle ese mes (todo cae a tarifa plana). Con datos mixtos (algunos
   * asesores con detalle, otros sin) se reporta false — no ocurre hoy
   * (feb-may tienen cobertura completa) pero queda documentado por si un
   * asesor nuevo se agrega sin su detalle de vehículo.
   */
  private async calcularSemanasHistoricas(
    asesorId: number | null,
    mes: number,
    anio: number
  ): Promise<{
    semanas: {
      inicio: string
      fin: string
      cantidadConvenio: number
      cantidadComercial: number
      pesosConvenio: number
      pesosComercial: number
      cantidadMotos: number | null
      cantidadCarros: number | null
    }[]
    esEstimado: boolean
    cantidadVehiculoDisponible: boolean
  }> {
    const query = Database.from('historico_comercial_asesor')
      .whereRaw('MONTH(fecha_inicio) = ? AND YEAR(fecha_inicio) = ?', [mes, anio])
      .select(
        'asesor_id',
        Database.raw("DATE_FORMAT(fecha_inicio, '%Y-%m-%d') as fecha_inicio"),
        Database.raw("DATE_FORMAT(fecha_fin, '%Y-%m-%d') as fecha_fin"),
        'tipo',
        'cantidad'
      )
    if (asesorId) query.andWhere('asesor_id', asesorId)

    const rows = (await query) as {
      asesor_id: number
      fecha_inicio: string
      fecha_fin: string
      tipo: string
      cantidad: number
    }[]

    const perAsesorSemana = new Map<
      number,
      Map<string, { inicio: string; fin: string; convenio: number; comercial: number }>
    >()
    const perAsesorMesTotal = new Map<number, { convenio: number; comercial: number }>()

    for (const r of rows) {
      const id = Number(r.asesor_id)
      const cantidad = Number(r.cantidad)

      if (!perAsesorSemana.has(id)) perAsesorSemana.set(id, new Map())
      const semanasAsesor = perAsesorSemana.get(id)!
      if (!semanasAsesor.has(r.fecha_inicio)) {
        semanasAsesor.set(r.fecha_inicio, {
          inicio: r.fecha_inicio,
          fin: r.fecha_fin,
          convenio: 0,
          comercial: 0,
        })
      }
      const s = semanasAsesor.get(r.fecha_inicio)!
      const totalAsesor = perAsesorMesTotal.get(id) ?? { convenio: 0, comercial: 0 }

      if (r.tipo === 'ASESOR_CONVENIO') {
        s.convenio += cantidad
        totalAsesor.convenio += cantidad
      } else {
        s.comercial += cantidad
        totalAsesor.comercial += cantidad
      }
      perAsesorMesTotal.set(id, totalAsesor)
    }

    const asesorIds = Array.from(perAsesorMesTotal.keys())
    const vehiculoMap = new Map<
      number,
      {
        livianosConvenio: number
        motosConvenio: number
        livianosPropio: number
        motosPropio: number
        tarifaCarro: number
        tarifaMoto: number
      }
    >()

    if (asesorIds.length > 0) {
      const detalleRows = (await Database.from('historico_comercial_vehiculo_mensual')
        .whereIn('asesor_id', asesorIds)
        .where({ mes, anio })
        .select(
          'asesor_id',
          'livianos_convenio',
          'motos_convenio',
          'livianos_propio',
          'motos_propio',
          'tarifa_carro',
          'tarifa_moto'
        )) as any[]

      for (const r of detalleRows) {
        vehiculoMap.set(Number(r.asesor_id), {
          livianosConvenio: Number(r.livianos_convenio),
          motosConvenio: Number(r.motos_convenio),
          livianosPropio: Number(r.livianos_propio),
          motosPropio: Number(r.motos_propio),
          tarifaCarro: Number(r.tarifa_carro),
          tarifaMoto: Number(r.tarifa_moto),
        })
      }
    }

    const cantidadVehiculoDisponible = vehiculoMap.size > 0

    const semanaAgregada = new Map<
      string,
      {
        inicio: string
        fin: string
        cantidadConvenio: number
        cantidadComercial: number
        pesosConvenio: number
        pesosComercial: number
        cantidadMotos: number | null
        cantidadCarros: number | null
      }
    >()

    for (const [id, semanasAsesor] of perAsesorSemana) {
      const totalAsesor = perAsesorMesTotal.get(id)!
      const detalle = vehiculoMap.get(id)

      for (const s of semanasAsesor.values()) {
        let pesosConvenio: number
        let pesosComercial: number
        let motos: number | null = null
        let carros: number | null = null

        // Proporción de esta semana sobre el total del mes, por tipo —
        // misma proporción usada para prorratear pesos y para prorratear
        // motos/carros (no hay detalle semanal de vehículo, solo mensual).
        const ratioConvenio = totalAsesor.convenio > 0 ? s.convenio / totalAsesor.convenio : 0
        const ratioComercial = totalAsesor.comercial > 0 ? s.comercial / totalAsesor.comercial : 0

        if (detalle) {
          pesosConvenio =
            (detalle.livianosConvenio * detalle.tarifaCarro + detalle.motosConvenio * detalle.tarifaMoto) *
            ratioConvenio
          pesosComercial =
            (detalle.livianosPropio * detalle.tarifaCarro + detalle.motosPropio * detalle.tarifaMoto) *
            ratioComercial
          motos = detalle.motosConvenio * ratioConvenio + detalle.motosPropio * ratioComercial
          carros = detalle.livianosConvenio * ratioConvenio + detalle.livianosPropio * ratioComercial
        } else {
          pesosConvenio = s.convenio * VALOR_ESTIMADO_ASESOR_CONVENIO
          pesosComercial = s.comercial * VALOR_ESTIMADO_ASESOR_COMERCIAL
        }

        if (!semanaAgregada.has(s.inicio)) {
          semanaAgregada.set(s.inicio, {
            inicio: s.inicio,
            fin: s.fin,
            cantidadConvenio: 0,
            cantidadComercial: 0,
            pesosConvenio: 0,
            pesosComercial: 0,
            cantidadMotos: cantidadVehiculoDisponible ? 0 : null,
            cantidadCarros: cantidadVehiculoDisponible ? 0 : null,
          })
        }
        const acc = semanaAgregada.get(s.inicio)!
        acc.cantidadConvenio += s.convenio
        acc.cantidadComercial += s.comercial
        acc.pesosConvenio += pesosConvenio
        acc.pesosComercial += pesosComercial
        if (acc.cantidadMotos !== null) acc.cantidadMotos += motos ?? 0
        if (acc.cantidadCarros !== null) acc.cantidadCarros += carros ?? 0
      }
    }

    // Redondear motos/carros a ENTEROS acá, una sola vez por semana — así
    // cantidad_total (motos + carros) en metaComercialSemanal siempre cuadra
    // exacto contra las dos columnas ya redondeadas, sin decimales sueltos
    // ni descuadres por redondear cada columna por separado en otro punto.
    const semanas = Array.from(semanaAgregada.values())
      .sort((a, b) => a.inicio.localeCompare(b.inicio))
      .map((s) => ({
        ...s,
        cantidadMotos: s.cantidadMotos !== null ? Math.round(s.cantidadMotos) : null,
        cantidadCarros: s.cantidadCarros !== null ? Math.round(s.cantidadCarros) : null,
      }))

    return { semanas, esEstimado: vehiculoMap.size === 0, cantidadVehiculoDisponible }
  }

  /**
   * GET /reportes-admin/meta-comercial/semanal?mes=&anio=&asesor_id=
   * Funciona para AMBAS fuentes:
   *  - histórico: lee historico_comercial_asesor y prorratea el total
   *    mensual real por tipo de vehículo (calcularSemanasHistoricas) cuando
   *    exista detalle; si no, tarifa plana estimada.
   *  - real: agrupa comisiones por semana con semanaSabadoViernes().
   *
   * Cada semana trae DOS comparaciones contra la meta, para que la tabla no
   * confunda "esta semana sola no llega al 100%" con "el mes va mal":
   *  - pesos_total / pct_vs_meta: aporte de ESA semana únicamente.
   *  - acumulado_total / pct_acumulado_vs_meta: suma corrida desde el inicio
   *    del mes — en la última semana coincide exactamente con el total y el
   *    % de metaComercialResumen para ese asesor/mes.
   */
  public async metaComercialSemanal({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const { asesorId, asesorNombre, error: asesorError } = await this.resolveAsesorFiltro(request)
    if (asesorError) return response.badRequest({ message: asesorError })

    const esReal = esFuenteRealComercial(mes, anio)
    const metaPesos = await this.metaPesosDelMes(asesorId, mes, anio)

    const semanas: {
      inicio: string
      fin: string
      cantidad_convenio: number | null
      cantidad_comercial: number | null
      cantidad_total: number | null
      cantidad_motos: number | null
      cantidad_carros: number | null
      pesos_convenio: number
      pesos_comercial: number
      pesos_total: number
      pct_vs_meta: number | null
      acumulado_convenio: number
      acumulado_comercial: number
      acumulado_total: number
      pct_acumulado_vs_meta: number | null
    }[] = []

    if (esReal) {
      const query = Database.from('comisiones as c')
        .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
        .where('c.es_config', false)
        .where('c.tipo_servicio', 'RTM')
        .whereIn('c.estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
        .whereRaw('MONTH(c.fecha_calculo) = ? AND YEAR(c.fecha_calculo) = ?', [mes, anio])
        .select(Database.raw("DATE_FORMAT(c.fecha_calculo, '%Y-%m-%d') as fecha"), 'a.tipo', 'c.tipo_vehiculo')
        .select('c.monto_asesor')
      if (asesorId) query.andWhere('c.asesor_id', asesorId)

      const rows = (await query) as {
        fecha: string
        tipo: string
        tipo_vehiculo: string | null
        monto_asesor: string
      }[]

      const semanasMap = new Map<
        string,
        { inicio: string; fin: string; convenio: number; comercial: number; motos: number; carros: number }
      >()
      for (const r of rows) {
        const { inicio, fin } = semanaSabadoViernes(DateTime.fromISO(r.fecha))
        const key = inicio.toISODate() as string
        if (!semanasMap.has(key)) {
          semanasMap.set(key, {
            inicio: key,
            fin: fin.toISODate() as string,
            convenio: 0,
            comercial: 0,
            motos: 0,
            carros: 0,
          })
        }
        const s = semanasMap.get(key)!
        if (r.tipo === 'ASESOR_CONVENIO') s.convenio += Number(r.monto_asesor)
        else s.comercial += Number(r.monto_asesor)
        if (r.tipo_vehiculo === 'MOTO') s.motos += 1
        else if (r.tipo_vehiculo === 'VEHICULO') s.carros += 1
      }

      let acumConvenioReal = 0
      let acumComercialReal = 0
      for (const s of Array.from(semanasMap.values()).sort((a, b) => a.inicio.localeCompare(b.inicio))) {
        const total = s.convenio + s.comercial
        acumConvenioReal += s.convenio
        acumComercialReal += s.comercial
        const acumuladoTotal = acumConvenioReal + acumComercialReal
        semanas.push({
          inicio: s.inicio,
          fin: s.fin,
          cantidad_convenio: null,
          cantidad_comercial: null,
          cantidad_total: s.motos + s.carros,
          cantidad_motos: s.motos,
          cantidad_carros: s.carros,
          pesos_convenio: s.convenio,
          pesos_comercial: s.comercial,
          pesos_total: total,
          pct_vs_meta: calcularPct(total, metaPesos ?? 0),
          acumulado_convenio: acumConvenioReal,
          acumulado_comercial: acumComercialReal,
          acumulado_total: acumuladoTotal,
          pct_acumulado_vs_meta: calcularPct(acumuladoTotal, metaPesos ?? 0),
        })
      }
    }

    let esEstimadoHistorico = true
    let cantidadVehiculoEstimada = false
    if (!esReal) {
      const {
        semanas: semanasCalc,
        esEstimado,
        cantidadVehiculoDisponible,
      } = await this.calcularSemanasHistoricas(asesorId, mes, anio)
      esEstimadoHistorico = esEstimado
      // El desglose moto/carro histórico SIEMPRE es prorrateado (solo hay
      // detalle mensual, no semanal) — a diferencia de pesos, que puede ser
      // "real" cuando existe historico_comercial_vehiculo_mensual. Se marca
      // aparte para no confundirlo con el conteo exacto de meses reales.
      cantidadVehiculoEstimada = cantidadVehiculoDisponible

      let acumConvenioHist = 0
      let acumComercialHist = 0
      for (const s of semanasCalc) {
        const total = s.pesosConvenio + s.pesosComercial
        acumConvenioHist += s.pesosConvenio
        acumComercialHist += s.pesosComercial
        const acumuladoTotal = acumConvenioHist + acumComercialHist
        semanas.push({
          inicio: s.inicio,
          fin: s.fin,
          cantidad_convenio: s.cantidadConvenio,
          cantidad_comercial: s.cantidadComercial,
          cantidad_total:
            s.cantidadMotos !== null && s.cantidadCarros !== null
              ? s.cantidadMotos + s.cantidadCarros
              : null,
          cantidad_motos: s.cantidadMotos,
          cantidad_carros: s.cantidadCarros,
          pesos_convenio: s.pesosConvenio,
          pesos_comercial: s.pesosComercial,
          pesos_total: total,
          pct_vs_meta: calcularPct(total, metaPesos ?? 0),
          acumulado_convenio: acumConvenioHist,
          acumulado_comercial: acumComercialHist,
          acumulado_total: acumuladoTotal,
          pct_acumulado_vs_meta: calcularPct(acumuladoTotal, metaPesos ?? 0),
        })
      }
    }

    return response.ok({
      mes,
      anio,
      asesor_id: asesorId,
      asesor_nombre: asesorNombre,
      fuente: esReal ? 'real' : 'historico',
      es_estimado: esReal ? false : esEstimadoHistorico,
      cantidad_vehiculo_estimada: esReal ? false : cantidadVehiculoEstimada,
      meta_pesos: metaPesos,
      semanas,
    })
  }

  /**
   * GET /reportes-admin/meta-comercial/proyectado?mes=&anio=&asesor_id=
   *  - mes >= corte (mes real en curso) → mismo patrón que
   *    metaMensualProyectado: promedio de lo transcurrido, proyección a fin
   *    de mes, granularidad diaria (reutiliza la agregación de
   *    metaComercialDiario).
   *  - mes < corte (histórico, ya cerrado) → NO se proyecta: el mes ya
   *    terminó, así que "proyeccion_cierre" es simplemente el total
   *    real/estimado ya conocido (calcularSemanasHistoricas), no una
   *    extrapolación. Granularidad semanal (no hay detalle diario).
   */
  public async metaComercialProyectado({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const { asesorId, asesorNombre, error: asesorError } = await this.resolveAsesorFiltro(request)
    if (asesorError) return response.badRequest({ message: asesorError })

    const esReal = esFuenteRealComercial(mes, anio)
    const metaPesos = await this.metaPesosDelMes(asesorId, mes, anio)
    const diasDelMes = DateTime.fromObject({ year: anio, month: mes }).daysInMonth as number

    if (esReal) {
      const query = Database.from('comisiones as c')
        .where('c.es_config', false)
        .where('c.tipo_servicio', 'RTM')
        .whereIn('c.estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
        .whereRaw('MONTH(c.fecha_calculo) = ? AND YEAR(c.fecha_calculo) = ?', [mes, anio])
        .select(Database.raw("DATE_FORMAT(c.fecha_calculo, '%Y-%m-%d') as fecha"))
        .sum('c.monto_asesor as total')
        .groupBy('fecha')
      if (asesorId) query.andWhere('c.asesor_id', asesorId)

      const rows = (await query) as { fecha: string; total: string }[]
      const porDia = new Map(rows.map((r) => [r.fecha, Number(r.total)]))

      const now = DateTime.now()
      const esMesActual = mes === now.month && anio === now.year
      const diasTranscurridos = esMesActual ? now.day : diasDelMes

      let acumulado = 0
      const periodos = []
      for (let d = 1; d <= diasTranscurridos; d++) {
        const fechaStr = DateTime.fromObject({ year: anio, month: mes, day: d }).toISODate() as string
        acumulado += porDia.get(fechaStr) ?? 0
        periodos.push({
          etiqueta: fechaStr,
          acumulado,
          promedio: Math.round((acumulado / d) * 100) / 100,
          proyeccion: Math.round((acumulado / d) * diasDelMes),
        })
      }

      const ultimo = periodos[periodos.length - 1] ?? null
      const proyeccionCierre = ultimo?.proyeccion ?? 0

      return response.ok({
        mes,
        anio,
        asesor_id: asesorId,
        asesor_nombre: asesorNombre,
        fuente: 'real',
        granularidad: 'diaria',
        meta_pesos: metaPesos,
        periodos_transcurridos: diasTranscurridos,
        periodos_totales: diasDelMes,
        resumen: ultimo
          ? {
              promedio_por_periodo: ultimo.promedio,
              proyeccion_cierre: proyeccionCierre,
              pct_proyeccion: calcularPct(proyeccionCierre, metaPesos ?? 0),
            }
          : null,
        periodos,
      })
    }

    // ── Histórico: granularidad semanal, mes ya cerrado → NO se
    // extrapola. Se muestra el total real/estimado ya conocido (mismo
    // prorrateo real por vehículo que Semanal/Resumen cuando hay detalle).
    const { semanas: semanasCalc, esEstimado } = await this.calcularSemanasHistoricas(
      asesorId,
      mes,
      anio
    )
    const semanasTotalesMes = Math.ceil(diasDelMes / 7)

    let acumulado = 0
    const periodos = semanasCalc.map((s, idx) => {
      acumulado += s.pesosConvenio + s.pesosComercial
      const n = idx + 1
      return {
        etiqueta: `${s.inicio} — ${s.fin}`,
        acumulado,
        promedio: Math.round(acumulado / n),
        proyeccion: acumulado,
      }
    })

    const ultimo = periodos[periodos.length - 1] ?? null
    const totalFinal = ultimo?.acumulado ?? 0

    return response.ok({
      mes,
      anio,
      asesor_id: asesorId,
      asesor_nombre: asesorNombre,
      fuente: 'historico',
      granularidad: 'semanal',
      es_estimado: esEstimado,
      nota: 'Mes histórico ya cerrado — se muestra el total real/estimado ya conocido, no una proyección.',
      meta_pesos: metaPesos,
      periodos_transcurridos: semanasCalc.length,
      periodos_totales: semanasTotalesMes,
      resumen: ultimo
        ? {
            promedio_por_periodo: ultimo.promedio,
            proyeccion_cierre: totalFinal,
            pct_proyeccion: calcularPct(totalFinal, metaPesos ?? 0),
          }
        : null,
      periodos,
    })
  }

  /**
   * GET /reportes-admin/meta-comercial/detalle-vehiculo?mes=&anio=&asesor_id=
   * Desglose por tipo de vehículo (livianos/motos × convenio/propio) para UN
   * asesor puntual. asesor_id es OBLIGATORIO: esta vista no tiene sentido
   * agregada para "todos los asesores" (mezclaría categorías de personas
   * distintas).
   *
   *  - mes >= corte (real): calculado en vivo desde `comisiones` — la tabla
   *    ya trae `tipo_vehiculo` (MOTO/VEHICULO) por fila, y `convenio_id`
   *    (NULL = captación propia, no NULL = referida por convenio) separa
   *    convenio/propio sin necesidad de cruzar con turnos_rtms. `tarifa` va
   *    null por categoría (son montos reales de comisión, no cantidad ×
   *    tarifa plana). Siempre `disponible:true` para meses reales (aunque
   *    algún asesor tenga 0 en todas las categorías ese mes).
   *  - mes < corte (histórico): leído directo de
   *    historico_comercial_vehiculo_mensual (feb-may/2026 hoy). Si el
   *    asesor/mes no tiene fila cargada ahí, responde `disponible:false` —
   *    el frontend debe simplemente no mostrar la sección, sin tabla vacía
   *    ni error.
   */
  public async metaComercialDetalleVehiculo({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const asesorIdRaw = request.input('asesor_id')
    const asesorId = Number(asesorIdRaw)
    if (!asesorIdRaw || !Number.isInteger(asesorId) || asesorId <= 0) {
      return response.badRequest({ message: 'asesor_id es obligatorio para este reporte' })
    }
    const asesor = await AgenteCaptacion.find(asesorId)
    if (!asesor) return response.badRequest({ message: 'asesor_id no existe' })

    const metaPesos = await this.metaPesosDelMes(asesorId, mes, anio)

    if (esFuenteRealComercial(mes, anio)) {
      // Meses reales: comisiones ya trae tipo_vehiculo (MOTO/VEHICULO) por
      // fila, y convenio_id (NULL = captación propia, no NULL = referida por
      // convenio) — no hace falta cruzar con turnos_rtms. Verificado contra
      // los totales ya conocidos de junio/2026 (Esteban $298.200, Henry
      // $205.200, Steven $148.300): la suma de las 4 categorías cuadra exacto.
      const rows = (await Database.from('comisiones')
        .where('asesor_id', asesorId)
        .where('es_config', false)
        .where('tipo_servicio', 'RTM')
        .whereIn('estado', ['PENDIENTE', 'APROBADA', 'PAGADA'])
        .whereRaw('MONTH(fecha_calculo) = ? AND YEAR(fecha_calculo) = ?', [mes, anio])
        .whereNotNull('tipo_vehiculo')
        .select(
          'tipo_vehiculo',
          Database.raw('CASE WHEN convenio_id IS NULL THEN 0 ELSE 1 END as es_convenio')
        )
        .count('* as cantidad')
        .sum('monto_asesor as total')
        .groupBy('tipo_vehiculo', 'es_convenio')) as {
        tipo_vehiculo: string
        es_convenio: number
        cantidad: string
        total: string
      }[]

      const acumulado = {
        livianoConvenio: { cantidad: 0, pesos: 0 },
        motoConvenio: { cantidad: 0, pesos: 0 },
        livianoPropio: { cantidad: 0, pesos: 0 },
        motoPropio: { cantidad: 0, pesos: 0 },
      }
      for (const r of rows) {
        const cantidad = Number(r.cantidad)
        const pesos = Number(r.total) || 0
        const esConvenio = Number(r.es_convenio) === 1
        const bucket =
          r.tipo_vehiculo === 'MOTO'
            ? esConvenio
              ? acumulado.motoConvenio
              : acumulado.motoPropio
            : esConvenio
              ? acumulado.livianoConvenio
              : acumulado.livianoPropio
        bucket.cantidad += cantidad
        bucket.pesos += pesos
      }

      const categorias = [
        { categoria: 'Livianos Convenio', cantidad: acumulado.livianoConvenio.cantidad, tarifa: null, pesos: acumulado.livianoConvenio.pesos },
        { categoria: 'Motos Convenio', cantidad: acumulado.motoConvenio.cantidad, tarifa: null, pesos: acumulado.motoConvenio.pesos },
        { categoria: 'Livianos Propio', cantidad: acumulado.livianoPropio.cantidad, tarifa: null, pesos: acumulado.livianoPropio.pesos },
        { categoria: 'Motos Propio', cantidad: acumulado.motoPropio.cantidad, tarifa: null, pesos: acumulado.motoPropio.pesos },
      ]

      const total = {
        cantidad: categorias.reduce((acc, c) => acc + c.cantidad, 0),
        pesos: categorias.reduce((acc, c) => acc + c.pesos, 0),
      }

      return response.ok({
        mes,
        anio,
        asesor_id: asesorId,
        asesor_nombre: asesor.nombre,
        fuente: 'real',
        disponible: true,
        categorias,
        total,
        meta_pesos: metaPesos,
      })
    }

    const fila = (await Database.from('historico_comercial_vehiculo_mensual')
      .where({ asesor_id: asesorId, mes, anio })
      .first()) as
      | {
          livianos_convenio: number
          motos_convenio: number
          livianos_propio: number
          motos_propio: number
          tarifa_carro: string
          tarifa_moto: string
        }
      | undefined

    if (!fila) {
      return response.ok({
        mes,
        anio,
        asesor_id: asesorId,
        asesor_nombre: asesor.nombre,
        fuente: 'historico',
        disponible: false,
        categorias: null,
        total: null,
        meta_pesos: null,
      })
    }

    const tarifaCarro = Number(fila.tarifa_carro)
    const tarifaMoto = Number(fila.tarifa_moto)

    const categorias = [
      {
        categoria: 'Livianos Convenio',
        cantidad: Number(fila.livianos_convenio),
        tarifa: tarifaCarro,
        pesos: Number(fila.livianos_convenio) * tarifaCarro,
      },
      {
        categoria: 'Motos Convenio',
        cantidad: Number(fila.motos_convenio),
        tarifa: tarifaMoto,
        pesos: Number(fila.motos_convenio) * tarifaMoto,
      },
      {
        categoria: 'Livianos Propio',
        cantidad: Number(fila.livianos_propio),
        tarifa: tarifaCarro,
        pesos: Number(fila.livianos_propio) * tarifaCarro,
      },
      {
        categoria: 'Motos Propio',
        cantidad: Number(fila.motos_propio),
        tarifa: tarifaMoto,
        pesos: Number(fila.motos_propio) * tarifaMoto,
      },
    ]

    const total = {
      cantidad: categorias.reduce((acc, c) => acc + c.cantidad, 0),
      pesos: categorias.reduce((acc, c) => acc + c.pesos, 0),
    }

    return response.ok({
      mes,
      anio,
      asesor_id: asesorId,
      asesor_nombre: asesor.nombre,
      fuente: 'historico',
      disponible: true,
      categorias,
      total,
      meta_pesos: metaPesos,
    })
  }

  /**
   * GET /reportes-admin/meta-comercial/ingreso-real-dateo?mes=&anio=&asesor_id=
   * Ingreso real de caja generado por cada dateo EXITOSO de UN asesor
   * puntual (asesor_id es obligatorio). Cruce dateo → factura vía
   * captacion_dateos.consumido_turno_id = facturacion_tickets.turno_id
   * (facturacion_tickets.dateo_id casi no se usa — 1/82 casos en los datos
   * actuales, no sirve como cruce confiable), filtrando
   * facturacion_tickets.estado = 'CONFIRMADA'. El ingreso reportado es
   * facturacion_tickets.total (ya neto del descuento aplicado), NO
   * comisiones.monto_asesor (eso es el pago al asesor, otra cosa).
   *
   * Expone tanto el descuento de catálogo (descuento_monto_aplicado) como el
   * verificado (total_sin_descuento - total): en este entorno de pruebas el
   * stub de OCR nunca restó realmente el descuento, así que
   * total_sin_descuento == total en todos los casos sembrados aunque
   * descuento_monto_aplicado sea > 0. Se exponen ambos valores para que la
   * discrepancia sea visible en vez de ocultarla.
   */
  public async metaComercialIngresoRealDateo({ request, response }: HttpContext) {
    const { mes, anio, error } = this.parseMesAnio(request)
    if (error) return response.badRequest({ message: error })

    const asesorIdRaw = request.input('asesor_id')
    const asesorId = Number(asesorIdRaw)
    if (!asesorIdRaw || !Number.isInteger(asesorId) || asesorId <= 0) {
      return response.badRequest({ message: 'asesor_id es obligatorio para este reporte' })
    }
    const asesor = await AgenteCaptacion.find(asesorId)
    if (!asesor) return response.badRequest({ message: 'asesor_id no existe' })

    const rows = (await Database.from('captacion_dateos as cd')
      .innerJoin('facturacion_tickets as ft', 'ft.turno_id', 'cd.consumido_turno_id')
      .leftJoin('descuentos as d', 'd.id', 'ft.descuento_id')
      .leftJoin('comisiones as com', (q) => {
        q.on('com.captacion_dateo_id', 'cd.id').andOnVal('com.es_config', false)
      })
      .where('ft.estado', 'CONFIRMADA')
      .where('ft.servicio_codigo', 'RTM')
      .where('cd.resultado', 'EXITOSO')
      .whereIn('cd.canal', ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'])
      .where('cd.agente_id', asesorId)
      .whereRaw('MONTH(cd.created_at) = ? AND YEAR(cd.created_at) = ?', [mes, anio])
      .select(
        'cd.id as dateo_id',
        'cd.created_at as fecha',
        'cd.convenio_id as convenio_id',
        'ft.tipo_vehiculo as tipo_vehiculo',
        'ft.total as total',
        'ft.total_sin_descuento as total_sin_descuento',
        'ft.descuento_id as descuento_id',
        'ft.descuento_monto_aplicado as descuento_monto_aplicado',
        'd.nombre as descuento_nombre',
        'ft.placa as placa',
        'com.monto_asesor as monto_asesor',
        'com.estado as comision_estado'
      )
      .orderBy('cd.created_at', 'asc')) as {
      dateo_id: number
      fecha: Date | string
      convenio_id: number | null
      tipo_vehiculo: string | null
      total: string | null
      total_sin_descuento: string | null
      descuento_id: number | null
      descuento_monto_aplicado: string | null
      descuento_nombre: string | null
      placa: string | null
      monto_asesor: string | null
      comision_estado: string | null
    }[]

    const detalle = rows.map((r) => {
      const ingresoReal = Number(r.total) || 0
      const totalSinDescuento =
        r.total_sin_descuento === null ? ingresoReal : Number(r.total_sin_descuento)

      return {
        dateo_id: r.dateo_id,
        fecha: DateTime.fromJSDate(new Date(r.fecha)).toISODate(),
        tipo_captacion: (r.convenio_id === null ? 'NUEVO_DIRECTO' : 'CONVENIO') as
          | 'NUEVO_DIRECTO'
          | 'CONVENIO',
        tipo_vehiculo: tipoVehiculoCarroMoto(r.tipo_vehiculo),
        ingreso_real: ingresoReal,
        tuvo_descuento: r.descuento_id !== null,
        descuento_nombre: r.descuento_nombre,
        descuento_monto: r.descuento_monto_aplicado === null ? 0 : Number(r.descuento_monto_aplicado),
        descuento_verificado: Math.round((totalSinDescuento - ingresoReal) * 100) / 100,
        placa: r.placa,
        // Valor crudo tal como está en comisiones — incluye comisiones ANULADAS
        // (se excluyen solo de los acumulados, no de esta columna individual).
        comision_asesor: r.monto_asesor === null ? null : Number(r.monto_asesor),
        // Expuesto para que el frontend pueda replicar la misma exclusión al
        // recalcular los acumulados sobre un subconjunto filtrado en memoria.
        comision_anulada: r.comision_estado === 'ANULADA',
      }
    })

    const acumulado = {
      nuevo_directo: { cantidad: 0, ingreso_real: 0, comision_asesor_total: 0 },
      convenio: { cantidad: 0, ingreso_real: 0, comision_asesor_total: 0 },
      total: { cantidad: 0, ingreso_real: 0, comision_asesor_total: 0 },
    }
    for (const fila of detalle) {
      const bucket = fila.tipo_captacion === 'CONVENIO' ? acumulado.convenio : acumulado.nuevo_directo
      bucket.cantidad += 1
      bucket.ingreso_real += fila.ingreso_real
      acumulado.total.cantidad += 1
      acumulado.total.ingreso_real += fila.ingreso_real

      // Comisiones ANULADAS no se le pagan al asesor: se excluyen de los acumulados.
      if (fila.comision_asesor !== null && !fila.comision_anulada) {
        bucket.comision_asesor_total += fila.comision_asesor
        acumulado.total.comision_asesor_total += fila.comision_asesor
      }
    }

    const resumenDescuentosPorNombre = new Map<string, { cantidad: number; monto_total: number }>()
    for (const fila of detalle) {
      if (!fila.tuvo_descuento) continue
      const nombre = fila.descuento_nombre ?? 'Sin nombre'
      const actual = resumenDescuentosPorNombre.get(nombre) ?? { cantidad: 0, monto_total: 0 }
      actual.cantidad += 1
      actual.monto_total += fila.descuento_monto
      resumenDescuentosPorNombre.set(nombre, actual)
    }

    const resumenDescuentosPorTipo = Array.from(resumenDescuentosPorNombre.entries())
      .map(([descuento_nombre, v]) => ({
        descuento_nombre,
        cantidad: v.cantidad,
        monto_total: Math.round(v.monto_total * 100) / 100,
      }))
      .sort((a, b) => b.monto_total - a.monto_total)

    const resumenDescuentosTotal = resumenDescuentosPorTipo.reduce(
      (acc, r) => {
        acc.cantidad += r.cantidad
        acc.monto_total += r.monto_total
        return acc
      },
      { cantidad: 0, monto_total: 0 }
    )

    return response.ok({
      mes,
      anio,
      asesor_id: asesorId,
      asesor_nombre: asesor.nombre,
      detalle,
      acumulado,
      resumen_descuentos: {
        por_tipo: resumenDescuentosPorTipo,
        total: resumenDescuentosTotal,
      },
    })
  }

  /**
   * Meta en pesos del mes: si asesorId viene, la meta puntual de ese
   * asesor; si no viene (modo "todos"), la SUMA de las metas de todos los
   * asesores con fila configurada ese mes. null si no hay ninguna meta.
   */
  private async metaPesosDelMes(
    asesorId: number | null,
    mes: number,
    anio: number
  ): Promise<number | null> {
    const query = Database.from('meta_comercial_asesor').where({ mes, anio })
    if (asesorId) query.andWhere('asesor_id', asesorId)
    const rows = (await query.select('meta_pesos')) as { meta_pesos: string }[]
    if (rows.length === 0) return null
    return rows.reduce((acc, r) => acc + Number(r.meta_pesos), 0)
  }

  /**
   * GET /reportes-admin/super-informe/pdf?fecha_inicio=&fecha_fin=
   * Súper Informe consolidado: portada + 7 secciones (Meta Mensual, Meta
   * Comercial por Asesor, Ingresos por Canal, Servicios (RTM), Retención
   * de Clientes, Descuentos, Producción por Líder). Reutiliza exactamente
   * los mismos compute*() ya verificados contra cada reporte individual —
   * no recalcula nada por su cuenta (salvo el rango anterior de Ingresos
   * por Canal, usado solo para el comparativo).
   */
  public async superInformePdf({ request, response, auth }: HttpContext) {
    const { fechaInicio, fechaFin, error } = parseRangoFechas(request)
    if (error) return response.badRequest({ message: error })

    const rangoAnterior = calcularRangoAnterior(fechaInicio, fechaFin)

    const [
      metaMensual,
      metaComercial,
      ingresosCanal,
      ingresosCanalAnterior,
      servicios,
      retencion,
      descuentosTipo,
      descuentosCanal,
      descuentosAutorizador,
      produccionLider,
    ] = await Promise.all([
      this.computeMetaMensualSuperInforme(fechaInicio, fechaFin),
      this.computeMetaComercialSuperInforme(fechaInicio, fechaFin),
      this.computeIngresosPorCanal(fechaInicio, fechaFin),
      this.computeIngresosPorCanal(rangoAnterior.inicio, rangoAnterior.fin),
      this.computeReporteServicios(fechaInicio, fechaFin),
      this.computeRetencionClientes(fechaInicio, fechaFin),
      this.computeDescuentosPorTipo(fechaInicio, fechaFin),
      this.computeDescuentosPorCanal(fechaInicio, fechaFin),
      this.computeDescuentosPorAutorizador(fechaInicio, fechaFin),
      this.computeProduccionPorLider(fechaInicio, fechaFin),
    ])

    const generadoPor = auth.user ? `${auth.user.nombres} ${auth.user.apellidos}` : 'Usuario del sistema'

    const buffer = await construirSuperInformePdf({
      fechaInicio,
      fechaFin,
      generadoPor,
      metaMensual,
      metaComercial,
      ingresosCanal,
      ingresosCanalAnterior,
      servicios,
      retencion,
      descuentosTipo,
      descuentosCanal,
      descuentosAutorizador,
      produccionLider,
    })

    const fileName = `Super_Informe_${fechaInicio}_${fechaFin}.pdf`
    response.header('Content-Type', 'application/pdf')
    response.header('Content-Disposition', `attachment; filename="${fileName}"`)
    return response.send(buffer)
  }
}
