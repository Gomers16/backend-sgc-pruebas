import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * "Segunda vez" — Entrega B2: permitir la segunda vez el MISMO día del rechazo.
 *
 * 1) dedupe_key pasa a incluir es_segunda_vez: el origen (0) y su segunda vez
 *    (1) pueden convivir el mismo día/sede/servicio/placa; dos turnos
 *    normales (o dos segundas veces) siguen chocando en
 *    uq_turno_activo_por_placa_servicio_dia.
 * 2) segunda_vez_origen_activo = turno_origen_id si es_segunda_vez=1 y
 *    estado<>'cancelado' (NULL si no), con índice único: una sola segunda
 *    vez activa por origen también a nivel de BD (cancelarla libera el índice).
 *
 * Estrategia (ensayada en una copia, MySQL 9.4, sin ALGORITHM=COPY): "primero
 * lo nuevo, después lo viejo", y la columna STORED vieja NO se borra (en 9.4
 * un DROP COLUMN STORED con columnas virtuales en la tabla exige COPY):
 *   a) ADD COLUMN dedupe_key_b2 + segunda_vez_origen_activo (VIRTUAL) — INSTANT
 *   b) ADD UNIQUE INDEX sobre ambas — INPLACE, LOCK=NONE (sin reconstruir)
 *   c) DROP INDEX uq_turno_activo_por_placa_servicio_dia (viejo) — INPLACE, LOCK=NONE
 *   d) en un solo ALTER, INPLACE, LOCK=NONE (solo metadata):
 *        dedupe_key → dedupe_key_a (STORED vieja, ya sin índice)
 *        dedupe_key_b2 → dedupe_key
 *        uq_turno_activo_b2 → uq_turno_activo_por_placa_servicio_dia
 *      así el código (catch de ER_DUP_ENTRY) y la documentación no cambian.
 * PENDIENTE (no aquí): borrar dedupe_key_a en una ventana de baja operación
 * con ALGORITHM=COPY.
 *
 * La FK turnos_rtms_sede_id_foreign se apoya en uq_turno_numero_*_por_dia_sede
 * / idx_turno_fecha_sede (empiezan por sede_id): no se tocan.
 *
 * SET SESSION lock_wait_timeout = 5 en la misma conexión (this.db es el
 * TransactionClient de la migración). Idempotente: cada paso comprueba
 * information_schema, así que si un paso falla se puede volver a correr.
 */
export default class SegundaVezMismoDiaDedupe extends BaseSchema {
  protected tableName = 'turnos_rtms'

  private readonly EXPR_DEDUPE_B2 = `CASE WHEN estado = 'cancelado' THEN NULL ELSE CONCAT(sede_id, '|', fecha, '|', servicio_id, '|', UPPER(TRIM(placa)), '|', es_segunda_vez) END`
  private readonly EXPR_ORIGEN_ACTIVO = `CASE WHEN es_segunda_vez = 1 AND estado <> 'cancelado' THEN turno_origen_id ELSE NULL END`

  private async columna(name: string): Promise<{ expr: string } | null> {
    const rows = await this.db.rawQuery(
      `SELECT generation_expression AS expr FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [this.tableName, name]
    )
    return rows[0][0] ?? null
  }

  private async indice(name: string): Promise<boolean> {
    const rows = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [this.tableName, name]
    )
    return rows[0].length > 0
  }

  private alter(sql: string) {
    return this.db.rawQuery(`ALTER TABLE ${this.tableName} ${sql}`)
  }

  public async up() {
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')

    const dedupe = await this.columna('dedupe_key')
    const yaRenombrada = !!dedupe && dedupe.expr.includes('es_segunda_vez')

    // a) columnas nuevas
    const add: string[] = []
    if (!yaRenombrada && !(await this.columna('dedupe_key_b2'))) {
      add.push(
        `ADD COLUMN dedupe_key_b2 VARCHAR(191) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci GENERATED ALWAYS AS (${this.EXPR_DEDUPE_B2}) VIRTUAL`
      )
    }
    if (!(await this.columna('segunda_vez_origen_activo'))) {
      add.push(
        `ADD COLUMN segunda_vez_origen_activo INT UNSIGNED GENERATED ALWAYS AS (${this.EXPR_ORIGEN_ACTIVO}) VIRTUAL`
      )
    }
    if (add.length) await this.alter(`${add.join(', ')}, ALGORITHM=INSTANT`)

    // b) índices únicos nuevos
    const idx: string[] = []
    if (!yaRenombrada && !(await this.indice('uq_turno_activo_b2'))) {
      idx.push('ADD UNIQUE INDEX uq_turno_activo_b2 (dedupe_key_b2)')
    }
    if (!(await this.indice('uq_segunda_vez_origen_activo'))) {
      idx.push('ADD UNIQUE INDEX uq_segunda_vez_origen_activo (segunda_vez_origen_activo)')
    }
    if (idx.length) await this.alter(`${idx.join(', ')}, ALGORITHM=INPLACE, LOCK=NONE`)

    if (yaRenombrada) return

    // c) índice viejo (sobre la dedupe_key STORED de la Entrega A)
    if (await this.indice('uq_turno_activo_por_placa_servicio_dia')) {
      await this.alter(
        'DROP INDEX uq_turno_activo_por_placa_servicio_dia, ALGORITHM=INPLACE, LOCK=NONE'
      )
    }

    // d) renombres en un solo ALTER (solo metadata)
    await this.alter(
      `RENAME COLUMN dedupe_key TO dedupe_key_a,
       RENAME COLUMN dedupe_key_b2 TO dedupe_key,
       RENAME INDEX uq_turno_activo_b2 TO uq_turno_activo_por_placa_servicio_dia,
       ALGORITHM=INPLACE, LOCK=NONE`
    )
  }

  /**
   * Vuelve al dedupe_key de la Entrega A (la columna STORED conservada como
   * dedupe_key_a). Falla si ya hay un origen y su segunda vez el mismo
   * día/sede (el índice viejo no lo admite): hay que cancelar una de las dos
   * antes de revertir. Si dedupe_key_a ya se borró (pendiente con COPY), no
   * hay forma de revertir sin reconstruir la tabla: se aborta con un error.
   */
  public async down() {
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')

    const dedupe = await this.columna('dedupe_key')
    if (dedupe && dedupe.expr.includes('es_segunda_vez')) {
      if (!(await this.columna('dedupe_key_a'))) {
        throw new Error(
          'dedupe_key_a ya no existe: revertir B2 exige reconstruir dedupe_key (STORED) con ALGORITHM=COPY a mano.'
        )
      }
      // Primero lo viejo vuelve a tener índice, después se quita el nuevo.
      if (!(await this.indice('uq_turno_activo_a'))) {
        await this.alter(
          'ADD UNIQUE INDEX uq_turno_activo_a (dedupe_key_a), ALGORITHM=INPLACE, LOCK=NONE'
        )
      }
      await this.alter(
        'DROP INDEX uq_turno_activo_por_placa_servicio_dia, ALGORITHM=INPLACE, LOCK=NONE'
      )
      await this.alter(
        `RENAME COLUMN dedupe_key TO dedupe_key_b2,
         RENAME COLUMN dedupe_key_a TO dedupe_key,
         RENAME INDEX uq_turno_activo_a TO uq_turno_activo_por_placa_servicio_dia,
         ALGORITHM=INPLACE, LOCK=NONE`
      )
    }

    // Columnas/índices virtuales de B2: un DROP de columna virtual va solo en su ALTER.
    if (await this.indice('uq_segunda_vez_origen_activo')) {
      await this.alter('DROP INDEX uq_segunda_vez_origen_activo, ALGORITHM=INPLACE, LOCK=NONE')
    }
    if (await this.columna('segunda_vez_origen_activo')) {
      await this.alter('DROP COLUMN segunda_vez_origen_activo, ALGORITHM=INSTANT')
    }
    if (await this.columna('dedupe_key_b2')) {
      await this.alter('DROP COLUMN dedupe_key_b2, ALGORITHM=INSTANT')
    }
  }
}
