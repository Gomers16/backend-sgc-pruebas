// database/migrations/1793000000000_create_certificacion_resultado_cambios_table.ts
//
// "Segunda vez" — Entrega C2: auditoría de las correcciones del resultado de
// una certificación RTM/PREV (PATCH /certificaciones/:turnoId/resultado,
// solo SUPER_ADMIN/GERENCIA, motivo obligatorio). Tabla nueva y aditiva: no
// toca ninguna tabla existente (las FK solo toman un candado breve de
// metadatos sobre turnos_rtms/usuarios al crearse).
//
// SQL explícito (no schema builder) para que lo revisado sea exactamente lo
// que se ejecuta. CREATE TABLE IF NOT EXISTS: idempotente.
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class CreateCertificacionResultadoCambios extends BaseSchema {
  protected tableName = 'certificacion_resultado_cambios'

  public async up() {
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')
    await this.db.rawQuery(`
      CREATE TABLE IF NOT EXISTS certificacion_resultado_cambios (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        turno_id INT UNSIGNED NOT NULL,
        resultado_anterior ENUM('APROBADA','RECHAZADA') NULL DEFAULT NULL,
        resultado_nuevo ENUM('APROBADA','RECHAZADA') NOT NULL,
        motivo VARCHAR(255) NOT NULL,
        usuario_id INT UNSIGNED NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_crc_turno (turno_id),
        KEY idx_crc_usuario (usuario_id),
        CONSTRAINT fk_crc_turno FOREIGN KEY (turno_id) REFERENCES turnos_rtms (id) ON DELETE CASCADE,
        CONSTRAINT fk_crc_usuario FOREIGN KEY (usuario_id) REFERENCES usuarios (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  }

  public async down() {
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')
    await this.db.rawQuery('DROP TABLE IF EXISTS certificacion_resultado_cambios')
  }
}
