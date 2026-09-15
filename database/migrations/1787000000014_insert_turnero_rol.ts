import { BaseSchema } from '@adonisjs/lucid/schema'

// Mismo patrón que 1779495000000_insert_tramitador_rol_cargo.ts: insert
// idempotente directo a la tabla, porque no existe un POST /roles — la única
// forma de agregar un rol nuevo en este sistema es una migración.
// A diferencia de TRAMITADOR, este rol no necesita un cargo propio (cargo_id
// es nullable en usuarios y este usuario no tiene nómina real).
export default class InsertTurneroRol extends BaseSchema {
  public async up() {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

    const rolExiste = await this.db.from('roles').where('nombre', 'TURNERO').first()
    if (!rolExiste) {
      await this.db.table('roles').insert({ nombre: 'TURNERO', created_at: now, updated_at: now })
    }
  }

  public async down() {
    await this.db.from('roles').where('nombre', 'TURNERO').delete()
  }
}
