// app/services/importacion_bogota/formato_bogota.ts
//
// Formato del archivo de Bogotá (BD_2022_ACT: 42 columnas A–AP, sin fila de
// títulos). Es el mismo reporte de Tecnoingeniería que el TECNOBASE de Ibagué
// pero SIN 6 columnas entre U y AA (clase, carrocería, cilindraje, capacidad,
// combustible...): el vehículo y la fecha están en las mismas letras y el
// dueño/conductor empiezan 6 columnas antes.
//
// Funciones PURAS (sin BD): leer una fila, normalizar y agrupar por
// placa + día. La escritura está en importacion_bogota_service.ts.

import { DateTime } from 'luxon'
import type { ResultadoCertificacion } from '#services/segunda_vez_service'

export const ZONA = 'America/Bogota'

/** Índices (base 0) de las columnas que se usan. */
export const COL = {
  FECHA: 2, // C  fecha y hora de la revisión
  ESTADO: 3, // D  APROBADO / RECHAZADO
  DURACION: 7, // H  duración (fracción de día)
  CATEGORIA: 8, // I  L1_LIVIANOS / L2_MOTOS
  TIPO: 9, // J  LIVIANO ORDINARIO, + TAXIMETRO, PREVENTIVA...
  PLACA: 10, // K
  MARCA: 12, // M
  LINEA: 13, // N
  MODELO: 14, // O
  MATRICULA: 16, // Q  (nº de motor; Ibagué lo guarda en vehiculos.matricula)
  COLOR: 20, // U
  DUENO_DOC_TIPO: 26, // AA
  DUENO_DOC_NUM: 27, // AB
  DUENO_NOMBRE: 28, // AC
  DUENO_TELEFONO: 32, // AG (celular)
  DUENO_EMAIL: 33, // AH
  COND_DOC_TIPO: 34, // AI
  COND_DOC_NUM: 35, // AJ
  COND_NOMBRE: 36, // AK
  COND_TELEFONO: 40, // AO (celular)
} as const

/** Columnas del archivo de Bogotá; más de esto suele ser el formato de Ibagué (48). */
export const MAX_COLUMNAS = 44

export type Celda = string | number | boolean | Date | null | undefined

export type MotivoDescarte =
  | 'FILA_VACIA'
  | 'PLACA_INVALIDA'
  | 'FECHA_INVALIDA'
  | 'ESTADO_DESCONOCIDO'
  | 'MISMO_DIA_UNIFICADA'

export const TEXTO_MOTIVO: Record<MotivoDescarte, string> = {
  FILA_VACIA: 'Fila vacía',
  PLACA_INVALIDA: 'Placa vacía o inválida (debe tener de 5 a 7 letras/números)',
  FECHA_INVALIDA: 'Fecha vacía o inválida (columna C)',
  ESTADO_DESCONOCIDO: 'Estado distinto de APROBADO / RECHAZADO (columna D)',
  MISMO_DIA_UNIFICADA: 'Misma placa el mismo día: se unifica en un solo turno',
}

export interface Persona {
  docTipo: string | null
  docNumero: string | null
  nombre: string | null
  telefono: string | null
  email: string | null
}

export interface FilaBogota {
  fila: number // 1 = primera fila del archivo
  placa: string
  fechaISO: string // yyyy-MM-dd
  hora: string // HH:mm:ss
  minutos: number // duración (columna H)
  instanteISO: string // fecha y hora (Bogotá)
  resultado: ResultadoCertificacion
  tipoTexto: string
  categoria: string
  servicioCodigo: 'RTM' | 'PREV'
  observacion: string | null
  tipoVehiculo: 'Liviano Particular' | 'Liviano Taxi' | 'Liviano Público' | 'Motocicleta'
  claseVehiculoId: number
  vehiculo: {
    marca: string | null
    linea: string | null
    modelo: number | null
    color: string | null
    matricula: string | null
  }
  dueno: Persona
  conductor: Persona
  telefonosDescartados: number
}

export interface Descarte {
  fila: number
  motivo: MotivoDescarte
  placa: string | null
  detalle: string | null
}

/** Visita (placa + día) que se convierte en UN turno. */
export interface GrupoBogota extends FilaBogota {
  filas: number[]
  unificadaConRechazo: boolean
  horaSalida: string
}

/* ============================ Normalización ============================ */

/** Texto de una celda; números enteros sin notación científica. */
export function texto(v: Celda): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    if (Number.isInteger(v)) return BigInt(v).toString()
    return String(v)
  }
  if (v instanceof Date) return v.toISOString()
  const s = String(v).trim()
  return s || null
}

export function normalizarPlaca(v: Celda): string | null {
  const s = texto(v)
  if (!s) return null
  const p = s.toUpperCase().replace(/[^A-Z0-9]/g, '')
  return p.length >= 5 && p.length <= 7 ? p : null
}

/** Solo dígitos; descarta vacíos, 0, 2000000 y menos de 7 dígitos (relleno del reporte). */
export function normalizarTelefono(v: Celda): string | null {
  const s = texto(v)
  if (!s) return null
  const d = s.replace(/\D/g, '')
  if (d.length < 7 || /^0+$/.test(d) || d === '2000000') return null
  return d
}

export function normalizarDocumento(v: Celda): string | null {
  const s = texto(v)
  if (!s) return null
  const d = s.replace(/\s+/g, '')
  return d === '0' || /^0+$/.test(d) ? null : d
}

function normalizarEmail(v: Celda): string | null {
  const s = texto(v)?.toLowerCase() ?? null
  return s && s.includes('@') ? s : null
}

function recortar(s: string | null, max: number): string | null {
  return s && s.length > max ? s.slice(0, max) : s
}

/** Fecha/hora de la columna C: serial de Excel, Date (xlsx) o texto dd/MM/yyyy [HH:mm[:ss]]. */
export function leerFecha(v: Celda, fecha1904 = false): DateTime | null {
  if (v === null || v === undefined || v === '') return null
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v <= 0) return null
    const base = fecha1904 ? 24107 : 25569 // días entre la época de Excel y 1970-01-01
    const ms = Math.round((v - base) * 86_400_000)
    const d = DateTime.fromMillis(ms, { zone: 'utc' }).setZone(ZONA, { keepLocalTime: true })
    return d.isValid ? d.startOf('second') : null
  }
  if (v instanceof Date) {
    // ExcelJS entrega la hora de pared como si fuera UTC.
    const d = DateTime.fromJSDate(v, { zone: 'utc' }).setZone(ZONA, { keepLocalTime: true })
    return d.isValid ? d.startOf('second') : null
  }
  const s = String(v).trim()
  for (const f of [
    'dd/MM/yyyy HH:mm:ss',
    'dd/MM/yyyy HH:mm',
    'dd/MM/yyyy',
    'yyyy-MM-dd HH:mm:ss',
    'yyyy-MM-dd',
  ]) {
    const d = DateTime.fromFormat(s, f, { zone: ZONA })
    if (d.isValid) return d
  }
  const iso = DateTime.fromISO(s, { zone: ZONA })
  return iso.isValid ? iso : null
}

/** Duración (columna H) en minutos; por defecto 60 (como el TECNOBASE de Ibagué: 08:00 → 09:00). */
function leerMinutos(v: Celda): number {
  if (typeof v === 'number' && v > 0 && v < 1) return Math.round(v * 24 * 60)
  return 60
}

/** Igual que el importador de Ibagué (detectarServicioId / detectarTipoVehiculo / detectarClaseVehiculoId). */
export function clasificarTipo(tipo: string, categoria: string) {
  const t = tipo.toUpperCase()
  const cat = categoria.toUpperCase()
  const parentesis = t.match(/\(\s*([^)]+)\s*\)/)?.[1]?.trim() ?? null
  const preventiva = t.includes('PREVENTIVA') || t.includes('PREVENTIVO')
  const conocido =
    preventiva ||
    ['ORDINARIO', 'TAXI', 'PUBLICO', 'APRENDIZAJE', 'LEY 769'].some((k) => t.includes(k))
  const observacion = parentesis ? `(${parentesis})` : conocido ? null : t ? `(${t})` : null

  const esMoto = cat.includes('L2_MOTO') || t.includes('MOTO')
  const tipoVehiculo: FilaBogota['tipoVehiculo'] = t.includes('MOTO')
    ? 'Motocicleta'
    : t.includes('TAXIMETRO') || t.includes('TAXI')
      ? 'Liviano Taxi'
      : t.includes('PUBLICO')
        ? 'Liviano Público'
        : 'Liviano Particular'
  const claseVehiculoId = esMoto
    ? 4
    : t.includes('TAXIMETRO') || t.includes('TAXI')
      ? 2
      : t.includes('PUBLICO')
        ? 3
        : 1
  return {
    servicioCodigo: (preventiva ? 'PREV' : 'RTM') as 'RTM' | 'PREV',
    observacion,
    tipoVehiculo,
    claseVehiculoId,
  }
}

function persona(
  f: Celda[],
  tipo: number,
  num: number,
  nombre: number,
  tel: number,
  email: number | null
) {
  const telefono = normalizarTelefono(f[tel])
  const docNumero = normalizarDocumento(f[num])
  const p: Persona = {
    docTipo: docNumero ? recortar(texto(f[tipo])?.toUpperCase() ?? null, 8) : null,
    docNumero: recortar(docNumero, 30),
    nombre: recortar(texto(f[nombre]), 120),
    telefono: recortar(telefono, 20),
    email: email === null ? null : recortar(normalizarEmail(f[email]), 120),
  }
  const descartado = texto(f[tel]) !== null && telefono === null ? 1 : 0
  return { p, descartado }
}

/** ¿La fila parece de títulos? (C sin fecha y algún texto típico de encabezado). */
export function esFilaTitulos(f: Celda[], fecha1904 = false): boolean {
  if (leerFecha(f[COL.FECHA], fecha1904)) return false
  return f.some((c) => typeof c === 'string' && /^(PLACA|FECHA|ESTADO|MARCA)\b/i.test(c.trim()))
}

/** Convierte una fila del archivo. */
export function leerFila(
  f: Celda[],
  numFila: number,
  fecha1904 = false
): { ok: true; fila: FilaBogota } | { ok: false; descarte: Descarte } {
  const vacia = f.every((c) => texto(c) === null)
  const placaTexto = texto(f[COL.PLACA])
  if (vacia)
    return {
      ok: false,
      descarte: { fila: numFila, motivo: 'FILA_VACIA', placa: null, detalle: null },
    }
  const placa = normalizarPlaca(f[COL.PLACA])
  if (!placa) {
    return {
      ok: false,
      descarte: { fila: numFila, motivo: 'PLACA_INVALIDA', placa: placaTexto, detalle: placaTexto },
    }
  }
  const fecha = leerFecha(f[COL.FECHA], fecha1904)
  if (!fecha) {
    return {
      ok: false,
      descarte: { fila: numFila, motivo: 'FECHA_INVALIDA', placa, detalle: texto(f[COL.FECHA]) },
    }
  }
  const estado = texto(f[COL.ESTADO])?.toUpperCase() ?? ''
  const resultado: ResultadoCertificacion | null = estado.startsWith('APROBAD')
    ? 'APROBADA'
    : estado.startsWith('RECHAZAD')
      ? 'RECHAZADA'
      : null
  if (!resultado) {
    return {
      ok: false,
      descarte: { fila: numFila, motivo: 'ESTADO_DESCONOCIDO', placa, detalle: estado || null },
    }
  }

  const tipoTexto = texto(f[COL.TIPO]) ?? ''
  const categoria = texto(f[COL.CATEGORIA]) ?? ''
  const cls = clasificarTipo(tipoTexto, categoria)
  const modeloTxt = texto(f[COL.MODELO])
  const modeloNum = modeloTxt !== null ? Number(modeloTxt) : Number.NaN
  const dueno = persona(
    f,
    COL.DUENO_DOC_TIPO,
    COL.DUENO_DOC_NUM,
    COL.DUENO_NOMBRE,
    COL.DUENO_TELEFONO,
    COL.DUENO_EMAIL
  )
  const conductor = persona(
    f,
    COL.COND_DOC_TIPO,
    COL.COND_DOC_NUM,
    COL.COND_NOMBRE,
    COL.COND_TELEFONO,
    null
  )
  // Sin hora en la celda (00:00:00): 08:00, como el TECNOBASE de Ibagué.
  const conHora = fecha.hour !== 0 || fecha.minute !== 0 || fecha.second !== 0
  const inicio = conHora ? fecha : fecha.set({ hour: 8, minute: 0, second: 0 })

  return {
    ok: true,
    fila: {
      fila: numFila,
      placa,
      fechaISO: inicio.toISODate()!,
      hora: inicio.toFormat('HH:mm:ss'),
      minutos: leerMinutos(f[COL.DURACION]),
      instanteISO: inicio.toISO()!,
      resultado,
      tipoTexto,
      categoria,
      ...cls,
      vehiculo: {
        marca: recortar(texto(f[COL.MARCA]), 60),
        linea: recortar(texto(f[COL.LINEA]), 80),
        modelo: Number.isFinite(modeloNum) ? modeloNum : null,
        color: recortar(texto(f[COL.COLOR]), 50),
        matricula: recortar(texto(f[COL.MATRICULA]), 50),
      },
      dueno: dueno.p,
      conductor: conductor.p,
      telefonosDescartados: dueno.descartado + conductor.descartado,
    },
  }
}

/**
 * Agrupa por placa + día → un turno por visita.
 * - Si hay algún APROBADO ese día, el turno queda APROBADA con los datos de
 *   ese APROBADO (un RECHAZADO del mismo día fue la misma visita: falla y
 *   reinspección), observación "(rechazado y aprobado el mismo día)".
 * - Solo RECHAZADO → turno RECHAZADA (visita que no da vigencia).
 * - Ingreso = la hora más temprana; salida = la más tardía + duración.
 * Ordenado por fecha y hora (el dueño del vehículo sigue la cronología).
 */
export function agruparPorVisita(filas: FilaBogota[]): {
  grupos: GrupoBogota[]
  unificadas: Descarte[]
} {
  const mapa = new Map<string, FilaBogota[]>()
  for (const f of filas) {
    const k = `${f.placa}|${f.fechaISO}`
    const g = mapa.get(k)
    if (g) g.push(f)
    else mapa.set(k, [f])
  }
  const grupos: GrupoBogota[] = []
  const unificadas: Descarte[] = []
  for (const lista of mapa.values()) {
    lista.sort((a, b) => a.hora.localeCompare(b.hora) || a.fila - b.fila)
    const rep = lista.find((x) => x.resultado === 'APROBADA') ?? lista[0]
    const hubo = new Set(lista.map((x) => x.resultado))
    const unificadaConRechazo = hubo.has('APROBADA') && hubo.has('RECHAZADA')
    const salidas = lista.map((x) =>
      DateTime.fromFormat(x.hora, 'HH:mm:ss').plus({ minutes: x.minutos })
    )
    const ultima = salidas.reduce((a, b) => (b > a ? b : a))
    const finDia = DateTime.fromFormat('23:59:59', 'HH:mm:ss')
    const obs = [
      rep.observacion,
      unificadaConRechazo ? '(rechazado y aprobado el mismo día)' : null,
    ]
      .filter(Boolean)
      .join(' ')
    grupos.push({
      ...rep,
      hora: lista[0].hora,
      instanteISO: lista[0].instanteISO,
      observacion: obs || null,
      filas: lista.map((x) => x.fila),
      unificadaConRechazo,
      horaSalida: (ultima.hasSame(finDia, 'day') && ultima < finDia ? ultima : finDia).toFormat(
        'HH:mm:ss'
      ),
    })
    for (const x of lista) {
      if (x !== rep) {
        unificadas.push({
          fila: x.fila,
          motivo: 'MISMO_DIA_UNIFICADA',
          placa: x.placa,
          detalle: `${x.resultado === 'APROBADA' ? 'APROBADO' : 'RECHAZADO'} unificado con la fila ${rep.fila}`,
        })
      }
    }
  }
  grupos.sort(
    (a, b) =>
      a.fechaISO.localeCompare(b.fechaISO) || a.hora.localeCompare(b.hora) || a.fila - b.fila
  )
  return { grupos, unificadas }
}
