import { test } from '@japa/runner'
import { resolverDecisionComision } from '#services/decision_comision_ticket_service'

const base = {
  dentroVentana: false,
  conComisionAsesor: undefined as unknown,
  conComisionConvenio: undefined as unknown,
  conComision: undefined as unknown,
}

test.group('resolverDecisionComision', () => {
  test('dentro de ventana sin flags (frontend anterior): comisión completa', ({ assert }) => {
    const dentro = { ...base, dentroVentana: true }
    assert.deepEqual(resolverDecisionComision({ ...dentro, caso: 'SIN_CONVENIO' }), {
      ok: true,
      decision: { asesor: true, convenio: null },
    })
    for (const caso of ['CONVENIO_SELF', 'CONVENIO_COMERCIAL'] as const) {
      assert.deepEqual(resolverDecisionComision({ ...dentro, caso }), {
        ok: true,
        decision: { asesor: true, convenio: true },
      })
    }
  })

  test('dentro de ventana con flags: se decide igual que fuera, con las mismas reglas', ({
    assert,
  }) => {
    const dentro = { ...base, dentroVentana: true }
    assert.deepEqual(
      resolverDecisionComision({
        ...dentro,
        caso: 'CONVENIO_COMERCIAL',
        conComisionAsesor: true,
        conComisionConvenio: false,
      }),
      { ok: true, decision: { asesor: true, convenio: false } }
    )
    assert.deepEqual(
      resolverDecisionComision({ ...dentro, caso: 'SIN_CONVENIO', conComisionAsesor: false }),
      { ok: true, decision: { asesor: false, convenio: null } }
    )
    // Combinaciones imposibles también dentro de ventana.
    assert.isFalse(
      resolverDecisionComision({ ...dentro, caso: 'CONVENIO_COMERCIAL', conComisionAsesor: true })
        .ok
    )
    assert.isFalse(
      resolverDecisionComision({
        ...dentro,
        caso: 'SIN_CONVENIO',
        conComisionAsesor: true,
        conComisionConvenio: true,
      }).ok
    )
    assert.isFalse(
      resolverDecisionComision({
        ...dentro,
        caso: 'CONVENIO_SELF',
        conComisionAsesor: true,
        conComisionConvenio: false,
      }).ok
    )
    // Solo el flag de convenio, sin el del asesor: error.
    assert.isFalse(
      resolverDecisionComision({
        ...dentro,
        caso: 'CONVENIO_COMERCIAL',
        conComisionConvenio: false,
      }).ok
    )
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
