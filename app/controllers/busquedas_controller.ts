// app/Controllers/Http/busquedas_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Vehiculo from '#models/vehiculo'
import Cliente from '#models/cliente'
import CaptacionDateo from '#models/captacion_dateo'
import AgenteCaptacion from '#models/agente_captacion'
import Prospecto from '#models/prospecto'
import Convenio from '#models/convenio'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import TurnoRtm from '#models/turno_rtm'
import { buildReserva } from '#services/reserva_dateo_service'

type CanalSimple = 'FACHADA' | 'ASESOR' | 'TELE' | 'REDES'

// Tipos instancia
type VehiculoInstance = InstanceType<typeof Vehiculo>
type ClienteInstance = InstanceType<typeof Cliente>
type CaptacionDateoInstance = InstanceType<typeof CaptacionDateo>
type AgenteInstance = InstanceType<typeof AgenteCaptacion>

function normalizePlaca(v?: string | null) {
  return v ? v.replace(/[\s-]/g, '').toUpperCase() : null
}
function normalizePhone(v?: string | null) {
  return v ? v.replace(/\D/g, '') : null
}

/** Asesor activo asignado a un convenio (si existe) */
async function getAsesorActivoDeConvenio(convenioId: number) {
  const asignacion = await AsesorConvenioAsignacion.query()
    .where('convenio_id', convenioId)
    .where('activo', true)
    .whereNull('fecha_fin')
    .orderBy('fecha_asignacion', 'desc')
    .first()

  if (!asignacion) return null
  const asesor = await AgenteCaptacion.find(asignacion.asesorId)
  if (!asesor) return null
  return { asignacion, asesor }
}

/** Serializador vehículo */
function serializeVehiculo(vehiculo: VehiculoInstance | null) {
  if (!vehiculo) return null
  const clase = (vehiculo as any).$preloaded?.clase
    ? {
        id: (vehiculo as any).$preloaded.clase.id,
        codigo: (vehiculo as any).$preloaded.clase.codigo,
        nombre: (vehiculo as any).$preloaded.clase.nombre,
      }
    : null

  return {
    id: vehiculo.id,
    placa: vehiculo.placa,
    clase,
    marca: vehiculo.marca,
    linea: vehiculo.linea,
    modelo: vehiculo.modelo,
  }
}

/** Serializador cliente */
function serializeCliente(cliente: ClienteInstance | null) {
  if (!cliente) return null

  const cliAny = cliente as any
  const vehiculosArr = Array.isArray(cliAny.vehiculos)
    ? cliAny.vehiculos.map((v: any) => ({
        id: v.id,
        placa: v.placa,
        clase: v.clase ? { id: v.clase.id, codigo: v.clase.codigo, nombre: v.clase.nombre } : null,
        marca: v.marca,
        linea: v.linea,
        modelo: v.modelo,
      }))
    : undefined

  return {
    id: cliente.id,
    nombre: cliAny.nombre,
    doc_tipo: cliAny.docTipo ?? cliAny['doc_tipo'],
    doc_numero: cliAny.docNumero ?? cliAny['doc_numero'],
    telefono: cliAny.telefono,
    email: cliAny.email,
    vehiculos: vehiculosArr,
  }
}

/** Mapea canal BD → canal simple */
function canalSimple(c: string | null | undefined): CanalSimple | null {
  if (!c) return null
  if (c === 'ASESOR_COMERCIAL' || c === 'ASESOR_CONVENIO') return 'ASESOR'
  if (c === 'FACHADA' || c === 'TELE' || c === 'REDES') return c as CanalSimple
  return null
}

/** Última visita por placa o cliente (una sola) */
async function getUltimaVisita(placa?: string | null, clienteId?: number | null) {
  if (placa) {
    const t = await TurnoRtm.query()
      .where('placa', placa)
      .preload('servicio')
      .preload('sede')
      .orderBy('fecha', 'desc')
      .orderBy('turno_numero', 'desc')
      .first()
    if (t) {
      return {
        fecha: t.fecha?.toISODate?.() ?? null,
        servicioCodigo: (t as any).$preloaded?.servicio?.codigoServicio ?? null,
        servicioNombre: (t as any).$preloaded?.servicio?.nombreServicio ?? null,
        sedeNombre: (t as any).$preloaded?.sede?.nombre ?? null,
        estado: t.estado,
      }
    }
  } else if (clienteId) {
    const t = await TurnoRtm.query()
      .where('cliente_id', clienteId)
      .preload('servicio')
      .preload('sede')
      .orderBy('fecha', 'desc')
      .orderBy('turno_numero', 'desc')
      .first()
    if (t) {
      return {
        fecha: t.fecha?.toISODate?.() ?? null,
        servicioCodigo: (t as any).$preloaded?.servicio?.codigoServicio ?? null,
        servicioNombre: (t as any).$preloaded?.servicio?.nombreServicio ?? null,
        sedeNombre: (t as any).$preloaded?.sede?.nombre ?? null,
        estado: t.estado,
      }
    }
  }
  return null
}

export default class BusquedasController {
  /**
   * GET /api/buscar?placa=ABC123 | /api/buscar?telefono=3XXXXXXXXX
   * Devuelve: vehiculo, cliente, dateoReciente (+reserva), captacionSugerida, ultimaVisita, etc.
   * ✅ Incluye convenio del dateo (dateoReciente.convenio) y a nivel raíz (convenio)
   */
  public async unificada({ request, response }: HttpContext) {
    const placa = normalizePlaca(request.input('placa'))
    const telefono = normalizePhone(request.input('telefono'))

    if (!placa && !telefono) {
      return response.badRequest({ message: 'Debe enviar placa o telefono' })
    }

    // 1) Contexto base
    let vehiculo: VehiculoInstance | null = null
    let cliente: ClienteInstance | null = null

    if (placa) {
      vehiculo = await Vehiculo.query()
        .where('placa', placa)
        .preload('clase')
        .preload('cliente')
        .first()
      if (vehiculo?.clienteId) {
        // @ts-ignore (Lucid preloaded)
        cliente = (vehiculo as any).$preloaded?.cliente ?? null
      }
    } else if (telefono) {
      cliente = await Cliente.query()
        .where('telefono', telefono)
        .preload('vehiculos', (q) => q.preload('clase'))
        .first()
    }

    // 2) Último dateo por placa/teléfono (preload convenio)
    let dateo: CaptacionDateoInstance | null = await CaptacionDateo.query()
      .where((qb) => {
        if (placa) qb.where('placa', placa)
        if (telefono) qb.orWhere('telefono', telefono!)
      })
      .preload('agente')
      .preload('convenio')
      .preload('prospecto')
      .orderBy('created_at', 'desc')
      .first()

    // Precalcular última visita (para todos los caminos)
    const ultimaVisita = await getUltimaVisita(placa ?? undefined, cliente?.id ?? undefined)

    let reserva: { vigente: boolean; bloqueaHasta: string | null } | null = null

    if (dateo) {
      const r = await buildReserva(dateo)
      reserva = r
      if (r.vigente) {
        const conv = (dateo as any).convenio
          ? {
              id: (dateo as any).convenio.id,
              nombre: (dateo as any).convenio.nombre,
              codigo:
                (dateo as any).convenio.codigo ?? (dateo as any).convenio.codigo_convenio ?? null,
            }
          : null

        return response.ok({
          fuente: 'DATEO',
          dateoId: dateo.id,
          vehiculo: serializeVehiculo(vehiculo),
          cliente: serializeCliente(cliente),
          dateoReciente: {
            id: dateo.id,
            canal: canalSimple(dateo.canal) ?? 'FACHADA',
            agente: (dateo as any).agente
              ? {
                  id: (dateo as any).agente.id,
                  nombre: (dateo as any).agente.nombre,
                  tipo: (dateo as any).agente.tipo,
                }
              : null,
            placa: dateo.placa,
            telefono: dateo.telefono,
            origen: dateo.origen,
            observacion: (dateo as any).observacion ?? null,
            imagen_url: (dateo as any).imagenUrl ?? null,
            created_at: dateo.createdAt ? dateo.createdAt.toISO() : null,
            consumido_turno_id: dateo.consumidoTurnoId ?? null,
            consumido_at: dateo.consumidoAt ? dateo.consumidoAt.toISO() : null,
            detectado_por_convenio: (dateo as any).detectadoPorConvenio ?? false,
            convenio: conv, // ✅ convenio del dateo
          },
          reserva,
          captacionSugerida: {
            canal: canalSimple(dateo.canal) ?? 'FACHADA',
            agente: (dateo as any).agente
              ? {
                  id: (dateo as any).agente.id,
                  nombre: (dateo as any).agente.nombre,
                  tipo: (dateo as any).agente.tipo,
                }
              : null,
          },
          convenio: conv, // ✅ también a nivel raíz para fácil acceso en front
          asesorAsignado: (dateo as any).agente
            ? {
                id: (dateo as any).agente.id,
                nombre: (dateo as any).agente.nombre,
                tipo: (dateo as any).agente.tipo,
              }
            : null,
          origenBusqueda: placa ? 'placa' : 'telefono',
          detectadoPorConvenio: (dateo as any).detectadoPorConvenio ?? false,
          ultimaVisita,
        })
      }
    }

    // 3) Sin dateo vigente → Detectar por prospecto/convenio y crear dateo automático
    const prospecto = await Prospecto.query()
      .where((q) => {
        if (placa) q.orWhere('placa', placa)
        if (telefono) q.orWhere('telefono', telefono!)
      })
      .orderByRaw('convenio_id IS NULL') // prioriza los que TENGAN convenio
      .orderBy('updated_at', 'desc')
      .first()

    if (prospecto?.convenioId) {
      const convenio = await Convenio.find(prospecto.convenioId)

      // Asesor activo del convenio (si hay)
      let asesorAsignado: AgenteInstance | null = null
      const info = await getAsesorActivoDeConvenio(prospecto.convenioId)
      if (info?.asesor) asesorAsignado = info.asesor

      // Crear dateo automático (canal BD correcto)
      dateo = await CaptacionDateo.create({
        canal: 'ASESOR_CONVENIO' as any,
        agenteId: asesorAsignado ? asesorAsignado.id : null,
        convenioId: convenio?.id ?? null,
        prospectoId: prospecto.id,
        vehiculoId: vehiculo?.id ?? null,
        clienteId: cliente?.id ?? null,
        placa: placa ?? null,
        telefono: telefono ?? null,
        origen: 'UI',
        observacion: 'Captación automática por base de convenio',
        detectadoPorConvenio: true as any,
        resultado: 'PENDIENTE',
      } as Partial<any>)

      await dateo.load('agente')
      await dateo.load('convenio')

      const r = await buildReserva(dateo)
      const conv = (dateo as any).convenio
        ? {
            id: (dateo as any).convenio.id,
            nombre: (dateo as any).convenio.nombre,
            codigo:
              (dateo as any).convenio.codigo ?? (dateo as any).convenio.codigo_convenio ?? null,
          }
        : null

      return response.ok({
        fuente: 'CONVENIO',
        dateoId: dateo.id,
        vehiculo: serializeVehiculo(vehiculo),
        cliente: serializeCliente(cliente),
        dateoReciente: {
          id: dateo.id,
          canal: 'ASESOR',
          agente: (dateo as any).agente
            ? {
                id: (dateo as any).agente.id,
                nombre: (dateo as any).agente.nombre,
                tipo: (dateo as any).agente.tipo,
              }
            : null,
          placa: dateo.placa,
          telefono: dateo.telefono,
          origen: dateo.origen,
          observacion: (dateo as any).observacion ?? null,
          imagen_url: (dateo as any).imagenUrl ?? null,
          created_at: dateo.createdAt ? dateo.createdAt.toISO() : null,
          consumido_turno_id: dateo.consumidoTurnoId ?? null,
          consumido_at: dateo.consumidoAt ? dateo.consumidoAt.toISO() : null,
          detectado_por_convenio: true,
          convenio: conv, // ✅ convenio del nuevo dateo
        },
        reserva: r,
        captacionSugerida: {
          canal: 'ASESOR',
          agente: asesorAsignado
            ? { id: asesorAsignado.id, nombre: asesorAsignado.nombre, tipo: asesorAsignado.tipo }
            : null,
        },
        convenio: conv,
        asesorAsignado: asesorAsignado
          ? { id: asesorAsignado.id, nombre: asesorAsignado.nombre, tipo: asesorAsignado.tipo }
          : null,
        origenBusqueda: placa ? 'placa' : 'telefono',
        detectadoPorConvenio: true,
        ultimaVisita,
      })
    }

    // 4) Detectar asesor por teléfono (PRIORIDAD ALTA)
    let asesorDetectado: {
      id: number
      nombre: string
      tipo: string
      telefono: string
      convenio?: { id: number; nombre: string; codigo: string | null } | null
    } | null = null

    if (telefono && /^\d{10}$/.test(telefono)) {
      try {
        const agente = await AgenteCaptacion.query()
          .where('activo', true)
          .where('telefono', telefono)
          .first()

        if (agente) {
          asesorDetectado = {
            id: agente.id,
            nombre: (agente as any).nombre,
            tipo: (agente as any).tipo, // 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'ASESOR_TELEMERCADEO'
            telefono: (agente as any).telefono,
          }

          // 🔍 Si es ASESOR_CONVENIO → Buscar convenio asociado
          if ((agente as any).tipo === 'ASESOR_CONVENIO') {
            const asignacionActiva = await AsesorConvenioAsignacion.query()
              .where('asesor_id', agente.id)
              .where('activo', true)
              .whereNull('fecha_fin')
              .orderBy('fecha_asignacion', 'desc')
              .first()

            if (asignacionActiva) {
              const convenioAsociado = await Convenio.find(asignacionActiva.convenioId)
              if (convenioAsociado) {
                asesorDetectado.convenio = {
                  id: convenioAsociado.id,
                  nombre: (convenioAsociado as any).nombre,
                  codigo:
                    (convenioAsociado as any).codigo ??
                    (convenioAsociado as any).codigo_convenio ??
                    null,
                }
              }
            }
          }
        }
      } catch (e) {
        console.error('Error detectando asesor por teléfono:', e)
      }
    }

    // 5) Sugerencia por teléfono (fallback si no hay asesor detectado arriba)
    let sugerenciaPorTelefono: {
      canal: CanalSimple
      agente: { id: number; nombre: string; tipo: string } | null
    } | null = null

    if (!asesorDetectado && telefono && /^\d{10}$/.test(telefono)) {
      try {
        const agente = await AgenteCaptacion.query()
          .where('activo', true)
          .andWhere('telefono', telefono)
          .first()

        if (agente) {
          let canal: CanalSimple = 'ASESOR'
          if ((agente as any).tipo === 'TELEMERCADEO') canal = 'TELE'
          sugerenciaPorTelefono = {
            canal,
            agente: { id: agente.id, nombre: (agente as any).nombre, tipo: (agente as any).tipo },
          }
        }
      } catch (e) {
        console.error('Lookup de agente por teléfono falló:', e)
      }
    }
    // 5) FACHADA
    return response.ok({
      fuente: 'FACHADA',
      dateoId: null,
      vehiculo: serializeVehiculo(vehiculo),
      cliente: serializeCliente(cliente),
      dateoReciente: null,
      reserva: null,
      captacionSugerida: sugerenciaPorTelefono || { canal: 'FACHADA', agente: null },
      convenio: null,
      asesorAsignado: sugerenciaPorTelefono?.agente ?? null,
      origenBusqueda: placa ? 'placa' : 'telefono',
      detectadoPorConvenio: false,
      ultimaVisita,
      asesorDetectado, // 👈 NUEVA LÍNEA
    })
  }
}
