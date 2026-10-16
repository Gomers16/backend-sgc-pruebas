import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Datos del intento de dateo que store() rechazó con REQUIERE_TICKET_DATEO,
 * guardados en el ticket para que aprobar() cree el dateo con ellos (antes
 * solo llegaban turno y placa y el dateo quedaba siempre "sin convenio").
 * Solo agrega columnas nullable/con default: los tickets existentes quedan
 * con NULL (aprobar() cae al comportamiento anterior).
 */
export default class extends BaseSchema {
  protected tableName = 'tickets_detalle_excepcion_dateo'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table
        .enu('canal', ['FACHADA', 'ASESOR_COMERCIAL', 'ASESOR_CONVENIO', 'TELE', 'REDES'])
        .nullable()
      table.integer('servicio_id').unsigned().nullable()
      table.integer('descuento_id').unsigned().nullable()
      table.boolean('es_avance').notNullable().defaultTo(false)
      table.string('comprobante_avance_url', 512).nullable()
      table.string('telefono', 20).nullable()
      // Convenio con el que se pidió el ticket. Si gerencia lo corrige al
      // aprobar, convenio_id cambia y este queda como registro del original.
      table.integer('convenio_id_original').unsigned().nullable()
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('canal')
      table.dropColumn('servicio_id')
      table.dropColumn('descuento_id')
      table.dropColumn('es_avance')
      table.dropColumn('comprobante_avance_url')
      table.dropColumn('telefono')
      table.dropColumn('convenio_id_original')
    })
  }
}
