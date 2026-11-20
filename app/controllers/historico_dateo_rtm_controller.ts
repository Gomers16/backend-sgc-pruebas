// app/controllers/historico_dateo_rtm_controller.ts
//
// RUTAS (en start/routes.ts):
//   router.post('/historico-rtm/preview',  [HistoricoDateoRtmController, 'preview'])
//   router.post('/historico-rtm/importar', [HistoricoDateoRtmController, 'importar'])
//
// BODY (multipart):
//   archivo        File (.xlsx)
//   dry_run        'true' | 'false'   (default: false)
//   hojas          'MAR2025,ABR2025'  (vacío = todas)

import type { HttpContext } from '@adonisjs/core/http'
import ExcelJS from 'exceljs'
import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'

import Cliente from '#models/cliente'
import CaptacionDateo from '#models/captacion_dateo'
import TurnoRtm from '#models/turno_rtm'
import AgenteCaptacion from '#models/agente_captacion'
import Servicio from '#models/servicio'
import { aplicarSede, sedeParaEscritura } from '#services/sede_scope'

// ─── Mapa TITULAR → nombre canónico ──────────────────────────────

const TITULAR_CANON: Record<string, string> = {
  'ESTEFANIA CARDONA': 'ESTEFANIA CARDONA',
  'ESTANIA CARDONA': 'ESTEFANIA CARDONA',
  'ESTEFANI CARDONA': 'ESTEFANIA CARDONA',
  'ESTEFANIS CARDONA': 'ESTEFANIA CARDONA',
  'ESTEFANUA CARDONA': 'ESTEFANIA CARDONA',
  'ESTEFANIA CARDO': 'ESTEFANIA CARDONA',
  'ESTEFANIA CARDOMA': 'ESTEFANIA CARDONA',
  'ESTEFANIA CARDONDA': 'ESTEFANIA CARDONA',
  'ESTEFANIA CARONA': 'ESTEFANIA CARDONA',
  'ESTEFANIA CARDONAA': 'ESTEFANIA CARDONA',
  'ESTEFANIA CARDONA PREVENTIVA': 'ESTEFANIA CARDONA',
  'ESTEFANIA CARDONA X LLAMADA': 'ESTEFANIA CARDONA',
  'ESTEFANIA CARDONA POR LLAMADA': 'ESTEFANIA CARDONA',
  'ESTEFANIA CARDONA CORRIJO PLACA': 'ESTEFANIA CARDONA',
  'ESTEFA': 'ESTEFANIA CARDONA',

  'ANDRES PAEZ': 'ANDRES PAEZ',
  'ANDRÉS PAEZ': 'ANDRES PAEZ',
  'ANDRÉS PÁEZ': 'ANDRES PAEZ',
  'ANDRES PÁEZ': 'ANDRES PAEZ',
  'QNDRES PAEZ': 'ANDRES PAEZ',
  'ANDRES CDA': 'ANDRES PAEZ',
  'ANDRES PAEZ CDA': 'ANDRES PAEZ',

  'DAGOBERTO SAENZ BENITEZ': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO SÁENZ BENÍTEZ': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO SÁENZ BENITEZ': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO SAENZ BENÍTEZ': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO SÁENZ': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO SÁEN': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO SÁENZ B': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO SÁENZ BENÍT': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO SUAREZ': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO TALLER  SUAREZ': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO BRAYAN VALDÉS': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBER SÁENZ BENÍTEZ': 'DAGOBERTO SAENZ BENITEZ',
  'DAGOBERTO SAENZ': 'DAGOBERTO SAENZ BENITEZ',

  'KAREN PARRA': 'KAREN PARRA',
  'KAREN  PARRA': 'KAREN PARRA',
  'KEREN PARRA': 'KAREN PARRA',
  'PREVENTIVA KAREN PARRA': 'KAREN PARRA',

  'LAURA HERNANDEZ': 'LAURA HERNANDEZ',
  'LAURA HERNÁNDEZ': 'LAURA HERNANDEZ',

  'CAROLINA BERNAL': 'CAROLINA BERNAL',
  'CAROLINA  BERNAL': 'CAROLINA BERNAL',

  'ALEJANDRO ESTACIO': 'ALEJANDRO ESTACIO',
  'ALEJANDRO ESTACIÓN': 'ALEJANDRO ESTACIO',

  'SEBASTIAN MORA': 'SEBASTIAN MORA',

  'MANUEL HERNANDEZ': 'MANUEL HERNANDEZ',
  'MANUEL HERNÁNDEZ': 'MANUEL HERNANDEZ',

  'DAVID ESTIVEN GARCIA': 'DAVID ESTIVEN GARCIA',
  'DAVID ESTIVEN GARCÍA': 'DAVID ESTIVEN GARCIA',
  'DAVID ESTIVEN GSRCIA': 'DAVID ESTIVEN GARCIA',

  'KATHERIN MENESES': 'KATHERIN MENESES',
  'CATHERIN MENESES': 'KATHERIN MENESES',

  'LIZETH CALDERON': 'LIZETH CALDERON',
  'LIZETH CALDERÓN': 'LIZETH CALDERON',

  'NICOL RODRÍGUEZ': 'NICOL RODRIGUEZ',
  'NIKOL RODRÍGUEZ': 'NICOL RODRIGUEZ',

  'MELISA RAMIREZ': 'MELISA RAMIREZ',
  'LAURA BONILLA': 'LAURA BONILLA',
  'ERIKA USECHE': 'ERIKA USECHE',
  'LEONELA BELTRAN': 'LEONELA BELTRAN',
  'LEONELA BELTRÁN': 'LEONELA BELTRAN',
  'RUBEN DARIO ECHEVERRY': 'RUBEN DARIO ECHEVERRY',
  'WILDER EFREN': 'WILDER EFREN',
  'WILDER EFRÉN': 'WILDER EFREN',
  'BRAYAN GARCIA': 'BRAYAN GARCIA',
}

// ─── Mapa tipo vehículo Excel → BD ──────────────────────────────

const TIPO_VEHICULO_MAP: Record<string, string> = {
  'LIVIANO ORDINARIO': 'Liviano Particular',
  'LIVIANO + VH SERVICIO PUBLICO': 'Liviano Público',
  'LIVIANO + TAXIMETRO': 'Liviano Taxi',
  'MOTO ORDINARIO': 'Motocicleta',
}

// ─── Helpers ─────────────────────────────────────────────────────

function cellStr(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'string') return v.trim() || null
  if (typeof v === 'number') return String(v)
  if (v instanceof Date) return v.toISOString()
  if (typeof v === 'object' && 'text' in v)
    return String((v as { text: unknown }).text).trim() || null
  return null
}

function cellDate(v: ExcelJS.CellValue): DateTime | null {
  if (!v) return null
  if (v instanceof Date) return DateTime.fromJSDate(v).setZone('America/Bogota')
  if (typeof v === 'string') {
    const d = DateTime.fromISO(v, { zone: 'America/Bogota' })
    if (d.isValid) return d
  }
  return null
}

function cellTime(v: ExcelJS.CellValue): string {
  if (!v) return '08:00:00'
  if (v instanceof Date) return DateTime.fromJSDate(v).toFormat('HH:mm:ss')
  const s = String(v).trim()
  const m = s.match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/)
  if (m) return `${m[1].padStart(2, '0')}:${m[2]}:${m[3] ?? '00'}`
  return '08:00:00'
}

function normalizePlaca(v: unknown): string | null {
  if (!v) return null
  const s = String(v)
    .replace(/[\s\-]/g, '')
    .toUpperCase()
    .trim()
  return s.length >= 5 && s.length <= 7 ? s : null
}

function normalizePhone(v: unknown): string | null {
  if (!v) return null
  const s = String(v).replace(/\D/g, '')
  return s.length >= 7 ? s : null
}

function normalizeCedula(v: unknown): string | null {
  if (!v) return null
  const s = String(v).replace(/\D/g, '').trim()
  return s.length >= 5 ? s : null
}

function normalizarTitular(raw: string | null): string | null {
  if (!raw) return null

  let s = raw
    .trim()
    .toUpperCase()
    .replace(/\s+/g, ' ')
    .replace(
      /\s+(ME LLAM|YA VIENE|YA VA|SE VENCE|SE LE|SE DIRIGE|VA A HACER|PARA INICI|SERÁ|ESTÁ EN|ES LA|ES UN|ES CLIENT|ES AMIG|LA TRAE|LA LLEV|LLEGA EN|YO MISMO|VIENE DE|VIENE EN|PAGARÁ|SOLICITA|DEMORA|ENVIÓ|ESTABA|ESTOY|TENGO|BIMENSUAL|\(SE EDITÓ|<SE EDITÓ|CORRIJO|ADJUNTO|AVANCE|POR LLAMA|X LLAMA|PREVENTIVA|PARA SOLICI|ME INDICA|ME LLAMÓ|ME HABÍA|ME LA|SEÑOR|CLIENTE ANT|CLIENTE MÍO|TODOS LOS|LA ESPOSA|EL CARRO|EL TAXI|EL DUEÑO|ES UNA|ES UNE|CLIEN).*/,
      ''
    )
    .trim()

  if (TITULAR_CANON[s]) return TITULAR_CANON[s]

  const prefix = s.substring(0, 15)
  for (const [key, val] of Object.entries(TITULAR_CANON)) {
    if (key.startsWith(prefix) || prefix.startsWith(key.substring(0, 12))) {
      return val
    }
  }

  return s.length >= 4 ? s : null
}

function esSucia(v: unknown): boolean {
  if (!v) return false
  const s = String(v).trim()
  return s.startsWith('=') || s === '#N/A' || s === '#REF!' || s === '#VALUE!'
}

function detectarColumnas(headerRow: unknown[]): Record<string, number> {
  const cols: Record<string, number> = {}
  let lastEstado = -1
  let lastValor = -1

  headerRow.forEach((v, i) => {
    if (!v) return
    const s = String(v).trim().toUpperCase()

    if (s === 'PLACA' || s === '-') cols['placa'] = i
    if (
      s.startsWith('FECHA') &&
      !s.includes('REPORTE') &&
      !s.includes('WHATSAPP') &&
      !cols['fecha']
    )
      cols['fecha'] = i
    if (s === 'HORA' && !cols['hora']) cols['hora'] = i
    if (s === 'ESTADO' && i < 6) cols['estado_rtm'] = i
    if (s === 'TIPO' && !cols['tipo']) cols['tipo'] = i
    if ((s === 'TITULAR' || s === 'TITULAR ') && !cols['titular']) cols['titular'] = i
    if (s.includes('CEDULA PROPIETARIO') && !cols['cedula_prop']) cols['cedula_prop'] = i
    if (s.includes('NOMBRE PROPIETARIO') && !cols['nombre_prop']) cols['nombre_prop'] = i
    if ((s === 'CEL.' || s === 'CEL') && !cols['celular']) cols['celular'] = i
    if (s === 'ESTADO PLACA' || (s === 'ESTADO' && i > 10)) lastEstado = i
    if (s === 'VALOR A PAGAR' && i > 10) lastValor = i
  })

  if (cols['celular'] === undefined) {
    headerRow.forEach((v, i) => {
      if (v && String(v).trim().toUpperCase() === 'CELULAR') cols['celular'] = i
    })
  }

  if (lastEstado >= 0) cols['estado_com'] = lastEstado
  if (lastValor >= 0) cols['valor'] = lastValor

  return cols
}

// ─── Cache ───────────────────────────────────────────────────────

interface Cache {
  agentes: Map<string, number>
  convenios: Map<string, number>
  clientes: Map<string, number>
  servicioRtmId: number | null
  funcionarioIdDefault: number | null
}

async function buildCache(): Promise<Cache> {
  const cache: Cache = {
    agentes: new Map(),
    convenios: new Map(),
    clientes: new Map(),
    servicioRtmId: null,
    funcionarioIdDefault: null,
  }

  const agentes = await AgenteCaptacion.query()
    .whereIn('tipo', ['ASESOR_CONVENIO', 'ASESOR_COMERCIAL'])
    .select(['id', 'nombre'])
  for (const a of agentes) {
    cache.agentes.set(a.nombre.trim().toUpperCase(), a.id)
  }

  // Multi-sede: solo convenios de la sede activa (los agentes ya los filtra el mixin).
  const convenios = await aplicarSede(Database.from('convenios'), 'sede_id').select([
    'id',
    'nombre',
  ])
  for (const c of convenios as Array<{ id: number; nombre: string }>) {
    cache.convenios.set(String(c.nombre).trim().toUpperCase(), Number(c.id))
  }

  const clientes = await Database.from('clientes')
    .whereNotNull('doc_numero')
    .select(['id', 'doc_numero'])
  for (const c of clientes as Array<{ id: number; doc_numero: string }>) {
    if (c.doc_numero) cache.clientes.set(String(c.doc_numero).trim(), Number(c.id))
  }

  const svc = await Servicio.query().where('codigo_servicio', 'RTM').first()
  cache.servicioRtmId = svc?.id ?? null

  // Multi-sede: funcionario = primer usuario de la sede activa (Ibagué: el mismo de antes).
  const adminRow = await aplicarSede(Database.from('usuarios'), 'sede_id')
    .select('id')
    .orderBy('id', 'asc')
    .first()
  cache.funcionarioIdDefault = (adminRow as { id: number } | null)?.id ?? 1

  return cache
}

// ─── Tipo interno ─────────────────────────────────────────────────

interface FilaParsed {
  hoja: string
  rowNum: number
  placa: string
  fecha: DateTime
  hora: string
  tipoVehiculo: string
  titularRaw: string | null
  titularNorm: string | null
  reportaRaw: string | null
  esRecurrente: boolean
  valor: number
  cedulaProp: string | null
  nombreProp: string | null
  celular: string | null
}

// ─── Controlador ─────────────────────────────────────────────────

export default class HistoricoDateoRtmController {
  /**
   * POST /historico-rtm/preview
   * Lee el Excel y devuelve estadísticas sin guardar nada.
   */
  public async preview({ request, response }: HttpContext) {
    const { filas, erroresParseo } = await this.leerExcel(request)

    const porHoja: Record<
      string,
      { total: number; aprobado: number; dateo: number; sinAsesor: number }
    > = {}

    for (const f of filas) {
      if (!porHoja[f.hoja]) porHoja[f.hoja] = { total: 0, aprobado: 0, dateo: 0, sinAsesor: 0 }
      porHoja[f.hoja].total++
      if (f.esRecurrente) porHoja[f.hoja].dateo++
      else porHoja[f.hoja].aprobado++
      if (!f.titularNorm) porHoja[f.hoja].sinAsesor++
    }

    return response.ok({
      total_filas: filas.length,
      errores_parseo: erroresParseo.length,
      por_hoja: porHoja,
      muestra: filas.slice(0, 5).map((f) => ({
        hoja: f.hoja,
        fila: f.rowNum,
        placa: f.placa,
        titular: f.titularNorm,
        cedula_prop: f.cedulaProp,
        es_recurrente: f.esRecurrente,
        valor: f.valor,
      })),
    })
  }

  /**
   * POST /historico-rtm/importar
   * Importa el histórico a la BD.
   */
  public async importar({ request, response }: HttpContext) {
    const dryRun = String(request.input('dry_run', 'false')) === 'true'
    const hojasFilter = String(request.input('hojas', '') || '')
      .split(',')
      .map((s) => s.trim().toUpperCase())
      .filter(Boolean)

    // Multi-sede: el histórico se importa en la sede activa ("todas" → 400);
    // turnos y dateos los crea el mixin en esa sede.
    const sedeImport = sedeParaEscritura()

    const { filas, erroresParseo } = await this.leerExcel(request, hojasFilter)

    if (!filas.length) {
      return response.badRequest({ message: 'No se encontraron filas válidas en el archivo' })
    }

    const cache = await buildCache()

    if (!cache.servicioRtmId) {
      return response.badRequest({
        message: 'No existe un servicio con codigo_servicio = "RTM" en la BD.',
      })
    }

    // ── Cargar duplicados existentes (placa + fecha) ──────────────
    // sede: duplicados (placa + fecha) solo dentro de la sede donde se importa
    const existentes = await Database.from('turnos_rtms')
      .where('sede_id', sedeImport ?? 0)
      .where('servicio_id', cache.servicioRtmId)
      .select(['placa', 'fecha'])

    const dupSet = new Set<string>(
      (existentes as Array<{ placa: string; fecha: Date | string }>).map((r) => {
        const fecha =
          r.fecha instanceof Date
            ? r.fecha.toISOString().substring(0, 10)
            : String(r.fecha).substring(0, 10)
        return `${String(r.placa).toUpperCase()}|${fecha}`
      })
    )

    // ── Contadores ────────────────────────────────────────────────
    let creados = 0
    let skippedDuplicado = 0
    let skippedSinAsesor = 0
    let errores = 0
    const erroresDetalle: Array<{ hoja: string; fila: number; placa: string; motivo: string }> = []

    // Números negativos para no colisionar con la constraint uq_turno_por_dia_y_sede
    // Los turnos reales siempre son positivos
    let contadorHistorico = -1

    for (const fila of filas) {
      // ── Skip duplicado ──
      const dupeKey = `${fila.placa}|${fila.fecha.toISODate()}`
      if (dupSet.has(dupeKey)) {
        skippedDuplicado++
        continue
      }

      // ── Resolver Agente y Convenio ──
      const agenteId = fila.titularNorm ? this.resolverAgenteId(fila.titularNorm, cache) : null
      const convenioId = fila.titularNorm ? this.resolverConvenioId(fila.titularNorm, cache) : null

      if (!agenteId || !convenioId) {
        skippedSinAsesor++
        erroresDetalle.push({
          hoja: fila.hoja,
          fila: fila.rowNum,
          placa: fila.placa,
          motivo: `Agente/Convenio no encontrado: "${fila.titularNorm ?? fila.titularRaw}"`,
        })
        continue
      }

      if (dryRun) {
        creados++
        dupSet.add(dupeKey)
        continue
      }

      const trx = await Database.transaction()
      try {
        // ── Paso 1: Resolver / crear Cliente ──────────────────────
        let clienteId: number | null = null
        if (fila.cedulaProp) {
          clienteId = cache.clientes.get(fila.cedulaProp) ?? null

          if (!clienteId) {
            const nuevoCliente = await Cliente.create(
              {
                nombre: fila.nombreProp ?? null,
                docTipo: 'CC',
                docNumero: fila.cedulaProp,
                telefono: fila.celular ?? fila.cedulaProp,
              } as any,
              { client: trx }
            )
            clienteId = nuevoCliente.id
            cache.clientes.set(fila.cedulaProp, clienteId)
          }
        }

        // ── Paso 2: Crear captacion_dateo ─────────────────────────
        const dateo = await CaptacionDateo.create(
          {
            canal: 'ASESOR_CONVENIO',
            agenteId,
            convenioId,
            asesorConvenioId: agenteId,
            placa: fila.placa,
            telefono: fila.celular,
            origen: 'IMPORT',
            resultado: 'EXITOSO',
            liberado: true,
            consumidoAt: fila.fecha,
            observacion: `[HISTÓRICO ${fila.hoja}] ${fila.esRecurrente ? 'Recurrente' : 'Continuidad'} $${fila.valor} | Reporta: ${fila.reportaRaw ?? '-'}`,
          } as any,
          { client: trx }
        )

        // ── Sobrescribir created_at/updated_at con la fecha del Excel ──
        const fechaSql: string = fila.fecha
          .setZone('America/Bogota')
          .toFormat('yyyy-MM-dd HH:mm:ss')
        const dateoId: number = Number(dateo.id)
        await trx.rawQuery(
          'UPDATE captacion_dateos SET created_at = ?, updated_at = ? WHERE id = ?',
          [fechaSql, fechaSql, dateoId]
        )

        // ── Paso 3: Crear turno_rtm ───────────────────────────────
        const turno = await TurnoRtm.create(
          {
            funcionarioId: cache.funcionarioIdDefault ?? 1,
            sedeId: sedeImport,
            servicioId: cache.servicioRtmId!,
            placa: fila.placa,
            fecha: fila.fecha,
            horaIngreso: fila.hora,
            horaSalida: null,
            tiempoServicio: null,
            estado: 'finalizado',
            tipoVehiculo: fila.tipoVehiculo as any,
            clienteId,
            agenteCaptacionId: agenteId,
            captacionDateoId: dateo.id,
            canalAtribucion: 'ASESOR',
            medioEntero: 'Asesor Comercial',
            turnoNumero: contadorHistorico,
            turnoNumeroServicio: contadorHistorico,
            turnoCodigo: `HIST-${fila.hoja}-${fila.rowNum}`,
            tieneFacturacion: true,
            esRecurrente: fila.esRecurrente,
            esRecuperacion: false,
            esAvance: false,
            observaciones: `[HISTÓRICO ${fila.hoja}]`,
          } as any,
          { client: trx }
        )

        // ── Sobrescribir created_at/updated_at con la fecha del Excel ──
        const turnoId: number = Number(turno.id)
        await trx.rawQuery('UPDATE turnos_rtms SET created_at = ?, updated_at = ? WHERE id = ?', [
          fechaSql,
          fechaSql,
          turnoId,
        ])

        // ── Paso 4: Enlazar dateo → turno ─────────────────────────
        // sede: por id del dateo recién creado en la sede activa
        await CaptacionDateo.query({ client: trx })
          .where('id', dateo.id)
          .update({ consumido_turno_id: turno.id } as any)

        await trx.commit()

        dupSet.add(dupeKey)
        creados++
        contadorHistorico--
      } catch (err: unknown) {
        await trx.rollback()
        errores++
        if (erroresDetalle.length < 50) {
          erroresDetalle.push({
            hoja: fila.hoja,
            fila: fila.rowNum,
            placa: fila.placa,
            motivo: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }

    return response.ok({
      dry_run: dryRun,
      resumen: {
        total_filas: filas.length,
        creados,
        skipped_duplicado: skippedDuplicado,
        skipped_sin_asesor: skippedSinAsesor,
        errores_proceso: errores,
        errores_parseo: erroresParseo.length,
      },
      errores_detalle: erroresDetalle,
    })
  }

  // ─── Helpers privados ─────────────────────────────────────────

  private async leerExcel(
    request: HttpContext['request'],
    hojasFilter: string[] = []
  ): Promise<{ filas: FilaParsed[]; erroresParseo: string[] }> {
    const file = request.file('archivo', { extnames: ['xlsx', 'xls'] })
    if (!file || !file.isValid) {
      return { filas: [], erroresParseo: ['Archivo Excel inválido o no enviado'] }
    }

    const wb = new ExcelJS.Workbook()
    await wb.xlsx.readFile(file.tmpPath!)

    const filas: FilaParsed[] = []
    const erroresParseo: string[] = []

    for (const ws of wb.worksheets) {
      const hojaNombre = ws.name.trim().toUpperCase()
      if (hojasFilter.length && !hojasFilter.includes(hojaNombre)) continue

      const rowsRaw: unknown[][] = []
      ws.eachRow({ includeEmpty: false }, (row) => {
        rowsRaw.push(row.values as unknown[])
      })

      // ExcelJS indexa desde 1 → slice(1) para base 0
      const rows = rowsRaw.map((r) => (r as unknown[]).slice(1))

      // Detectar fila header
      let headerIdx = 0
      for (let i = 0; i < Math.min(3, rows.length); i++) {
        const c0 = cellStr(rows[i][0] as ExcelJS.CellValue)
          ?.toUpperCase()
          .trim()
        if (c0 === 'PLACA' || c0 === '-') {
          headerIdx = i
          break
        }
      }

      const header = rows[headerIdx]
      if (!header) continue

      const cols = detectarColumnas(header)

      if (cols['placa'] === undefined || cols['fecha'] === undefined) {
        erroresParseo.push(`Hoja ${ws.name}: no se encontraron columnas PLACA/FECHA`)
        continue
      }

      for (let i = headerIdx + 1; i < rows.length; i++) {
        const row = rows[i]
        const rowNum = i + 1

        // Placa
        const placaRaw = row[cols['placa']] as ExcelJS.CellValue
        if (esSucia(placaRaw)) continue
        const placa = normalizePlaca(placaRaw)
        if (!placa) continue

        // Fecha
        const fechaRaw = row[cols['fecha']] as ExcelJS.CellValue
        const fecha = cellDate(fechaRaw)
        if (!fecha || !fecha.isValid) continue

        // Hora
        const hora = cellTime(row[cols['hora']] as ExcelJS.CellValue)

        // Tipo vehículo
        const tipoRaw =
          cellStr(row[cols['tipo']] as ExcelJS.CellValue)
            ?.toUpperCase()
            .trim() ?? ''
        const tipoVehiculo = TIPO_VEHICULO_MAP[tipoRaw] ?? 'Liviano Particular'

        // Titular
        const titularRaw = cellStr(row[cols['titular']] as ExcelJS.CellValue)
        if (!titularRaw || esSucia(titularRaw)) continue
        const titularNorm = normalizarTitular(titularRaw)

        // REPORTA (solo observación)
        const reportaRaw =
          cols['reporta'] !== undefined ? cellStr(row[cols['reporta']] as ExcelJS.CellValue) : null

        // es_recurrente: DATEO=$4000 → true | APROBADO=$15000 → false
        let esRecurrente = false
        if (cols['estado_com'] !== undefined) {
          const estadoCom = cellStr(row[cols['estado_com']] as ExcelJS.CellValue)
            ?.toUpperCase()
            .trim()
          esRecurrente = estadoCom === 'DATEO'
        } else if (cols['valor'] !== undefined) {
          const valor = Number(cellStr(row[cols['valor']] as ExcelJS.CellValue) ?? '0')
          esRecurrente = valor <= 4000
        }

        // Valor
        let valor = 0
        if (cols['valor'] !== undefined) {
          const vRaw = row[cols['valor']]
          if (typeof vRaw === 'number') valor = vRaw
          else if (typeof vRaw === 'string' && !vRaw.startsWith('=')) {
            valor = Number(vRaw.replace(/[^\d]/g, '')) || 0
          }
        }

        // Cédula propietario
        const cedulaProp =
          cols['cedula_prop'] !== undefined ? normalizeCedula(row[cols['cedula_prop']]) : null

        // Nombre propietario
        const nombreProp =
          cols['nombre_prop'] !== undefined
            ? cellStr(row[cols['nombre_prop']] as ExcelJS.CellValue)
            : null

        // Celular
        const celular = cols['celular'] !== undefined ? normalizePhone(row[cols['celular']]) : null

        filas.push({
          hoja: ws.name,
          rowNum,
          placa,
          fecha,
          hora,
          tipoVehiculo,
          titularRaw,
          titularNorm,
          reportaRaw,
          esRecurrente,
          valor,
          cedulaProp,
          nombreProp,
          celular,
        })
      } // fin for filas
    } // fin for worksheets

    return { filas, erroresParseo }
  } // fin leerExcel

  // ─── Resolver Agente ─────────────────────────────────────────

  private resolverAgenteId(titularNorm: string, cache: Cache): number | null {
    // Buscar exacto primero
    const exacto = cache.agentes.get(titularNorm.toUpperCase())
    if (exacto) return exacto

    // Buscar parcial (por si el nombre en BD tiene variación menor)
    for (const [nombre, id] of cache.agentes.entries()) {
      if (
        nombre.includes(titularNorm.toUpperCase()) ||
        titularNorm.toUpperCase().includes(nombre)
      ) {
        return id
      }
    }

    return null
  }

  // ─── Resolver Convenio ───────────────────────────────────────

  private resolverConvenioId(titularNorm: string, cache: Cache): number | null {
    // Buscar exacto primero
    const exacto = cache.convenios.get(titularNorm.toUpperCase())
    if (exacto) return exacto

    // Buscar parcial
    for (const [nombre, id] of cache.convenios.entries()) {
      if (
        nombre.includes(titularNorm.toUpperCase()) ||
        titularNorm.toUpperCase().includes(nombre)
      ) {
        return id
      }
    }

    return null
  }
}
