import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import { backfill, SEDE_IBAGUE } from '../database/helpers/multisede.js'

/**
 * Multi-sede — vuelve a correr el backfill de sede de usuarios (y de los
 * agentes y convenios de los que depende), con la MISMA regla que la
 * migración 1811000000001. Solo toca filas con sede_id NULL.
 *
 * Para cuando código viejo (producción local o servidor antes de sincronizar)
 * siguió creando usuarios / agentes / convenios sin sede después de migrar.
 * Paso (d) del checklist de despliegue: debe terminar con 0 usuarios sin sede.
 *
 * Sin --aplicar: dry-run (una transacción que se deshace, con conteos).
 *
 *   node ace multisede:rebackfill-usuarios
 *   node ace multisede:rebackfill-usuarios --aplicar
 */
const ESPEJO = `EXISTS (SELECT 1 FROM agentes_captacions ae
                       WHERE ae.usuario_id = usuarios.id AND ae.tipo = 'ASESOR_CONVENIO')`

export default class MultisedeRebackfillUsuarios extends BaseCommand {
  static commandName = 'multisede:rebackfill-usuarios'
  static description =
    'Rellena sede_id NULL de usuarios, agentes y convenios (regla de la migración 1811000000001)'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Escribe los cambios (sin esto es dry-run)' })
  declare aplicar?: boolean

  async run() {
    const trx = await db.transaction()
    try {
      const c = trx as any
      await backfill(
        c,
        'usuarios',
        [
          {
            desc: 'no espejo → Ibagué',
            sql: `UPDATE usuarios SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL AND NOT ${ESPEJO}`,
          },
        ],
        { permitirNull: ESPEJO }
      )
      await backfill(
        c,
        'agentes_captacions',
        [
          {
            desc: 'no convenio ← usuario',
            sql: `UPDATE agentes_captacions a JOIN usuarios u ON u.id = a.usuario_id
                     SET a.sede_id = u.sede_id
                   WHERE a.sede_id IS NULL AND a.tipo <> 'ASESOR_CONVENIO' AND u.sede_id IS NOT NULL`,
          },
          {
            desc: 'no convenio sin usuario → Ibagué',
            sql: `UPDATE agentes_captacions SET sede_id = ${SEDE_IBAGUE}
                   WHERE sede_id IS NULL AND tipo <> 'ASESOR_CONVENIO'`,
          },
        ],
        { permitirNull: `tipo = 'ASESOR_CONVENIO'` }
      )
      await backfill(c, 'convenios', [
        {
          desc: '← asesor asignado activo',
          sql: `UPDATE convenios cv JOIN (
                  SELECT aca.convenio_id, MAX(a.sede_id) AS s
                    FROM asesor_convenio_asignaciones aca
                    JOIN agentes_captacions a ON a.id = aca.asesor_id
                   WHERE aca.activo = 1 AND aca.fecha_fin IS NULL AND a.sede_id IS NOT NULL
                   GROUP BY aca.convenio_id) x ON x.convenio_id = cv.id
                   SET cv.sede_id = x.s WHERE cv.sede_id IS NULL`,
        },
        {
          desc: '← usuario de su agente',
          sql: `UPDATE convenios cv
                  JOIN agentes_captacions a ON a.id = cv.asesor_convenio_id
                  JOIN usuarios u ON u.id = a.usuario_id
                   SET cv.sede_id = u.sede_id
                 WHERE cv.sede_id IS NULL AND u.sede_id IS NOT NULL`,
        },
        {
          desc: 'resto → Ibagué',
          sql: `UPDATE convenios SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
        },
      ])
      await backfill(c, 'agentes_captacions', [
        {
          desc: 'convenio ← su convenio',
          sql: `UPDATE agentes_captacions a JOIN (
                  SELECT asesor_convenio_id AS aid, MIN(sede_id) AS s FROM convenios
                   WHERE asesor_convenio_id IS NOT NULL GROUP BY asesor_convenio_id) x
                    ON x.aid = a.id
                   SET a.sede_id = x.s WHERE a.sede_id IS NULL`,
        },
        {
          desc: 'resto → Ibagué',
          sql: `UPDATE agentes_captacions SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
        },
      ])
      await backfill(c, 'usuarios', [
        {
          desc: 'espejo ← su agente de convenio',
          sql: `UPDATE usuarios u JOIN (
                  SELECT usuario_id, MIN(sede_id) AS s FROM agentes_captacions
                   WHERE tipo = 'ASESOR_CONVENIO' AND usuario_id IS NOT NULL
                   GROUP BY usuario_id) x ON x.usuario_id = u.id
                   SET u.sede_id = x.s WHERE u.sede_id IS NULL`,
        },
        {
          desc: 'resto → Ibagué',
          sql: `UPDATE usuarios SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
        },
      ])

      const [r] = await c.rawQuery('SELECT COUNT(*) AS n FROM usuarios WHERE sede_id IS NULL')
      this.logger.info(`Usuarios sin sede al final: ${r[0].n}`)
      if (this.aplicar) {
        await trx.commit()
        this.logger.success('Aplicado.')
      } else {
        await trx.rollback()
        this.logger.info('Dry-run: nada escrito. Usa --aplicar para escribir.')
      }
    } catch (error) {
      await trx.rollback()
      this.logger.error((error as Error).message)
      this.exitCode = 1
    }
  }
}
