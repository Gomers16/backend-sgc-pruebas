import { test } from '@japa/runner'
import {
  calcularComision,
  convenioSinComisionPorDescuento,
  decidirCasoComision,
  esDescuentoFinalAvance,
  type ConfigComisionResuelta,
  type ConfigRecurrenciaResuelta,
  type ParametrosCalculoComision,
} from '#services/comision_calculo_service'

// Fixtures fijos, calcados de los valores reales de la fila de config global
// (es_config=true, asesor_id=NULL) confirmados en producción: monto=8640
// (valorDateoNuevo), valor_nuevo_directo=17280, valor_placa_*=20000
// (valorIncentivoCaso3). valorIncentivo/valorRecurrente son valores de
// ejemplo razonables (no dependen de la fila global), solo deben ser
// consistentes dentro de este archivo.
const cfgValues: ConfigComisionResuelta = {
  valorIncentivo: 15000,
  valorIncentivoPorTipo: 20000,
  valorIncentivoCaso3: 20000,
  valorDateoNuevo: 8640,
  valorNuevoDirecto: 17280,
}

const recValues: ConfigRecurrenciaResuelta = {
  valorRecurrente: 4320,
  valorRecuperacion: 8600,
}

const CODIGOS = [
  'INFORMATIVO',
  'AVANCE',
  'INFORMATIVO_EMPLEADO',
  'INFORMATIVO_POLICIA',
  'AVANCE_PROPIETARIO',
  'INFORMATIVO_OBSEQUIO',
  'INFORMATIVO_SOAT_RTM',
]
const ESCENARIOS = ['NUEVO', 'RECURRENTE', 'RECUPERACION'] as const

/** calcularComision con el descuento final = el activo (lo normal al confirmar). */
const calc = (
  p: Pick<ParametrosCalculoComision, 'caso' | 'escenario'> &
    Partial<Omit<ParametrosCalculoComision, 'caso' | 'escenario'>>
) =>
  calcularComision({
    tuvoContinuidad: false,
    montoAvance: 0,
    codigoDescuento: null,
    codigoDescuentoFinal: p.codigoDescuento ?? null,
    cfgValues,
    recValues,
    ...p,
  })

test.group('comision_calculo_service · calcularComision · Caso 1 (SIN_CONVENIO)', () => {
  test('Nuevo + informativo → paga valor_dateo_recurrencia (CAMBIO 1, antes era $0)', ({
    assert,
  }) => {
    const r = calc({
      caso: 'SIN_CONVENIO',
      escenario: 'NUEVO',
      codigoDescuento: 'INFORMATIVO_POLICIA',
    })
    assert.equal(r.monto, 4320)
    assert.equal(r.montoAsesor, 4320)
    assert.equal(r.montoConvenio, 0)
    assert.equal(r.base, 0)
    assert.notInclude(r.reglaAplicada, '$0')
  })

  test('Nuevo sin informativo → sigue pagando valor_nuevo_directo (sin regresión)', ({
    assert,
  }) => {
    const r = calc({ caso: 'SIN_CONVENIO', escenario: 'NUEVO' })
    assert.equal(r.montoAsesor, 17280)
    assert.equal(r.montoConvenio, 0)
  })

  test('Recurrente → sin cambios (sin regresión)', ({ assert }) => {
    const r = calc({ caso: 'SIN_CONVENIO', escenario: 'RECURRENTE' })
    assert.equal(r.montoAsesor, 4320)
    assert.equal(r.montoConvenio, 0)
  })

  test('el descuento no deja nada en $0 en el Caso 1 (7 descuentos, 3 escenarios)', ({
    assert,
  }) => {
    for (const escenario of ESCENARIOS) {
      for (const codigoDescuento of CODIGOS) {
        const r = calc({ caso: 'SIN_CONVENIO', escenario, codigoDescuento })
        assert.equal(r.montoAsesor, 4320, `${escenario}/${codigoDescuento}`)
        assert.isNull(r.descuentoMontoAplicado)
      }
    }
  })
})

test.group('comision_calculo_service · calcularComision · Caso 2 (CONVENIO_SELF)', () => {
  test('Nuevo sin descuento → sigue pagando valorIncentivo', ({ assert }) => {
    const r = calc({ caso: 'CONVENIO_SELF', escenario: 'NUEVO' })
    assert.equal(r.montoAsesor, 15000)
    assert.equal(r.montoConvenio, 0)
  })

  test('cualquier descuento final → $0 en todos los escenarios, con y sin continuidad', ({
    assert,
  }) => {
    for (const escenario of ESCENARIOS) {
      for (const tuvoContinuidad of [true, false]) {
        for (const codigoDescuento of CODIGOS) {
          const r = calc({ caso: 'CONVENIO_SELF', escenario, tuvoContinuidad, codigoDescuento })
          const k = `${escenario}/${tuvoContinuidad}/${codigoDescuento}`
          assert.equal(r.monto, 0, k)
          assert.equal(r.montoAsesor, 0, k)
          assert.equal(r.montoConvenio, 0, k)
          assert.deepEqual(r.camposUsados, [], k)
        }
      }
    }
  })

  test('Avance guarda su monto; los demás descuentos no', ({ assert }) => {
    const avance = calc({
      caso: 'CONVENIO_SELF',
      escenario: 'NUEVO',
      montoAvance: 6000,
      codigoDescuento: 'AVANCE',
    })
    assert.equal(avance.descuentoMontoAplicado, 6000)
    const otro = calc({
      caso: 'CONVENIO_SELF',
      escenario: 'NUEVO',
      montoAvance: 6000,
      codigoDescuento: 'AVANCE_PROPIETARIO',
    })
    assert.isNull(otro.descuentoMontoAplicado)
  })
})

test.group('comision_calculo_service · calcularComision · Caso 3 (CONVENIO_COMERCIAL)', () => {
  test('sin descuento → comercial $8.640 y convenio $20.000 en los 3 escenarios', ({ assert }) => {
    for (const escenario of ESCENARIOS) {
      const r = calc({ caso: 'CONVENIO_COMERCIAL', escenario, tuvoContinuidad: true })
      assert.equal(r.montoAsesor, 8640, escenario)
      assert.equal(r.montoConvenio, 20000, escenario)
    }
  })

  test('cualquier descuento final → convenio $0 y el comercial conserva su valor', ({ assert }) => {
    for (const escenario of ESCENARIOS) {
      for (const codigoDescuento of CODIGOS) {
        const r = calc({ caso: 'CONVENIO_COMERCIAL', escenario, codigoDescuento })
        const k = `${escenario}/${codigoDescuento}`
        assert.equal(r.montoAsesor, 8640, k)
        assert.equal(r.montoConvenio, 0, k)
        assert.deepEqual(r.camposUsados, ['valorDateoNuevo'], k)
      }
    }
  })

  test('descuento quitado en caja (dateo pre-marcado, factura sin descuento) → convenio cobra', ({
    assert,
  }) => {
    const r = calc({
      caso: 'CONVENIO_COMERCIAL',
      escenario: 'NUEVO',
      codigoDescuento: 'AVANCE',
      codigoDescuentoFinal: null,
    })
    assert.equal(r.montoAsesor, 8640)
    assert.equal(r.montoConvenio, 20000)
  })
})

test.group('decidirCasoComision', () => {
  const base = { convenioId: 10, agenteId: 5, canal: 'ASESOR_COMERCIAL', asesorConvenioIdDelConvenio: 7 }

  test('sin convenio → SIN_CONVENIO (aunque el canal sea ASESOR_CONVENIO)', ({ assert }) => {
    assert.equal(decidirCasoComision({ ...base, convenioId: null }), 'SIN_CONVENIO')
    assert.equal(decidirCasoComision({ ...base, convenioId: null, canal: 'ASESOR_CONVENIO' }), 'SIN_CONVENIO')
  })

  test('con convenio y datea el asesor del convenio → CONVENIO_SELF', ({ assert }) => {
    assert.equal(decidirCasoComision({ ...base, agenteId: 7 }), 'CONVENIO_SELF')
    assert.equal(decidirCasoComision({ ...base, canal: 'ASESOR_CONVENIO' }), 'CONVENIO_SELF')
    assert.equal(decidirCasoComision({ ...base, agenteId: null }), 'CONVENIO_SELF')
  })

  test('con convenio y datea un comercial → CONVENIO_COMERCIAL', ({ assert }) => {
    assert.equal(decidirCasoComision(base), 'CONVENIO_COMERCIAL')
  })
})

test.group('comision_calculo_service · convenioSinComisionPorDescuento', () => {
  test('con convenio, cualquier código final; sin descuento o en el Caso 1, nunca', ({
    assert,
  }) => {
    for (const codigo of CODIGOS) {
      assert.isTrue(
        convenioSinComisionPorDescuento({
          caso: 'CONVENIO_COMERCIAL',
          codigoDescuentoFinal: codigo,
        })
      )
      assert.isTrue(
        convenioSinComisionPorDescuento({ caso: 'CONVENIO_SELF', codigoDescuentoFinal: codigo })
      )
      assert.isFalse(
        convenioSinComisionPorDescuento({ caso: 'SIN_CONVENIO', codigoDescuentoFinal: codigo })
      )
    }
    assert.isFalse(
      convenioSinComisionPorDescuento({ caso: 'CONVENIO_COMERCIAL', codigoDescuentoFinal: null })
    )
  })

  test('esDescuentoFinalAvance: solo AVANCE con convenio (monto de avance y marca informativa)', ({
    assert,
  }) => {
    assert.isTrue(esDescuentoFinalAvance({ caso: 'CONVENIO_SELF', codigoDescuentoFinal: 'AVANCE' }))
    assert.isFalse(esDescuentoFinalAvance({ caso: 'SIN_CONVENIO', codigoDescuentoFinal: 'AVANCE' }))
    assert.isFalse(
      esDescuentoFinalAvance({
        caso: 'CONVENIO_COMERCIAL',
        codigoDescuentoFinal: 'AVANCE_PROPIETARIO',
      })
    )
  })
})
