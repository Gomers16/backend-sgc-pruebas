import { test } from '@japa/runner'
import {
  calcularResumenContable,
  grupoVehiculo,
  textoRechazo,
  type FilaResumen,
} from '#services/resumen_contable_service'

const fila = (filas: FilaResumen[], clave: string) => filas.find((f) => f.clave === clave)!

test.group('resumen_contable_service', () => {
  test('grupos de vehículo: moto, los tres livianos, lo demás a Otros', ({ assert }) => {
    assert.equal(grupoVehiculo('Motocicleta'), 'motos')
    for (const t of ['Liviano Particular', 'Liviano Taxi', 'Liviano Público'])
      assert.equal(grupoVehiculo(t), 'livianos')
    assert.equal(grupoVehiculo('Pesado'), 'otros')
    assert.equal(grupoVehiculo(null), 'otros')
  })

  test('sin turnos: filas fijas en 0 y % rechazo null', ({ assert }) => {
    const r = calcularResumenContable([])
    assert.deepEqual(
      r.filas.map((f) => f.clave),
      ['RTM_PRIMERA', 'RTM_SEGUNDA', 'RTM_TOTAL', 'SOAT', 'PREV', 'PERI', 'TOTAL']
    )
    assert.isTrue(r.filas.every((f) => f.total === 0))
    assert.isNull(r.rechazo.primera_vez.porcentaje)
    assert.isNull(r.rechazo.segunda_vez.porcentaje)
    assert.equal(r.sin_finalizar, 0)
    assert.equal(textoRechazo(r.rechazo.primera_vez), '—')
  })

  test('cancelados/inactivos fuera; segunda vez separada solo en RTM; sin servicio y no previstos al final', ({
    assert,
  }) => {
    const r = calcularResumenContable([
      {
        servicioCodigo: 'RTM',
        tipoVehiculo: 'Motocicleta',
        estado: 'finalizado',
        resultadoCertificacion: 'RECHAZADA',
      },
      { servicioCodigo: 'rtm ', tipoVehiculo: 'Liviano Taxi', estado: 'activo', esSegundaVez: 0 },
      {
        servicioCodigo: 'RTM',
        tipoVehiculo: 'Liviano Particular',
        estado: 'finalizado',
        esSegundaVez: true,
        resultadoCertificacion: 'APROBADA',
      },
      {
        servicioCodigo: 'PREV',
        tipoVehiculo: 'Motocicleta',
        estado: 'finalizado',
        esSegundaVez: 1,
      },
      { servicioCodigo: 'ZZZ', tipoVehiculo: null, estado: 'finalizado' },
      { servicioCodigo: null, tipoVehiculo: 'Liviano Público', estado: 'finalizado' },
      {
        servicioCodigo: 'RTM',
        tipoVehiculo: 'Motocicleta',
        estado: 'cancelado',
        resultadoCertificacion: 'APROBADA',
      },
      { servicioCodigo: 'SOAT', tipoVehiculo: 'Motocicleta', estado: 'inactivo' },
    ])
    assert.deepEqual(
      r.filas.map((f) => f.clave),
      [
        'RTM_PRIMERA',
        'RTM_SEGUNDA',
        'RTM_TOTAL',
        'SOAT',
        'PREV',
        'PERI',
        'SIN SERVICIO',
        'ZZZ',
        'TOTAL',
      ]
    )
    assert.include(fila(r.filas, 'RTM_PRIMERA'), { motos: 1, livianos: 1, total: 2 })
    assert.include(fila(r.filas, 'RTM_SEGUNDA'), { livianos: 1, total: 1 })
    assert.include(fila(r.filas, 'RTM_TOTAL'), {
      motos: 1,
      livianos: 2,
      total: 3,
      tipo: 'subtotal',
    })
    // PREV segunda vez: no se separa.
    assert.include(fila(r.filas, 'PREV'), { motos: 1, total: 1 })
    assert.include(fila(r.filas, 'SOAT'), { total: 0 })
    assert.include(fila(r.filas, 'ZZZ'), { otros: 1, total: 1 })
    assert.include(fila(r.filas, 'SIN SERVICIO'), { livianos: 1, total: 1 })
    assert.include(fila(r.filas, 'TOTAL'), {
      motos: 2,
      livianos: 3,
      otros: 1,
      total: 6,
      tipo: 'total',
    })
    assert.deepEqual(r.rechazo.primera_vez, {
      aprobadas: 0,
      rechazadas: 1,
      sin_resultado: 1,
      porcentaje: 100,
    })
    assert.deepEqual(r.rechazo.segunda_vez, {
      aprobadas: 1,
      rechazadas: 0,
      sin_resultado: 0,
      porcentaje: 0,
    })
    assert.equal(r.sin_finalizar, 1)
  })

  test('textoRechazo con un decimal y coma', ({ assert }) => {
    assert.equal(
      textoRechazo({ aprobadas: 17, rechazadas: 3, sin_resultado: 4, porcentaje: 15 }),
      '15,0% (3 de 20)'
    )
    assert.equal(
      textoRechazo({ aprobadas: 1, rechazadas: 2, sin_resultado: 0, porcentaje: 200 / 3 }),
      '66,7% (2 de 3)'
    )
    assert.equal(
      textoRechazo({ aprobadas: 0, rechazadas: 0, sin_resultado: 5, porcentaje: null }),
      '—'
    )
  })
})
