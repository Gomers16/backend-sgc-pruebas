// app/services/comision_tele_service.ts
//
// Decisión de negocio (2026-11-23): un dateo de Telemercadeo (canal TELE) NO
// genera comisión para el asesor. Ninguna ruta crea la fila en `comisiones`
// para él (hook de facturación, edición del dateo, alta manual de comisión,
// aprobación de ticket de Excepción de Dateo, cierre de turno). El dateo sigue
// quedando EXITOSO y cuenta en las metas de Telemercadeo y en la ficha.

/** Canal de captación cuyos dateos no generan comisión. */
export const CANAL_SIN_COMISION = 'TELE'

/** Código de error cuando alguien intenta crear a mano una comisión de un dateo TELE. */
export const CODIGO_TELE_SIN_COMISION = 'TELE_SIN_COMISION'

/** ¿El dateo es de Telemercadeo (canal TELE)? Esos dateos no generan comisión. */
export function dateoSinComision(dateo: { canal?: string | null } | null | undefined): boolean {
  return (dateo?.canal ?? '').toUpperCase() === CANAL_SIN_COMISION
}

/** Log único para auditar cada comisión que se omite por ser de Telemercadeo. */
export function logComisionTeleOmitida(origen: string, dateoId: number, extra: string = '') {
  console.log(
    `📵 [COMISION-TELE-OMITIDA] ${origen}: dateo ${dateoId} es de Telemercadeo (canal TELE); no se crea comisión${extra ? ` (${extra})` : ''}.`
  )
}
