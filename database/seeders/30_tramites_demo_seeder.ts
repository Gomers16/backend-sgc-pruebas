// database/seeders/30_tramites_demo_seeder.ts
// QA demo — módulo Trámites completo
// Crea: 3 turnos · 6 trámites · 6 formularios RUNT · 6 liquidaciones · 3 checklists
// NO crea liquidacion_pagos — los pagos se registran manualmente desde el navegador
// para que el endpoint registrarPago() genere los PDFs reales.
//
// Plan de pagos manuales (ver detalle en las observaciones de cada trámite):
//   Turno A: 1 pago  $750.000 "Efectivo"                  → pagado
//   Turno B: 3 pagos $300k "Transferencia" / "Efectivo" / "Datáfono" → pagado
//            0 pagos (T-B2)                                → pendiente
//   Turno C: 1 abono $40.000 "Efectivo"                    → parcial ($55k saldo)
//            2 pagos $200k "Transferencia" + $480k "Efectivo" → pagado
//            0 pagos, liquidación vacía (T-C3) → probar rechazo 422
import { sinFiltroDeSede } from '#services/sede_scope'
import { sedeDeSeeder } from '../helpers/sede_seeder.js'
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import Tramite from '#models/tramite'
import FormularioRunt from '#models/formulario_runt'
import TramiteChecklist from '#models/tramite_checklist'
import TramiteLiquidacion from '#models/tramite_liquidacion'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'

// Sede explícita: SEED_SEDE=<id> (obligatoria; la 2, Bogotá, prohibida).
// Se fija al inicio de run() con sedeDeSeeder(); ver database/helpers/sede_seeder.ts.
let SEDE_ID = 0
const HOY     = DateTime.local().setZone('America/Bogota').startOf('day')

const mkCodigo = (idx: number) => {
  const ts  = DateTime.local().setZone('America/Bogota').toFormat('yyyyMMddHHmmssSSS')
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `TRM-${ts}-${rnd}-${String(idx).padStart(2, '0')}`
}

export default class TramitesDemoSeeder extends BaseSeeder {
  // Multi-sede: sin request no hay sede activa; el seeder declara la suya en
  // cada registro, así que corre sin filtro de sede de forma explícita.
  public async run() {
    SEDE_ID = sedeDeSeeder('30_tramites_demo_seeder')
    await sinFiltroDeSede(async () => await this.sembrar())
  }

  private async sembrar() {
    const trx = await db.transaction()
    try {
      // ── Prerrequisitos ────────────────────────────────────────────────────
      const usuario = await Usuario.query({ client: trx })
        .where('sede_id', SEDE_ID)
        .first()
      if (!usuario) {
        console.warn('[TramitesDemoSeeder] No hay usuarios en sede_id=1. Abortando.')
        await trx.commit()
        return
      }

      const servicio = await Servicio.query({ client: trx })
        .whereILike('codigo_servicio', 'TRAMITES')
        .first()
      if (!servicio) {
        console.warn('[TramitesDemoSeeder] Servicio TRAMITES no encontrado. Abortando.')
        await trx.commit()
        return
      }

      // ── Números de turno consecutivos al máximo del día ───────────────────
      const rowMax = await trx
        .from('tramites')
        .where('sede_id', SEDE_ID)
        .where('fecha', HOY.toISODate()!)
        .max('turno_numero as max')
        .first()
      const base   = Number(rowMax?.max ?? 0)
      const turnoA = base + 1  // 1 trámite
      const turnoB = base + 2  // 2 trámites comparten este número
      const turnoC = base + 3  // 3 trámites comparten este número

      // ══════════════════════════════════════════════════════════════════════
      //  TURNO A (#turnoA)
      //  T-A1 · TRASPASO con compraventa · liquidación $750.000
      //  Pago manual: 1 x $750.000 "Efectivo" → estado "pagado"
      // ══════════════════════════════════════════════════════════════════════

      const tA1 = await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Sebastián Medina Rojas',
        cedula:             '1192345678',
        telefono:           '3201234567',
        email:              'smedina@gmail.com',
        turnoNumero:        turnoA,
        turnoCodigo:        mkCodigo(1),
        tipoTramite:        'TRASPASO',
        placa:              'NXP774',
        incluyeCompraventa: true,
        valorVehiculo:      28000000,
        formaPago:          'Efectivo',
        estado:             'completado',
        fecha:              HOY,
        horaIngreso:        '08:00',
        horaAtencion:       '08:05',
        horaFin:            '08:28',
        tiempoAtencion:     '23 min',
        observaciones:      'Traspaso por venta directa entre particulares. Compraventa firmada ante notario.',
        resultado:          'Trámite completado. Pago pendiente de registro.',
      } as any, { client: trx })

      await FormularioRunt.create({
        tramiteId:           tA1.id,
        placa:               'NXP774',
        marca:               'Kia',
        linea:               'Sportage LX',
        modelo:              '2021',
        color:               'Blanco Glaciar',
        claseVehiculo:       'automovil',
        combustible:         'gasolina',
        noMotor:             'G4FG774001A',
        noChasis:            'KNDJP3A51M7774001',
        noSerie:             'KNDJP3A51M7774001',
        noVin:               'KNDJP3A51M7774001',
        tipoServicio:        'particular',
        carroceriaCodigo:    'C02',
        carroceriaTipo:      'CAMPERO',
        capacidadKg:         '500',
        blindaje:            false,
        potenciaHp:          '150',
        cilindrada:          '2000',
        puertas:             5,
        // Propietario (vendedor)
        propPrimerApellido:  'Quintero',
        propSegundoApellido: 'Soto',
        propNombres:         'Fernanda Inés',
        propTipoDocumento:   'cc',
        propNoDocumento:     '52789034',
        propDireccion:       'Cra 7 # 34-56 La Pola',
        propCiudad:          'Ibagué',
        propTelefono:        '3104567890',
        propCorreo:          'fquintero@gmail.com',
        // Comprador
        compPrimerApellido:  'Medina',
        compSegundoApellido: 'Rojas',
        compNombres:         'Sebastián',
        compTipoDocumento:   'cc',
        compNoDocumento:     '1192345678',
        compDireccion:       'Cll 48 # 5A-12 Ambala',
        compCiudad:          'Ibagué',
        compTelefono:        '3201234567',
        compCorreo:          'smedina@gmail.com',
        // Mandatario null — para probar autocompletado desde el frontend
        mandatarioNombre:    null,
        mandatarioDocumento: null,
        alertaHurto:         false,
        alertaLimPropiedad:  false,
        alertaEmbargo:       false,
        alertaOtro:          null,
        observaciones:       'Vehículo libre de gravámenes. Compraventa firmada ante notario.',
      } as any, { client: trx })

      // Liquidación T-A1: $180k+$120k+$80k+$0+$0+$45k+$200k+$95k+$30k = $750.000
      await TramiteLiquidacion.create({
        tramiteId:             tA1.id,
        retencion:             180000,
        derechosTraspaso:      120000,
        pazSalvo:              80000,
        levantamientoPrenda:   0,
        inscripcionPrenda:     0,
        papeleria:             45000,
        honorarios:            200000,
        impuestoAnioActual:    95000,
        impuestoAniosVencidos: 30000,
      } as any, { client: trx })

      // ══════════════════════════════════════════════════════════════════════
      //  TURNO B (#turnoB)
      //  T-B1 · TRASPASO con compraventa · liquidación $900.000
      //  Pago manual: $300k "Transferencia" → $300k "Efectivo" → $300k "Datáfono" DTF-2026-0617-001
      //  T-B2 · DUPLICADO_PLACAS · liquidación $120.000
      //  Sin pagos — dejar en estado "pendiente" para verificar historial
      // ══════════════════════════════════════════════════════════════════════

      const tB1 = await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Diana Esperanza Ríos Castro',
        cedula:             '1020987654',
        telefono:           '3112340987',
        email:              'drios@yahoo.com',
        turnoNumero:        turnoB,
        turnoCodigo:        mkCodigo(2),
        tipoTramite:        'TRASPASO',
        placa:              'QRS810',
        incluyeCompraventa: true,
        valorVehiculo:      52000000,
        formaPago:          'Transferencia',
        estado:             'completado',
        fecha:              HOY,
        horaIngreso:        '09:00',
        horaAtencion:       '09:06',
        horaFin:            '09:31',
        tiempoAtencion:     '25 min',
        observaciones:      'Traspaso vehículo usado — pago pactado en 3 cuotas iguales de $300.000.',
        resultado:          'Trámite completado. Abonos pendientes de registro.',
      } as any, { client: trx })

      await FormularioRunt.create({
        tramiteId:           tB1.id,
        placa:               'QRS810',
        marca:               'Mazda',
        linea:               'CX-3 Prime',
        modelo:              '2020',
        color:               'Gris Sonic Metálico',
        claseVehiculo:       'automovil',
        combustible:         'gasolina',
        noMotor:             'P3VPS810002B',
        noChasis:            'JM1DKDM71L0810002',
        noSerie:             'JM1DKDM71L0810002',
        noVin:               'JM1DKDM71L0810002',
        tipoServicio:        'particular',
        carroceriaCodigo:    'C02',
        carroceriaTipo:      'CAMPERO',
        capacidadKg:         '470',
        blindaje:            false,
        potenciaHp:          '148',
        cilindrada:          '1998',
        puertas:             5,
        // Propietario (vendedor)
        propPrimerApellido:  'Muñoz',
        propSegundoApellido: 'Celis',
        propNombres:         'Héctor Fabio',
        propTipoDocumento:   'cc',
        propNoDocumento:     '79891234',
        propDireccion:       'Cll 60 # 8-44 Calambeo',
        propCiudad:          'Ibagué',
        propTelefono:        '3189012345',
        propCorreo:          null,
        // Comprador
        compPrimerApellido:  'Ríos',
        compSegundoApellido: 'Castro',
        compNombres:         'Diana Esperanza',
        compTipoDocumento:   'cc',
        compNoDocumento:     '1020987654',
        compDireccion:       'Kra 3 # 22-11 San Simón',
        compCiudad:          'Ibagué',
        compTelefono:        '3112340987',
        compCorreo:          'drios@yahoo.com',
        mandatarioNombre:    null,
        mandatarioDocumento: null,
        alertaHurto:         false,
        alertaLimPropiedad:  false,
        alertaEmbargo:       false,
        alertaOtro:          null,
        observaciones:       'Pago acordado en 3 cuotas iguales de $300.000 c/u.',
      } as any, { client: trx })

      // Liquidación T-B1: $200k+$150k+$100k+$80k+$0+$45k+$220k+$75k+$30k = $900.000
      await TramiteLiquidacion.create({
        tramiteId:             tB1.id,
        retencion:             200000,
        derechosTraspaso:      150000,
        pazSalvo:              100000,
        levantamientoPrenda:   80000,
        inscripcionPrenda:     0,
        papeleria:             45000,
        honorarios:            220000,
        impuestoAnioActual:    75000,
        impuestoAniosVencidos: 30000,
      } as any, { client: trx })

      const tB2 = await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Nelson Armando Cano Heredia',
        cedula:             '71567890',
        telefono:           '3190876543',
        email:              null,
        turnoNumero:        turnoB,
        turnoCodigo:        mkCodigo(3),
        tipoTramite:        'DUPLICADO_PLACAS',
        placa:              'CDF592',
        incluyeCompraventa: false,
        estado:             'completado',
        fecha:              HOY,
        horaIngreso:        '09:35',
        horaAtencion:       '09:38',
        horaFin:            '09:50',
        tiempoAtencion:     '12 min',
        observaciones:      'Placa trasera robada. Denuncio 2026-IB-00312.',
        resultado:          'Trámite completado. Pago pendiente de registro.',
      } as any, { client: trx })

      await FormularioRunt.create({
        tramiteId:           tB2.id,
        placa:               'CDF592',
        marca:               'Renault',
        linea:               'Sandero Stepway',
        modelo:              '2019',
        color:               'Rojo Flamme',
        claseVehiculo:       'automovil',
        combustible:         'gasolina',
        noMotor:             'D4F592771C',
        noChasis:            'VF15RF0BAKJ592771',
        noSerie:             'VF15RF0BAKJ592771',
        noVin:               'VF15RF0BAKJ592771',
        tipoServicio:        'particular',
        carroceriaCodigo:    'C01',
        carroceriaTipo:      'HATCHBACK',
        capacidadKg:         '430',
        blindaje:            false,
        potenciaHp:          '100',
        cilindrada:          '1598',
        puertas:             5,
        propPrimerApellido:  'Cano',
        propSegundoApellido: 'Heredia',
        propNombres:         'Nelson Armando',
        propTipoDocumento:   'cc',
        propNoDocumento:     '71567890',
        propDireccion:       'Cl 30 # 4-22 Boquerón',
        propCiudad:          'Ibagué',
        propTelefono:        '3190876543',
        propCorreo:          null,
        alertaHurto:         false,
        alertaLimPropiedad:  false,
        alertaEmbargo:       false,
        alertaOtro:          null,
        observaciones:       'Duplicado de placa trasera por hurto. Denuncia adjunta.',
      } as any, { client: trx })

      // Liquidación T-B2: $0+$0+$0+$0+$0+$30k+$70k+$20k+$0 = $120.000
      await TramiteLiquidacion.create({
        tramiteId:             tB2.id,
        retencion:             0,
        derechosTraspaso:      0,
        pazSalvo:              0,
        levantamientoPrenda:   0,
        inscripcionPrenda:     0,
        papeleria:             30000,
        honorarios:            70000,
        impuestoAnioActual:    20000,
        impuestoAniosVencidos: 0,
      } as any, { client: trx })

      // ══════════════════════════════════════════════════════════════════════
      //  TURNO C (#turnoC)
      //  T-C1 · CAMBIO_COLOR · liquidación $95.000
      //  Pago manual: 1 x $40.000 "Efectivo" → estado "parcial" (saldo $55.000)
      //  T-C2 · TRASPASO con compraventa · liquidación $680.000
      //  Pago manual: $200k "Transferencia" → $480k "Efectivo" → estado "pagado"
      //  T-C3 · REGRABAR_MOTOR · liquidación vacía (todos en 0)
      //  Sin pagos — intentar registrar pago debe devolver 422
      // ══════════════════════════════════════════════════════════════════════

      const tC1 = await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Andrea Milena Parra Valencia',
        cedula:             '1002345678',
        telefono:           '3176543210',
        email:              'aparra@hotmail.com',
        turnoNumero:        turnoC,
        turnoCodigo:        mkCodigo(4),
        tipoTramite:        'CAMBIO_COLOR',
        placa:              'LMK347',
        incluyeCompraventa: false,
        estado:             'completado',
        fecha:              HOY,
        horaIngreso:        '10:00',
        horaAtencion:       '10:03',
        horaFin:            '10:15',
        tiempoAtencion:     '12 min',
        observaciones:      'Cambio de color por reparación total de carrocería tras siniestro.',
        resultado:          'Trámite completado. Abono parcial pendiente.',
      } as any, { client: trx })

      await FormularioRunt.create({
        tramiteId:           tC1.id,
        placa:               'LMK347',
        marca:               'Honda',
        linea:               'Civic EXL',
        modelo:              '2018',
        color:               'Negro Cristal (antes: Azul Marino)',
        claseVehiculo:       'automovil',
        combustible:         'gasolina',
        noMotor:             'L15B7347123D',
        noChasis:            '19XFC2F58JE347123',
        noSerie:             '19XFC2F58JE347123',
        noVin:               '19XFC2F58JE347123',
        tipoServicio:        'particular',
        carroceriaCodigo:    'C01',
        carroceriaTipo:      'SEDAN',
        capacidadKg:         '460',
        blindaje:            false,
        potenciaHp:          '174',
        cilindrada:          '1498',
        puertas:             4,
        propPrimerApellido:  'Parra',
        propSegundoApellido: 'Valencia',
        propNombres:         'Andrea Milena',
        propTipoDocumento:   'cc',
        propNoDocumento:     '1002345678',
        propDireccion:       'Cll 51 # 6B-34 Piedrapintada',
        propCiudad:          'Ibagué',
        propTelefono:        '3176543210',
        propCorreo:          'aparra@hotmail.com',
        alertaHurto:         false,
        alertaLimPropiedad:  false,
        alertaEmbargo:       false,
        alertaOtro:          null,
        observaciones:       'Color anterior: Azul Marino. Nuevo color: Negro Cristal. Reparación total de carrocería.',
      } as any, { client: trx })

      // Liquidación T-C1: $0+$0+$0+$0+$0+$25k+$60k+$10k+$0 = $95.000
      await TramiteLiquidacion.create({
        tramiteId:             tC1.id,
        retencion:             0,
        derechosTraspaso:      0,
        pazSalvo:              0,
        levantamientoPrenda:   0,
        inscripcionPrenda:     0,
        papeleria:             25000,
        honorarios:            60000,
        impuestoAnioActual:    10000,
        impuestoAniosVencidos: 0,
      } as any, { client: trx })

      const tC2 = await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Mauricio Alberto Lozano Arias',
        cedula:             '79234501',
        telefono:           '3143456789',
        email:              'mlozano@gmail.com',
        turnoNumero:        turnoC,
        turnoCodigo:        mkCodigo(5),
        tipoTramite:        'TRASPASO',
        placa:              'EFG128',
        incluyeCompraventa: true,
        valorVehiculo:      65000000,
        formaPago:          'Transferencia',
        estado:             'completado',
        fecha:              HOY,
        horaIngreso:        '10:20',
        horaAtencion:       '10:25',
        horaFin:            '10:52',
        tiempoAtencion:     '27 min',
        observaciones:      'Traspaso entre particulares — pago acordado en 2 cuotas.',
        resultado:          'Trámite completado. Abonos pendientes de registro.',
      } as any, { client: trx })

      await FormularioRunt.create({
        tramiteId:           tC2.id,
        placa:               'EFG128',
        marca:               'Toyota',
        linea:               'Corolla XEI',
        modelo:              '2020',
        color:               'Gris Acero',
        claseVehiculo:       'automovil',
        combustible:         'gasolina',
        noMotor:             '2ZR128456E',
        noChasis:            'JTDBAMFE6LJ128456',
        noSerie:             'JTDBAMFE6LJ128456',
        noVin:               'JTDBAMFE6LJ128456',
        tipoServicio:        'particular',
        carroceriaCodigo:    'C01',
        carroceriaTipo:      'SEDAN',
        capacidadKg:         '490',
        blindaje:            false,
        potenciaHp:          '139',
        cilindrada:          '1798',
        puertas:             4,
        // Propietario (vendedora)
        propPrimerApellido:  'Cardona',
        propSegundoApellido: 'Muñoz',
        propNombres:         'Patricia Inés',
        propTipoDocumento:   'cc',
        propNoDocumento:     '41890123',
        propDireccion:       'Cra 11 # 44-78 El Jardín',
        propCiudad:          'Ibagué',
        propTelefono:        '3120987654',
        propCorreo:          null,
        // Comprador
        compPrimerApellido:  'Lozano',
        compSegundoApellido: 'Arias',
        compNombres:         'Mauricio Alberto',
        compTipoDocumento:   'cc',
        compNoDocumento:     '79234501',
        compDireccion:       'Cl 35 # 3A-67 Chapetón',
        compCiudad:          'Ibagué',
        compTelefono:        '3143456789',
        compCorreo:          'mlozano@gmail.com',
        mandatarioNombre:    null,
        mandatarioDocumento: null,
        alertaHurto:         false,
        alertaLimPropiedad:  false,
        alertaEmbargo:       false,
        alertaOtro:          null,
        observaciones:       'Vehículo libre de gravámenes. Compraventa firmada ante notario Quinta.',
      } as any, { client: trx })

      // Liquidación T-C2: $150k+$120k+$80k+$0+$0+$40k+$180k+$75k+$35k = $680.000
      await TramiteLiquidacion.create({
        tramiteId:             tC2.id,
        retencion:             150000,
        derechosTraspaso:      120000,
        pazSalvo:              80000,
        levantamientoPrenda:   0,
        inscripcionPrenda:     0,
        papeleria:             40000,
        honorarios:            180000,
        impuestoAnioActual:    75000,
        impuestoAniosVencidos: 35000,
      } as any, { client: trx })

      const tC3 = await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Claudia Patricia Vélez Montoya',
        cedula:             '41234567',
        telefono:           '3105678901',
        email:              null,
        turnoNumero:        turnoC,
        turnoCodigo:        mkCodigo(6),
        tipoTramite:        'REGRABAR_MOTOR',
        placa:              'HJN063',
        incluyeCompraventa: false,
        estado:             'en_atencion',
        fecha:              HOY,
        horaIngreso:        '10:55',
        horaAtencion:       '11:00',
        horaFin:            null,
        tiempoAtencion:     null,
        observaciones:      'Motor reemplazado por daño total en accidente. Regrabación en proceso.',
        resultado:          null,
      } as any, { client: trx })

      await FormularioRunt.create({
        tramiteId:           tC3.id,
        placa:               'HJN063',
        marca:               'Ford',
        linea:               'Ranger Limited 4x4',
        modelo:              '2017',
        color:               'Plata Estelar',
        claseVehiculo:       'camioneta',
        combustible:         'diesel',
        noMotor:             'TDCI063891F',
        noChasis:            '1FTNF21L5HE063891',
        noSerie:             '1FTNF21L5HE063891',
        noVin:               '1FTNF21L5HE063891',
        tipoServicio:        'particular',
        carroceriaCodigo:    'P04',
        carroceriaTipo:      'PICKUP',
        capacidadKg:         '1200',
        blindaje:            false,
        potenciaHp:          '163',
        cilindrada:          '3200',
        propPrimerApellido:  'Vélez',
        propSegundoApellido: 'Montoya',
        propNombres:         'Claudia Patricia',
        propTipoDocumento:   'cc',
        propNoDocumento:     '41234567',
        propDireccion:       'Kra 6 # 55-23 Malabar',
        propCiudad:          'Ibagué',
        propTelefono:        '3105678901',
        propCorreo:          null,
        motorRegrabado:      true,
        alertaHurto:         false,
        alertaLimPropiedad:  false,
        alertaEmbargo:       false,
        alertaOtro:          'Motor reemplazado — acto perito No. 2026-IB-00089',
        observaciones:       'Regrabación de motor por daño total en accidente. Perito autorizado.',
      } as any, { client: trx })

      // Liquidación T-C3: todos en 0 — caso borde "liquidación vacía"
      // El endpoint registrarPago debe rechazar con 422
      await TramiteLiquidacion.create({
        tramiteId:             tC3.id,
        retencion:             0,
        derechosTraspaso:      0,
        pazSalvo:              0,
        levantamientoPrenda:   0,
        inscripcionPrenda:     0,
        papeleria:             0,
        honorarios:            0,
        impuestoAnioActual:    0,
        impuestoAniosVencidos: 0,
      } as any, { client: trx })

      // ══════════════════════════════════════════════════════════════════════
      //  CHECKLISTS — uno por turno
      // ══════════════════════════════════════════════════════════════════════

      // Turno A — 8/13: tarjetaPropiedad, soat, runtVendedor, runtComprador,
      //                  antecedentesComprador, antecedentesVendedor,
      //                  certificadoImpuestos, declaracionExtrajuicio
      await TramiteChecklist.create({
        sedeId:                 SEDE_ID,
        fecha:                  HOY,
        turnoNumero:            turnoA,
        tarjetaPropiedad:       true,
        soat:                   true,
        runtVendedor:           true,
        runtComprador:          true,
        antecedentesComprador:  true,
        antecedentesVendedor:   true,
        levantaPrendaOriginal:  false,
        inscribePrendaOriginal: false,
        camaraComercio:         false,
        certificadoImpuestos:   true,
        declaracionExtrajuicio: true,
        pazSalvoEmpresa:        false,
        cesionDerechoEmpresa:   false,
        observaciones:          'Pendientes: levantamiento prenda, inscripción prenda, cámara comercio, paz y salvo empresa, cesión derecho.',
      } as any, { client: trx })

      // Turno B — 3/13: tarjetaPropiedad, soat, runtVendedor
      await TramiteChecklist.create({
        sedeId:                 SEDE_ID,
        fecha:                  HOY,
        turnoNumero:            turnoB,
        tarjetaPropiedad:       true,
        soat:                   true,
        runtVendedor:           true,
        runtComprador:          false,
        antecedentesComprador:  false,
        antecedentesVendedor:   false,
        levantaPrendaOriginal:  false,
        inscribePrendaOriginal: false,
        camaraComercio:         false,
        certificadoImpuestos:   false,
        declaracionExtrajuicio: false,
        pazSalvoEmpresa:        false,
        cesionDerechoEmpresa:   false,
        observaciones:          'Documentación incompleta — pendiente la mayor parte del expediente.',
      } as any, { client: trx })

      // Turno C — 13/13: expediente completo
      await TramiteChecklist.create({
        sedeId:                 SEDE_ID,
        fecha:                  HOY,
        turnoNumero:            turnoC,
        tarjetaPropiedad:       true,
        soat:                   true,
        runtVendedor:           true,
        runtComprador:          true,
        antecedentesComprador:  true,
        antecedentesVendedor:   true,
        levantaPrendaOriginal:  true,
        inscribePrendaOriginal: true,
        camaraComercio:         true,
        certificadoImpuestos:   true,
        declaracionExtrajuicio: true,
        pazSalvoEmpresa:        true,
        cesionDerechoEmpresa:   true,
        observaciones:          'Expediente completo. Todos los documentos verificados.',
      } as any, { client: trx })

      await trx.commit()

      console.log('[TramitesDemoSeeder] OK — 6 trámites · 6 formularios RUNT · 6 liquidaciones · 3 checklists')
      console.log(`  Turno A (#${turnoA}): NXP774 TRASPASO          $750.000 → registrar 1 pago $750k "Efectivo"`)
      console.log(`  Turno B (#${turnoB}): QRS810 TRASPASO          $900.000 → registrar 3 abonos $300k c/u`)
      console.log(`           (#${turnoB}): CDF592 DUPLICADO_PLACAS  $120.000 → sin pagos (pendiente)`)
      console.log(`  Turno C (#${turnoC}): LMK347 CAMBIO_COLOR       $95.000  → registrar 1 abono $40k "Efectivo"`)
      console.log(`           (#${turnoC}): EFG128 TRASPASO          $680.000 → registrar $200k luego $480k`)
      console.log(`           (#${turnoC}): HJN063 REGRABAR_MOTOR    vacía    → intentar pago debe rechazar 422`)
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
