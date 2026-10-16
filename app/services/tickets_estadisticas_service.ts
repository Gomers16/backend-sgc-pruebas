// app/services/tickets_estadisticas_service.ts
//
// Estadísticas de tickets de Excepción de Dateo (GET /tickets/estadisticas y
// hoja resumen de GET /tickets/exportar). Fuente: tickets +
// tickets_detalle_excepcion_dateo + turnos_rtms + comisiones; ticket_eventos
// no participa (producción local no lo escribe).
//
// DINERO, por asesor del ticket (d.comercial_id), separado asesor/convenio:
//  - comision_real: la comisión ya existe (turno exitoso / Facturación
//    confirmada) → montos reales de la última comisión del dateo del turno,
//    desglosados por su estado (PENDIENTE/APROBADA/PAGADA/ANULADA). Los
//    totales asesor/convenio excluyen ANULADA.
//  - en_proceso: ticket aprobado cuyo dateo todavía no tiene comisión → valor
//    calculado con calcularComision() y la configuración vigente, ya con la
//    decisión de gerencia aplicada.
//  - dejado_de_pagar: lo que la decisión "sin comisión" dejó en $0.
//      asesor   = monto − monto_asesor de la comisión real (monto es siempre el
//                 valor completo del asesor en los 3 casos; el Rep General lo
//                 mantiene así), o el calculado si está en proceso.
//      convenio = estimado con la configuración vigente (la comisión no guarda
//                 el valor del convenio que se forzó a $0).
//  El cálculo por ticket (en proceso + estimación de convenio) se limita a
//  LIMITE_CALCULO_POR_TICKET filas; la respuesta avisa si se truncó.

import Database from '@adonisjs/lucid/services/db'
import {
  calcularComision,
  decidirCasoComision,
  inferTipoVehiculoComision,
  resolveConfigComision,
  resolveConfigRecurrencia,
  type ConfigComisionResuelta,
  type ConfigRecurrenciaResuelta,
  type EscenarioCliente,
  type OrigenDescuento,
} from '#services/comision_calculo_service'
import { evaluarContinuidad } from '#services/continuidad_service'
import {
  aplicarFiltrosTickets,
  sqlDecisionComision,
  sqlFlagAsesor,
  sqlFlagConvenio,
  type FiltrosTickets,
} from '#services/tickets_consulta_service'

export const LIMITE_CALCULO_POR_TICKET = 500
export const ESTADOS_COMISION = ['PENDIENTE', 'APROBADA', 'PAGADA', 'ANULADA'] as const

interface Montos {
  asesor: number
  convenio: number
  tickets: number
}
const montos = (): Montos => ({ asesor: 0, convenio: 0, tickets: 0 })

export interface BloqueEstadisticas {
  creados: number
  dentro_ventana: number
  fuera_ventana: number
  aprobados: {
    total: number
    con: number
    sin_asesor: number
    sin_convenio: number
    sin_ninguno: number
    regimen_anterior: number
  }
  rechazados: number
  pendientes: number
  /** aprobados / (aprobados + rechazados); null si no hay resueltos. */
  tasa_aprobacion: number | null
  tiempo_promedio_resolucion_min: number | null
  dinero: {
    comision_real: Montos & { por_estado: Record<string, Montos> }
    en_proceso: Montos
    dejado_de_pagar: Montos
  }
}

interface Acumulado extends BloqueEstadisticas {
  _segResolucion: number
  _resueltos: number
}

function bloqueVacio(): Acumulado {
  return {
    creados: 0,
    dentro_ventana: 0,
    fuera_ventana: 0,
    aprobados: {
      total: 0,
      con: 0,
      sin_asesor: 0,
      sin_convenio: 0,
      sin_ninguno: 0,
      regimen_anterior: 0,
    },
    rechazados: 0,
    pendientes: 0,
    tasa_aprobacion: null,
    tiempo_promedio_resolucion_min: null,
    dinero: {
      comision_real: {
        ...montos(),
        por_estado: Object.fromEntries(ESTADOS_COMISION.map((e) => [e, montos()])),
      },
      en_proceso: montos(),
      dejado_de_pagar: montos(),
    },
    _segResolucion: 0,
    _resueltos: 0,
  }
}

const n = (v: unknown) => Number(v ?? 0) || 0
const redondear = (v: number) => Math.round(v * 100) / 100

/** Base común: tickets de Excepción de Dateo con su detalle, filtrados. */
function base(f: FiltrosTickets) {
  const q = Database.from('tickets as t')
    .join('tipos_ticket as tt', 'tt.id', 't.tipo_ticket_id')
    .join('tickets_detalle_excepcion_dateo as d', 'd.ticket_id', 't.id')
    .where('tt.codigo', 'EXCEPCION_DATEO')
  return aplicarFiltrosTickets(q, f, 't', 'd')
}

/** Última comisión real (no config) del dateo vinculado al turno del ticket. */
const SQL_ULTIMA_COMISION =
  '(SELECT MAX(c2.id) FROM comisiones c2 WHERE c2.captacion_dateo_id = tr.captacion_dateo_id AND c2.es_config = 0)'

export async function estadisticasTickets(f: FiltrosTickets) {
  const grupos = new Map<
    number,
    Acumulado & { comercial_id: number; comercial_nombre: string | null }
  >()
  const grupo = (id: number, nombre: string | null = null) => {
    let g = grupos.get(id)
    if (!g) {
      g = { comercial_id: id, comercial_nombre: nombre, ...bloqueVacio() }
      grupos.set(id, g)
    }
    if (nombre && !g.comercial_nombre) g.comercial_nombre = nombre
    return g
  }
  const dec = sqlDecisionComision('t', 'd')

  // 1) Conteos.
  const conteos = await base(f)
    .leftJoin('agentes_captacions as ac', 'ac.id', 'd.comercial_id')
    .groupBy('d.comercial_id')
    .select('d.comercial_id')
    .select(
      Database.raw(`MAX(ac.nombre) as nombre`),
      Database.raw(`COUNT(*) as creados`),
      Database.raw(`SUM(d.dentro_ventana = 1) as dentro`),
      Database.raw(`SUM(d.dentro_ventana = 0) as fuera`),
      Database.raw(`SUM(t.estado = 'APROBADO') as aprobados`),
      Database.raw(`SUM(${dec} = 'con') as d_con`),
      Database.raw(`SUM(${dec} = 'sin_asesor') as d_sin_asesor`),
      Database.raw(`SUM(${dec} = 'sin_convenio') as d_sin_convenio`),
      Database.raw(`SUM(${dec} = 'sin_ninguno') as d_sin_ninguno`),
      Database.raw(`SUM(${dec} = 'regimen_anterior') as d_regimen_anterior`),
      Database.raw(`SUM(t.estado = 'RECHAZADO') as rechazados`),
      Database.raw(`SUM(t.estado = 'PENDIENTE') as pendientes`),
      Database.raw(
        `SUM(CASE WHEN t.estado IN ('APROBADO','RECHAZADO') AND t.resuelto_at IS NOT NULL THEN TIMESTAMPDIFF(SECOND, t.created_at, t.resuelto_at) END) as seg_resolucion`
      ),
      Database.raw(
        `SUM(t.estado IN ('APROBADO','RECHAZADO') AND t.resuelto_at IS NOT NULL) as resueltos`
      )
    )
  for (const r of conteos as any[]) {
    const g = grupo(Number(r.comercial_id), r.nombre)
    g.creados = n(r.creados)
    g.dentro_ventana = n(r.dentro)
    g.fuera_ventana = n(r.fuera)
    g.aprobados = {
      total: n(r.aprobados),
      con: n(r.d_con),
      sin_asesor: n(r.d_sin_asesor),
      sin_convenio: n(r.d_sin_convenio),
      sin_ninguno: n(r.d_sin_ninguno),
      regimen_anterior: n(r.d_regimen_anterior),
    }
    g.rechazados = n(r.rechazados)
    g.pendientes = n(r.pendientes)
    g._segResolucion = n(r.seg_resolucion)
    g._resueltos = n(r.resueltos)
  }

  // 2) Dinero real (la comisión ya existe), agregado por asesor y estado.
  const reales = await base(f)
    .where('t.estado', 'APROBADO')
    .join('turnos_rtms as tr', 'tr.id', 'd.turno_id')
    .joinRaw(`JOIN comisiones c ON c.id = ${SQL_ULTIMA_COMISION}`)
    .groupBy('d.comercial_id', 'c.estado')
    .select('d.comercial_id', 'c.estado')
    .select(
      Database.raw('COUNT(*) as tickets'),
      Database.raw('SUM(c.monto_asesor) as asesor'),
      Database.raw('SUM(c.monto_convenio) as convenio'),
      Database.raw(
        `SUM(CASE WHEN c.estado <> 'ANULADA' AND ${sqlFlagAsesor('d')} = 0 THEN GREATEST(c.monto - c.monto_asesor, 0) ELSE 0 END) as dejado_asesor`
      ),
      Database.raw(
        `SUM(c.estado <> 'ANULADA' AND (${sqlFlagAsesor('d')} = 0 OR ${sqlFlagConvenio('d')} = 0)) as dejado_tickets`
      )
    )
  for (const r of reales as any[]) {
    const g = grupo(Number(r.comercial_id))
    const real = g.dinero.comision_real
    const e = real.por_estado[r.estado] ?? (real.por_estado[r.estado] = montos())
    e.asesor += n(r.asesor)
    e.convenio += n(r.convenio)
    e.tickets += n(r.tickets)
    if (r.estado !== 'ANULADA') {
      real.asesor += n(r.asesor)
      real.convenio += n(r.convenio)
      real.tickets += n(r.tickets)
    }
    g.dinero.dejado_de_pagar.asesor += n(r.dejado_asesor)
    g.dinero.dejado_de_pagar.tickets += n(r.dejado_tickets)
  }

  // 3) Cálculo por ticket: aprobados sin comisión todavía (en proceso) y
  //    comisiones reales con el convenio en $0 (para estimar lo no pagado).
  const filas = (await base(f)
    .where('t.estado', 'APROBADO')
    .join('turnos_rtms as tr', 'tr.id', 'd.turno_id')
    .join('captacion_dateos as cd', 'cd.id', 'tr.captacion_dateo_id')
    .leftJoin('convenios as cv', 'cv.id', 'cd.convenio_id')
    .leftJoin('descuentos as ds', 'ds.id', 'cd.descuento_id')
    .joinRaw(`LEFT JOIN comisiones c ON c.id = ${SQL_ULTIMA_COMISION}`)
    .where((q: any) => {
      q.whereNull('c.id').orWhere((q2: any) => {
        q2.whereRaw(`${sqlFlagConvenio('d')} = 0`).whereNot('c.estado', 'ANULADA')
      })
    })
    .select(
      't.id as ticket_id',
      'd.comercial_id',
      'd.dentro_ventana',
      'tr.id as turno_id',
      'tr.placa',
      'tr.tipo_vehiculo',
      'tr.es_recurrente',
      'tr.es_recuperacion',
      'cd.agente_id',
      'cd.convenio_id',
      'cd.canal',
      'cd.descuento_id',
      'cd.es_avance',
      'ds.codigo as descuento_codigo',
      'ds.valor_carro',
      'ds.valor_moto',
      'cv.asesor_convenio_id',
      'c.id as comision_id',
      'c.es_avance as c_es_avance',
      'c.descuento_codigo_aplicado as c_descuento_codigo'
    )
    .select(
      Database.raw(`${sqlFlagAsesor('d')} as flag_asesor`),
      Database.raw(`${sqlFlagConvenio('d')} as flag_convenio`)
    )
    .orderBy('t.id', 'desc')
    .limit(LIMITE_CALCULO_POR_TICKET + 1)) as any[]

  const truncado = filas.length > LIMITE_CALCULO_POR_TICKET
  const cacheCfg = new Map<string, Promise<ConfigComisionResuelta>>()
  const cacheRec = new Map<string, Promise<ConfigRecurrenciaResuelta>>()

  for (const r of filas.slice(0, LIMITE_CALCULO_POR_TICKET)) {
    const tipoVehiculo = inferTipoVehiculoComision({ turnoTipo: r.tipo_vehiculo })
    const asesorConvenioId = r.asesor_convenio_id ?? null
    const caso = decidirCasoComision({
      convenioId: r.convenio_id,
      agenteId: r.agente_id,
      canal: r.canal,
      asesorConvenioIdDelConvenio: asesorConvenioId,
    })
    const escenario: EscenarioCliente = r.es_recurrente
      ? 'RECURRENTE'
      : r.es_recuperacion
        ? 'RECUPERACION'
        : 'NUEVO'

    const kCfg = `${r.agente_id}|${asesorConvenioId}|${tipoVehiculo}`
    if (!cacheCfg.has(kCfg)) {
      cacheCfg.set(
        kCfg,
        resolveConfigComision({ asesorId: r.agente_id, asesorConvenioId, tipoVehiculo })
      )
    }
    const kRec = `${r.agente_id}|${tipoVehiculo}`
    if (!cacheRec.has(kRec)) cacheRec.set(kRec, resolveConfigRecurrencia(r.agente_id, tipoVehiculo))

    // La continuidad solo cambia el resultado en Caso 2 recurrente/recuperación.
    let tuvoContinuidad = true
    if (caso === 'CONVENIO_SELF' && escenario !== 'NUEVO') {
      const estado = await evaluarContinuidad({
        placa: r.placa,
        asesorConvenioId,
        convenioId: r.convenio_id,
        excluirTurnoId: r.turno_id,
      })
      tuvoContinuidad = estado !== 'ROTA'
    }

    const enProceso = r.comision_id === null || r.comision_id === undefined
    const esAvance = caso !== 'SIN_CONVENIO' && Boolean(enProceso ? r.es_avance : r.c_es_avance)
    const codigoDescuento: string | null = enProceso
      ? (r.descuento_codigo ?? null)
      : (r.c_descuento_codigo ?? null)
    const origenDescuento: OrigenDescuento =
      !enProceso && codigoDescuento && !r.descuento_id ? 'CAJA' : 'DATEO'
    const montoAvance =
      esAvance && r.descuento_id ? n(tipoVehiculo === 'MOTO' ? r.valor_moto : r.valor_carro) : 0

    const calc = calcularComision({
      caso,
      escenario,
      tuvoContinuidad,
      esAvance,
      montoAvance,
      codigoDescuento,
      origenDescuento,
      cfgValues: await cacheCfg.get(kCfg)!,
      recValues: await cacheRec.get(kRec)!,
    })

    const sinAsesor = r.flag_asesor !== null && r.flag_asesor !== undefined && !r.flag_asesor
    const sinConvenio =
      r.flag_convenio !== null && r.flag_convenio !== undefined && !r.flag_convenio
    const g = grupo(Number(r.comercial_id))
    const dejado = g.dinero.dejado_de_pagar

    if (enProceso) {
      const ep = g.dinero.en_proceso
      ep.asesor += sinAsesor ? 0 : calc.montoAsesor
      ep.convenio += sinConvenio ? 0 : calc.montoConvenio
      ep.tickets += 1
      if (sinAsesor) dejado.asesor += calc.montoAsesor
      if (sinConvenio) dejado.convenio += calc.montoConvenio
      if (sinAsesor || sinConvenio) dejado.tickets += 1
    } else if (sinConvenio) {
      // Comisión real con el convenio en $0: el asesor ya se contó en (2).
      dejado.convenio += calc.montoConvenio
    }
  }

  // Cierre: derivados y totales.
  const total = bloqueVacio()
  const porAsesor = [...grupos.values()].sort((a, b) => b.creados - a.creados)
  for (const g of porAsesor) {
    for (const k of [
      'creados',
      'dentro_ventana',
      'fuera_ventana',
      'rechazados',
      'pendientes',
    ] as const) {
      total[k] += g[k]
    }
    for (const k of Object.keys(g.aprobados) as (keyof Acumulado['aprobados'])[]) {
      total.aprobados[k] += g.aprobados[k]
    }
    total._segResolucion += g._segResolucion
    total._resueltos += g._resueltos
    sumarDinero(total, g)
  }

  return {
    totales: cerrar(total),
    por_asesor: porAsesor.map((g) => ({
      comercial_id: g.comercial_id,
      comercial_nombre: g.comercial_nombre,
      ...cerrar(g),
    })),
    meta: {
      calculados_por_ticket: Math.min(filas.length, LIMITE_CALCULO_POR_TICKET),
      calculo_truncado: truncado,
      limite_calculo_por_ticket: LIMITE_CALCULO_POR_TICKET,
      en_proceso_y_convenio_dejado_son_estimados: true,
    },
  }
}

function sumarDinero(dst: Acumulado, src: Acumulado) {
  const sum = (a: Montos, b: Montos) => {
    a.asesor += b.asesor
    a.convenio += b.convenio
    a.tickets += b.tickets
  }
  sum(dst.dinero.comision_real, src.dinero.comision_real)
  for (const [estado, m] of Object.entries(src.dinero.comision_real.por_estado)) {
    sum(
      dst.dinero.comision_real.por_estado[estado] ??
        (dst.dinero.comision_real.por_estado[estado] = montos()),
      m
    )
  }
  sum(dst.dinero.en_proceso, src.dinero.en_proceso)
  sum(dst.dinero.dejado_de_pagar, src.dinero.dejado_de_pagar)
}

function cerrar(g: Acumulado): BloqueEstadisticas {
  const resueltos = g.aprobados.total + g.rechazados
  const r = (m: Montos): Montos => ({
    asesor: redondear(m.asesor),
    convenio: redondear(m.convenio),
    tickets: m.tickets,
  })
  return {
    creados: g.creados,
    dentro_ventana: g.dentro_ventana,
    fuera_ventana: g.fuera_ventana,
    aprobados: g.aprobados,
    rechazados: g.rechazados,
    pendientes: g.pendientes,
    tasa_aprobacion: resueltos ? redondear(g.aprobados.total / resueltos) : null,
    tiempo_promedio_resolucion_min: g._resueltos
      ? redondear(g._segResolucion / g._resueltos / 60)
      : null,
    dinero: {
      comision_real: {
        ...r(g.dinero.comision_real),
        por_estado: Object.fromEntries(
          Object.entries(g.dinero.comision_real.por_estado).map(([k, m]) => [k, r(m)])
        ),
      },
      en_proceso: r(g.dinero.en_proceso),
      dejado_de_pagar: r(g.dinero.dejado_de_pagar),
    },
  }
}
