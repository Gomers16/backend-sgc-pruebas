import { test } from '@japa/runner'
import {
  calcularComision,
  type ConfigComisionResuelta,
  type ConfigRecurrenciaResuelta,
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

test.group('comision_calculo_service · calcularComision · Caso 1 (SIN_CONVENIO)', () => {
  test('Nuevo + informativo → paga valor_dateo_recurrencia (CAMBIO 1, antes era $0)', ({
    assert,
  }) => {
    const r = calcularComision({
      caso: 'SIN_CONVENIO',
      escenario: 'NUEVO',
      tuvoContinuidad: false,
      esAvance: false,
      montoAvance: 0,
      codigoDescuento: 'INFORMATIVO_POLICIA',
      origenDescuento: 'DATEO',
      cfgValues,
      recValues,
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
    const r = calcularComision({
      caso: 'SIN_CONVENIO',
      escenario: 'NUEVO',
      tuvoContinuidad: false,
      esAvance: false,
      montoAvance: 0,
      codigoDescuento: null,
      origenDescuento: null,
      cfgValues,
      recValues,
    })
    assert.equal(r.montoAsesor, 17280)
    assert.equal(r.montoConvenio, 0)
  })

  test('Recurrente → sin cambios (sin regresión)', ({ assert }) => {
    const r = calcularComision({
      caso: 'SIN_CONVENIO',
      escenario: 'RECURRENTE',
      tuvoContinuidad: false,
      esAvance: false,
      montoAvance: 0,
      codigoDescuento: null,
      origenDescuento: null,
      cfgValues,
      recValues,
    })
    assert.equal(r.montoAsesor, 4320)
    assert.equal(r.montoConvenio, 0)
  })
})

test.group(
  'comision_calculo_service · calcularComision · Caso 2 (CONVENIO_SELF) — regresión',
  () => {
    test('Avance → sigue en $0/$0', ({ assert }) => {
      const r = calcularComision({
        caso: 'CONVENIO_SELF',
        escenario: 'NUEVO',
        tuvoContinuidad: false,
        esAvance: true,
        montoAvance: 6000,
        codigoDescuento: null,
        origenDescuento: null,
        cfgValues,
        recValues,
      })
      assert.equal(r.montoAsesor, 0)
      assert.equal(r.montoConvenio, 0)
      assert.equal(r.descuentoMontoAplicado, 6000)
    })

    test('Nuevo → sigue pagando valorIncentivo', ({ assert }) => {
      const r = calcularComision({
        caso: 'CONVENIO_SELF',
        escenario: 'NUEVO',
        tuvoContinuidad: false,
        esAvance: false,
        montoAvance: 0,
        codigoDescuento: null,
        origenDescuento: null,
        cfgValues,
        recValues,
      })
      assert.equal(r.montoAsesor, 15000)
      assert.equal(r.montoConvenio, 0)
    })
  }
)

test.group('comision_calculo_service · calcularComision · Caso 3 (CONVENIO_COMERCIAL)', () => {
  test('Nuevo + normal → montoAsesor=$8,640, montoConvenio sin cambios', ({ assert }) => {
    const r = calcularComision({
      caso: 'CONVENIO_COMERCIAL',
      escenario: 'NUEVO',
      tuvoContinuidad: false,
      esAvance: false,
      montoAvance: 0,
      codigoDescuento: null,
      origenDescuento: null,
      cfgValues,
      recValues,
    })
    assert.equal(r.montoAsesor, 8640)
    assert.equal(r.montoConvenio, 20000)
  })

  test('Nuevo + avance → montoAsesor=$8,640, montoConvenio=$0 sin cambios', ({ assert }) => {
    const r = calcularComision({
      caso: 'CONVENIO_COMERCIAL',
      escenario: 'NUEVO',
      tuvoContinuidad: false,
      esAvance: true,
      montoAvance: 6000,
      codigoDescuento: null,
      origenDescuento: null,
      cfgValues,
      recValues,
    })
    assert.equal(r.montoAsesor, 8640)
    assert.equal(r.montoConvenio, 0)
  })

  test('Recurrente + normal → montoAsesor=$8,640, montoConvenio sin cambios', ({ assert }) => {
    const r = calcularComision({
      caso: 'CONVENIO_COMERCIAL',
      escenario: 'RECURRENTE',
      tuvoContinuidad: true,
      esAvance: false,
      montoAvance: 0,
      codigoDescuento: null,
      origenDescuento: null,
      cfgValues,
      recValues,
    })
    assert.equal(r.montoAsesor, 8640)
    assert.equal(r.montoConvenio, 20000)
  })

  test('Recurrente + avance → montoAsesor=$8,640, montoConvenio=$0 sin cambios', ({ assert }) => {
    const r = calcularComision({
      caso: 'CONVENIO_COMERCIAL',
      escenario: 'RECURRENTE',
      tuvoContinuidad: true,
      esAvance: true,
      montoAvance: 6000,
      codigoDescuento: null,
      origenDescuento: null,
      cfgValues,
      recValues,
    })
    assert.equal(r.montoAsesor, 8640)
    assert.equal(r.montoConvenio, 0)
  })

  test('Nuevo + descuento especial en caja → montoAsesor=$8,640 (CAMBIO 2, antes era $4,320)', ({
    assert,
  }) => {
    const r = calcularComision({
      caso: 'CONVENIO_COMERCIAL',
      escenario: 'NUEVO',
      tuvoContinuidad: false,
      esAvance: false,
      montoAvance: 0,
      codigoDescuento: 'INFORMATIVO_POLICIA',
      origenDescuento: 'CAJA',
      cfgValues,
      recValues,
    })
    assert.equal(r.montoAsesor, 8640)
    assert.equal(r.montoConvenio, 0)
  })

  test('Recuperación + normal → montoAsesor=$8,640 (misma fórmula que Recurrente, sin rama especial de caja)', ({
    assert,
  }) => {
    const r = calcularComision({
      caso: 'CONVENIO_COMERCIAL',
      escenario: 'RECUPERACION',
      tuvoContinuidad: false,
      esAvance: false,
      montoAvance: 0,
      codigoDescuento: 'INFORMATIVO_POLICIA',
      origenDescuento: 'CAJA',
      cfgValues,
      recValues,
    })
    assert.equal(r.montoAsesor, 8640)
    assert.equal(r.montoConvenio, 20000)
  })
})
