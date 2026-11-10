import { BaseCommand, flags } from '@adonisjs/core/ace'
import type { CommandOptions } from '@adonisjs/core/types/ace'
import db from '@adonisjs/lucid/services/db'
import { observacionMencionaConvenio } from '#services/convenio_ticket_service'

/**
 * SOLO LECTURA. Lista los tickets de Excepción de Dateo APROBADOS que
 * quedaron en Caso 1 (sin convenio) y cuya observación menciona "convenio":
 * candidatos a revisar con la corrección posterior
 * (PATCH /tickets-excepcion-dateo/:id/convenio).
 *
 * No escribe nada: solo SELECT, dentro de una transacción que se deshace al
 * final. "corregible" = la comisión está PENDIENTE y fuera de liquidaciones
 * (o todavía no hay comisión); APROBADA/PAGADA necesitan un ajuste aparte.
 *
 *   node ace tickets:caso1-menciona-convenio
 *   node ace tickets:caso1-menciona-convenio --desde=2026-10-01 --csv
 */
export default class TicketsCaso1MencionaConvenio extends BaseCommand {
  static commandName = 'tickets:caso1-menciona-convenio'
  static description = 'Solo lectura: tickets aprobados Caso 1 cuya observación menciona "convenio"'

  static options: CommandOptions = {
    startApp: true,
  }

  @flags.string({ description: 'Aprobados desde esta fecha (YYYY-MM-DD)' })
  declare desde?: string

  @flags.boolean({ description: 'Salida CSV (separador ;) en vez de tabla' })
  declare csv?: boolean

  async run() {
    const trx = await db.transaction()
    try {
      const q = trx
        .from('tickets_detalle_excepcion_dateo as d')
        .join('tickets as t', 't.id', 'd.ticket_id')
        .leftJoin('agentes_captacions as ag', 'ag.id', 'd.comercial_id')
        .leftJoin('turnos_rtms as tr', 'tr.id', 'd.turno_id')
        .where('t.estado', 'APROBADO')
        .whereNull('d.convenio_id')
        .where((qb) => qb.whereNull('d.canal').orWhereNot('d.canal', 'ASESOR_CONVENIO'))
        // Filtro grueso en SQL; el fino (tildes, mayúsculas) con la regla de la app.
        .whereRaw('LOWER(d.observacion) LIKE ?', ['%conven%'])
        .orderBy('d.aprobado_at', 'asc')
        .select(
          't.id as ticket_id',
          'd.aprobado_at',
          'd.placa',
          'd.dentro_ventana',
          'd.con_comision_asesor',
          'd.observacion',
          'ag.nombre as comercial',
          'tr.captacion_dateo_id as dateo_id'
        )
      if (this.desde) q.where('d.aprobado_at', '>=', `${this.desde} 00:00:00`)
      const candidatas = await q
      const filas = candidatas.filter((f: any) => observacionMencionaConvenio(f.observacion))

      const dateoIds = filas.map((f: any) => f.dateo_id).filter(Boolean)
      const comisiones = dateoIds.length
        ? await trx
            .from('comisiones as c')
            .whereIn('c.captacion_dateo_id', dateoIds)
            .where('c.tipo_servicio', 'RTM')
            .whereNot('c.estado', 'ANULADA')
            .select(
              'c.id',
              'c.captacion_dateo_id',
              'c.estado',
              'c.monto_asesor',
              'c.monto_convenio',
              db.raw(
                'EXISTS (SELECT 1 FROM liquidacion_detalle ld WHERE ld.comision_id = c.id) as en_liquidacion'
              )
            )
        : []
      const porDateo = new Map(comisiones.map((c: any) => [Number(c.captacion_dateo_id), c]))

      const salida = filas.map((f: any) => {
        const c: any = f.dateo_id ? porDateo.get(Number(f.dateo_id)) : undefined
        const corregible = !c || (c.estado === 'PENDIENTE' && !Number(c.en_liquidacion))
        return {
          ticket: f.ticket_id,
          aprobado: f.aprobado_at ? new Date(f.aprobado_at).toISOString().slice(0, 16) : '',
          placa: f.placa,
          comercial: f.comercial ?? '',
          ventana: f.dentro_ventana ? 'dentro' : 'fuera',
          comision: c
            ? `#${c.id} ${c.estado}${Number(c.en_liquidacion) ? ' (liquidación)' : ''}`
            : 'sin comisión',
          monto_asesor: c ? Number(c.monto_asesor ?? 0) : '',
          corregible: corregible ? 'sí' : 'no (ajuste aparte)',
          observacion: String(f.observacion ?? '')
            .replace(/\s+/g, ' ')
            .slice(0, 80),
        }
      })

      if (this.csv) {
        const cols = Object.keys(
          salida[0] ?? {
            ticket: '',
            aprobado: '',
            placa: '',
            comercial: '',
            ventana: '',
            comision: '',
            monto_asesor: '',
            corregible: '',
            observacion: '',
          }
        )
        const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`
        console.log(cols.join(';'))
        for (const s of salida) console.log(cols.map((k) => esc((s as any)[k])).join(';'))
      } else if (salida.length) {
        console.table(salida)
      }
      const corregibles = salida.filter((s) => s.corregible === 'sí').length
      this.logger.info(
        `${salida.length} ticket(s) aprobados Caso 1 mencionan "convenio"; ${corregibles} corregible(s) con PATCH /tickets-excepcion-dateo/:id/convenio.`
      )
    } catch (error) {
      this.logger.error(`Error consultando tickets: ${(error as Error).message}`)
      this.exitCode = 1
    } finally {
      // Solo lectura: nunca se confirma nada.
      await trx.rollback()
    }
  }
}
