// app/services/turno_etapas_service.ts
//
// Única fuente de verdad para: (1) qué etapas aplica un turno según su
// servicio, y (2) cuántas de esas etapas están completas → de ahí se deriva
// el "semáforo" visual (estadoVisual) que consumen la vista Turnos del Día
// y el export a Excel. Antes esta lógica vivía duplicada entre getEtapas()
// en el frontend y el bloque de exportExcel() en el backend, y no eran la
// misma fuente que decidía el color: el color dependía del campo crudo
// turno.estado (puesto en 'finalizado' por registrarSalida() sin verificar
// si Facturación quedó completa), lo que producía turnos en verde con una
// etapa saltada.
//
// Regla del semáforo (validada con negocio, 2026-08-04):
//  - turno.estado === 'cancelado'                    → 'cancelado'   (rojo)
//  - 0 o 1 etapa requerida completada                 → 'en_proceso'  (azul)
//  - ≥2 etapas completas pero falta alguna requerida   → 'incompleto'  (amarillo)
//  - todas las etapas requeridas completas             → 'finalizado'  (verde)

export type EtapaKey = 'puerta' | 'facturacion' | 'certificacion'
export type EstadoVisualTurno = 'cancelado' | 'en_proceso' | 'incompleto' | 'finalizado'

/** Servicios que NO pasan por Certificación (solo Puerta + Facturación). */
const SERVICIOS_SIN_CERTIFICACION = ['SOAT']

/** Etapas que aplican a un turno según el código de su servicio. */
export function getEtapasRequeridas(servicioCodigo?: string | null): EtapaKey[] {
  const codigo = (servicioCodigo || '').toUpperCase().trim()
  if (SERVICIOS_SIN_CERTIFICACION.includes(codigo)) {
    return ['puerta', 'facturacion']
  }
  return ['puerta', 'facturacion', 'certificacion']
}

export interface TurnoEtapasInput {
  servicioCodigo?: string | null
  estado: string
  horaIngreso?: string | null
  tieneFacturacion?: boolean | null
  horaSalida?: string | null
}

export interface TurnoEtapasResult {
  etapasRequeridas: EtapaKey[]
  totalRequeridas: number
  totalCompletadas: number
  estadoVisual: EstadoVisualTurno
}

function etapaCompletada(key: EtapaKey, input: TurnoEtapasInput): boolean {
  switch (key) {
    case 'puerta':
      return !!input.horaIngreso
    case 'facturacion':
      return !!input.tieneFacturacion
    case 'certificacion':
      return !!input.horaSalida
  }
}

/** Cuenta etapas completas de un turno y deriva su estado visual (semáforo). */
export function computeEtapasTurno(input: TurnoEtapasInput): TurnoEtapasResult {
  const etapasRequeridas = getEtapasRequeridas(input.servicioCodigo)
  const totalRequeridas = etapasRequeridas.length
  const totalCompletadas = etapasRequeridas.filter((k) => etapaCompletada(k, input)).length

  let estadoVisual: EstadoVisualTurno
  if (input.estado === 'cancelado') {
    estadoVisual = 'cancelado'
  } else if (totalCompletadas <= 1) {
    estadoVisual = 'en_proceso'
  } else if (totalCompletadas < totalRequeridas) {
    estadoVisual = 'incompleto'
  } else {
    estadoVisual = 'finalizado'
  }

  return { etapasRequeridas, totalRequeridas, totalCompletadas, estadoVisual }
}
