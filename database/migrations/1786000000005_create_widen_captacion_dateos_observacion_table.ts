import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'captacion_dateos'

  public async up() {
    this.schema.alterTable(this.tableName, (table) => {
      table.text('observacion').nullable().alter()
    })
  }

  public async down() {
    // 🔒 Guard: si ya hay filas con observacion > 255 chars (algo casi
    // garantizado tras usar re-datear un par de veces), revertir a
    // VARCHAR(255) las truncaría en silencio. Mejor fallar explícito.
    const [row] = await this.db
      .from(this.tableName)
      .whereRaw('LENGTH(observacion) > 255')
      .count('* as total')

    const total = Number(row?.total ?? 0)
    if (total > 0) {
      throw new Error(
        `No se puede revertir: existen ${total} fila(s) con observacion de más de 255 caracteres en '${this.tableName}'. ` +
          `Recorta o migra esos valores manualmente antes de correr este rollback.`
      )
    }

    this.schema.alterTable(this.tableName, (table) => {
      table.string('observacion', 255).nullable().alter()
    })
  }
}
