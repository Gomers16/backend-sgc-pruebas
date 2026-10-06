import { test } from '@japa/runner'
import {
  armarFilasCanal,
  avisoCanal,
  filasQueSuman,
  nombreCanalReporte,
  normalizarCanalReporte,
  sumarMetricas,
} from '#services/canal_reporte_service'

type M = { cantidad: number; total: number }
const vacia = (): M => ({ cantidad: 0, total: 0 })

test.group('canal_reporte_service', () => {
  test('filas en orden fijo con ceros; Asesor = Asesor comercial + Asesor convenio; la línea por convenio no suma', ({
    assert,
  }) => {
    const filas = armarFilasCanal<M>(
      new Map([
        ['TELE', { cantidad: 2, total: 20 }],
        ['ASESOR_COMERCIAL', { cantidad: 1, total: 10 }],
        ['ASESOR_COMERCIAL_CONVENIO', { cantidad: 4, total: 30 }],
        ['ASESOR_CONVENIO', { cantidad: 3, total: 30 }],
      ]),
      vacia,
      sumarMetricas,
      (m) => m,
      'total'
    )
    assert.deepEqual(
      filas.map((f) => [f.canal, f.nombre, f.es_subcanal, f.es_informativa, f.cantidad]),
      [
        ['FACHADA', 'Fachada', false, false, 0],
        ['REDES', 'Redes Sociales', false, false, 0],
        ['TELE', 'Call Center', false, false, 2],
        ['ASESOR', 'Asesor', false, false, 8],
        ['ASESOR_COMERCIAL', 'Asesor comercial', true, false, 5],
        ['ASESOR_COMERCIAL_CONVENIO', 'de los cuales, por convenio', true, true, 4],
        ['ASESOR_CONVENIO', 'Asesor convenio', true, false, 3],
        ['GOOGLE_ADS', 'Google ADS', false, false, 0],
      ]
    )
    // 30 de 40 de Asesor comercial.
    assert.equal(filas[5].porcentaje_sobre_asesor_comercial, 75)
    // Solo las filas sin subcanal suman: 2 + 8.
    assert.equal(
      filasQueSuman(filas).reduce((a, f) => a + f.cantidad, 0),
      10
    )
  })

  test('la línea por convenio no tiene % del total (null)', ({ assert }) => {
    const filas = armarFilasCanal<{ cantidad: number; porcentaje: number }>(
      new Map([['ASESOR_COMERCIAL_CONVENIO', { cantidad: 1, porcentaje: 0 }]]),
      () => ({ cantidad: 0, porcentaje: 0 }),
      sumarMetricas,
      (m) => ({ ...m, porcentaje: 50 }),
      'cantidad'
    )
    const inf = filas.find((f) => f.es_informativa)!
    assert.isNull(inf.porcentaje)
    assert.equal(inf.porcentaje_sobre_asesor_comercial, 100)
    assert.equal(filas.find((f) => f.canal === 'ASESOR_COMERCIAL')!.porcentaje, 50)
  })

  test('"Asesor (sin detalle)" solo aparece si tiene datos y suma en Asesor', ({ assert }) => {
    const filas = armarFilasCanal<M>(
      new Map([['ASESOR_SIN_DETALLE', { cantidad: 1, total: 5 }]]),
      vacia,
      sumarMetricas
    )
    const asesor = filas.find((f) => f.canal === 'ASESOR')!
    assert.equal(asesor.cantidad, 1)
    assert.equal(
      filas.find((f) => f.canal === 'ASESOR_SIN_DETALLE')?.nombre,
      'Asesor (sin detalle)'
    )
  })

  test('finalizar recalcula lo derivado en cada fila (incluido el total de Asesor)', ({
    assert,
  }) => {
    const filas = armarFilasCanal<{ cantidad: number; promedio: number }>(
      new Map([
        ['ASESOR_COMERCIAL', { cantidad: 2, promedio: 0 }],
        ['ASESOR_CONVENIO', { cantidad: 2, promedio: 0 }],
      ]),
      () => ({ cantidad: 0, promedio: 0 }),
      sumarMetricas,
      (m, canal) => ({ ...m, promedio: canal === 'ASESOR' ? 99 : 1 })
    )
    assert.equal(filas.find((f) => f.canal === 'ASESOR')!.promedio, 99)
    assert.equal(filas.find((f) => f.canal === 'ASESOR_COMERCIAL')!.promedio, 1)
  })

  test('códigos viejos de las pantallas se traducen', ({ assert }) => {
    assert.equal(normalizarCanalReporte('telemercadeo'), 'TELE')
    assert.equal(normalizarCanalReporte('GOOGLE_ADS'), 'GOOGLE_ADS')
    assert.equal(nombreCanalReporte('TELE'), 'Call Center')
    assert.equal(nombreCanalReporte('DESCONOCIDO'), 'DESCONOCIDO')
  })

  test('avisoCanal: aplica antes de la fecha, no desde ella, y siempre sin fecha', ({ assert }) => {
    assert.isTrue(avisoCanal('2026-10-05', '2026-10-06').aplica)
    assert.include(avisoCanal('2026-10-05', '2026-10-06').mensaje!, '06/10/2026')
    assert.isFalse(avisoCanal('2026-10-06', '2026-10-06').aplica)
    assert.isNull(avisoCanal('2026-11-01', '2026-10-06').mensaje)
    const sinFecha = avisoCanal('2030-01-01', null)
    assert.isTrue(sinFecha.aplica)
    assert.include(sinFecha.mensaje!, 'CANAL_CONFIABLE_DESDE')
  })
})
