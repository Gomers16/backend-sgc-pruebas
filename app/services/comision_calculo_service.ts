// app/services/comision_calculo_service.ts
//
// Única fuente de verdad para: (1) resolver la configuración de comisión
// aplicable (cascada asesor → global) y (2) calcular el monto final según
// el caso de negocio (1/2/3), escenario del cliente, continuidad, avance y
// descuentos informativos. Antes esta lógica vivía inline dentro de
// facturacion_tickets_controller.ts (applyCommissionHook). Se extrajo aquí
// para que el endpoint de simulación (dry-run) ejecute EXACTAMENTE la misma
// función que el flujo real, sin duplicar reglas de negocio.
//
// captacion_dateos_controller.ts tiene una implementación paralela más
// simple (sin continuidad) que NO fue tocada — queda fuera de este service
// por ahora.

import Comision from '#models/comision'
import Database from '@adonisjs/lucid/services/db'

export type TipoVehiculoComision = 'MOTO' | 'VEHICULO'

/* ============================================================
 *   Helpers de clasificación — compartidos entre todas las rutas
 *   que generan comisiones (ticket de facturación, dateo manual).
 * ============================================================*/

/** Determina si un servicio cuenta como RTM para efectos de comisión. */
export function isRTM(codigo?: string | null, nombre?: string | null): boolean {
  const c = (codigo || '').toUpperCase().trim()
  const n = (nombre || '').toUpperCase().trim()
  if (c.includes('RTM')) return true
  if (n.includes('RTM')) return true
  if (n.includes('TECNOMECANICA') || n.includes('TECNOMECÁNICA')) return true
  if (n.includes('REVISION') && n.includes('TECNICO')) return true
  return false
}

export function inferTipoVehiculoComision(opts: {
  ticketTipo?: string | null
  turnoTipo?: string | null
}): TipoVehiculoComision | null {
  const normalize = (v?: string | null) => (v ?? '').toString().toUpperCase().trim()
  const txt = normalize(opts.ticketTipo) || normalize(opts.turnoTipo)
  if (!txt) return null
  if (txt.includes('MOTO')) return 'MOTO'
  return 'VEHICULO'
}

/* ============================================================
 *   Resolución de configuración (cascada asesor → global)
 * ============================================================*/

export interface ConfigComisionResuelta {
  valorIncentivo: number
  valorIncentivoPorTipo: number
  valorIncentivoCaso3: number
  valorDateoNuevo: number
  valorNuevoDirecto: number
}

export async function resolveConfigComision(params: {
  asesorId: number | null
  asesorConvenioId: number | null
  tipoVehiculo: TipoVehiculoComision | null
}): Promise<ConfigComisionResuelta> {
  const { asesorId, asesorConvenioId, tipoVehiculo } = params

  const num = (v: any) => {
    const n = Number(String(v ?? '').replace(/[^\d.-]/g, ''))
    return Number.isFinite(n) ? n : 0
  }

  const tryFind = async (aId: number | null, tv: string | null) => {
    const q = Comision.query().where('es_config', true)
    if (aId === null) q.whereNull('asesor_id')
    else q.where('asesor_id', aId)
    if (tv === null) q.whereNull('tipo_vehiculo')
    else q.where('tipo_vehiculo', tv)
    return q.first()
  }

  // Búsqueda 1: config del COMERCIAL (dateo nuevo, nuevo directo)
  let rowComercial: Comision | null = null
  if (asesorId && tipoVehiculo) rowComercial = await tryFind(asesorId, tipoVehiculo)
  if (!rowComercial && asesorId) rowComercial = await tryFind(asesorId, null)
  if (!rowComercial && tipoVehiculo) rowComercial = await tryFind(null, tipoVehiculo)
  if (!rowComercial) rowComercial = await tryFind(null, null)

  // Búsqueda 2: incentivo — config personal del convenio (cualquier tipo), fallback global
  let rowIncentivo: Comision | null = null
  if (asesorConvenioId && tipoVehiculo) rowIncentivo = await tryFind(asesorConvenioId, tipoVehiculo)
  if (!rowIncentivo && asesorConvenioId) {
    // Fila unificada del convenio (sin tipo_vehiculo) — valor_placa_vehiculo y
    // valor_placa_moto conviven en la misma fila, ya no requiere 2 filas por tipo.
    rowIncentivo = await tryFind(asesorConvenioId, null)
  }
  if (!rowIncentivo && asesorConvenioId) {
    // Buscar fila del convenio con CUALQUIER tipo de vehículo (MOTO o VEHICULO)
    // para extraer luego el campo correcto según tipo real del vehículo
    const rowConvenioMoto = await tryFind(asesorConvenioId, 'MOTO')
    const rowConvenioVehiculo = await tryFind(asesorConvenioId, 'VEHICULO')
    rowIncentivo = rowConvenioMoto ?? rowConvenioVehiculo ?? null
  }
  if (!rowIncentivo && tipoVehiculo) rowIncentivo = await tryFind(null, tipoVehiculo)
  if (!rowIncentivo) rowIncentivo = await tryFind(null, null)

  // Calcular incentivo por tipo
  // Prioridad: valorPlacaMoto/valorPlacaVehiculo específico > base
  // Si rowIncentivo es de VEHICULO pero el vehículo real es MOTO,
  // intenta leer valorPlacaMoto de esa fila antes de caer al base
  let valorIncentivoPorTipo = 0
  if (rowIncentivo) {
    if (tipoVehiculo === 'MOTO') {
      if (rowIncentivo.valorPlacaMoto !== null && rowIncentivo.valorPlacaMoto !== undefined) {
        valorIncentivoPorTipo = num(rowIncentivo.valorPlacaMoto)
      } else {
        // Intentar buscar otra fila del mismo convenio con tipo MOTO
        const rowMotoEspecifica = asesorConvenioId ? await tryFind(asesorConvenioId, 'MOTO') : null
        valorIncentivoPorTipo = rowMotoEspecifica
          ? rowMotoEspecifica.valorPlacaMoto !== null
            ? num(rowMotoEspecifica.valorPlacaMoto)
            : num(rowMotoEspecifica.base)
          : num(rowIncentivo.base)
      }
    } else if (tipoVehiculo === 'VEHICULO') {
      if (
        rowIncentivo.valorPlacaVehiculo !== null &&
        rowIncentivo.valorPlacaVehiculo !== undefined
      ) {
        valorIncentivoPorTipo = num(rowIncentivo.valorPlacaVehiculo)
      } else {
        const rowVehiculoEspecifica = asesorConvenioId
          ? await tryFind(asesorConvenioId, 'VEHICULO')
          : null
        valorIncentivoPorTipo = rowVehiculoEspecifica
          ? rowVehiculoEspecifica.valorPlacaVehiculo !== null
            ? num(rowVehiculoEspecifica.valorPlacaVehiculo)
            : num(rowVehiculoEspecifica.base)
          : num(rowIncentivo.base)
      }
    } else {
      valorIncentivoPorTipo = num(rowIncentivo.base)
    }
  }

  const valorIncentivo = rowIncentivo ? num(rowIncentivo.base) : 14000

  // ── CASO 3: incentivo del convenio SIN caer nunca al `base` propio del
  // convenio — el base es exclusivo de CASO 2 (self-dateo). Si el convenio
  // no tiene su valor específico para este tipo, cae a Global (nunca a su base).
  const leerCampoTipoIncentivo = (row: Comision | null) => {
    if (!row) return null
    const v = tipoVehiculo === 'MOTO' ? row.valorPlacaMoto : row.valorPlacaVehiculo
    return v !== null && v !== undefined ? num(v) : null
  }
  const rowEsDelConvenio =
    !!rowIncentivo && !!asesorConvenioId && rowIncentivo.asesorId === asesorConvenioId
  let valorIncentivoCaso3 = rowEsDelConvenio ? leerCampoTipoIncentivo(rowIncentivo) : null
  if (valorIncentivoCaso3 === null) {
    const rowGlobalTipo = tipoVehiculo ? await tryFind(null, tipoVehiculo) : null
    valorIncentivoCaso3 =
      leerCampoTipoIncentivo(rowGlobalTipo) ?? (rowGlobalTipo ? num(rowGlobalTipo.base) : null)
  }
  if (valorIncentivoCaso3 === null) {
    const rowGlobalNull = await tryFind(null, null)
    valorIncentivoCaso3 =
      leerCampoTipoIncentivo(rowGlobalNull) ?? (rowGlobalNull ? num(rowGlobalNull.base) : 0)
  }

  return {
    valorIncentivo,
    valorIncentivoPorTipo,
    valorIncentivoCaso3,
    valorDateoNuevo: num(rowComercial?.monto),
    valorNuevoDirecto: num(rowComercial?.valorNuevoDirecto),
  }
}

export interface ConfigRecurrenciaResuelta {
  valorRecurrente: number
  valorRecuperacion: number
}

export async function resolveConfigRecurrencia(
  asesorId: number | null,
  tipoVehiculo: TipoVehiculoComision | null = null
): Promise<ConfigRecurrenciaResuelta> {
  const esMoto = tipoVehiculo === 'MOTO'

  const globalCfg = await Database.from('configuracion_recurrencia_global').orderBy('id', 'asc').first()

  let valorRecurrente: number
  let valorRecuperacion: number

  if (esMoto) {
    valorRecurrente = Number(
      globalCfg?.valor_dateo_recurrencia_moto ?? globalCfg?.valor_dateo_recurrencia ?? 4300
    )
    valorRecuperacion = Number(
      globalCfg?.valor_dateo_recuperacion_moto ?? globalCfg?.valor_dateo_recuperacion ?? 8600
    )
  } else {
    valorRecurrente = Number(
      globalCfg?.valor_dateo_recurrencia_vehiculo ?? globalCfg?.valor_dateo_recurrencia ?? 4300
    )
    valorRecuperacion = Number(
      globalCfg?.valor_dateo_recuperacion_vehiculo ?? globalCfg?.valor_dateo_recuperacion ?? 8600
    )
  }

  if (asesorId) {
    const asesorCfg = await Database.from('configuracion_recurrencia_asesores')
      .where('asesor_id', asesorId)
      .where('recurrencia_habilitada', true)
      .first()

    if (asesorCfg?.valor_dateo_recurrencia) valorRecurrente = Number(asesorCfg.valor_dateo_recurrencia)
    if (asesorCfg?.valor_dateo_recuperacion) valorRecuperacion = Number(asesorCfg.valor_dateo_recuperacion)
  }

  return { valorRecurrente, valorRecuperacion }
}

/* ============================================================
 *   Cálculo puro del monto (Casos 1/2/3 + continuidad + avance +
 *   descuentos informativos) — sin efectos secundarios, sin BD.
 * ============================================================*/

export type CasoComision = 'SIN_CONVENIO' | 'CONVENIO_SELF' | 'CONVENIO_COMERCIAL'
export type EscenarioCliente = 'NUEVO' | 'RECURRENTE' | 'RECUPERACION'
export type OrigenDescuento = 'DATEO' | 'CAJA'

/** Códigos de descuento que activan la rama especial "aplicado en caja" en Caso 2/3 */
export const CODIGOS_DESCUENTO_ESPECIAL_CAJA = [
  'INFORMATIVO_POLICIA',
  'INFORMATIVO_EMPLEADO',
  'AVANCE_PROPIETARIO',
  'INFORMATIVO_OBSEQUIO',
  'INFORMATIVO_SOAT_RTM',
] as const

export interface ParametrosCalculoComision {
  caso: CasoComision
  escenario: EscenarioCliente
  /** Solo relevante en CONVENIO_SELF (Caso 2) + escenario RECURRENTE/RECUPERACION */
  tuvoContinuidad: boolean
  /** Ignorado si caso === 'SIN_CONVENIO' (Caso 1 nunca tiene avance) */
  esAvance: boolean
  /** Monto de avance ya resuelto (solo se refleja en descuentoMontoAplicado) */
  montoAvance: number
  /** Código del descuento activo, o null si no hay ninguno */
  codigoDescuento: string | null
  /** Dónde se marcó el descuento: comercial en el dateo, o cajera en el ticket */
  origenDescuento: OrigenDescuento | null
  cfgValues: ConfigComisionResuelta
  recValues: ConfigRecurrenciaResuelta
}

export interface ResultadoCalculoComision {
  base: number
  monto: number
  montoAsesor: number
  montoConvenio: number
  valorNuevoDirectoFinal: number
  descuentoMontoAplicado: number | null
  /** Descripción legible de qué rama del cálculo real se aplicó */
  reglaAplicada: string
}

export function calcularComision(p: ParametrosCalculoComision): ResultadoCalculoComision {
  const { caso, escenario, tuvoContinuidad, esAvance, montoAvance, codigoDescuento, origenDescuento, cfgValues, recValues } = p

  const esClienteNuevo = escenario === 'NUEVO'
  const esClienteRecurrente = escenario === 'RECURRENTE'
  const esClienteRecuperacion = escenario === 'RECUPERACION'

  const tieneInformativo = !!codigoDescuento
  const esDescuentoEspecialCaja =
    !!codigoDescuento &&
    origenDescuento === 'CAJA' &&
    (CODIGOS_DESCUENTO_ESPECIAL_CAJA as readonly string[]).includes(codigoDescuento)

  if (caso === 'SIN_CONVENIO') {
    // ════════════════════════ CASO 1 ════════════════════════
    if (esClienteNuevo) {
      if (tieneInformativo) {
        return {
          base: 0,
          monto: recValues.valorRecurrente,
          montoAsesor: recValues.valorRecurrente,
          montoConvenio: 0,
          valorNuevoDirectoFinal: 0,
          descuentoMontoAplicado: null,
          reglaAplicada: `Caso 1 · Sin convenio · Nuevo + informativo (${codigoDescuento}) → valor_dateo_recurrencia`,
        }
      }
      return {
        base: 0,
        monto: cfgValues.valorNuevoDirecto,
        montoAsesor: cfgValues.valorNuevoDirecto,
        montoConvenio: 0,
        valorNuevoDirectoFinal: cfgValues.valorNuevoDirecto,
        descuentoMontoAplicado: null,
        reglaAplicada: 'Caso 1 · Sin convenio · Nuevo directo → valor_nuevo_directo',
      }
    }
    // Recuperación es solo una categoría informativa/de reporte para el
    // comercial — nunca paga distinto de recurrente.
    return {
      base: 0,
      monto: recValues.valorRecurrente,
      montoAsesor: recValues.valorRecurrente,
      montoConvenio: 0,
      valorNuevoDirectoFinal: 0,
      descuentoMontoAplicado: null,
      reglaAplicada: `Caso 1 · Sin convenio · ${esClienteRecurrente ? 'Recurrente' : 'Recuperación'} → valor_dateo_recurrencia`,
    }
  }

  if (caso === 'CONVENIO_SELF') {
    // ════════════════════════ CASO 2 ════════════════════════
    if (esAvance) {
      return {
        base: cfgValues.valorIncentivoPorTipo,
        monto: 0,
        montoAsesor: 0,
        montoConvenio: 0,
        valorNuevoDirectoFinal: 0,
        descuentoMontoAplicado: montoAvance,
        reglaAplicada: 'Caso 2 · Convenio self-dateo · Avance → $0 (ya cobró vía descuento en factura)',
      }
    }
    if (esDescuentoEspecialCaja) {
      return {
        base: 0,
        monto: 0,
        montoAsesor: 0,
        montoConvenio: 0,
        valorNuevoDirectoFinal: 0,
        descuentoMontoAplicado: null,
        reglaAplicada: `Caso 2 · Convenio self-dateo · ${codigoDescuento} aplicado en caja → $0`,
      }
    }
    if (esClienteNuevo) {
      return {
        base: cfgValues.valorIncentivo,
        monto: cfgValues.valorIncentivo,
        montoAsesor: cfgValues.valorIncentivo,
        montoConvenio: 0,
        valorNuevoDirectoFinal: 0,
        descuentoMontoAplicado: null,
        reglaAplicada: 'Caso 2 · Convenio self-dateo · Nuevo (continuidad automática) → incentivo base',
      }
    }
    // Recurrente o Recuperación
    if (tuvoContinuidad) {
      return {
        base: cfgValues.valorIncentivo,
        monto: cfgValues.valorIncentivo,
        montoAsesor: cfgValues.valorIncentivo,
        montoConvenio: 0,
        valorNuevoDirectoFinal: 0,
        descuentoMontoAplicado: null,
        reglaAplicada: `Caso 2 · Convenio self-dateo · ${esClienteRecuperacion ? 'Recuperación' : 'Recurrente'} CON continuidad → incentivo base`,
      }
    }
    return {
      base: 0,
      monto: recValues.valorRecurrente,
      montoAsesor: recValues.valorRecurrente,
      montoConvenio: 0,
      valorNuevoDirectoFinal: 0,
      descuentoMontoAplicado: null,
      reglaAplicada: `Caso 2 · Convenio self-dateo · ${esClienteRecuperacion ? 'Recuperación' : 'Recurrente'} SIN continuidad → valor_dateo_recurrencia`,
    }
  }

  // ════════════════════════ CASO 3: CONVENIO_COMERCIAL ════════════════════════
  if (esClienteNuevo) {
    if (esDescuentoEspecialCaja) {
      return {
        base: cfgValues.valorIncentivoCaso3,
        monto: cfgValues.valorDateoNuevo,
        montoAsesor: cfgValues.valorDateoNuevo,
        montoConvenio: 0,
        valorNuevoDirectoFinal: 0,
        descuentoMontoAplicado: null,
        reglaAplicada: `Caso 3 · Comercial+convenio · Nuevo + ${codigoDescuento} en caja → comercial dateo_nuevo | convenio $0`,
      }
    }
    if (esAvance) {
      return {
        base: cfgValues.valorIncentivoCaso3,
        monto: cfgValues.valorDateoNuevo,
        montoAsesor: cfgValues.valorDateoNuevo,
        montoConvenio: 0,
        valorNuevoDirectoFinal: 0,
        descuentoMontoAplicado: montoAvance,
        reglaAplicada: 'Caso 3 · Comercial+convenio · Nuevo + Avance → comercial dateo_nuevo | convenio $0',
      }
    }
    return {
      base: cfgValues.valorIncentivoCaso3,
      monto: cfgValues.valorDateoNuevo,
      montoAsesor: cfgValues.valorDateoNuevo,
      montoConvenio: cfgValues.valorIncentivoCaso3,
      valorNuevoDirectoFinal: 0,
      descuentoMontoAplicado: null,
      reglaAplicada: 'Caso 3 · Comercial+convenio · Nuevo → comercial dateo_nuevo | convenio incentivo (Global si no tiene propio)',
    }
  }

  // Recurrente o Recuperación (misma fórmula — el informativo no tiene rama especial aquí)
  const etiqueta = esClienteRecuperacion ? 'Recuperación' : 'Recurrente'
  if (esAvance) {
    return {
      base: cfgValues.valorIncentivoCaso3,
      monto: cfgValues.valorDateoNuevo,
      montoAsesor: cfgValues.valorDateoNuevo,
      montoConvenio: 0,
      valorNuevoDirectoFinal: 0,
      descuentoMontoAplicado: montoAvance,
      reglaAplicada: `Caso 3 · Comercial+convenio · ${etiqueta} + Avance → comercial dateo_nuevo | convenio $0`,
    }
  }
  return {
    base: cfgValues.valorIncentivoCaso3,
    monto: cfgValues.valorDateoNuevo,
    montoAsesor: cfgValues.valorDateoNuevo,
    montoConvenio: cfgValues.valorIncentivoCaso3,
    valorNuevoDirectoFinal: 0,
    descuentoMontoAplicado: null,
    reglaAplicada: `Caso 3 · Comercial+convenio · ${etiqueta} → comercial dateo_nuevo | convenio incentivo (Global si no tiene propio)`,
  }
}
