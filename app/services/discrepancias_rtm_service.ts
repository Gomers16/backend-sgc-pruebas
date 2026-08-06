// app/services/discrepancias_rtm_service.ts
//
// Cruce SGC vs Tecnoingeniería para el servicio RTM. Regla de negocio validada
// contra datos reales de julio 2026 (coincide 100% con las correcciones
// manuales hechas por el equipo):
//
//  - Tecnoingeniería NUNCA certifica sin pago previo → cualquier fila válida
//    del CSV RepGeneral (aprobada o rechazada) implica que el cliente pagó.
//  - "Válida" = vez == '1 a' (la '2 a' se descarta siempre, es un reintento)
//    y el tipo de servicio no es preventiva/auditoría.
//  - Las filas preventiva/auditoría con vez == '1 a' SÍ importan, pero solo
//    para el tipo 4 (servicio mal asignado) — por definición nunca son
//    "válidas" para el resto de tipos, así que se procesan aparte.
//
// Los 6 tipos NO son todos mutuamente excluyentes: el tipo 6 (alerta de
// cobro no registrado) es transversal — se evalúa sobre cualquier turno que
// haya matcheado (exacto o por typo), sin sacarlo de su clasificación 1/2/3.

import { DateTime } from 'luxon'
import Database from '@adonisjs/lucid/services/db'
import TurnoRtm from '#models/turno_rtm'
import InformeDiscrepanciaRtm from '#models/informe_discrepancia_rtm'
import { getEtapasRequeridas, etapaCompletada, type EtapaKey } from '#services/turno_etapas_service'

// ==================== ÍNDICES DE COLUMNA DEL CSV TECNO (RepGeneral) ====================
const IDX_FECHA = 2
const IDX_ESTADO = 3
const IDX_VEZ = 7
const IDX_TIPO_SERVICIO = 9
const IDX_PLACA = 10

type CategoriaVehiculo = 'MOTO' | 'LIVIANO'

interface TecnoRegistro {
  filaIndex: number
  fecha: DateTime
  estado: string // 'APROBADO' | 'RECHAZADO' tal como venga del CSV
  vez: string
  tipoServicioRaw: string
  tipoServicioNormalizado: string
  placa: string
  categoriaVehiculo: CategoriaVehiculo
}

interface CandidatoTypo {
  registro: TecnoRegistro
  esConfusionTipica: boolean
}

interface MatchInfo {
  registro: TecnoRegistro
  viaTypo: boolean
}

export interface InformeDiscrepanciasResult {
  informe: InformeDiscrepanciaRtm
}

/** Trazabilidad por etapa — agregada por enrichConResponsables() a tipo2/3/6/7 y a duplicados_finalizado.turnos. */
export interface ResponsablesTurno {
  responsablePuerta: string
  responsableFacturacion: string
  responsableCertificacion: string
  etapaDondeSeQuedo: string
}

/** Forma mínima que necesita enrichConResponsables(): cualquier fila con turnoId, sin importar el tipo al que pertenezca. */
interface TurnoDiscrepanciaConId {
  turnoId: number
  [key: string]: unknown
}

interface DuplicadoGrupo {
  turnos: TurnoDiscrepanciaConId[]
  [key: string]: unknown
}

// Mapa de confusiones típicas de OCR / digitación manual.
const CONFUSIONES_TIPICAS: Record<string, string> = {
  O: '0',
  '0': 'O',
  I: '1',
  '1': 'I',
  B: '8',
  '8': 'B',
  S: '5',
  '5': 'S',
  Z: '2',
  '2': 'Z',
  G: '6',
  '6': 'G',
}

export default class DiscrepanciasRtmService {
  // ==================== NORMALIZACIÓN ====================

  private static normalizarPlaca(value: string | undefined | null): string | null {
    if (!value) return null
    const limpia = value.toUpperCase().replace(/[^A-Z0-9]/g, '').trim()
    return limpia || null
  }

  private static quitarTildes(value: string): string {
    // Evita marcas diacríticas combinantes (rango Unicode 0x0300-0x036f)
    // tras normalizar a NFD, sin depender de un escape \u literal en el regex.
    return value
      .normalize('NFD')
      .split('')
      .filter((ch) => {
        const code = ch.codePointAt(0) ?? 0
        return code < 768 || code > 879
      })
      .join('')
  }

  private static normalizarTipoServicio(value: string | undefined | null): string {
    if (!value) return ''
    return this.quitarTildes(value.toUpperCase().replace(/\s+/g, ' ').trim())
  }

  private static esVigenciaPrimeraVez(vez: string | undefined | null): boolean {
    return (vez ?? '').trim().toLowerCase() === '1 a'
  }

  private static esPreventivaOAuditoria(tipoNormalizado: string): boolean {
    return tipoNormalizado.includes('PREVENTIVA') || tipoNormalizado.includes('AUDITORIA')
  }

  private static categoriaVehiculoTecno(tipoNormalizado: string): CategoriaVehiculo {
    return tipoNormalizado.includes('MOTO') ? 'MOTO' : 'LIVIANO'
  }

  private static categoriaVehiculoSgc(tipoVehiculo: string | null | undefined): CategoriaVehiculo {
    return (tipoVehiculo ?? '').toUpperCase().includes('MOTO') ? 'MOTO' : 'LIVIANO'
  }

  // ==================== PARSEO CSV TECNO ====================

  /** Parsea todas las filas con vez == '1 a' (el resto se descarta siempre). */
  private static parseTecnoRows(rows: string[][]): TecnoRegistro[] {
    const resultado: TecnoRegistro[] = []

    rows.forEach((row, filaIndex) => {
      const vez = row[IDX_VEZ] ?? ''
      if (!this.esVigenciaPrimeraVez(vez)) return

      const placa = this.normalizarPlaca(row[IDX_PLACA])
      if (!placa) return

      const fechaRaw = (row[IDX_FECHA] ?? '').substring(0, 10)
      const fecha = DateTime.fromISO(fechaRaw, { zone: 'America/Bogota' })
      if (!fecha.isValid) return

      const tipoServicioRaw = row[IDX_TIPO_SERVICIO] ?? ''
      const tipoServicioNormalizado = this.normalizarTipoServicio(tipoServicioRaw)

      resultado.push({
        filaIndex,
        fecha,
        estado: (row[IDX_ESTADO] ?? '').trim().toUpperCase(),
        vez: vez.trim(),
        tipoServicioRaw,
        tipoServicioNormalizado,
        placa,
        categoriaVehiculo: this.categoriaVehiculoTecno(tipoServicioNormalizado),
      })
    })

    return resultado
  }

  // ==================== DISTANCIA DE 1 CARÁCTER ====================

  /**
   * true si a y b difieren en exactamente 1 carácter: misma longitud con 1
   * posición distinta, o longitud ±1 donde el sobrante está al final (nunca
   * en medio). También indica si esa única diferencia es una confusión
   * típica (O↔0, I↔1, B↔8, S↔5, Z↔2, G↔6), usada como criterio de desempate.
   */
  private static distanciaUnCaracter(
    a: string,
    b: string
  ): { esVariacion: boolean; esConfusionTipica: boolean } {
    if (a === b) return { esVariacion: false, esConfusionTipica: false }

    if (a.length === b.length) {
      let diffs = 0
      let posDiff = -1
      for (let i = 0; i < a.length; i++) {
        if (a[i] !== b[i]) {
          diffs++
          posDiff = i
          if (diffs > 1) break
        }
      }
      if (diffs === 1) {
        return {
          esVariacion: true,
          esConfusionTipica: CONFUSIONES_TIPICAS[a[posDiff]] === b[posDiff],
        }
      }
      return { esVariacion: false, esConfusionTipica: false }
    }

    if (Math.abs(a.length - b.length) === 1) {
      const corta = a.length < b.length ? a : b
      const larga = a.length < b.length ? b : a
      if (larga.startsWith(corta)) {
        return { esVariacion: true, esConfusionTipica: false }
      }
    }

    return { esVariacion: false, esConfusionTipica: false }
  }

  /**
   * Cascada de desambiguación cuando un turno tiene 2+ candidatos a
   * distancia 1 carácter. Cada criterio SOLO reduce el set si de verdad
   * distingue algo — si un criterio deja 0 candidatos (ninguno cumple) o
   * no reduce nada, se descarta y se sigue con el set anterior. Validado
   * contra 1.541 placas reales de julio 2026: nunca llegó al paso (d).
   */
  private static desambiguar(
    turno: TurnoRtm,
    candidatos: CandidatoTypo[]
  ): { elegido: CandidatoTypo | null; ambiguos: CandidatoTypo[] } {
    if (candidatos.length === 1) return { elegido: candidatos[0], ambiguos: [] }
    if (candidatos.length === 0) return { elegido: null, ambiguos: [] }

    // (a) categoría de vehículo (MOTO vs LIVIANO)
    const categoriaTurno = this.categoriaVehiculoSgc(turno.tipoVehiculo)
    let restantes = this.narrow(candidatos, (c) => c.registro.categoriaVehiculo === categoriaTurno)
    if (restantes.length === 1) return { elegido: restantes[0], ambiguos: [] }

    // (b) fecha más cercana a la fecha Tecno
    const diffs = restantes.map((c) => ({
      candidato: c,
      diffDias: Math.abs(turno.fecha.diff(c.registro.fecha, 'days').days),
    }))
    const minDiff = Math.min(...diffs.map((d) => d.diffDias))
    restantes = diffs.filter((d) => d.diffDias === minDiff).map((d) => d.candidato)
    if (restantes.length === 1) return { elegido: restantes[0], ambiguos: [] }

    // (c) confusión típica (O↔0, I↔1, B↔8, S↔5, Z↔2, G↔6)
    restantes = this.narrow(restantes, (c) => c.esConfusionTipica)
    if (restantes.length === 1) return { elegido: restantes[0], ambiguos: [] }

    // (d) empate total → no se corrige automáticamente
    return { elegido: null, ambiguos: restantes }
  }

  private static narrow<T>(set: T[], predicate: (t: T) => boolean): T[] {
    const filtrado = set.filter(predicate)
    return filtrado.length > 0 ? filtrado : set
  }

  // ==================== TRAZABILIDAD: RESPONSABLES POR ETAPA ====================
  //
  // Enriquece tipo2/tipo3/tipo6/tipo7/duplicados con quién abrió, facturó y
  // certificó cada turno, más la primera etapa incompleta ("etapa donde se
  // quedó"). Reutiliza turno_etapas_service (misma fuente de verdad que el
  // semáforo de Turnos del Día) para decidir completitud — así "etapa donde
  // se quedó" nunca puede divergir del semáforo que ya ve el usuario ahí.
  // Todos los turnos que procesa este servicio son RTM (generarInforme ya
  // filtra servicio_id=1), así que servicioCodigo se fija a 'RTM'.

  private static readonly ETAPA_LABELS: Record<EtapaKey, string> = {
    puerta: 'Puerta',
    facturacion: 'Facturación',
    certificacion: 'Certificación',
  }

  private static readonly SIN_RESPONSABLE: ResponsablesTurno = {
    responsablePuerta: '—',
    responsableFacturacion: '—',
    responsableCertificacion: '—',
    etapaDondeSeQuedo: '—',
  }

  /** Bulk lookup — una sola pasada a BD por informe, sin importar cuántas hojas consuman el resultado. */
  private static async buildResponsablesMap(
    turnoIds: number[]
  ): Promise<Map<number, ResponsablesTurno>> {
    const mapa = new Map<number, ResponsablesTurno>()
    const idsUnicos = [...new Set(turnoIds)]
    if (idsUnicos.length === 0) return mapa

    const turnos = await Database.from('turnos_rtms')
      .whereIn('id', idsUnicos)
      .select(
        'id',
        'funcionario_id',
        'facturacion_funcionario_id',
        'tiene_facturacion',
        'hora_ingreso',
        'hora_salida',
        'estado'
      )

    // Un turno puede tener más de una certificación (regrabado) — la más
    // reciente (id desc) es la que representa el estado actual.
    const certificaciones = await Database.from('certificaciones')
      .whereIn('turno_id', idsUnicos)
      .orderBy('id', 'desc')
      .select('turno_id', 'usuario_id')
    const usuarioCertificacionPorTurno = new Map<number, number | null>()
    for (const c of certificaciones) {
      if (!usuarioCertificacionPorTurno.has(c.turno_id)) {
        usuarioCertificacionPorTurno.set(c.turno_id, c.usuario_id)
      }
    }

    const usuarioIds = new Set<number>()
    for (const t of turnos) {
      if (t.funcionario_id) usuarioIds.add(t.funcionario_id)
      if (t.facturacion_funcionario_id) usuarioIds.add(t.facturacion_funcionario_id)
    }
    for (const usuarioId of usuarioCertificacionPorTurno.values()) {
      if (usuarioId) usuarioIds.add(usuarioId)
    }

    const usuarios = usuarioIds.size
      ? await Database.from('usuarios').whereIn('id', [...usuarioIds]).select('id', 'nombres', 'apellidos')
      : []
    const nombrePorUsuario = new Map<number, string>(
      usuarios.map((u) => [u.id, `${u.nombres} ${u.apellidos}`.trim()])
    )

    const etapasRequeridas = getEtapasRequeridas('RTM')

    for (const t of turnos) {
      const responsablePuerta = nombrePorUsuario.get(t.funcionario_id) ?? '—'
      const responsableFacturacion = t.tiene_facturacion
        ? nombrePorUsuario.get(t.facturacion_funcionario_id) ?? '—'
        : '—'
      const usuarioCertificacionId = usuarioCertificacionPorTurno.get(t.id) ?? null
      const responsableCertificacion = usuarioCertificacionId
        ? nombrePorUsuario.get(usuarioCertificacionId) ?? '—'
        : '—'

      const primeraIncompleta = etapasRequeridas.find(
        (etapa) =>
          !etapaCompletada(etapa, {
            servicioCodigo: 'RTM',
            estado: t.estado,
            horaIngreso: t.hora_ingreso,
            tieneFacturacion: !!t.tiene_facturacion,
            horaSalida: t.hora_salida,
          })
      )
      const etapaDondeSeQuedo = primeraIncompleta ? this.ETAPA_LABELS[primeraIncompleta] : 'Completo'

      mapa.set(t.id, {
        responsablePuerta,
        responsableFacturacion,
        responsableCertificacion,
        etapaDondeSeQuedo,
      })
    }

    return mapa
  }

  /**
   * Agrega los 4 campos de trazabilidad a tipo2/tipo3/tipo6/tipo7 y a cada
   * turno dentro de duplicados_finalizado — mutando los arrays en el sitio,
   * así que debe llamarse ANTES de guardar/serializar detalleJson.
   */
  private static async enrichConResponsables(detalle: {
    tipo2: TurnoDiscrepanciaConId[]
    tipo3: TurnoDiscrepanciaConId[]
    tipo6: TurnoDiscrepanciaConId[]
    tipo7: TurnoDiscrepanciaConId[]
    duplicados: DuplicadoGrupo[]
  }): Promise<void> {
    const turnoIds: number[] = [
      ...detalle.tipo2.map((r) => r.turnoId),
      ...detalle.tipo3.map((r) => r.turnoId),
      ...detalle.tipo6.map((r) => r.turnoId),
      ...detalle.tipo7.map((r) => r.turnoId),
      ...detalle.duplicados.flatMap((g) => g.turnos.map((t) => t.turnoId)),
    ]

    const mapa = await this.buildResponsablesMap(turnoIds)
    const aplicar = (items: TurnoDiscrepanciaConId[]) => {
      for (const item of items) {
        Object.assign(item, mapa.get(item.turnoId) ?? this.SIN_RESPONSABLE)
      }
    }

    aplicar(detalle.tipo2)
    aplicar(detalle.tipo3)
    aplicar(detalle.tipo6)
    aplicar(detalle.tipo7)
    for (const grupo of detalle.duplicados) aplicar(grupo.turnos)
  }

  // ==================== ALGORITMO PRINCIPAL ====================

  public static async generarInforme(
    rows: string[][],
    meta: { archivoNombre: string | null; generadoPorId: number | null }
  ): Promise<InformeDiscrepanciaRtm> {
    const tecnoTodos = this.parseTecnoRows(rows)

    const tecnoValidos = tecnoTodos.filter((r) => !this.esPreventivaOAuditoria(r.tipoServicioNormalizado))
    const tecnoPreventivas = tecnoTodos.filter((r) => this.esPreventivaOAuditoria(r.tipoServicioNormalizado))

    // Período: rango de fechas presente en el archivo (auto-detectado).
    const fechasOrdenadas = tecnoTodos.map((r) => r.fecha).sort((a, b) => a.toMillis() - b.toMillis())
    const fechaInicio = fechasOrdenadas[0] ?? DateTime.now().setZone('America/Bogota')
    const fechaFin = fechasOrdenadas[fechasOrdenadas.length - 1] ?? fechaInicio

    // Turnos SGC del período, servicio RTM, en estado activo o finalizado.
    const turnosSgc = await TurnoRtm.query()
      .where('servicio_id', 1)
      .whereIn('estado', ['activo', 'finalizado'])
      .whereBetween('fecha', [fechaInicio.toISODate()!, fechaFin.toISODate()!])
      .orderBy('id', 'asc')

    // Facturación RTM confirmada, precargada en bloque (evita N+1).
    const turnoIds = turnosSgc.map((t) => t.id)
    const facturacionConfirmadaSet = new Set<number>()
    if (turnoIds.length > 0) {
      const facturados = await Database.from('facturacion_tickets')
        .whereIn('turno_id', turnoIds)
        .where('estado', 'CONFIRMADA')
        .where('servicio_codigo', 'RTM')
        .select('turno_id')
      for (const f of facturados) facturacionConfirmadaSet.add(f.turno_id)
    }

    // Pools disponibles para matchear (se van consumiendo).
    const tecnoValidosDisponibles = new Map<string, TecnoRegistro[]>()
    for (const r of tecnoValidos) {
      const lista = tecnoValidosDisponibles.get(r.placa) ?? []
      lista.push(r)
      tecnoValidosDisponibles.set(r.placa, lista)
    }
    const tecnoConsumidos = new Set<TecnoRegistro>()

    const matchPorTurnoId = new Map<number, MatchInfo>()

    const tipo1: unknown[] = []
    const tipo2: unknown[] = []
    const tipo3: unknown[] = []
    const tipo6: unknown[] = []
    const ambiguos: unknown[] = []
    let totalCoinciden = 0

    const registrarMatch = (turno: TurnoRtm, registro: TecnoRegistro, viaTypo: boolean) => {
      matchPorTurnoId.set(turno.id, { registro, viaTypo })
      tecnoConsumidos.add(registro)
      const lista = tecnoValidosDisponibles.get(registro.placa)
      if (lista) {
        const idx = lista.indexOf(registro)
        if (idx >= 0) lista.splice(idx, 1)
      }
    }

    const evaluarTipo6 = (turno: TurnoRtm, registro: TecnoRegistro) => {
      const facturado = turno.tieneFacturacion && facturacionConfirmadaSet.has(turno.id)
      if (!facturado) {
        tipo6.push({
          turnoId: turno.id,
          turnoCodigo: turno.turnoCodigo,
          placa: turno.placa,
          fecha: turno.fecha.toISODate(),
          estadoTecno: registro.estado,
          tieneFacturacion: turno.tieneFacturacion,
        })
        return false
      }
      return true
    }

    // ---- Pasada 1: matches EXACTOS por placa ----
    for (const turno of turnosSgc) {
      const disponibles = tecnoValidosDisponibles.get(turno.placa)
      if (!disponibles || disponibles.length === 0) continue

      // Si hay varias filas Tecno válidas con la misma placa, se toma la de
      // fecha más cercana al turno (p.ej. reintentos legítimos en fechas distintas).
      disponibles.sort(
        (a, b) =>
          Math.abs(turno.fecha.diff(a.fecha, 'days').days) -
          Math.abs(turno.fecha.diff(b.fecha, 'days').days)
      )
      const registro = disponibles[0]
      registrarMatch(turno, registro, false)

      if (turno.estado === 'activo') {
        tipo2.push({
          turnoId: turno.id,
          turnoCodigo: turno.turnoCodigo,
          placa: turno.placa,
          fecha: turno.fecha.toISODate(),
          estadoTecno: registro.estado,
        })
        evaluarTipo6(turno, registro)
      } else {
        const limpio = evaluarTipo6(turno, registro)
        if (limpio) totalCoinciden++
      }
    }

    // ---- Pasada 2: matches por distancia de 1 carácter (typo) ----
    for (const turno of turnosSgc) {
      if (matchPorTurnoId.has(turno.id)) continue

      const candidatos: CandidatoTypo[] = []
      for (const [, lista] of tecnoValidosDisponibles) {
        for (const registro of lista) {
          if (tecnoConsumidos.has(registro)) continue
          const d = this.distanciaUnCaracter(turno.placa, registro.placa)
          if (d.esVariacion) candidatos.push({ registro, esConfusionTipica: d.esConfusionTipica })
        }
      }
      if (candidatos.length === 0) continue

      const { elegido, ambiguos: empatados } = this.desambiguar(turno, candidatos)

      if (elegido) {
        registrarMatch(turno, elegido.registro, true)
        tipo1.push({
          turnoId: turno.id,
          turnoCodigo: turno.turnoCodigo,
          placaSgc: turno.placa,
          placaTecno: elegido.registro.placa,
          fecha: turno.fecha.toISODate(),
          estadoTecno: elegido.registro.estado,
        })
        evaluarTipo6(turno, elegido.registro)
      } else {
        ambiguos.push({
          turnoId: turno.id,
          turnoCodigo: turno.turnoCodigo,
          placaSgc: turno.placa,
          fecha: turno.fecha.toISODate(),
          candidatosTecno: empatados.map((c) => ({
            placa: c.registro.placa,
            fecha: c.registro.fecha.toISODate(),
            estado: c.registro.estado,
          })),
        })
      }
    }

    // ---- Tipo 3: turnos activos sin ningún rastro (ni exacto ni typo) ----
    for (const turno of turnosSgc) {
      if (turno.estado !== 'activo') continue
      if (matchPorTurnoId.has(turno.id)) continue
      tipo3.push({
        turnoId: turno.id,
        turnoCodigo: turno.turnoCodigo,
        placa: turno.placa,
        fecha: turno.fecha.toISODate(),
        funcionarioId: turno.funcionarioId,
      })
    }

    // ---- Tipo 7: turnos 'finalizado' sin ningún rastro (ni exacto ni typo) ----
    // Mismo criterio que tipo 3 pero para turnos ya cerrados en SGC — un
    // finalizado sin ningún match en Tecno es tan sospechoso como un activo
    // sin match, solo que nadie lo va a revisar porque en SGC "ya está listo".
    // Detectado al validar contra datos reales de producción (2026-08-05):
    // sin este tipo, estos casos quedaban invisibles.
    const tipo7: unknown[] = []
    for (const turno of turnosSgc) {
      if (turno.estado !== 'finalizado') continue
      if (matchPorTurnoId.has(turno.id)) continue
      tipo7.push({
        turnoId: turno.id,
        turnoCodigo: turno.turnoCodigo,
        placa: turno.placa,
        fecha: turno.fecha.toISODate(),
        funcionarioId: turno.funcionarioId,
      })
    }

    // ---- Tipo 5: filas Tecno válidas que nunca fueron consumidas ----
    const tipo5: unknown[] = []
    for (const r of tecnoValidos) {
      if (tecnoConsumidos.has(r)) continue
      tipo5.push({
        placa: r.placa,
        fecha: r.fecha.toISODate(),
        estadoTecno: r.estado,
      })
    }

    // ---- Tipo 4: filas Tecno preventiva/auditoría que SGC tiene como RTM ----
    // Match exacto de placa únicamente (no aplica la cascada de typos: el problema
    // acá es de clasificación de servicio, no de digitación de placa).
    const tipo4: unknown[] = []
    const turnosPorPlacaExacta = new Map<string, TurnoRtm[]>()
    for (const t of turnosSgc) {
      const lista = turnosPorPlacaExacta.get(t.placa) ?? []
      lista.push(t)
      turnosPorPlacaExacta.set(t.placa, lista)
    }
    for (const r of tecnoPreventivas) {
      const turnosCoincidentes = turnosPorPlacaExacta.get(r.placa)
      if (!turnosCoincidentes) continue
      for (const turno of turnosCoincidentes) {
        tipo4.push({
          turnoId: turno.id,
          turnoCodigo: turno.turnoCodigo,
          placa: turno.placa,
          fecha: turno.fecha.toISODate(),
          tipoServicioTecno: r.tipoServicioRaw,
        })
      }
    }

    // ---- Validación final: placas con 2+ turnos 'finalizado' en el período ----
    const duplicados: unknown[] = []
    const finalizadosPorPlaca = new Map<string, TurnoRtm[]>()
    for (const t of turnosSgc) {
      if (t.estado !== 'finalizado') continue
      const lista = finalizadosPorPlaca.get(t.placa) ?? []
      lista.push(t)
      finalizadosPorPlaca.set(t.placa, lista)
    }
    for (const [placa, turnos] of finalizadosPorPlaca) {
      if (turnos.length < 2) continue

      const conFacturaConfirmada = turnos.filter(
        (t) => t.tieneFacturacion && facturacionConfirmadaSet.has(t.id)
      )

      let sugeridoId: number | null = null
      let motivo: string

      if (conFacturaConfirmada.length === 1) {
        sugeridoId = conFacturaConfirmada[0].id
        motivo = 'Único con facturación RTM confirmada'
      } else {
        const conMatchTecno = turnos.filter((t) => matchPorTurnoId.has(t.id))
        if (conMatchTecno.length === 1) {
          sugeridoId = conMatchTecno[0].id
          motivo = 'Único con coincidencia en el reporte de Tecnoingeniería'
        } else if (conMatchTecno.length > 1) {
          const distancias = conMatchTecno.map((t) => ({
            turno: t,
            diffDias: Math.abs(t.fecha.diff(matchPorTurnoId.get(t.id)!.registro.fecha, 'days').days),
          }))
          const minDiff = Math.min(...distancias.map((d) => d.diffDias))
          const ganadores = distancias.filter((d) => d.diffDias === minDiff)
          if (ganadores.length === 1) {
            sugeridoId = ganadores[0].turno.id
            motivo = 'Fecha más cercana al registro de Tecnoingeniería'
          } else {
            motivo = 'Empate en todos los criterios — revisar manualmente'
          }
        } else {
          motivo = 'Ninguno tiene facturación confirmada ni coincidencia en Tecno — revisar manualmente'
        }
      }

      duplicados.push({
        placa,
        turnos: turnos.map((t) => ({
          turnoId: t.id,
          turnoCodigo: t.turnoCodigo,
          fecha: t.fecha.toISODate(),
          tieneFacturacionConfirmada: t.tieneFacturacion && facturacionConfirmadaSet.has(t.id),
          tieneMatchTecno: matchPorTurnoId.has(t.id),
        })),
        sugeridoId,
        motivo,
      })
    }

    const totalSgcFinalizados = turnosSgc.filter((t) => t.estado === 'finalizado').length

    // Trazabilidad por etapa (responsables + dónde se quedó) — se guarda ya
    // resuelta en detalleJson, no se recalcula al exportar el Excel.
    await this.enrichConResponsables({
      tipo2: tipo2 as TurnoDiscrepanciaConId[],
      tipo3: tipo3 as TurnoDiscrepanciaConId[],
      tipo6: tipo6 as TurnoDiscrepanciaConId[],
      tipo7: tipo7 as TurnoDiscrepanciaConId[],
      duplicados: duplicados as unknown as DuplicadoGrupo[],
    })

    const informe = await InformeDiscrepanciaRtm.create({
      fechaInicio,
      fechaFin,
      archivoNombre: meta.archivoNombre,
      filasCsvTotal: rows.length,
      generadoPorId: meta.generadoPorId,
      generadoAt: DateTime.now(),
      totalTecnoValido: tecnoValidos.length,
      totalSgcFinalizados,
      totalCoinciden,
      totalTipo1PlacaMalDigitada: tipo1.length,
      totalTipo2ActivoDebeFinalizar: tipo2.length,
      totalTipo3TurnoFantasma: tipo3.length,
      totalTipo4ServicioMalAsignado: tipo4.length,
      totalTipo5FaltaEnSgc: tipo5.length,
      totalTipo6AlertaCobroNoRegistrado: tipo6.length,
      totalTipo7FinalizadoSinRastroTecno: tipo7.length,
      totalDuplicadosFinalizado: duplicados.length,
      totalAmbiguosRevisarManual: ambiguos.length,
      detalleJson: {
        tipo1_placa_mal_digitada: tipo1,
        tipo2_activo_debe_finalizar: tipo2,
        tipo3_turno_fantasma: tipo3,
        tipo4_servicio_mal_asignado: tipo4,
        tipo5_falta_en_sgc: tipo5,
        tipo6_alerta_cobro_no_registrado: tipo6,
        tipo7_finalizado_sin_rastro_tecno: tipo7,
        duplicados_finalizado: duplicados,
        ambiguos_revisar_manual: ambiguos,
      },
    })

    return informe
  }
}
