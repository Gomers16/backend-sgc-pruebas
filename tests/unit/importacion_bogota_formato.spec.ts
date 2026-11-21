import { test } from '@japa/runner'
import app from '@adonisjs/core/services/app'
import fs from 'node:fs/promises'
import { esXls, leerXls } from '#services/importacion_bogota/lector_xls'
import {
  agruparPorVisita,
  type Celda,
  COL,
  esFilaTitulos,
  leerFecha,
  leerFila,
  normalizarPlaca,
  normalizarTelefono,
  texto,
} from '#services/importacion_bogota/formato_bogota'

/** Fila de 42 columnas con lo mínimo; `extra` pisa columnas por índice. */
function fila(extra: Record<number, Celda>): Celda[] {
  const f: Celda[] = Array.from({ length: 42 }, () => null)
  f[COL.FECHA] = 44564.5 // 2022-01-03 12:00
  f[COL.ESTADO] = 'APROBADO'
  f[COL.DURACION] = 1 / 24
  f[COL.CATEGORIA] = 'L1_LIVIANOS'
  f[COL.TIPO] = 'LIVIANO ORDINARIO'
  f[COL.PLACA] = 'ABC123'
  f[COL.DUENO_DOC_NUM] = 1012345678
  f[COL.DUENO_TELEFONO] = 3001234567
  for (const [k, v] of Object.entries(extra)) f[Number(k)] = v
  return f
}

test.group('Importación Bogotá · formato', () => {
  test('números sin notación científica; teléfonos de relleno descartados', ({ assert }) => {
    assert.equal(texto(3001234567), '3001234567')
    assert.equal(texto(1e15), '1000000000000000')
    assert.equal(texto('  x  '), 'x')
    assert.isNull(normalizarTelefono(0))
    assert.isNull(normalizarTelefono(2000000))
    assert.isNull(normalizarTelefono('9'))
    assert.equal(normalizarTelefono('300 123-4567'), '3001234567')
  })

  test('placa: quita puntos y guiones bajos; 5 a 7 caracteres', ({ assert }) => {
    assert.equal(normalizarPlaca('ZBV004.'), 'ZBV004')
    assert.equal(normalizarPlaca('zbn046_'), 'ZBN046')
    assert.isNull(normalizarPlaca('-'))
    assert.isNull(normalizarPlaca('AB1'))
  })

  test('fecha: serial de Excel con hora (hora de pared de Bogotá) y texto dd/MM/yyyy', ({
    assert,
  }) => {
    const d = leerFecha(44564.2956134259)!
    assert.equal(d.toFormat('yyyy-MM-dd HH:mm:ss'), '2022-01-03 07:05:41')
    assert.equal(d.zoneName, 'America/Bogota')
    assert.equal(leerFecha('03/01/2022 07:05')!.toFormat('yyyy-MM-dd HH:mm'), '2022-01-03 07:05')
    assert.isNull(leerFecha(''))
  })

  test('fila: servicio, tipo, clase y descartes', ({ assert }) => {
    const prev = leerFila(fila({ [COL.TIPO]: 'LIVIANO PREVENTIVA' }), 1)
    assert.isTrue(prev.ok)
    if (prev.ok) assert.equal(prev.fila.servicioCodigo, 'PREV')
    const taxi = leerFila(fila({ [COL.TIPO]: 'LIVIANO + TAXIMETRO ( AUDITORIA )' }), 2)
    if (taxi.ok) {
      assert.equal(taxi.fila.tipoVehiculo, 'Liviano Taxi')
      assert.equal(taxi.fila.claseVehiculoId, 2)
      assert.equal(taxi.fila.observacion, '(AUDITORIA)')
    }
    const sinPlaca = leerFila(fila({ [COL.PLACA]: '-' }), 3)
    assert.isFalse(sinPlaca.ok)
    if (!sinPlaca.ok) assert.equal(sinPlaca.descarte.motivo, 'PLACA_INVALIDA')
    const otroEstado = leerFila(fila({ [COL.ESTADO]: 'ANULADO' }), 4)
    if (!otroEstado.ok) assert.equal(otroEstado.descarte.motivo, 'ESTADO_DESCONOCIDO')
    const tel = leerFila(fila({ [COL.DUENO_TELEFONO]: 2000000 }), 5)
    if (tel.ok) {
      assert.isNull(tel.fila.dueno.telefono)
      assert.equal(tel.fila.telefonosDescartados, 1)
    }
  })

  test('agrupar: rechazado + aprobado el mismo día → un turno APROBADA; solo rechazado → RECHAZADA', ({
    assert,
  }) => {
    const leer = (n: number, extra: Record<number, Celda>) => {
      const r = leerFila(fila(extra), n)
      if (!r.ok) throw new Error('fila inválida')
      return r.fila
    }
    const filas = [
      leer(1, { [COL.FECHA]: 44564.3, [COL.ESTADO]: 'RECHAZADO' }), // 07:12
      leer(2, { [COL.FECHA]: 44564.4, [COL.ESTADO]: 'APROBADO' }), // 09:36
      leer(3, { [COL.FECHA]: 44565.4, [COL.ESTADO]: 'RECHAZADO', [COL.PLACA]: 'XYZ987' }),
      leer(4, { [COL.FECHA]: 44566.4, [COL.PLACA]: 'XYZ987' }),
      leer(5, { [COL.FECHA]: 44566.5, [COL.PLACA]: 'XYZ987' }),
    ]
    const { grupos, unificadas } = agruparPorVisita(filas)
    assert.lengthOf(grupos, 3)
    assert.lengthOf(unificadas, 2)
    const [a, b, c] = grupos
    assert.equal(a.resultado, 'APROBADA')
    assert.equal(a.hora, '07:12:00') // ingreso = la más temprana
    assert.equal(a.horaSalida, '10:36:00') // la más tardía + 1 h
    assert.include(a.observacion!, 'rechazado y aprobado el mismo día')
    assert.deepEqual(a.filas, [1, 2])
    assert.equal(b.resultado, 'RECHAZADA')
    assert.equal(c.resultado, 'APROBADA')
    assert.deepEqual(c.filas, [4, 5])
  })

  test('fila de títulos detectada; fila de datos nunca', ({ assert }) => {
    const titulos: Celda[] = Array.from({ length: 42 }, (_, i) => `COL${i}`)
    titulos[COL.PLACA] = 'PLACA'
    titulos[COL.FECHA] = 'FECHA'
    assert.isTrue(esFilaTitulos(titulos))
    assert.isFalse(esFilaTitulos(fila({})))
  })
})

test.group('Importación Bogotá · lector .xls', () => {
  test('lee la muestra (Excel 97-2003): 30 filas × 42 columnas, textos y números', async ({
    assert,
  }) => {
    const buf = await fs.readFile(app.makePath('tests/fixtures/importacion_bogota_muestra.xls'))
    assert.isTrue(esXls(buf))
    const hoja = leerXls(buf)
    assert.equal(hoja.nombre, 'BD 2022 ACT')
    assert.lengthOf(hoja.filas, 30)
    assert.equal(Math.max(...hoja.filas.map((f) => f.length)), 42)
    assert.isFalse(hoja.fecha1904)
    assert.equal(hoja.filas[0][COL.PLACA], 'ZBA001')
    assert.typeOf(hoja.filas[0][COL.FECHA], 'number')
    assert.match(String(hoja.filas[0][COL.DUENO_NOMBRE]), /^CLIENTE PRUEBA \d+$/)
    assert.equal(texto(hoja.filas[0][COL.DUENO_DOC_NUM])!.slice(0, 4), '9900')
  })

  test('un archivo que no es .xls se rechaza', ({ assert }) => {
    assert.isFalse(esXls(Buffer.from('PK\u0003\u0004')))
    assert.throws(() => leerXls(Buffer.from('no es excel')), /Excel 97-2003/)
  })
})
