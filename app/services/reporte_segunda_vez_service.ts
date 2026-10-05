// app/services/reporte_segunda_vez_service.ts
//
// Reporte de segundas veces (Entrega C2, solo conteos, sin dinero).
// GET /reportes-admin/segunda-vez (+ /excel).
//
// Universo: rechazos de RTM y PREV que NO son segunda vez (un rechazo de una
// segunda vez no abre ventana), sin placas TST%, con fecha de turno en el
// rango. Incluye los rechazos que luego se corrigieron a APROBADA (auditoría
// certificacion_resultado_cambios): su ventana quedó anulada.
//
// El estado de cada ventana sale de las reglas compartidas de
// segunda_vez_service.ts — estadoVentana() + clasificarPosteriores() — no se
// reimplementa aquí:
//   ABIERTA · USADA (tiene su segunda vez) · VENCIDA (no regresó) ·
//   SUPERADA (hubo otro turno después que no es su segunda vez, p. ej. pagó
//   normal) · ANULADA (origen cancelado o rechazo corregido a APROBADA).
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import ExcelJS from 'exceljs'
import {
  SERVICIOS_SEGUNDA_VEZ,
  ZONA_SEGUNDA_VEZ,
  clasificarPosteriores,
  estadoVentana,
  excluirSegundaVez,
  type EstadoVentanaSegundaVez,
  type FilaPosterior,
} from '#services/segunda_vez_service'

/** Regreso pagando normal después de vencida la ventana: hasta este margen. */
const DIAS_REGRESO_TRAS_VENCER = 30
/** Rango que termina hace menos de esto: aún puede haber ventanas abiertas. */
const DIAS_AVISO_RANGO_RECIENTE = 15

export const ESTADOS_REPORTE: EstadoVentanaSegundaVez[] = [
  'ABIERTA',
  'USADA',
  'VENCIDA',
  'SUPERADA',
  'ANULADA',
]

export interface FiltrosReporteSegundaVez {
  fechaInicio: string
  fechaFin: string
  servicio?: string | null
  sedeId?: number | null
  placa?: string | null
  estado?: string | null
}

interface FilaTurnoPosterior extends FilaPosterior {
  turno_codigo: string
  fecha: Date
  hora_ingreso: string
  resultado_certificacion: 'APROBADA' | 'RECHAZADA' | null
}

const aBogota = (v: Date | string | null | undefined): DateTime | null => {
  if (!v) return null
  const d = v instanceof Date ? DateTime.fromJSDate(v) : DateTime.fromSQL(String(v))
  return d.isValid ? d.setZone(ZONA_SEGUNDA_VEZ) : null
}

/** Llegada de un turno: su fecha + hora_ingreso (Bogotá). */
const llegadaDe = (t: { fecha: Date; hora_ingreso: string }): DateTime | null => {
  const dia = aBogota(t.fecha)?.toISODate()
  if (!dia) return null
  const hora = String(t.hora_ingreso ?? '').length === 5 ? `${t.hora_ingreso}:00` : t.hora_ingreso
  const d = DateTime.fromISO(`${dia}T${hora}`, { zone: ZONA_SEGUNDA_VEZ })
  return d.isValid ? d : null
}

// Mínimo 0: hora_ingreso se guarda sin segundos (HH:mm), así que una llegada
// en el mismo minuto del rechazo (o un rechazado_at movido por una corrección
// a RECHAZADA posterior a la llegada) daría horas negativas.
const horasEntre = (a: DateTime | null, b: DateTime | null) =>
  a && b ? Math.max(0, Math.round(b.diff(a, 'hours').hours * 100) / 100) : null

export async function calcularReporteSegundaVez(
  filtros: FiltrosReporteSegundaVez,
  ahora: DateTime = DateTime.now().setZone(ZONA_SEGUNDA_VEZ)
) {
  const servicios = filtros.servicio
    ? [String(filtros.servicio).toUpperCase()].filter((s) =>
        (SERVICIOS_SEGUNDA_VEZ as readonly string[]).includes(s)
      )
    : [...SERVICIOS_SEGUNDA_VEZ]

  const q = excluirSegundaVez(
    Database.from('turnos_rtms as t')
      .join('servicios as s', 's.id', 't.servicio_id')
      .leftJoin('sedes as se', 'se.id', 't.sede_id')
      .leftJoin('usuarios as u', 'u.id', 't.certificacion_funcionario_id')
      .whereIn('s.codigo_servicio', servicios.length ? servicios : ['__ninguno__'])
      .whereRaw("t.placa NOT LIKE 'TST%'")
      .whereRaw('DATE(t.fecha) BETWEEN ? AND ?', [filtros.fechaInicio, filtros.fechaFin])
      .where((w) => {
        w.where('t.resultado_certificacion', 'RECHAZADA').orWhereExists((sub) => {
          sub
            .from('certificacion_resultado_cambios as c')
            .whereRaw('c.turno_id = t.id')
            .where('c.resultado_anterior', 'RECHAZADA')
        })
      }),
    't'
  )
  if (filtros.sedeId) q.where('t.sede_id', filtros.sedeId)
  if (filtros.placa) q.where('t.placa', 'like', `%${String(filtros.placa).toUpperCase().trim()}%`)

  const origenes: any[] = await q
    .select(
      't.id',
      't.placa',
      't.servicio_id',
      's.codigo_servicio',
      't.sede_id',
      'se.nombre as sede_nombre',
      't.turno_codigo',
      't.fecha',
      't.estado',
      't.resultado_certificacion',
      't.rechazado_at',
      't.ventana_segunda_vez_hasta',
      'u.nombres as cert_nombres',
      'u.apellidos as cert_apellidos'
    )
    .select(
      Database.raw(
        "EXISTS (SELECT 1 FROM certificacion_resultado_cambios c WHERE c.turno_id = t.id AND c.resultado_anterior = 'RECHAZADA') AS rechazo_corregido"
      )
    )
    .orderBy('t.fecha', 'asc')
    .orderBy('t.id', 'asc')

  // Lo que vino después de cada origen (misma placa+servicio, id mayor), en una
  // sola consulta; clasificarPosteriores() aplica la regla de cada origen.
  const placas = [...new Set(origenes.map((o) => o.placa))]
  const posteriores: FilaTurnoPosterior[] = placas.length
    ? await Database.from('turnos_rtms')
        .whereIn('placa', placas)
        .whereIn('servicio_id', [...new Set(origenes.map((o) => o.servicio_id))])
        .where('id', '>', Math.min(...origenes.map((o) => o.id)))
        .select(
          'id',
          'placa',
          'servicio_id',
          'estado',
          'es_segunda_vez',
          'turno_origen_id',
          'turno_codigo',
          'fecha',
          'hora_ingreso',
          'resultado_certificacion'
        )
    : []

  const filas = origenes.map((o) => {
    const origen = { id: o.id, placa: o.placa, servicioId: Number(o.servicio_id) }
    const { hijo, posterior } = clasificarPosteriores(origen, posteriores)
    const hasta = aBogota(o.ventana_segunda_vez_hasta)
    const rechazadoAt = aBogota(o.rechazado_at)
    const corregido = Boolean(Number(o.rechazo_corregido))

    const estado: EstadoVentanaSegundaVez =
      !hasta && corregido
        ? 'ANULADA'
        : estadoVentana(
            {
              ventanaSegundaVezHasta: hasta,
              estado: o.estado,
              resultadoCertificacion: o.resultado_certificacion,
            },
            ahora,
            { hijoActivo: !!hijo, turnoPosterior: !!posterior }
          )

    const llegadaHijo = hijo ? llegadaDe(hijo) : null
    const llegadaPosterior = posterior ? llegadaDe(posterior) : null
    const pagoTrasVencer =
      estado === 'SUPERADA' &&
      !!hasta &&
      !!llegadaPosterior &&
      llegadaPosterior >= hasta &&
      llegadaPosterior <= hasta.plus({ days: DIAS_REGRESO_TRAS_VENCER })

    return {
      turno_origen_id: o.id,
      placa: o.placa,
      servicio: o.codigo_servicio,
      sede: o.sede_nombre ?? null,
      turno_origen_codigo: o.turno_codigo,
      turno_origen_fecha: aBogota(o.fecha)?.toISODate() ?? null,
      rechazado_at: rechazadoAt?.toISO() ?? null,
      certificado_por: [o.cert_nombres, o.cert_apellidos].filter(Boolean).join(' ').trim() || null,
      resultado_actual: o.resultado_certificacion ?? null,
      rechazo_corregido: corregido,
      ventana_hasta: hasta?.toISO() ?? null,
      estado,
      segunda_vez_codigo: hijo?.turno_codigo ?? null,
      segunda_vez_resultado: hijo ? (hijo.resultado_certificacion ?? 'PENDIENTE') : null,
      // Rechazo → regreso (segunda vez); si no regresó, rechazo → ahora.
      horas_transcurridas: horasEntre(rechazadoAt, llegadaHijo ?? ahora),
      regreso_tras_vencer_pagando: pagoTrasVencer,
      turno_posterior_codigo: posterior?.turno_codigo ?? null,
    }
  })

  // Indicadores: sobre todo el universo filtrado (el filtro de estado solo
  // recorta el detalle).
  const cuenta = (e: EstadoVentanaSegundaVez) => filas.filter((f) => f.estado === e).length
  const usadas = filas.filter((f) => f.estado === 'USADA')
  const vencidas = cuenta('VENCIDA')
  const horasRegreso = usadas
    .map((f) => f.horas_transcurridas)
    .filter((h): h is number => h !== null)
  const indicadores = {
    rechazos: filas.length,
    abiertas: cuenta('ABIERTA'),
    usadas: usadas.length,
    vencidas,
    superadas: cuenta('SUPERADA'),
    anuladas: cuenta('ANULADA'),
    tasa_regreso_pct:
      usadas.length + vencidas > 0
        ? Math.round((usadas.length / (usadas.length + vencidas)) * 10000) / 100
        : null,
    segundas_veces: {
      aprobadas: usadas.filter((f) => f.segunda_vez_resultado === 'APROBADA').length,
      rechazadas: usadas.filter((f) => f.segunda_vez_resultado === 'RECHAZADA').length,
      pendientes: usadas.filter((f) => f.segunda_vez_resultado === 'PENDIENTE').length,
    },
    horas_promedio_hasta_regreso: horasRegreso.length
      ? Math.round((horasRegreso.reduce((a, b) => a + b, 0) / horasRegreso.length) * 100) / 100
      : null,
    regresaron_tras_vencer_pagando: filas.filter((f) => f.regreso_tras_vencer_pagando).length,
  }

  const estadoFiltro = filtros.estado ? String(filtros.estado).toUpperCase() : null
  const detalle = estadoFiltro ? filas.filter((f) => f.estado === estadoFiltro) : filas

  const hoy = ahora.startOf('day')
  const fin = DateTime.fromISO(filtros.fechaFin, { zone: ZONA_SEGUNDA_VEZ }).startOf('day')
  const aviso =
    hoy.diff(fin, 'days').days < DIAS_AVISO_RANGO_RECIENTE
      ? `El rango termina hace menos de ${DIAS_AVISO_RANGO_RECIENTE} días: los rechazos recientes todavía pueden tener la ventana de segunda vez abierta, así que la tasa de regreso puede subir.`
      : null

  return {
    fecha_inicio: filtros.fechaInicio,
    fecha_fin: filtros.fechaFin,
    filtros: {
      servicio: filtros.servicio ?? null,
      sede_id: filtros.sedeId ?? null,
      placa: filtros.placa ?? null,
      estado: estadoFiltro,
    },
    generado_at: ahora.toISO(),
    aviso,
    indicadores,
    detalle,
  }
}

export type ReporteSegundaVez = Awaited<ReturnType<typeof calcularReporteSegundaVez>>

/** Excel: hoja "Resumen" con los indicadores y hoja "Detalle". */
export async function construirExcelReporteSegundaVez(data: ReporteSegundaVez): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const resumen = wb.addWorksheet('Resumen')
  resumen.columns = [
    { header: 'Indicador', key: 'k', width: 46 },
    { header: 'Valor', key: 'v', width: 18 },
  ]
  resumen.getRow(1).font = { bold: true }
  const i = data.indicadores
  const filasResumen: Array<[string, string | number | null]> = [
    ['Rango', `${data.fecha_inicio} a ${data.fecha_fin}`],
    ['Rechazos (RTM/PREV, sin segundas veces)', i.rechazos],
    ['Ventanas abiertas hoy', i.abiertas],
    ['Usadas (regresaron)', i.usadas],
    ['Vencidas (no regresaron)', i.vencidas],
    ['Superadas', i.superadas],
    ['Anuladas', i.anuladas],
    ['Tasa de regreso (usadas / (usadas + vencidas)) %', i.tasa_regreso_pct],
    ['Segundas veces aprobadas', i.segundas_veces.aprobadas],
    ['Segundas veces rechazadas', i.segundas_veces.rechazadas],
    ['Segundas veces pendientes', i.segundas_veces.pendientes],
    ['Horas promedio hasta el regreso', i.horas_promedio_hasta_regreso],
    ['Regresaron tras vencer y pagaron normal (≤30 días)', i.regresaron_tras_vencer_pagando],
  ]
  for (const [k, v] of filasResumen) resumen.addRow({ k, v: v ?? '—' })
  if (data.aviso) {
    resumen.addRow({})
    resumen.addRow({ k: `Aviso: ${data.aviso}` })
  }

  const detalle = wb.addWorksheet('Detalle')
  detalle.columns = [
    { header: 'Placa', key: 'placa', width: 12 },
    { header: 'Servicio', key: 'servicio', width: 10 },
    { header: 'Sede', key: 'sede', width: 16 },
    { header: 'Turno origen', key: 'turno_origen_codigo', width: 26 },
    { header: 'Fecha origen', key: 'turno_origen_fecha', width: 13 },
    { header: 'Rechazado', key: 'rechazado_at', width: 22 },
    { header: 'Certificó', key: 'certificado_por', width: 26 },
    { header: 'Ventana hasta', key: 'ventana_hasta', width: 22 },
    { header: 'Estado', key: 'estado', width: 11 },
    { header: 'Turno 2ª vez', key: 'segunda_vez_codigo', width: 26 },
    { header: 'Resultado 2ª vez', key: 'segunda_vez_resultado', width: 16 },
    { header: 'Horas transcurridas', key: 'horas_transcurridas', width: 18 },
  ]
  detalle.getRow(1).font = { bold: true }
  for (const f of data.detalle) detalle.addRow(f)

  return Buffer.from(await wb.xlsx.writeBuffer())
}
