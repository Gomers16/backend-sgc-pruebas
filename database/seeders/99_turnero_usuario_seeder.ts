// Seeder del usuario dedicado para la pantalla del turnero (TurneroCDAPro).
// Mismo patrón que 99_tramitador_test_seeder.ts, con una diferencia
// deliberada: el rolId se resuelve por nombre (Rol.findByOrFail) en vez de
// hardcodearlo, para no depender de que 'TURNERO' tenga un id numérico
// específico en cada entorno (mismo criterio ya documentado para el cargo
// LIDER NACIONAL: nunca hardcodear el id, resolver siempre por nombre).
// Ejecutar: node ace db:seed --files "database/seeders/99_turnero_usuario_seeder.ts"
// NOTA: withAuthFinder tiene @beforeSave que hashea automáticamente.
// Pasar el password en texto plano — NO pre-hashear con Hash.make().
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import Usuario from '#models/usuario'
import Rol from '#models/rol'

export default class TurneroUsuarioSeeder extends BaseSeeder {
  public async run() {
    const rolTurnero = await Rol.findByOrFail('nombre', 'TURNERO')

    await Usuario.updateOrCreate(
      { correo: 'turnero@cda.local' },
      {
        nombres: 'Turnero',
        apellidos: 'Sala de Espera',
        correo: 'turnero@cda.local',
        password: '3qbVMpzGS31F47Y01eKnmf',
        rolId: rolTurnero.id,
        estado: 'activo',
        recomendaciones: false,
      } as any
    )

    console.log('[TurneroUsuarioSeeder] Usuario turnero@cda.local creado/actualizado.')
    console.log(`  Rol ID: ${rolTurnero.id} (TURNERO)`)
  }
}
