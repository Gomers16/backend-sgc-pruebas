import type { HttpContext } from '@adonisjs/core/http'
import app from '@adonisjs/core/services/app'
import { existsSync } from 'node:fs'
import PdfkitTable from 'pdfkit-table'

const PDFDocument = PdfkitTable as any
import TramiteLiquidacion from '#models/tramite_liquidacion'
import Tramite from '#models/tramite'

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

const CAMPOS_LIQUIDACION = [
  'retencion',
  'derechosTraspaso',
  'pazSalvo',
  'levantamientoPrenda',
  'inscripcionPrenda',
  'papeleria',
  'honorarios',
  'impuestoAnioActual',
  'impuestoAniosVencidos',
] as const

const LIQUIDACION_VACIA = {
  id: null,
  retencion: 0,
  derechosTraspaso: 0,
  pazSalvo: 0,
  levantamientoPrenda: 0,
  inscripcionPrenda: 0,
  papeleria: 0,
  honorarios: 0,
  impuestoAnioActual: 0,
  impuestoAniosVencidos: 0,
}

const formatPeso = (valor: number | null): string =>
  `$ ${new Intl.NumberFormat('es-CO').format(Math.round(valor ?? 0))}`

export default class TramiteLiquidacionesController {
  /** GET /tramites/:tramiteId/liquidacion */
  public async getByTramite({ params, response }: HttpContext) {
    try {
      const liquidacion = await TramiteLiquidacion.query()
        .where('tramite_id', Number(params.tramiteId))
        .first()

      if (!liquidacion) {
        return response.ok({ ...LIQUIDACION_VACIA, tramiteId: Number(params.tramiteId) })
      }

      return response.ok(liquidacion)
    } catch (error) {
      console.error('Error en getByTramite liquidacion:', error)
      return response.internalServerError({ message: 'Error al obtener la liquidación' })
    }
  }

  /** PUT /tramites/:tramiteId/liquidacion */
  public async upsert({ params, request, response }: HttpContext) {
    try {
      const tramite = await Tramite.find(Number(params.tramiteId))
      if (!tramite) return response.notFound({ message: 'Trámite no encontrado' })

      const raw = request.only([...CAMPOS_LIQUIDACION])

      const camposNegativos = CAMPOS_LIQUIDACION.filter(
        (c) => raw[c] !== undefined && Number(raw[c]) < 0
      )
      if (camposNegativos.length > 0) {
        return response.badRequest({
          message: `Los valores de liquidación no pueden ser negativos: ${camposNegativos.join(', ')}`,
        })
      }

      const updates = Object.fromEntries(
        Object.entries(raw).filter(([, v]) => v !== undefined)
      )

      let liquidacion = await TramiteLiquidacion.query()
        .where('tramite_id', tramite.id)
        .first()

      if (!liquidacion) {
        liquidacion = await TramiteLiquidacion.create({ tramiteId: tramite.id, ...updates })
      } else {
        liquidacion.merge(updates)
        await liquidacion.save()
      }

      return response.ok(liquidacion)
    } catch (error) {
      console.error('Error en upsert liquidacion:', error)
      return response.internalServerError({ message: 'Error al guardar la liquidación' })
    }
  }

  /** GET /tramites/:tramiteId/liquidacion/export-pdf */
  public async exportLiquidacionPdf({ params, response }: HttpContext) {
    try {
      const tramite = await Tramite.query()
        .where('id', Number(params.tramiteId))
        .preload('liquidacion')
        .preload('formularioRunt')
        .first()

      if (!tramite) return response.notFound({ message: 'Trámite no encontrado' })

      if (!tramite.liquidacion) {
        return response.unprocessableEntity({
          message: 'Este trámite no tiene liquidación guardada. Guárdala primero.',
        })
      }

      const liq = tramite.liquidacion

      const conceptos = [
        { label: 'Retención',              valor: liq.retencion },
        { label: 'Derechos de traspaso',   valor: liq.derechosTraspaso },
        { label: 'Paz y salvo',            valor: liq.pazSalvo },
        { label: 'Levantamiento de prenda', valor: liq.levantamientoPrenda },
        { label: 'Inscripción de prenda',  valor: liq.inscripcionPrenda },
        { label: 'Papelería',              valor: liq.papeleria },
        { label: 'Honorarios',             valor: liq.honorarios },
        { label: 'Impuesto año actual',    valor: liq.impuestoAnioActual },
        { label: 'Impuesto años vencidos', valor: liq.impuestoAniosVencidos },
      ]
      const total = conceptos.reduce((sum, c) => {
        const v = Number(c.valor)
        return sum + (isNaN(v) ? 0 : v)
      }, 0)

      const placa = tramite.placa ?? tramite.formularioRunt?.placa ?? 'SIN-PLACA'
      const tipoLabel = tramite.tipoTramite
        ? (TIPO_TRAMITE_LABEL[tramite.tipoTramite] ?? tramite.tipoTramite)
        : 'N/A'

      // ── Documento PDF ────────────────────────────────────────────────────
      const doc = new PDFDocument({ margin: 50, size: 'LETTER' })

      // Logo
      const logoPath = app.makePath('storage/logo_tramites/logo_tramites_centro.png')
      if (existsSync(logoPath)) {
        doc.image(logoPath, 50, 45, { width: 110 })
      }
      doc.moveDown(4)

      // Título
      doc
        .font('Helvetica-Bold')
        .fontSize(16)
        .fillColor('#1a3c5e')
        .text('LIQUIDACIÓN DE TRÁMITE', { align: 'center' })

      doc.moveDown(0.5)

      // Texto explicativo
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

      // Línea separadora
      doc.moveDown(0.8)
      doc
        .moveTo(50, doc.y)
        .lineTo(562, doc.y)
        .strokeColor('#cccccc')
        .lineWidth(0.5)
        .stroke()
      doc.moveDown(0.8)

      // Datos del trámite
      doc.font('Helvetica-Bold').fontSize(10).fillColor('#1a3c5e').text('Datos del trámite')
      doc.moveDown(0.4)
      doc.font('Helvetica').fontSize(10).fillColor('#000000')
      doc.text(`Placa:            ${placa}`)
      doc.text(`Tipo de trámite:  ${tipoLabel}`)
      doc.text(`Turno N.º:        ${tramite.turnoNumero}`)
      doc.text(`Cliente:          ${tramite.nombreCliente}`)

      doc.moveDown(1)

      // ── Tabla de conceptos ──────────────────────────────────────────────
      // Se añade TOTAL como última fila y se estiliza en prepareRow por índice
      const filas = [
        ...conceptos.map((c) => ({ concepto: c.label, valor: formatPeso(c.valor) })),
        { concepto: 'TOTAL', valor: formatPeso(total) },
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

      // ── Estado de pago ──────────────────────────────────────────────────
      doc.moveDown(1.5)
      doc.font('Helvetica-Bold').fontSize(12)

      if (tramite.estadoPago === 'pagado') {
        const fechaStr = tramite.fechaPago
          ? tramite.fechaPago.setLocale('es-CO').toFormat('dd/MM/yyyy HH:mm')
          : ''
        doc
          .fillColor('#1a7a1a')
          .text(`PAGADO${fechaStr ? `  —  ${fechaStr}` : ''}`, { align: 'center' })
      } else {
        doc.fillColor('#cc0000').text('PENDIENTE DE PAGO', { align: 'center' })
      }

      doc.fillColor('#000000')

      // ── Buffer y envío ──────────────────────────────────────────────────
      const buffer = await new Promise<Buffer>((resolve, reject) => {
        const chunks: Buffer[] = []
        doc.on('data', (chunk: Buffer) => chunks.push(chunk))
        doc.on('end', () => resolve(Buffer.concat(chunks)))
        doc.on('error', reject)
        doc.end()
      })

      const fileName = `LIQUIDACION-${placa}-${tramite.turnoNumero}.pdf`
      response.header('Content-Type', 'application/pdf')
      response.header('Content-Disposition', `attachment; filename="${fileName}"`)
      return response.send(buffer)
    } catch (error) {
      console.error('Error en exportLiquidacionPdf:', error)
      return response.internalServerError({ message: 'Error al generar el PDF de liquidación' })
    }
  }
}
