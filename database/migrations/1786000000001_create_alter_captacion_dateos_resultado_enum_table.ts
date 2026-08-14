import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'captacion_dateos'

  public async up() {
    await this.schema.raw(`
      ALTER TABLE \`${this.tableName}\`
      MODIFY COLUMN \`resultado\`
      ENUM('PENDIENTE','EN_PROCESO','EXITOSO','NO_EXITOSO','RE_DATEAR','REEMPLAZADO')
      NOT NULL DEFAULT 'PENDIENTE'
    `)
  }

  public async down() {
    // 🔒 Guard: si ya hay filas usando el valor nuevo, revertir el enum las
    // dejaría en un estado inválido (MySQL las convertiría silenciosamente
    // a '' o al primer valor del enum al hacer MODIFY con un valor faltante
    // en la lista). Mejor fallar explícito y forzar una decisión manual.
    const [row] = await this.db
      .from(this.tableName)
      .where('resultado', 'REEMPLAZADO')
      .count('* as total')

    const total = Number(row?.total ?? 0)
    if (total > 0) {
      throw new Error(
        `No se puede revertir: existen ${total} fila(s) con resultado='REEMPLAZADO' en '${this.tableName}'. ` +
          `Migra o elimina esas filas manualmente antes de correr este rollback.`
      )
    }

    await this.schema.raw(`
      ALTER TABLE \`${this.tableName}\`
      MODIFY COLUMN \`resultado\`
      ENUM('PENDIENTE','EN_PROCESO','EXITOSO','NO_EXITOSO','RE_DATEAR')
      NOT NULL DEFAULT 'PENDIENTE'
    `)
  }
}
