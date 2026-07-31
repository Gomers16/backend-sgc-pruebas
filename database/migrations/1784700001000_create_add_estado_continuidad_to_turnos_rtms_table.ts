// database/migrations/1784700001000_create_add_estado_continuidad_to_turnos_rtms_table.ts
import { BaseSchema } from '@adonisjs/lucid/schema'

export default class extends BaseSchema {
  protected tableName = 'turnos_rtms'

  async up() {
    this.schema.alterTable(this.tableName, (table) => {
      /**
       * Resultado de la evaluación de continuidad de asesor convenio para
       * este turno. NULL cuando el turno no vino por dateo de asesor convenio
       * (no aplica). Se guarda aquí para no tener que recalcular todo el
       * historial cada vez que se muestra en la pestaña Continuidad.
       *
       * CONTINUA      → todas las visitas previas vinculadas a dateo coinciden
       *                 con el mismo asesor/convenio (o hubo override FORZAR_SI)
       * ROTA          → hubo al menos una visita previa con otro asesor/convenio
       *                 (o dato NULL posterior al corte de confiabilidad),
       *                 o hubo override FORZAR_NO
       * SIN_EVIDENCIA → no hay historial vinculado a dateo para decidir, o el
       *                 único conflicto encontrado es NULL histórico anterior
       *                 al corte de datos confiables — hoy se paga como
       *                 continuidad completa por decisión de negocio, pero
       *                 queda marcado como no verificado, no como confirmado
       */
      table
        .enu('estado_continuidad', ['CONTINUA', 'ROTA', 'SIN_EVIDENCIA'], {
          useNative: true,
          enumName: 'turno_estado_continuidad_enum',
        })
        .nullable()
        .after('es_avance')

      table.index(['estado_continuidad'], 'idx_turnos_estado_continuidad')
    })
  }

  async down() {
    this.schema.alterTable(this.tableName, (table) => {
      table.dropIndex(['estado_continuidad'], 'idx_turnos_estado_continuidad')
      table.dropColumn('estado_continuidad')
    })
  }
}
