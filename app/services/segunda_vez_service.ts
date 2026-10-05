// app/services/segunda_vez_service.ts
//
// Única fuente de verdad de "Segunda vez" (reinspección gratuita tras una
// certificación RECHAZADA de RTM o Preventiva).
//
// Reglas (cerradas con negocio):
//  - Aplica solo a los servicios RTM y PREV (códigos reales en servicios.codigo_servicio).
//  - Al certificar RECHAZADA un turno que NO es segunda vez se abre una
//    ventana de 360 h exactas (15 días corridos) desde el instante del
//    rechazo, con hora del servidor (Bogotá), nunca la del frontend.
//  - Borde ESTRICTO: abierta solo si ahora < ventana_hasta.
//  - Si la segunda vez también sale RECHAZADA no se abre otra ventana.
//  - Un turno RECHAZADO no da vigencia (no bloquea WINDOW_BLOCK/RTM_VIGENTE).
//    resultado NULL (histórico / SOAT / PERI) se trata como aprobado.
//
// Las funciones reciben "ahora" por parámetro para poder probar los bordes.

import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import type TurnoRtm from '#models/turno_rtm'

export type ResultadoCertificacion = 'APROBADA' | 'RECHAZADA'
export type EstadoVentanaSegundaVez =
  | 'NO_APLICA'
  | 'ABIERTA'
  | 'USADA'
  | 'VENCIDA'
  | 'ANULADA'
  | 'SUPERADA'

export const ZONA_SEGUNDA_VEZ = 'America/Bogota'
export const SERVICIOS_SEGUNDA_VEZ = ['RTM', 'PREV'] as const
export const HORAS_VENTANA = 360
export const RESULTADOS_CERTIFICACION: readonly ResultadoCertificacion[] = ['APROBADA', 'RECHAZADA']

/** ¿El servicio (por codigo_servicio) participa de Segunda vez? */
export function aplicaSegundaVez(codigoServicio?: string | null): boolean {
  const c = (codigoServicio || '').toUpperCase().trim()
  return (SERVICIOS_SEGUNDA_VEZ as readonly string[]).includes(c)
}

/** Normaliza el resultado recibido del cliente; null si no es válido. */
export function parseResultadoCertificacion(v: unknown): ResultadoCertificacion | null {
  const x = String(v ?? '')
    .toUpperCase()
    .trim()
  return (RESULTADOS_CERTIFICACION as readonly string[]).includes(x)
    ? (x as ResultadoCertificacion)
    : null
}

/** Instante del rechazo según el servidor (Bogotá), truncado a segundos (DATETIME sin fracción). */
export function instanteRechazo(ahora: DateTime = DateTime.now()): DateTime {
  return ahora.setZone(ZONA_SEGUNDA_VEZ).startOf('second')
}

/** rechazadoAt + 360 h exactas. */
export function calcularVentanaHasta(rechazadoAt: DateTime): DateTime {
  return rechazadoAt.plus({ hours: HORAS_VENTANA })
}

/** es_segunda_vez es TINYINT(1): mysql2 lo entrega como 0/1. */
export function esTurnoSegundaVez(t: { esSegundaVez?: boolean | number | null }): boolean {
  return Boolean(t.esSegundaVez)
}

/**
 * Estado de la ventana de un turno de origen (el rechazado).
 *  - NO_APLICA: el turno no tiene ventana (aprobado, sin resultado, SOAT/PERI
 *    o una segunda vez rechazada).
 *  - ANULADA:   el origen ya no es un rechazo finalizado (p. ej. se canceló).
 *               Solo se evalúa si estado/resultado vienen en `t`.
 *  - USADA:     ya tiene una segunda vez hija no cancelada.
 *  - SUPERADA:  después del origen hubo otro turno no cancelado de la misma
 *               placa+servicio que no es su segunda vez (p. ej. NO_APLICADA).
 *  - VENCIDA:   ahora >= ventana_segunda_vez_hasta (borde estricto).
 *  - ABIERTA:   ahora <  ventana_segunda_vez_hasta y nada de lo anterior.
 */
export function estadoVentana(
  t: {
    ventanaSegundaVezHasta?: DateTime | null
    estado?: string | null
    resultadoCertificacion?: ResultadoCertificacion | null
  },
  ahora: DateTime,
  ctx: { hijoActivo?: boolean; turnoPosterior?: boolean } = {}
): EstadoVentanaSegundaVez {
  const hasta = t.ventanaSegundaVezHasta
  if (!hasta) return 'NO_APLICA'
  if (t.estado !== undefined && t.estado !== 'finalizado') return 'ANULADA'
  if (t.resultadoCertificacion !== undefined && t.resultadoCertificacion !== 'RECHAZADA') {
    return 'ANULADA'
  }
  if (ctx.hijoActivo) return 'USADA'
  if (ctx.turnoPosterior) return 'SUPERADA'
  return ahora.toMillis() < hasta.toMillis() ? 'ABIERTA' : 'VENCIDA'
}

/** Horas (con decimales, mínimo 0) que le quedan a la ventana. */
export function horasRestantes(hasta: DateTime, ahora: DateTime): number {
  const h = hasta.diff(ahora, 'hours').hours
  return h > 0 ? Math.round(h * 100) / 100 : 0
}

/**
 * Datos de segunda vez a guardar al certificar un turno. Para servicios que
 * no aplican, resultado y ventana quedan en NULL.
 */
export function camposAlCertificar(params: {
  codigoServicio?: string | null
  resultado: ResultadoCertificacion | null
  esSegundaVez: boolean | number | null | undefined
  ahora: DateTime
}): {
  resultadoCertificacion: ResultadoCertificacion | null
  rechazadoAt: DateTime | null
  ventanaSegundaVezHasta: DateTime | null
} {
  if (!aplicaSegundaVez(params.codigoServicio) || !params.resultado) {
    return { resultadoCertificacion: null, rechazadoAt: null, ventanaSegundaVezHasta: null }
  }
  if (params.resultado === 'APROBADA') {
    return { resultadoCertificacion: 'APROBADA', rechazadoAt: null, ventanaSegundaVezHasta: null }
  }
  const rechazadoAt = instanteRechazo(params.ahora)
  return {
    resultadoCertificacion: 'RECHAZADA',
    rechazadoAt,
    // Segunda vez rechazada: no se abre otra ventana.
    ventanaSegundaVezHasta: esTurnoSegundaVez({ esSegundaVez: params.esSegundaVez })
      ? null
      : calcularVentanaHasta(rechazadoAt),
  }
}

/**
 * ¿Este turno da vigencia (cuenta para WINDOW_BLOCK / RTM_VIGENTE)?
 * estado finalizado Y resultado_certificacion NULL o APROBADA.
 */
export function esTurnoQueDaVigencia(t: {
  estado?: string | null
  resultadoCertificacion?: ResultadoCertificacion | null
}): boolean {
  return t.estado === 'finalizado' && t.resultadoCertificacion !== 'RECHAZADA'
}

/**
 * Mismo criterio que esTurnoQueDaVigencia() como filtro SQL sobre
 * turnos_rtms (Lucid model query o query builder).
 */
export function whereTurnoDaVigencia<Q extends { where: (...args: any[]) => any }>(
  query: Q,
  tabla: string = 'turnos_rtms'
): Q {
  query.where(`${tabla}.estado`, 'finalizado')
  query.where((q: any) => {
    q.whereNull(`${tabla}.resultado_certificacion`).orWhere(
      `${tabla}.resultado_certificacion`,
      'APROBADA'
    )
  })
  return query
}

/**
 * Excluye las segundas veces de una consulta sobre turnos_rtms. Para la
 * lógica comercial (recurrencia, continuidad, última visita, exigencia de
 * dateo) y los reportes (meta, producción, reconciliación, discrepancias):
 * el turno de origen rechazado SÍ cuenta como visita/unidad, la segunda vez
 * no (no es ingreso, unidad, meta ni turno pendiente de facturar).
 */
export function excluirSegundaVez<Q extends { whereRaw: (...args: any[]) => any }>(
  query: Q,
  tabla: string = 'turnos_rtms'
): Q {
  query.whereRaw(excluirSegundaVezSql(tabla))
  return query
}

/** Mismo filtro que excluirSegundaVez() para SQL crudo (`AND ${excluirSegundaVezSql('t')}`). */
export function excluirSegundaVezSql(tabla: string = 'turnos_rtms'): string {
  return `${tabla}.es_segunda_vez = 0`
}

// ───────────────────────── Acceso a BD ─────────────────────────

export const CODIGO_TURNO_SEGUNDA_VEZ = 'TURNO_SEGUNDA_VEZ'

/** Cuerpo del 409 que devuelven facturación, comisiones, cierre y salida. */
export function conflictoTurnoSegundaVez(accion: string) {
  return {
    code: CODIGO_TURNO_SEGUNDA_VEZ,
    message: `Este turno es una segunda vez gratuita: no admite ${accion}.`,
  }
}

/** ¿El turno (por id) es una segunda vez? false si no existe o no viene id. */
export async function turnoIdEsSegundaVez(
  turnoId: number | null | undefined,
  trx?: TransactionClientContract
): Promise<boolean> {
  if (!turnoId) return false
  const q = trx ? Database.from('turnos_rtms').useTransaction(trx) : Database.from('turnos_rtms')
  const row = await q.where('id', turnoId).select('es_segunda_vez').first()
  return Boolean(row?.es_segunda_vez)
}

export interface EvaluacionVentana {
  origen: TurnoRtm
  estado: EstadoVentanaSegundaVez
  hasta: DateTime
  horasRestantes: number
  /** Segunda vez hija no cancelada (USADA). */
  hijoActivoId: number | null
  /** Turno posterior no cancelado que no es su segunda vez (SUPERADA). */
  turnoPosteriorId: number | null
}

/**
 * Hijo activo y turno posterior del origen. Lectura FRESCA, fuera de la
 * transacción del llamador: con REPEATABLE READ, una lectura normal dentro de
 * la trx usaría la foto tomada en su primera lectura y no vería una segunda
 * vez confirmada por otra petición mientras esta esperaba el candado del
 * origen. Se filtra por placa (índice idx_turno_placa) porque una segunda vez
 * siempre tiene la placa y el servicio de su origen (update() no deja
 * cambiarlos).
 */
async function contextoOrigen(origen: TurnoRtm) {
  const rows: Array<{ id: number; es_segunda_vez: number; turno_origen_id: number | null }> =
    await Database.from('turnos_rtms')
      .where('placa', origen.placa)
      .where('servicio_id', origen.servicioId)
      .where('id', '>', origen.id)
      .whereNot('estado', 'cancelado')
      .select('id', 'es_segunda_vez', 'turno_origen_id')
      .orderBy('id', 'asc')

  let hijoActivoId: number | null = null
  let turnoPosteriorId: number | null = null
  for (const r of rows) {
    const esHijo = Boolean(r.es_segunda_vez) && Number(r.turno_origen_id) === origen.id
    if (esHijo) hijoActivoId ??= r.id
    else turnoPosteriorId ??= r.id
  }
  return { hijoActivoId, turnoPosteriorId }
}

async function evaluarOrigen(origen: TurnoRtm, ahora: DateTime): Promise<EvaluacionVentana> {
  const ctx = await contextoOrigen(origen)
  const hasta = origen.ventanaSegundaVezHasta!
  return {
    origen,
    estado: estadoVentana(origen, ahora, {
      hijoActivo: ctx.hijoActivoId !== null,
      turnoPosterior: ctx.turnoPosteriorId !== null,
    }),
    hasta,
    horasRestantes: horasRestantes(hasta, ahora),
    ...ctx,
  }
}

/**
 * Evalúa la ventana más reciente de placa+servicio (cualquier estado), o
 * null si nunca hubo una. Con `trx`, bloquea la fila del origen por PK
 * (SELECT ... FOR UPDATE): toda petición que vaya a crear un turno de esa
 * placa+servicio mientras exista un origen pasa por este candado, así que
 * dos confirmaciones simultáneas se serializan y la segunda ve la hija de
 * la primera (garantía de una sola segunda vez activa sin índice único).
 * El candidato se busca con lectura fresca y el candado es solo por PK para
 * no tomar gap locks sobre idx_turno_placa (riesgo de deadlock con la
 * reasignación de huecos de store()).
 */
export async function evaluarVentanaSegundaVez(
  placa: string,
  servicioId: number,
  ahora: DateTime,
  trx?: TransactionClientContract
): Promise<EvaluacionVentana | null> {
  const candidato = await Database.from('turnos_rtms')
    .where('placa', placa)
    .where('servicio_id', servicioId)
    .whereNotNull('ventana_segunda_vez_hasta')
    .orderBy('rechazado_at', 'desc')
    .orderBy('id', 'desc')
    .select('id')
    .first()
  if (!candidato) return null
  return evaluarOrigenPorId(candidato.id, ahora, trx)
}

/** Evalúa (y con `trx` bloquea) un origen concreto. null si no existe o no tiene ventana. */
export async function evaluarOrigenPorId(
  origenId: number,
  ahora: DateTime,
  trx?: TransactionClientContract
): Promise<EvaluacionVentana | null> {
  const { default: TurnoRtmModel } = await import('#models/turno_rtm')
  const origen = trx
    ? await TurnoRtmModel.query({ client: trx }).where('id', origenId).forUpdate().first()
    : await TurnoRtmModel.find(origenId)
  if (!origen?.ventanaSegundaVezHasta) return null
  return evaluarOrigen(origen, ahora)
}

/** La ventana de placa+servicio solo si está ABIERTA (con candado si hay `trx`). */
export async function buscarVentanaAbierta(
  placa: string,
  servicioId: number,
  ahora: DateTime,
  trx?: TransactionClientContract
): Promise<EvaluacionVentana | null> {
  const ev = await evaluarVentanaSegundaVez(placa, servicioId, ahora, trx)
  return ev?.estado === 'ABIERTA' ? ev : null
}

/** ¿El origen tiene una segunda vez hija no cancelada? (para cancelar/editar el origen) */
export async function hijoActivoDeOrigen(origen: TurnoRtm): Promise<number | null> {
  const { hijoActivoId } = await contextoOrigen(origen)
  return hijoActivoId
}

/** Datos públicos de una evaluación (409 SEGUNDA_VEZ_DISPONIBLE, búsqueda unificada). */
export function serializarVentana(ev: EvaluacionVentana) {
  return {
    estado: ev.estado,
    origenId: ev.origen.id,
    origenTurnoCodigo: ev.origen.turnoCodigo,
    origenFecha: (ev.origen.fecha as DateTime)?.toISODate?.() ?? null,
    servicioId: ev.origen.servicioId,
    rechazadoAt: ev.origen.rechazadoAt?.setZone(ZONA_SEGUNDA_VEZ).toISO() ?? null,
    hasta: ev.hasta.setZone(ZONA_SEGUNDA_VEZ).toISO(),
    horasRestantes: ev.horasRestantes,
    hijoActivoId: ev.hijoActivoId,
  }
}

/** Otra segunda vez hija no cancelada del mismo origen (excluyendo `excluirId`). */
export async function otroHijoActivo(t: TurnoRtm): Promise<number | null> {
  if (!t.turnoOrigenId) return null
  const row = await Database.from('turnos_rtms')
    .where('placa', t.placa)
    .where('servicio_id', t.servicioId)
    .where('es_segunda_vez', 1)
    .where('turno_origen_id', t.turnoOrigenId)
    .whereNot('id', t.id)
    .whereNot('estado', 'cancelado')
    .select('id')
    .first()
  return row?.id ?? null
}

/** 409 al intentar finalizar un RTM/PREV por una vía distinta de Certificación. */
export function conflictoFinalizarSinCertificacion(codigoServicio?: string | null) {
  return {
    code: 'FINALIZAR_REQUIERE_CERTIFICACION',
    message: `Un turno de ${codigoServicio ?? 'RTM/PREV'} solo se finaliza desde Certificación (con resultado Aprobada/Rechazada).`,
  }
}

/** 409 al cancelar/editar un origen que tiene una segunda vez activa. */
export function conflictoOrigenConHijoActivo(hijoActivoId: number) {
  return {
    code: 'ORIGEN_CON_SEGUNDA_VEZ_ACTIVA',
    message:
      'Este turno tiene una segunda vez activa. Cancela primero la segunda vez si necesitas modificarlo o cancelarlo.',
    hijoActivoId,
  }
}

/**
 * Ventanas de segunda vez de una placa, una por servicio RTM/PREV que haya
 * tenido alguna (cualquier estado). Solo lectura, sin candados: para la
 * búsqueda unificada / banner de CrearTurno. store() revalida con candado.
 */
export async function ventanasSegundaVezDePlaca(
  placa: string,
  ahora: DateTime = DateTime.now().setZone(ZONA_SEGUNDA_VEZ)
) {
  const servicios: Array<{ id: number; codigo_servicio: string }> = await Database.from('servicios')
    .whereIn('codigo_servicio', [...SERVICIOS_SEGUNDA_VEZ])
    .select('id', 'codigo_servicio')

  const ventanas = []
  for (const s of servicios) {
    const ev = await evaluarVentanaSegundaVez(placa, s.id, ahora)
    if (ev) ventanas.push({ ...serializarVentana(ev), servicioCodigo: s.codigo_servicio })
  }
  return ventanas
}

/**
 * ¿Hay una segunda vez abierta o en curso? (ventana ABIERTA, o una segunda
 * vez hija todavía 'activo', es decir, sin certificar). La búsqueda unificada
 * lo usa para no crear el dateo automático de convenio en ese caso.
 */
export async function haySegundaVezEnCurso(
  ventanas: Array<{ estado: EstadoVentanaSegundaVez; hijoActivoId: number | null }>
): Promise<boolean> {
  if (ventanas.some((v) => v.estado === 'ABIERTA')) return true
  const hijos = ventanas.map((v) => v.hijoActivoId).filter((id): id is number => !!id)
  if (hijos.length === 0) return false
  const enCurso = await Database.from('turnos_rtms')
    .whereIn('id', hijos)
    .where('estado', 'activo')
    .select('id')
    .first()
  return !!enCurso
}
