// app/services/visibilidad_sede.ts
//
// Multi-sede 3c — clientes y vehículos tienen IDENTIDAD GLOBAL (una sola fila
// por documento/teléfono o por placa, compartida entre sedes) pero se VEN en
// la sede activa solo si tienen turnos o dateos en ella.
//
// - sqlClienteVisible / sqlVehiculoVisible: fragmentos EXISTS para listados.
// - clienteVisible / vehiculoVisible: chequeo por registro (ver, editar,
//   borrar, detalle). Un registro no visible responde 404, igual que un dato
//   de otra sede.
// - tieneHistorialFueraDeSede: un cliente/vehículo con turnos o dateos en
//   OTRA sede no se borra desde esta (es de todos).
//
// Con bypass (sinFiltroDeSede, tests sin request) todo es visible.

import db from '@adonisjs/lucid/services/db'
import { scopeObligatorio, sedeSql } from '#services/sede_scope'

const COL_RE = /^[a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*$/

function col(c: string): string {
  if (!COL_RE.test(c)) throw new Error(`visibilidad_sede: columna inválida "${c}"`)
  return c
}

/** EXISTS: el cliente (columna con su id) tiene turnos o dateos en la sede activa. */
export function sqlClienteVisible(colId: string): string {
  if (!scopeObligatorio()) return '1=1'
  const id = col(colId)
  return `(EXISTS (SELECT 1 FROM turnos_rtms tvis WHERE tvis.cliente_id = ${id} AND ${sedeSql('tvis')})
    OR EXISTS (SELECT 1 FROM captacion_dateos dvis WHERE dvis.cliente_id = ${id} AND ${sedeSql('dvis')}))`
}

/** EXISTS: el vehículo (id y placa) tiene turnos o dateos en la sede activa. */
export function sqlVehiculoVisible(colId: string, colPlaca: string): string {
  if (!scopeObligatorio()) return '1=1'
  const id = col(colId)
  const placa = col(colPlaca)
  return `(EXISTS (SELECT 1 FROM turnos_rtms tvis WHERE (tvis.vehiculo_id = ${id} OR tvis.placa = ${placa}) AND ${sedeSql('tvis')})
    OR EXISTS (SELECT 1 FROM captacion_dateos dvis WHERE (dvis.vehiculo_id = ${id} OR dvis.placa = ${placa}) AND ${sedeSql('dvis')}))`
}

export async function clienteVisible(clienteId: number): Promise<boolean> {
  if (!scopeObligatorio()) return true
  const fila = await db
    .from('clientes')
    .where('clientes.id', clienteId)
    .whereRaw(sqlClienteVisible('clientes.id'))
    .select('clientes.id')
    .first()
  return !!fila
}

export async function vehiculoVisible(vehiculoId: number): Promise<boolean> {
  if (!scopeObligatorio()) return true
  const fila = await db
    .from('vehiculos')
    .where('vehiculos.id', vehiculoId)
    .whereRaw(sqlVehiculoVisible('vehiculos.id', 'vehiculos.placa'))
    .select('vehiculos.id')
    .first()
  return !!fila
}

/**
 * ¿Tiene turnos o dateos FUERA de la sede activa? (para no borrar desde una
 * sede algo que otra usa). Con "todas" o bypass: false (no hay "fuera").
 */
export async function tieneHistorialFueraDeSede(
  campo: { tipo: 'cliente'; id: number } | { tipo: 'vehiculo'; id: number; placa: string }
): Promise<boolean> {
  const s = scopeObligatorio()
  if (!s || s.todas) return false
  const ids = s.sedeIds.length ? s.sedeIds : [0]
  // sede: a propósito busca FUERA de la sede activa (bloquear el borrado)
  const turnos = db.from('turnos_rtms').whereNotIn('sede_id', ids)
  const dateos = db.from('captacion_dateos').whereNotIn('sede_id', ids)
  if (campo.tipo === 'cliente') {
    turnos.where('cliente_id', campo.id)
    dateos.where('cliente_id', campo.id)
  } else {
    turnos.where((q) => q.where('vehiculo_id', campo.id).orWhere('placa', campo.placa))
    dateos.where((q) => q.where('vehiculo_id', campo.id).orWhere('placa', campo.placa))
  }
  const [t, d] = await Promise.all([turnos.select('id').first(), dateos.select('id').first()])
  return !!t || !!d
}
