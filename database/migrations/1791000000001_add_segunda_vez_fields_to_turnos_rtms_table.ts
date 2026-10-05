import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * "Segunda vez" (Entrega A): columnas aditivas en turnos_rtms.
 *
 *  - resultado_certificacion: copia del resultado de la certificación
 *    (RTM/PREV). NULL = sin resultado → para la vigencia se trata como
 *    aprobado (ver segunda_vez_service.ts). No se rellena el histórico.
 *  - rechazado_at / ventana_segunda_vez_hasta: instante del rechazo (hora
 *    del servidor, Bogotá) y rechazado_at + 360 h. La ventana está abierta
 *    solo si ahora < ventana_segunda_vez_hasta.
 *  - es_segunda_vez / turno_origen_id: marcan el turno de regreso y el
 *    turno rechazado que lo originó. turno_origen_id va SIN foreign key a
 *    propósito en esta entrega (la FK se evalúa en la Entrega B).
 *  - segunda_vez_excepcion*: excepción manual (FORZADA / NO_APLICADA),
 *    quién la aplicó y por qué. Solo esquema en esta entrega.
 *
 * Todas son NULL o NOT NULL con DEFAULT y van al final de la tabla, así que
 * el ALTER es ALGORITHM=INSTANT (MySQL >= 8.0.29): solo metadata, sin copiar
 * la tabla ni reconstruir índices ni las columnas generadas existentes
 * (dedupe_key, turno_numero_activo, ...). Si el servidor no pudiera hacerlo
 * INSTANT, el ALTER falla en vez de degradar en silencio a COPY.
 *
 * Idempotente: solo agrega las columnas que falten (information_schema).
 */
export default class AddSegundaVezFieldsToTurnosRtms extends BaseSchema {
  protected tableName = 'turnos_rtms'

  private readonly columnas: Array<[string, string]> = [
    ['resultado_certificacion', `ENUM('APROBADA','RECHAZADA') NULL DEFAULT NULL`],
    ['rechazado_at', `DATETIME NULL DEFAULT NULL`],
    ['ventana_segunda_vez_hasta', `DATETIME NULL DEFAULT NULL`],
    ['es_segunda_vez', `TINYINT(1) NOT NULL DEFAULT 0`],
    ['turno_origen_id', `INT UNSIGNED NULL DEFAULT NULL`],
    ['segunda_vez_excepcion', `ENUM('FORZADA','NO_APLICADA') NULL DEFAULT NULL`],
    ['segunda_vez_excepcion_por_id', `INT UNSIGNED NULL DEFAULT NULL`],
    ['segunda_vez_excepcion_motivo', `VARCHAR(255) NULL DEFAULT NULL`],
  ]

  private async columnExists(name: string): Promise<boolean> {
    const rows = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [this.tableName, name]
    )
    return rows[0].length > 0
  }

  public async up() {
    const faltantes: string[] = []
    for (const [nombre, definicion] of this.columnas) {
      if (!(await this.columnExists(nombre))) faltantes.push(`ADD COLUMN ${nombre} ${definicion}`)
    }
    if (faltantes.length === 0) return

    // Falla rápido si no consigue el MDL, en vez de encolar consultas.
    // this.db es el TransactionClient de la migración → misma conexión.
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')
    await this.db.rawQuery(`
      ALTER TABLE ${this.tableName}
        ${faltantes.join(',\n        ')},
        ALGORITHM=INSTANT
    `)
  }

  public async down() {
    const presentes: string[] = []
    for (const [nombre] of [...this.columnas].reverse()) {
      if (await this.columnExists(nombre)) presentes.push(`DROP COLUMN ${nombre}`)
    }
    if (presentes.length === 0) return

    await this.db.rawQuery(`
      ALTER TABLE ${this.tableName}
        ${presentes.join(',\n        ')},
        ALGORITHM=INSTANT
    `)
  }
}
