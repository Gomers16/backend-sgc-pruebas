// app/services/ticket_comision_origen_service.ts
//
// Comisiones que vienen de un ticket de Excepción de Dateo APROBADO:
//  - la marca que muestra Comisiones (ticket, caso, decisión, quién y cuándo
//    decidió, lo dejado de pagar) y el filtro "Origen";
//  - la regla que impide pisar el $0 que decidió gerencia (editar, valores,
//    crear a mano, PUT /captacion-dateos/:id) salvo confirmación explícita de
//    SUPER_ADMIN/GERENCIA (confirmar_excepcion=true, mismo patrón que el dateo).
//
// Vínculo: comision.captacion_dateo_id → captacion_dateos.consumido_turno_id
// → tickets_detalle_excepcion_dateo.turno_id. Flags con la misma regla de
// compatibilidad que el resto del módulo (sqlFlagAsesor/sqlFlagConvenio).

import type { HttpContext } from '@adonisjs/core/http'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import Database from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'
import { sqlFlagAsesor, sqlFlagConvenio } from '#services/tickets_consulta_service'
import {
  decidirCasoComision,
  resolveConfigComision,
  inferTipoVehiculoComision,
  type CasoComision,
} from '#services/comision_calculo_service'
import { registrarEventoTicket } from '#services/ticket_eventos_service'

export type MarcaTicketComision = 'SIN_COMISION_ASESOR' | 'SIN_COMISION_CONVENIO' | 'SIN_COMISION'

export interface TicketOrigenComision {
  ticket_id: number
  caso: CasoComision
  dentro_ventana: boolean
  sin_comision_asesor: boolean
  sin_comision_convenio: boolean
  /** null = el ticket se aprobó con comisión completa. */
  marca: MarcaTicketComision | null
  /** "Sin comisión asesor · ticket #123" (o null). */
  etiqueta: string | null
  decidido_por_id: number | null
  decidido_por_nombre: string | null
  decidido_at: string | null
  /** Solo en el detalle (GET /comisiones/:id). */
  dejado_de_pagar?: {
    asesor: number
    convenio: number | null
    /** true = foto del valor calculado guardada al aplicar la decisión. */
    exacto: boolean
  } | null
}

/** Condición SQL: la comisión (alias `c`) viene de un ticket aprobado; `soloSin` = con algún "sin comisión". */
export function sqlComisionDeTicket(c: string, soloSin: boolean): string {
  const sin = soloSin ? ` AND (${sqlFlagAsesor('d')} = 0 OR ${sqlFlagConvenio('d')} = 0)` : ''
  return (
    `EXISTS (SELECT 1 FROM captacion_dateos cdo` +
    ` JOIN tickets_detalle_excepcion_dateo d ON d.turno_id = cdo.consumido_turno_id` +
    ` JOIN tickets tko ON tko.id = d.ticket_id AND tko.estado = 'APROBADO'` +
    ` WHERE cdo.id = ${c}.captacion_dateo_id${sin})`
  )
}

const n = (v: unknown) => Number(v ?? 0) || 0
const esCero = (v: unknown) => v !== null && v !== undefined && Number(v) === 0

function marcaDe(caso: CasoComision, sinA: boolean, sinC: boolean): MarcaTicketComision | null {
  if (!sinA && !sinC) return null
  // Caso 1 (no hay convenio) y Caso 2 (asesor = convenio): no se separa.
  if (caso !== 'CONVENIO_COMERCIAL' || (sinA && sinC)) return 'SIN_COMISION'
  return sinA ? 'SIN_COMISION_ASESOR' : 'SIN_COMISION_CONVENIO'
}

const TEXTO_MARCA: Record<MarcaTicketComision, string> = {
  SIN_COMISION_ASESOR: 'Sin comisión asesor',
  SIN_COMISION_CONVENIO: 'Sin comisión convenio',
  SIN_COMISION: 'Sin comisión',
}

/** Ticket de origen por id de dateo (solo tickets APROBADOS). */
export async function ticketsOrigenPorDateo(
  dateoIds: (number | null | undefined)[]
): Promise<Map<number, TicketOrigenComision>> {
  const ids = [...new Set(dateoIds.filter((x): x is number => !!x))]
  const out = new Map<number, TicketOrigenComision>()
  if (!ids.length) return out
  const filas = (await Database.from('captacion_dateos as cd')
    .join('tickets_detalle_excepcion_dateo as d', 'd.turno_id', 'cd.consumido_turno_id')
    .join('tickets as t', 't.id', 'd.ticket_id')
    .leftJoin('convenios as cv', 'cv.id', 'cd.convenio_id')
    .leftJoin('usuarios as u', 'u.id', 'd.aprobado_por_id')
    .whereIn('cd.id', ids)
    .where('t.estado', 'APROBADO')
    .select(
      'cd.id as dateo_id',
      'cd.convenio_id',
      'cd.agente_id',
      'cd.canal',
      'cv.asesor_convenio_id',
      'd.ticket_id',
      'd.dentro_ventana',
      'd.aprobado_por_id',
      'd.aprobado_at',
      'u.nombres',
      'u.apellidos'
    )
    .select(
      Database.raw(`${sqlFlagAsesor('d')} as flag_asesor`),
      Database.raw(`${sqlFlagConvenio('d')} as flag_convenio`)
    )
    .orderBy('d.ticket_id', 'desc')) as any[]

  for (const r of filas) {
    if (out.has(r.dateo_id)) continue
    const caso = decidirCasoComision({
      convenioId: r.convenio_id,
      agenteId: r.agente_id,
      canal: r.canal,
      asesorConvenioIdDelConvenio: r.asesor_convenio_id ?? null,
    })
    const sinA = esCero(r.flag_asesor)
    const sinC = esCero(r.flag_convenio)
    const marca = marcaDe(caso, sinA, sinC)
    const fecha =
      r.aprobado_at instanceof Date ? r.aprobado_at : r.aprobado_at ? new Date(r.aprobado_at) : null
    out.set(r.dateo_id, {
      ticket_id: r.ticket_id,
      caso,
      dentro_ventana: Boolean(r.dentro_ventana),
      sin_comision_asesor: sinA,
      sin_comision_convenio: sinC,
      marca,
      etiqueta: marca ? `${TEXTO_MARCA[marca]} · ticket #${r.ticket_id}` : null,
      decidido_por_id: r.aprobado_por_id ?? null,
      decidido_por_nombre: r.nombres ? `${r.nombres} ${r.apellidos ?? ''}`.trim() : null,
      decidido_at: fecha ? DateTime.fromJSDate(fecha).toISO() : null,
    })
  }
  return out
}

/**
 * Lo dejado de pagar para el detalle de una comisión con "sin comisión":
 * exacto con la foto del valor calculado; si no hay foto, estimado (asesor =
 * monto − monto_asesor; convenio = incentivo vigente del Caso 3).
 */
export async function dejadoDePagarComision(
  origen: TicketOrigenComision,
  comision: { monto: string | number | null; montoAsesor: string | number | null },
  turno: { tipoVehiculo?: string | null } | null,
  dateo: { agenteId: number | null; convenioId: number | null } | null
): Promise<TicketOrigenComision['dejado_de_pagar']> {
  if (!origen.marca) return null
  const foto = await Database.from('tickets_detalle_excepcion_dateo')
    .where('ticket_id', origen.ticket_id)
    .select('monto_asesor_calculado', 'monto_convenio_calculado')
    .first()
  if (foto && foto.monto_asesor_calculado !== null && foto.monto_asesor_calculado !== undefined) {
    return {
      asesor: origen.sin_comision_asesor ? n(foto.monto_asesor_calculado) : 0,
      convenio: origen.sin_comision_convenio ? n(foto.monto_convenio_calculado) : 0,
      exacto: true,
    }
  }
  const asesor = origen.sin_comision_asesor
    ? Math.max(0, n(comision.monto) - n(comision.montoAsesor))
    : 0
  let convenio: number | null = 0
  if (origen.sin_comision_convenio && origen.caso === 'CONVENIO_COMERCIAL') {
    const cv = dateo?.convenioId
      ? await Database.from('convenios')
          .where('id', dateo.convenioId)
          .select('asesor_convenio_id')
          .first()
      : null
    const cfg = await resolveConfigComision({
      asesorId: dateo?.agenteId ?? null,
      asesorConvenioId: cv?.asesor_convenio_id ?? null,
      tipoVehiculo: inferTipoVehiculoComision({ turnoTipo: turno?.tipoVehiculo ?? null }),
    })
    convenio = cfg.valorIncentivoCaso3
  }
  return { asesor, convenio, exacto: false }
}

/* ═══════════════ Bloqueo de montos que contradicen la decisión ═══════════════ */

export const CODIGO_CONFLICTO = 'MONTO_CONTRADICE_TICKET_SIN_COMISION'
const ROLES_CONFIRMAN = ['SUPER_ADMIN', 'GERENCIA']

export interface ConflictoSinComision {
  ticketId: number
  sinAsesor: boolean
  sinConvenio: boolean
  /** Campos cuyo valor contradice la decisión. */
  campos: ('monto_asesor' | 'monto_convenio')[]
}

/**
 * ¿Los montos que se quieren escribir contradicen la decisión del ticket del
 * turno? Solo cuenta un monto > 0 en la parte que quedó "sin comisión".
 * `undefined` = ese monto no se está cambiando.
 */
export async function conflictoSinComisionTicket(
  turnoId: number | null | undefined,
  montos: { montoAsesor?: number; montoConvenio?: number }
): Promise<ConflictoSinComision | null> {
  if (!turnoId) return null
  const d = (await Database.from('tickets_detalle_excepcion_dateo as d')
    .join('tickets as t', 't.id', 'd.ticket_id')
    .where('d.turno_id', turnoId)
    .where('t.estado', 'APROBADO')
    .select('d.ticket_id')
    .select(
      Database.raw(`${sqlFlagAsesor('d')} as flag_asesor`),
      Database.raw(`${sqlFlagConvenio('d')} as flag_convenio`)
    )
    .orderBy('d.ticket_id', 'desc')
    .first()) as any
  if (!d) return null
  const sinAsesor = esCero(d.flag_asesor)
  const sinConvenio = esCero(d.flag_convenio)
  const campos: ConflictoSinComision['campos'] = []
  if (sinAsesor && (montos.montoAsesor ?? 0) > 0) campos.push('monto_asesor')
  if (sinConvenio && (montos.montoConvenio ?? 0) > 0) campos.push('monto_convenio')
  return campos.length ? { ticketId: d.ticket_id, sinAsesor, sinConvenio, campos } : null
}

/**
 * Decide qué hacer con un conflicto: sin conflicto o confirmado por un rol
 * que puede → seguir. Si no, deja puesta la respuesta en ctx.response (409
 * sin confirmación; 403 si confirma alguien que no puede) y devuelve
 * `bloqueado` = true: el llamador corta sin escribir nada. (response.conflict()
 * de Adonis no devuelve la respuesta, por eso el booleano.)
 */
export async function resolverConflictoSinComision(
  ctx: HttpContext,
  conflicto: ConflictoSinComision | null
): Promise<{ bloqueado: boolean; confirmada: boolean }> {
  if (!conflicto) return { bloqueado: false, confirmada: false }
  const { request, response, auth } = ctx
  const confirmar =
    request.input('confirmar_excepcion') === true || request.input('confirmar_excepcion') === 'true'
  if (auth.user && !auth.user.rol) await auth.user.load('rol')
  const rol = String(auth.user?.rol?.nombre ?? '').toUpperCase()
  const puedeConfirmar = ROLES_CONFIRMAN.includes(rol)
  const base = {
    code: CODIGO_CONFLICTO,
    message: `Este valor viene de un ticket que decidió sin comisión (ticket #${conflicto.ticketId})`,
    ticket_id: conflicto.ticketId,
    decision: {
      sin_comision_asesor: conflicto.sinAsesor,
      sin_comision_convenio: conflicto.sinConvenio,
    },
    campos: conflicto.campos,
    puede_confirmar: puedeConfirmar,
  }
  if (!confirmar) {
    response.conflict(base)
    return { bloqueado: true, confirmada: false }
  }
  if (!puedeConfirmar) {
    response.forbidden({
      ...base,
      code: 'CONFIRMACION_SIN_COMISION_NO_PERMITIDA',
      message: `Solo SUPER_ADMIN o GERENCIA pueden confirmar un valor contra la decisión del ticket #${conflicto.ticketId}.`,
    })
    return { bloqueado: true, confirmada: false }
  }
  return { bloqueado: false, confirmada: true }
}

/**
 * Deja registrado quién y cuándo pasó por encima de la decisión: una línea en
 * comisiones.observacion y un comentario en el ticket (evento COMENTARIO).
 */
export async function registrarExcepcionSinComision(
  trx: TransactionClientContract | null,
  p: {
    conflicto: ConflictoSinComision
    comisionId: number
    usuarioId: number
    usuarioNombre: string
    accion: string
    montos: { montoAsesor?: number; montoConvenio?: number }
  }
) {
  const cliente = trx ?? Database
  const fecha = DateTime.now().setZone('America/Bogota').toFormat('dd/LL/yyyy HH:mm')
  const valores = p.conflicto.campos
    .map((c) => `${c} = ${c === 'monto_asesor' ? p.montos.montoAsesor : p.montos.montoConvenio}`)
    .join(', ')
  const linea = `[Excepción ticket #${p.conflicto.ticketId}] ${p.accion}: ${valores} — confirmado por ${p.usuarioNombre} el ${fecha}`
  const actual = await cliente
    .from('comisiones')
    .where('id', p.comisionId)
    .select('observacion')
    .first()
  await cliente
    .from('comisiones')
    .where('id', p.comisionId)
    .update({ observacion: actual?.observacion ? `${actual.observacion}\n${linea}` : linea })

  const ejecutar = async (t: TransactionClientContract) => {
    const [comentarioId] = await t.table('tickets_comentarios').insert({
      ticket_id: p.conflicto.ticketId,
      usuario_id: p.usuarioId,
      mensaje: `Comisión #${p.comisionId}: ${p.accion} contra la decisión del ticket (${valores}).`,
      created_at: DateTime.now().toSQL({ includeOffset: false }),
    })
    await registrarEventoTicket(t, {
      ticketId: p.conflicto.ticketId,
      tipo: 'COMENTARIO',
      usuarioId: p.usuarioId,
      datos: { comentario_id: comentarioId, comision_id: p.comisionId, excepcion: true },
    })
  }
  if (trx) await ejecutar(trx)
  else await Database.transaction(ejecutar)
}
