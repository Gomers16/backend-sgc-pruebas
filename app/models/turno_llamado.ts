// app/models/turno_llamado.ts
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'

import TurnoRtm from '#models/turno_rtm'
import Usuario from '#models/usuario'

export default class TurnoLlamado extends BaseModel {
  public static table = 'turno_llamados'

  @column({ isPrimary: true })
  declare id: number

  @column({ columnName: 'turno_id' })
  declare turnoId: number

  @column()
  declare modulo: string

  @column({ columnName: 'usuario_id' })
  declare usuarioId: number | null

  @column.dateTime({ columnName: 'llamado_at' })
  declare llamadoAt: DateTime

  // Flujo Entregar / No se presentó (pantalla de exhibición del Turnero) —
  // exclusivos de esta tabla, no afectan turnos_rtms.estado.
  @column.dateTime({ columnName: 'entregado_at' })
  declare entregadoAt: DateTime | null

  // true = el cliente no se presentó al llamado: la fila deja de contar como
  // "llamado activo" y el turno vuelve a la cola (ver
  // turno_llamados_controller.ts). Se apaga al volver a llamarlo a un módulo
  // desde "Turnos para Llamar" (store() reutiliza esta misma fila).
  @column({ columnName: 'no_presentado' })
  declare noPresentado: boolean

  // Tipo del último anuncio de esta fila: 'modulo' (llamado a un módulo) o
  // 'pregunta' (mismo módulo, texto "Por favor acérquese a …", ver
  // llamarPregunta()/preguntar()).
  @column({ columnName: 'tipo_llamado' })
  declare tipoLlamado: 'modulo' | 'pregunta'

  // true = tuvo un "LLAMAR" real a módulo (store()). false = la fila existe
  // solo por un "Preguntar" sobre un turno todavía sin llamar — el turno
  // sigue en "Turnos para Llamar" y en la cola (ver sinLlamadoActivo()).
  @column({ columnName: 'llamado_oficial' })
  declare llamadoOficial: boolean

  @column.dateTime({ autoCreate: true })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true })
  declare updatedAt: DateTime

  @belongsTo(() => TurnoRtm, { foreignKey: 'turnoId' })
  declare turno: BelongsTo<typeof TurnoRtm>

  @belongsTo(() => Usuario, { foreignKey: 'usuarioId' })
  declare usuario: BelongsTo<typeof Usuario>
}
