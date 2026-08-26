import { BaseSchema } from '@adonisjs/lucid/schema'

/**
 * Fix del bug de cancelación de turnos_rtms (500 al cancelar por choque de
 * índice único): los índices únicos uq_turno_por_dia_y_sede y
 * uq_turno_por_servicio_dia_sede son incondicionales sobre turno_numero /
 * turno_numero_servicio, sin distinguir positivo (activo/finalizado) de
 * negativo (liberado por cancelación). Como el sistema reutiliza números
 * liberados por cancelaciones para turnos nuevos, dos turnos cancelados en
 * momentos distintos pueden terminar queriendo el mismo valor negativo
 * (-N) y violar el índice único (caso real: turnos 59489 y 59531, ambos
 * con turno_numero=25 en distintos momentos).
 *
 * Mismo patrón ya usado en 1784900002000_add_dedupe_key_to_turnos_rtms_table
 * para un problema análogo con dedupe_key: se reemplaza el índice único
 * incondicional por uno sobre una columna generada STORED que da NULL
 * cuando el turno está cancelado (turno_numero <= 0), y MySQL permite
 * múltiples NULL en un índice único. No se toca turno_numero /
 * turno_numero_servicio ni ningún código de app — cancelar(), store() y
 * GET /turnos-rtm/siguiente-turno siguen dependiendo de ABS(turno_numero)
 * exactamente igual que antes.
 *
 * Chequeo previo contra information_schema (mismo patrón que 1784900002000
 * y 1784900004000): MySQL no soporta "ADD COLUMN/INDEX IF NOT EXISTS" en
 * esta versión, así que cada paso se verifica a mano para que un reintento
 * después de una falla a mitad de camino sea seguro.
 */
export default class AddTurnoNumeroActivoUniqueToTurnosRtms extends BaseSchema {
  protected tableName = 'turnos_rtms'

  private async columnExists(name: string): Promise<boolean> {
    const rows = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.columns
       WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`,
      [this.tableName, name]
    )
    return rows[0].length > 0
  }

  private async indexExists(name: string): Promise<boolean> {
    const rows = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.statistics
       WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?`,
      [this.tableName, name]
    )
    return rows[0].length > 0
  }

  public async up() {
    // Orden importante: primero se crean las columnas generadas y los
    // índices únicos NUEVOS, y solo al final se borran los viejos.
    // Motivo (descubierto al correr esta migración contra -pruebas):
    // uq_turno_por_dia_y_sede y uq_turno_por_servicio_dia_sede son, además,
    // los únicos índices con sede_id como columna líder que respaldan la FK
    // turnos_rtms_sede_id_foreign (idx_turno_fecha_sede está en orden
    // (fecha, sede_id), no sirve). Si se borran ambos antes de que exista un
    // reemplazo, InnoDB rechaza el DROP INDEX con "needed in a foreign key
    // constraint". Creando primero uq_turno_numero_activo_por_dia_sede
    // (también con sede_id al frente) se garantiza que la FK siempre tenga
    // un índice de respaldo válido en todo momento.

    // 1) Columnas generadas: NULL cuando el turno está cancelado
    //    (turno_numero / turno_numero_servicio <= 0), valor real si está
    //    activo/finalizado (> 0)
    if (!(await this.columnExists('turno_numero_activo'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD COLUMN turno_numero_activo INT
            GENERATED ALWAYS AS (
              CASE WHEN turno_numero > 0 THEN turno_numero ELSE NULL END
            ) STORED
      `)
    }

    if (!(await this.columnExists('turno_numero_servicio_activo'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD COLUMN turno_numero_servicio_activo INT
            GENERATED ALWAYS AS (
              CASE WHEN turno_numero_servicio > 0 THEN turno_numero_servicio ELSE NULL END
            ) STORED
      `)
    }

    // 3) Nuevos índices únicos sobre las columnas generadas
    if (!(await this.indexExists('uq_turno_numero_activo_por_dia_sede'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD UNIQUE INDEX uq_turno_numero_activo_por_dia_sede
            (sede_id, fecha, turno_numero_activo)
      `)
    }

    if (!(await this.indexExists('uq_turno_numero_servicio_activo_por_dia_sede'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD UNIQUE INDEX uq_turno_numero_servicio_activo_por_dia_sede
            (sede_id, fecha, servicio_id, turno_numero_servicio_activo)
      `)
    }

    // 2) Recién ahora, con el índice de reemplazo ya en pie, se pueden
    //    borrar los índices únicos incondicionales viejos sin que InnoDB
    //    se queje de dejar la FK de sede_id sin índice de respaldo.
    if (await this.indexExists('uq_turno_por_dia_y_sede')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP INDEX uq_turno_por_dia_y_sede
      `)
    }
    if (await this.indexExists('uq_turno_por_servicio_dia_sede')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP INDEX uq_turno_por_servicio_dia_sede
      `)
    }
  }

  public async down() {
    // Mismo cuidado que en up(): nunca dejar la tabla, ni siquiera a mitad
    // de camino, sin un índice con sede_id como columna líder (lo exige la
    // FK turnos_rtms_sede_id_foreign). Por eso primero se recrean los
    // índices viejos y solo después se borran los nuevos y las columnas
    // generadas.
    if (!(await this.indexExists('uq_turno_por_dia_y_sede'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD UNIQUE INDEX uq_turno_por_dia_y_sede (sede_id, fecha, turno_numero)
      `)
    }
    if (!(await this.indexExists('uq_turno_por_servicio_dia_sede'))) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          ADD UNIQUE INDEX uq_turno_por_servicio_dia_sede
            (sede_id, fecha, servicio_id, turno_numero_servicio)
      `)
    }

    if (await this.indexExists('uq_turno_numero_activo_por_dia_sede')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP INDEX uq_turno_numero_activo_por_dia_sede
      `)
    }
    if (await this.indexExists('uq_turno_numero_servicio_activo_por_dia_sede')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP INDEX uq_turno_numero_servicio_activo_por_dia_sede
      `)
    }

    if (await this.columnExists('turno_numero_activo')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP COLUMN turno_numero_activo
      `)
    }
    if (await this.columnExists('turno_numero_servicio_activo')) {
      await this.db.rawQuery(`
        ALTER TABLE ${this.tableName}
          DROP COLUMN turno_numero_servicio_activo
      `)
    }
  }
}
