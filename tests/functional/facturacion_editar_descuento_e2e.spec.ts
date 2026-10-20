import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import FacturacionTicket from '#models/facturacion_ticket'
import Comision from '#models/comision'
import FacturacionDescuentoEdicion from '#models/facturacion_descuento_edicion'

// Edición del descuento de un ticket ya CONFIRMADA (Facturación / Historial):
// PATCH /facturacion/tickets/:id con motivo_edicion. Solo SUPER_ADMIN /
// GERENCIA; total recalculado desde total_sin_descuento; consecutivo
// obligatorio y único; registro en facturacion_descuento_ediciones; la
// comisión del dateo del turno se recalcula solo si está PENDIENTE.
// Todo lo creado aquí se borra en el teardown (por placa y por usuario).

const SEDE_ID = 2
const SERVICIO_RTM_ID = 1
const AGENTE_COMERCIAL_ID = 1
const ROL = { SUPER_ADMIN: 9, GERENCIA: 10, CONTABILIDAD: 12 }
const DESCUENTO = { INFORMATIVO: 1, EMPLEADO: 3, POLICIA: 4 }
// Valores de la BD de pruebas para vehículo (no moto).
const MAX_INFORMATIVO = 50000
const FIJO_EMPLEADO = 60000

const PLACAS = Array.from({ length: 20 }, (_, i) => `TFE${String(900 + i)}`)
const RUN = Date.now().toString(36).toUpperCase()
const cd = (sufijo: string) => `EDT-${RUN}-${sufijo}`

test.group('Facturación: editar el descuento de un ticket confirmado', (group) => {
  const usuarios: Usuario[] = []
  const tokens: Record<'admin' | 'gerencia' | 'contabilidad', string> = {
    admin: '',
    gerencia: '',
    contabilidad: '',
  }
  let convenioAsesor: AgenteCaptacion
  let convenio: Convenio
  let turnoNumero = 960000 + Math.floor(Math.random() * 9000)

  group.setup(async () => {
    for (const [clave, rolId] of [
      ['admin', ROL.SUPER_ADMIN],
      ['gerencia', ROL.GERENCIA],
      ['contabilidad', ROL.CONTABILIDAD],
    ] as const) {
      const u = await Usuario.create({
        nombres: 'TEST',
        apellidos: `EDITAR-DESC-${clave.toUpperCase()}`,
        correo: `test.editar.desc.${clave}.${Date.now()}@test.local`,
        password: 'Test1234!Aa',
        rolId,
        sedeId: SEDE_ID,
      } as any)
      usuarios.push(u)
      const tok = await Usuario.accessTokens.create(u)
      tokens[clave] = tok.value!.release()
    }
    convenioAsesor = await AgenteCaptacion.create({
      tipo: 'ASESOR_CONVENIO',
      nombre: `TEST EDITAR DESC CONVENIO ASESOR ${RUN}`,
      activo: true,
    } as any)
    convenio = await Convenio.create({
      tipo: 'TALLER',
      nombre: `TEST EDITAR DESC CONVENIO ${RUN}`,
      activo: true,
      estado: 'ACTIVO',
      asesorConvenioId: convenioAsesor.id,
    } as any)
  })

  group.teardown(async () => {
    const ph = PLACAS.map(() => '?').join(', ')
    await Database.rawQuery(
      `DELETE FROM tickets_detalle_excepcion_dateo WHERE placa IN (${ph})`,
      PLACAS
    )
    await Database.rawQuery(`DELETE FROM tickets WHERE titulo LIKE ?`, [`%EDT-${RUN}%`])
    await Database.rawQuery(
      `DELETE FROM comisiones WHERE captacion_dateo_id IN (SELECT id FROM captacion_dateos WHERE placa IN (${ph}))`,
      PLACAS
    )
    // facturacion_descuento_ediciones cae por ON DELETE CASCADE.
    await Database.rawQuery(`DELETE FROM facturacion_tickets WHERE placa IN (${ph})`, PLACAS)
    await Database.rawQuery(`DELETE FROM turnos_rtms WHERE placa IN (${ph})`, PLACAS)
    await Database.rawQuery(`DELETE FROM captacion_dateos WHERE placa IN (${ph})`, PLACAS)
    if (convenio) await Database.rawQuery('DELETE FROM convenios WHERE id = ?', [convenio.id])
    if (convenioAsesor)
      await Database.rawQuery('DELETE FROM agentes_captacions WHERE id = ?', [convenioAsesor.id])
    for (const u of usuarios) await u.delete()
  })

  /**
   * Ticket RTM CONFIRMADA por la API (con su comisión, si lleva dateo).
   * total 200.000; con descuento lleva su consecutivo.
   */
  async function crearConfirmado(
    client: any,
    placa: string,
    opts: {
      dateo?: 'SIN_CONVENIO' | 'CONVENIO_COMERCIAL'
      descuentoId?: number
      monto?: number
      antesDeConfirmar?: (turno: TurnoRtm) => Promise<void>
    } = {}
  ) {
    let dateo: CaptacionDateo | null = null
    let turno: TurnoRtm | null = null
    if (opts.dateo) {
      dateo = await CaptacionDateo.create({
        canal: 'ASESOR_COMERCIAL',
        agenteId: AGENTE_COMERCIAL_ID,
        convenioId: opts.dateo === 'CONVENIO_COMERCIAL' ? convenio.id : null,
        asesorConvenioId: opts.dateo === 'CONVENIO_COMERCIAL' ? convenioAsesor.id : null,
        placa,
        servicioId: SERVICIO_RTM_ID,
        origen: 'UI',
        resultado: 'EN_PROCESO',
        descuentoId: null,
      } as any)
      turnoNumero += 1
      turno = await TurnoRtm.create({
        sedeId: SEDE_ID,
        funcionarioId: usuarios[0].id,
        servicioId: SERVICIO_RTM_ID,
        fecha: DateTime.now(),
        horaIngreso: '08:00:00',
        turnoNumero,
        turnoNumeroServicio: turnoNumero,
        turnoCodigo: `RTM-EDT-${RUN}-${turnoNumero}`,
        placa,
        tipoVehiculo: 'Liviano Particular',
        estado: 'activo',
        tieneFacturacion: false,
        captacionDateoId: dateo.id,
      } as any)
      dateo.consumidoTurnoId = turno.id
      dateo.consumidoAt = DateTime.now()
      await dateo.save()
      if (opts.antesDeConfirmar) await opts.antesDeConfirmar(turno)
    }

    const monto = opts.monto ?? 0
    const ticket = await FacturacionTicket.create({
      hash: `test-hash-edt-${placa}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      filePath: 'test/fixture.jpg',
      estado: 'BORRADOR',
      placa,
      total: 200000 - monto,
      totalFactura: 200000 - monto,
      totalSinDescuento: monto > 0 ? 200000 : null,
      fechaPago: DateTime.now(),
      sedeId: SEDE_ID,
      agenteId: dateo ? AGENTE_COMERCIAL_ID : null,
      turnoId: turno?.id ?? null,
      dateoId: dateo?.id ?? null,
      servicioCodigo: 'RTM',
      servicioNombre: 'RTM',
      tipoVehiculoSnapshot: 'Liviano Particular',
      descuentoId: opts.descuentoId ?? null,
      descuentoMontoAplicado: monto > 0 ? monto : null,
      consecutivoDescuento: opts.descuentoId ? cd(`${placa}-INI`) : null,
    } as any)

    const res = await client
      .post(`/api/facturacion/tickets/${ticket.id}/confirmar`)
      .header('Authorization', `Bearer ${tokens.admin}`)
      .json({})
    if (res.status() !== 200) throw new Error(`confirmar ${placa}: ${res.status()} ${res.text()}`)

    const comision = dateo
      ? await Comision.query()
          .where('captacion_dateo_id', dateo.id)
          .where('es_config', false)
          .first()
      : null
    return { ticket: await FacturacionTicket.findOrFail(ticket.id), dateo, turno, comision }
  }

  function editar(client: any, id: number, body: Record<string, unknown>, token = tokens.admin) {
    return client
      .patch(`/api/facturacion/tickets/${id}`)
      .header('Authorization', `Bearer ${token}`)
      .json(body)
  }

  const ediciones = (ticketId: number) =>
    FacturacionDescuentoEdicion.query().where('facturacion_ticket_id', ticketId)

  async function filaTicket(id: number) {
    return Database.from('facturacion_tickets').where('id', id).first()
  }

  async function filaComision(id: number) {
    return Database.from('comisiones').where('id', id).first()
  }

  test('agregar descuento: total desde total_sin_descuento, consecutivo y registro', async ({
    assert,
    client,
  }) => {
    const { ticket } = await crearConfirmado(client, PLACAS[0])
    const res = await editar(client, ticket.id, {
      descuento_id: DESCUENTO.INFORMATIVO,
      descuento_monto_aplicado: 20000,
      autorizado_por_id: usuarios[1].id,
      descuento_observacion: 'Cliente pide en caja el descuento',
      consecutivo_descuento: cd('AGREGAR').toLowerCase(),
      motivo_edicion: 'Faltó registrar el descuento al confirmar',
    })
    assert.equal(res.status(), 200, res.text())
    assert.equal(res.body().antes.total, 200000)
    assert.equal(res.body().despues.total, 180000)
    assert.equal(res.body().comision.accion, 'SIN_COMISION')

    const t = await FacturacionTicket.findOrFail(ticket.id)
    assert.equal(t.estado, 'CONFIRMADA')
    assert.equal(t.descuentoId, DESCUENTO.INFORMATIVO)
    assert.equal(Number(t.descuentoMontoAplicado), 20000)
    assert.equal(Number(t.totalSinDescuento), 200000)
    assert.equal(Number(t.totalFactura), 180000)
    assert.equal(Number(t.total), 180000)
    assert.equal(t.consecutivoDescuento, cd('AGREGAR'))

    const regs = await ediciones(ticket.id)
    assert.lengthOf(regs, 1)
    const r = regs[0]
    assert.isNull(r.descuentoIdAnterior)
    assert.equal(r.descuentoIdNuevo, DESCUENTO.INFORMATIVO)
    assert.equal(r.descuentoNombreNuevo, 'Informativo')
    assert.isNull(r.montoAnterior)
    assert.equal(r.montoNuevo, 20000)
    assert.equal(r.totalAnterior, 200000)
    assert.equal(r.totalNuevo, 180000)
    assert.isNull(r.consecutivoAnterior)
    assert.equal(r.consecutivoNuevo, cd('AGREGAR'))
    assert.equal(r.motivo, 'Faltó registrar el descuento al confirmar')
    assert.equal(r.usuarioId, usuarios[0].id)
    assert.equal(r.comisionAccion, 'SIN_COMISION')
    assert.isNotNull(r.createdAt)
  }).timeout(30000)

  test('cambiar monto y quitar descuento: el total vuelve al original', async ({
    assert,
    client,
  }) => {
    const { ticket } = await crearConfirmado(client, PLACAS[1], {
      descuentoId: DESCUENTO.INFORMATIVO,
      monto: 30000,
    })
    assert.equal(Number(ticket.totalFactura), 170000)

    const cambio = await editar(client, ticket.id, {
      descuento_monto_aplicado: 10000,
      motivo_edicion: 'El monto autorizado era menor',
    })
    assert.equal(cambio.status(), 200, cambio.text())
    let t = await FacturacionTicket.findOrFail(ticket.id)
    assert.equal(Number(t.totalFactura), 190000)
    assert.equal(Number(t.totalSinDescuento), 200000)
    assert.equal(t.consecutivoDescuento, cd(`${PLACAS[1]}-INI`))

    const quitar = await editar(client, ticket.id, {
      descuento_id: null,
      motivo_edicion: 'El cliente no tenía derecho al descuento',
    })
    assert.equal(quitar.status(), 200, quitar.text())
    t = await FacturacionTicket.findOrFail(ticket.id)
    assert.isNull(t.descuentoId)
    assert.isNull(t.descuentoMontoAplicado)
    assert.isNull(t.consecutivoDescuento)
    assert.isNull(t.autorizadoPorId)
    assert.equal(Number(t.totalFactura), 200000)
    assert.equal(Number(t.total), 200000)

    const regs = await ediciones(ticket.id).orderBy('id', 'asc')
    assert.lengthOf(regs, 2)
    assert.equal(regs[0].montoAnterior, 30000)
    assert.equal(regs[0].montoNuevo, 10000)
    assert.equal(regs[1].descuentoIdAnterior, DESCUENTO.INFORMATIVO)
    assert.isNull(regs[1].descuentoIdNuevo)
    assert.equal(regs[1].consecutivoAnterior, cd(`${PLACAS[1]}-INI`))
    assert.isNull(regs[1].consecutivoNuevo)
    assert.equal(regs[1].totalNuevo, 200000)
  }).timeout(30000)

  test('consecutivo repetido en otro CONFIRMADA → 409 y no cambia nada', async ({
    assert,
    client,
  }) => {
    const otro = await crearConfirmado(client, PLACAS[2], {
      descuentoId: DESCUENTO.INFORMATIVO,
      monto: 5000,
    })
    const { ticket } = await crearConfirmado(client, PLACAS[3])
    const antes = await filaTicket(ticket.id)

    const res = await editar(client, ticket.id, {
      descuento_id: DESCUENTO.INFORMATIVO,
      descuento_monto_aplicado: 5000,
      consecutivo_descuento: otro.ticket.consecutivoDescuento,
      motivo_edicion: 'Probar consecutivo repetido',
    })
    assert.equal(res.status(), 409)
    assert.equal(res.body().code, 'CONSECUTIVO_DESCUENTO_DUPLICADO')
    assert.equal(res.body().id, otro.ticket.id)
    assert.deepEqual(await filaTicket(ticket.id), antes)
    assert.lengthOf(await ediciones(ticket.id), 0)

    // Con descuento el consecutivo es obligatorio.
    const sin = await editar(client, ticket.id, {
      descuento_id: DESCUENTO.INFORMATIVO,
      descuento_monto_aplicado: 5000,
      motivo_edicion: 'Probar consecutivo vacío',
    })
    assert.equal(sin.status(), 422)
    assert.equal(sin.body().code, 'CONSECUTIVO_DESCUENTO_REQUERIDO')
  }).timeout(30000)

  test('motivo vacío o corto → 422; sin cambios → SIN_CAMBIO; nada se escribe', async ({
    assert,
    client,
  }) => {
    const { ticket } = await crearConfirmado(client, PLACAS[4], {
      descuentoId: DESCUENTO.INFORMATIVO,
      monto: 10000,
    })
    const antes = await filaTicket(ticket.id)
    for (const motivo of ['', '   ', 'abc', '  ab  ']) {
      const r = await editar(client, ticket.id, {
        descuento_monto_aplicado: 20000,
        motivo_edicion: motivo,
      })
      assert.equal(r.status(), 422, `motivo "${motivo}"`)
      assert.equal(r.body().code, 'MOTIVO_REQUERIDO')
    }
    const igual = await editar(client, ticket.id, {
      descuento_id: DESCUENTO.INFORMATIVO,
      descuento_monto_aplicado: 10000,
      consecutivo_descuento: ticket.consecutivoDescuento,
      motivo_edicion: 'Nada cambia en realidad',
    })
    assert.equal(igual.status(), 422)
    assert.equal(igual.body().code, 'SIN_CAMBIO')
    assert.deepEqual(await filaTicket(ticket.id), antes)
    assert.lengthOf(await ediciones(ticket.id), 0)
  }).timeout(30000)

  test('permisos: CONTABILIDAD → 403 (también al previsualizar); GERENCIA sí puede', async ({
    assert,
    client,
  }) => {
    const { ticket } = await crearConfirmado(client, PLACAS[5])
    const antes = await filaTicket(ticket.id)
    const body = {
      descuento_id: DESCUENTO.INFORMATIVO,
      descuento_monto_aplicado: 1000,
      consecutivo_descuento: cd('PERM'),
      motivo_edicion: 'Probar permisos del rol',
    }
    const r1 = await editar(client, ticket.id, body, tokens.contabilidad)
    assert.equal(r1.status(), 403)
    assert.equal(r1.body().code, 'EDICION_DESCUENTO_SIN_PERMISO')
    const r2 = await editar(
      client,
      ticket.id,
      { ...body, solo_previsualizar: true },
      tokens.contabilidad
    )
    assert.equal(r2.status(), 403)
    assert.deepEqual(await filaTicket(ticket.id), antes)

    const r3 = await editar(client, ticket.id, body, tokens.gerencia)
    assert.equal(r3.status(), 200, r3.text())
    const regs = await ediciones(ticket.id)
    assert.lengthOf(regs, 1)
    assert.equal(regs[0].usuarioId, usuarios[1].id)
  }).timeout(30000)

  test('validaciones del descuento: máximo, monto fijo y documentos de Policía', async ({
    assert,
    client,
  }) => {
    const { ticket } = await crearConfirmado(client, PLACAS[6])
    const base = { consecutivo_descuento: cd('VAL'), motivo_edicion: 'Probar validaciones' }

    const max = await editar(client, ticket.id, {
      ...base,
      descuento_id: DESCUENTO.INFORMATIVO,
      descuento_monto_aplicado: MAX_INFORMATIVO + 1,
    })
    assert.equal(max.status(), 422)
    assert.equal(max.body().code, 'MONTO_SUPERA_MAXIMO')

    const fijo = await editar(client, ticket.id, {
      ...base,
      descuento_id: DESCUENTO.EMPLEADO,
      descuento_monto_aplicado: FIJO_EMPLEADO - 1000,
    })
    assert.equal(fijo.status(), 422)
    assert.equal(fijo.body().code, 'MONTO_FIJO')

    const policia = await editar(client, ticket.id, {
      ...base,
      descuento_id: DESCUENTO.POLICIA,
      descuento_monto_aplicado: 100000,
    })
    assert.equal(policia.status(), 400)
    assert.lengthOf(policia.body().documentos_faltantes, 3)
    // El detalle del ticket dice qué documentos de Policía faltan.
    const detalle = await client
      .get(`/api/facturacion/tickets/${ticket.id}`)
      .header('Authorization', `Bearer ${tokens.admin}`)
    assert.isFalse(detalle.body().documentosPoliciaCompletos)
    assert.deepEqual(detalle.body().documentosPoliciaFaltantes, [
      'carnet',
      'tarjeta_propiedad',
      'cedula',
    ])
    assert.lengthOf(await ediciones(ticket.id), 0)
  }).timeout(30000)

  test('solo_previsualizar no escribe nada (ticket, comisión ni registro)', async ({
    assert,
    client,
  }) => {
    const { ticket, comision } = await crearConfirmado(client, PLACAS[7], {
      dateo: 'SIN_CONVENIO',
    })
    assert.exists(comision)
    const ticketAntes = await filaTicket(ticket.id)
    const comisionAntes = await filaComision(comision!.id)
    const totalRegistros = await Database.from('facturacion_descuento_ediciones').count('* as n')

    // Espera 1 s para que un updated_at reescrito se notara.
    await new Promise((r) => setTimeout(r, 1100))
    const res = await editar(client, ticket.id, {
      descuento_id: DESCUENTO.INFORMATIVO,
      descuento_monto_aplicado: 15000,
      consecutivo_descuento: cd('PREVIA'),
      motivo_edicion: '',
      solo_previsualizar: true,
    })
    assert.equal(res.status(), 200, res.text())
    assert.isTrue(res.body().previsualizacion)
    assert.equal(res.body().despues.total, 185000)
    assert.equal(res.body().comision.accion, 'RECALCULADA')
    assert.equal(res.body().comision.comisionId, comision!.id)
    assert.notEqual(res.body().comision.despues.montoAsesor, res.body().comision.antes.montoAsesor)

    assert.deepEqual(await filaTicket(ticket.id), ticketAntes)
    assert.deepEqual(await filaComision(comision!.id), comisionAntes)
    assert.deepEqual(
      await Database.from('facturacion_descuento_ediciones').count('* as n'),
      totalRegistros
    )
  }).timeout(30000)

  test('comisión PENDIENTE: se recalcula igual que si se hubiera confirmado con ese descuento', async ({
    assert,
    client,
  }) => {
    const { ticket, comision } = await crearConfirmado(client, PLACAS[8], {
      dateo: 'SIN_CONVENIO',
    })
    // Gemelo confirmado desde el principio con el mismo descuento.
    const gemelo = await crearConfirmado(client, PLACAS[9], {
      dateo: 'SIN_CONVENIO',
      descuentoId: DESCUENTO.INFORMATIVO,
      monto: 15000,
    })
    assert.exists(comision)
    assert.exists(gemelo.comision)
    const montoAntes = Number(comision!.montoAsesor)

    const res = await editar(client, ticket.id, {
      descuento_id: DESCUENTO.INFORMATIVO,
      descuento_monto_aplicado: 15000,
      consecutivo_descuento: cd('PEND'),
      motivo_edicion: 'Se aplicó el informativo en caja',
    })
    assert.equal(res.status(), 200, res.text())
    assert.equal(res.body().comision.accion, 'RECALCULADA')
    assert.equal(res.body().comision.antes.montoAsesor, montoAntes)

    const c = await Comision.findOrFail(comision!.id)
    const g = gemelo.comision!
    assert.equal(c.estado, 'PENDIENTE')
    assert.equal(Number(c.monto), Number(g.monto))
    assert.equal(Number(c.montoAsesor), Number(g.montoAsesor))
    assert.equal(Number(c.montoConvenio), Number(g.montoConvenio))
    assert.equal(Number(c.base), Number(g.base))
    assert.equal(c.reglaAplicada, g.reglaAplicada)
    assert.equal(c.descuentoCodigoAplicado, 'INFORMATIVO')
    assert.notEqual(Number(c.montoAsesor), montoAntes)
    // No cambian quién cobra ni cuándo se calculó.
    assert.equal(c.asesorId, comision!.asesorId)
    assert.equal(c.fechaCalculo.toISO(), comision!.fechaCalculo.toISO())

    const [r] = await ediciones(ticket.id)
    assert.equal(r.comisionId, comision!.id)
    assert.equal(r.comisionEstado, 'PENDIENTE')
    assert.equal(r.comisionAccion, 'RECALCULADA')
    assert.equal(r.comisionMontoAsesorAnterior, montoAntes)
    assert.equal(r.comisionMontoAsesorNuevo, Number(g.montoAsesor))
  }).timeout(40000)

  test('comisión APROBADA, PAGADA o ANULADA: no se toca y avisa con su número', async ({
    assert,
    client,
  }) => {
    for (const [i, estado] of (['APROBADA', 'PAGADA', 'ANULADA'] as const).entries()) {
      const { ticket, comision } = await crearConfirmado(client, PLACAS[10 + i], {
        dateo: 'SIN_CONVENIO',
      })
      await Database.from('comisiones').where('id', comision!.id).update({ estado })
      const comisionAntes = await filaComision(comision!.id)

      const res = await editar(client, ticket.id, {
        descuento_id: DESCUENTO.INFORMATIVO,
        descuento_monto_aplicado: 15000,
        consecutivo_descuento: cd(`EST-${estado}`),
        motivo_edicion: `Comisión ${estado}`,
      })
      assert.equal(res.status(), 200, res.text())
      assert.equal(res.body().comision.accion, 'NO_MODIFICADA')
      assert.equal(
        res.body().comision.mensaje,
        `La comisión #${comision!.id} ya está ${estado}: no se modificó, ajústala en Comisiones.`
      )
      assert.deepEqual(await filaComision(comision!.id), comisionAntes)
      // El ticket sí queda editado.
      const editado = await FacturacionTicket.findOrFail(ticket.id)
      assert.equal(Number(editado.totalFactura), 185000)
      const [r] = await ediciones(ticket.id)
      assert.equal(r.comisionAccion, 'NO_MODIFICADA')
      assert.equal(r.comisionEstado, estado)
    }
  }).timeout(60000)

  test('comisión PENDIENTE dentro de una liquidación: no se toca', async ({ assert, client }) => {
    const { ticket, comision } = await crearConfirmado(client, PLACAS[17], {
      dateo: 'SIN_CONVENIO',
    })
    const [liquidacionId] = await Database.table('liquidaciones').insert({
      fecha_inicio: DateTime.now().toISODate(),
      fecha_fin: DateTime.now().toISODate(),
      tipo_origen: 'TABLA_GENERAL',
      usuario_id: usuarios[0].id,
    })
    try {
      await Database.table('liquidacion_detalle').insert({
        liquidacion_id: liquidacionId,
        comision_id: comision!.id,
        monto: comision!.montoAsesor,
      })
      const comisionAntes = await filaComision(comision!.id)
      const res = await editar(client, ticket.id, {
        descuento_id: DESCUENTO.INFORMATIVO,
        descuento_monto_aplicado: 15000,
        consecutivo_descuento: cd('LIQ'),
        motivo_edicion: 'Comisión ya liquidada',
      })
      assert.equal(res.status(), 200, res.text())
      assert.equal(res.body().comision.accion, 'NO_MODIFICADA')
      assert.equal(
        res.body().comision.mensaje,
        `La comisión #${comision!.id} ya está en una liquidación: no se modificó, ajústala en Comisiones.`
      )
      assert.deepEqual(await filaComision(comision!.id), comisionAntes)
    } finally {
      await Database.from('liquidacion_detalle').where('liquidacion_id', liquidacionId).delete()
      await Database.from('liquidaciones').where('id', liquidacionId).delete()
    }
  }).timeout(30000)

  test('con convenio: recalcula con la continuidad guardada; sin ella no toca la comisión', async ({
    assert,
    client,
  }) => {
    // Con continuidad guardada: Caso 3 + Informativo Empleado en caja → convenio $0.
    const a = await crearConfirmado(client, PLACAS[13], { dateo: 'CONVENIO_COMERCIAL' })
    const turnoA = await TurnoRtm.findOrFail(a.turno!.id)
    assert.isNotNull(turnoA.estadoContinuidad)
    assert.isAbove(Number(a.comision!.montoConvenio), 0)
    const ok = await editar(client, a.ticket.id, {
      descuento_id: DESCUENTO.EMPLEADO,
      descuento_monto_aplicado: FIJO_EMPLEADO,
      consecutivo_descuento: cd('CONV-OK'),
      motivo_edicion: 'Era empleado del convenio',
    })
    assert.equal(ok.status(), 200, ok.text())
    assert.equal(ok.body().comision.accion, 'RECALCULADA')
    const ca = await Comision.findOrFail(a.comision!.id)
    assert.equal(Number(ca.montoConvenio), 0)
    assert.equal(ca.descuentoCodigoAplicado, 'INFORMATIVO_EMPLEADO')

    // Sin continuidad guardada (deuda conocida): no se recalcula.
    const b = await crearConfirmado(client, PLACAS[14], { dateo: 'CONVENIO_COMERCIAL' })
    await Database.from('turnos_rtms').where('id', b.turno!.id).update({ estado_continuidad: null })
    const comisionAntes = await filaComision(b.comision!.id)
    const res = await editar(client, b.ticket.id, {
      descuento_id: DESCUENTO.EMPLEADO,
      descuento_monto_aplicado: FIJO_EMPLEADO,
      consecutivo_descuento: cd('CONV-NULL'),
      motivo_edicion: 'Era empleado del convenio',
    })
    assert.equal(res.status(), 200, res.text())
    assert.equal(res.body().comision.accion, 'SIN_CONTINUIDAD')
    assert.include(res.body().comision.mensaje, 'falta la continuidad guardada')
    assert.deepEqual(await filaComision(b.comision!.id), comisionAntes)
    // La continuidad no se inventa ni se recalcula.
    const turnoB = await TurnoRtm.findOrFail(b.turno!.id)
    assert.isNull(turnoB.estadoContinuidad)
  }).timeout(60000)

  test('ticket de Excepción de Dateo "sin comisión": se recalcula y el asesor sigue en $0', async ({
    assert,
    client,
  }) => {
    const { ticket, comision, turno } = await crearConfirmado(client, PLACAS[15], {
      dateo: 'SIN_CONVENIO',
      // Ticket APROBADO "sin comisión" para el asesor, antes de confirmar.
      antesDeConfirmar: async (t) => {
        const [ticketId] = await Database.table('tickets').insert({
          tipo_ticket_id: 1,
          titulo: `Excepción de Dateo ${PLACAS[15]} EDT-${RUN}`,
          estado: 'APROBADO',
          creado_por_id: usuarios[0].id,
        })
        await Database.table('tickets_detalle_excepcion_dateo').insert({
          ticket_id: ticketId,
          turno_id: t.id,
          placa: PLACAS[15],
          comercial_id: AGENTE_COMERCIAL_ID,
          hora_ingreso: '08:00',
          hora_intento_dateo: DateTime.now().toSQL({ includeOffset: false }),
          minutos_totales: 0,
          minutos_exceso: 0,
          observacion: 'test',
          evidencia_chat_url: 'x',
          evidencia_grupo_whatsapp_url: 'x',
          evidencia_bloqueo_url: 'x',
          con_comision: 0,
          con_comision_asesor: 0,
        })
      },
    })
    assert.equal(Number(comision!.montoAsesor), 0)
    const fotoAntes = await Database.from('tickets_detalle_excepcion_dateo')
      .where('turno_id', turno!.id)
      .first()

    const res = await editar(client, ticket.id, {
      descuento_id: DESCUENTO.INFORMATIVO,
      descuento_monto_aplicado: 15000,
      consecutivo_descuento: cd('SINCOM'),
      motivo_edicion: 'Informativo en caja',
    })
    assert.equal(res.status(), 200, res.text())
    assert.equal(res.body().comision.accion, 'RECALCULADA')
    assert.equal(res.body().comision.despues.montoAsesor, 0)

    const c = await Comision.findOrFail(comision!.id)
    assert.equal(Number(c.montoAsesor), 0)
    assert.equal(c.descuentoCodigoAplicado, 'INFORMATIVO')
    // La foto del valor calculado se actualiza al nuevo cálculo.
    const fotoDespues = await Database.from('tickets_detalle_excepcion_dateo')
      .where('turno_id', turno!.id)
      .first()
    assert.equal(Number(fotoDespues.monto_asesor_calculado), Number(c.monto))
    assert.notEqual(
      Number(fotoDespues.monto_asesor_calculado),
      Number(fotoAntes.monto_asesor_calculado)
    )
  }).timeout(40000)

  test('PATCH genérico sin motivo_edicion sigue igual en un CONFIRMADA (sin registro)', async ({
    assert,
    client,
  }) => {
    const { ticket } = await crearConfirmado(client, PLACAS[16], {
      descuentoId: DESCUENTO.INFORMATIVO,
      monto: 10000,
    })
    const res = await editar(
      client,
      ticket.id,
      { descuento_monto_aplicado: 12000, total_sin_descuento: 200000 },
      tokens.contabilidad
    )
    assert.equal(res.status(), 200, res.text())
    const t = await FacturacionTicket.findOrFail(ticket.id)
    assert.equal(Number(t.descuentoMontoAplicado), 12000)
    assert.equal(Number(t.totalFactura), 188000)
    assert.lengthOf(await ediciones(ticket.id), 0)
  }).timeout(30000)
})
