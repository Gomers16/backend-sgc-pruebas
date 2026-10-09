import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
  ROLES_FECHA_RETROACTIVA,
  hoyServidorISO,
  puedeCrearConFechaRetroactiva,
  validarFechaTurno,
} from '#services/fecha_turno_service'

const HOY = '2026-10-09'
const AYER = '2026-10-08'
const MANANA = '2026-10-10'

test.group('fecha_turno_service · roles', () => {
  test('roles permitidos: SUPER_ADMIN y GERENCIA', ({ assert }) => {
    assert.deepEqual([...ROLES_FECHA_RETROACTIVA], ['SUPER_ADMIN', 'GERENCIA'])
    assert.isTrue(puedeCrearConFechaRetroactiva('SUPER_ADMIN'))
    assert.isTrue(puedeCrearConFechaRetroactiva('GERENCIA'))
    assert.isFalse(puedeCrearConFechaRetroactiva('OPERATIVO_TURNOS'))
    assert.isFalse(puedeCrearConFechaRetroactiva('TRAMITADOR'))
    assert.isFalse(puedeCrearConFechaRetroactiva(null))
    assert.isFalse(puedeCrearConFechaRetroactiva(undefined))
  })
})

test.group('fecha_turno_service · validarFechaTurno', () => {
  test('hoy se acepta con cualquier rol (también sin rol)', ({ assert }) => {
    for (const rol of ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS', 'TRAMITADOR', null]) {
      assert.isNull(validarFechaTurno({ fechaISO: HOY, hoyISO: HOY, rol }))
    }
  })

  test('fecha anterior: SUPER_ADMIN y GERENCIA permitidos', ({ assert }) => {
    assert.isNull(validarFechaTurno({ fechaISO: AYER, hoyISO: HOY, rol: 'SUPER_ADMIN' }))
    assert.isNull(validarFechaTurno({ fechaISO: AYER, hoyISO: HOY, rol: 'GERENCIA' }))
    assert.isNull(validarFechaTurno({ fechaISO: '2025-01-15', hoyISO: HOY, rol: 'GERENCIA' }))
  })

  test('fecha anterior: OPERATIVO_TURNOS, TRAMITADOR y sin rol → 403', ({ assert }) => {
    for (const rol of ['OPERATIVO_TURNOS', 'TRAMITADOR', null]) {
      const e = validarFechaTurno({ fechaISO: AYER, hoyISO: HOY, rol })
      assert.equal(e?.status, 403)
      assert.equal(e?.code, 'FECHA_RETROACTIVA_NO_AUTORIZADA')
    }
  })

  test('fecha futura → 422 para todos, incluso SUPER_ADMIN', ({ assert }) => {
    for (const rol of ['SUPER_ADMIN', 'GERENCIA', 'OPERATIVO_TURNOS']) {
      const e = validarFechaTurno({ fechaISO: MANANA, hoyISO: HOY, rol })
      assert.equal(e?.status, 422)
      assert.equal(e?.code, 'FECHA_FUTURA')
    }
  })

  test('bordes de mes y año', ({ assert }) => {
    assert.isNull(
      validarFechaTurno({ fechaISO: '2026-12-31', hoyISO: '2027-01-01', rol: 'GERENCIA' })
    )
    assert.equal(
      validarFechaTurno({ fechaISO: '2027-01-01', hoyISO: '2026-12-31', rol: 'GERENCIA' })?.code,
      'FECHA_FUTURA'
    )
  })
})

test.group('fecha_turno_service · hoyServidorISO', () => {
  test('usa la fecha de Bogotá, no la UTC', ({ assert }) => {
    // 2026-10-10 03:00 UTC = 2026-10-09 22:00 en Bogotá (UTC-5)
    const ahora = DateTime.fromISO('2026-10-10T03:00:00', { zone: 'utc' })
    assert.equal(hoyServidorISO(ahora), '2026-10-09')
  })
})
