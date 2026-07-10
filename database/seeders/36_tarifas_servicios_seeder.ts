// database/seeders/36_tarifas_servicios_seeder.ts
// Tarifas base por servicio + tipo de vehículo. RTM ya tiene valores reales
// (Resolución RTM 2026); SOAT/PREV/PERI quedan en 0 para configurarse desde
// la pantalla de Tarifas por Servicio.
import { BaseSeeder } from '@adonisjs/lucid/seeders'

import Servicio from '#models/servicio'
import TarifaServicio, { type TipoVehiculoTarifa } from '#models/tarifa_servicio'

const VIGENCIA_RTM = '2026-01-01'

const TARIFAS: {
  codigoServicio: string
  tipoVehiculo: TipoVehiculoTarifa
  valorBase: number
  valorTotal: number
  descripcion: string
  vigenciaDesde: string | null
}[] = [
  {
    codigoServicio: 'RTM',
    tipoVehiculo: 'MOTO',
    valorBase: 141339,
    valorTotal: 228430,
    descripcion: 'RTM Motocicleta 2026',
    vigenciaDesde: VIGENCIA_RTM,
  },
  {
    codigoServicio: 'RTM',
    tipoVehiculo: 'VEHICULO',
    valorBase: 233683,
    valorTotal: 338820,
    descripcion: 'RTM Vehículo 2026',
    vigenciaDesde: VIGENCIA_RTM,
  },
  {
    codigoServicio: 'SOAT',
    tipoVehiculo: 'MOTO',
    valorBase: 0,
    valorTotal: 0,
    descripcion: 'SOAT Motocicleta 2026',
    vigenciaDesde: null,
  },
  {
    codigoServicio: 'SOAT',
    tipoVehiculo: 'VEHICULO',
    valorBase: 0,
    valorTotal: 0,
    descripcion: 'SOAT Vehículo 2026',
    vigenciaDesde: null,
  },
  {
    codigoServicio: 'PREV',
    tipoVehiculo: 'MOTO',
    valorBase: 0,
    valorTotal: 0,
    descripcion: 'Preventiva Moto 2026',
    vigenciaDesde: null,
  },
  {
    codigoServicio: 'PREV',
    tipoVehiculo: 'VEHICULO',
    valorBase: 0,
    valorTotal: 0,
    descripcion: 'Preventiva Vehículo 2026',
    vigenciaDesde: null,
  },
  {
    codigoServicio: 'PERI',
    tipoVehiculo: 'MOTO',
    valorBase: 0,
    valorTotal: 0,
    descripcion: 'Peritaje Moto 2026',
    vigenciaDesde: null,
  },
  {
    codigoServicio: 'PERI',
    tipoVehiculo: 'VEHICULO',
    valorBase: 0,
    valorTotal: 0,
    descripcion: 'Peritaje Vehículo 2026',
    vigenciaDesde: null,
  },
]

export default class TarifasServiciosSeeder extends BaseSeeder {
  public async run() {
    let creadas = 0

    for (const t of TARIFAS) {
      const servicio = await Servicio.findBy('codigoServicio', t.codigoServicio)
      if (!servicio) {
        console.warn(`⚠️ No existe servicio con codigo_servicio = ${t.codigoServicio}. Se omite.`)
        continue
      }

      await TarifaServicio.updateOrCreate(
        { servicioId: servicio.id, tipoVehiculo: t.tipoVehiculo },
        {
          valorBase: t.valorBase,
          valorTotal: t.valorTotal,
          descripcion: t.descripcion,
          vigenciaDesde: t.vigenciaDesde as any,
        }
      )
      creadas++
    }

    console.log(`✅ tarifas_servicios insertadas/actualizadas: ${creadas}`)
  }
}
