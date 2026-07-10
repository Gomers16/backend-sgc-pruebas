// database/seeders/33_clientes_prueba_seeder.ts
//
// Crea 20 clientes ficticios (nombres colombianos, CC ficticias) y vincula
// algunos a turnos_rtms reales (los que ya tienen un facturacion_tickets
// asociado pero aún no tienen cliente_id) para que el drill-down de
// Reportes Administrativos muestre nombres reales en algunas filas y
// "Sin RepGeneral" en las demás.
// Solo INSERTA clientes y hace UPDATE de turnos_rtms.cliente_id — no borra
// ni modifica ningún otro dato existente.
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'

import Cliente from '#models/cliente'

const CLIENTES_PRUEBA: Array<{ nombre: string; docNumero: string }> = [
  { nombre: 'CARLOS ANDRES MARTINEZ LOPEZ', docNumero: '1090456789' },
  { nombre: 'DIANA PATRICIA GOMEZ REYES', docNumero: '1098234567' },
  { nombre: 'JUAN SEBASTIAN RODRIGUEZ TORRES', docNumero: '1094567890' },
  { nombre: 'MARIA ALEJANDRA PEREZ VARGAS', docNumero: '1092345678' },
  { nombre: 'ANDRES FELIPE SANCHEZ MORENO', docNumero: '1096789012' },
  { nombre: 'LUISA FERNANDA CASTRO JIMENEZ', docNumero: '1091234567' },
  { nombre: 'JORGE IVAN RAMIREZ OSPINA', docNumero: '1093456789' },
  { nombre: 'VALENTINA LOPEZ CARDONA', docNumero: '1097890123' },
  { nombre: 'MIGUEL ANGEL HERRERA PINTO', docNumero: '1095678901' },
  { nombre: 'PAOLA ANDREA GARCIA RUIZ', docNumero: '1099012345' },
  { nombre: 'EDGAR MAURICIO SILVA QUINTERO', docNumero: '1090123456' },
  { nombre: 'NATALIA ISABEL MENDEZ FRANCO', docNumero: '1098901234' },
  { nombre: 'RICARDO ALBERTO LEON PARRA', docNumero: '1094012345' },
  { nombre: 'SANDRA MILENA ROJAS CAMPOS', docNumero: '1091023456' },
  { nombre: 'CAMILO ANDRES VEGA ACOSTA', docNumero: '1093012345' },
  { nombre: 'LILIANA MARCELA RIOS MOLINA', docNumero: '1096023456' },
  { nombre: 'OSCAR EDUARDO MORA SUAREZ', docNumero: '1092012345' },
  { nombre: 'JENNIFER TATIANA CRUZ MONTOYA', docNumero: '1097012345' },
  { nombre: 'WILLIAM FERNANDO DIAZ AGUILAR', docNumero: '1095012345' },
  { nombre: 'ADRIANA LUCIA VARGAS CALDERON', docNumero: '1099123456' },
]

export default class ClientesPruebaSeeder extends BaseSeeder {
  public async run() {
    const trx = await db.transaction()
    try {
      // 1) Insertar los 20 clientes ficticios (idempotente por doc_tipo + doc_numero)
      const clientesCreados: Cliente[] = []
      for (let i = 0; i < CLIENTES_PRUEBA.length; i++) {
        const { nombre, docNumero } = CLIENTES_PRUEBA[i]
        const telefono = `310${String(1 + i).padStart(7, '0')}`

        const cliente = await Cliente.updateOrCreate(
          { docTipo: 'CC', docNumero },
          {
            nombre,
            docTipo: 'CC',
            docNumero,
            telefono,
            email: null,
            ciudadId: null,
          },
          { client: trx }
        )
        clientesCreados.push(cliente)
      }
      console.log(`✅ ${clientesCreados.length} clientes de prueba insertados/actualizados`)

      // 2) Buscar turnos reales (con facturacion_tickets asociado) que aún no tengan cliente_id
      const turnosDisponibles = (await trx
        .from('facturacion_tickets as ft')
        .join('turnos_rtms as t', 't.id', 'ft.turno_id')
        .whereNull('t.cliente_id')
        .distinct('t.id as turno_id')
        .limit(CLIENTES_PRUEBA.length)) as { turno_id: number }[]

      if (!turnosDisponibles.length) {
        console.warn(
          '⚠️ No hay turnos_rtms sin cliente_id vinculados a facturacion_tickets. No se vinculó ningún cliente.'
        )
        await trx.commit()
        return
      }

      // 3) Distribuir los clientes entre esos turnos (1 a 1, hasta agotar el menor de los dos)
      const pares = Math.min(clientesCreados.length, turnosDisponibles.length)
      for (let i = 0; i < pares; i++) {
        await trx
          .from('turnos_rtms')
          .where('id', turnosDisponibles[i].turno_id)
          .update({ cliente_id: clientesCreados[i].id })
      }
      console.log(
        `✅ ${pares} turnos_rtms vinculados a clientes (de ${turnosDisponibles.length} turnos disponibles sin cliente)`
      )

      await trx.commit()

      // 4) Verificación (fuera de la transacción, ya confirmada)
      const verificacion = await db
        .from('facturacion_tickets as ft')
        .join('turnos_rtms as t', 't.id', 'ft.turno_id')
        .join('clientes as c', 'c.id', 't.cliente_id')
        .select('ft.placa', 'c.nombre as cliente_nombre', 'c.doc_numero')
        .limit(5)

      console.log('🔎 Verificación (5 filas con cliente vinculado):')
      console.table(verificacion)
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
