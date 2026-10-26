// app/services/resumen_contable_service.ts
//
// Resumen contable RTM y servicios del Súper Informe (sección 8).
// GET /reportes-admin/super-informe/resumen-contable + PDF del Súper Informe.
//
// Mismo cálculo que Turnos del Día → Estadísticas
// (front: src/views/rtm/resumenContable.ts), sobre un rango de días:
//  - Base: turnos_rtms con fecha en el rango (DATE, día de Bogotá), estado
//    distinto de 'cancelado'/'inactivo' (igual que Turnos del Día, así el
//    rango suma lo mismo que los días sueltos) y sin placas TST%.
//  - Las segundas veces SE INCLUYEN (no se aplica excluirSegundaVez) y solo se
//    separan en RTM. Por eso esta sección puede diferir de las demás.
//  - Tipo de vehículo: 'Motocicleta' → motos; 'Liviano Particular' |
//    'Liviano Taxi' | 'Liviano Público' → livianos; lo demás → otros.
//  - % rechazo RTM = RECHAZADA / (APROBADA + RECHAZADA) sobre
//    resultado_certificacion; sin resultado va aparte; null si el
//    denominador es 0.
//  - sin_finalizar: turnos de la base aún en estado 'activo' (informativo; la
//    sección 1 cuenta solo finalizados).
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'

export const ZONA_RESUMEN_CONTABLE = 'America/Bogota'

export type GrupoVehiculo = 'motos' | 'livianos' | 'otros'

export interface TurnoParaResumen {
  servicioCodigo: string | null
  tipoVehiculo: string | null
  estado: string
  esSegundaVez?: boolean | number | null
  resultadoCertificacion?: 'APROBADA' | 'RECHAZADA' | null
}

export interface FilaResumen {
  clave: string
  etiqueta: string
  motos: number
  livianos: number
  otros: number
  total: number
  tipo: 'detalle' | 'subtotal' | 'total'
}

export interface RechazoRtm {
  aprobadas: number
  rechazadas: number
  sin_resultado: number
  /** null si no hay ningún turno con resultado (denominador 0). */
  porcentaje: number | null
}

export interface ResumenContable {
  filas: FilaResumen[]
  rechazo: { primera_vez: RechazoRtm; segunda_vez: RechazoRtm }
  sin_finalizar: number
}

export interface ResumenContableRango extends ResumenContable {
  fecha_inicio: string
  fecha_fin: string
}

/** Servicios que siempre tienen fila (aunque estén en 0), en este orden. */
const SERVICIOS_FIJOS = ['SOAT', 'PREV', 'PERI']
const SIN_SERVICIO = 'SIN SERVICIO'
const LIVIANOS = ['Liviano Particular', 'Liviano Taxi', 'Liviano Público']

export function grupoVehiculo(tipo: string | null | undefined): GrupoVehiculo {
  if (tipo === 'Motocicleta') return 'motos'
  if (tipo && LIVIANOS.includes(tipo)) return 'livianos'
  return 'otros'
}

function filaVacia(clave: string, etiqueta: string, tipo: FilaResumen['tipo']): FilaResumen {
  return { clave, etiqueta, motos: 0, livianos: 0, otros: 0, total: 0, tipo }
}

function sumar(fila: FilaResumen, grupo: GrupoVehiculo) {
  fila[grupo]++
  fila.total++
}

function rechazoVacio(): RechazoRtm {
  return { aprobadas: 0, rechazadas: 0, sin_resultado: 0, porcentaje: null }
}

/** Cálculo puro; excluye cancelados e inactivos aunque vengan en `turnos`. */
export function calcularResumenContable(turnos: TurnoParaResumen[]): ResumenContable {
  const rtmPrimera = filaVacia('RTM_PRIMERA', 'RTM · Primera vez', 'detalle')
  const rtmSegunda = filaVacia('RTM_SEGUNDA', 'RTM · Segunda vez', 'detalle')
  const rtmTotal = filaVacia('RTM_TOTAL', 'RTM · Total', 'subtotal')
  const otros = new Map<string, FilaResumen>()
  for (const s of SERVICIOS_FIJOS) otros.set(s, filaVacia(s, s, 'detalle'))
  const general = filaVacia('TOTAL', 'TOTAL GENERAL', 'total')
  const rechazo = { primera_vez: rechazoVacio(), segunda_vez: rechazoVacio() }
  let sinFinalizar = 0

  for (const t of turnos) {
    if (t.estado === 'cancelado' || t.estado === 'inactivo') continue
    if (t.estado !== 'finalizado') sinFinalizar++

    const grupo = grupoVehiculo(t.tipoVehiculo)
    const codigo = (t.servicioCodigo ?? '').trim().toUpperCase() || SIN_SERVICIO
    sumar(general, grupo)

    if (codigo === 'RTM') {
      const segunda = Boolean(t.esSegundaVez)
      sumar(segunda ? rtmSegunda : rtmPrimera, grupo)
      sumar(rtmTotal, grupo)

      const r = segunda ? rechazo.segunda_vez : rechazo.primera_vez
      if (t.resultadoCertificacion === 'RECHAZADA') r.rechazadas++
      else if (t.resultadoCertificacion === 'APROBADA') r.aprobadas++
      else r.sin_resultado++
      continue
    }

    if (!otros.has(codigo)) otros.set(codigo, filaVacia(codigo, codigo, 'detalle'))
    sumar(otros.get(codigo)!, grupo)
  }

  for (const r of [rechazo.primera_vez, rechazo.segunda_vez]) {
    const conResultado = r.aprobadas + r.rechazadas
    r.porcentaje = conResultado > 0 ? (r.rechazadas / conResultado) * 100 : null
  }

  // Fijos primero; los no previstos después, en orden alfabético.
  const extras = [...otros.keys()].filter((k) => !SERVICIOS_FIJOS.includes(k)).sort()
  const filasOtros = [...SERVICIOS_FIJOS, ...extras].map((k) => otros.get(k)!)

  return {
    filas: [rtmPrimera, rtmSegunda, rtmTotal, ...filasOtros, general],
    rechazo,
    sin_finalizar: sinFinalizar,
  }
}

/** "15,0% (3 de 20)" o "—" si no hay turnos con resultado (igual que textoRechazo del front). */
export function textoRechazo(r: RechazoRtm): string {
  if (r.porcentaje === null) return '—'
  const pct = r.porcentaje.toLocaleString('es-CO', {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  })
  return `${pct}% (${r.rechazadas} de ${r.aprobadas + r.rechazadas})`
}

/** Resumen del rango [fechaInicio, fechaFin] (YYYY-MM-DD, días de Bogotá). */
export async function obtenerResumenContable(
  fechaInicio: string,
  fechaFin: string
): Promise<ResumenContableRango> {
  const di = DateTime.fromISO(fechaInicio, { zone: ZONA_RESUMEN_CONTABLE })
  const df = DateTime.fromISO(fechaFin, { zone: ZONA_RESUMEN_CONTABLE })
  if (!di.isValid || !df.isValid) throw new Error('Rango de fechas inválido')

  const rows = (await Database.from('turnos_rtms as t')
    .leftJoin('servicios as s', 's.id', 't.servicio_id')
    .whereBetween('t.fecha', [di.toISODate()!, df.toISODate()!])
    .whereNotIn('t.estado', ['cancelado', 'inactivo'])
    .whereRaw("t.placa NOT LIKE 'TST%'")
    .select(
      's.codigo_servicio',
      't.tipo_vehiculo',
      't.estado',
      't.es_segunda_vez',
      't.resultado_certificacion'
    )) as {
    codigo_servicio: string | null
    tipo_vehiculo: string | null
    estado: string
    es_segunda_vez: number | null
    resultado_certificacion: 'APROBADA' | 'RECHAZADA' | null
  }[]

  const resumen = calcularResumenContable(
    rows.map((r) => ({
      servicioCodigo: r.codigo_servicio,
      tipoVehiculo: r.tipo_vehiculo,
      estado: r.estado,
      esSegundaVez: r.es_segunda_vez,
      resultadoCertificacion: r.resultado_certificacion,
    }))
  )
  return { fecha_inicio: fechaInicio, fecha_fin: fechaFin, ...resumen }
}
