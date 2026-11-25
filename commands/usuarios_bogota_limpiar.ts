import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import Contrato from '#models/contrato'
import ContratoSalario from '#models/contrato_salario'
import ContratoPaso from '#models/contrato_paso'
import AgenteCaptacion from '#models/agente_captacion'
import { sinFiltroDeSede } from '#services/sede_scope'
import { leerUsuariosBogota } from '#database/helpers/usuarios_bogota'

/**
 * Borra los usuarios de 41_usuarios_bogota_seeder.ts, con sus contratos,
 * salarios, pasos y agentes. Se identifican SOLO por las
 * 12 cédulas de tmp/usuarios_bogota_credenciales.json (fuera de git; o la ruta
 * en USUARIOS_BOGOTA_JSON). Sin ese archivo no hace nada.
 *
 * Un usuario o agente con actividad (turnos, dateos, metas...) se omite: hay
 * claves foráneas en CASCADE (p. ej. turnos_rtms.funcionario_id) que la
 * borrarían.
 *
 *   node ace usuarios:bogota-limpiar            (simulación)
 *   node ace usuarios:bogota-limpiar --aplicar
 */

/** Filas propias que se borran con el usuario y no cuentan como actividad. */
const PROPIAS = new Set([
  'auth_access_tokens.tokenable_id',
  'usuario_preferencia_modulo.usuario_id',
  'agentes_captacions.usuario_id',
])
/** Hijas de contratos: solo cuentan si son de un contrato de otra persona. */
const DE_CONTRATO = new Set([
  'contrato_cambios',
  'contrato_historial_estados',
  'contrato_pasos',
  'contrato_eventos',
])
/** Columnas que apuntan a usuarios o agentes sin clave foránea. */
const SIN_FK = [{ ref: 'usuarios', tabla: 'contratos', columna: 'actor_id' }]

export default class UsuariosBogotaLimpiar extends BaseCommand {
  static commandName = 'usuarios:bogota-limpiar'
  static description = 'Borra los usuarios de prueba de Bogotá (por cédula)'
  static options: CommandOptions = { startApp: true }

  @flags.boolean({ description: 'Borra de verdad (sin esto es simulación)' })
  declare aplicar?: boolean

  async run() {
    const datos = await leerUsuariosBogota()
    const cedulas = datos.usuarios.map((u) => u.doc)
    const refs = await this.referencias()
    const usuarios = await Usuario.query().whereIn('numero_documento', cedulas).orderBy('id', 'asc')
    this.logger.info(`${usuarios.length} de ${cedulas.length} cédulas encontradas`)

    for (const u of usuarios) {
      await sinFiltroDeSede(async () => {
        const contratos = await Contrato.query().where('usuario_id', u.id)
        const agentes = await AgenteCaptacion.query().where('usuario_id', u.id)
        const etiqueta = `${u.numeroDocumento} ${u.correo} (usuario ${u.id})`

        const actividad = await this.actividad(
          refs,
          u.id,
          agentes.map((a) => a.id),
          contratos.map((c) => c.id)
        )
        if (actividad.length) {
          this.logger.warning(`OMITIDO ${etiqueta}: tiene actividad en ${actividad.join(', ')}`)
          return
        }

        const resumen = `${contratos.length} contrato(s), ${agentes.length} agente(s)`
        if (!this.aplicar) {
          this.logger.info(`Se borraría ${etiqueta}: ${resumen}`)
          return
        }

        await db.transaction(async (trx) => {
          for (const c of contratos) {
            // Historial, cambios y eventos caen por su clave foránea.
            await ContratoPaso.query({ client: trx }).where('contrato_id', c.id).delete()
            await ContratoSalario.query({ client: trx }).where('contrato_id', c.id).delete()
            c.useTransaction(trx)
            await c.delete()
          }
          for (const a of agentes) {
            a.useTransaction(trx)
            await a.delete()
          }
          u.useTransaction(trx)
          await u.delete()
        })
        this.logger.success(`Borrado ${etiqueta}: ${resumen}`)
      })
    }
    if (!this.aplicar) this.logger.info('Simulación: no se borró nada. Usa --aplicar.')
  }

  /** Columnas de toda la BD que apuntan a usuarios o a agentes. */
  private async referencias(): Promise<{ ref: string; tabla: string; columna: string }[]> {
    const [filas] = await db.rawQuery(
      `SELECT referenced_table_name AS ref, table_name AS tabla, column_name AS columna
         FROM information_schema.key_column_usage
        WHERE table_schema = DATABASE() AND referenced_table_schema = DATABASE()
          AND referenced_table_name IN ('usuarios', 'agentes_captacions')`
    )
    return [...filas, ...SIN_FK]
  }

  private async actividad(
    refs: { ref: string; tabla: string; columna: string }[],
    usuarioId: number,
    agenteIds: number[],
    contratoIds: number[]
  ): Promise<string[]> {
    const salida: string[] = []
    for (const { ref, tabla, columna } of refs) {
      const ids = ref === 'usuarios' ? [usuarioId] : agenteIds
      if (!ids.length || PROPIAS.has(`${tabla}.${columna}`)) continue
      const q = db.from(tabla).whereIn(columna, ids)
      if (DE_CONTRATO.has(tabla)) q.whereNotIn('contrato_id', contratoIds)
      if (tabla === 'contratos') q.whereNotIn('id', contratoIds)
      const [{ n }] = await q.count('* as n')
      if (Number(n) > 0) salida.push(`${tabla}.${columna} (${n})`)
    }
    return salida
  }
}
