// database/seeders/25_captacion_dateos_seeder.ts
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import CaptacionDateo, { type Canal } from '#models/captacion_dateo'
import { sinFiltroDeSede } from '#services/sede_scope'
import { sedeDeSeeder } from '../helpers/sede_seeder.js'
import AgenteCaptacion from '#models/agente_captacion'
import Convenio from '#models/convenio'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'

/** Helpers */
const rand = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min

function makePhone(): string {
  // 10 dígitos, empieza en 3
  return '3' + String(rand(100000000, 999999999))
}

function makePlateSet(total: number): string[] {
  // Placa AAA000–ZZZ999 (sin Ñ, ni caracteres raros)
  const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ' // sin O/Q/I
  const out: string[] = []
  const seen = new Set<string>()

  while (out.length < total) {
    const L = () =>
      letters[rand(0, letters.length - 1)] +
      letters[rand(0, letters.length - 1)] +
      letters[rand(0, letters.length - 1)]
    const N = () => String(rand(100, 999))
    const p = `${L()}${N()}`
    if (!seen.has(p)) {
      seen.add(p)
      out.push(p)
    }
  }
  return out
}

export default class CaptacionDateosSeeder extends BaseSeeder {
  // Multi-sede: sede explícita SEED_SEDE=<id> (obligatoria; la 2, Bogotá,
  // prohibida). Sin request no hay sede activa: corre sin filtro y cada
  // dateo lleva la sede declarada.
  public async run() {
    const sede = sedeDeSeeder('25_captacion_dateos_seeder')
    await sinFiltroDeSede(async () => await this.sembrar(sede))
  }

  private async sembrar(sede: number) {
    const trx = await db.transaction()

    try {
      const TOTAL = 32
      const hoy = DateTime.now().startOf('day')

      // ===== Ventana para crear "recientes" =====
      const TTL_SIN_CONSUMIR = Number(process.env.TTL_SIN_CONSUMIR_DIAS ?? 7) // ej. 7
      const MAX_DIAS_ATRAS = Number(process.env.DATEOS_MAX_DIAS_ATRAS ?? 5) // ej. 5
      // Nunca generes más atrás que el TTL-1, para que salgan vigentes.
      // Forzamos que la ventana máxima sea 1 día (hoy o ayer) para el tema de vencimiento.
      const WINDOW_DAYS = Math.min(1, Math.max(0, Math.min(MAX_DIAS_ATRAS, TTL_SIN_CONSUMIR - 1)))

      const getCreatedAt = () =>
        hoy.minus({
          days: rand(0, WINDOW_DAYS),
          hours: rand(0, 23),
          minutes: rand(0, 59),
        })

      // ===== 1) Datos requeridos =====
      const conveniosActivos = await Convenio.query({ client: trx }).where('activo', true)

      if (!conveniosActivos.length) {
        console.warn('⚠️ No hay convenios activos. No se crean dateos.')
        await trx.commit()
        return
      }

      const asesoresCom = await AgenteCaptacion.query({ client: trx })
        .where('activo', true)
        .where('tipo', 'ASESOR_COMERCIAL')

      const asesoresConv = await AgenteCaptacion.query({ client: trx })
        .where('activo', true)
        .where('tipo', 'ASESOR_CONVENIO')

      const teles = await AgenteCaptacion.query({ client: trx })
        .where('activo', true)
        .where('tipo', 'ASESOR_TELEMERCADEO')

      if (!asesoresCom.length) {
        console.warn('⚠️ No hay asesores comerciales. No se crean escenarios 1, 2 y 4.')
      }

      // Mapa idConvenio -> Convenio
      const conveniosById = new Map<number, Convenio>()
      for (const c of conveniosActivos) {
        conveniosById.set(c.id, c)
      }

      // ===== Asignaciones de convenios por ASESOR (solo comerciales) =====
      const asignaciones = await AsesorConvenioAsignacion.query({ client: trx })
        .where('activo', true)
        .whereNull('fechaFin')

      const conveniosPorComercial = new Map<number, Convenio[]>()

      for (const asig of asignaciones) {
        const conv = conveniosById.get(asig.convenioId)
        if (!conv) continue

        const arr = conveniosPorComercial.get(asig.asesorId) ?? []
        arr.push(conv)
        conveniosPorComercial.set(asig.asesorId, arr)
      }

      // ===== 2) Placas y teléfonos “reales” =====
      const placas = makePlateSet(TOTAL)
      const telefonos = Array.from({ length: TOTAL }, () => makePhone())
      let idx = 0

      const payloads: any[] = []

      const useNextPlate = () => placas[idx] ?? placas[placas.length - 1]
      const useNextPhone = () => telefonos[idx] ?? telefonos[telefonos.length - 1]

      const pushRow = (row: Partial<CaptacionDateo>) => {
        payloads.push({ ...row, sedeId: sede })
        idx++
      }

      // Helpers para buscar comerciales por nombre (Diana, Juan, Miguel)
      const findComercialByName = (nombre: string) =>
        asesoresCom.find((a) => a.nombre.toUpperCase().includes(nombre.toUpperCase()))

      const diana = findComercialByName('DIANA') ?? asesoresCom[0]
      const juan = findComercialByName('JUAN') ?? asesoresCom[1] ?? asesoresCom[0]
      const miguel = findComercialByName('MIGUEL') ?? asesoresCom[2] ?? asesoresCom[0]

      // ==========================
      // 🎯 ESCENARIO 1
      // Diana datea CON convenio (8 dateos)
      // – SOLO convenios que tiene asignados
      // ==========================
      if (diana) {
        const conveniosDeDiana = conveniosPorComercial.get(diana.id) ?? conveniosActivos

        for (let i = 0; i < 8 && conveniosDeDiana.length; i++) {
          const conv = conveniosDeDiana[i % conveniosDeDiana.length]
          const createdAt = getCreatedAt()
          pushRow({
            canal: 'ASESOR_COMERCIAL',
            agenteId: diana.id,
            convenioId: conv.id,
            placa: useNextPlate(),
            telefono: useNextPhone(),
            origen: 'UI',
            observacion: `Escenario 1 (${i + 1}/8): Diana datea con convenio asignado (${conv.nombre})`,
            resultado: 'PENDIENTE',
            createdAt,
            updatedAt: createdAt,
          })
        }
      }

      // ==========================
      // 🎯 ESCENARIO 2
      // Juan datea SIN convenio (4 dateos)
      // ==========================
      if (juan) {
        for (let i = 0; i < 4; i++) {
          const createdAt = getCreatedAt()
          pushRow({
            canal: 'ASESOR_COMERCIAL',
            agenteId: juan.id,
            convenioId: null,
            placa: useNextPlate(),
            telefono: useNextPhone(),
            origen: 'UI',
            observacion: `Escenario 2 (${i + 1}/4): Juan datea SIN convenio`,
            resultado: 'PENDIENTE',
            createdAt,
            updatedAt: createdAt,
          })
        }
      }

      // ==========================
      // 🎯 ESCENARIO 3
      // Convenio datea él mismo (9 dateos)
      // canal = ASESOR_CONVENIO
      // agente_id = asesor_convenio
      // convenio_id = convenio ligado (asesor_convenio_id)
      // ==========================
      // Mapa asesor_convenio_id -> convenio
      const conveniosPorAsesor = new Map<number, Convenio>()
      for (const c of conveniosActivos) {
        if (c.asesorConvenioId) {
          conveniosPorAsesor.set(c.asesorConvenioId, c)
        }
      }

      let creadosEsc3 = 0
      for (const asesor of asesoresConv) {
        const conv = conveniosPorAsesor.get(asesor.id)
        if (!conv) continue

        for (let i = 0; i < 3 && creadosEsc3 < 9; i++) {
          const createdAt = getCreatedAt()
          pushRow({
            canal: 'ASESOR_CONVENIO',
            agenteId: asesor.id,
            convenioId: conv.id,
            placa: useNextPlate(),
            telefono: useNextPhone(),
            origen: 'UI',
            observacion: `Escenario 3 (${creadosEsc3 + 1}/9): ${conv.nombre} datea él mismo`,
            resultado: 'PENDIENTE',
            createdAt,
            updatedAt: createdAt,
          })
          creadosEsc3++
        }

        if (creadosEsc3 >= 9) break
      }

      // ==========================
      // 🎯 ESCENARIO 4
      // Miguel datea PARA convenio (4 dateos)
      // – SOLO convenios que tiene asignados
      // ==========================
      if (miguel) {
        const conveniosDeMiguel = conveniosPorComercial.get(miguel.id) ?? conveniosActivos

        for (let i = 0; i < 4 && conveniosDeMiguel.length; i++) {
          const conv = conveniosDeMiguel[i % conveniosDeMiguel.length]
          const createdAt = getCreatedAt()
          pushRow({
            canal: 'ASESOR_COMERCIAL',
            agenteId: miguel.id,
            convenioId: conv.id,
            placa: useNextPlate(),
            telefono: useNextPhone(),
            origen: 'UI',
            observacion: `Escenario 4 (${i + 1}/4): Miguel datea para convenio asignado (${conv.nombre})`,
            resultado: 'PENDIENTE',
            createdAt,
            updatedAt: createdAt,
          })
        }
      }

      // ==========================
      // 🎯 OTROS CANALES
      // TELE / FACHADA / REDES (7 dateos)
      // ==========================

      // 3 TELE
      for (let i = 0; i < 3 && payloads.length < TOTAL; i++) {
        const createdAt = getCreatedAt()
        const tele = teles.length ? teles[i % teles.length] : null

        pushRow({
          canal: 'TELE' as Canal,
          agenteId: tele ? tele.id : null,
          convenioId: null,
          placa: useNextPlate(),
          telefono: useNextPhone(),
          origen: 'UI',
          observacion: `OTRO (TELE) (${i + 1}/3): dateo de telemercadeo`,
          resultado: 'PENDIENTE',
          createdAt,
          updatedAt: createdAt,
        })
      }

      // 2 FACHADA
      for (let i = 0; i < 2 && payloads.length < TOTAL; i++) {
        const createdAt = getCreatedAt()
        pushRow({
          canal: 'FACHADA' as Canal,
          agenteId: null,
          convenioId: null,
          placa: useNextPlate(),
          telefono: useNextPhone(),
          origen: 'UI',
          observacion: `OTRO (FACHADA) (${i + 1}/2): dateo tomado en fachada`,
          resultado: 'PENDIENTE',
          createdAt,
          updatedAt: createdAt,
        })
      }

      // 2 REDES
      for (let i = 0; i < 2 && payloads.length < TOTAL; i++) {
        const createdAt = getCreatedAt()
        pushRow({
          canal: 'REDES' as Canal,
          agenteId: null,
          convenioId: null,
          placa: useNextPlate(),
          telefono: useNextPhone(),
          origen: 'UI',
          observacion: `OTRO (REDES) (${i + 1}/2): dateo proveniente de redes`,
          resultado: 'PENDIENTE',
          createdAt,
          updatedAt: createdAt,
        })
      }

      // ===== 3) Crear dateos =====
      for (const row of payloads) {
        await CaptacionDateo.create(row as any, { client: trx })
      }

      console.log(`✅ Dateos de captación creados (escenarios controlados): ${payloads.length}`)

      await trx.commit()
    } catch (err) {
      await trx.rollback()
      throw err
    }
  }
}
