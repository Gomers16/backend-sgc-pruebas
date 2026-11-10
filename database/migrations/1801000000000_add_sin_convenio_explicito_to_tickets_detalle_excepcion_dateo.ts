import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Decisión explícita del convenio al crear un ticket de Excepción de Dateo.
 *  - true  = se eligió "Sin convenio (directo)" al crear, o gerencia lo
 *            confirmó al aprobar.
 *  - false = con convenio.
 *  - NULL  = ticket anterior a esta regla o creado por producción local:
 *            nadie decidió; aprobar() pide confirmar si sigue sin convenio.
 * Sin backfill: NULL tiene que seguir significando "no decidido".
 */
export default class extends BaseSchema {
  protected tableName = 'tickets_detalle_excepcion_dateo'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table
        .boolean('sin_convenio_explicito')
        .nullable()
        .defaultTo(null)
        .after('convenio_id_original')
    })
  }

  public async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropColumn('sin_convenio_explicito')
    })
  }
}
