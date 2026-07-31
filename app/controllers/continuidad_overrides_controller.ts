// app/controllers/continuidad_overrides_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import Database from '@adonisjs/lucid/services/db'
import Cliente from '#models/cliente'
import ContinuidadOverride from '#models/continuidad_override'

function normalizePlaca(v?: string | null) {
  return v ? v.replace(/[\s-]/g, '').toUpperCase() : null
}

export default class ContinuidadOverridesController {
  /**
   * GET /continuidad/buscar?placa=XXX
   * GET /continuidad/buscar?cedula=XXX
   *
   * Si la cédula tiene varias placas asociadas, devuelve la lista de placas
   * para que el admin elija — la continuidad se evalúa siempre por placa,
   * nunca solo por cliente (ver diagnóstico).
   */
  public async buscar({ request, response }: HttpContext) {
    const placaParam = normalizePlaca(request.input('placa'))
    const cedula = request.input('cedula') as string | undefined

    let placa = placaParam

    if (!placa && cedula) {
      const cliente = await Cliente.query().where('doc_numero', cedula).first()
      if (!cliente) return response.notFound({ message: 'No se encontró un cliente con esa cédula' })

      const placas = await Database.from('turnos_rtms')
        .where('cliente_id', cliente.id)
        .whereNotNull('placa')
        .distinct('placa')
        .orderBy('placa', 'asc')
        .select('placa')

      if (placas.length === 0) {
        return response.ok({ cliente: { id: cliente.id, nombre: cliente.nombre }, placas: [] })
      }
      if (placas.length > 1) {
        return response.ok({
          cliente: { id: cliente.id, nombre: cliente.nombre },
          placas: placas.map((p) => p.placa),
        })
      }
      placa = placas[0].placa
    }

    if (!placa) return response.badRequest({ message: 'Debe indicar placa o cédula' })

    const visitas = await Database.from('turnos_rtms as t')
      .leftJoin('captacion_dateos as cd', 't.captacion_dateo_id', 'cd.id')
      .leftJoin('agentes_captacions as ag', 'cd.asesor_convenio_id', 'ag.id')
      .leftJoin('agentes_captacions as agc', 'cd.agente_id', 'agc.id')
      .leftJoin('convenios as cv', 'cd.convenio_id', 'cv.id')
      .where('t.placa', placa)
      .orderBy('t.fecha', 'desc')
      .select(
        't.id as turnoId',
        't.fecha',
        't.estado',
        't.dateo_canal as canal',
        't.es_recurrente as esRecurrente',
        't.es_recuperacion as esRecuperacion',
        't.estado_continuidad as estadoContinuidad',
        'cd.id as dateoId',
        'cd.convenio_id as convenioId',
        'cd.asesor_convenio_id as asesorConvenioId',
        'ag.nombre as asesorConvenioNombre',
        'agc.nombre as agenteNombre',
        'cv.nombre as convenioNombre'
      )

    const overrides = await ContinuidadOverride.query()
      .where('placa', placa)
      .preload('asesorConvenio')
      .preload('convenio')
      .preload('creadoPor')
      .orderBy('updated_at', 'desc')

    return response.ok({ placa, visitas, overrides })
  }

  /**
   * POST /continuidad/overrides
   * body: { placa, asesorConvenioId?, convenioId?, estado, motivo? }
   *
   * Upsert: un mismo (placa, asesorConvenioId) o (placa, convenioId) tiene
   * un único override activo — si ya existe, se actualiza.
   */
  public async store({ request, auth, response }: HttpContext) {
    const placa = normalizePlaca(request.input('placa'))
    const asesorConvenioId = request.input('asesorConvenioId')
      ? Number(request.input('asesorConvenioId'))
      : null
    const convenioId = request.input('convenioId') ? Number(request.input('convenioId')) : null
    const estado = String(request.input('estado') || '').toUpperCase()
    const motivo = (request.input('motivo') as string | undefined)?.trim() || null

    if (!placa) return response.badRequest({ message: 'placa es obligatoria' })
    if (!asesorConvenioId && !convenioId)
      return response.badRequest({
        message: 'Debe indicar asesorConvenioId o convenioId (al menos uno)',
      })
    if (!['AUTOMATICO', 'FORZAR_SI', 'FORZAR_NO'].includes(estado))
      return response.badRequest({ message: 'estado inválido (AUTOMATICO, FORZAR_SI, FORZAR_NO)' })
    if (estado !== 'AUTOMATICO' && !motivo)
      return response.badRequest({ message: 'motivo es obligatorio cuando estado no es AUTOMATICO' })

    const query = ContinuidadOverride.query().where('placa', placa)
    if (asesorConvenioId) query.where('asesor_convenio_id', asesorConvenioId)
    else query.whereNull('asesor_convenio_id')
    if (convenioId) query.where('convenio_id', convenioId)
    else query.whereNull('convenio_id')

    let override = await query.first()
    if (!override) {
      override = new ContinuidadOverride()
      override.placa = placa
      override.asesorConvenioId = asesorConvenioId
      override.convenioId = convenioId
      override.creadoPorId = auth.user!.id
    }

    override.estado = estado as any
    override.motivo = motivo
    await override.save()

    return response.ok(override)
  }
}
