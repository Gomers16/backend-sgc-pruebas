import { test } from '@japa/runner'
import { resolverDecisionComision } from '#services/decision_comision_ticket_service'

const base = {
  dentroVentana: false,
  conComisionAsesor: undefined as unknown,
  conComisionConvenio: undefined as unknown,
  conComision: undefined as unknown,
}

test.group('resolverDecisionComision', () => {
  test('dentro de ventana: sin decisión, aunque lleguen flags', ({ assert }) => {
    const r = resolverDecisionComision({
      ...base,
      dentroVentana: true,
      caso: 'CONVENIO_COMERCIAL',
      conComisionAsesor: false,
      conComisionConvenio: false,
    })
    assert.deepEqual(r, { ok: true, decision: { asesor: null, convenio: null } })
  })

  test('falta el flag del asesor → error', ({ assert }) => {
    assert.isFalse(resolverDecisionComision({ ...base, caso: 'SIN_CONVENIO' }).ok)
    assert.isFalse(
      resolverDecisionComision({ ...base, caso: 'SIN_CONVENIO', conComisionAsesor: 'false' }).ok
    )
  })

  test('Caso 1: solo asesor; flag de convenio → error', ({ assert }) => {
    assert.deepEqual(
      resolverDecisionComision({ ...base, caso: 'SIN_CONVENIO', conComisionAsesor: false }),
      { ok: true, decision: { asesor: false, convenio: null } }
    )
    assert.isFalse(
      resolverDecisionComision({
        ...base,
        caso: 'SIN_CONVENIO',
        conComisionAsesor: true,
        conComisionConvenio: true,
      }).ok
    )
  })

  test('Caso 2: flags iguales (el de convenio se copia si no viene); distintos → error', ({
    assert,
  }) => {
    assert.deepEqual(
      resolverDecisionComision({ ...base, caso: 'CONVENIO_SELF', conComisionAsesor: false }),
      { ok: true, decision: { asesor: false, convenio: false } }
    )
    assert.deepEqual(
      resolverDecisionComision({
        ...base,
        caso: 'CONVENIO_SELF',
        conComisionAsesor: true,
        conComisionConvenio: true,
      }),
      { ok: true, decision: { asesor: true, convenio: true } }
    )
    assert.isFalse(
      resolverDecisionComision({
        ...base,
        caso: 'CONVENIO_SELF',
        conComisionAsesor: true,
        conComisionConvenio: false,
      }).ok
    )
  })

  test('Caso 3: las 4 combinaciones; sin flag de convenio → error', ({ assert }) => {
    for (const asesor of [true, false]) {
      for (const convenio of [true, false]) {
        assert.deepEqual(
          resolverDecisionComision({
            ...base,
            caso: 'CONVENIO_COMERCIAL',
            conComisionAsesor: asesor,
            conComisionConvenio: convenio,
          }),
          { ok: true, decision: { asesor, convenio } }
        )
      }
    }
    assert.isFalse(
      resolverDecisionComision({ ...base, caso: 'CONVENIO_COMERCIAL', conComisionAsesor: true }).ok
    )
  })

  test('formato anterior (solo con_comision): asesor = valor, convenio cobra', ({ assert }) => {
    assert.deepEqual(
      resolverDecisionComision({ ...base, caso: 'CONVENIO_COMERCIAL', conComision: false }),
      { ok: true, decision: { asesor: false, convenio: true } }
    )
    assert.deepEqual(
      resolverDecisionComision({ ...base, caso: 'SIN_CONVENIO', conComision: true }),
      { ok: true, decision: { asesor: true, convenio: null } }
    )
  })
})
