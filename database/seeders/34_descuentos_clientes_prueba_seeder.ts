// database/seeders/34_descuentos_clientes_prueba_seeder.ts
//
// PARTE A: crea 100 clientes ficticios (nombres colombianos, CC ficticias 108xxxxxxx).
// PARTE B: vincula esos clientes a turnos_rtms reales sin cliente_id, repartidos
//          entre los 5 canales de captación (FACHADA/ASESOR_COMERCIAL/
//          ASESOR_CONVENIO/TELEMERCADEO/REDES).
// PARTE C: aplica descuentos realistas (catálogo `descuentos`) a ~250
//          facturacion_tickets sin descuento, repartidos entre los mismos
//          canales y entre los 7 tipos de descuento activos.
//
// Solo INSERTA clientes y hace UPDATE de turnos_rtms.cliente_id /
// facturacion_tickets.{descuento_id,descuento_monto_aplicado,autorizado_por_id,
// ajuste_total_diff,ajuste_total_flag} — no borra ni modifica ningún otro dato.
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'

import Cliente from '#models/cliente'
import Descuento from '#models/descuento'
import Usuario from '#models/usuario'

type Canal = 'FACHADA' | 'ASESOR_COMERCIAL' | 'ASESOR_CONVENIO' | 'TELEMERCADEO' | 'REDES'

const NOMBRES = [
  'CARLOS', 'DIANA', 'JUAN', 'MARIA', 'ANDRES', 'LUISA', 'JORGE', 'VALENTINA', 'MIGUEL', 'PAOLA',
  'EDGAR', 'NATALIA', 'RICARDO', 'SANDRA', 'CAMILO', 'LILIANA', 'OSCAR', 'JENNIFER', 'WILLIAM', 'ADRIANA',
  'RAFAEL', 'CAROLINA', 'ALEJANDRO', 'VICTORIA', 'DANIEL', 'LAURA', 'FRANCISCO', 'ANA', 'SERGIO', 'PATRICIA',
  'HERNANDO', 'CLAUDIA', 'NELSON', 'GLORIA', 'IVAN', 'MARTHA', 'JAIME', 'ROSA', 'ALBERTO', 'ESPERANZA',
  'RODRIGO', 'AMPARO', 'HENRY', 'ANGELA', 'MARIO', 'BEATRIZ', 'FELIX', 'CECILIA', 'RAMON', 'DOLORES',
]

const APELLIDOS = [
  'GARCIA', 'RODRIGUEZ', 'MARTINEZ', 'LOPEZ', 'GONZALEZ', 'PEREZ', 'SANCHEZ', 'RAMIREZ', 'TORRES', 'FLORES',
  'RIVERA', 'GOMEZ', 'DIAZ', 'REYES', 'MORALES', 'JIMENEZ', 'RUIZ', 'HERRERA', 'MEDINA', 'CASTRO',
  'VARGAS', 'OSPINA', 'PINTO', 'SILVA', 'MORA', 'CAMPO', 'MOLINA', 'RIOS', 'VEGA', 'SUAREZ',
  'ACOSTA', 'PARRA', 'CALDERON', 'AGUILAR', 'QUINTERO', 'FRANCO', 'MONTOYA', 'CARDONA', 'LEON', 'MEJIA',
]

// Cuántos turnos sin cliente_id se vinculan por canal (suma = 100, uno por cliente nuevo)
const VINCULACION_POR_CANAL: Record<Canal, number> = {
  FACHADA: 40,
  ASESOR_COMERCIAL: 25,
  ASESOR_CONVENIO: 20,
  TELEMERCADEO: 10,
  REDES: 5,
}

// Cuántos facturacion_tickets reciben descuento por canal (suma = 250)
const DESCUENTOS_POR_CANAL: Record<Canal, number> = {
  FACHADA: 100,
  ASESOR_COMERCIAL: 60,
  ASESOR_CONVENIO: 50,
  TELEMERCADEO: 25,
  REDES: 15,
}

// Distribución de tipos de descuento entre los 250 tickets (suma = 250)
const DISTRIBUCION_TIPOS: Record<string, number> = {
  INFORMATIVO: 87,
  AVANCE: 62,
  INFORMATIVO_EMPLEADO: 30,
  INFORMATIVO_POLICIA: 25,
  AVANCE_PROPIETARIO: 20,
  INFORMATIVO_OBSEQUIO: 15,
  INFORMATIVO_SOAT_RTM: 11,
}

// Tipos de descuento que sí reducen el total cobrado (el resto son informativos)
const TIPOS_QUE_AFECTAN_TOTAL = new Set(['AVANCE', 'AVANCE_PROPIETARIO'])

function randInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min
}

function shuffle<T>(arr: T[]): T[] {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = randInt(0, i)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function buildClientesPrueba(n: number): { nombre: string; docNumero: string; telefono: string }[] {
  const list: { nombre: string; docNumero: string; telefono: string }[] = []
  for (let i = 0; i < n; i++) {
    const nombre = NOMBRES[i % NOMBRES.length]
    const apellido1 = APELLIDOS[i % APELLIDOS.length]
    const apellido2 = APELLIDOS[(i + 13) % APELLIDOS.length]
    list.push({
      nombre: `${nombre} ${apellido1} ${apellido2}`,
      docNumero: `108${String(i + 1).padStart(7, '0')}`,
      telefono: `310${String(i + 101).padStart(7, '0')}`,
    })
  }
  return list
}

function buildTipoPool(dist: Record<string, number>): string[] {
  const pool: string[] = []
  for (const [codigo, count] of Object.entries(dist)) {
    for (let i = 0; i < count; i++) pool.push(codigo)
  }
  return shuffle(pool)
}

export default class DescuentosClientesPruebaSeeder extends BaseSeeder {
  public async run() {
    const trx = await db.transaction()
    try {
      // ===== Validación de datos base =====
      const descuentos = await Descuento.query({ client: trx }).where('activo', true)
      if (!descuentos.length) {
        console.warn('⚠️ No hay descuentos activos en el catálogo. Abortando seeder.')
        await trx.commit()
        return
      }
      const descuentoPorCodigo = new Map(descuentos.map((d) => [d.codigo, d]))
      const codigosFaltantes = Object.keys(DISTRIBUCION_TIPOS).filter(
        (c) => !descuentoPorCodigo.has(c)
      )
      if (codigosFaltantes.length) {
        console.warn(
          `⚠️ Faltan códigos de descuento en el catálogo: ${codigosFaltantes.join(', ')}. Abortando seeder.`
        )
        await trx.commit()
        return
      }

      const usuarios = await Usuario.query({ client: trx }).where('estado', 'activo')
      if (!usuarios.length) {
        console.warn('⚠️ No hay usuarios activos para asignar como autorizador. Abortando seeder.')
        await trx.commit()
        return
      }

      // ════════════════════════════════════════
      // PARTE A: 100 clientes ficticios colombianos
      // ════════════════════════════════════════
      const clientesData = buildClientesPrueba(100)
      const clientesCreados: Cliente[] = []
      for (const c of clientesData) {
        const cliente = await Cliente.updateOrCreate(
          { docTipo: 'CC', docNumero: c.docNumero },
          {
            nombre: c.nombre,
            docTipo: 'CC',
            docNumero: c.docNumero,
            telefono: c.telefono,
            email: null,
            ciudadId: null,
          },
          { client: trx }
        )
        clientesCreados.push(cliente)
      }
      console.log(`✅ Parte A: ${clientesCreados.length} clientes de prueba insertados/actualizados`)

      // ════════════════════════════════════════
      // PARTE B: vincular clientes a turnos por canal
      // ════════════════════════════════════════
      let clienteCursor = 0
      let totalVinculados = 0
      for (const [canal, cantidad] of Object.entries(VINCULACION_POR_CANAL) as [Canal, number][]) {
        const turnos = (await trx
          .from('facturacion_tickets as ft')
          .join('turnos_rtms as t', 't.id', 'ft.turno_id')
          .where('ft.captacion_canal', canal)
          .whereNull('t.cliente_id')
          .distinct('t.id as turno_id')
          .limit(cantidad)) as { turno_id: number }[]

        if (turnos.length < cantidad) {
          console.warn(
            `⚠️ ${canal}: solo hay ${turnos.length} turnos sin cliente_id disponibles (se esperaban ${cantidad})`
          )
        }

        for (const { turno_id } of turnos) {
          const cliente = clientesCreados[clienteCursor % clientesCreados.length]
          clienteCursor++
          await trx.from('turnos_rtms').where('id', turno_id).update({ cliente_id: cliente.id })
          totalVinculados++
        }
      }
      console.log(`✅ Parte B: ${totalVinculados} turnos_rtms vinculados a clientes de prueba`)

      // ════════════════════════════════════════
      // PARTE C: descuentos en ~250 tickets
      // ════════════════════════════════════════
      const tipoPool = buildTipoPool(DISTRIBUCION_TIPOS)
      let tipoCursor = 0
      let usuarioCursor = 0
      let totalConDescuento = 0

      for (const [canal, cantidad] of Object.entries(DESCUENTOS_POR_CANAL) as [Canal, number][]) {
        const tickets = (await trx
          .from('facturacion_tickets as ft')
          .join('turnos_rtms as t', 't.id', 'ft.turno_id')
          .where('ft.captacion_canal', canal)
          .whereNull('ft.descuento_id')
          .orderByRaw('(t.cliente_id IS NULL) asc') // prioriza tickets cuyo turno ya tiene cliente vinculado
          .select('ft.id as ticket_id', 'ft.tipo_vehiculo as tipo_vehiculo')
          .limit(cantidad)) as { ticket_id: number; tipo_vehiculo: string | null }[]

        if (tickets.length < cantidad) {
          console.warn(
            `⚠️ ${canal}: solo hay ${tickets.length} tickets sin descuento disponibles (se esperaban ${cantidad})`
          )
        }

        for (const { ticket_id, tipo_vehiculo } of tickets) {
          const codigo = tipoPool[tipoCursor % tipoPool.length]
          tipoCursor++
          const descuento = descuentoPorCodigo.get(codigo)!
          const esMoto = (tipo_vehiculo ?? '').toLowerCase().includes('moto')
          const monto = esMoto ? descuento.valorMoto : descuento.valorCarro
          const autorizador = usuarios[usuarioCursor % usuarios.length]
          usuarioCursor++
          const afectaTotal = TIPOS_QUE_AFECTAN_TOTAL.has(codigo)
          const ajusteTotalDiff = afectaTotal ? -monto : 0

          await trx
            .from('facturacion_tickets')
            .where('id', ticket_id)
            .update({
              descuento_id: descuento.id,
              descuento_monto_aplicado: monto,
              autorizado_por_id: autorizador.id,
              ajuste_total_diff: ajusteTotalDiff,
              ajuste_total_flag: afectaTotal,
            })
          totalConDescuento++
        }
      }
      console.log(`✅ Parte C: ${totalConDescuento} facturacion_tickets actualizados con descuento`)

      await trx.commit()

      // ════════════════════════════════════════
      // VERIFICACIÓN FINAL
      // ════════════════════════════════════════
      const [{ total_clientes }] = (await db.from('clientes').count('* as total_clientes')) as {
        total_clientes: number
      }[]
      console.log(`🔎 1) Total clientes en BD: ${total_clientes}`)

      const porTipo = await db
        .from('facturacion_tickets as ft')
        .join('descuentos as d', 'd.id', 'ft.descuento_id')
        .select('d.nombre')
        .count('* as cantidad')
        .sum('ft.descuento_monto_aplicado as total_descuentos')
        .groupBy('d.id', 'd.nombre')
        .orderBy('cantidad', 'desc')
      console.log('🔎 2) Tickets con descuento por tipo:')
      console.table(porTipo)

      const porCanalConCliente = await db
        .from('facturacion_tickets as ft')
        .join('turnos_rtms as t', 't.id', 'ft.turno_id')
        .join('clientes as c', 'c.id', 't.cliente_id')
        .select('ft.captacion_canal')
        .count('* as con_cliente')
        .groupBy('ft.captacion_canal')
      console.log('🔎 3) Tickets con cliente vinculado por canal:')
      console.table(porCanalConCliente)

      const ejemplos = await db
        .from('facturacion_tickets as ft')
        .join('turnos_rtms as t', 't.id', 'ft.turno_id')
        .join('clientes as c', 'c.id', 't.cliente_id')
        .join('descuentos as d', 'd.id', 'ft.descuento_id')
        .select(
          'ft.placa',
          'c.nombre as cliente',
          'd.nombre as descuento',
          'ft.descuento_monto_aplicado',
          'ft.captacion_canal'
        )
        .limit(3)
      console.log('🔎 4) 3 ejemplos de tickets con descuento y cliente:')
      console.table(ejemplos)
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
