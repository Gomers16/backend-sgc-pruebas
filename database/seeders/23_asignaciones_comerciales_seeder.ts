// database/seeders/23_asignaciones_comerciales_seeder.ts
import { sinFiltroDeSede } from '#services/sede_scope'
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import Database from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import AgenteCaptacion from '#models/agente_captacion'
import Usuario from '#models/usuario'
import Convenio from '#models/convenio'
import Prospecto from '#models/prospecto'
import AsesorConvenioAsignacion from '#models/asesor_convenio_asignacion'
import AsesorProspectoAsignacion from '#models/asesor_prospecto_asignacion'

export default class AsignacionesComercialesSeeder extends BaseSeeder {
  // Multi-sede: sin request no hay sede activa; cada registro declara su sede
  // (la de su usuario/agente), así que corre sin filtro de forma explícita.
  public async run() {
    await sinFiltroDeSede(async () => await this.sembrar())
  }

  private async sembrar() {
    const trx = await Database.transaction()

    try {
      // ===== 1) IDs de Telemercadeo (excluir de asignaciones) =====
      const teleRows = await AgenteCaptacion.query({ client: trx })
        .where('activo', true)
        .where('tipo', 'ASESOR_TELEMERCADEO')
        .select('id')

      const teleIds = teleRows.map((r) => r.id)

      // ===== 2) Asesores COMERCIAL o CONVENIO (asignables para prospectos si hiciera falta) =====
      // Nota: ya no usaremos round-robin para prospectos; queda como respaldo/logs.
      const asignablesQuery = AgenteCaptacion.query({ client: trx })
        .where('activo', true)
        .whereIn('tipo', ['ASESOR_COMERCIAL', 'ASESOR_CONVENIO'] as const)
        .orderBy('id', 'asc')

      if (teleIds.length > 0) {
        asignablesQuery.whereNotIn('id', teleIds)
      }
      const asignables = await asignablesQuery

      // ===== 3) Asesores para CONVENIOS (SOLO COMERCIALES) =====
      const comercialesQuery = AgenteCaptacion.query({ client: trx })
        .where('activo', true)
        .where('tipo', 'ASESOR_COMERCIAL')
        .orderBy('id', 'asc')

      if (teleIds.length > 0) {
        comercialesQuery.whereNotIn('id', teleIds)
      }
      const comerciales = await comercialesQuery

      if (comerciales.length === 0) {
        console.warn('⚠️ No hay asesores COMERCIALES activos para asignar convenios.')
      }
      if (asignables.length === 0) {
        console.warn('⚠️ No hay asesores asignables (comercial/convenio) para prospectos.')
      }

      const usuarioAsignador = await Usuario.query({ client: trx }).first()

      const pickRR = <T>(arr: T[], i: number) => arr[i % arr.length]

      // ===== 4) Reparto de CONVENIOS (solo comerciales; si no hay activa vigente) =====
      const convenios = await Convenio.query({ client: trx }).orderBy('id', 'asc')
      let convCreadas = 0

      for (const [idx, conv] of convenios.entries()) {
        const yaActiva = await AsesorConvenioAsignacion.query({ client: trx })
          .where('convenio_id', conv.id)
          .where('activo', true)
          .whereNull('fecha_fin')
          .first()

        if (!yaActiva && comerciales.length > 0) {
          await AsesorConvenioAsignacion.create(
            {
              convenioId: conv.id,
              asesorId: pickRR(comerciales, idx).id, // 👈 SIEMPRE comercial
              asignadoPor: usuarioAsignador?.id ?? null,
              fechaAsignacion: DateTime.now(),
              fechaFin: null,
              motivoFin: null,
              activo: true,
            } as any,
            { client: trx }
          )
          convCreadas++
        }
      }

      // ===== 5) Normalización de PROSPECTOS: asignado SIEMPRE = creador =====
      const prospectos = await Prospecto.query({ client: trx }).orderBy('id', 'asc')
      let prosAsignados = 0
      let prosReasignados = 0
      let prosSinCreador = 0
      let prosCreadorSinAgente = 0

      for (const pros of prospectos) {
        // 5.1: buscar asignación activa (si hay)
        const activa = await AsesorProspectoAsignacion.query({ client: trx })
          .where('prospecto_id', pros.id)
          .where('activo', true)
          .whereNull('fecha_fin')
          .first()

        // 5.2: obtener el agente del CREADOR (mismo asesor que debe quedar asignado)
        const creadorId = (pros as any).creadoPor ?? (pros as any).creado_por ?? null
        if (!creadorId) {
          prosSinCreador++
          console.warn(`⚠️ Prospecto #${pros.id} no tiene 'creado_por'; se omite asignación.`)
          continue
        }

        // Buscar agente del creador (activo, no tele)
        const creadorAgenteQuery = AgenteCaptacion.query({ client: trx })
          .where('usuario_id', Number(creadorId))
          .where('activo', true)

        if (teleIds.length > 0) {
          creadorAgenteQuery.whereNotIn('id', teleIds)
        }

        const creadorAgente = await creadorAgenteQuery.first()
        if (!creadorAgente) {
          prosCreadorSinAgente++
          console.warn(
            `⚠️ Prospecto #${pros.id} — el usuario creador #${creadorId} no tiene AgenteCaptacion activo (no tele).`
          )
          continue
        }

        // 5.3: si ya hay activa y coincide, no hacemos nada
        if (activa && activa.asesorId === creadorAgente.id) {
          continue
        }

        // 5.4: si hay activa distinta, cerrarla y reasignar al creador
        if (activa && activa.asesorId !== creadorAgente.id) {
          activa.merge({
            activo: false,
            fechaFin: DateTime.now(),
            motivoFin: 'Normalización: debe asignarse al creador',
          } as any)
          await activa.save()
          prosReasignados++
        }

        // 5.5: crear asignación hacia el CREADOR
        await AsesorProspectoAsignacion.create(
          {
            prospectoId: pros.id,
            asesorId: creadorAgente.id,
            asignadoPor: usuarioAsignador?.id ?? creadorId ?? null,
            fechaAsignacion: DateTime.now(),
            fechaFin: null,
            motivoFin: null,
            activo: true,
          } as any,
          { client: trx }
        )
        prosAsignados++
      }

      await trx.commit()

      console.log(
        [
          '✅ Asignaciones listas.',
          `Convenios creados: ${convCreadas}.`,
          `Prospectos asignados al creador: ${prosAsignados}.`,
          `Prospectos reasignados (tenían otro asesor): ${prosReasignados}.`,
          `Prospectos sin creador: ${prosSinCreador}.`,
          `Prospectos con creador sin agente activo: ${prosCreadorSinAgente}.`,
          `Asesores comerciales (para convenios): ${comerciales.length}.`,
          `Asesores asignables (solo referencia): ${asignables.length}.`,
          `Excluidos tele: ${teleIds.length}.`,
        ].join(' ')
      )
    } catch (err) {
      await trx.rollback()
      console.error('❌ Error en AsignacionesComercialesSeeder:', err)
      throw err
    }
  }
}
