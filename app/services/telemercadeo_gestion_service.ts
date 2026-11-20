// app/services/telemercadeo_gestion_service.ts
//
// Reglas de las gestiones de Telemercadeo (no generan comisiones):
//  - Quién es asesor de Telemercadeo: agente ASESOR_TELEMERCADEO ligado al
//    usuario del token (el agente_id nunca sale del body).
//  - Ciclo de seguimiento por cliente (placa + servicio), sumando todos los
//    asesores. Máximo de gestiones por ciclo = override del asesor que
//    registra → global (default 3) + extras autorizados por gerencia.
//  - Cierre perezoso del ciclo (sin cron): TURNO si hubo un turno finalizado
//    de esa placa y servicio desde que se abrió; VENCIDO si pasaron
//    dias_vigencia_ciclo días sin gestiones; DATEADO al vincular el dateo.
//  - Evidencia: ruta privada uploads/telemercadeo/AAAA/MM/<cuid>.<ext>.
//  - Vínculo gestión ↔ dateo dentro de la transacción de store().

import { preferirConfigDeSede } from '#services/sede_scope'
import fs from 'node:fs'
import { DateTime } from 'luxon'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import AgenteCaptacion from '#models/agente_captacion'
import CaptacionDateo from '#models/captacion_dateo'
import TelemercadeoCiclo, { type MotivoCierreCiclo } from '#models/telemercadeo_ciclo'
import TelemercadeoGestion, {
  MEDIOS_GESTION,
  RESULTADOS_ELEGIBLES,
  type MedioGestion,
  type ResultadoGestion,
} from '#models/telemercadeo_gestion'
import ConfiguracionSeguimientoTeleGlobal from '#models/configuracion_seguimiento_tele_global'
import ConfiguracionSeguimientoTeleAsesor from '#models/configuracion_seguimiento_tele_asesor'
import { buildReserva } from '#services/reserva_dateo_service'
import { whereTurnoDaVigencia } from '#services/segunda_vez_service'
import { bloqueaDateoRtm, vigenciaRtm } from '#services/ventana_rtm_service'

export const ZONA_TELE = 'America/Bogota'
export const TIPO_AGENTE_TELE = 'ASESOR_TELEMERCADEO'
export const CARPETA_EVIDENCIAS_TELE = 'telemercadeo'
export const MAX_SEGUIMIENTOS_DEFAULT = 3
export const DIAS_VIGENCIA_CICLO_DEFAULT = 30
export const OBSERVACION_MAX = 2000

const RE_EVIDENCIA = /^telemercadeo\/\d{4}\/\d{2}\/[a-z0-9]+\.(jpg|jpeg|png|webp|heic|heif)$/
const RE_IDEMPOTENCIA = /^[A-Za-z0-9_-]{8,64}$/
const RE_PLACA = /^[A-Z0-9]{4,10}$/

/* ───────────────────────── Normalización ───────────────────────── */

export const normalizarPlacaTele = (v: unknown): string =>
  String(v ?? '')
    .replace(/[\s-]/g, '')
    .toUpperCase()

export const normalizarTelefonoTele = (v: unknown): string | null => {
  const d = String(v ?? '').replace(/\D/g, '')
  return d ? d : null
}

/** ¿La ruta es una evidencia de Telemercadeo bien formada? (no comprueba el disco) */
export const esRutaEvidenciaTele = (ruta: unknown): ruta is string =>
  typeof ruta === 'string' && RE_EVIDENCIA.test(ruta)

/** Ruta absoluta en disco de una evidencia (ya validada con esRutaEvidenciaTele). */
export const rutaAbsolutaEvidencia = (ruta: string) => app.makePath('uploads', ...ruta.split('/'))

/* ───────────────────────── Agente y configuración ───────────────────────── */

/** Agente ASESOR_TELEMERCADEO del usuario, o null. */
export async function agenteTelemercadeoDeUsuario(usuarioId: number) {
  return AgenteCaptacion.query()
    .where('usuario_id', usuarioId)
    .where('tipo', TIPO_AGENTE_TELE)
    .first()
}

export async function getConfigSeguimientoTele(client?: TransactionClientContract) {
  let cfg = await preferirConfigDeSede(ConfiguracionSeguimientoTeleGlobal.query({ client })).first()
  if (!cfg) {
    cfg = await ConfiguracionSeguimientoTeleGlobal.create(
      {
        maxSeguimientos: MAX_SEGUIMIENTOS_DEFAULT,
        diasVigenciaCiclo: DIAS_VIGENCIA_CICLO_DEFAULT,
      },
      { client }
    )
  }
  return { maxSeguimientos: cfg.maxSeguimientos, diasVigenciaCiclo: cfg.diasVigenciaCiclo }
}

/** Override del asesor (si existe y no es null) → global. Mismo patrón que getMaxRedateos(). */
export async function getMaxSeguimientos(
  agenteId: number | null,
  client?: TransactionClientContract
): Promise<number> {
  if (agenteId) {
    const o = await ConfiguracionSeguimientoTeleAsesor.query({ client })
      .where('asesor_id', agenteId)
      .first()
    if (o && o.maxSeguimientos !== null) return o.maxSeguimientos
  }
  return (await getConfigSeguimientoTele(client)).maxSeguimientos
}

/* ───────────────────────── Ciclo ───────────────────────── */

/**
 * Regla pura de cierre del ciclo. TURNO gana a VENCIDO (es la causa real).
 * `base` = última gestión o, si no hay, apertura del ciclo.
 */
export function evaluarCierreCiclo(p: {
  aperturaAt: DateTime
  ultimaGestionAt: DateTime | null
  turnoFinalizadoDesdeApertura: boolean
  diasVigenciaCiclo: number
  ahora?: DateTime
}): MotivoCierreCiclo | null {
  if (p.turnoFinalizadoDesdeApertura) return 'TURNO'
  const ahora = p.ahora ?? DateTime.now()
  const base = p.ultimaGestionAt ?? p.aperturaAt
  if (ahora.diff(base, 'days').days >= p.diasVigenciaCiclo) return 'VENCIDO'
  return null
}

/** Fecha (Bogotá) de un DateTime de la BD. */
const fechaBogota = (dt: DateTime) => dt.setZone(ZONA_TELE).toISODate()!

/** ¿Turno finalizado (no segunda vez) de la placa y servicio desde la fecha dada? */
async function hayTurnoFinalizadoDesde(
  placa: string,
  servicioId: number,
  desdeISO: string,
  client?: TransactionClientContract
): Promise<boolean> {
  const row = await (client ?? Database)
    .from('turnos_rtms')
    .where('placa', placa)
    .where('servicio_id', servicioId)
    .where('estado', 'finalizado')
    .where('es_segunda_vez', 0)
    .where('fecha', '>=', desdeISO)
    .select('id')
    .first()
  return !!row
}

async function motivoCierre(
  ciclo: TelemercadeoCiclo,
  diasVigenciaCiclo: number,
  client?: TransactionClientContract
): Promise<MotivoCierreCiclo | null> {
  return evaluarCierreCiclo({
    aperturaAt: ciclo.createdAt,
    ultimaGestionAt: ciclo.ultimaGestionAt,
    turnoFinalizadoDesdeApertura: await hayTurnoFinalizadoDesde(
      ciclo.placa,
      ciclo.servicioId,
      fechaBogota(ciclo.createdAt),
      client
    ),
    diasVigenciaCiclo,
  })
}

async function cerrarCiclo(
  ciclo: TelemercadeoCiclo,
  motivo: MotivoCierreCiclo,
  trx: TransactionClientContract
) {
  ciclo.abiertoKey = null
  ciclo.cerradoAt = DateTime.now()
  ciclo.cerradoMotivo = motivo
  await ciclo.useTransaction(trx).save()
}

export interface EstadoSeguimiento {
  ciclo_id: number | null
  /** Gestiones ya hechas en el ciclo vigente (0 si no hay o si vencería). */
  n: number
  max: number
  extras_autorizados: number
  limite: number
  puede_registrar: boolean
}

/** Estado del seguimiento SIN escribir (el cierre perezoso se evalúa, no se guarda). */
export async function estadoSeguimiento(
  placa: string,
  servicioId: number,
  agenteId: number | null
): Promise<EstadoSeguimiento> {
  const [cfg, max] = await Promise.all([getConfigSeguimientoTele(), getMaxSeguimientos(agenteId)])
  const ciclo = await TelemercadeoCiclo.query()
    .where('placa', placa)
    .where('servicio_id', servicioId)
    .where('abierto_key', 1)
    .first()
  const vigente = ciclo && !(await motivoCierre(ciclo, cfg.diasVigenciaCiclo)) ? ciclo : null
  const n = vigente?.numeroGestiones ?? 0
  const extras = vigente?.extrasAutorizados ?? 0
  return {
    ciclo_id: vigente?.id ?? null,
    n,
    max,
    extras_autorizados: extras,
    limite: max + extras,
    puede_registrar: n < max + extras,
  }
}

/* ───────────────────────── Avisos (dateo activo / RTM vigente) ───────────────────────── */

export interface AvisosGestion {
  dateo_activo: {
    dateo_id: number
    agente_id: number | null
    es_propio: boolean
    bloquea_hasta: string | null
  } | null
  rtm_vigente: { vence_el: string; puede_datear_desde: string } | null
}

/**
 * Mismos criterios que store() de dateos: último dateo liberado=0 por placa
 * o teléfono + servicio (buildReserva) y RTM_VIGENTE con la ventana
 * compartida. Solo informan: la gestión se registra igual.
 */
export async function avisosGestion(p: {
  placa: string
  telefono: string | null
  servicioId: number
  agenteId: number | null
}): Promise<AvisosGestion> {
  const ultimo = await CaptacionDateo.query()
    .where((q) => {
      q.orWhere('placa', p.placa)
      if (p.telefono) q.orWhere('telefono', p.telefono)
    })
    .where('liberado', false)
    .where('servicio_id', p.servicioId)
    .orderBy('created_at', 'desc')
    .first()

  let dateoActivo: AvisosGestion['dateo_activo'] = null
  if (ultimo) {
    const r = await buildReserva(ultimo)
    if (r.vigente) {
      dateoActivo = {
        dateo_id: ultimo.id,
        agente_id: ultimo.agenteId ?? null,
        es_propio: !!p.agenteId && ultimo.agenteId === p.agenteId,
        bloquea_hasta: r.bloqueaHasta,
      }
    }
  }

  let rtmVigente: AvisosGestion['rtm_vigente'] = null
  const servicio = await Database.from('servicios').where('id', p.servicioId).first()
  if (String(servicio?.codigo_servicio ?? '').toUpperCase() === 'RTM') {
    const ultimoRtm = await whereTurnoDaVigencia(
      Database.from('turnos_rtms').where('placa', p.placa).where('servicio_id', p.servicioId)
    )
      .orderBy('fecha', 'desc')
      .select('fecha')
      .first()
    if (ultimoRtm) {
      const fecha =
        ultimoRtm.fecha instanceof Date
          ? DateTime.fromJSDate(ultimoRtm.fecha).toISODate()!
          : String(ultimoRtm.fecha).substring(0, 10)
      const v = vigenciaRtm(fecha)
      if (bloqueaDateoRtm(v)) {
        rtmVigente = {
          vence_el: v.venceEl.toISODate()!,
          puede_datear_desde: v.puedeDatearDesde.toISODate()!,
        }
      }
    }
  }

  return { dateo_activo: dateoActivo, rtm_vigente: rtmVigente }
}

/* ───────────────────────── Registrar gestión ───────────────────────── */

export interface EntradaGestion {
  placa: unknown
  telefono?: unknown
  servicio_id?: unknown
  medio: unknown
  origen_id: unknown
  resultado: unknown
  evidencia_ruta: unknown
  observacion?: unknown
  proximo_contacto_at?: unknown
  idempotency_key: unknown
}

type Falla = { ok: false; status: 400 | 403 | 404 | 409; body: Record<string, unknown> }
const falla = (status: Falla['status'], body: Record<string, unknown>): Falla => ({
  ok: false,
  status,
  body,
})

export type ResultadoRegistro =
  | { ok: true; repetida: boolean; gestion: TelemercadeoGestion; seguimiento: EstadoSeguimiento }
  | Falla

async function servicioRtmId(): Promise<number | null> {
  const r = await Database.from('servicios').where('codigo_servicio', 'RTM').select('id').first()
  return r?.id ?? null
}

/** Validación de la entrada (sin BD salvo catálogos). */
async function validarEntrada(e: EntradaGestion) {
  const placa = normalizarPlacaTele(e.placa)
  if (!RE_PLACA.test(placa)) return falla(400, { code: 'PLACA_INVALIDA', message: 'Placa inválida' })

  const medio = String(e.medio ?? '').toUpperCase() as MedioGestion
  if (!MEDIOS_GESTION.includes(medio)) {
    return falla(400, { code: 'MEDIO_INVALIDO', message: `medio debe ser ${MEDIOS_GESTION.join(', ')}` })
  }

  const resultado = String(e.resultado ?? '').toUpperCase() as ResultadoGestion
  if (!RESULTADOS_ELEGIBLES.includes(resultado)) {
    return falla(400, {
      code: 'RESULTADO_INVALIDO',
      message: `resultado debe ser ${RESULTADOS_ELEGIBLES.join(', ')} (DATEADO lo asigna el sistema al datear)`,
    })
  }

  const origenId = Number(e.origen_id)
  const origen = Number.isInteger(origenId)
    ? await Database.from('telemercadeo_origenes').where('id', origenId).first()
    : null
  if (!origen || !Boolean(origen.activo)) {
    return falla(400, { code: 'ORIGEN_INVALIDO', message: 'origen_id no existe o está inactivo' })
  }

  let servicioId: number | null
  if (e.servicio_id === undefined || e.servicio_id === null || e.servicio_id === '') {
    servicioId = await servicioRtmId()
  } else {
    const sid = Number(e.servicio_id)
    const s = Number.isInteger(sid) ? await Database.from('servicios').where('id', sid).first() : null
    servicioId = s ? sid : null
  }
  if (!servicioId) return falla(400, { code: 'SERVICIO_INVALIDO', message: 'servicio_id no existe' })

  if (!esRutaEvidenciaTele(e.evidencia_ruta)) {
    return falla(400, {
      code: 'EVIDENCIA_INVALIDA',
      message: 'evidencia_ruta es obligatoria: sube la imagen con carpeta=telemercadeo',
    })
  }
  if (!fs.existsSync(rutaAbsolutaEvidencia(e.evidencia_ruta))) {
    return falla(400, { code: 'EVIDENCIA_NO_EXISTE', message: 'La evidencia no existe en el servidor' })
  }

  const observacion =
    e.observacion === undefined || e.observacion === null ? null : String(e.observacion).trim() || null
  if (observacion && observacion.length > OBSERVACION_MAX) {
    return falla(400, {
      code: 'OBSERVACION_LARGA',
      message: `observacion admite máximo ${OBSERVACION_MAX} caracteres`,
    })
  }

  let proximo: DateTime | null = null
  if (e.proximo_contacto_at !== undefined && e.proximo_contacto_at !== null && e.proximo_contacto_at !== '') {
    proximo = DateTime.fromISO(String(e.proximo_contacto_at).substring(0, 10), { zone: ZONA_TELE })
    if (!proximo.isValid) {
      return falla(400, { code: 'FECHA_INVALIDA', message: 'proximo_contacto_at debe ser AAAA-MM-DD' })
    }
  }

  const key = String(e.idempotency_key ?? '')
  if (!RE_IDEMPOTENCIA.test(key)) {
    return falla(400, {
      code: 'IDEMPOTENCIA_INVALIDA',
      message: 'idempotency_key es obligatoria (8-64 caracteres alfanuméricos, - o _)',
    })
  }

  return {
    ok: true as const,
    placa,
    medio,
    resultado,
    origenId,
    servicioId,
    evidenciaRuta: e.evidencia_ruta,
    observacion,
    proximo,
    key,
    telefono: normalizarTelefonoTele(e.telefono),
  }
}

const esDuplicado = (err: any) => err?.code === 'ER_DUP_ENTRY' || err?.errno === 1062
const esReintentable = (err: any) =>
  esDuplicado(err) || err?.code === 'ER_LOCK_DEADLOCK' || err?.errno === 1213

class ReintentarCiclo extends Error {}

/**
 * Registra una gestión a nombre del agente (ya resuelto desde el token).
 * Idempotente por (agente, idempotency_key): un reenvío devuelve la misma
 * gestión con repetida=true. El ciclo se bloquea con FOR UPDATE: dos envíos
 * simultáneos no pueden pasar el límite.
 */
export async function registrarGestion(
  agente: AgenteCaptacion,
  usuarioId: number,
  entrada: EntradaGestion
): Promise<ResultadoRegistro> {
  const v = await validarEntrada(entrada)
  if (!v.ok) return v

  const previa = await TelemercadeoGestion.query()
    .where('agente_id', agente.id)
    .where('idempotency_key', v.key)
    .first()
  if (previa) {
    return {
      ok: true,
      repetida: true,
      gestion: previa,
      seguimiento: await estadoSeguimiento(previa.placa, previa.servicioId, agente.id),
    }
  }

  const vehiculo = await Database.from('vehiculos').where('placa', v.placa).first()
  const clienteId: number | null = vehiculo?.cliente_id ?? null
  let telefono = v.telefono
  if (!telefono && clienteId) {
    const c = await Database.from('clientes').where('id', clienteId).select('telefono').first()
    telefono = normalizarTelefonoTele(c?.telefono)
  }

  for (let intento = 1; intento <= 3; intento++) {
    const trx = await Database.transaction()
    try {
      const cfg = await getConfigSeguimientoTele(trx)
      const max = await getMaxSeguimientos(agente.id, trx)

      let ciclo = await TelemercadeoCiclo.query({ client: trx })
        .where('placa', v.placa)
        .where('servicio_id', v.servicioId)
        .where('abierto_key', 1)
        .forUpdate()
        .first()

      if (ciclo) {
        const motivo = await motivoCierre(ciclo, cfg.diasVigenciaCiclo, trx)
        if (motivo) {
          await cerrarCiclo(ciclo, motivo, trx)
          ciclo = null
        }
      }
      if (!ciclo) {
        try {
          ciclo = await TelemercadeoCiclo.create(
            {
              placa: v.placa,
              servicioId: v.servicioId,
              clienteId,
              numeroGestiones: 0,
              extrasAutorizados: 0,
              abiertoKey: 1,
            },
            { client: trx }
          )
        } catch (err) {
          if (esReintentable(err)) throw new ReintentarCiclo()
          throw err
        }
      }

      const limite = max + ciclo.extrasAutorizados
      if (ciclo.numeroGestiones >= limite) {
        await trx.rollback()
        return falla(409, {
          code: 'SEGUIMIENTO_LIMITE',
          message: `Este cliente ya tiene ${ciclo.numeroGestiones} de ${limite} seguimientos en el ciclo. Pide a gerencia autorizar uno extra.`,
          n: ciclo.numeroGestiones,
          max,
          extras_autorizados: ciclo.extrasAutorizados,
          limite,
          ciclo_id: ciclo.id,
        })
      }

      const gestion = await TelemercadeoGestion.create(
        {
          cicloId: ciclo.id,
          numeroEnCiclo: ciclo.numeroGestiones + 1,
          agenteId: agente.id,
          usuarioId,
          placa: v.placa,
          telefono,
          clienteId,
          vehiculoId: vehiculo?.id ?? null,
          servicioId: v.servicioId,
          medio: v.medio,
          origenId: v.origenId,
          resultado: v.resultado,
          evidenciaRuta: v.evidenciaRuta,
          observacion: v.observacion,
          proximoContactoAt: v.proximo,
          captacionDateoId: null,
          idempotencyKey: v.key,
        },
        { client: trx }
      )

      ciclo.numeroGestiones += 1
      ciclo.ultimaGestionAt = DateTime.now()
      await ciclo.useTransaction(trx).save()
      await trx.commit()

      return {
        ok: true,
        repetida: false,
        gestion,
        seguimiento: {
          ciclo_id: ciclo.id,
          n: ciclo.numeroGestiones,
          max,
          extras_autorizados: ciclo.extrasAutorizados,
          limite,
          puede_registrar: ciclo.numeroGestiones < limite,
        },
      }
    } catch (err) {
      await trx.rollback()
      // Doble clic que llegó a la vez: la otra petición ya guardó la gestión.
      if (esDuplicado(err)) {
        const ya = await TelemercadeoGestion.query()
          .where('agente_id', agente.id)
          .where('idempotency_key', v.key)
          .first()
        if (ya) {
          return {
            ok: true,
            repetida: true,
            gestion: ya,
            seguimiento: await estadoSeguimiento(ya.placa, ya.servicioId, agente.id),
          }
        }
      }
      if ((err instanceof ReintentarCiclo || esReintentable(err)) && intento < 3) continue
      throw err
    }
  }
  throw new Error('No se pudo registrar la gestión (ciclo en conflicto)')
}

/* ───────────────────────── Autorizar seguimiento extra ───────────────────────── */

export async function autorizarExtra(cicloId: number, usuarioId: number, motivoRaw: unknown) {
  const motivo = String(motivoRaw ?? '').trim()
  if (motivo.length < 5 || motivo.length > 500) {
    return falla(400, {
      code: 'MOTIVO_INVALIDO',
      message: 'El motivo es obligatorio (5 a 500 caracteres)',
    })
  }
  const trx = await Database.transaction()
  try {
    const ciclo = await TelemercadeoCiclo.query({ client: trx }).where('id', cicloId).forUpdate().first()
    if (!ciclo) {
      await trx.rollback()
      return falla(404, { code: 'CICLO_NO_ENCONTRADO', message: 'Ciclo no encontrado' })
    }
    if (ciclo.abiertoKey === null || !Boolean(ciclo.abiertoKey)) {
      await trx.rollback()
      return falla(409, { code: 'CICLO_CERRADO', message: 'El ciclo ya está cerrado' })
    }
    ciclo.extrasAutorizados += 1
    await ciclo.useTransaction(trx).save()
    await trx.insertQuery().table('telemercadeo_ciclo_autorizaciones').insert({
      ciclo_id: ciclo.id,
      usuario_id: usuarioId,
      motivo,
      created_at: DateTime.now().toFormat('yyyy-LL-dd HH:mm:ss'),
    })
    await trx.commit()
    return { ok: true as const, ciclo }
  } catch (err) {
    await trx.rollback()
    throw err
  }
}

/* ───────────────────────── Dateo desde una gestión (store()) ───────────────────────── */

/**
 * Valida que el usuario pueda datear desde la gestión: debe ser su propio
 * agente ASESOR_TELEMERCADEO, la gestión suya, de la misma placa y sin dateo.
 * store() usa el agente devuelto (nunca el del body) y fuerza canal TELE.
 */
export async function prepararDateoDesdeGestion(
  gestionId: number,
  usuarioId: number,
  placaNormalizada: string | null
): Promise<{ ok: true; agenteId: number; gestion: TelemercadeoGestion } | Falla> {
  const agente = await agenteTelemercadeoDeUsuario(usuarioId)
  if (!agente) {
    return falla(403, {
      code: 'NO_ES_ASESOR_TELEMERCADEO',
      message: 'Solo un asesor de Telemercadeo puede datear desde una gestión.',
    })
  }
  const gestion = await TelemercadeoGestion.find(gestionId)
  if (!gestion) return falla(404, { code: 'GESTION_NO_ENCONTRADA', message: 'Gestión no encontrada' })
  if (gestion.agenteId !== agente.id) {
    return falla(403, { code: 'GESTION_AJENA', message: 'La gestión no es tuya.' })
  }
  if (gestion.captacionDateoId !== null) {
    return falla(409, {
      code: 'GESTION_YA_DATEADA',
      message: 'Esta gestión ya tiene un dateo vinculado.',
      captacion_dateo_id: gestion.captacionDateoId,
    })
  }
  if (!placaNormalizada || normalizarPlacaTele(placaNormalizada) !== gestion.placa) {
    return falla(400, {
      code: 'GESTION_PLACA_DISTINTA',
      message: `La placa del dateo debe ser la de la gestión (${gestion.placa}).`,
    })
  }
  return { ok: true, agenteId: agente.id, gestion }
}

/**
 * Dentro de la transacción de store(): vincula el dateo a la gestión
 * (resultado → DATEADO) y cierra su ciclo como DATEADO. false si otra
 * petición ya vinculó la gestión (el caller hace rollback y responde 409).
 */
export async function vincularGestionConDateo(
  gestionId: number,
  dateoId: number,
  trx: TransactionClientContract
): Promise<boolean> {
  const gestion = await TelemercadeoGestion.query({ client: trx })
    .where('id', gestionId)
    .forUpdate()
    .first()
  if (!gestion || gestion.captacionDateoId !== null) return false

  gestion.captacionDateoId = dateoId
  gestion.resultado = 'DATEADO'
  await gestion.useTransaction(trx).save()

  const ciclo = await TelemercadeoCiclo.query({ client: trx })
    .where('id', gestion.cicloId)
    .forUpdate()
    .first()
  if (ciclo && ciclo.abiertoKey !== null && Boolean(ciclo.abiertoKey)) {
    await cerrarCiclo(ciclo, 'DATEADO', trx)
  }
  return true
}

/* ───────────────────────── Seguimiento por placa (cola) ───────────────────────── */

export interface SeguimientoPlaca {
  placa: string
  /** Gestiones del ciclo vigente (0 si el ciclo ya cerró o vencería). */
  n: number
  limite: number
  ciclo_abierto: boolean
  ultima_gestion: {
    id: number
    fecha: string
    medio: MedioGestion
    resultado: ResultadoGestion
    agente_id: number
    agente_nombre: string | null
    servicio_id: number
  }
}

/**
 * Última gestión de cada placa (cualquier servicio) con el estado de su
 * ciclo. Solo lectura: el cierre perezoso se evalúa, no se guarda. Pensado
 * para las filas de UNA página de la cola (≤ 100 placas): 4 consultas fijas.
 */
export async function seguimientoPorPlacas(
  placasRaw: string[],
  agenteId: number | null
): Promise<Map<string, SeguimientoPlaca>> {
  const res = new Map<string, SeguimientoPlaca>()
  const placas = [...new Set(placasRaw.map(normalizarPlacaTele).filter(Boolean))]
  if (!placas.length) return res

  const ultimas = (await Database.from('telemercadeo_gestiones as g')
    .joinRaw(
      `JOIN (SELECT MAX(id) AS id FROM telemercadeo_gestiones
             WHERE placa IN (${placas.map(() => '?').join(',')}) GROUP BY placa) m ON m.id = g.id`,
      placas
    )
    .join('telemercadeo_ciclos as c', 'c.id', 'g.ciclo_id')
    .leftJoin('agentes_captacions as a', 'a.id', 'g.agente_id')
    .select(
      'g.id',
      'g.placa',
      'g.servicio_id',
      'g.medio',
      'g.resultado',
      'g.created_at',
      'g.agente_id',
      'a.nombre as agente_nombre',
      'c.numero_gestiones',
      'c.extras_autorizados',
      'c.abierto_key',
      'c.created_at as ciclo_created_at',
      'c.ultima_gestion_at'
    )) as any[]
  if (!ultimas.length) return res

  const [cfg, max] = await Promise.all([getConfigSeguimientoTele(), getMaxSeguimientos(agenteId)])

  const aDT = (v: unknown) =>
    v instanceof Date ? DateTime.fromJSDate(v) : DateTime.fromSQL(String(v), { zone: ZONA_TELE })
  const minApertura = ultimas
    .map((u) => fechaBogota(aDT(u.ciclo_created_at)))
    .sort()[0]
  const turnos = (await Database.from('turnos_rtms')
    .whereIn('placa', ultimas.map((u) => u.placa))
    .where('estado', 'finalizado')
    .where('es_segunda_vez', 0)
    .where('fecha', '>=', minApertura)
    .groupBy('placa', 'servicio_id')
    .select('placa', 'servicio_id')
    .max('fecha as fecha')) as any[]
  const ultimoTurno = new Map<string, string>(
    turnos.map((t) => [
      `${t.placa}|${t.servicio_id}`,
      t.fecha instanceof Date ? DateTime.fromJSDate(t.fecha).toISODate()! : String(t.fecha).substring(0, 10),
    ])
  )

  for (const u of ultimas) {
    const apertura = aDT(u.ciclo_created_at)
    const abierto = u.abierto_key !== null && Boolean(u.abierto_key)
    const fechaTurno = ultimoTurno.get(`${u.placa}|${u.servicio_id}`)
    const vigente =
      abierto &&
      !evaluarCierreCiclo({
        aperturaAt: apertura,
        ultimaGestionAt: u.ultima_gestion_at ? aDT(u.ultima_gestion_at) : null,
        turnoFinalizadoDesdeApertura: !!fechaTurno && fechaTurno >= fechaBogota(apertura),
        diasVigenciaCiclo: cfg.diasVigenciaCiclo,
      })
    const extras = vigente ? Number(u.extras_autorizados) : 0
    res.set(u.placa, {
      placa: u.placa,
      n: vigente ? Number(u.numero_gestiones) : 0,
      limite: max + extras,
      ciclo_abierto: vigente,
      ultima_gestion: {
        id: Number(u.id),
        fecha: aDT(u.created_at).setZone(ZONA_TELE).toISO()!,
        medio: u.medio,
        resultado: u.resultado,
        agente_id: Number(u.agente_id),
        agente_nombre: u.agente_nombre ?? null,
        servicio_id: Number(u.servicio_id),
      },
    })
  }
  return res
}
