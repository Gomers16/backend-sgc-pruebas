import { BaseSchema } from '@adonisjs/lucid/schema'
import { agregarSedeId, backfill, quitarSedeId, SEDE_IBAGUE } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 1 — sede de las tablas operativas raíz.
 *
 * sede_id (NULL + índice + FK; NOT NULL en la Fase 3) en captacion_dateos,
 * comisiones, comprobantes_pago, liquidaciones, tickets,
 * telemercadeo_gestiones, telemercadeo_ciclos, informes_discrepancias_rtm,
 * turnero_multimedia y turnero_mensajes_ticker. Las tablas hijas (llamados,
 * certificaciones, redateos, eventos, detalle de liquidación…) heredan por
 * join con su padre y no llevan columna.
 *
 * Además rellena facturacion_tickets.sede_id donde sea NULL (la columna ya
 * existe con FK; sigue nullable).
 *
 * Requiere 1811000000001 (sede de agentes, convenios y usuarios).
 * comisiones con es_config = 1 (configuración global o por asesor) quedan
 * con sede NULL: NULL = global; el asesor ya fija la sede de las suyas.
 * El índice único de telemercadeo_ciclos se cambia en la Fase 3g, cuando
 * el código ponga la sede al abrir un ciclo.
 */
const TABLAS = [
  'captacion_dateos',
  'comisiones',
  'comprobantes_pago',
  'liquidaciones',
  'tickets',
  'telemercadeo_gestiones',
  'telemercadeo_ciclos',
  'informes_discrepancias_rtm',
  'turnero_multimedia',
  'turnero_mensajes_ticker',
]

const ibague = (t: string, where = 'sede_id IS NULL') => ({
  desc: 'resto → Ibagué',
  sql: `UPDATE ${t} SET sede_id = ${SEDE_IBAGUE} WHERE ${where}`,
})

export default class MultisedeSedeOperativa extends BaseSchema {
  async up() {
    for (const t of TABLAS) await agregarSedeId(this.db, t)

    await backfill(this.db, 'captacion_dateos', [
      {
        desc: '← turno que lo consumió',
        sql: `UPDATE captacion_dateos d JOIN turnos_rtms t ON t.id = d.consumido_turno_id
                 SET d.sede_id = t.sede_id WHERE d.sede_id IS NULL`,
      },
      {
        desc: '← agente que dateó',
        sql: `UPDATE captacion_dateos d JOIN agentes_captacions a ON a.id = d.agente_id
                 SET d.sede_id = a.sede_id WHERE d.sede_id IS NULL AND a.sede_id IS NOT NULL`,
      },
      {
        desc: '← agente del convenio',
        sql: `UPDATE captacion_dateos d JOIN agentes_captacions a ON a.id = d.asesor_convenio_id
                 SET d.sede_id = a.sede_id WHERE d.sede_id IS NULL AND a.sede_id IS NOT NULL`,
      },
      {
        desc: '← convenio',
        sql: `UPDATE captacion_dateos d JOIN convenios c ON c.id = d.convenio_id
                 SET d.sede_id = c.sede_id WHERE d.sede_id IS NULL AND c.sede_id IS NOT NULL`,
      },
      ibague('captacion_dateos'),
    ])

    await backfill(
      this.db,
      'comisiones',
      [
        {
          desc: '← dateo',
          sql: `UPDATE comisiones c JOIN captacion_dateos d ON d.id = c.captacion_dateo_id
                   SET c.sede_id = d.sede_id
                 WHERE c.sede_id IS NULL AND c.es_config = 0`,
        },
        {
          desc: '← asesor',
          sql: `UPDATE comisiones c JOIN agentes_captacions a ON a.id = c.asesor_id
                   SET c.sede_id = a.sede_id
                 WHERE c.sede_id IS NULL AND c.es_config = 0 AND a.sede_id IS NOT NULL`,
        },
        ibague('comisiones', 'sede_id IS NULL AND es_config = 0'),
      ],
      { permitirNull: 'es_config = 1' }
    )

    await backfill(this.db, 'comprobantes_pago', [
      {
        desc: '← primera comisión',
        sql: `UPDATE comprobantes_pago p
                JOIN comisiones c
                  ON JSON_VALID(p.comision_ids)
                 AND c.id = CAST(JSON_UNQUOTE(JSON_EXTRACT(p.comision_ids, '$[0]')) AS UNSIGNED)
                 SET p.sede_id = c.sede_id
               WHERE p.sede_id IS NULL AND c.sede_id IS NOT NULL`,
      },
      {
        desc: '← usuario que lo generó',
        sql: `UPDATE comprobantes_pago p JOIN usuarios u ON u.id = p.generado_por
                 SET p.sede_id = u.sede_id WHERE p.sede_id IS NULL AND u.sede_id IS NOT NULL`,
      },
      ibague('comprobantes_pago'),
    ])

    const [mixtas] = await this.db.rawQuery(
      `SELECT COUNT(*) AS n FROM (
         SELECT ld.liquidacion_id FROM liquidacion_detalle ld
           JOIN comisiones c ON c.id = ld.comision_id
          GROUP BY ld.liquidacion_id HAVING COUNT(DISTINCT c.sede_id) > 1) z`
    )
    console.log(`[multisede] liquidaciones con comisiones de varias sedes: ${mixtas[0].n}`)
    await backfill(this.db, 'liquidaciones', [
      {
        desc: '← sus comisiones',
        sql: `UPDATE liquidaciones l JOIN (
                SELECT ld.liquidacion_id, MIN(c.sede_id) AS s FROM liquidacion_detalle ld
                  JOIN comisiones c ON c.id = ld.comision_id
                 WHERE c.sede_id IS NOT NULL GROUP BY ld.liquidacion_id) x
                  ON x.liquidacion_id = l.id
                 SET l.sede_id = x.s WHERE l.sede_id IS NULL`,
      },
      ibague('liquidaciones'),
    ])

    await backfill(this.db, 'tickets', [
      {
        desc: '← turno del detalle',
        sql: `UPDATE tickets k
                JOIN tickets_detalle_excepcion_dateo d ON d.ticket_id = k.id
                JOIN turnos_rtms t ON t.id = d.turno_id
                 SET k.sede_id = t.sede_id WHERE k.sede_id IS NULL`,
      },
      {
        desc: '← usuario que lo creó',
        sql: `UPDATE tickets k JOIN usuarios u ON u.id = k.creado_por_id
                 SET k.sede_id = u.sede_id WHERE k.sede_id IS NULL AND u.sede_id IS NOT NULL`,
      },
      ibague('tickets'),
    ])

    await backfill(this.db, 'telemercadeo_gestiones', [
      {
        desc: '← agente',
        sql: `UPDATE telemercadeo_gestiones g JOIN agentes_captacions a ON a.id = g.agente_id
                 SET g.sede_id = a.sede_id WHERE g.sede_id IS NULL AND a.sede_id IS NOT NULL`,
      },
      ibague('telemercadeo_gestiones'),
    ])
    await backfill(this.db, 'telemercadeo_ciclos', [
      {
        desc: '← última gestión',
        sql: `UPDATE telemercadeo_ciclos c JOIN (
                SELECT ciclo_id, CAST(SUBSTRING_INDEX(GROUP_CONCAT(sede_id ORDER BY id DESC), ',', 1)
                         AS UNSIGNED) AS s
                  FROM telemercadeo_gestiones WHERE sede_id IS NOT NULL GROUP BY ciclo_id) x
                  ON x.ciclo_id = c.id
                 SET c.sede_id = x.s WHERE c.sede_id IS NULL`,
      },
      ibague('telemercadeo_ciclos'),
    ])

    await backfill(this.db, 'informes_discrepancias_rtm', [
      {
        desc: '← usuario que lo generó',
        sql: `UPDATE informes_discrepancias_rtm i JOIN usuarios u ON u.id = i.generado_por_id
                 SET i.sede_id = u.sede_id WHERE i.sede_id IS NULL AND u.sede_id IS NOT NULL`,
      },
      ibague('informes_discrepancias_rtm'),
    ])
    await backfill(this.db, 'turnero_multimedia', [ibague('turnero_multimedia')])
    await backfill(this.db, 'turnero_mensajes_ticker', [ibague('turnero_mensajes_ticker')])

    // facturacion_tickets: solo rellenar los NULL (registro para down()).
    await this.db.rawQuery(
      `CREATE TABLE IF NOT EXISTS multisede_backfill_facturacion (
         facturacion_ticket_id INT UNSIGNED NOT NULL PRIMARY KEY
       )`
    )
    await this.db.rawQuery(
      `INSERT IGNORE INTO multisede_backfill_facturacion (facturacion_ticket_id)
       SELECT id FROM facturacion_tickets WHERE sede_id IS NULL`
    )
    await backfill(this.db, 'facturacion_tickets', [
      {
        desc: '← turno',
        sql: `UPDATE facturacion_tickets f JOIN turnos_rtms t ON t.id = f.turno_id
                 SET f.sede_id = t.sede_id WHERE f.sede_id IS NULL`,
      },
      {
        desc: '← usuario que lo subió',
        sql: `UPDATE facturacion_tickets f JOIN usuarios u ON u.id = f.created_by_id
                 SET f.sede_id = u.sede_id WHERE f.sede_id IS NULL AND u.sede_id IS NOT NULL`,
      },
      ibague('facturacion_tickets'),
    ])
  }

  async down() {
    const [t] = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'multisede_backfill_facturacion'`
    )
    if (t.length) {
      await this.db.rawQuery(
        `UPDATE facturacion_tickets f
           JOIN multisede_backfill_facturacion b ON b.facturacion_ticket_id = f.id
            SET f.sede_id = NULL`
      )
      await this.db.rawQuery(`DROP TABLE multisede_backfill_facturacion`)
    }
    for (const tabla of [...TABLAS].reverse()) await quitarSedeId(this.db, tabla)
  }
}
