import { BaseSchema } from '@adonisjs/lucid/schema'
import { backfill, columnaExiste, indiceExiste, SEDE_IBAGUE } from '../helpers/multisede.js'

/**
 * Multi-sede Fase 3g — agentes, convenios, prospectos y telemercadeo.
 *
 * 1) sede_id NOT NULL DEFAULT 1 TEMPORAL en agentes_captacions, convenios,
 *    prospectos, telemercadeo_gestiones y telemercadeo_ciclos. Antes rellena
 *    lo que el código viejo haya dejado con NULL (agente ← su usuario;
 *    convenio ← su asesor; prospecto ← su convenio; gestión ← su agente;
 *    ciclo ← su última gestión; resto → Ibagué). Producción local no conoce
 *    la columna en esos modelos (ni tiene telemercadeo) y toma el DEFAULT.
 * 2) El único de ciclo abierto pasa a ser por sede (anotado para la 3g en
 *    1811000000002): (sede_id, placa, servicio_id, abierto_key).
 */
const TABLAS = [
  'agentes_captacions',
  'convenios',
  'prospectos',
  'telemercadeo_gestiones',
  'telemercadeo_ciclos',
]
const ibague = (t: string) => ({
  desc: 'resto → Ibagué',
  sql: `UPDATE ${t} SET sede_id = ${SEDE_IBAGUE} WHERE sede_id IS NULL`,
})

export default class MultisedeFuerzaComercialSedeNotNull extends BaseSchema {
  async up() {
    for (const t of TABLAS) {
      if (!(await columnaExiste(this.db, t, 'sede_id'))) {
        throw new Error(`[multisede] ${t}.sede_id no existe: falta 1811`)
      }
    }

    await backfill(this.db, 'agentes_captacions', [
      {
        desc: '← usuario',
        sql: `UPDATE agentes_captacions a JOIN usuarios u ON u.id = a.usuario_id
                 SET a.sede_id = u.sede_id WHERE a.sede_id IS NULL AND u.sede_id IS NOT NULL`,
      },
      ibague('agentes_captacions'),
    ])
    await backfill(this.db, 'convenios', [
      {
        desc: '← asesor del convenio',
        sql: `UPDATE convenios c JOIN agentes_captacions a ON a.id = c.asesor_convenio_id
                 SET c.sede_id = a.sede_id WHERE c.sede_id IS NULL`,
      },
      ibague('convenios'),
    ])
    await backfill(this.db, 'prospectos', [
      {
        desc: '← convenio',
        sql: `UPDATE prospectos p JOIN convenios c ON c.id = p.convenio_id
                 SET p.sede_id = c.sede_id WHERE p.sede_id IS NULL`,
      },
      ibague('prospectos'),
    ])
    await backfill(this.db, 'telemercadeo_gestiones', [
      {
        desc: '← agente',
        sql: `UPDATE telemercadeo_gestiones g JOIN agentes_captacions a ON a.id = g.agente_id
                 SET g.sede_id = a.sede_id WHERE g.sede_id IS NULL`,
      },
      ibague('telemercadeo_gestiones'),
    ])
    await backfill(this.db, 'telemercadeo_ciclos', [
      {
        desc: '← última gestión',
        sql: `UPDATE telemercadeo_ciclos c JOIN (
                SELECT ciclo_id, MAX(id) AS gid FROM telemercadeo_gestiones GROUP BY ciclo_id) x
                  ON x.ciclo_id = c.id
                JOIN telemercadeo_gestiones g ON g.id = x.gid
                 SET c.sede_id = g.sede_id WHERE c.sede_id IS NULL`,
      },
      ibague('telemercadeo_ciclos'),
    ])

    for (const t of TABLAS) {
      await this.db.rawQuery(
        `ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NOT NULL DEFAULT ${SEDE_IBAGUE}`
      )
    }

    if (await indiceExiste(this.db, 'telemercadeo_ciclos', 'uq_tele_ciclo_abierto')) {
      await this.db.rawQuery(
        'ALTER TABLE telemercadeo_ciclos ADD UNIQUE INDEX uq_tele_ciclo_abierto_sede (sede_id, placa, servicio_id, abierto_key), DROP INDEX uq_tele_ciclo_abierto'
      )
    }
  }

  async down() {
    if (await indiceExiste(this.db, 'telemercadeo_ciclos', 'uq_tele_ciclo_abierto_sede')) {
      await this.db.rawQuery(
        'ALTER TABLE telemercadeo_ciclos ADD UNIQUE INDEX uq_tele_ciclo_abierto (placa, servicio_id, abierto_key), DROP INDEX uq_tele_ciclo_abierto_sede'
      )
    }
    for (const t of TABLAS) {
      if (await columnaExiste(this.db, t, 'sede_id')) {
        await this.db.rawQuery(`ALTER TABLE ${t} MODIFY sede_id INT UNSIGNED NULL DEFAULT NULL`)
      }
    }
  }
}
