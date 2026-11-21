// app/services/importacion_bogota/importacion_bogota_service.ts
//
// "Importación Bogotá": carga la base histórica de una sede que NO es Ibagué
// (formato de Bogotá, ver formato_bogota.ts) con la MISMA organización que el
// TECNOBASE de Ibagué (rep_general_imports_controller.crearTurnoHistorico):
// clientes / vehículos / conductores globales y un turno RTM finalizado por
// visita en la sede activa (mixin SedeScoped), responsable = un usuario de la
// sede, canal FACHADA, sin recurrencia ni comisiones (esas las calcula el Rep
// General diario después, como en Ibagué).
//
// Diferencias a propósito con el TECNOBASE de Ibagué:
//  - Lee APROBADO/RECHAZADO (columna D): el resultado se guarda como al
//    certificar (camposAlCertificar): RECHAZADA no da vigencia y abre su
//    ventana de segunda vez. Misma placa el mismo día → un solo turno.
//  - Hora real de ingreso (columna C) y salida = ingreso + duración (H).
//  - Un vehículo con historial en OTRA sede no cambia de dueño ni de clase
//    (solo se completan campos vacíos); cada caso se reporta.
//  - Dos pasos: vista previa (no escribe; guarda el plan en tmp) y lotes con
//    una transacción cada uno. Idempotente por placa + fecha en la sede:
//    repetir o reanudar no duplica.

import app from '@adonisjs/core/services/app'
import db from '@adonisjs/lucid/services/db'
import type { TransactionClientContract } from '@adonisjs/lucid/types/database'
import { DateTime } from 'luxon'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import ExcelJS from 'exceljs'

import Cliente from '#models/cliente'
import Conductor from '#models/conductor'
import TurnoRtm from '#models/turno_rtm'
import Vehiculo from '#models/vehiculo'
import { SedeScopeError, sedeParaEscritura, sinFiltroDeSede } from '#services/sede_scope'
import { camposAlCertificar } from '#services/segunda_vez_service'
import { esXls, leerXls } from './lector_xls.js'
import {
  agruparPorVisita,
  type Celda,
  type Descarte,
  esFilaTitulos,
  type GrupoBogota,
  leerFila,
  MAX_COLUMNAS,
  type MotivoDescarte,
  TEXTO_MOTIVO,
  type FilaBogota,
  ZONA,
} from './formato_bogota.js'

export const SEDE_IBAGUE = 1
export const TAM_LOTE = 250
const EJEMPLOS_POR_MOTIVO = 10
const MAX_AVISOS = 200
const VIGENCIA_PLAN_HORAS = 24
export const MARCA_OBSERVACION = 'Importado desde Importación Bogotá'

/* ============================== Errores ============================== */

export class ImportacionError extends Error {
  constructor(
    message: string,
    public status = 400,
    public code = 'E_IMPORTACION_BOGOTA'
  ) {
    super(message)
  }
}

/** Sede donde se escribe: concreta, distinta de Ibagué. */
export function sedeDeImportacion(): number {
  const sede = sedeParaEscritura() // "todas" → 400
  if (!sede) throw new SedeScopeError('No se pudo determinar la sede activa.', 400)
  if (sede === SEDE_IBAGUE) {
    throw new SedeScopeError(
      'La Importación Bogotá no se usa en Ibagué: Ibagué carga su base con "Importar RepGeneral". Elige la sede de destino en el encabezado.',
      400
    )
  }
  return sede
}

/* ============================== Lectura ============================== */

export interface ArchivoLeido {
  filas: Celda[][]
  fecha1904: boolean
}

export async function leerArchivo(buf: Buffer, nombre: string): Promise<ArchivoLeido> {
  if (esXls(buf)) {
    const h = leerXls(buf)
    return { filas: h.filas, fecha1904: h.fecha1904 }
  }
  if (buf.subarray(0, 2).toString('latin1') !== 'PK') {
    throw new ImportacionError(`"${nombre}" no es un Excel .xls ni .xlsx.`)
  }
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as any)
  const ws = wb.worksheets[0]
  if (!ws) throw new ImportacionError('El archivo no tiene hojas.')
  const filas: Celda[][] = []
  ws.eachRow({ includeEmpty: true }, (row, n) => {
    const vals: Celda[] = []
    row.eachCell({ includeEmpty: true }, (cell, col) => {
      let v: any = cell.value
      if (v && typeof v === 'object' && !(v instanceof Date)) {
        v =
          'result' in v
            ? v.result
            : 'text' in v
              ? v.text
              : 'richText' in v
                ? v.richText.map((r: any) => r.text).join('')
                : null
      }
      vals[col - 1] = v ?? null
    })
    filas[n - 1] = vals
  })
  for (let i = 0; i < filas.length; i++) if (!filas[i]) filas[i] = []
  return { filas, fecha1904: false }
}

/** Valida que el archivo tenga el formato de Bogotá (no el de Ibagué). */
function validarFormato(a: ArchivoLeido) {
  const conDatos = a.filas.filter((f) => f.some((c) => c !== null && c !== undefined && c !== ''))
  if (!conDatos.length) throw new ImportacionError('El archivo no tiene filas con datos.')
  const anchoMax = Math.max(...conDatos.slice(0, 200).map((f) => f.length))
  if (anchoMax > MAX_COLUMNAS) {
    throw new ImportacionError(
      `El archivo tiene ${anchoMax} columnas; el formato de Bogotá tiene 42 (A–AP). Si es un archivo de Ibagué (48 columnas), usa "Importar RepGeneral".`
    )
  }
}

/* ============================== Plan ============================== */

interface Plan {
  token: string
  sedeId: number
  usuarioId: number
  archivo: string
  creadoAt: string
  grupos: GrupoBogota[]
}

const dirPlanes = () => app.tmpPath('importacion_bogota')
const rutaPlan = (token: string) => {
  if (!/^[0-9a-f-]{36}$/.test(token)) throw new ImportacionError('Token de importación inválido.')
  return path.join(dirPlanes(), `${token}.json`)
}

async function limpiarPlanesViejos() {
  const dir = dirPlanes()
  const archivos = await fs.readdir(dir).catch(() => [] as string[])
  const limite = Date.now() - VIGENCIA_PLAN_HORAS * 3600_000
  for (const a of archivos) {
    const p = path.join(dir, a)
    const st = await fs.stat(p).catch(() => null)
    if (st && st.mtimeMs < limite) await fs.unlink(p).catch(() => {})
  }
}

async function leerPlan(token: string, sedeId: number, usuarioId: number): Promise<Plan> {
  let plan: Plan
  try {
    plan = JSON.parse(await fs.readFile(rutaPlan(token), 'utf8'))
  } catch {
    throw new ImportacionError(
      'La vista previa ya no existe o venció: vuelve a subir el archivo.',
      404
    )
  }
  if (plan.sedeId !== sedeId) {
    throw new ImportacionError(
      'La vista previa se hizo en otra sede: vuelve a subir el archivo en esta sede.',
      409
    )
  }
  if (plan.usuarioId !== usuarioId) {
    throw new ImportacionError('La vista previa la hizo otro usuario.', 403)
  }
  return plan
}

/* ============================== Consultas ============================== */

/** Responsable de los turnos: el primer usuario activo de la sede (como Ibagué). */
async function responsableDeSede(sedeId: number) {
  // sede: usuarios de la sede activa (no se usa nunca uno de otra sede)
  const u = await db
    .from('usuarios')
    .where('sede_id', sedeId)
    .where('estado', 'activo')
    .orderBy('id', 'asc')
    .select('id', 'nombres', 'apellidos')
    .first()
  if (!u) {
    throw new ImportacionError(
      'La sede activa no tiene usuarios activos: crea al menos uno (Gestión documental → Usuarios) para que sea el responsable de los turnos importados.'
    )
  }
  return u as { id: number; nombres: string; apellidos: string }
}

async function enLotes<T, R>(
  valores: T[],
  fn: (lote: T[]) => Promise<R[]>,
  tam = 1000
): Promise<R[]> {
  const out: R[] = []
  for (let i = 0; i < valores.length; i += tam) out.push(...(await fn(valores.slice(i, i + tam))))
  return out
}

/** Placas con turnos en una sede distinta de `sedeId`. */
async function placasConHistorialEnOtraSede(
  placas: string[],
  sedeId: number,
  client?: TransactionClientContract
) {
  if (!placas.length) return new Set<string>()
  const filas = await enLotes(placas, (lote) =>
    sinFiltroDeSede(() =>
      // sede: a propósito otras sedes: detectar vehículos compartidos (no se cambia su dueño ni clase)
      (client ?? db)
        .from('turnos_rtms')
        .whereIn('placa', lote)
        .whereNot('sede_id', sedeId)
        .distinct('placa')
        .select('placa')
    )
  )
  return new Set((filas as any[]).map((r) => String(r.placa).toUpperCase()))
}

/* ============================== Vista previa ============================== */

export interface ResumenDescartes {
  motivo: MotivoDescarte
  texto: string
  filas: number
  ejemplos: Descarte[]
}

export async function vistaPrevia(params: { buf: Buffer; nombre: string; usuarioId: number }) {
  const sedeId = sedeDeImportacion()
  const responsable = await responsableDeSede(sedeId)
  // sede: nombre de la sede activa
  const sede = await db.from('sedes').where('id', sedeId).select('id', 'nombre').first()

  const archivo = await leerArchivo(params.buf, params.nombre)
  validarFormato(archivo)

  const validas: FilaBogota[] = []
  const descartes: Descarte[] = []
  let telefonosDescartados = 0
  let conTitulos = false
  archivo.filas.forEach((f, i) => {
    if (i === 0 && esFilaTitulos(f, archivo.fecha1904)) {
      conTitulos = true
      return
    }
    const r = leerFila(f, i + 1, archivo.fecha1904)
    if (r.ok) {
      validas.push(r.fila)
      telefonosDescartados += r.fila.telefonosDescartados
    } else if (r.descarte.motivo !== 'FILA_VACIA') {
      descartes.push(r.descarte)
    }
  })
  const { grupos, unificadas } = agruparPorVisita(validas)
  if (!grupos.length) throw new ImportacionError('No quedó ninguna fila válida para importar.')

  // Conteos contra la BD (solo lectura).
  const placas = [...new Set(grupos.map((g) => g.placa))]
  const docsDueno = [...new Set(grupos.map((g) => g.dueno.docNumero).filter(Boolean))] as string[]
  const docsCond = [
    ...new Set(grupos.map((g) => g.conductor.docNumero).filter(Boolean)),
  ] as string[]
  const fechas = grupos.map((g) => g.fechaISO).sort()

  const filasVeh = await enLotes(placas, (l) =>
    db.from('vehiculos').whereIn('placa', l).select('placa')
  )
  const vehExist = new Set(filasVeh.map((r: any) => String(r.placa).toUpperCase()))
  const filasCli = await enLotes(docsDueno, (l) =>
    db.from('clientes').whereIn('doc_numero', l).select('doc_numero')
  )
  const cliExist = new Set(filasCli.map((r: any) => String(r.doc_numero)))
  const filasCond = await enLotes(docsCond, (l) =>
    db.from('conductores').whereIn('doc_numero', l).select('doc_numero')
  )
  const condExist = new Set(filasCond.map((r: any) => String(r.doc_numero)))
  const filasTurnos = await enLotes(placas, (l) =>
    // sede: turnos ya importados/creados en la sede activa (idempotencia)
    db
      .from('turnos_rtms')
      .where('sede_id', sedeId)
      .whereIn('placa', l)
      .whereBetween('fecha', [fechas[0], fechas[fechas.length - 1]])
      .select('placa', db.raw("DATE_FORMAT(fecha, '%Y-%m-%d') as f"))
  )
  const turnosExist = new Set(
    filasTurnos.map((r: any) => `${String(r.placa).toUpperCase()}|${r.f}`)
  )
  const otraSede = await placasConHistorialEnOtraSede([...vehExist], sedeId)
  // Clientes existentes sin turnos ni dateos en ninguna sede: hoy se ven en
  // todas; al recibir turnos de esta sede pasarán a verse solo aquí.
  const filasSinHistorial = await enLotes([...cliExist], (l) =>
    sinFiltroDeSede(() =>
      db
        .from('clientes as c')
        .whereIn('c.doc_numero', l)
        // sede: a propósito todas las sedes (¿tiene historial en alguna?)
        .whereNotExists((q) => q.from('turnos_rtms as t').whereColumn('t.cliente_id', 'c.id'))
        // sede: a propósito todas las sedes (¿tiene historial en alguna?)
        .whereNotExists((q) => q.from('captacion_dateos as d').whereColumn('d.cliente_id', 'c.id'))
        .select('c.id')
    )
  )
  const sinHistorial = filasSinHistorial.length

  const turnosNuevos = grupos.filter((g) => !turnosExist.has(`${g.placa}|${g.fechaISO}`))
  const porMotivo = new Map<MotivoDescarte, Descarte[]>()
  for (const d of [...descartes, ...unificadas]) {
    const l = porMotivo.get(d.motivo) ?? []
    l.push(d)
    porMotivo.set(d.motivo, l)
  }
  const resumenDescartes: ResumenDescartes[] = [...porMotivo].map(([motivo, l]) => ({
    motivo,
    texto: TEXTO_MOTIVO[motivo],
    filas: l.length,
    ejemplos: l.sort((a, b) => a.fila - b.fila).slice(0, EJEMPLOS_POR_MOTIVO),
  }))

  await fs.mkdir(dirPlanes(), { recursive: true })
  await limpiarPlanesViejos()
  const token = randomUUID()
  const plan: Plan = {
    token,
    sedeId,
    usuarioId: params.usuarioId,
    archivo: params.nombre,
    creadoAt: DateTime.now().toISO()!,
    grupos,
  }
  await fs.writeFile(rutaPlan(token), JSON.stringify(plan))

  return {
    token,
    sede: sede
      ? { id: Number(sede.id), nombre: String(sede.nombre) }
      : { id: sedeId, nombre: `Sede ${sedeId}` },
    responsable: {
      id: Number(responsable.id),
      nombre: `${responsable.nombres} ${responsable.apellidos}`.trim(),
    },
    archivo: params.nombre,
    conTitulos,
    filasLeidas: validas.length + descartes.length,
    rango: { desde: fechas[0], hasta: fechas[fechas.length - 1] },
    turnos: {
      visitas: grupos.length,
      aCrear: turnosNuevos.length,
      yaExisten: grupos.length - turnosNuevos.length,
      aprobadas: turnosNuevos.filter((g) => g.resultado === 'APROBADA').length,
      rechazadas: turnosNuevos.filter((g) => g.resultado === 'RECHAZADA').length,
      preventivas: turnosNuevos.filter((g) => g.servicioCodigo === 'PREV').length,
    },
    vehiculos: {
      distintos: placas.length,
      aCrear: placas.filter((p) => !vehExist.has(p)).length,
      existentes: vehExist.size,
      conHistorialEnOtraSede: otraSede.size,
    },
    clientes: {
      conDocumento: docsDueno.length,
      aCrear: docsDueno.filter((d) => !cliExist.has(d)).length,
      existentes: cliExist.size,
      existentesSinHistorial: sinHistorial,
    },
    conductores: {
      conDocumento: docsCond.length,
      aCrear: docsCond.filter((d) => !condExist.has(d)).length,
      existentes: condExist.size,
    },
    telefonosDescartados,
    descartes: resumenDescartes,
    lotes: { tamano: TAM_LOTE, total: Math.ceil(grupos.length / TAM_LOTE) },
  }
}

/* ============================== Escritura por lote ============================== */

export interface Aviso {
  fila: number
  placa: string
  aviso: string
}

interface Conteos {
  turnosCreados: number
  turnosYaExistian: number
  clientesCreados: number
  clientesReutilizados: number
  vehiculosCreados: number
  vehiculosReutilizados: number
  conductoresCreados: number
  conductoresReutilizados: number
}

/** Cliente: 1° documento, 2° teléfono (si el documento no contradice), 3° crear. Igual que Ibagué. */
async function upsertCliente(g: GrupoBogota, trx: TransactionClientContract, c: Conteos) {
  const p = g.dueno
  if (!p.docNumero && !p.nombre && !p.telefono && !p.email) return null
  let cliente: Cliente | null = null
  if (p.docNumero)
    cliente = await Cliente.query({ client: trx }).where('doc_numero', p.docNumero).first()
  if (!cliente && p.telefono) {
    const porTel = await Cliente.query({ client: trx }).where('telefono', p.telefono).first()
    if (porTel && (!p.docNumero || !porTel.docNumero || porTel.docNumero === p.docNumero))
      cliente = porTel
  }
  const emailLibre = async (excluir: number | null) => {
    if (!p.email) return null
    const q = Cliente.query({ client: trx }).whereRaw('LOWER(email) = ?', [p.email])
    if (excluir) q.whereNot('id', excluir)
    return (await q.first()) ? null : p.email
  }
  if (!cliente) {
    cliente = await Cliente.create(
      {
        docTipo: p.docTipo || (p.docNumero ? 'CC' : null),
        docNumero: p.docNumero,
        nombre: p.nombre,
        telefono: p.telefono ?? '',
        email: await emailLibre(null),
      } as any,
      { client: trx }
    )
    c.clientesCreados++
    return cliente
  }
  // Completar solo lo vacío (sin pisar datos).
  let cambia = false
  if (!cliente.docNumero && p.docNumero) {
    cliente.docNumero = p.docNumero
    cliente.docTipo = p.docTipo || 'CC'
    cambia = true
  }
  if (!cliente.nombre && p.nombre) {
    cliente.nombre = p.nombre
    cambia = true
  }
  if (!cliente.telefono && p.telefono) {
    cliente.telefono = p.telefono
    cambia = true
  }
  if (!cliente.email && p.email) {
    const e = await emailLibre(cliente.id)
    if (e) {
      cliente.email = e
      cambia = true
    }
  }
  if (cambia) {
    cliente.useTransaction(trx)
    await cliente.save()
  }
  c.clientesReutilizados++
  return cliente
}

async function upsertConductor(
  g: GrupoBogota,
  cliente: Cliente | null,
  trx: TransactionClientContract,
  c: Conteos
) {
  const p = g.conductor
  let conductor: Conductor | null = null
  if (p.docNumero)
    conductor = await Conductor.query({ client: trx }).where('doc_numero', p.docNumero).first()
  if (!conductor && p.telefono)
    conductor = await Conductor.query({ client: trx }).where('telefono', p.telefono).first()
  if (!conductor && p.nombre) {
    conductor = await Conductor.create(
      {
        nombre: p.nombre,
        docTipo: p.docTipo || (p.docNumero ? 'CC' : null),
        docNumero: p.docNumero,
        telefono: p.telefono,
      },
      { client: trx }
    )
    c.conductoresCreados++
    return conductor
  }
  if (conductor) {
    let cambia = false
    if (!conductor.docNumero && p.docNumero) {
      conductor.docNumero = p.docNumero
      conductor.docTipo = p.docTipo || 'CC'
      cambia = true
    }
    if (!conductor.telefono && p.telefono) {
      conductor.telefono = p.telefono
      cambia = true
    }
    if (cambia) {
      conductor.useTransaction(trx)
      await conductor.save()
    }
    c.conductoresReutilizados++
    return conductor
  }
  // Sin conductor en el archivo: el dueño (como Ibagué).
  if (!cliente || !cliente.nombre) return null
  const q = Conductor.query({ client: trx })
  if (cliente.docNumero) q.where('doc_numero', cliente.docNumero)
  else if (cliente.telefono) q.where('telefono', cliente.telefono)
  else return null
  const mismo = await q.first()
  if (mismo) {
    c.conductoresReutilizados++
    return mismo
  }
  c.conductoresCreados++
  return Conductor.create(
    {
      nombre: cliente.nombre,
      docTipo: cliente.docTipo,
      docNumero: cliente.docNumero,
      telefono: cliente.telefono || null,
    },
    { client: trx }
  )
}

async function upsertVehiculo(
  g: GrupoBogota,
  cliente: Cliente | null,
  otraSede: Set<string>,
  trx: TransactionClientContract,
  c: Conteos,
  avisos: Aviso[]
) {
  let v = await Vehiculo.query({ client: trx }).whereRaw('UPPER(placa) = ?', [g.placa]).first()
  if (!v) {
    v = await Vehiculo.create(
      {
        placa: g.placa,
        ...g.vehiculo,
        clienteId: cliente?.id ?? null,
        claseVehiculoId: g.claseVehiculoId,
      } as any,
      { client: trx }
    )
    c.vehiculosCreados++
    return v
  }
  c.vehiculosReutilizados++
  const compartido = otraSede.has(g.placa)
  let cambia = false
  for (const k of ['marca', 'linea', 'modelo', 'color', 'matricula'] as const) {
    if (!(v as any)[k] && g.vehiculo[k]) {
      ;(v as any)[k] = g.vehiculo[k]
      cambia = true
    }
  }
  if ((v as any).claseVehiculoId !== g.claseVehiculoId) {
    if (compartido) {
      avisos.push({
        fila: g.fila,
        placa: g.placa,
        aviso:
          'Vehículo con historial en otra sede y otra clase en el archivo: no se cambió la clase.',
      })
    } else {
      ;(v as any).claseVehiculoId = g.claseVehiculoId
      cambia = true
    }
  }
  if (cliente) {
    if (!v.clienteId) {
      v.clienteId = cliente.id
      cambia = true
    } else if (v.clienteId !== cliente.id) {
      if (compartido) {
        avisos.push({
          fila: g.fila,
          placa: g.placa,
          aviso:
            'Vehículo con historial en otra sede y otro dueño en el archivo: no se cambió el dueño.',
        })
      } else {
        // Igual que Ibagué: cambia de dueño si esta visita es posterior al
        // último turno (en esta sede) con el dueño actual.
        const ultimo = await TurnoRtm.query({ client: trx })
          .where('placa', g.placa)
          .where('cliente_id', v.clienteId)
          .orderBy('fecha', 'desc')
          .first()
        const fechaUltimo = ultimo?.fecha
          ? DateTime.fromISO(
              String((ultimo.fecha as any).toISODate?.() ?? ultimo.fecha).slice(0, 10),
              { zone: ZONA }
            )
          : null
        if (!fechaUltimo || DateTime.fromISO(g.fechaISO, { zone: ZONA }) > fechaUltimo) {
          v.clienteId = cliente.id
          cambia = true
        }
      }
    }
  }
  if (cambia) {
    v.useTransaction(trx)
    await v.save()
  }
  return v
}

export async function procesarLote(params: { token: string; lote: number; usuarioId: number }) {
  const sedeId = sedeDeImportacion()
  const plan = await leerPlan(params.token, sedeId, params.usuarioId)
  const total = Math.ceil(plan.grupos.length / TAM_LOTE)
  if (!Number.isInteger(params.lote) || params.lote < 0 || params.lote >= total) {
    throw new ImportacionError(`Lote inválido: debe estar entre 0 y ${total - 1}.`)
  }
  const responsable = await responsableDeSede(sedeId)
  const grupos = plan.grupos.slice(params.lote * TAM_LOTE, (params.lote + 1) * TAM_LOTE)
  const c: Conteos = {
    turnosCreados: 0,
    turnosYaExistian: 0,
    clientesCreados: 0,
    clientesReutilizados: 0,
    vehiculosCreados: 0,
    vehiculosReutilizados: 0,
    conductoresCreados: 0,
    conductoresReutilizados: 0,
  }
  const avisos: Aviso[] = []
  const servicios = new Map<string, number>(
    (
      (await db
        .from('servicios')
        .whereIn('codigo_servicio', ['RTM', 'PREV'])
        .select('id', 'codigo_servicio')) as any[]
    ).map((s) => [String(s.codigo_servicio), Number(s.id)])
  )
  if (!servicios.get('RTM'))
    throw new ImportacionError('No existe el servicio RTM en la base de datos.', 500)

  await db.transaction(async (trx) => {
    const otraSede = await placasConHistorialEnOtraSede(
      [...new Set(grupos.map((g) => g.placa))],
      sedeId,
      trx
    )
    for (const g of grupos) {
      // Idempotencia: placa + fecha en la sede activa (el mixin filtra por sede).
      const existe = await TurnoRtm.query({ client: trx })
        .where('placa', g.placa)
        .where('fecha', g.fechaISO)
        .first()
      if (existe) {
        c.turnosYaExistian++
        continue
      }
      const cliente = await upsertCliente(g, trx, c)
      const vehiculo = await upsertVehiculo(g, cliente, otraSede, trx, c, avisos)
      const conductor = await upsertConductor(g, cliente, trx, c)

      const servicioId = servicios.get(g.servicioCodigo) ?? servicios.get('RTM')!
      const numero = await TurnoRtm.query({ client: trx })
        .where('fecha', g.fechaISO)
        .max('turno_numero as max')
        .pojo<{ max: number | null }>()
        .first()
      const numeroServicio = await TurnoRtm.query({ client: trx })
        .where('fecha', g.fechaISO)
        .where('servicio_id', servicioId)
        .max('turno_numero_servicio as max')
        .pojo<{ max: number | null }>()
        .first()
      const turnoNumero = (numero?.max ?? 0) + 1
      const resultado = camposAlCertificar({
        codigoServicio: g.servicioCodigo,
        resultado: g.resultado,
        esSegundaVez: false,
        ahora: DateTime.fromISO(g.instanteISO, { zone: ZONA }),
      })
      await TurnoRtm.create(
        {
          fecha: DateTime.fromISO(g.fechaISO, { zone: ZONA }),
          horaIngreso: g.hora,
          horaSalida: g.horaSalida,
          turnoNumero,
          turnoNumeroServicio: (numeroServicio?.max ?? 0) + 1,
          turnoCodigo: `HIST-${g.fechaISO.replace(/-/g, '')}-${sedeId}-${turnoNumero}`,
          placa: g.placa,
          tipoVehiculo: g.tipoVehiculo,
          estado: 'finalizado',
          vehiculoId: vehiculo?.id ?? null,
          clienteId: cliente?.id ?? vehiculo?.clienteId ?? null,
          conductorId: conductor?.id ?? null,
          claseVehiculoId: (vehiculo as any)?.claseVehiculoId ?? g.claseVehiculoId,
          funcionarioId: responsable.id,
          servicioId,
          observaciones: [MARCA_OBSERVACION, g.observacion].filter(Boolean).join(' '),
          canalAtribucion: 'FACHADA',
          esRecurrente: false,
          esRecuperacion: false,
          mesesDesdeUltimaVisita: null,
          ultimoTurnoId: null,
          fechaUltimaVisita: null,
          ...resultado,
        } as any,
        { client: trx }
      )
      c.turnosCreados++
    }
  })

  const terminado = params.lote === total - 1
  if (terminado) await fs.unlink(rutaPlan(params.token)).catch(() => {})
  return {
    lote: params.lote,
    totalLotes: total,
    procesados: Math.min((params.lote + 1) * TAM_LOTE, plan.grupos.length),
    totalVisitas: plan.grupos.length,
    terminado,
    ...c,
    avisos: avisos.slice(0, MAX_AVISOS),
    avisosTotal: avisos.length,
  }
}
