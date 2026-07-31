// app/controllers/rep_general_import_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import logger from '@adonisjs/core/services/logger'
import fs from 'node:fs'
import { DateTime } from 'luxon'
import ExcelJS from 'exceljs'
import db from '@adonisjs/lucid/services/db'

import Cliente from '#models/cliente'
import Vehiculo from '#models/vehiculo'
import Conductor from '#models/conductor'
import TurnoRtm from '#models/turno_rtm'
import Comision from '#models/comision'
import { evaluarContinuidad, type EstadoContinuidad } from '#services/continuidad_service'

type TipoVehiculoDB = 'Liviano Particular' | 'Liviano Taxi' | 'Liviano Público' | 'Motocicleta'

interface RecurrenciaResult {
  esRecurrente: boolean
  esRecuperacion: boolean
  mesesDesdeUltimaVisita: number | null
  ultimoTurnoId: number | null
  fechaUltimaVisita: string | null
  estadoContinuidad: EstadoContinuidad | null
}

export default class RepGeneralImportController {
  // ==================== ÍNDICES DE COLUMNAS ====================

  private IDX_PLACA = 10
  private IDX_MARCA = 12
  private IDX_LINEA = 13
  private IDX_MODELO = 14
  private IDX_COLOR = 20
  private IDX_MATRICULA = 16

  private IDX_DUENO_DOC_TIPO = 32
  private IDX_DUENO_DOC_NUM = 33
  private IDX_DUENO_NOMBRE = 34
  private IDX_DUENO_TELEFONO = 38
  private IDX_DUENO_EMAIL = 39

  private IDX_COND_DOC_TIPO = 40
  private IDX_COND_DOC_NUM = 41
  private IDX_COND_NOMBRE = 42
  private IDX_COND_TELEFONO = 46

  private IDX_FECHA = 2
  private IDX_TIPO_SERVICIO = 9

  private MESES_MINIMOS_DEFAULT = 24

  // ==================== MÉTODO PRINCIPAL ====================

  public async import({ request, response }: HttpContext) {
    try {
      const file = request.file('file', {
        size: '50mb',
        extnames: ['csv', 'xlsx'],
      })

      if (!file) {
        return response.badRequest({
          ok: false,
          message: 'No se recibió ningún archivo. Envíe el archivo en el campo "file".',
        })
      }

      if (!file.isValid) {
        return response.badRequest({
          ok: false,
          message: 'El archivo enviado no es válido.',
          errors: file.errors,
        })
      }

      if (!file.tmpPath) {
        return response.status(500).send({
          ok: false,
          message: 'No se pudo acceder al archivo temporal en el servidor.',
        })
      }

      logger.info(
        { fileName: file.clientName, fileExt: file.extname, fileSize: file.size },
        '🚀 Iniciando importación'
      )

      let rows: string[][] = []

      if (file.extname === 'xlsx') {
        logger.info('📊 Parseando archivo Excel...')
        rows = await this.parseExcelToArrays(file.tmpPath)
      } else {
        logger.info('📄 Parseando archivo CSV...')
        const raw = fs.readFileSync(file.tmpPath, 'utf-8')
        rows = this.parseCsvToArrays(raw)
      }

      if (!rows.length) {
        return response.badRequest({
          ok: false,
          message: 'El archivo no contiene datos (0 filas).',
        })
      }

      const esTECNOBASE = this.detectarTipoArchivo(
        file.clientName ?? null,
        file.extname ?? '',
        rows.length
      )

      logger.info(
        {
          totalFilas: rows.length,
          tipoArchivo: esTECNOBASE
            ? 'TECNOBASE (solo histórico)'
            : 'RepGeneral (clasificar + empalme)',
        },
        '✅ Archivo parseado correctamente'
      )

      let funcionarioIdValido: number | null = null
      let sedeIdValido: number | null = null

      if (esTECNOBASE) {
        const usuarioAdmin = await db.from('usuarios').orderBy('id', 'asc').first()
        const sedeDefault = await db.from('sedes').orderBy('id', 'asc').first()

        if (!usuarioAdmin) {
          return response.status(500).send({
            ok: false,
            message: 'No existe ningún usuario en la base de datos.',
          })
        }
        if (!sedeDefault) {
          return response.status(500).send({
            ok: false,
            message: 'No existe ninguna sede en la base de datos.',
          })
        }

        funcionarioIdValido = usuarioAdmin.id
        sedeIdValido = sedeDefault.id
      }

      const configGlobal = await db
        .from('configuracion_recurrencia_global')
        .orderBy('id', 'asc')
        .first()
      const mesesMinimos: number = configGlobal?.meses_minimos ?? this.MESES_MINIMOS_DEFAULT

      let clientesCreados = 0
      let clientesActualizados = 0
      let vehiculosCreados = 0
      let vehiculosActualizados = 0
      let conductoresCreados = 0
      let conductoresActualizados = 0
      let turnosActualizados = 0
      let turnosCreados = 0
      let turnosRecurrentes = 0
      let turnosRecuperacion = 0
      let turnosNuevos = 0
      let errores = 0
      const erroresDetalle: string[] = []

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]

        if (i > 0 && i % 1000 === 0) {
          logger.info(
            {
              progreso: `${i}/${rows.length}`,
              turnosCreados,
              turnosActualizados,
              turnosRecurrentes,
              turnosRecuperacion,
              turnosNuevos,
              errores,
            },
            '⏳ Procesando...'
          )
        }

        try {
          // 1️⃣ Cliente
          const { cliente, creado: cliCreado } = await this.upsertClienteDesdeFila(row)
          if (cliCreado) clientesCreados++
          else if (cliente) clientesActualizados++

          // 2️⃣ Vehículo
          const fechaFilaRaw = esTECNOBASE ? this.normText(row[this.IDX_FECHA]) : null
          const fechaFila = fechaFilaRaw ? this.parsearFecha(fechaFilaRaw) : null

          const { vehiculo, creado: vehCreado } = await this.upsertVehiculoDesdeFila(
            row,
            cliente ?? null,
            fechaFila
          )
          if (vehCreado) vehiculosCreados++
          else if (vehiculo) vehiculosActualizados++

          // 3️⃣ Conductor
          let { conductor, creado: condCreado } = await this.upsertConductorDesdeFila(row)

          if (!conductor && cliente) {
            conductor = await Conductor.query()
              .where('doc_numero', cliente.docNumero ?? '')
              .orWhere('telefono', cliente.telefono ?? '')
              .first()

            if (!conductor) {
              conductor = await Conductor.create({
                nombre: cliente.nombre,
                docTipo: cliente.docTipo,
                docNumero: cliente.docNumero,
                telefono: cliente.telefono || null,
              } as any)
              condCreado = true
            }
          }

          if (condCreado) conductoresCreados++
          else if (conductor) conductoresActualizados++

          // 4️⃣ TECNOBASE vs RepGeneral
          if (esTECNOBASE) {
            const result = await this.crearTurnoHistorico(
              row,
              cliente ?? null,
              vehiculo ?? null,
              conductor ?? null,
              funcionarioIdValido!,
              sedeIdValido!
            )
            turnosCreados += result.creados
            turnosActualizados += result.actualizados
          } else {
            const result = await this.empalmarTurnosDesdeFila(
              row,
              cliente ?? null,
              vehiculo ?? null,
              conductor ?? null,
              mesesMinimos
            )
            turnosActualizados += result.actualizados
            turnosRecurrentes += result.recurrentes
            turnosRecuperacion += result.recuperacion
            turnosNuevos += result.nuevos
          }
        } catch (filaError) {
          errores++
          const msgError = filaError instanceof Error ? filaError.message : String(filaError)
          const placa = this.normalizePlaca(row[this.IDX_PLACA]) ?? 'SIN_PLACA'
          const nombreCliente = this.normText(row[this.IDX_DUENO_NOMBRE]) ?? 'Sin nombre'
          const docCliente = this.normText(row[this.IDX_DUENO_DOC_NUM]) ?? 'Sin cédula'

          let mensajeAmigable: string
          if (msgError.includes("telefono' cannot be null") || msgError.includes('telefono')) {
            mensajeAmigable = `Cliente "${nombreCliente}" (CC: ${docCliente}, placa: ${placa}) no tiene número de teléfono`
          } else if (
            msgError.includes("doc_numero' cannot be null") ||
            msgError.includes('doc_numero')
          ) {
            mensajeAmigable = `Cliente "${nombreCliente}" (placa: ${placa}) no tiene número de documento`
          } else if (msgError.includes('placa')) {
            mensajeAmigable = `Placa "${placa}": ${msgError}`
          } else {
            mensajeAmigable = `Fila ${i + 1} (placa: ${placa}): ${msgError}`
          }

          erroresDetalle.push(mensajeAmigable)
          logger.warn({ error: msgError, fila: i + 1, placa }, '⚠️ Error procesando fila')
        }
      }

      const mensaje = esTECNOBASE
        ? 'Importación TECNOBASE (histórico) finalizada.'
        : 'Importación RepGeneral (clasificación + empalme) finalizada.'

      logger.info(
        {
          clientesCreados,
          vehiculosCreados,
          conductoresCreados,
          turnosCreados,
          turnosActualizados,
          turnosRecurrentes,
          turnosRecuperacion,
          turnosNuevos,
          errores,
        },
        '🎉 Importación finalizada'
      )

      return response.ok({
        ok: true,
        message: mensaje,
        resumen: {
          mesesMinimos: esTECNOBASE ? null : mesesMinimos,
          clientesCreados,
          clientesActualizados,
          vehiculosCreados,
          vehiculosActualizados,
          conductoresCreados,
          conductoresActualizados,
          turnosCreados,
          turnosActualizados,
          turnosRecurrentes,
          turnosRecuperacion,
          turnosNuevos,
          errores,
          erroresDetalle,
          primerError: erroresDetalle[0] ?? null,
        },
      })
    } catch (error) {
      logger.error(error, 'Error importando archivo')
      return response.status(500).send({
        ok: false,
        message: 'Ocurrió un error al procesar el archivo.',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // ==================== DETECCIÓN DE TIPO DE ARCHIVO ====================

  private detectarTipoArchivo(
    nombreArchivo: string | null,
    extension: string | null,
    totalFilas: number
  ): boolean {
    if (nombreArchivo?.toUpperCase().includes('TECNOBASE')) {
      logger.info('✅ Detectado por nombre: TECNOBASE')
      return true
    }
    if (extension === 'xlsx' && totalFilas > 1000) {
      logger.info('✅ Detectado por extensión y tamaño: TECNOBASE')
      return true
    }
    logger.info('✅ Detectado como RepGeneral')
    return false
  }

  // ==================== DETECCIÓN DE RECURRENCIA / RECUPERACIÓN ====================

  private async detectarRecurrencia(
    clienteId: number | null,
    conductorId: number | null,
    fechaActualISO: string,
    mesesMinimos: number,
    turnoActualId: number | null = null,
    captacionDateoIdActual: number | null = null,
    placa: string | null = null
  ): Promise<RecurrenciaResult> {
    const vacio: RecurrenciaResult = {
      esRecurrente: false,
      esRecuperacion: false,
      mesesDesdeUltimaVisita: null,
      ultimoTurnoId: null,
      fechaUltimaVisita: null,
      estadoContinuidad: null,
    }

    let ultimoTurno: TurnoRtm | null = null

    if (clienteId) {
      const q = TurnoRtm.query()
        .where('cliente_id', clienteId)
        .where('estado', 'finalizado')
        .where('fecha', '<', fechaActualISO)
        .orderBy('fecha', 'desc')
      if (turnoActualId) q.whereNot('id', turnoActualId)
      ultimoTurno = await q.first()
    }

    if (!ultimoTurno && conductorId) {
      const q = TurnoRtm.query()
        .where('conductor_id', conductorId)
        .where('estado', 'finalizado')
        .where('fecha', '<', fechaActualISO)
        .orderBy('fecha', 'desc')
      if (turnoActualId) q.whereNot('id', turnoActualId)
      ultimoTurno = await q.first()
    }

    if (!ultimoTurno) return vacio

    let fechaUltimaVisitaISO: string
    if (ultimoTurno.fecha instanceof DateTime) {
      fechaUltimaVisitaISO = ultimoTurno.fecha.toISODate() ?? ''
    } else {
      fechaUltimaVisitaISO = String(ultimoTurno.fecha).substring(0, 10)
    }

    if (!fechaUltimaVisitaISO) return vacio

    const fechaActual = DateTime.fromISO(fechaActualISO, { zone: 'America/Bogota' })
    const fechaAnterior = DateTime.fromISO(fechaUltimaVisitaISO, { zone: 'America/Bogota' })

    if (!fechaActual.isValid || !fechaAnterior.isValid) {
      logger.warn({ fechaActualISO, fechaUltimaVisitaISO }, '⚠️ Fechas inválidas en recurrencia')
      return vacio
    }

    const mesesTranscurridos = Math.floor(fechaActual.diff(fechaAnterior, 'months').months)
    let esRecurrente: boolean
    let esRecuperacion: boolean
    let estadoContinuidad: EstadoContinuidad | null = null

    if (captacionDateoIdActual) {
      const dateoActual = await db
        .from('captacion_dateos')
        .where('id', captacionDateoIdActual)
        .first()
      const asesorConvenioIdActual = dateoActual?.asesor_convenio_id ?? null
      const convenioIdActual = dateoActual?.convenio_id ?? null

      if ((asesorConvenioIdActual || convenioIdActual) && placa) {
        // Continuidad real: revisa TODO el historial de la placa (servicio
        // compartido con turnos_rtms_controller.ts y facturacion_tickets_controller.ts,
        // ver app/services/continuidad_service.ts). Antes esta función solo
        // comparaba contra la última visita — no cumplía "una vez rota, no
        // se recupera" de la especificación de negocio.
        estadoContinuidad = await evaluarContinuidad({
          placa,
          asesorConvenioId: asesorConvenioIdActual,
          convenioId: convenioIdActual,
          excluirTurnoId: turnoActualId,
        })
        esRecurrente = estadoContinuidad === 'ROTA'
        esRecuperacion = false
      } else {
        esRecurrente = mesesTranscurridos < mesesMinimos
        esRecuperacion = mesesTranscurridos >= mesesMinimos
      }
    } else {
      esRecurrente = mesesTranscurridos < mesesMinimos
      esRecuperacion = mesesTranscurridos >= mesesMinimos
    }

    if (esRecurrente) {
      logger.info(
        { clienteId, conductorId, mesesTranscurridos, mesesMinimos },
        '🔄 RECURRENTE detectado'
      )
    } else {
      logger.info(
        { clienteId, conductorId, mesesTranscurridos, mesesMinimos },
        '💛 RECUPERACIÓN detectada'
      )
    }

    return {
      esRecurrente,
      esRecuperacion,
      mesesDesdeUltimaVisita: mesesTranscurridos,
      ultimoTurnoId: ultimoTurno.id,
      fechaUltimaVisita: fechaUltimaVisitaISO,
      estadoContinuidad,
    }
  }

  // ==================== DETECCIÓN DE SERVICIO Y TIPO VEHÍCULO ====================

  private detectarServicioId(row: string[]): {
    servicioId: number | null
    observacion: string | null
  } {
    const tipoServicio = this.normText(row[this.IDX_TIPO_SERVICIO])?.toUpperCase() || ''
    const match = tipoServicio.match(/\(\s*([^)]+)\s*\)/)
    const textoParentesis = match ? match[1].trim() : null

    if (tipoServicio.includes('PREVENTIVA') || tipoServicio.includes('PREVENTIVO')) {
      return { servicioId: 2, observacion: textoParentesis ? `(${textoParentesis})` : null }
    }
    if (
      tipoServicio.includes('ORDINARIO') ||
      tipoServicio.includes('TAXI') ||
      tipoServicio.includes('PUBLICO') ||
      tipoServicio.includes('APRENDIZAJE') ||
      tipoServicio.includes('LEY 769')
    ) {
      return { servicioId: 1, observacion: textoParentesis ? `(${textoParentesis})` : null }
    }

    logger.warn({ tipoServicio }, '⚠️ Tipo de servicio no reconocido, asignando RTM por defecto')
    return { servicioId: 1, observacion: tipoServicio ? `(${tipoServicio})` : null }
  }

  private detectarTipoVehiculo(row: string[]): TipoVehiculoDB {
    const t = this.normText(row[this.IDX_TIPO_SERVICIO])?.toUpperCase() || ''
    if (t.includes('MOTO')) return 'Motocicleta'
    if (t.includes('TAXIMETRO') || t.includes('TAXI')) return 'Liviano Taxi'
    if (t.includes('PUBLICO') || t.includes('SERVICIO PUBLICO')) return 'Liviano Público'
    return 'Liviano Particular'
  }

  /**
   * Detecta el claseVehiculoId según col8 (L1_LIVIANA / L2_MOTOS) o col9 (MOTO / LIVIANO)
   * IDs según seeder: 1=Liviano Particular, 2=Liviano Taxi, 3=Liviano Público, 4=Motocicleta
   */
  private detectarClaseVehiculoId(row: string[]): number {
    const col8 = this.normText(row[8])?.toUpperCase() || ''
    const col9 = this.normText(row[this.IDX_TIPO_SERVICIO])?.toUpperCase() || ''

    // Moto detectada por col8 o col9
    if (col8.includes('L2_MOTO') || col9.includes('MOTO')) return 4

    // Livianos especiales
    if (col9.includes('TAXIMETRO') || col9.includes('TAXI')) return 2
    if (col9.includes('PUBLICO')) return 3

    // Default liviano particular
    return 1
  }

  // ==================== PARSEO DE ARCHIVOS ====================

  private async parseExcelToArrays(filePath: string): Promise<string[][]> {
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.readFile(filePath)

    const worksheet = workbook.worksheets[0]
    const rows: string[][] = []

    worksheet.eachRow((row, rowNumber) => {
      if (rowNumber === 1) return

      const values: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        const idx = colNumber - 1

        if (cell.type === ExcelJS.ValueType.Date && cell.value instanceof Date) {
          const dt = DateTime.fromJSDate(cell.value, { zone: 'America/Bogota' })
          values[idx] = dt.toFormat('dd/MM/yyyy HH:mm:ss')
        } else if (cell.type === ExcelJS.ValueType.Number && typeof cell.value === 'number') {
          values[idx] = Number.isInteger(cell.value)
            ? cell.value.toString()
            : Math.round(cell.value).toString()
        } else {
          values[idx] = cell.value ? String(cell.value).trim() : ''
        }
      })
      rows.push(values)
    })

    return rows
  }

  private parseCsvToArrays(raw: string): string[][] {
    const lines = raw.split(/\r?\n/).filter((l) => l.trim() !== '')
    if (!lines.length) return []

    const firstLine = lines[0]
    const semiCount = (firstLine.match(/;/g) || []).length
    const commaCount = (firstLine.match(/,/g) || []).length
    const sep = semiCount >= commaCount ? ';' : ','

    const rows: string[][] = []
    for (const line of lines) {
      if (!line.trim()) continue
      const parts = line.split(sep)
      if (parts.length && parts[0].charCodeAt(0) === 0xfeff) {
        parts[0] = parts[0].replace(/^\uFEFF/, '')
      }
      rows.push(parts)
    }
    return rows
  }

  private parsearFecha(valor: string): DateTime | null {
    if (!valor) return null
    const formatos = ['dd/MM/yyyy HH:mm:ss', 'dd/MM/yyyy', 'yyyy-MM-dd HH:mm:ss', 'yyyy-MM-dd']
    for (const fmt of formatos) {
      const d = DateTime.fromFormat(valor, fmt, { zone: 'America/Bogota' })
      if (d.isValid) return d
    }
    const iso = DateTime.fromISO(valor, { zone: 'America/Bogota' })
    return iso.isValid ? iso : null
  }

  // ==================== NORMALIZACIÓN ====================

  private normalizePlaca(value: string | undefined | null): string | null {
    if (!value) return null
    return (
      value
        .toUpperCase()
        .replace(/[^A-Z0-9]/g, '')
        .trim() || null
    )
  }

  private normalizeTelefono(value: string | undefined | null): string | null {
    if (!value) return null
    const digits = value.replace(/\D/g, '')
    return digits || null
  }

  private normText(value: string | undefined | null): string | null {
    if (!value) return null
    return value.trim() || null
  }

  private truncateText(value: string | null, maxLength: number): string | null {
    if (!value) return null
    return value.length > maxLength ? value.substring(0, maxLength) : value
  }

  // ==================== UPSERT ENTIDADES ====================

  /**
   * Busca o crea un cliente con prioridad:
   *  1° DOCUMENTO  → más confiable, identifica a la persona sin ambigüedad
   *  2° TELÉFONO   → segundo identificador único
   *  3° EMAIL      → solo si no está en uso por OTRO cliente
   *  4° CREAR NUEVO → email queda null si ya lo tiene otro cliente
   *
   * Esto evita que dos personas que comparten email (ej. David Parra / Hannier)
   * queden fusionadas en el mismo cliente.
   */
  private async upsertClienteDesdeFila(
    row: string[]
  ): Promise<{ cliente: Cliente | null; creado: boolean }> {
    const docTipo = this.normText(row[this.IDX_DUENO_DOC_TIPO])
    const docNumero = this.normText(row[this.IDX_DUENO_DOC_NUM])
    const nombre = this.normText(row[this.IDX_DUENO_NOMBRE])
    const telefono = this.normalizeTelefono(row[this.IDX_DUENO_TELEFONO])
    const emailRaw = this.normText(row[this.IDX_DUENO_EMAIL])?.toLowerCase() || null

    if (!docNumero && !nombre && !telefono && !emailRaw) {
      return { cliente: null, creado: false }
    }

    let cliente: Cliente | null = null

    // ── 1° PRIORIDAD: DOCUMENTO ──────────────────────────────────────────────
    if (docNumero) {
      cliente = await Cliente.query().where('doc_numero', docNumero).first()
    }

    // ── 2° PRIORIDAD: TELÉFONO ───────────────────────────────────────────────
    // ⚠️ Solo usar si el documento coincide O si la persona encontrada no tiene documento.
    // Si el teléfono está en otro cliente con diferente cédula (teléfono falso/compartido),
    // NO se usa — se crea un cliente nuevo para evitar fusionar personas distintas.
    if (!cliente && telefono) {
      const porTelefono = await Cliente.query().where('telefono', telefono).first()
      if (porTelefono) {
        const docCoincide =
          !docNumero || // la fila no trae doc → aceptar
          !porTelefono.docNumero || // el cliente no tiene doc → aceptar
          porTelefono.docNumero === docNumero // los docs coinciden → aceptar
        if (docCoincide) {
          cliente = porTelefono
        } else {
          logger.warn(
            { telefono, docFila: docNumero, docEncontrado: porTelefono.docNumero, nombre },
            '⚠️ Teléfono compartido con otro cliente (cédula diferente), se creará cliente nuevo'
          )
        }
      }
    }

    // ── 3° CREAR CLIENTE NUEVO ───────────────────────────────────────────────
    if (!cliente) {
      // Verificar si el email ya pertenece a alguien más → si es así, no lo asignamos
      let emailFinal: string | null = emailRaw
      if (emailRaw) {
        const emailEnUso = await Cliente.query().whereRaw('LOWER(email) = ?', [emailRaw]).first()
        if (emailEnUso) {
          logger.warn(
            { email: emailRaw, clienteExistente: emailEnUso.id, nombre },
            '⚠️ Email ya pertenece a otro cliente, se crea el nuevo sin email'
          )
          emailFinal = null
        }
      }

      cliente = await Cliente.create({
        docTipo: docTipo || (docNumero ? 'CC' : null),
        docNumero,
        nombre,
        telefono: telefono ?? '',
        email: emailFinal,
      } as any)

      return { cliente, creado: true }
    }

    // ── ACTUALIZAR CAMPOS VACÍOS (sin pisar datos existentes) ────────────────
    let debeGuardar = false

    if (!cliente.docNumero && docNumero) {
      cliente.docNumero = docNumero
      cliente.docTipo = docTipo || 'CC'
      debeGuardar = true
    }
    if (!cliente.nombre && nombre) {
      cliente.nombre = nombre
      debeGuardar = true
    }
    if (!cliente.telefono && telefono) {
      cliente.telefono = telefono
      debeGuardar = true
    }

    // Email: solo asignar si el cliente no tiene uno YA
    // y si el email no está siendo usado por otro cliente distinto
    if (!cliente.email && emailRaw) {
      const emailEnUso = await Cliente.query()
        .whereRaw('LOWER(email) = ?', [emailRaw])
        .whereNot('id', cliente.id)
        .first()

      if (!emailEnUso) {
        cliente.email = emailRaw
        debeGuardar = true
      } else {
        logger.warn(
          { email: emailRaw, clienteConEmail: emailEnUso.id, clienteActual: cliente.id },
          '⚠️ Email ya está en otro cliente, no se asigna'
        )
      }
    }

    if (debeGuardar) await cliente.save()
    return { cliente, creado: false }
  }

  private async upsertVehiculoDesdeFila(
    row: string[],
    cliente: Cliente | null,
    fechaFila: DateTime | null = null
  ): Promise<{ vehiculo: Vehiculo | null; creado: boolean }> {
    const placa = this.normalizePlaca(row[this.IDX_PLACA])
    if (!placa) return { vehiculo: null, creado: false }

    const marca = this.normText(row[this.IDX_MARCA])
    const linea = this.normText(row[this.IDX_LINEA])
    const modeloRaw = this.normText(row[this.IDX_MODELO])
    const color = this.truncateText(this.normText(row[this.IDX_COLOR]), 50)
    const matricula = this.normText(row[this.IDX_MATRICULA])

    let modelo: number | null = null
    if (modeloRaw) {
      const n = Number(modeloRaw)
      modelo = Number.isFinite(n) ? n : null
    }

    let vehiculo = await Vehiculo.query().whereRaw('UPPER(placa) = ?', [placa]).first()

    const claseVehiculoId = this.detectarClaseVehiculoId(row)

    if (!vehiculo) {
      vehiculo = await Vehiculo.create({
        placa,
        marca,
        linea,
        modelo,
        color,
        matricula,
        clienteId: cliente?.id ?? null,
        claseVehiculoId,
      } as any)
      return { vehiculo, creado: true }
    }

    let debeGuardar = false

    // Corregir clase si estaba mal asignada (ej: moto importada como liviano)
    if ((vehiculo as any).claseVehiculoId !== claseVehiculoId) {
      ;(vehiculo as any).claseVehiculoId = claseVehiculoId
      debeGuardar = true
    }

    if (!vehiculo.marca && marca) {
      vehiculo.marca = marca
      debeGuardar = true
    }
    if (!vehiculo.linea && linea) {
      vehiculo.linea = linea
      debeGuardar = true
    }
    if (!vehiculo.modelo && modelo) {
      vehiculo.modelo = modelo
      debeGuardar = true
    }
    if (!vehiculo.color && color) {
      vehiculo.color = color
      debeGuardar = true
    }
    if (!vehiculo.matricula && matricula) {
      vehiculo.matricula = matricula
      debeGuardar = true
    }

    if (cliente?.id) {
      if (!vehiculo.clienteId) {
        vehiculo.clienteId = cliente.id
        debeGuardar = true
      } else if (vehiculo.clienteId !== cliente.id) {
        if (!fechaFila) {
          vehiculo.clienteId = cliente.id
          debeGuardar = true
        } else {
          const ultimoTurnoConDuenoActual = await TurnoRtm.query()
            .where('placa', placa)
            .where('cliente_id', vehiculo.clienteId)
            .orderBy('fecha', 'desc')
            .select('fecha')
            .first()

          if (!ultimoTurnoConDuenoActual) {
            vehiculo.clienteId = cliente.id
            debeGuardar = true
          } else {
            const fechaUltimoTurno =
              ultimoTurnoConDuenoActual.fecha instanceof DateTime
                ? ultimoTurnoConDuenoActual.fecha
                : DateTime.fromISO(String(ultimoTurnoConDuenoActual.fecha), {
                    zone: 'America/Bogota',
                  })

            if (fechaFila > fechaUltimoTurno) {
              vehiculo.clienteId = cliente.id
              debeGuardar = true
            }
          }
        }
      }
    }

    if (debeGuardar) await vehiculo.save()
    return { vehiculo, creado: false }
  }

  private async upsertConductorDesdeFila(
    row: string[]
  ): Promise<{ conductor: Conductor | null; creado: boolean }> {
    const docTipo = this.normText(row[this.IDX_COND_DOC_TIPO])
    const docNumero = this.normText(row[this.IDX_COND_DOC_NUM])
    const nombre = this.normText(row[this.IDX_COND_NOMBRE])
    const telefono = this.normalizeTelefono(row[this.IDX_COND_TELEFONO])

    if (!docNumero && !nombre && !telefono) return { conductor: null, creado: false }

    let conductor: Conductor | null = null

    if (docNumero) conductor = await Conductor.query().where('doc_numero', docNumero).first()
    if (!conductor && telefono)
      conductor = await Conductor.query().where('telefono', telefono).first()

    if (!conductor) {
      conductor = await Conductor.create({
        nombre,
        docTipo: docTipo || (docNumero ? 'CC' : null),
        docNumero,
        telefono: telefono || null,
      } as any)
      return { conductor, creado: true }
    }

    let debeGuardar = false
    if (!conductor.docNumero && docNumero) {
      conductor.docNumero = docNumero
      conductor.docTipo = docTipo || 'CC'
      debeGuardar = true
    }
    if (!conductor.nombre && nombre) {
      conductor.nombre = nombre
      debeGuardar = true
    }
    if (!conductor.telefono && telefono) {
      conductor.telefono = telefono
      debeGuardar = true
    }

    if (debeGuardar) await conductor.save()
    return { conductor, creado: false }
  }

  // ==================== CREAR TURNO HISTÓRICO (TECNOBASE) ====================

  private async crearTurnoHistorico(
    row: string[],
    cliente: Cliente | null,
    vehiculo: Vehiculo | null,
    conductor: Conductor | null,
    funcionarioId: number,
    sedeId: number
  ): Promise<{ creados: number; actualizados: number }> {
    if (!vehiculo?.placa) return { creados: 0, actualizados: 0 }

    const placa = vehiculo.placa
    const fechaRaw = this.normText(row[this.IDX_FECHA])
    const fecha = fechaRaw ? this.parsearFecha(fechaRaw) : null

    if (!fecha?.isValid) {
      logger.warn({ placa, fechaRaw }, '⚠️ Fecha inválida, omitiendo fila')
      return { creados: 0, actualizados: 0 }
    }

    const fechaISO = fecha.toISODate()!
    const { servicioId, observacion } = this.detectarServicioId(row)
    const tipoVehiculo = this.detectarTipoVehiculo(row)

    const clienteIdFinal = cliente?.id ?? vehiculo.clienteId ?? null
    const claseVehiculoIdFinal = (vehiculo as any).claseVehiculoId ?? 1
    const conductorIdFinal = conductor?.id ?? null

    const turnoExistente = await TurnoRtm.query()
      .where('placa', placa)
      .where('fecha', fechaISO)
      .first()

    if (turnoExistente) {
      let changed = false
      if (!turnoExistente.vehiculoId && vehiculo.id) {
        turnoExistente.vehiculoId = vehiculo.id
        changed = true
      }
      if (!turnoExistente.clienteId && clienteIdFinal) {
        turnoExistente.clienteId = clienteIdFinal
        changed = true
      }
      if (!turnoExistente.conductorId && conductorIdFinal) {
        turnoExistente.conductorId = conductorIdFinal
        changed = true
      }
      if (!(turnoExistente as any).claseVehiculoId && claseVehiculoIdFinal) {
        ;(turnoExistente as any).claseVehiculoId = claseVehiculoIdFinal
        changed = true
      }
      if (!turnoExistente.servicioId && servicioId) {
        turnoExistente.servicioId = servicioId
        changed = true
      }

      if (changed) await turnoExistente.save()
      return { creados: 0, actualizados: changed ? 1 : 0 }
    }

    const maxTurnoNumero = await TurnoRtm.query()
      .where('sede_id', sedeId)
      .where('fecha', fechaISO)
      .max('turno_numero as max')
      .pojo<{ max: number }>()
      .first()
    const turnoNumero = (maxTurnoNumero?.max ?? 0) + 1

    const maxTurnoServicio = await TurnoRtm.query()
      .where('sede_id', sedeId)
      .where('fecha', fechaISO)
      .where('servicio_id', servicioId ?? 1)
      .max('turno_numero_servicio as max')
      .pojo<{ max: number }>()
      .first()
    const turnoNumeroServicio = (maxTurnoServicio?.max ?? 0) + 1

    const fechaPart = fecha.toFormat('yyyyMMdd')
    const turnoCodigo = `HIST-${fechaPart}-${sedeId}-${turnoNumero}`

    await TurnoRtm.create({
      fecha: fechaISO,
      horaIngreso: '08:00:00',
      horaSalida: '09:00:00',
      turnoNumero,
      turnoNumeroServicio,
      turnoCodigo,
      placa,
      tipoVehiculo,
      estado: 'finalizado',
      vehiculoId: vehiculo.id,
      clienteId: clienteIdFinal,
      conductorId: conductorIdFinal,
      claseVehiculoId: claseVehiculoIdFinal,
      funcionarioId,
      sedeId,
      servicioId,
      observaciones: ['Importado desde TECNOBASE', observacion].filter(Boolean).join(' '),
      canalAtribucion: 'FACHADA',
      esRecurrente: false,
      esRecuperacion: false,
      mesesDesdeUltimaVisita: null,
      ultimoTurnoId: null,
      fechaUltimaVisita: null,
    } as any)

    return { creados: 1, actualizados: 0 }
  }

  // ==================== EMPALMAR TURNOS (REP GENERAL DIARIO) ====================

  private async empalmarTurnosDesdeFila(
    row: string[],
    cliente: Cliente | null,
    vehiculo: Vehiculo | null,
    conductor: Conductor | null,
    mesesMinimos: number
  ): Promise<{ actualizados: number; recurrentes: number; recuperacion: number; nuevos: number }> {
    if (!vehiculo?.placa) return { actualizados: 0, recurrentes: 0, recuperacion: 0, nuevos: 0 }

    const placa = vehiculo.placa
    const clienteIdFinal = cliente?.id ?? vehiculo.clienteId ?? null
    const claseVehiculoIdFinal = (vehiculo as any).claseVehiculoId ?? null
    const conductorIdFinal = conductor?.id ?? null

    const fechaRaw = this.normText(row[this.IDX_FECHA])
    const fechaParseada = fechaRaw ? this.parsearFecha(fechaRaw) : null
    const fechaCSV = fechaParseada?.isValid ? fechaParseada.toISODate()! : null
    const fechaParaComparar = fechaCSV ?? DateTime.now().toISODate()!

    const rec = await this.detectarRecurrencia(
      clienteIdFinal,
      conductorIdFinal,
      fechaParaComparar,
      mesesMinimos,
      null
    )

    let turnosRecurrentes = rec.esRecurrente ? 1 : 0
    let turnosRecuperacion = rec.esRecuperacion ? 1 : 0
    let turnosNuevos = !rec.esRecurrente && !rec.esRecuperacion ? 1 : 0
    let turnosActualizados = 0

    const turnos = await TurnoRtm.query()
      .where('placa', placa)
      .whereIn('estado', ['activo', 'finalizado'])

    for (const turno of turnos) {
      let changed = false

      // Siempre marcar verificado si la placa está en Rep General
      turno.repGeneralVerificado = true
      changed = true
      if (!turno.vehiculoId && vehiculo.id) {
        turno.vehiculoId = vehiculo.id
        changed = true
      }
      if (!turno.clienteId && clienteIdFinal) {
        turno.clienteId = clienteIdFinal
        changed = true
      }
      if (!(turno as any).claseVehiculoId && claseVehiculoIdFinal) {
        ;(turno as any).claseVehiculoId = claseVehiculoIdFinal
        changed = true
      }
      if (!turno.conductorId && conductorIdFinal) {
        turno.conductorId = conductorIdFinal
        changed = true
      }

      const cambioDeDueno =
        clienteIdFinal !== null && turno.clienteId !== null && clienteIdFinal !== turno.clienteId

      const necesitaClasificar = turno.mesesDesdeUltimaVisita === null || cambioDeDueno

      if (necesitaClasificar) {
        let fechaTurnoISO: string
        if (turno.fecha instanceof DateTime) {
          fechaTurnoISO = turno.fecha.toISODate() ?? fechaParaComparar
        } else {
          fechaTurnoISO = String(turno.fecha).substring(0, 10) || fechaParaComparar
        }

        const recTurno = await this.detectarRecurrencia(
          clienteIdFinal,
          conductorIdFinal ?? turno.conductorId,
          fechaTurnoISO,
          mesesMinimos,
          turno.id,
          turno.captacionDateoId ?? null,
          placa
        )
        turno.esRecurrente = recTurno.esRecurrente
        turno.esRecuperacion = recTurno.esRecuperacion
        turno.mesesDesdeUltimaVisita = recTurno.mesesDesdeUltimaVisita
        turno.ultimoTurnoId = recTurno.ultimoTurnoId
        ;(turno as any).fechaUltimaVisita = recTurno.fechaUltimaVisita
        if (recTurno.estadoContinuidad) turno.estadoContinuidad = recTurno.estadoContinuidad
        changed = true
      }

      if (changed) {
        ;(turno as any).repGeneralVerificado = true
        await turno.save()
        turnosActualizados++

        if (turno.captacionDateoId && turno.mesesDesdeUltimaVisita !== null) {
          const recParaComision: RecurrenciaResult = {
            esRecurrente: turno.esRecurrente,
            esRecuperacion: turno.esRecuperacion,
            mesesDesdeUltimaVisita: turno.mesesDesdeUltimaVisita,
            ultimoTurnoId: turno.ultimoTurnoId,
            fechaUltimaVisita: turno.fechaUltimaVisita
              ? turno.fechaUltimaVisita instanceof DateTime
                ? turno.fechaUltimaVisita.toISODate()
                : String(turno.fechaUltimaVisita).substring(0, 10)
              : null,
            estadoContinuidad: turno.estadoContinuidad ?? null,
          }
          console.log(`   🔄 Recalculando comisión para dateo ${turno.captacionDateoId}`)
          await this.recalcularComisionSiExiste(
            turno.captacionDateoId,
            recParaComision,
            turno.tipoVehiculo
          )
        }
      }
    }

    return {
      actualizados: turnosActualizados,
      recurrentes: turnosRecurrentes,
      recuperacion: turnosRecuperacion,
      nuevos: turnosNuevos,
    }
  }

  // ==================== RECALCULAR COMISIÓN AL SUBIR REP GENERAL ====================

  private async recalcularComisionSiExiste(
    dateoId: number,
    rec: RecurrenciaResult,
    tipoVehiculo: string | null
  ): Promise<void> {
    const comision = await Comision.query()
      .where('captacion_dateo_id', dateoId)
      .where('estado', 'PENDIENTE')
      .where('tipo_servicio', 'RTM')
      .first()

    if (!comision) {
      console.log(`   ⚠️ No hay comisión PENDIENTE para dateo ${dateoId}`)
      return
    }

    const esMoto = tipoVehiculo === 'Motocicleta'
    console.log(`   🚗 tipoVehiculo: ${tipoVehiculo} | esMoto: ${esMoto}`)

    const asesorId = comision.asesorId
    const configGlobal = await db
      .from('configuracion_recurrencia_global')
      .orderBy('id', 'asc')
      .first()

    let valorRecurrente: number

    if (esMoto) {
      valorRecurrente = Number(
        configGlobal?.valor_dateo_recurrencia_moto ?? configGlobal?.valor_dateo_recurrencia ?? 4300
      )
    } else {
      valorRecurrente = Number(
        configGlobal?.valor_dateo_recurrencia_vehiculo ??
          configGlobal?.valor_dateo_recurrencia ??
          4300
      )
    }

    if (asesorId) {
      const asesorCfg = await db
        .from('configuracion_recurrencia_asesores')
        .where('asesor_id', asesorId)
        .where('recurrencia_habilitada', true)
        .first()

      if (asesorCfg) {
        if (esMoto) {
          if (asesorCfg.valor_dateo_recurrencia_moto)
            valorRecurrente = Number(asesorCfg.valor_dateo_recurrencia_moto)
          else if (asesorCfg.valor_dateo_recurrencia)
            valorRecurrente = Number(asesorCfg.valor_dateo_recurrencia)
        } else {
          if (asesorCfg.valor_dateo_recurrencia)
            valorRecurrente = Number(asesorCfg.valor_dateo_recurrencia)
        }
      }
    }

    // Actualizar flags en el turno
    const turnoParaActualizar = await TurnoRtm.query().where('captacion_dateo_id', dateoId).first()

    if (turnoParaActualizar) {
      turnoParaActualizar.esRecurrente = rec.esRecurrente
      turnoParaActualizar.esRecuperacion = rec.esRecuperacion
      await turnoParaActualizar.save()
      console.log(
        `   🔄 Turno #${turnoParaActualizar.id} → esRecurrente: ${rec.esRecurrente} | esRecuperacion: ${rec.esRecuperacion}`
      )
    }

    const tieneConvenio = !!comision.convenioId
    const esComercialConConvenio = tieneConvenio && !!comision.asesorSecundarioId

    if (rec.esRecurrente || rec.esRecuperacion) {
      // Recuperación es solo una categoría informativa/de reporte — nunca
      // paga distinto de recurrente, ni para el comercial ni para el
      // asesor convenio.
      const valorAsesor = valorRecurrente
      const etiqueta = rec.esRecurrente
        ? `🔄 RECURRENTE ${esMoto ? '🏍️ MOTO' : '🚗 VEHICULO'}`
        : `💛 RECUPERACIÓN ${esMoto ? '🏍️ MOTO' : '🚗 VEHICULO'}`

      if (!tieneConvenio) {
        // CASO 1: Sin convenio — solo actualizar monto del asesor
        comision.monto = String(valorAsesor)
        comision.montoAsesor = String(valorAsesor)
        console.log(
          `   ${etiqueta} Comisión #${comision.id} | Sin convenio → asesor $${valorAsesor}`
        )
      } else if (esComercialConConvenio) {
        // CASO 3: Comercial + convenio
        // montoAsesor = valorDateoNuevo (mismo para nuevo/recurrente/recuperacion)
        // montoConvenio = valorIncentivoPorTipo (mismo para todos los casos)
        // No se modifica nada — los montos ya son correctos
        console.log(
          `   ${etiqueta} Comisión #${comision.id} | Comercial+convenio → sin cambios (dateo $${comision.montoAsesor ?? 0} + incentivo $${comision.montoConvenio ?? 0})`
        )
      } else {
        // CASO 2: Convenio datea él mismo
        // montoConvenio siempre es $0, solo actualizar montoAsesor
        comision.monto = String(valorAsesor)
        comision.montoAsesor = String(valorAsesor)
        console.log(
          `   ${etiqueta} Comisión #${comision.id} | Convenio datea → asesor $${valorAsesor} | convenio $0`
        )
      }
    }

    await comision.save()
    console.log(`   ✅ Comisión #${comision.id} actualizada correctamente`)
  }
}
