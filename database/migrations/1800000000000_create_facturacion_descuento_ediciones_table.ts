// database/migrations/1800000000000_create_facturacion_descuento_ediciones_table.ts
//
// Edición del descuento de un ticket ya CONFIRMADA (Facturación / Historial,
// solo SUPER_ADMIN / GERENCIA, PATCH /facturacion/tickets/:id con
// motivo_edicion). Una fila por edición guardada: quién, cuándo, descuento,
// monto, total y consecutivo antes y después, motivo, y qué pasó con la
// comisión del dateo del turno (id, estado, acción tomada, montos antes y
// después). Mismo estilo que facturacion_consecutivo_descuento_cambios
// (1795000000000).
//
// Aditiva: solo crea la tabla, no toca facturacion_tickets ni comisiones.
// CREATE TABLE IF NOT EXISTS para que un reintento sea seguro.
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class CreateFacturacionDescuentoEdicionesTable extends BaseSchema {
  protected tableName = 'facturacion_descuento_ediciones'

  public async up() {
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')
    await this.db.rawQuery(`
      CREATE TABLE IF NOT EXISTS ${this.tableName} (
        id INT UNSIGNED NOT NULL AUTO_INCREMENT,
        facturacion_ticket_id INT UNSIGNED NOT NULL,
        descuento_id_anterior INT UNSIGNED NULL DEFAULT NULL,
        descuento_id_nuevo INT UNSIGNED NULL DEFAULT NULL,
        descuento_nombre_anterior VARCHAR(150) NULL DEFAULT NULL,
        descuento_nombre_nuevo VARCHAR(150) NULL DEFAULT NULL,
        monto_anterior DECIMAL(14,2) NULL DEFAULT NULL,
        monto_nuevo DECIMAL(14,2) NULL DEFAULT NULL,
        total_anterior DECIMAL(14,2) NULL DEFAULT NULL,
        total_nuevo DECIMAL(14,2) NULL DEFAULT NULL,
        consecutivo_anterior VARCHAR(30) NULL DEFAULT NULL,
        consecutivo_nuevo VARCHAR(30) NULL DEFAULT NULL,
        autorizado_por_id_anterior INT UNSIGNED NULL DEFAULT NULL,
        autorizado_por_id_nuevo INT UNSIGNED NULL DEFAULT NULL,
        observacion_anterior TEXT NULL,
        observacion_nueva TEXT NULL,
        motivo VARCHAR(255) NOT NULL,
        comision_id INT UNSIGNED NULL DEFAULT NULL,
        comision_estado VARCHAR(20) NULL DEFAULT NULL,
        comision_accion VARCHAR(30) NOT NULL,
        comision_mensaje VARCHAR(255) NULL DEFAULT NULL,
        comision_monto_anterior DECIMAL(12,2) NULL DEFAULT NULL,
        comision_monto_nuevo DECIMAL(12,2) NULL DEFAULT NULL,
        comision_monto_asesor_anterior DECIMAL(12,2) NULL DEFAULT NULL,
        comision_monto_asesor_nuevo DECIMAL(12,2) NULL DEFAULT NULL,
        comision_monto_convenio_anterior DECIMAL(12,2) NULL DEFAULT NULL,
        comision_monto_convenio_nuevo DECIMAL(12,2) NULL DEFAULT NULL,
        usuario_id INT UNSIGNED NULL DEFAULT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id),
        KEY idx_fde_ticket (facturacion_ticket_id),
        KEY idx_fde_usuario (usuario_id),
        KEY idx_fde_comision (comision_id),
        CONSTRAINT fk_fde_ticket FOREIGN KEY (facturacion_ticket_id)
          REFERENCES facturacion_tickets (id) ON DELETE CASCADE,
        CONSTRAINT fk_fde_usuario FOREIGN KEY (usuario_id)
          REFERENCES usuarios (id) ON DELETE SET NULL
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
    `)
  }

  public async down() {
    await this.db.rawQuery('SET SESSION lock_wait_timeout = 5')
    await this.db.rawQuery(`DROP TABLE IF EXISTS ${this.tableName}`)
  }
}
