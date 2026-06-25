import type { HttpContext } from '@adonisjs/core/http'
import { DateTime } from 'luxon'
import app from '@adonisjs/core/services/app'
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import { existsSync, createReadStream, createWriteStream } from 'node:fs'
import { pipeline } from 'node:stream/promises'
import PdfkitTable from 'pdfkit-table'

const PDFDocument = PdfkitTable as any

import Tramite from '#models/tramite'
import TramiteLiquidacion from '#models/tramite_liquidacion'
import LiquidacionPago from '#models/liquidacion_pago'

const TIPO_TRAMITE_LABEL: Record<string, string> = {
  MATRICULA_REGISTRO:             'MATRICULA / REGISTRO',
  TRASPASO:                       'TRASPASO',
  TRASLADO_MATRICULA_REGISTRO:    'TRASLADO MATRICULA / REGISTRO',
  RADICADO_MATRICULA_REGISTRO:    'RADICADO MATRICULA / REGISTRO',
  CAMBIO_COLOR:                   'CAMBIO DE COLOR',
  CAMBIO_SERVICIO:                'CAMBIO DE SERVICIO',
  REGRABAR_MOTOR:                 'REGRABAR MOTOR',
  REGRABAR_CHASIS:                'REGRABAR CHASIS',
  TRANSFORMACION:                 'TRANSFORMACION',
  DUPLICADO_LICENCIA_TRANSITO:    'DUPLICADO LICENCIA TRANSITO',
  INSCRIPCION_PRENDA:             'INSCRIPCION DE PRENDA',
  LEVANTA_PRENDA:                 'LEVANTAMIENTO DE PRENDA',
  CANCELACION_MATRICULA_REGISTRO: 'CANCELACION MATRICULA / REGISTRO',
  CAMBIO_PLACAS:                  'CAMBIO DE PLACAS',
  DUPLICADO_PLACAS:               'DUPLICADO DE PLACAS',
  REMATRICULA:                    'REMATRICULA',
  CAMBIO_CARROCERIA:              'CAMBIO DE CARROCERIA',
  OTROS:                          'OTROS',
}

const formatPeso = (valor: number | null): string =>
  `$ ${new Intl.NumberFormat('es-CO').format(Math.round(valor ?? 0))}`

function calcularTotal(liq: TramiteLiquidacion): number {
  const campos = [
    liq.retencion, liq.derechosTraspaso, liq.pazSalvo, liq.levantamientoPrenda,
    liq.inscripcionPrenda, liq.papeleria, liq.honorarios,
    liq.impuestoAnioActual, liq.impuestoAniosVencidos,
  ]
  return campos.reduce<number>((sum, v) => sum + (Number(v) || 0), 0)
}

export default class LiquidacionPagosController {
  /** GET /tramites/liquidacion-historial?sedeId=&fecha=&turnoNumero= */
  public async getHistorialTurno({ request, response }: HttpContext) {
    try {
      const sedeId      = Number(request.input('sedeId'))
      const fecha       = request.input('fecha') as string
      const turnoNumero = Number(request.input('turnoNumero'))

      if (!sedeId || !fecha || !turnoNumero) {
        return response.badRequest({ message: 'sedeId, fecha y turnoNumero son requeridos' })
      }

      const tramites = await Tramite.query()
        .where('sede_id', sedeId)
        .where('fecha', fecha)
        .where('turno_numero', turnoNumero)
        .preload('liquidacion', (q) => q.preload('pagos'))
        .orderBy('id', 'asc')

      const resultado = tramites.map((tramite) => {
        const liq              = tramite.liquidacion
        const totalLiquidacion = liq ? calcularTotal(liq) : 0
        const pagos            = liq?.pagos ?? []
        const totalPagado      = pagos.reduce((sum, p) => sum + Number(p.monto), 0)
        const saldoPendiente   = Math.max(0, totalLiquidacion - totalPagado)

        let estado: 'pendiente' | 'parcial' | 'pagado'
        if (pagos.length === 0 || totalPagado === 0) {
          estado = 'pendiente'
        } else if (totalPagado >= totalLiquidacion) {
          estado = 'pagado'
        } else {
          estado = 'parcial'
        }

        return {
          tramiteId:        tramite.id,
          placa:            tramite.placa,
          tipoTramite:      tramite.tipoTramite,
          liquidacionId:    liq?.id ?? null,
          totalLiquidacion,
          pagos: pagos.map((p) => ({
            id:             p.id,
            fecha:          p.fecha,
            monto:          p.monto,
            formaPago:      p.formaPago,
            referenciaPago: p.referenciaPago,
            evidenciaUrl:   p.evidenciaUrl,
            pdfPath:        p.pdfPath,
          })),
          totalPagado,
          saldoPendiente,
          estado,
        }
      })

      return response.ok(resultado)
    } catch (error) {
      console.error('Error en getHistorialTurno:', error)
      return response.internalServerError({ message: 'Error al obtener el historial de pagos' })
    }
  }

  /** POST /tramites/liquidacion/:tramiteLiquidacionId/pago */
  public async registrarPago({ params, request, response }: HttpContext) {
    try {
      const liquidacion = await TramiteLiquidacion.query()
        .where('id', Number(params.tramiteLiquidacionId))
        .preload('tramite', (q) => q.preload('formularioRunt'))
        .first()

      if (!liquidacion) {
        return response.notFound({ message: 'Liquidación no encontrada' })
      }

      const fechaRaw       = request.input('fecha')          as string | undefined
      const monto          = request.input('monto')
      const formaPago      = request.input('formaPago')      as string | undefined
      const referenciaPago = request.input('referenciaPago') as string | undefined

      if (!fechaRaw || monto == null) {
        return response.badRequest({ message: 'fecha y monto son requeridos' })
      }

      if (!formaPago) {
        return response.badRequest({ message: 'La forma de pago es obligatoria' })
      }

      const fechaPago = DateTime.fromISO(fechaRaw, { zone: 'America/Bogota' })
      if (!fechaPago.isValid) {
        return response.badRequest({ message: 'fecha inválida — use formato YYYY-MM-DD' })
      }

      const montoNum = Number(monto)
      if (isNaN(montoNum) || montoNum <= 0) {
        return response.badRequest({ message: 'monto debe ser un número positivo' })
      }

      // ── Validación: liquidación no puede estar vacía ─────────────────────
      const totalLiquidacion = calcularTotal(liquidacion)
      if (totalLiquidacion === 0) {
        return response.unprocessableEntity({
          message: 'Esta liquidación no tiene valores registrados. Complétala antes de registrar un pago.',
        })
      }

      // ── Validación: monto no puede exceder el saldo pendiente actual ──────
      const pagosExistentes  = await LiquidacionPago.query()
        .where('tramite_liquidacion_id', liquidacion.id)
      const totalPagadoAntes = pagosExistentes.reduce((sum, p) => sum + Number(p.monto), 0)
      const saldoActual      = Math.max(0, totalLiquidacion - totalPagadoAntes)
      if (montoNum > saldoActual) {
        return response.badRequest({
          message: `El monto excede el saldo pendiente de ${formatPeso(saldoActual)}`,
        })
      }

      // ── Subida de evidencia ──────────────────────────────────────────────
      let evidenciaUrl: string | null = null
      const EXTS_EVIDENCIA = ['jpg', 'jpeg', 'jfif', 'png', 'pdf', 'webp']
      const evidencia = request.file('evidencia', { size: '10mb' })

      if (evidencia && evidencia.tmpPath) {
        if (evidencia.hasErrors) {
          return response.badRequest({ message: evidencia.errors[0]?.message ?? 'Archivo demasiado grande (máx 10MB)' })
        }
        const ext = (evidencia.clientName?.split('.').pop() ?? '').toLowerCase()
        if (!ext || !EXTS_EVIDENCIA.includes(ext)) {
          return response.badRequest({
            message: `Extensión .${ext || 'desconocida'} no permitida. Solo se aceptan: ${EXTS_EVIDENCIA.join(', ')}`,
          })
        }
        const abonoDir = app.makePath('uploads', 'abonos')
        await mkdir(abonoDir, { recursive: true })
        const name = `abono-liq-${liquidacion.id}-${Date.now()}.${ext}`
        const dest = `${abonoDir}/${name}`
        await pipeline(createReadStream(evidencia.tmpPath), createWriteStream(dest))
        evidenciaUrl = `/api/uploads/abonos/${name}`
      }

      // ── Crear registro de pago (sin pdf_path aún) ────────────────────────
      const pago = await LiquidacionPago.create({
        tramiteLiquidacionId: liquidacion.id,
        fecha:          fechaPago,
        monto:          montoNum,
        formaPago:      formaPago ?? null,
        referenciaPago: referenciaPago ?? null,
        evidenciaUrl,
        pdfPath:        null,
      })

      // ── Totales reales para el PDF (sin re-query) ────────────────────────
      const totalPagado    = totalPagadoAntes + montoNum
      const saldoPendiente = Math.max(0, totalLiquidacion - totalPagado)
      const estaPagado     = totalPagado >= totalLiquidacion

      // ── Construir PDF ────────────────────────────────────────────────────
      const tramite   = liquidacion.tramite
      const placa     = tramite.placa ?? tramite.formularioRunt?.placa ?? 'SIN-PLACA'
      const tipoLabel = tramite.tipoTramite
        ? (TIPO_TRAMITE_LABEL[tramite.tipoTramite] ?? tramite.tipoTramite)
        : 'N/A'

      const conceptos = [
        { label: 'Retención',               valor: liquidacion.retencion },
        { label: 'Derechos de traspaso',    valor: liquidacion.derechosTraspaso },
        { label: 'Paz y salvo',             valor: liquidacion.pazSalvo },
        { label: 'Levantamiento de prenda', valor: liquidacion.levantamientoPrenda },
        { label: 'Inscripción de prenda',   valor: liquidacion.inscripcionPrenda },
        { label: 'Papelería',               valor: liquidacion.papeleria },
        { label: 'Honorarios',              valor: liquidacion.honorarios },
        { label: 'Impuesto año actual',     valor: liquidacion.impuestoAnioActual },
        { label: 'Impuesto años vencidos',  valor: liquidacion.impuestoAniosVencidos },
      ]

      const doc = new PDFDocument({ margin: 50, size: 'LETTER' })

      const logoPath = app.makePath('storage/logo_tramites/logo_tramites_centro.png')
      if (existsSync(logoPath)) {
        doc.image(logoPath, 50, 45, { width: 110 })
      }
      doc.moveDown(4)

      doc
        .font('Helvetica-Bold')
        .fontSize(16)
        .fillColor('#1a3c5e')
        .text('LIQUIDACIÓN DE TRÁMITE', { align: 'center' })
      doc.moveDown(0.5)

      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor('#555555')
        .text(
          'A continuación se detallan los valores correspondientes al trámite solicitado. ' +
          'Por favor verifique la información antes de realizar el pago.',
          { align: 'center' }
        )
      doc.fillColor('#000000')

      doc.moveDown(0.8)
      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke()
      doc.moveDown(0.8)

      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a3c5e').text('Datos del trámite')
      doc.moveDown(0.4)
      doc.font('Helvetica').fontSize(10).fillColor('#000000')
      doc.text(`Placa:            ${placa}`)
      doc.text(`Tipo de trámite:  ${tipoLabel}`)
      doc.text(`Turno N.º:        ${tramite.turnoNumero}`)
      doc.text(`Cliente:          ${tramite.nombreCliente}`)
      doc.moveDown(1)

      const filas = [
        ...conceptos.map((c) => ({ concepto: c.label, valor: formatPeso(c.valor) })),
        { concepto: 'TOTAL', valor: formatPeso(totalLiquidacion) },
      ]

      await (doc as any).table(
        {
          headers: [
            { label: 'CONCEPTO', property: 'concepto', width: 330 },
            { label: 'VALOR',    property: 'valor',    width: 162, align: 'right' },
          ],
          datas: filas,
        },
        {
          prepareHeader: () =>
            (doc as any).font('Helvetica-Bold').fontSize(10).fillColor('#ffffff'),
          prepareRow: (_row: any, _col: number, indexRow: number) => {
            const esTotal = indexRow === filas.length - 1
            ;(doc as any)
              .font(esTotal ? 'Helvetica-Bold' : 'Helvetica')
              .fontSize(esTotal ? 11 : 10)
              .fillColor('#000000')
          },
          columnSpacing: 5,
          padding: 6,
          headerColor: '#1a3c5e',
        }
      )

      // ── Historial de pagos ───────────────────────────────────────────────
      doc.moveDown(1.2)
      doc.moveTo(50, doc.y).lineTo(562, doc.y).strokeColor('#cccccc').lineWidth(0.5).stroke()
      doc.moveDown(0.6)
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a3c5e').text('Historial de pagos')
      doc.moveDown(0.4)

      const todosPagos = [...pagosExistentes, pago].sort(
        (a, b) => (a.fecha?.toMillis() ?? 0) - (b.fecha?.toMillis() ?? 0)
      )

      const filasHistorial = [
        ...todosPagos.map((p) => ({
          fecha:      p.fecha?.toFormat('dd/MM/yyyy') ?? '—',
          monto:      formatPeso(Number(p.monto)),
          formaPago:  p.formaPago ?? '—',
          referencia: p.referenciaPago ?? '',
        })),
        {
          fecha:      'TOTAL PAGADO',
          monto:      formatPeso(totalPagado),
          formaPago:  '',
          referencia: '',
        },
      ]

      await (doc as any).table(
        {
          headers: [
            { label: 'FECHA',         property: 'fecha',      width: 88  },
            { label: 'MONTO',         property: 'monto',      width: 112, align: 'right' },
            { label: 'FORMA DE PAGO', property: 'formaPago',  width: 142 },
            { label: 'REFERENCIA',    property: 'referencia', width: 150 },
          ],
          datas: filasHistorial,
        },
        {
          prepareHeader: () =>
            (doc as any).font('Helvetica-Bold').fontSize(10).fillColor('#ffffff'),
          prepareRow: (_row: any, _col: number, indexRow: number) => {
            const esTotal = indexRow === filasHistorial.length - 1
            ;(doc as any)
              .font(esTotal ? 'Helvetica-Bold' : 'Helvetica')
              .fontSize(esTotal ? 11 : 10)
              .fillColor('#000000')
          },
          columnSpacing: 5,
          padding: 6,
          headerColor: '#1a3c5e',
        }
      )

      if (saldoPendiente > 0) {
        doc.moveDown(0.4)
        doc
          .font('Helvetica-Bold')
          .fontSize(10)
          .fillColor('#cc7700')
          .text(`Saldo pendiente: ${formatPeso(saldoPendiente)}`, { align: 'right' })
      }

      doc.moveDown(1.2)
      doc.font('Helvetica-Bold').fontSize(12)

      if (estaPagado) {
        const fechaStr = fechaPago.toFormat('dd/MM/yyyy')
        doc.fillColor('#1a7a1a').text(`PAGADO  —  ${fechaStr}`, { align: 'center' })
      } else {
        doc
          .fillColor('#cc7700')
          .text(`ABONO PARCIAL  —  Abonado hoy: ${formatPeso(montoNum)}`, { align: 'center' })
      }

      doc.fillColor('#000000')

      const pdfBuffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        doc.on('data', (chunk: Buffer) => chunks.push(chunk))
        doc.on('end',  () => resolve(Buffer.concat(chunks)))
        doc.on('error', reject)
        doc.end()
      })

      // ── Guardar PDF en disco ─────────────────────────────────────────────
      const pdfDir  = app.makePath('storage', 'liquidaciones_pdf')
      await mkdir(pdfDir, { recursive: true })
      const pdfName = `pago-${pago.id}.pdf`
      await writeFile(`${pdfDir}/${pdfName}`, pdfBuffer)

      pago.pdfPath = `storage/liquidaciones_pdf/${pdfName}`
      await pago.save()

      return response.ok(pago)
    } catch (error) {
      console.error('Error en registrarPago liquidacion:', error)
      return response.internalServerError({ message: 'Error al registrar el pago' })
    }
  }

  /** GET /tramites/reporte-caja?sedeId=&fechaInicio=&fechaFin= */
  public async getReporteCaja({ request, response }: HttpContext) {
    try {
      const fechaInicio = request.input('fechaInicio') as string
      const fechaFin    = request.input('fechaFin')    as string

      if (!fechaInicio || !fechaFin) {
        return response.badRequest({ message: 'fechaInicio y fechaFin son requeridos' })
      }

      const dtInicio = DateTime.fromISO(fechaInicio, { zone: 'America/Bogota' })
      const dtFin    = DateTime.fromISO(fechaFin,    { zone: 'America/Bogota' })
      if (!dtInicio.isValid || !dtFin.isValid) {
        return response.badRequest({ message: 'Fechas inválidas — use formato YYYY-MM-DD' })
      }
      if (dtInicio > dtFin) {
        return response.badRequest({ message: 'La fecha de inicio no puede ser mayor que la fecha fin' })
      }

      // ── 1. Pagos en el período ───────────────────────────────────────────
      const pagosEnPeriodo = await LiquidacionPago.query()
        .whereBetween('fecha', [fechaInicio, fechaFin])
        .preload('tramiteLiquidacion', (liqQ) => {
          liqQ.preload('tramite', (tramQ) => {
            tramQ.preload('formularioRunt')
          })
        })
        .orderBy('tramite_liquidacion_id', 'asc')
        .orderBy('fecha', 'asc')

      // ── 2. IDs únicos de liquidaciones presentes en el período ───────────
      const liquidacionIds = [...new Set(pagosEnPeriodo.map((p) => p.tramiteLiquidacionId))]

      // ── 3. TODOS los pagos de esas liquidaciones (historial completo) ────
      const todosPagosMap = new Map<number, LiquidacionPago[]>()
      if (liquidacionIds.length > 0) {
        const todosPagos = await LiquidacionPago.query()
          .whereIn('tramite_liquidacion_id', liquidacionIds)
        for (const p of todosPagos) {
          const arr = todosPagosMap.get(p.tramiteLiquidacionId) ?? []
          arr.push(p)
          todosPagosMap.set(p.tramiteLiquidacionId, arr)
        }
      }

      // ── 4. Agrupar pagos del período por liquidación ─────────────────────
      const pagosPorLiquidacion = new Map<number, typeof pagosEnPeriodo>()
      for (const p of pagosEnPeriodo) {
        const arr = pagosPorLiquidacion.get(p.tramiteLiquidacionId) ?? []
        arr.push(p)
        pagosPorLiquidacion.set(p.tramiteLiquidacionId, arr)
      }

      // ── 5. Construir array de liquidaciones ──────────────────────────────
      const liquidaciones = []
      for (const [liquidacionId, pagos] of pagosPorLiquidacion) {
        const liq     = pagos[0].tramiteLiquidacion
        const tramite = liq.tramite

        const totalLiquidacion     = calcularTotal(liq)
        const abonadoEnPeriodo     = pagos.reduce((sum, p) => sum + Number(p.monto), 0)
        const totalPagadoReal      = (todosPagosMap.get(liquidacionId) ?? [])
          .reduce((sum, p) => sum + Number(p.monto), 0)
        const saldoPendienteActual = Math.max(0, totalLiquidacion - totalPagadoReal)

        let estado: 'pendiente' | 'parcial' | 'pagado'
        if (totalPagadoReal === 0) {
          estado = 'pendiente'
        } else if (totalPagadoReal >= totalLiquidacion) {
          estado = 'pagado'
        } else {
          estado = 'parcial'
        }

        liquidaciones.push({
          tramiteLiquidacionId: liquidacionId,
          tramiteId:            tramite.id,
          turnoNumero:          tramite.turnoNumero,
          placa:                tramite.placa ?? tramite.formularioRunt?.placa ?? null,
          tipoTramite:          tramite.tipoTramite,
          nombreCliente:        tramite.nombreCliente,
          abonadoEnPeriodo,
          totalLiquidacion,
          saldoPendienteActual,
          estado,
          pagosEnPeriodo: pagos.map((p) => ({
            id:             p.id,
            fecha:          p.fecha?.toFormat('yyyy-MM-dd') ?? null,
            monto:          Number(p.monto),
            formaPago:      p.formaPago,
            referenciaPago: p.referenciaPago,
            evidenciaUrl:   p.evidenciaUrl ?? null,
          })),
        })
      }

      // ── 6. Totales globales ──────────────────────────────────────────────
      const totalIngresado  = pagosEnPeriodo.reduce((sum, p) => sum + Number(p.monto), 0)
      const porFormaPago: Record<string, number> = {}
      for (const p of pagosEnPeriodo) {
        const raw   = p.formaPago ?? 'Sin especificar'
        const forma = raw.charAt(0).toUpperCase() + raw.slice(1).toLowerCase()
        porFormaPago[forma] = (porFormaPago[forma] ?? 0) + Number(p.monto)
      }

      return response.ok({
        fechaInicio,
        fechaFin,
        totalIngresado,
        porFormaPago,
        liquidaciones,
      })
    } catch (error) {
      console.error('Error en getReporteCaja:', error)
      return response.internalServerError({ message: 'Error al generar el reporte de caja' })
    }
  }

  /** GET /tramites/liquidacion-pago/:liquidacionPagoId/pdf */
  public async getPagoPdf({ params, response }: HttpContext) {
    try {
      const pago = await LiquidacionPago.find(Number(params.liquidacionPagoId))
      if (!pago) {
        return response.notFound({ message: 'Pago no encontrado' })
      }
      if (!pago.pdfPath) {
        return response.notFound({ message: 'Este pago no tiene PDF generado' })
      }

      const absPath = app.makePath(pago.pdfPath)
      if (!existsSync(absPath)) {
        return response.notFound({ message: 'Archivo PDF no encontrado en disco' })
      }

      const buffer   = await readFile(absPath)
      const fileName = `LIQUIDACION-PAGO-${pago.id}.pdf`
      response.header('Content-Type', 'application/pdf')
      response.header('Content-Disposition', `inline; filename="${fileName}"`)
      return response.send(buffer)
    } catch (error) {
      console.error('Error en getPagoPdf:', error)
      return response.internalServerError({ message: 'Error al obtener el PDF' })
    }
  }
}
