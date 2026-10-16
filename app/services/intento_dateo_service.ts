// app/services/intento_dateo_service.ts
//
// Resolución y validación de los datos de un intento de dateo (canal,
// agente, convenio, servicio, descuento, avance). Única fuente de verdad
// para captacion_dateos_controller.ts::store() y
// tickets_excepcion_dateo_controller.ts::crear(): el ticket de Excepción de
// Dateo guarda el mismo intento que store() rechazó con REQUIERE_TICKET_DATEO
// y aprobar() crea el dateo con esos datos.

import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import Descuento from '#models/descuento'
import Servicio from '#models/servicio'

export const CANALES_DATEO = [
  'FACHADA',
  'ASESOR_COMERCIAL',
  'ASESOR_CONVENIO',
  'TELE',
  'REDES',
] as const
export type CanalDateoDb = (typeof CANALES_DATEO)[number]

export interface EntradaIntentoDateo {
  agenteId: number | null
  /** 'ASESOR' (default) se resuelve a ASESOR_COMERCIAL/ASESOR_CONVENIO según el agente. */
  canal: string | null
  convenioId: number | null
  descuentoId: number | null
  servicioId: number | null
  esAvance: boolean
  comprobanteAvanceUrl: string | null
}

export interface IntentoDateo {
  agenteId: number | null
  agente: AgenteCaptacion | null
  canal: CanalDateoDb
  convenioId: number | null
  convenio: Convenio | null
  /** Solo cuando quien datea es el asesor del convenio (Caso 2). */
  asesorConvenioId: number | null
  descuentoId: number | null
  descuento: Descuento | null
  /** servicio_id tal como llegó (null = RTM por defecto). */
  servicioId: number | null
  servicio: Servicio | null
  /** servicio_id real (RTM si no vino ninguno). */
  servicioIdEfectivo: number | null
  codigoServicio: string
  esAvance: boolean
  comprobanteAvanceUrl: string | null
}

export type ResultadoIntentoDateo =
  | { ok: true; intento: IntentoDateo }
  | { ok: false; status: 400 | 403 | 422; message: string }

/**
 * Convenio activo de un asesor convenio: el que se llama igual que el
 * asesor (o empieza con su nombre), comparando sin espacios repetidos y en
 * mayúsculas. Es la regla que siempre usó store().
 */
export async function buscarConvenioDelAsesorConvenio(
  agente: AgenteCaptacion
): Promise<Convenio | null> {
  const nombreNormalizado = agente.nombre.trim().replace(/\s+/g, ' ').toUpperCase()
  const conveniosActivos = await Convenio.query().where('activo', true).select(['id', 'nombre'])
  const encontrado = conveniosActivos.find((c) => {
    const n = c.nombre.trim().replace(/\s+/g, ' ').toUpperCase()
    return n === nombreNormalizado || n.startsWith(nombreNormalizado)
  })
  return encontrado ? Convenio.find(encontrado.id) : null
}

const falla = (status: 400 | 403 | 422, message: string): ResultadoIntentoDateo => ({
  ok: false,
  status,
  message,
})

export async function resolverIntentoDateo(e: EntradaIntentoDateo): Promise<ResultadoIntentoDateo> {
  const agenteId = e.agenteId
  let agente: AgenteCaptacion | null = null

  const canalRaw = String(e.canal || 'ASESOR').toUpperCase()
  let canal: CanalDateoDb
  if (canalRaw === 'ASESOR') {
    if (agenteId !== null) agente = await AgenteCaptacion.find(agenteId)
    canal =
      (agente?.tipo || '').toUpperCase() === 'ASESOR_CONVENIO'
        ? 'ASESOR_CONVENIO'
        : 'ASESOR_COMERCIAL'
  } else if ((CANALES_DATEO as readonly string[]).includes(canalRaw)) {
    canal = canalRaw as CanalDateoDb
  } else {
    return falla(400, 'canal inválido')
  }

  let convenioId = e.convenioId
  let convenio: Convenio | null = null
  if (convenioId !== null) {
    convenio = await Convenio.find(convenioId)
    if (!convenio) return falla(400, 'convenio_id no existe')
  }

  let descuentoId: number | null = null
  let descuento: Descuento | null = null
  if (e.descuentoId !== null) {
    descuento = await Descuento.query().where('id', e.descuentoId).where('activo', true).first()
    if (!descuento) return falla(400, 'descuento_id no existe o está inactivo')
    // Comercial dateando CON convenio (CASO 3): solo puede marcar AVANCE,
    // nunca un descuento informativo (POLICIA/EMPLEADO/OBSEQUIO/etc).
    const esAvanceDescuento = descuento.codigo.toUpperCase().includes('AVANCE')
    if (canal === 'ASESOR_COMERCIAL' && convenioId !== null && !esAvanceDescuento) {
      return falla(
        400,
        'Un comercial que datea con convenio solo puede marcar AVANCE, no un descuento informativo.'
      )
    }
    descuentoId = e.descuentoId
  }

  // Servicio para el que se datea (opcional, default = RTM).
  let servicio: Servicio | null = null
  if (e.servicioId !== null) {
    servicio = await Servicio.find(e.servicioId)
    if (!servicio) return falla(400, 'servicio_id no existe')
  }
  let servicioIdEfectivo: number | null = servicio?.id ?? null
  if (servicioIdEfectivo === null) {
    const rtm = await Servicio.query().where('codigo_servicio', 'RTM').first()
    servicioIdEfectivo = rtm?.id ?? null
    servicio = servicio ?? rtm
  }
  const codigoServicio = (servicio?.codigoServicio ?? 'RTM').toUpperCase()

  // AVANCE: el comercial necesita comprobante; el asesor convenio no (él
  // mismo pide el avance). Fuera de los canales de asesor no aplica.
  if (e.esAvance && canal === 'ASESOR_COMERCIAL' && !e.comprobanteAvanceUrl) {
    return falla(
      400,
      'comprobante_avance_url es obligatorio cuando el asesor comercial solicita un avance en nombre del convenio.'
    )
  }
  if (e.esAvance && canal !== 'ASESOR_COMERCIAL' && canal !== 'ASESOR_CONVENIO') {
    return falla(400, 'es_avance solo aplica para canal ASESOR_COMERCIAL o ASESOR_CONVENIO.')
  }

  if (
    (canal === 'ASESOR_COMERCIAL' || canal === 'ASESOR_CONVENIO' || canal === 'TELE') &&
    agenteId === null
  ) {
    return falla(400, 'agente_id es requerido para canal ASESOR/TELE')
  }
  if (agenteId !== null && !agente) {
    agente = await AgenteCaptacion.find(agenteId)
    if (!agente) return falla(400, 'agente_id no existe')
  }

  let asesorConvenioId: number | null = null
  if (agente && agente.tipo === 'ASESOR_CONVENIO') {
    canal = 'ASESOR_CONVENIO'
    const convenioDelAsesor = await buscarConvenioDelAsesorConvenio(agente)
    if (!convenioDelAsesor) {
      return falla(
        422,
        `El asesor convenio "${agente.nombre}" no tiene un convenio asociado activo. Verifica que exista un convenio que comience con "${agente.nombre}".`
      )
    }
    if (convenioId !== null && convenioId !== convenioDelAsesor.id) {
      return falla(
        403,
        'No puede datear para un convenio distinto al que tiene asociado como asesor convenio.'
      )
    }
    convenioId = convenioDelAsesor.id
    convenio = convenioDelAsesor
    asesorConvenioId = agente.id
  } else if (agente && canal === 'ASESOR_COMERCIAL' && convenioId !== null) {
    const asignacion = await AsesorConvenioAsignacion.query()
      .where('asesor_id', agente.id)
      .where('convenio_id', convenioId)
      .where('activo', true)
      .whereNull('fecha_fin')
      .first()
    if (!asignacion) {
      return falla(
        403,
        'Este asesor comercial no tiene asignado el convenio seleccionado. No puede datear para él.'
      )
    }
  }

  return {
    ok: true,
    intento: {
      agenteId,
      agente,
      canal,
      convenioId,
      convenio,
      asesorConvenioId,
      descuentoId,
      descuento,
      servicioId: e.servicioId,
      servicio,
      servicioIdEfectivo,
      codigoServicio,
      esAvance: e.esAvance,
      comprobanteAvanceUrl: e.esAvance ? e.comprobanteAvanceUrl : null,
    },
  }
}
