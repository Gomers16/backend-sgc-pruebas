import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Cargo "ASESOR TELEMERCADEO" (mismo patrón que 1787000000013, LIDER NACIONAL).
 *
 * Un contrato con este cargo convierte el agente del usuario en
 * ASESOR_TELEMERCADEO (contratos_controller.ts::ensureAgenteYConvenioParaContrato,
 * que busca 'TELEMERCADEO' en el nombre del cargo). Buscar siempre por nombre,
 * nunca por id: el id cambia entre entornos.
 *
 * ⚠️ BD compartida pruebas / producción local: al sincronizar, copiar esta
 * migración junto con el código y NO correr rollback desde producción local.
 */
const NOMBRE = 'ASESOR TELEMERCADEO'

export default class InsertAsesorTelemercadeoCargo extends BaseSchema {
  public async up() {
    const now = new Date().toISOString().replace('T', ' ').substring(0, 19)

    const cargoExiste = await this.db.from('cargos').where('nombre', NOMBRE).first()
    if (!cargoExiste) {
      await this.db.table('cargos').insert({ nombre: NOMBRE, created_at: now, updated_at: now })
    }
  }

  /** Solo borra el cargo si ningún usuario ni contrato lo usa. */
  public async down() {
    const cargo = await this.db.from('cargos').where('nombre', NOMBRE).first()
    if (!cargo) return

    const [usuarios] = await this.db.from('usuarios').where('cargo_id', cargo.id).count('* as n')
    const [contratos] = await this.db.from('contratos').where('cargo_id', cargo.id).count('* as n')
    if (Number(usuarios.n) + Number(contratos.n) > 0) return

    await this.db.from('cargos').where('id', cargo.id).delete()
  }
}
