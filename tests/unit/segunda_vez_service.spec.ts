import { test } from '@japa/runner'
import { DateTime } from 'luxon'
import {
  HORAS_VENTANA,
  SERVICIOS_SEGUNDA_VEZ,
  aplicaSegundaVez,
  calcularVentanaHasta,
  camposAlCertificar,
  esTurnoQueDaVigencia,
  esTurnoSegundaVez,
  estadoVentana,
  horasRestantes,
  instanteRechazo,
  parseResultadoCertificacion,
} from '#services/segunda_vez_service'
import { computeEtapasTurno, getEtapasRequeridas } from '#services/turno_etapas_service'

const ZONA = 'America/Bogota'
const rechazo = DateTime.fromISO('2026-10-05T14:30:15', { zone: ZONA })

test.group('segunda_vez_service · constantes y servicios', () => {
  test('constantes: RTM y PREV, 360 horas', ({ assert }) => {
    assert.deepEqual([...SERVICIOS_SEGUNDA_VEZ], ['RTM', 'PREV'])
    assert.equal(HORAS_VENTANA, 360)
  })

  test('aplicaSegundaVez por código de servicio', ({ assert }) => {
    assert.isTrue(aplicaSegundaVez('RTM'))
    assert.isTrue(aplicaSegundaVez('PREV'))
    assert.isTrue(aplicaSegundaVez(' rtm '))
    assert.isFalse(aplicaSegundaVez('SOAT'))
    assert.isFalse(aplicaSegundaVez('PERI'))
    assert.isFalse(aplicaSegundaVez(''))
    assert.isFalse(aplicaSegundaVez(null))
    assert.isFalse(aplicaSegundaVez(undefined))
  })

  test('parseResultadoCertificacion', ({ assert }) => {
    assert.equal(parseResultadoCertificacion('APROBADA'), 'APROBADA')
    assert.equal(parseResultadoCertificacion('rechazada'), 'RECHAZADA')
    assert.isNull(parseResultadoCertificacion(''))
    assert.isNull(parseResultadoCertificacion(undefined))
    assert.isNull(parseResultadoCertificacion('OTRO'))
  })
})

test.group('segunda_vez_service · ventana', () => {
  test('calcularVentanaHasta = +360 h exactas (15 días corridos)', ({ assert }) => {
    const hasta = calcularVentanaHasta(rechazo)
    assert.equal(hasta.diff(rechazo, 'hours').hours, 360)
    assert.equal(hasta.toISO(), DateTime.fromISO('2026-10-20T14:30:15', { zone: ZONA }).toISO())
  })

  test('instanteRechazo usa Bogotá y trunca a segundos', ({ assert }) => {
    const utc = DateTime.fromISO('2026-10-05T19:30:15.987Z', { zone: 'utc' })
    const r = instanteRechazo(utc)
    assert.equal(r.zoneName, ZONA)
    assert.equal(r.millisecond, 0)
    assert.equal(r.toFormat('yyyy-LL-dd HH:mm:ss'), '2026-10-05 14:30:15')
  })

  test('ventana ABIERTA en hasta - 1 ms', ({ assert }) => {
    const hasta = calcularVentanaHasta(rechazo)
    const t = { ventanaSegundaVezHasta: hasta }
    assert.equal(estadoVentana(t, hasta.minus({ milliseconds: 1 })), 'ABIERTA')
    assert.equal(estadoVentana(t, rechazo), 'ABIERTA')
  })

  test('ventana VENCIDA en hasta exacto (borde estricto) y después', ({ assert }) => {
    const hasta = calcularVentanaHasta(rechazo)
    const t = { ventanaSegundaVezHasta: hasta }
    assert.equal(estadoVentana(t, hasta), 'VENCIDA')
    assert.equal(estadoVentana(t, hasta.plus({ milliseconds: 1 })), 'VENCIDA')
  })

  test('el borde no depende de la zona de "ahora"', ({ assert }) => {
    const hasta = calcularVentanaHasta(rechazo)
    const t = { ventanaSegundaVezHasta: hasta }
    assert.equal(estadoVentana(t, hasta.setZone('utc')), 'VENCIDA')
    assert.equal(estadoVentana(t, hasta.setZone('utc').minus({ milliseconds: 1 })), 'ABIERTA')
  })

  test('sin ventana → NO_APLICA', ({ assert }) => {
    assert.equal(estadoVentana({ ventanaSegundaVezHasta: null }, rechazo), 'NO_APLICA')
    assert.equal(estadoVentana({}, rechazo), 'NO_APLICA')
  })
})

test.group('segunda_vez_service · es_segunda_vez (TINYINT 0/1)', () => {
  test('Boolean() con 0/1, true/false y null', ({ assert }) => {
    assert.isTrue(esTurnoSegundaVez({ esSegundaVez: 1 }))
    assert.isFalse(esTurnoSegundaVez({ esSegundaVez: 0 }))
    assert.isTrue(esTurnoSegundaVez({ esSegundaVez: true }))
    assert.isFalse(esTurnoSegundaVez({ esSegundaVez: false }))
    assert.isFalse(esTurnoSegundaVez({ esSegundaVez: null }))
    assert.isFalse(esTurnoSegundaVez({}))
  })
})

test.group('segunda_vez_service · camposAlCertificar', () => {
  test('RTM RECHAZADA (primera vez) abre ventana de 360 h', ({ assert }) => {
    const c = camposAlCertificar({
      codigoServicio: 'RTM',
      resultado: 'RECHAZADA',
      esSegundaVez: 0,
      ahora: rechazo.plus({ milliseconds: 450 }),
    })
    assert.equal(c.resultadoCertificacion, 'RECHAZADA')
    assert.equal(c.rechazadoAt!.toISO(), rechazo.toISO())
    assert.equal(c.ventanaSegundaVezHasta!.diff(c.rechazadoAt!, 'hours').hours, 360)
  })

  test('segunda vez RECHAZADA (es_segunda_vez=1) no abre otra ventana', ({ assert }) => {
    const c = camposAlCertificar({
      codigoServicio: 'PREV',
      resultado: 'RECHAZADA',
      esSegundaVez: 1,
      ahora: rechazo,
    })
    assert.equal(c.resultadoCertificacion, 'RECHAZADA')
    assert.isNotNull(c.rechazadoAt)
    assert.isNull(c.ventanaSegundaVezHasta)
  })

  test('APROBADA no llena rechazo ni ventana', ({ assert }) => {
    const c = camposAlCertificar({
      codigoServicio: 'RTM',
      resultado: 'APROBADA',
      esSegundaVez: 0,
      ahora: rechazo,
    })
    assert.deepEqual(c, {
      resultadoCertificacion: 'APROBADA',
      rechazadoAt: null,
      ventanaSegundaVezHasta: null,
    })
  })

  test('SOAT/PERI ignoran el resultado', ({ assert }) => {
    for (const codigo of ['SOAT', 'PERI']) {
      const c = camposAlCertificar({
        codigoServicio: codigo,
        resultado: 'RECHAZADA',
        esSegundaVez: 0,
        ahora: rechazo,
      })
      assert.deepEqual(c, {
        resultadoCertificacion: null,
        rechazadoAt: null,
        ventanaSegundaVezHasta: null,
      })
    }
  })
})

test.group('segunda_vez_service · esTurnoQueDaVigencia', () => {
  test('finalizado + NULL o APROBADA da vigencia; RECHAZADA no', ({ assert }) => {
    assert.isTrue(esTurnoQueDaVigencia({ estado: 'finalizado', resultadoCertificacion: null }))
    assert.isTrue(esTurnoQueDaVigencia({ estado: 'finalizado' }))
    assert.isTrue(
      esTurnoQueDaVigencia({ estado: 'finalizado', resultadoCertificacion: 'APROBADA' })
    )
    assert.isFalse(
      esTurnoQueDaVigencia({ estado: 'finalizado', resultadoCertificacion: 'RECHAZADA' })
    )
    assert.isFalse(esTurnoQueDaVigencia({ estado: 'activo', resultadoCertificacion: 'APROBADA' }))
    assert.isFalse(esTurnoQueDaVigencia({ estado: 'cancelado', resultadoCertificacion: null }))
  })
})

test.group('segunda_vez_service · estadoVentana completo (B1)', () => {
  const hasta = calcularVentanaHasta(rechazo)
  const origen = {
    ventanaSegundaVezHasta: hasta,
    estado: 'finalizado',
    resultadoCertificacion: 'RECHAZADA' as const,
  }
  const dentro = hasta.minus({ hours: 1 })

  test('ABIERTA sin hija ni turno posterior', ({ assert }) => {
    assert.equal(estadoVentana(origen, dentro), 'ABIERTA')
    assert.equal(
      estadoVentana(origen, dentro, { hijoActivo: false, turnoPosterior: false }),
      'ABIERTA'
    )
  })

  test('USADA si tiene una segunda vez activa (aunque ya haya vencido)', ({ assert }) => {
    assert.equal(estadoVentana(origen, dentro, { hijoActivo: true }), 'USADA')
    assert.equal(estadoVentana(origen, hasta.plus({ days: 1 }), { hijoActivo: true }), 'USADA')
  })

  test('SUPERADA si hubo un turno posterior que no es su segunda vez', ({ assert }) => {
    assert.equal(estadoVentana(origen, dentro, { turnoPosterior: true }), 'SUPERADA')
  })

  test('ANULADA si el origen ya no es un rechazo finalizado', ({ assert }) => {
    assert.equal(estadoVentana({ ...origen, estado: 'cancelado' }, dentro), 'ANULADA')
    assert.equal(
      estadoVentana({ ...origen, resultadoCertificacion: 'APROBADA' as const }, dentro),
      'ANULADA'
    )
  })

  test('VENCIDA en el borde exacto también con contexto vacío', ({ assert }) => {
    assert.equal(estadoVentana(origen, hasta, {}), 'VENCIDA')
    assert.equal(estadoVentana(origen, hasta.minus({ milliseconds: 1 }), {}), 'ABIERTA')
  })

  test('horasRestantes: 0 si ya venció, con decimales si no', ({ assert }) => {
    assert.equal(horasRestantes(hasta, hasta.plus({ minutes: 1 })), 0)
    assert.equal(horasRestantes(hasta, hasta.minus({ minutes: 90 })), 1.5)
  })
})

test.group('turno_etapas_service · segunda vez', () => {
  test('segunda vez: solo Puerta y Certificación (también con 0/1)', ({ assert }) => {
    assert.deepEqual(getEtapasRequeridas('RTM', true), ['puerta', 'certificacion'])
    assert.deepEqual(getEtapasRequeridas('PREV', 1), ['puerta', 'certificacion'])
    assert.deepEqual(getEtapasRequeridas('RTM', 0), ['puerta', 'facturacion', 'certificacion'])
    assert.deepEqual(getEtapasRequeridas('SOAT'), ['puerta', 'facturacion'])
  })

  test('segunda vez certificada sin facturación queda "finalizado", no "incompleto"', ({
    assert,
  }) => {
    const r = computeEtapasTurno({
      servicioCodigo: 'RTM',
      esSegundaVez: 1,
      estado: 'finalizado',
      horaIngreso: '08:00',
      tieneFacturacion: false,
      horaSalida: '09:00:00',
    })
    assert.equal(r.estadoVisual, 'finalizado')
    assert.equal(r.totalRequeridas, 2)
  })
})
