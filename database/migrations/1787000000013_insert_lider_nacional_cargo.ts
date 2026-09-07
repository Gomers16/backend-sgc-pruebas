import { BaseSchema } from '@adonisjs/lucid/schema'

export default class InsertLiderNacionalCargo extends BaseSchema {
  public async up() {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

    const cargoExiste = await this.db.from('cargos').where('nombre', 'LIDER NACIONAL').first()
    if (!cargoExiste) {
      await this.db.table('cargos').insert({ nombre: 'LIDER NACIONAL', created_at: now, updated_at: now })
    }
  }

  public async down() {
    await this.db.from('cargos').where('nombre', 'LIDER NACIONAL').delete()
  }
}
