import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Decisión de comisión separada para el asesor y el convenio (null = dentro
 * de ventana o pendiente). Aditiva: con_comision se queda porque producción
 * local (misma BD) todavía la lee y escribe; mientras tanto el código escribe
 * las tres columnas (con_comision = flag del asesor). Se borra en la Fase 7
 * de Tickets o al sincronizar a producción local, lo que ocurra después.
 *
 * Copia: con_comision 1 → ambos 1; 0 → asesor 0 y convenio 1 (lo que
 * significaba "aprobar sin comisión": el convenio cobraba su parte); NULL →
 * ambos NULL.
 */
/**
 * UPDATE de la copia. `soloTicketIds` lo limita a esos tickets (lo usa el
 * test; la migración copia todo).
 */
export function sqlCopiaConComision(soloTicketIds?: number[]): string {
  const filtro = soloTicketIds?.length
    ? ` WHERE ticket_id IN (${soloTicketIds.map((id) => Math.trunc(Number(id))).join(',')})`
    : ''
  return (
    'UPDATE tickets_detalle_excepcion_dateo' +
    ' SET con_comision_asesor = con_comision,' +
    ' con_comision_convenio = CASE WHEN con_comision IS NULL THEN NULL ELSE 1 END' +
    filtro
  )
}

export default class extends BaseSchema {
  protected tableName = 'tickets_detalle_excepcion_dateo'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.boolean('con_comision_asesor').nullable()
      table.boolean('con_comision_convenio').nullable()
    })

    this.defer(async (db) => {
      await db.rawQuery(sqlCopiaConComision())
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('con_comision_asesor')
      table.dropColumn('con_comision_convenio')
    })
  }
}
