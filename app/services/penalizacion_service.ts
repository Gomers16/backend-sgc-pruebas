// app/services/penalizacion_service.ts
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import {
  calcularIngresoRtmGeneradoPorAsesor,
  calcularPct,
} from '#controllers/reportes_administrativos_controller'

export interface CumplioMetaResultado {
  cumplio: boolean | null
  ingresoRtmGenerado: number
  metaPesos: number | null
  pctAvance: number | null
}

/**
 * ¿Este asesor cumplió su meta comercial en este mes/año? Llama directamente
 * a calcularIngresoRtmGeneradoPorAsesor() (reportes_administrativos_controller.ts)
 * — el mismo cálculo que usa metaComercialResumen()/metaComercialSuperInforme()
 * — en vez del endpoint HTTP /reportes-admin/meta-comercial/resumen, que es
 * bulk (todos los asesores del mes) y no filtra por un solo asesor.
 *
 * cumplio=null cuando el asesor no tiene meta_pesos configurada ese mes/año
 * (metaPesos null o 0) — no hay contra qué comparar.
 */
export async function evaluarCumplioMeta(
  asesorId: number,
  mes: number,
  anio: number
): Promise<CumplioMetaResultado> {
  const metaRow = await Database.from('meta_comercial_asesor')
    .where({ asesor_id: asesorId, mes, anio })
    .select('meta_pesos')
    .first()
  const metaPesos = metaRow ? Number(metaRow.meta_pesos) : null

  const inicioMes = DateTime.fromObject({ year: anio, month: mes, day: 1 })
  const fechaInicio = inicioMes.toISODate() as string
  const fechaFin = inicioMes.endOf('month').toISODate() as string

  const ingresoMap = await calcularIngresoRtmGeneradoPorAsesor([asesorId], fechaInicio, fechaFin)
  const ingreso = ingresoMap.get(asesorId)
  const ingresoRtmGenerado = ingreso
    ? ingreso.convenio.pesosMotos +
      ingreso.convenio.pesosVehiculos +
      ingreso.comercial.pesosMotos +
      ingreso.comercial.pesosVehiculos
    : 0

  if (metaPesos === null || metaPesos <= 0) {
    return { cumplio: null, ingresoRtmGenerado, metaPesos, pctAvance: null }
  }

  const pctAvance = calcularPct(ingresoRtmGenerado, metaPesos)
  return {
    cumplio: pctAvance !== null ? pctAvance >= 100 : null,
    ingresoRtmGenerado,
    metaPesos,
    pctAvance,
  }
}

/**
 * Bolsa de comisiones disponible de un asesor en un mes/año — SUM(monto_asesor)
 * de comisiones reales (es_config=false) en estado PENDIENTE/APROBADA
 * ÚNICAMENTE, agrupadas por fecha_calculo (confirmado como el campo correcto
 * para "a qué mes pertenece" una comisión — no created_at).
 *
 * Dos exclusiones deliberadas, ambas por el mismo principio de cautela ya
 * aplicado en aprobar() (nunca tocar plata que no es del comercial, ni plata
 * que ya salió de la empresa):
 *  - PAGADA queda fuera desde este cálculo (no solo protegida al repartir):
 *    esa comisión ya se desembolsó, no hay nada real que "recuperar" de ahí
 *    sin un movimiento de reverso explícito que no existe en este flujo.
 *  - Solo monto_asesor, nunca monto_convenio: esa plata es de un tercero
 *    (el convenio) ajeno a la infracción del ticket — igual que la fórmula
 *    de aprobar() ya no la toca para calcular el cargo, la bolsa tampoco
 *    debe contar dinero que el reparto de cobrarSaldo() jamás va a tocar.
 *
 * Sin filtro de tipo_servicio: toda comisión PENDIENTE/APROBADA del mes
 * cuenta para la bolsa, no solo RTM.
 */
export async function calcularBolsaComisionesMes(
  asesorId: number,
  mes: number,
  anio: number
): Promise<number> {
  const row = await Database.from('comisiones')
    .where('asesor_id', asesorId)
    .where('es_config', false)
    .whereIn('estado', ['PENDIENTE', 'APROBADA'])
    .whereRaw('MONTH(fecha_calculo) = ? AND YEAR(fecha_calculo) = ?', [mes, anio])
    .sum('monto_asesor as suma_asesor')
    .first()

  return Number(row?.suma_asesor ?? 0)
}
