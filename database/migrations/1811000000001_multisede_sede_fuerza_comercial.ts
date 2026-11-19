import { BaseSchema } from '@adonisjs/lucid/schema'
import { agregarSedeId, backfill, quitarSedeId, SEDE_IBAGUE } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 1 — sede de la fuerza comercial y de los usuarios.
 *
 * Agrega sede_id (NULL + índice + FK; el NOT NULL llega en la Fase 3, cuando
 * el código de alta ponga la sede) a agentes_captacions, convenios,
 * prospectos y continuidad_overrides, y rellena usuarios.sede_id.
 *
 * Orden de derivación (cada paso solo toca filas aún sin sede):
 *  1. Usuarios con sede NULL que NO son espejo de convenio → Ibagué.
 *     "Espejo" = usuario cuyo agente es ASESOR_CONVENIO (con o sin rol).
 *  2. Agentes comerciales/telemercadeo → sede de su usuario; si no, Ibagué.
 *  3. Convenios → sede del asesor asignado activo; si no, del último asesor
 *     que tuvo; si no, del usuario de su propio agente; si no, Ibagué.
 *  4. Agentes ASESOR_CONVENIO → sede de su convenio; si no, de su usuario;
 *     si no, Ibagué.
 *  5. Usuarios espejo → sede de su agente (= la de su convenio).
 *  6. Prospectos → sede del convenio; si no, del usuario que lo creó; si no,
 *     Ibagué. Continuidad → convenio; si no, agente; si no, Ibagué.
 *
 * Los ids de usuarios que tenían sede NULL quedan en
 * multisede_backfill_usuarios para que down() los deje exactamente como
 * estaban.
 */
const TABLAS = ['agentes_captacions', 'convenios', 'prospectos', 'continuidad_overrides']
const ESPEJO = `EXISTS (SELECT 1 FROM agentes_captacions ae
                       WHERE ae.usuario_id = usuarios.id AND ae.tipo = 'ASESOR_CONVENIO')`

export default class MultisedeSedeFuerzaComercial extends BaseSchema {
  async up() {
    for (const t of TABLAS) await agregarSedeId(this.db, t)

    // Registro para down() (idempotente: solo se llena la primera vez).
    await this.db.rawQuery(
      `CREATE TABLE IF NOT EXISTS multisede_backfill_usuarios (
         usuario_id INT UNSIGNED NOT NULL PRIMARY KEY
       )`
    )
    await this.db.rawQuery(
      `INSERT IGNORE INTO multisede_backfill_usuarios (usuario_id)
       SELECT id FROM usuarios WHERE sede_id IS NULL`
    )

    // 1) Usuarios no espejo
    await backfill(
      this.db,
      'usuarios',
      [
        {
          desc: 'no espejo → Ibagué',
          sql: `UPDATE usuarios SET sede_id = ${SEDE_IBAGUE}
                 WHERE sede_id IS NULL AND NOT ${ESPEJO}`,
        },
      ],
      { permitirNull: ESPEJO }
    )

    // 2) Agentes comerciales y de telemercadeo
    await backfill(
      this.db,
      'agentes_captacions',
      [
        {
          desc: 'no convenio ← usuario',
          sql: `UPDATE agentes_captacions a JOIN usuarios u ON u.id = a.usuario_id
                   SET a.sede_id = u.sede_id
                 WHERE a.sede_id IS NULL AND a.tipo <> 'ASESOR_CONVENIO'
                   AND u.sede_id IS NOT NULL`,
        },
        {
          desc: 'no convenio sin usuario → Ibagué',
          sql: `UPDATE agentes_captacions SET sede_id = ${SEDE_IBAGUE}
                 WHERE sede_id IS NULL AND tipo <> 'ASESOR_CONVENIO'`,
        },
      ],
      { permitirNull: `tipo = 'ASESOR_CONVENIO'` }
    )

    // 3) Convenios
    await backfill(this.db, 'convenios', [
      {
        desc: '← asesor asignado activo',
        sql: `UPDATE convenios c JOIN (
                SELECT aca.convenio_id, MAX(a.sede_id) AS s
                  FROM asesor_convenio_asignaciones aca
                  JOIN agentes_captacions a ON a.id = aca.asesor_id
                 WHERE aca.activo = 1 AND aca.fecha_fin IS NULL AND a.sede_id IS NOT NULL
                 GROUP BY aca.convenio_id) x ON x.convenio_id = c.id
                 SET c.sede_id = x.s
               WHERE c.sede_id IS NULL`,
      },
      {
        desc: '← último asesor que tuvo',
        sql: `UPDATE convenios c JOIN (
                SELECT aca.convenio_id,
                       CAST(SUBSTRING_INDEX(GROUP_CONCAT(a.sede_id
                         ORDER BY aca.fecha_asignacion DESC, aca.id DESC), ',', 1) AS UNSIGNED) AS s
                  FROM asesor_convenio_asignaciones aca
                  JOIN agentes_captacions a ON a.id = aca.asesor_id
                 WHERE a.sede_id IS NOT NULL
                 GROUP BY aca.convenio_id) x ON x.convenio_id = c.id
                 SET c.sede_id = x.s
               WHERE c.sede_id IS NULL`,
      },
      {
        desc: '← usuario de su agente',
        sql: `UPDATE convenios c
                JOIN agentes_captacions a ON a.id = c.asesor_convenio_id
                JOIN usuarios u ON u.id = a.usuario_id
                 SET c.sede_id = u.sede_id
               WHERE c.sede_id IS NULL AND u.sede_id IS NOT NULL`,
      },
      {
        desc: 'resto → Ibagué',
        sql: `UPDATE convenios SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
      },
    ])

    // 4) Agentes de convenio
    const [mixtos] = await this.db.rawQuery(
      `SELECT COUNT(*) AS n FROM (
         SELECT asesor_convenio_id FROM convenios WHERE asesor_convenio_id IS NOT NULL
          GROUP BY asesor_convenio_id HAVING COUNT(DISTINCT sede_id) > 1) z`
    )
    console.log(`[multisede] agentes de convenio con convenios en varias sedes: ${mixtos[0].n}`)
    await backfill(this.db, 'agentes_captacions', [
      {
        desc: 'convenio ← su convenio',
        sql: `UPDATE agentes_captacions a JOIN (
                SELECT asesor_convenio_id AS aid, MIN(sede_id) AS s FROM convenios
                 WHERE asesor_convenio_id IS NOT NULL GROUP BY asesor_convenio_id) x
                  ON x.aid = a.id
                 SET a.sede_id = x.s
               WHERE a.sede_id IS NULL`,
      },
      {
        desc: 'convenio ← usuario',
        sql: `UPDATE agentes_captacions a JOIN usuarios u ON u.id = a.usuario_id
                 SET a.sede_id = u.sede_id
               WHERE a.sede_id IS NULL AND u.sede_id IS NOT NULL`,
      },
      {
        desc: 'resto → Ibagué',
        sql: `UPDATE agentes_captacions SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
      },
    ])

    // 5) Usuarios espejo
    await backfill(this.db, 'usuarios', [
      {
        desc: 'espejo ← su agente de convenio',
        sql: `UPDATE usuarios u JOIN (
                SELECT usuario_id, MIN(sede_id) AS s FROM agentes_captacions
                 WHERE tipo = 'ASESOR_CONVENIO' AND usuario_id IS NOT NULL
                 GROUP BY usuario_id) x ON x.usuario_id = u.id
                 SET u.sede_id = x.s
               WHERE u.sede_id IS NULL`,
      },
      {
        desc: 'resto → Ibagué',
        sql: `UPDATE usuarios SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
      },
    ])

    // 6) Prospectos y continuidad
    await backfill(this.db, 'prospectos', [
      {
        desc: '← convenio',
        sql: `UPDATE prospectos p JOIN convenios c ON c.id = p.convenio_id
                 SET p.sede_id = c.sede_id WHERE p.sede_id IS NULL`,
      },
      {
        desc: '← usuario que lo creó',
        sql: `UPDATE prospectos p JOIN usuarios u ON u.id = p.creado_por
                 SET p.sede_id = u.sede_id WHERE p.sede_id IS NULL AND u.sede_id IS NOT NULL`,
      },
      {
        desc: 'resto → Ibagué',
        sql: `UPDATE prospectos SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
      },
    ])
    await backfill(this.db, 'continuidad_overrides', [
      {
        desc: '← convenio',
        sql: `UPDATE continuidad_overrides o JOIN convenios c ON c.id = o.convenio_id
                 SET o.sede_id = c.sede_id WHERE o.sede_id IS NULL`,
      },
      {
        desc: '← agente',
        sql: `UPDATE continuidad_overrides o JOIN agentes_captacions a ON a.id = o.asesor_convenio_id
                 SET o.sede_id = a.sede_id WHERE o.sede_id IS NULL`,
      },
      {
        desc: 'resto → Ibagué',
        sql: `UPDATE continuidad_overrides SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
      },
    ])
  }

  async down() {
    // Usuarios: vuelven a NULL solo los que estaban en NULL antes de up().
    const [t] = await this.db.rawQuery(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = DATABASE() AND table_name = 'multisede_backfill_usuarios'`
    )
    if (t.length) {
      await this.db.rawQuery(
        `UPDATE usuarios u JOIN multisede_backfill_usuarios b ON b.usuario_id = u.id
            SET u.sede_id = NULL`
      )
      await this.db.rawQuery(`DROP TABLE multisede_backfill_usuarios`)
    }
    for (const tabla of [...TABLAS].reverse()) await quitarSedeId(this.db, tabla)
  }
}
