import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Cargos "PALETERA" y "CAJERO(A)" (mismo patrón que 1787000000013, LIDER
 * NACIONAL). Buscar siempre por nombre: el id cambia entre entornos.
 */
const NOMBRES = ['PALETERA', 'CAJERO(A)']

export default class InsertPaleteraCajeroCargos extends BaseSchema {
  public async up() {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

    for (const nombre of NOMBRES) {
      const cargoExiste = await this.db.from('cargos').where('nombre', nombre).first()
      if (!cargoExiste) {
        await this.db.table('cargos').insert({ nombre, created_at: now, updated_at: now })
      }
    }
  }

  /** Solo borra los cargos que ningún usuario ni contrato usa. */
  public async down() {
    for (const nombre of NOMBRES) {
      const cargo = await this.db.from('cargos').where('nombre', nombre).first()
      if (!cargo) continue

      const [usuarios] = await this.db.from('usuarios').where('cargo_id', cargo.id).count('* as n')
      const [contratos] = await this.db
        .from('contratos')
        .where('cargo_id', cargo.id)
        .count('* as n')
      if (Number(usuarios.n) + Number(contratos.n) > 0) continue

      await this.db.from('cargos').where('id', cargo.id).delete()
    }
  }
}
