// app/services/continuidad_service.ts
//
// Única fuente de verdad para evaluar continuidad de Asesor Convenio.
// Antes existían 3 implementaciones divergentes (turnos_rtms_controller.ts,
// facturacion_tickets_controller.ts, rep_general_imports_controller.ts) que
// podían dar resultados distintos para el mismo cliente. Este servicio las
// reemplaza a las tres.
//
// Regla de negocio (especificación validada):
//  - Se recorre TODO el historial de turnos finalizados de la placa.
//  - Una visita sin dateo vinculado (fachada/otro canal) ROMPE la
//    continuidad — es evidencia real de "no fue con este asesor".
//  - Una visita con dateo cuyo convenio_id/asesor_convenio_id coincide con
//    el actual, NO rompe.
//  - Una visita con dateo cuyo convenio_id/asesor_convenio_id es de OTRO
//    asesor/convenio, ROMPE.
//  - Ninguna visita en el historial (cliente nunca visitó antes) → se
//    respeta la continuidad (no hay nada que la rompa).
//  - Excepción de datos migrados: una visita con dateo cuyo
//    convenio_id/asesor_convenio_id están ambos en NULL Y esa visita es
//    anterior al corte de confiabilidad de datos, se trata como "sin
//    evidencia suficiente" en vez de ruptura — no sabemos si fue con este
//    asesor o no, el dato simplemente no se capturó en esa época.
//  - Un override manual (continuidad_overrides) tiene siempre la última
//    palabra, sin recorrer nada.
import Database from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

export type EstadoContinuidad = 'CONTINUA' | 'ROTA' | 'SIN_EVIDENCIA'

// Fecha a partir de la cual un dateo con asesor_convenio_id/convenio_id en
// NULL se considera una ruptura real. Antes de esta fecha, un NULL se trata
// como dato migrado/histórico sin evidencia suficiente. Confirmado con
// negocio: 2026-04-01.
const CORTE_DATOS_CONFIABLES = DateTime.fromISO('2026-04-01', { zone: 'America/Bogota' })

export interface EvaluarContinuidadParams {
  placa: string
  asesorConvenioId?: number | null
  convenioId?: number | null
  /** Excluir este turno de la revisión de historial (ej. el turno actual, si ya existe). */
  excluirTurnoId?: number | null
}

export async function evaluarContinuidad(
  params: EvaluarContinuidadParams
): Promise<EstadoContinuidad> {
  const { placa, asesorConvenioId = null, convenioId = null, excluirTurnoId = null } = params
  if (!asesorConvenioId && !convenioId) return 'SIN_EVIDENCIA'

  // 1) Override manual — tiene la última palabra.
  const override = await Database.from('continuidad_overrides')
    .where('placa', placa)
    .where((qb) => {
      if (asesorConvenioId) qb.orWhere('asesor_convenio_id', asesorConvenioId)
      if (convenioId) qb.orWhere('convenio_id', convenioId)
    })
    .orderBy('updated_at', 'desc')
    .first()

  if (override?.estado === 'FORZAR_SI') return 'CONTINUA'
  if (override?.estado === 'FORZAR_NO') return 'ROTA'

  // 2) Recorrer TODO el historial de turnos finalizados de la placa.
  const query = Database.from('turnos_rtms')
    .where('placa', placa)
    .where('estado', 'finalizado')
    .orderBy('fecha', 'asc')
    .select('id', 'captacion_dateo_id')
  if (excluirTurnoId) query.whereNot('id', excluirTurnoId)

  const todosLosTurnos = await query

  if (todosLosTurnos.length === 0) return 'CONTINUA'

  let huboVisitaSinEvidencia = false

  for (const turno of todosLosTurnos) {
    const dateoId = turno.captacion_dateo_id
    if (!dateoId) return 'ROTA' // Visita sin dateo (otro canal) → rompe

    const dateo = await Database.from('captacion_dateos')
      .where('id', dateoId)
      .select('convenio_id', 'asesor_convenio_id', 'created_at')
      .first()

    if (!dateo) return 'ROTA'

    const mismoConvenio = convenioId !== null && dateo.convenio_id === convenioId
    const mismoAsesor = asesorConvenioId !== null && dateo.asesor_convenio_id === asesorConvenioId
    if (mismoConvenio || mismoAsesor) continue

    const esNullSinAsesorNiConvenio = !dateo.convenio_id && !dateo.asesor_convenio_id
    if (esNullSinAsesorNiConvenio) {
      const fechaVisita = DateTime.fromJSDate(new Date(dateo.created_at))
      if (fechaVisita < CORTE_DATOS_CONFIABLES) {
        huboVisitaSinEvidencia = true
        continue
      }
    }

    return 'ROTA'
  }

  return huboVisitaSinEvidencia ? 'SIN_EVIDENCIA' : 'CONTINUA'
}
