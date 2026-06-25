import type { HttpContext } from '@adonisjs/core/http'
import ExcelJS from 'exceljs'
import app from '@adonisjs/core/services/app'

import FormularioRunt from '#models/formulario_runt'
import Tramite from '#models/tramite'
import TramiteChecklist from '#models/tramite_checklist'

const TIPO_TRAMITE_LABEL: Record<string, string> = {
  MATRICULA_REGISTRO:             'MATRICULA / REGISTRO',
  TRASPASO:                       'TRASPASO',
  TRASLADO_MATRICULA_REGISTRO:    'TRANSLADO MATRICULA / REGISTRO',
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

const CAMPOS_FORMULARIO = [
  // Vehículo
  'placa',
  'marca',
  'linea',
  'modelo',
  'color',
  'claseVehiculo',
  'combustible',
  'noMotor',
  'noChasis',
  'noSerie',
  'noVin',
  'tipoServicio',
  'carroceriaCodigo',
  'carroceriaTipo',
  'capacidadKg',
  'blindaje',
  'potenciaHp',
  'cilindrada',
  // Propietario
  'propPrimerApellido',
  'propSegundoApellido',
  'propNombres',
  'propTipoDocumento',
  'propNoDocumento',
  'propDireccion',
  'propCiudad',
  'propTelefono',
  // Comprador
  'compPrimerApellido',
  'compSegundoApellido',
  'compNombres',
  'compTipoDocumento',
  'compNoDocumento',
  'compDireccion',
  'compCiudad',
  'compTelefono',
  // Importación
  'importacionTipo',
  'importacionNoDocumento',
  'importacionFecha',
  // Alertas
  'alertaHurto',
  'alertaLimPropiedad',
  'alertaEmbargo',
  'alertaOtro',
  // Observaciones
  'observaciones',
  // Contacto y mandatario
  'propCorreo',
  'compCorreo',
  'puertas',
  'mandatarioNombre',
  'mandatarioDocumento',
] as const

// Celdas del formulario RUNT oficial según tipo de trámite
const TRAMITE_CELDAS: Record<string, string> = {
  MATRICULA_REGISTRO:             'A8',
  TRASPASO:                       'E8',
  TRASLADO_MATRICULA_REGISTRO:    'I8',
  RADICADO_MATRICULA_REGISTRO:    'N8',
  CAMBIO_COLOR:                   'Q8',
  CAMBIO_SERVICIO:                'T8',
  REGRABAR_MOTOR:                 'A10',
  REGRABAR_CHASIS:                'E10',
  TRANSFORMACION:                 'I10',
  DUPLICADO_LICENCIA_TRANSITO:    'N10',
  INSCRIPCION_PRENDA:             'Q10',
  LEVANTA_PRENDA:                 'T10',
  CANCELACION_MATRICULA_REGISTRO: 'A13',
  CAMBIO_PLACAS:                  'E13',
  DUPLICADO_PLACAS:               'I13',
  REMATRICULA:                    'N13',
  CAMBIO_CARROCERIA:              'Q13',
  OTROS:                          'T13',
}

const CLASE_VEHICULO_CELDAS: Record<string, string> = {
  automovil:     'A17',
  bus:           'D17',
  buseta:        'H17',
  camion:        'L17',
  camioneta:     'O17',
  campero:       'P17',
  microbus:      'S17',
  tractocamion:  'A19',
  motocicleta:   'D19',
  motocarro:     'H19',
  mototriciciclo:'L19',
  cuatrimoto:    'O19',
  volqueta:      'P19',
  otro:          'S19',
}

// Para exportPaqueteCompleto: el FORMULARIO lee estos checkmarks vía fórmulas =DATOS!Exx
const CLASE_VEHICULO_DATOS_CELDAS: Record<string, string> = {
  automovil:      'E20',
  bus:            'F20',
  buseta:         'G20',
  camion:         'H20',
  camioneta:      'I20',
  campero:        'J20',
  microbus:       'K20',
  tractocamion:   'E22',
  motocicleta:    'F22',
  motocarro:      'G22',
  mototriciciclo: 'H22',
  cuatrimoto:     'I22',
  volqueta:       'J22',
  otro:           'K22',
}

const COMBUSTIBLE_CELDAS: Record<string, string> = {
  gasolina:  'AC8',
  diesel:    'AE8',
  gas:       'AF8',
  electrico: 'AG8',
  hibrido:   'AH8',
  etanol:    'AJ8',
  biodiesel: 'AK8',
}

const TIPO_SERVICIO_VEH_CELDAS: Record<string, string> = {
  particular:  'AE29',
  publico:     'AF29',
  diplomatico: 'AG29',
  oficial:     'AH29',
  especial:    'AI29',
  otros:       'AJ29',
}

const IMPORT_TIPO_CELDAS: Record<string, string> = {
  manif_o_acta:    'W25',
  dec_importacion: 'X25',
  acta:            'Y25',
  entidad:         'Z25',
  lugar:           'AA25',
  codigo:          'AB25',
}

const PROP_DOC_CELDAS: Record<string, string> = {
  cc:            'A26',
  nit:           'C26',
  nn:            'D26',
  pasaporte:     'G26',
  c_extranjeria: 'J26',
  t_identidad:   'L26',
  nuip:          'O26',
  c_diplomatico: 'P26',
}

const COMP_DOC_CELDAS: Record<string, string> = {
  cc:            'A41',
  nit:           'C41',
  nn:            'D41',
  pasaporte:     'G41',
  c_extranjeria: 'J41',
  t_identidad:   'L41',
  nuip:          'O41',
  c_diplomatico: 'P41',
}

export default class FormulariosRuntController {
  /** GET /tramites/:tramiteId/formulario-runt */
  public async show({ params, response }: HttpContext) {
    try {
      const formulario = await FormularioRunt.query()
        .where('tramite_id', Number(params.tramiteId))
        .first()

      if (!formulario) return response.notFound({ message: 'Formulario RUNT no encontrado' })
      return response.ok(formulario)
    } catch (error) {
      console.error('Error en show formulario RUNT:', error)
      return response.internalServerError({ message: 'Error al obtener el formulario RUNT' })
    }
  }

  /** PUT /tramites/:tramiteId/formulario-runt */
  public async upsert({ params, request, response }: HttpContext) {
    try {
      const tramite = await Tramite.find(Number(params.tramiteId))
      if (!tramite) return response.notFound({ message: 'Trámite no encontrado' })

      const raw = request.only([...CAMPOS_FORMULARIO])

      // Solo actualizar los campos que el cliente envió explícitamente
      const updates = Object.fromEntries(
        Object.entries(raw).filter(([, v]) => v !== undefined)
      )

      if (typeof updates.placa === 'string') updates.placa = updates.placa.substring(0, 6)

      let formulario = await FormularioRunt.query()
        .where('tramite_id', tramite.id)
        .first()

      if (!formulario) {
        formulario = await FormularioRunt.create({ tramiteId: tramite.id, ...updates })
      } else {
        formulario.merge(updates)
        await formulario.save()
      }

      return response.ok(formulario)
    } catch (error) {
      console.error('Error en upsert formulario RUNT:', error)
      return response.internalServerError({ message: 'Error al guardar el formulario RUNT' })
    }
  }

  /** GET /tramites/:tramiteId/formulario-runt/export-excel */
  public async exportExcel({ params, response }: HttpContext) {
    try {
      const tramite = await Tramite.query()
        .where('id', Number(params.tramiteId))
        .preload('formularioRunt')
        .preload('funcionario')
        .first()

      if (!tramite) return response.notFound({ message: 'Trámite no encontrado' })

      const formulario = tramite.formularioRunt
      if (!formulario) {
        return response.unprocessableEntity({
          message: 'Este trámite no tiene formulario RUNT guardado. Llénalo primero.',
        })
      }

      // El archivo base debe estar en storage/runt/ como .xlsx
      // (ftrunt_0.xls debe convertirse a .xlsx antes de copiarlo)
      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(app.makePath('storage/runt/formulario_runt_base.xlsx'))

      const ws = workbook.getWorksheet(1)
      if (!ws) {
        return response.internalServerError({
          message: 'Archivo base RUNT no encontrado o sin hojas válidas',
        })
      }

      // Guardar anchos de columna del template antes de cualquier modificación.
      // ExcelJS los pierde al escribir celdas; los restauramos antes de writeBuffer.
      const colWidths: Record<number, number> = {}
      ws.columns.forEach((col, i) => {
        if (col.width) colWidths[i] = col.width
      })

      // Limpiar tachado heredado del template.
      // includeEmpty: true alcanza celdas mergeadas (slaves) que eachRow omite por defecto.
      // Se preserva row.height para que los rangos mergeados no colapsen.
      ws.eachRow({ includeEmpty: true }, (row) => {
        const h = row.height
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (cell.font?.strike) cell.font = { ...cell.font, strike: false }
        })
        if (h !== undefined) row.height = h
      })
      // Segundo pase: iterar explícitamente las celdas master de cada rango mergeado.
      // eachRow puede omitir masters de merges grandes que empiezan en filas sin datos
      // propios (ej. sección importación filas 23-28 columnas W-AB).
      if (ws.model?.merges) {
        for (const range of ws.model.merges) {
          const masterAddr = range.split(':')[0]
          const masterCell = ws.getCell(masterAddr)
          if (masterCell.font?.strike) masterCell.font = { ...masterCell.font, strike: false }
        }
      }
      // Tercer pase: limpieza de strike en zona de importación (filas 22-28, cols W-AB).
      // Debug confirmó strike=false en toda la zona — el italic del template es intencional.
      // El bucle se mantiene como salvaguarda por si el template cambia.
      for (let r = 22; r <= 28; r++) {
        for (let c = 23; c <= 28; c++) {
          const cell = ws.getRow(r).getCell(c)
          if (cell.font?.strike) cell.font = { ...cell.font, strike: false }
        }
      }

      // setCell: resuelve la master cell del merge antes de escribir.
      const setCell = (address: string, value: ExcelJS.CellValue) => {
        const cell = ws.getCell(address)
        const target = cell.isMerged ? cell.master : cell
        target.value = value
      }
      // setCellNoWrap: escribe en la dirección exacta (sin resolver master) y
      // desactiva wrapText. Usar en celdas de datos que comparten fila con headers
      // mergeados (ej. fila 24 de propietario) para no sobreescribir etiquetas.
      const setCellNoWrap = (address: string, value: ExcelJS.CellValue) => {
        const cell = ws.getCell(address)
        cell.alignment = { ...cell.alignment, wrapText: false }
        cell.value = value
      }
      const mark = (address: string, condition: boolean | null | undefined) => {
        if (condition) setCell(address, 'X')
      }

      // ── SECCIÓN 2: PLACA ──────────────────────────────────────────────
      if (formulario.placa) {
        const placa = formulario.placa.toUpperCase().trim()
        const esCarro = /^[A-Z]{3}[0-9]{3}$/.test(placa)
        if (esCarro) {
          setCell('AJ4', placa.substring(0, 3))
          setCell('AK4', placa.substring(3, 6))
        } else {
          setCell('AJ4', placa)
          setCell('AK4', '')
        }
      }

      // ── SECCIÓN 3: TRÁMITE SOLICITADO ─────────────────────────────────
      if (tramite.tipoTramite && TRAMITE_CELDAS[tramite.tipoTramite]) {
        setCell(TRAMITE_CELDAS[tramite.tipoTramite], 'X')
      }

      // ── SECCIÓN 4: CLASE DE VEHÍCULO ──────────────────────────────────
      if (formulario.claseVehiculo && CLASE_VEHICULO_CELDAS[formulario.claseVehiculo]) {
        setCell(CLASE_VEHICULO_CELDAS[formulario.claseVehiculo], 'X')
      }

      // ── SECCIÓN 5: DATOS DEL VEHÍCULO ─────────────────────────────────
      setCell('W7',  formulario.marca            ?? null)
      setCell('Z7',  formulario.linea            ?? null)
      setCell('W10', formulario.color            ?? null)
      setCell('AG10', formulario.modelo          ?? null)
      setCell('AI10', formulario.cilindrada      ?? null)
      setCell('W13', formulario.capacidadKg      ?? null)
      setCell('AI13', formulario.potenciaHp      ?? null)
      setCell('W17', formulario.carroceriaCodigo ?? null)
      setCell('W19', formulario.carroceriaTipo   ?? null)

      // ── SECCIÓN 6: COMBUSTIBLE ────────────────────────────────────────
      if (formulario.combustible && COMBUSTIBLE_CELDAS[formulario.combustible]) {
        setCell(COMBUSTIBLE_CELDAS[formulario.combustible], 'X')
      }

      // ── SECCIÓN 8: IDENTIFICACIÓN INTERNA ────────────────────────────
      setCell('AE17', formulario.noMotor  ?? null)
      setCell('AE19', formulario.noChasis ?? null)
      setCell('AE22', formulario.noSerie  ?? null)
      setCell('AE24', formulario.noVin    ?? null)

      // ── SECCIÓN 9: TIPO DE SERVICIO ───────────────────────────────────
      if (formulario.tipoServicio && TIPO_SERVICIO_VEH_CELDAS[formulario.tipoServicio]) {
        setCell(TIPO_SERVICIO_VEH_CELDAS[formulario.tipoServicio], 'X')
      }

      // ── SECCIÓN 10: IMPORTACIÓN O REMATE ─────────────────────────────
      if (formulario.importacionTipo && IMPORT_TIPO_CELDAS[formulario.importacionTipo]) {
        setCell(IMPORT_TIPO_CELDAS[formulario.importacionTipo], 'X')
      }
      setCell('W27', formulario.importacionNoDocumento ?? null)
      if (formulario.importacionFecha) {
        setCell('Z28',  formulario.importacionFecha.day)
        setCell('AA28', formulario.importacionFecha.month)
        setCell('AB28', formulario.importacionFecha.year)
      }

      // ── SECCIÓN 11: DATOS DEL PROPIETARIO ────────────────────────────
      // Fila 23 = headers (PRIMER APELLIDO, etc.) — NO tocar.
      // Fila 24 = datos: se escribe directo con setCellNoWrap para desactivar wrapText.
      setCellNoWrap('A24', formulario.propPrimerApellido  ?? null)
      setCellNoWrap('I24', formulario.propSegundoApellido ?? null)
      setCellNoWrap('P24', formulario.propNombres         ?? null)
      setCell('S27', formulario.propNoDocumento     ?? null)
      setCell('A29', formulario.propDireccion       ?? null)
      setCell('M29', formulario.propCiudad          ?? null)
      setCell('S29', formulario.propTelefono        ?? null)

      if (formulario.propTipoDocumento && PROP_DOC_CELDAS[formulario.propTipoDocumento]) {
        setCell(PROP_DOC_CELDAS[formulario.propTipoDocumento], 'X')
      }

      // ── SECCIÓN 12: DATOS DEL COMPRADOR (solo TRASPASO) ───────────────
      if (tramite.tipoTramite === 'TRASPASO') {
        setCell('A37', formulario.compPrimerApellido  ?? null)
        setCell('I37', formulario.compSegundoApellido ?? null)
        setCell('P37', formulario.compNombres         ?? null)
        setCell('S41', formulario.compNoDocumento     ?? null)
        setCell('A44', formulario.compDireccion       ?? null)
        setCell('M44', formulario.compCiudad          ?? null)
        setCell('S44', formulario.compTelefono        ?? null)

        if (formulario.compTipoDocumento && COMP_DOC_CELDAS[formulario.compTipoDocumento]) {
          setCell(COMP_DOC_CELDAS[formulario.compTipoDocumento], 'X')
        }
      }

      // ── SECCIÓN 13: ALERTAS ───────────────────────────────────────────
      mark('W33', formulario.alertaHurto)
      mark('X33', formulario.alertaLimPropiedad)
      mark('Z33', formulario.alertaEmbargo)
      if (formulario.alertaOtro) setCell('AB33', formulario.alertaOtro)

      // ── SECCIÓN 14: OBSERVACIONES ────────────────────────────────────
      setCell('W39', formulario.observaciones ?? null)

      // ── SERIALIZAR Y ENVIAR ───────────────────────────────────────────
      // Restaurar anchos del template y aplicar mínimos en columnas de texto libre.
      const colLetter = (n: number): string => {
        let s = ''
        while (n > 0) { s = String.fromCharCode(65 + ((n - 1) % 26)) + s; n = Math.floor((n - 1) / 26) }
        return s
      }
      const minWidths: Record<string, number> = { A: 15, I: 12, M: 10, P: 15, S: 10, W: 20, AJ: 12, AK: 8, AL: 8 }
      ws.columns.forEach((col, i) => {
        const letter   = colLetter(i + 1)
        const restored = colWidths[i] ?? 0
        col.width = Math.max(restored, minWidths[letter] ?? 0)
      })
      const minHeights: Record<number, number> = {
        10: 25,
        24: 25,
        29: 25,
        37: 25,
        44: 25,
      }
      ws.eachRow({ includeEmpty: true }, (row) => {
        const min = minHeights[row.number]
        if (min && (!row.height || row.height < min)) row.height = min
      })
      const buffer = await workbook.xlsx.writeBuffer()
      const placa = formulario.placa ?? 'SIN-PLACA'
      const fileName = `RUNT-${placa}-${tramite.turnoNumero}.xlsx`

      response.header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      response.header('Content-Disposition', `attachment; filename="${fileName}"`)
      return response.send(buffer)
    } catch (error) {
      console.error('Error en exportExcel formulario RUNT:', error)
      return response.internalServerError({ message: 'Error al generar el Excel RUNT' })
    }
  }

  /** GET /tramites/:tramiteId/mandato/export-excel */
  public async exportMandatoExcel({ params, response }: HttpContext) {
    try {
      const tramite = await Tramite.query()
        .where('id', Number(params.tramiteId))
        .preload('formularioRunt')
        .first()

      if (!tramite) return response.notFound({ message: 'Trámite no encontrado' })

      const formulario = tramite.formularioRunt
      if (!formulario) {
        return response.unprocessableEntity({
          message: 'Este trámite no tiene formulario RUNT guardado. Llénalo primero.',
        })
      }

      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(app.makePath('storage/runt/mandato_base.xlsx'))

      const ws = workbook.getWorksheet(1)
      if (!ws) {
        return response.internalServerError({ message: 'Plantilla de mandato no encontrada' })
      }

      // Guardar anchos de columna del template
      const colWidths: Record<number, number> = {}
      ws.columns.forEach((col, i) => {
        if (col.width) colWidths[i] = col.width
      })

      // Limpiar strike heredado del template
      ws.eachRow({ includeEmpty: true }, (row) => {
        const h = row.height
        row.eachCell({ includeEmpty: true }, (cell) => {
          if (cell.font?.strike) cell.font = { ...cell.font, strike: false }
        })
        if (h !== undefined) row.height = h
      })
      if (ws.model?.merges) {
        for (const range of ws.model.merges) {
          const masterAddr = range.split(':')[0]
          const masterCell = ws.getCell(masterAddr)
          if (masterCell.font?.strike) masterCell.font = { ...masterCell.font, strike: false }
        }
      }

      const setCell = (address: string, value: ExcelJS.CellValue) => {
        const cell = ws.getCell(address)
        const target = cell.isMerged ? cell.master : cell
        target.value = value
      }

      // ── Nombre del mandante (propietario: apellidos + nombres)
      const nombreMandante = [
        formulario.propPrimerApellido,
        formulario.propSegundoApellido,
        formulario.propNombres,
      ].filter(Boolean).join(' ') || null
      setCell('H5',  nombreMandante)

      // ── Documento del mandante
      setCell('M7',  formulario.propNoDocumento ?? null)

      // ── Nombre y documento del mandatario
      setCell('C11', formulario.mandatarioNombre    ?? null)
      setCell('F13', formulario.mandatarioDocumento ?? null)

      // ── Tipo de trámite
      setCell('P25', tramite.tipoTramite
        ? (TIPO_TRAMITE_LABEL[tramite.tipoTramite] ?? tramite.tipoTramite)
        : null)

      // ── Datos del vehículo
      setCell('E29', formulario.placa      ?? null)
      setCell('I29', formulario.marca      ?? null)
      setCell('N29', formulario.linea      ?? null)
      setCell('S29', formulario.modelo     ?? null)
      setCell('F31', formulario.cilindrada ?? null)
      setCell('J31', formulario.noMotor    ?? null)
      setCell('P31', formulario.noChasis   ?? null)

      // ── Restaurar anchos del template
      ws.columns.forEach((col, i) => {
        col.width = colWidths[i] ?? col.width ?? 8
      })

      const buffer = await workbook.xlsx.writeBuffer()
      const placa = formulario.placa ?? 'SIN-PLACA'
      const fileName = `MANDATO-${placa}-${tramite.turnoNumero}.xlsx`

      response.header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      response.header('Content-Disposition', `attachment; filename="${fileName}"`)
      return response.send(buffer)
    } catch (error) {
      console.error('Error en exportMandatoExcel:', error)
      return response.internalServerError({ message: 'Error al generar el Excel de mandato' })
    }
  }

  /** GET /tramites/:tramiteId/paquete/export-excel
   *
   * Devuelve runt_mandato_datos.xlsx con la hoja DATOS rellena desde el
   * FormularioRunt + Tramite. Las hojas FORMULARIO, " MANDATO" y COMPRAVENTA
   * se auto-populan vía sus fórmulas =DATOS!... al abrir el archivo en Excel.
   * Excepción: C11 y F13 de " MANDATO" (mandatario) se escriben directamente.
   */
  public async exportPaqueteCompleto({ params, response }: HttpContext) {
    try {
      const tramite = await Tramite.query()
        .where('id', Number(params.tramiteId))
        .preload('formularioRunt')
        .preload('sede')
        .preload('liquidacion')
        .first()

      if (!tramite) return response.notFound({ message: 'Trámite no encontrado' })

      const formulario = tramite.formularioRunt
      if (!formulario) {
        return response.unprocessableEntity({
          message: 'Este trámite no tiene formulario RUNT guardado. Llénalo primero.',
        })
      }

      const workbook = new ExcelJS.Workbook()
      await workbook.xlsx.readFile(app.makePath('storage/runt/runt_mandato_datos.xlsx'))

      // ── Hoja DATOS: escritura directa (sin fórmulas, sin merges) ─────────
      const wsDatos = workbook.getWorksheet('DATOS')
      if (!wsDatos) {
        return response.internalServerError({
          message: 'Hoja DATOS no encontrada en la plantilla maestra',
        })
      }

      const set = (addr: string, value: ExcelJS.CellValue) => {
        wsDatos.getCell(addr).value = value
      }

      // Propietario (vendedor)
      set('B3', formulario.propPrimerApellido  ?? null)
      set('C3', formulario.propSegundoApellido ?? null)
      set('D3', formulario.propNombres         ?? null)
      set('B4', formulario.propNoDocumento     ?? null)
      set('B5', formulario.propTelefono        ?? null)
      set('B6', formulario.propCorreo          ?? null)
      set('B7', formulario.propDireccion       ?? null)
      set('B8', formulario.propCiudad          ?? null)

      // Comprador: solo TRASPASO con incluyeCompraventa activo.
      // El else limpia explícitamente las celdas para no heredar datos
      // residuales del template (que puede tener valores de prueba guardados).
      if (tramite.tipoTramite === 'TRASPASO' && tramite.incluyeCompraventa) {
        set('B11', formulario.compPrimerApellido  ?? null)
        set('C11', formulario.compSegundoApellido ?? null)
        set('D11', formulario.compNombres         ?? null)
        set('B12', formulario.compNoDocumento     ?? null)
        set('B13', formulario.compTelefono        ?? null)
        set('B14', formulario.compCorreo          ?? null)
        set('B15', formulario.compDireccion       ?? null)
        set('B16', formulario.compCiudad          ?? null)
      } else {
        set('B11', null)
        set('C11', null)
        set('D11', null)
        set('B12', null)
        set('B13', null)
        set('B14', null)
        set('B15', null)
        set('B16', null)
      }

      // Vehículo
      set('B19', formulario.placa          ?? null)
      set('C19', formulario.placa?.substring(0, 3)  ?? null)
      set('D19', formulario.placa?.substring(3)     ?? null)
      set('B20', formulario.modelo         ?? null)
      set('B21', formulario.claseVehiculo  ?? null)
      if (formulario.claseVehiculo && CLASE_VEHICULO_DATOS_CELDAS[formulario.claseVehiculo]) {
        set(CLASE_VEHICULO_DATOS_CELDAS[formulario.claseVehiculo], 'X')
      }
      set('B22', formulario.marca          ?? null)
      set('B23', formulario.linea          ?? null)
      set('B24', formulario.color          ?? null)
      set('B25', formulario.puertas        ?? null)
      set('B26', formulario.tipoServicio   ?? null)
      set('B27', formulario.noMotor        ?? null)
      set('B28', formulario.noSerie        ?? null)
      set('B29', formulario.noChasis       ?? null)
      set('B30', formulario.noVin          ?? null)
      set('B31', formulario.cilindrada     ?? null)
      set('B32', formulario.capacidadKg    ?? null)
      set('B33', formulario.potenciaHp     ?? null)
      set('B34', formulario.cilindrada     ?? null)

      // Fecha del contrato: ciudad, día, mes, año
      set('E26', tramite.sede?.nombre      ?? null)
      set('F26', tramite.fecha?.day   ?? null)
      set('G26', tramite.fecha?.month ?? null)
      set('H26', tramite.fecha?.year  ?? null)

      // Valor vehículo, forma de pago, fecha entrega, destrate
      set('B40', tramite.valorVehiculo  ?? null)
      set('B41', tramite.formaPago      ?? null)
      set('B42', tramite.fechaEntrega?.toFormat('dd/MM/yyyy') ?? null)
      set('B44', tramite.destrate       ?? null)

      // Tipo de trámite — alimenta la fórmula =DATOS!B43 en " MANDATO"!P25
      set('B43', tramite.tipoTramite
        ? (TIPO_TRAMITE_LABEL[tramite.tipoTramite] ?? tramite.tipoTramite)
        : null)

      // ── Hoja " MANDATO": mandatario (celdas directas, sin fórmula) ────────
      // El nombre tiene un espacio al inicio: " MANDATO"
      const wsMandato = workbook.getWorksheet(' MANDATO')
      if (wsMandato) {
        const setMandato = (address: string, value: ExcelJS.CellValue) => {
          const cell = wsMandato.getCell(address)
          const target = cell.isMerged ? cell.master : cell
          target.value = value
        }
        setMandato('C11', formulario.mandatarioNombre    ?? null)
        setMandato('F13', formulario.mandatarioDocumento ?? null)
      }

      // ── Hoja "CHECK LIST": liquidación + checkmarks ──────────────────────
      const wsCheck = workbook.getWorksheet('CHECK LIST')
      if (wsCheck) {
        const setK = (addr: string, value: ExcelJS.CellValue) => {
          wsCheck.getCell(addr).value = value
        }
        const x = (v: boolean | null | undefined) => (v ? 'X' : null)

        // Liquidación — columna B (filas 8-16)
        const liq = tramite.liquidacion
        if (liq) {
          setK('B8',  liq.retencion          ?? null)
          setK('B9',  liq.derechosTraspaso   ?? null)
          setK('B10', liq.pazSalvo           ?? null)
          setK('B11', liq.levantamientoPrenda ?? null)
          setK('B12', liq.inscripcionPrenda  ?? null)
          setK('B13', liq.papeleria          ?? null)
          setK('B14', liq.honorarios         ?? null)
          setK('B15', liq.impuestoAnioActual ?? null)
          setK('B16', liq.impuestoAniosVencidos ?? null)
        }

        // Checklist — columna E (filas 8-21, orden = layout del template)
        const cl = await TramiteChecklist.query()
          .where('sede_id', tramite.sedeId)
          .where('fecha', tramite.fecha.toSQLDate()!)
          .where('turno_numero', tramite.turnoNumero)
          .first()

        setK('E8',  x(cl?.tarjetaPropiedad))
        setK('E9',  x(cl?.soat))
        setK('E10', x(cl?.fotocopiaCedula))
        setK('E11', x(cl?.runtVendedor))
        setK('E12', x(cl?.runtComprador))
        setK('E13', x(cl?.antecedentesComprador))
        setK('E14', x(cl?.antecedentesVendedor))
        setK('E15', x(cl?.levantaPrendaOriginal))
        setK('E16', x(cl?.inscribePrendaOriginal))
        setK('E17', x(cl?.camaraComercio))
        setK('E18', x(cl?.certificadoImpuestos))
        setK('E19', x(cl?.declaracionExtrajuicio))
        setK('E20', x(cl?.pazSalvoEmpresa))
        setK('E21', x(cl?.cesionDerechoEmpresa))
      }

      // ── Serializar y enviar el workbook completo ──────────────────────────
      // ExcelJS no puede serializar ciertas reglas de formato condicional del
      // template original (tipo "expression" con dxfId). Se limpian aquí porque
      // son puramente cosméticas y no afectan valores ni fórmulas =DATOS!...
      workbook.worksheets.forEach((ws) => {
        ;(ws as any).conditionalFormattings = []
      })
      // Fuerza recálculo completo de todas las fórmulas =DATOS!... al abrir en Excel
      workbook.calcProperties.fullCalcOnLoad = true
      const buffer = await workbook.xlsx.writeBuffer()
      const placa    = formulario.placa ?? 'SIN-PLACA'
      const fileName = `PAQUETE-${placa}-${tramite.turnoNumero}.xlsx`

      response.header(
        'Content-Type',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
      )
      response.header('Content-Disposition', `attachment; filename="${fileName}"`)
      return response.send(buffer)
    } catch (error) {
      console.error('Error en exportPaqueteCompleto:', error)
      return response.internalServerError({ message: 'Error al generar el paquete Excel' })
    }
  }
}
