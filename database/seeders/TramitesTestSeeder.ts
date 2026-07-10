// database/seeders/TramitesTestSeeder.ts
// Datos de prueba para el módulo de trámites.
// Crea: 3 turnos · 6 trámites · 4 formularios RUNT · 3 liquidaciones · 3 checklists
//
// Turno 1 (#N+1):   ABC123  TRASPASO completo          $279.520  → completado / pagado
// Turno 2 (#N+2a):  XYZ789  MATRICULA_REGISTRO parcial $115.000  → en_atencion / pendiente
//          (#N+2b):  XYZ789  DUPLICADO_PLACAS            sin liq  → en_espera   / pendiente
// Turno 3 (#N+3a):  DEF456  CAMBIO_COLOR completo      $155.000  → completado / pagado
//          (#N+3b):  DEF456  CAMBIO_SERVICIO             sin liq  → en_espera   / pendiente
//          (#N+3c):  DEF456  REGRABAR_MOTOR              sin liq  → en_espera   / pendiente
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import db from '@adonisjs/lucid/services/db'
import { DateTime } from 'luxon'

import Tramite from '#models/tramite'
import FormularioRunt from '#models/formulario_runt'
import TramiteChecklist from '#models/tramite_checklist'
import TramiteLiquidacion from '#models/tramite_liquidacion'
import Usuario from '#models/usuario'
import Servicio from '#models/servicio'

const SEDE_ID = 1
const HOY     = DateTime.local().setZone('America/Bogota').startOf('day')

const mkCodigo = (tag: string) => {
  const ts  = DateTime.local().setZone('America/Bogota').toFormat('yyyyMMddHHmmssSSS')
  const rnd = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `TRM-${ts}-${rnd}-${tag}`
}

export default class TramitesTestSeeder extends BaseSeeder {
  public async run() {
    const trx = await db.transaction()
    try {
      // ── Prerrequisitos ──────────────────────────────────────────────────────
      const usuario = await Usuario.query({ client: trx })
        .where('sede_id', SEDE_ID)
        .first()
      if (!usuario) {
        console.warn('[TramitesTestSeeder] No hay usuarios en sede_id=1. Abortando.')
        await trx.commit()
        return
      }

      const servicio = await Servicio.query({ client: trx })
        .whereILike('codigo_servicio', 'TRAMITES')
        .first()
      if (!servicio) {
        console.warn('[TramitesTestSeeder] Servicio TRAMITES no encontrado. Abortando.')
        await trx.commit()
        return
      }

      // ── Números de turno consecutivos al máximo del día ─────────────────────
      const rowMax = await trx
        .from('tramites')
        .where('sede_id', SEDE_ID)
        .where('fecha', HOY.toISODate()!)
        .max('turno_numero as max')
        .first()
      const base   = Number(rowMax?.max ?? 0)
      const turno1 = base + 1
      const turno2 = base + 2
      const turno3 = base + 3

      // Todos los trámites del mismo turno comparten el mismo turnoCodigo
      const codigo1 = mkCodigo('T1')
      const codigo2 = mkCodigo('T2')
      const codigo3 = mkCodigo('T3')

      // ══════════════════════════════════════════════════════════════════════
      //  TURNO 1 — TRASPASO completo
      //  Cliente:  CARLOS PÉREZ  CC: 10234567
      //  Vendedor: JUAN RAMÍREZ TORRES
      //  Vehículo: ABC123 · CHEVROLET SPARK GT 2020 ROJO
      //  Liquidación: $279.520  |  Estado: completado / pagado
      // ══════════════════════════════════════════════════════════════════════

      const t1 = await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Carlos Pérez',
        cedula:             '10234567',
        telefono:           '3101234567',
        email:              null,
        turnoNumero:        turno1,
        turnoCodigo:        codigo1,
        tipoTramite:        'TRASPASO',
        placa:              'ABC123',
        incluyeCompraventa: true,
        valorVehiculo:      45000000,
        formaPago:          'Efectivo',
        destrate:           3000000,
        estado:             'completado',
        estadoPago:         'pagado',
        fechaPago:          HOY,
        fecha:              HOY,
        horaIngreso:        '08:00',
        horaAtencion:       '08:05',
        horaFin:            '08:30',
        tiempoAtencion:     '25 min',
        observaciones:      'Traspaso por compraventa entre particulares.',
        resultado:          'Trámite completado. Pago registrado.',
      } as any, { client: trx })

      await FormularioRunt.create({
        tramiteId:           t1.id,
        placa:               'ABC123',
        marca:               'CHEVROLET',
        linea:               'SPARK GT',
        modelo:              '2020',
        color:               'ROJO',
        claseVehiculo:       'automovil',
        combustible:         'gasolina',
        noMotor:             'B12D1ABC1234',
        noChasis:            'KL1CD7FEXLB123456',
        noSerie:             'KL1CD7FEXLB123456',
        noVin:               'KL1CD7FEXLB123456',
        tipoServicio:        'particular',
        capacidadKg:         '350',
        blindaje:            false,
        potenciaHp:          '80',
        cilindrada:          '1200',
        puertas:             5,
        // Vendedor (propietario actual)
        propPrimerApellido:  'RAMÍREZ',
        propSegundoApellido: 'TORRES',
        propNombres:         'JUAN',
        propTipoDocumento:   'cc',
        propNoDocumento:     '79512345',
        propDireccion:       'Cra 5 # 22-10 Centro',
        propCiudad:          'Ibagué',
        propTelefono:        '3108765432',
        propCorreo:          null,
        // Comprador
        compPrimerApellido:  'PÉREZ',
        compSegundoApellido: 'GÓMEZ',
        compNombres:         'CARLOS',
        compTipoDocumento:   'cc',
        compNoDocumento:     '10234567',
        compDireccion:       'Cll 30 # 4-50 Ambala',
        compCiudad:          'Ibagué',
        compTelefono:        '3101234567',
        compCorreo:          null,
        mandatarioNombre:    null,
        mandatarioDocumento: null,
        alertaHurto:         false,
        alertaLimPropiedad:  false,
        alertaEmbargo:       false,
        alertaOtro:          null,
        observaciones:       'Vehículo libre de gravámenes. Compraventa firmada.',
      } as any, { client: trx })

      // Liquidación turno 1: retencion+derechosTraspaso+pazSalvo+papeleria+honorarios+imp = $279.520
      await TramiteLiquidacion.create({
        tramiteId:             t1.id,
        retencion:             20000,
        derechosTraspaso:      38520,
        pazSalvo:              58000,
        levantamientoPrenda:   0,
        inscripcionPrenda:     0,
        papeleria:             85000,
        honorarios:            30000,
        impuestoAnioActual:    40000,
        impuestoAniosVencidos: 8000,
      } as any, { client: trx })

      // Checklist turno 1: 12/14 (todos excepto levantaPrendaOriginal e inscribePrendaOriginal)
      await TramiteChecklist.create({
        sedeId:                 SEDE_ID,
        fecha:                  HOY,
        turnoNumero:            turno1,
        tarjetaPropiedad:       true,
        soat:                   true,
        fotocopiaCedula:        true,
        runtVendedor:           true,
        runtComprador:          true,
        antecedentesComprador:  true,
        antecedentesVendedor:   true,
        levantaPrendaOriginal:  false,
        inscribePrendaOriginal: false,
        camaraComercio:         true,
        certificadoImpuestos:   true,
        declaracionExtrajuicio: true,
        pazSalvoEmpresa:        true,
        cesionDerechoEmpresa:   true,
        observaciones:          'Pendiente: levantamiento de prenda e inscripción de prenda.',
      } as any, { client: trx })

      // ══════════════════════════════════════════════════════════════════════
      //  TURNO 2 — 2 trámites (Diana Ríos, mismo turnoCodigo)
      //  2a: MATRICULA_REGISTRO · XYZ789 · RENAULT 2023 AZUL (RUNT parcial)
      //  2b: DUPLICADO_PLACAS   · XYZ789 · sin formulario, sin liquidación
      // ══════════════════════════════════════════════════════════════════════

      const t2a = await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Diana Ríos',
        cedula:             '52345678',
        telefono:           '3209876543',
        email:              null,
        turnoNumero:        turno2,
        turnoCodigo:        codigo2,
        tipoTramite:        'MATRICULA_REGISTRO',
        placa:              'XYZ789',
        incluyeCompraventa: false,
        estado:             'en_atencion',
        estadoPago:         'pendiente',
        fecha:              HOY,
        horaIngreso:        '09:00',
        horaAtencion:       '09:10',
        horaFin:            null,
        tiempoAtencion:     null,
        observaciones:      'Matrícula de vehículo nuevo.',
        resultado:          null,
      } as any, { client: trx })

      // Formulario parcial: solo datos del vehículo
      await FormularioRunt.create({
        tramiteId:           t2a.id,
        placa:               'XYZ789',
        marca:               'RENAULT',
        linea:               'LOGAN LIFE',
        modelo:              '2023',
        color:               'AZUL',
        claseVehiculo:       'automovil',
        combustible:         'gasolina',
        noMotor:             null,
        noChasis:            null,
        noSerie:             null,
        noVin:               null,
        tipoServicio:        'particular',
        capacidadKg:         null,
        blindaje:            false,
        potenciaHp:          null,
        cilindrada:          null,
        puertas:             null,
        propPrimerApellido:  'RÍOS',
        propSegundoApellido: null,
        propNombres:         'DIANA',
        propTipoDocumento:   'cc',
        propNoDocumento:     '52345678',
        propDireccion:       null,
        propCiudad:          null,
        propTelefono:        '3209876543',
        propCorreo:          null,
        mandatarioNombre:    null,
        mandatarioDocumento: null,
        alertaHurto:         false,
        alertaLimPropiedad:  false,
        alertaEmbargo:       false,
        alertaOtro:          null,
        observaciones:       null,
      } as any, { client: trx })

      await TramiteLiquidacion.create({
        tramiteId:             t2a.id,
        retencion:             0,
        derechosTraspaso:      0,
        pazSalvo:              0,
        levantamientoPrenda:   0,
        inscripcionPrenda:     0,
        papeleria:             85000,
        honorarios:            30000,
        impuestoAnioActual:    0,
        impuestoAniosVencidos: 0,
      } as any, { client: trx })

      // Trámite 2b: sin formulario, sin liquidación
      await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Diana Ríos',
        cedula:             '52345678',
        telefono:           '3209876543',
        email:              null,
        turnoNumero:        turno2,
        turnoCodigo:        codigo2,
        tipoTramite:        'DUPLICADO_PLACAS',
        placa:              'XYZ789',
        incluyeCompraventa: false,
        estado:             'en_espera',
        estadoPago:         'pendiente',
        fecha:              HOY,
        horaIngreso:        '09:00',
        horaAtencion:       null,
        horaFin:            null,
        tiempoAtencion:     null,
        observaciones:      null,
        resultado:          null,
      } as any, { client: trx })

      // Checklist turno 2: tarjetaPropiedad, soat, fotocopiaCedula marcados
      await TramiteChecklist.create({
        sedeId:                 SEDE_ID,
        fecha:                  HOY,
        turnoNumero:            turno2,
        tarjetaPropiedad:       true,
        soat:                   true,
        fotocopiaCedula:        true,
        runtVendedor:           false,
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
        observaciones:          null,
      } as any, { client: trx })

      // ══════════════════════════════════════════════════════════════════════
      //  TURNO 3 — 3 trámites (Andrés Morales, mismo turnoCodigo)
      //  3a: CAMBIO_COLOR   · DEF456 · TOYOTA HILUX 2019 NEGRO (completo)
      //  3b: CAMBIO_SERVICIO · DEF456 · sin formulario, sin liquidación
      //  3c: REGRABAR_MOTOR  · DEF456 · sin formulario, sin liquidación
      // ══════════════════════════════════════════════════════════════════════

      const t3a = await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Andrés Morales',
        cedula:             '98765432',
        telefono:           '3154567890',
        email:              null,
        turnoNumero:        turno3,
        turnoCodigo:        codigo3,
        tipoTramite:        'CAMBIO_COLOR',
        placa:              'DEF456',
        incluyeCompraventa: false,
        estado:             'completado',
        estadoPago:         'pagado',
        fechaPago:          HOY,
        fecha:              HOY,
        horaIngreso:        '10:00',
        horaAtencion:       '10:05',
        horaFin:            '10:20',
        tiempoAtencion:     '15 min',
        observaciones:      'Cambio de color por reparación de carrocería.',
        resultado:          'Trámite completado. Pago registrado.',
      } as any, { client: trx })

      await FormularioRunt.create({
        tramiteId:           t3a.id,
        placa:               'DEF456',
        marca:               'TOYOTA',
        linea:               'HILUX 4X4',
        modelo:              '2019',
        color:               'NEGRO',
        claseVehiculo:       'camioneta',
        combustible:         'diesel',
        noMotor:             '1KDFTV456001D',
        noChasis:            'MR0FZ29GX00456001',
        noSerie:             'MR0FZ29GX00456001',
        noVin:               'MR0FZ29GX00456001',
        tipoServicio:        'particular',
        capacidadKg:         '1000',
        blindaje:            false,
        potenciaHp:          '163',
        cilindrada:          '2982',
        puertas:             4,
        propPrimerApellido:  'MORALES',
        propSegundoApellido: null,
        propNombres:         'ANDRÉS',
        propTipoDocumento:   'cc',
        propNoDocumento:     '98765432',
        propDireccion:       'Cll 45 # 7-23 El Salado',
        propCiudad:          'Ibagué',
        propTelefono:        '3154567890',
        propCorreo:          null,
        mandatarioNombre:    null,
        mandatarioDocumento: null,
        alertaHurto:         false,
        alertaLimPropiedad:  false,
        alertaEmbargo:       false,
        alertaOtro:          null,
        observaciones:       'Cambio de color por reparación total. Color anterior: BLANCO.',
      } as any, { client: trx })

      // Liquidación turno 3a: papeleria+honorarios+impuestoAnioActual = $155.000
      await TramiteLiquidacion.create({
        tramiteId:             t3a.id,
        retencion:             0,
        derechosTraspaso:      0,
        pazSalvo:              0,
        levantamientoPrenda:   0,
        inscripcionPrenda:     0,
        papeleria:             85000,
        honorarios:            30000,
        impuestoAnioActual:    40000,
        impuestoAniosVencidos: 0,
      } as any, { client: trx })

      // Trámite 3b: sin formulario, sin liquidación
      await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Andrés Morales',
        cedula:             '98765432',
        telefono:           '3154567890',
        email:              null,
        turnoNumero:        turno3,
        turnoCodigo:        codigo3,
        tipoTramite:        'CAMBIO_SERVICIO',
        placa:              'DEF456',
        incluyeCompraventa: false,
        estado:             'en_espera',
        estadoPago:         'pendiente',
        fecha:              HOY,
        horaIngreso:        '10:00',
        horaAtencion:       null,
        horaFin:            null,
        tiempoAtencion:     null,
        observaciones:      null,
        resultado:          null,
      } as any, { client: trx })

      // Trámite 3c: sin formulario, sin liquidación
      await Tramite.create({
        sedeId:             SEDE_ID,
        funcionarioId:      usuario.id,
        servicioId:         servicio.id,
        nombreCliente:      'Andrés Morales',
        cedula:             '98765432',
        telefono:           '3154567890',
        email:              null,
        turnoNumero:        turno3,
        turnoCodigo:        codigo3,
        tipoTramite:        'REGRABAR_MOTOR',
        placa:              'DEF456',
        incluyeCompraventa: false,
        estado:             'en_espera',
        estadoPago:         'pendiente',
        fecha:              HOY,
        horaIngreso:        '10:00',
        horaAtencion:       null,
        horaFin:            null,
        tiempoAtencion:     null,
        observaciones:      null,
        resultado:          null,
      } as any, { client: trx })

      // Checklist turno 3: completo (14/14)
      await TramiteChecklist.create({
        sedeId:                 SEDE_ID,
        fecha:                  HOY,
        turnoNumero:            turno3,
        tarjetaPropiedad:       true,
        soat:                   true,
        fotocopiaCedula:        true,
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

      console.log('[TramitesTestSeeder] OK — 6 trámites · 4 formularios RUNT · 3 liquidaciones · 3 checklists')
      console.log(`  Turno 1 (#${turno1}): ABC123  TRASPASO           $279.520  → completado / pagado`)
      console.log(`                         Checklist: 12/14 (falta levanta/inscribe prenda)`)
      console.log(`  Turno 2 (#${turno2}): XYZ789  MATRICULA_REGISTRO $115.000  → en_atencion / pendiente`)
      console.log(`           (#${turno2}): XYZ789  DUPLICADO_PLACAS   sin liq  → en_espera   / pendiente`)
      console.log(`                         Checklist: 3/14 (tarjetaPropiedad, soat, fotocopiaCedula)`)
      console.log(`  Turno 3 (#${turno3}): DEF456  CAMBIO_COLOR       $155.000  → completado  / pagado`)
      console.log(`           (#${turno3}): DEF456  CAMBIO_SERVICIO    sin liq  → en_espera   / pendiente`)
      console.log(`           (#${turno3}): DEF456  REGRABAR_MOTOR     sin liq  → en_espera   / pendiente`)
      console.log(`                         Checklist: 14/14 (completo)`)
    } catch (error) {
      await trx.rollback()
      throw error
    }
  }
}
