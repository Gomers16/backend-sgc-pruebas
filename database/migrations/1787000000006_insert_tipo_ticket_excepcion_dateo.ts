// database/migrations/1787000000006_insert_tipo_ticket_excepcion_dateo.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  public async up() {
    const existe = await this.db.from('tipos_ticket').where('codigo', 'EXCEPCION_DATEO').first()
    if (!existe) {
      await this.db.table('tipos_ticket').insert({
        codigo: 'EXCEPCION_DATEO',
        nombre: 'Excepción de Dateo',
        roles_creador: JSON.stringify(['COMERCIAL']),
        roles_resuelve: JSON.stringify(['SUPER_ADMIN', 'GERENCIA']),
        requiere_aprobacion_financiera: true,
      })
    }
  }

  public async down() {
    await this.db.from('tipos_ticket').where('codigo', 'EXCEPCION_DATEO').delete()
  }
}
