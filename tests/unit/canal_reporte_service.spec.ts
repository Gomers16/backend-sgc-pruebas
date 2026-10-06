import { test } from '@japa/runner'
import {
  armarFilasCanal,
  avisoCanal,
  nombreCanalReporte,
  normalizarCanalReporte,
  sumarMetricas,
} from '#services/canal_reporte_service'

type M = { cantidad: number; total: number }
const vacia = (): M => ({ cantidad: 0, total: 0 })

test.group('canal_reporte_service', () => {
  test('filas en orden fijo con ceros; Asesor = suma de Comercial + Convenio', ({ assert }) => {
    const filas = armarFilasCanal<M>(
      new Map([
        ['TELE', { cantidad: 2, total: 20 }],
        ['ASESOR_COMERCIAL', { cantidad: 1, total: 10 }],
        ['ASESOR_CONVENIO', { cantidad: 3, total: 30 }],
      ]),
      vacia,
      sumarMetricas
    )
    assert.deepEqual(
      filas.map((f) => [f.canal, f.nombre, f.es_subcanal, f.cantidad]),
      [
        ['FACHADA', 'Fachada', false, 0],
        ['REDES', 'Redes Sociales', false, 0],
        ['TELE', 'Call Center', false, 2],
        ['ASESOR', 'Asesor', false, 4],
        ['ASESOR_COMERCIAL', 'Comercial', true, 1],
        ['ASESOR_CONVENIO', 'Convenio', true, 3],
        ['GOOGLE_ADS', 'Google ADS', false, 0],
      ]
    )
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
