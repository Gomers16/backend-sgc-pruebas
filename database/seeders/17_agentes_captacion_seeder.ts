// database/seeders/17_agentes_captacion_seeder.ts

import { sinFiltroDeSede } from '#services/sede_scope'
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import AgenteCaptacion from '#models/agente_captacion'
import Cargo from '#models/cargo'
import Usuario from '#models/usuario'

export default class AgentesCaptacionSeeder extends BaseSeeder {
  // Multi-sede: sin request no hay sede activa; cada registro declara su sede
  // (la de su usuario/agente), así que corre sin filtro de forma explícita.
  public async run() {
    await sinFiltroDeSede(async () => await this.sembrar())
  }

  private async sembrar() {
    // Ubicamos los cargos clave
    const cargoCom = await Cargo.findBy('nombre', 'ASESOR COMERCIAL')
    const cargoConv = await Cargo.findBy('nombre', 'ASESOR CONVENIO')

    if (!cargoCom || !cargoConv) {
      throw new Error(
        '❌ Faltan cargos ASESOR COMERCIAL / ASESOR CONVENIO. Corre el CargoSeeder antes.'
      )
    }

    // Usuarios por cargo (1:1)
    const comerciales = await Usuario.query().where('cargo_id', cargoCom.id)
    const convenios = await Usuario.query().where('cargo_id', cargoConv.id)

    // ASESOR COMERCIAL -> tipo ASESOR_COMERCIAL
    for (const u of comerciales) {
      const agente = await AgenteCaptacion.updateOrCreate(
        { usuarioId: u.id },
        {
          usuarioId: u.id,
          sedeId: u.sedeId,
          tipo: 'ASESOR_COMERCIAL',
          nombre: `${u.nombres} ${u.apellidos}`.trim(),
          telefono: u.celularPersonal ?? u.celularCorporativo ?? null,
          activo: true,
        }
      )

      // 🔥 Vincular agente con usuario
      u.agenteId = agente.id
      await u.save()
    }

    // ASESOR CONVENIO -> tipo ASESOR_CONVENIO
    for (const u of convenios) {
      const agente = await AgenteCaptacion.updateOrCreate(
        { usuarioId: u.id },
        {
          usuarioId: u.id,
          sedeId: u.sedeId,
          tipo: 'ASESOR_CONVENIO',
          nombre: `${u.nombres} ${u.apellidos}`.trim(),
          telefono: u.celularPersonal ?? u.celularCorporativo ?? null,
          activo: true,
        }
      )

      // 🔥 Vincular agente con usuario
      u.agenteId = agente.id
      await u.save()
    }

    console.log(
      `✅ Agentes de Captación creados/actualizados y vinculados: comerciales=${comerciales.length}, convenios=${convenios.length}`
    )
  }
}
