import { test } from '@japa/runner'
import Database from '@adonisjs/lucid/services/db'
import {
  calcularComision,
  esAvanceEfectivo,
  resolveConfigComision,
  resolveConfigRecurrencia,
  type CasoComision,
  type EscenarioCliente,
  type OrigenDescuento,
  type TipoVehiculoComision,
} from '#services/comision_calculo_service'
import { armarDesglose } from '#services/comision_ticket_service'

// Lo que promete el diálogo (desglose: montos, regla, explicación y avisos)
// contra lo que paga calcularComision() con la configuración vigente de la
// BD, para los 3 casos, escenarios, continuidad, vehículos, los 7 descuentos
// del catálogo más "sin descuento", origen (dateo o caja) y marca de avance
// del dateo (solo informativa: manda el descuento final, esAvanceEfectivo).
// Solo lee.

const SIN_FILA = 999999999 // asesor sin fila propia → configuración Global

const personas = {
  comercial: { id: 1, nombre: 'Comercial', tipo: 'ASESOR_COMERCIAL' },
  asesorConvenio: { id: 2, nombre: 'Asesor convenio', tipo: 'ASESOR_CONVENIO' },
  convenio: { id: 3, nombre: 'Convenio', tipo: 'TALLER' },
}

test.group('Desglose de comisión = calcularComision (configuración vigente)', () => {
  test('matriz completa: montos, regla, textos y avisos coinciden con el motor', async ({
    assert,
  }) => {
    const descuentos = await Database.from('descuentos').orderBy('id').select('codigo')
    const codigos: (string | null)[] = [null, ...descuentos.map((d) => d.codigo)]
    assert.isAtLeast(codigos.length, 8, 'catálogo de descuentos')

    // Perfiles de convenio: sin fila (Global) y, si existe, uno con fila propia.
    const filaPropia = await Database.from('comisiones as c')
      .join('agentes_captacions as a', 'a.id', 'c.asesor_id')
      .where('c.es_config', true)
      .where('a.tipo', 'ASESOR_CONVENIO')
      .select('c.asesor_id')
      .first()
    const convenios = [SIN_FILA, ...(filaPropia ? [Number(filaPropia.asesor_id)] : [])]

    let combinaciones = 0
    const casos: CasoComision[] = ['SIN_CONVENIO', 'CONVENIO_SELF', 'CONVENIO_COMERCIAL']
    for (const caso of casos)
      for (const convenioId of caso === 'SIN_CONVENIO' ? [null] : convenios)
        for (const tv of ['VEHICULO', 'MOTO'] as TipoVehiculoComision[]) {
          const asesorId = caso === 'CONVENIO_SELF' ? convenioId : SIN_FILA
          const cfgValues = await resolveConfigComision({
            asesorId,
            asesorConvenioId: convenioId,
            tipoVehiculo: tv,
          })
          const recValues = await resolveConfigRecurrencia(asesorId, tv)
          for (const escenario of ['NUEVO', 'RECURRENTE', 'RECUPERACION'] as EscenarioCliente[])
            for (const continuidad of caso === 'CONVENIO_SELF'
              ? ['CONTINUA', 'ROTA']
              : ['CONTINUA'])
              for (const codigo of codigos)
                for (const origen of (codigo
                  ? ['DATEO', 'CAJA']
                  : [null]) as (OrigenDescuento | null)[])
                  for (const marca of caso === 'SIN_CONVENIO' ? [false] : [false, true]) {
                    combinaciones++
                    const esAvance = esAvanceEfectivo({ caso, codigoDescuento: codigo })
                    const donde = `${caso}/${convenioId}/${tv}/${escenario}/${continuidad}/${codigo}/${origen}/marca=${marca}`
                    const r = calcularComision({
                      caso,
                      escenario,
                      tuvoContinuidad: continuidad !== 'ROTA',
                      esAvance,
                      montoAvance: esAvance ? 10000 : 0,
                      codigoDescuento: codigo,
                      origenDescuento: origen,
                      cfgValues,
                      recValues,
                    })
                    const d = armarDesglose({
                      caso,
                      escenario,
                      tipoVehiculo: tv,
                      continuidadEstado: caso === 'SIN_CONVENIO' ? null : continuidad,
                      codigoDescuento: codigo,
                      origenDescuento: origen,
                      esAvance,
                      marcaAvanceDateo: marca,
                      cfgValues,
                      recValues,
                      resultado: r,
                      despues: { montoAsesor: r.montoAsesor, montoConvenio: r.montoConvenio },
                      guardada: null,
                      personas,
                      sinComisionTicket: { asesor: false, convenio: false },
                    })
                    const rol = (x: string) => d.beneficiarios.find((b) => b.rol === x)

                    // 1. Montos por beneficiario = motor.
                    if (caso === 'CONVENIO_SELF') {
                      assert.lengthOf(d.beneficiarios, 1, donde)
                      assert.equal(rol('ASESOR_CONVENIO')!.despues, r.montoAsesor, donde)
                      assert.equal(r.montoConvenio, 0, donde)
                    } else {
                      assert.equal(rol('ASESOR_COMERCIAL')!.despues, r.montoAsesor, donde)
                      if (caso === 'CONVENIO_COMERCIAL')
                        assert.equal(rol('CONVENIO')!.despues, r.montoConvenio, donde)
                      else assert.lengthOf(d.beneficiarios, 1, donde)
                    }
                    assert.equal(d.regla, r.reglaAplicada, donde)
                    assert.equal(d.explicacion, r.explicacion, donde)

                    // 2. Los valores de configuración marcados como usados son los que pagan.
                    const usados = d.configuracion.filter((v) => v.usado)
                    const valor = (campo: string) => usados.find((v) => v.campo === campo)?.valor
                    if (caso === 'CONVENIO_COMERCIAL') {
                      assert.equal(valor('valorDateoNuevo'), r.montoAsesor, donde)
                      assert.equal(valor('valorIncentivoCaso3') ?? 0, r.montoConvenio, donde)
                    } else {
                      assert.isAtMost(usados.length, 1, donde)
                      assert.equal(usados[0]?.valor ?? 0, r.montoAsesor, donde)
                    }

                    // 3. Lo que dice el texto coincide con lo que paga.
                    assert.notInclude(d.explicacion, 'valor básico', donde)
                    if (caso === 'SIN_CONVENIO' && escenario === 'NUEVO' && codigo)
                      assert.include(d.explicacion, 'valor de recurrencia', donde)
                    if (caso === 'CONVENIO_SELF' && usados.length === 0)
                      assert.include(d.explicacion, 'queda en $0', donde)
                    if (caso === 'CONVENIO_COMERCIAL') {
                      const convenioPorRegla = !r.camposUsados.includes('valorIncentivoCaso3')
                      if (convenioPorRegla)
                        assert.include(d.explicacion, 'convenio queda en $0', donde)
                      else assert.notInclude(d.explicacion, 'queda en $0', donde)
                    }
                    if (caso !== 'CONVENIO_COMERCIAL' && usados.length)
                      assert.notInclude(d.explicacion, 'queda en $0', donde)

                    // 3b. Avance (dateo o caja, cualquier escenario): Caso 3 convenio $0 y
                    // el comercial conserva su valor; Caso 2 en $0; Caso 1 lo ignora.
                    if (codigo === 'AVANCE') {
                      if (caso === 'CONVENIO_COMERCIAL') {
                        assert.equal(r.montoConvenio, 0, donde)
                        assert.equal(r.montoAsesor, cfgValues.valorDateoNuevo, donde)
                        assert.include(d.explicacion, 'Avance', donde)
                      } else if (caso === 'CONVENIO_SELF') {
                        assert.equal(r.montoAsesor, 0, donde)
                        assert.include(d.explicacion, 'Avance', donde)
                      } else {
                        assert.isFalse(esAvance, donde)
                        assert.notInclude(r.reglaAplicada, 'Avance', donde)
                      }
                      assert.equal(d.descuento.esAvance, caso !== 'SIN_CONVENIO', donde)
                    } else {
                      // La marca sola ya no hace avance.
                      assert.isFalse(esAvance, donde)
                      assert.notInclude(r.reglaAplicada, '+ Avance', donde)
                    }

                    // 4. Avisos: cada valor usado en 0 trae CONFIG_EN_CERO; avance heredado.
                    const enCero = usados.filter((v) => v.valor === 0).length
                    assert.equal(
                      d.alertas.filter((a) => a.codigo === 'CONFIG_EN_CERO').length,
                      enCero,
                      donde
                    )
                    const heredado = caso !== 'SIN_CONVENIO' && marca && !esAvance
                    assert.equal(
                      d.alertas.some((a) => a.codigo === 'AVANCE_HEREDADO'),
                      heredado,
                      donde
                    )
                    assert.isTrue(d.estimado, donde)
                    assert.equal(d.alertas[0].codigo, 'ESTIMADO', donde)
                  }
        }
    assert.isAbove(combinaciones, 500)
  }).timeout(60000)

  test('ticket "sin comisión": el desglose muestra $0 y lo que el motor calcularía', async ({
    assert,
  }) => {
    const cfgValues = await resolveConfigComision({
      asesorId: SIN_FILA,
      asesorConvenioId: SIN_FILA,
      tipoVehiculo: 'VEHICULO',
    })
    const recValues = await resolveConfigRecurrencia(SIN_FILA, 'VEHICULO')
    const r = calcularComision({
      caso: 'CONVENIO_COMERCIAL',
      escenario: 'NUEVO',
      tuvoContinuidad: true,
      esAvance: false,
      montoAvance: 0,
      codigoDescuento: null,
      origenDescuento: null,
      cfgValues,
      recValues,
    })
    const d = armarDesglose({
      caso: 'CONVENIO_COMERCIAL',
      escenario: 'NUEVO',
      tipoVehiculo: 'VEHICULO',
      continuidadEstado: 'CONTINUA',
      codigoDescuento: null,
      origenDescuento: null,
      esAvance: false,
      marcaAvanceDateo: false,
      cfgValues,
      recValues,
      resultado: r,
      despues: { montoAsesor: 0, montoConvenio: r.montoConvenio },
      guardada: { montoAsesor: 0, montoConvenio: r.montoConvenio, reglaAplicada: r.reglaAplicada },
      personas,
      sinComisionTicket: { asesor: true, convenio: false },
    })
    const alerta = d.alertas.find((a) => a.codigo === 'SIN_COMISION_TICKET')
    assert.exists(alerta)
    assert.include(alerta!.mensaje, 'el asesor comercial')
    assert.include(alerta!.mensaje, `$${r.montoAsesor.toLocaleString('es-CO')}`)
    assert.equal(d.beneficiarios[0].despues, 0)
    assert.isFalse(d.estimado)
  })
})
