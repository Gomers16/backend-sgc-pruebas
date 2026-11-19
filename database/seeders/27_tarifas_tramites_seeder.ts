// database/seeders/27_tarifas_tramites_seeder.ts
// Tarifas según Resolución 000005 del 02 ENE 2026 — Secretaría de Movilidad de Ibagué
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import TarifaTramite from '#models/tarifa_tramite'

const VIGENCIA = '2026-01-02'

const TARIFAS = [
  // ── Matrícula / Registro
  {
    tipoTramite: 'MATRICULA_REGISTRO',
    claseVehiculo: 'automovil',
    valor: 357000,
    descripcion: 'Matrícula inicial automóvil',
  },
  {
    tipoTramite: 'MATRICULA_REGISTRO',
    claseVehiculo: 'motocicleta',
    valor: 315200,
    descripcion: 'Matrícula inicial motocicleta',
  },
  // ── Traslado
  {
    tipoTramite: 'TRASLADO_MATRICULA_REGISTRO',
    claseVehiculo: 'automovil',
    valor: 247200,
    descripcion: 'Traslado matrícula automóvil',
  },
  {
    tipoTramite: 'TRASLADO_MATRICULA_REGISTRO',
    claseVehiculo: 'motocicleta',
    valor: 127600,
    descripcion: 'Traslado matrícula motocicleta',
  },
  // ── Radicado
  {
    tipoTramite: 'RADICADO_MATRICULA_REGISTRO',
    claseVehiculo: 'automovil',
    valor: 247200,
    descripcion: 'Radicado matrícula automóvil',
  },
  {
    tipoTramite: 'RADICADO_MATRICULA_REGISTRO',
    claseVehiculo: 'motocicleta',
    valor: 127600,
    descripcion: 'Radicado matrícula motocicleta',
  },
  // ── Trámites sin distinción de clase
  {
    tipoTramite: 'CAMBIO_COLOR',
    claseVehiculo: null,
    valor: 215200,
    descripcion: 'Cambio de color',
  },
  {
    tipoTramite: 'CAMBIO_SERVICIO',
    claseVehiculo: null,
    valor: 1999200,
    descripcion: 'Cambio de servicio',
  },
  {
    tipoTramite: 'REGRABAR_MOTOR',
    claseVehiculo: null,
    valor: 215200,
    descripcion: 'Regrabación de motor',
  },
  {
    tipoTramite: 'REGRABAR_CHASIS',
    claseVehiculo: null,
    valor: 215200,
    descripcion: 'Regrabación de chasis',
  },
  {
    tipoTramite: 'TRANSFORMACION',
    claseVehiculo: null,
    valor: 244400,
    descripcion: 'Transformación de vehículo',
  },
  {
    tipoTramite: 'DUPLICADO_LICENCIA_TRANSITO',
    claseVehiculo: null,
    valor: 127600,
    descripcion: 'Duplicado de licencia de tránsito',
  },
  {
    tipoTramite: 'INSCRIPCION_PRENDA',
    claseVehiculo: null,
    valor: 221500,
    descripcion: 'Inscripción de prenda',
  },
  {
    tipoTramite: 'LEVANTA_PRENDA',
    claseVehiculo: null,
    valor: 221500,
    descripcion: 'Levantamiento de prenda',
  },
  {
    tipoTramite: 'CANCELACION_MATRICULA_REGISTRO',
    claseVehiculo: null,
    valor: 60800,
    descripcion: 'Cancelación de matrícula',
  },
  // ── Cambio de placas
  {
    tipoTramite: 'CAMBIO_PLACAS',
    claseVehiculo: 'automovil',
    valor: 400000,
    descripcion: 'Cambio de placas automóvil',
  },
  {
    tipoTramite: 'CAMBIO_PLACAS',
    claseVehiculo: 'motocicleta',
    valor: 80200,
    descripcion: 'Cambio de placas motocicleta',
  },
  // ── Duplicado de placas
  {
    tipoTramite: 'DUPLICADO_PLACAS',
    claseVehiculo: 'automovil',
    valor: 122000,
    descripcion: 'Duplicado de placas automóvil',
  },
  {
    tipoTramite: 'DUPLICADO_PLACAS',
    claseVehiculo: 'motocicleta',
    valor: 80200,
    descripcion: 'Duplicado de placas motocicleta',
  },
  // ── Rematrícula
  {
    tipoTramite: 'REMATRICULA',
    claseVehiculo: 'automovil',
    valor: 305600,
    descripcion: 'Rematrícula automóvil',
  },
  {
    tipoTramite: 'REMATRICULA',
    claseVehiculo: 'motocicleta',
    valor: 263800,
    descripcion: 'Rematrícula motocicleta',
  },
  // ── Otros trámites con tarifa fija
  {
    tipoTramite: 'CAMBIO_CARROCERIA',
    claseVehiculo: null,
    valor: 246700,
    descripcion: 'Cambio de carrocería',
  },
  {
    tipoTramite: 'TRASPASO',
    claseVehiculo: null,
    valor: 305900,
    descripcion: 'Traspaso de vehículo',
  },
] as const

export default class TarifasTramitesSeeder extends BaseSeeder {
  public async run() {
    for (const t of TARIFAS) {
      // Tarifas de Ibagué (sede 1): desde multi-sede las tarifas de trámites
      // son por sede (migración 1811000000005).
      await TarifaTramite.updateOrCreate(
        { tipoTramite: t.tipoTramite, claseVehiculo: t.claseVehiculo ?? null, sedeId: 1 },
        { valor: t.valor, vigenciaDesde: VIGENCIA as any, descripcion: t.descripcion }
      )
    }
    console.log(`[TarifasTramitesSeeder] ${TARIFAS.length} tarifas insertadas/actualizadas.`)
  }
}
