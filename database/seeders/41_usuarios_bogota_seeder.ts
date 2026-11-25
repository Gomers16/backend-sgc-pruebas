// Usuarios de PRUEBA de Bogotá (CDA Activa): usuario, contrato, salario, pasos
// y agente. Salarios, fechas, afiliaciones y funciones son inventados.
//
//   node ace db:seed --files "database/seeders/41_usuarios_bogota_seeder.ts"
//
// - Idempotente: si la cédula o el correo ya existen, se omite (a un usuario de
//   esta lista sin contrato se le completa el contrato).
// - Usa los store() de usuarios y contratos, así corren las validaciones, el
//   historial y la creación del agente de captación.
// - Los datos personales y las contraseñas (nombre, cédula, correo, celular,
//   dirección, clave) NO están aquí: se leen de
//   tmp/usuarios_bogota_credenciales.json (ignorado por git) o de la ruta en
//   USUARIOS_BOGOTA_JSON. Ver database/helpers/usuarios_bogota.ts. El repo es
//   público: no traerlos al código. El modelo Usuario hashea la clave.
// - Con NODE_ENV=production se niega, salvo SEED_USUARIOS_BOGOTA=1.
// - Limpieza: node ace usuarios:bogota-limpiar
import { BaseSeeder } from '@adonisjs/lucid/seeders'
import app from '@adonisjs/core/services/app'
import { DateTime } from 'luxon'
import Usuario from '#models/usuario'
import Contrato from '#models/contrato'
import AgenteCaptacion from '#models/agente_captacion'
import Cargo from '#models/cargo'
import Rol from '#models/rol'
import Sede from '#models/sede'
import RazonSocial from '#models/razon_social'
import EntidadSalud from '#models/entidad_salud'
import UsuariosController from '#controllers/usuarios_controller'
import ContratosController from '#controllers/contratos_controller'
import { conSede } from '#services/sede_scope'
import { leerUsuariosBogota, type PersonaBogota } from '#database/helpers/usuarios_bogota'

const RAZON_SOCIAL_ID = 2
const SEDE_ID = 2

/** Mismos pasos base que crea la pantalla de contratos para tipo laboral. */
const PASOS = [
  'Proceso de Selección',
  'Verificación de Referencias',
  'Entrevista Final',
  'Examen Médico de Ingreso',
  'Firma de Contrato',
  'Inducción y Bienvenida',
]
/** Días antes del inicio en que se completó cada paso. */
const DIAS_ANTES = [14, 11, 8, 5, 1, 0]

const FUNCIONES: Record<string, string> = {
  'PALETERA': 'Orientación de vehículos y señalización en la entrada del CDA.',
  'CAJERO(A)': 'Recaudo, facturación y cuadre de caja.',
  'INGENIERO': 'Supervisión técnica de la línea de inspección y certificación.',
  'ASESOR TELEMERCADEO': 'Gestión telefónica de clientes y agendamiento de servicios.',
  'ASESOR SERVICIO AL CLIENTE': 'Atención, orientación y seguimiento a clientes de la sede.',
}

/** Puesto y contrato; el i-ésimo se une con la i-ésima persona del JSON. */
interface Fila extends PersonaBogota {
  cargo: string
  rol: string
  inicio: string
  fin?: string
  salario: number
  eps: string
  arl: string
  afp: string
  afc: string
  ccf: string
  centroCosto: string
}

const CAMPOS = [
  'cargo',
  'rol',
  'inicio',
  'fin',
  'salario',
  'eps',
  'arl',
  'afp',
  'afc',
  'ccf',
  'centroCosto',
]
const OPER = 'OPERATIVO_TURNOS'
const COM = 'COMERCIAL'
const TELE = 'ASESOR TELEMERCADEO'
const SAC = 'ASESOR SERVICIO AL CLIENTE'
const FNA = 'FONDO NACIONAL DEL AHORRO'

/* prettier-ignore */
const DATOS: (string | number | null)[][] = [
  ['PALETERA', OPER, '2025-01-13', null, 1800000, 'FAMISANAR', 'SURA ARL', 'PORVENIR', 'PORVENIR', 'COLSUBSIDIO', 'OPERACIÓN'],
  ['CAJERO(A)', OPER, '2025-03-03', null, 1900000, 'COMPENSAR', 'POSITIVA ARL', 'PROTECCION', 'PROTECCION', 'COMPENSAR', 'OPERACIÓN'],
  ['CAJERO(A)', OPER, '2025-05-12', null, 1900000, 'SANITAS', 'SURA ARL', 'COLPENSIONES', FNA, 'CAFAM', 'OPERACIÓN'],
  ['INGENIERO', OPER, '2025-02-17', null, 2900000, 'SURA', 'COLMENA ARL', 'PORVENIR', 'PORVENIR', 'COLSUBSIDIO', 'OPERACIÓN'],
  ['INGENIERO', OPER, '2025-07-01', null, 3000000, 'SALUD TOTAL', 'POSITIVA ARL', 'COLFONDOS', 'COLFONDOS', 'COMPENSAR', 'OPERACIÓN'],
  ['INGENIERO', 'SUPER_ADMIN', '2025-04-01', null, 3500000, 'SANITAS', 'SURA ARL', 'PROTECCION', 'PROTECCION', 'CAFAM', 'ADMINISTRACIÓN'],
  [TELE, COM, '2026-06-16', '2026-12-15', 1850000, 'NUEVA EPS', 'BOLIVAR ARL', 'PORVENIR', 'PORVENIR', 'COLSUBSIDIO', 'COMERCIAL'],
  [TELE, COM, '2026-07-13', '2027-01-12', 1850000, 'FAMISANAR', 'SURA ARL', 'COLPENSIONES', FNA, 'COMPENSAR', 'COMERCIAL'],
  [TELE, COM, '2026-08-18', '2027-02-17', 1850000, 'COMPENSAR', 'POSITIVA ARL', 'PROTECCION', 'PROTECCION', 'CAFAM', 'COMERCIAL'],
  [SAC, COM, '2025-09-08', null, 2000000, 'SALUD TOTAL', 'COLMENA ARL', 'COLFONDOS', 'COLFONDOS', 'COLSUBSIDIO', 'SERVICIO AL CLIENTE'],
  [SAC, COM, '2025-11-04', null, 2000000, 'SURA', 'SURA ARL', 'COLPENSIONES', FNA, 'CAFAM', 'SERVICIO AL CLIENTE'],
  [SAC, COM, '2026-02-02', null, 2000000, 'SANITAS', 'AXA COLPATRIA ARL', 'PORVENIR', 'PORVENIR', 'COMPENSAR', 'SERVICIO AL CLIENTE'],
]

const PUESTOS = DATOS.map((d) => Object.fromEntries(CAMPOS.map((c, i) => [c, d[i]])))

/** Llama a un store() de la app fuera de HTTP y devuelve lo que respondió. */
async function llamarStore(
  store: (ctx: any) => Promise<any>,
  actor: Usuario,
  body: Record<string, unknown>
): Promise<any> {
  const res = { status: 200, body: undefined as any }
  const responder = (status: number) => (b: any) => {
    res.status = status
    res.body = b
  }
  await store({
    auth: { user: actor },
    request: {
      // Sin filtrar a propósito: así numeroDocumento (que la pantalla no envía)
      // queda en el mismo INSERT y la limpieza por cédula siempre lo encuentra.
      only: () => ({ ...body }),
      all: () => ({ ...body }),
      input: (k: string, def?: unknown) => body[k] ?? def,
      header: () => undefined,
    },
    response: {
      created: responder(201),
      badRequest: responder(400),
      conflict: responder(409),
      unprocessableEntity: responder(422),
      internalServerError: responder(500),
      status: (s: number) => ({ send: responder(s) }),
    },
  })
  if (res.status !== 201) {
    throw new Error(`${res.status} ${res.body?.message ?? ''} ${res.body?.error ?? ''}`.trim())
  }
  return res.body
}

async function porNombre(modelo: any, nombre: string): Promise<number> {
  const fila = await modelo.query().where('nombre', nombre).first()
  if (!fila) throw new Error(`No existe "${nombre}" en ${modelo.table}`)
  return fila.id
}

async function entidad(tipo: string, nombre: string): Promise<number> {
  const e = await EntidadSalud.query().where('tipo', tipo).where('nombre', nombre).first()
  if (!e) throw new Error(`No existe la entidad ${tipo} "${nombre}"`)
  return e.id
}

export default class UsuariosBogotaSeeder extends BaseSeeder {
  public async run() {
    if (app.inProduction && process.env.SEED_USUARIOS_BOGOTA !== '1') {
      throw new Error(
        'Datos de prueba: con NODE_ENV=production exige SEED_USUARIOS_BOGOTA=1. No se creó nada.'
      )
    }

    const sede = await Sede.findOrFail(SEDE_ID)
    const razon = await RazonSocial.findOrFail(RAZON_SOCIAL_ID)
    if (sede.nombre !== 'Bogotá' || razon.nombre !== 'CDA Activa') {
      throw new Error(`Los ids no coinciden: sede "${sede.nombre}", razón social "${razon.nombre}"`)
    }

    const rolSA = await porNombre(Rol, 'SUPER_ADMIN')
    const datos = await leerUsuariosBogota()
    const filas = datos.usuarios.map((p, i) => ({ ...PUESTOS[i], ...p }) as Fila)
    const docs = filas.map((f) => f.doc)
    const actor = await Usuario.query()
      .where('rol_id', rolSA)
      .where('estado', 'activo')
      .where((q) => q.whereNull('numero_documento').orWhereNotIn('numero_documento', docs))
      .orderBy('id', 'asc')
      .firstOrFail()

    let errores = 0
    await conSede([SEDE_ID], async () => {
      for (const f of filas) {
        try {
          console.log(`[${f.doc}] ${f.correo}: ${await this.sembrar(f, actor, datos.direccion)}`)
        } catch (e: any) {
          errores++
          console.error(`[${f.doc}] ${f.correo}: ERROR ${e.message}`)
        }
      }
    })
    if (errores) throw new Error(`${errores} usuario(s) con error`)
  }

  private async sembrar(f: Fila, actor: Usuario, direccion: string): Promise<string> {
    const porCorreo = await Usuario.query().where('correo', f.correo).first()
    if (porCorreo && porCorreo.numeroDocumento !== f.doc) {
      return `OMITIDO, el correo es del usuario ajeno ${porCorreo.id}`
    }
    const porDoc = await Usuario.query().where('numero_documento', f.doc).first()
    if (porDoc && porDoc.correo !== f.correo) {
      return `OMITIDO, la cédula ya es del usuario ${porDoc.id} con otro correo`
    }

    const comun = {
      razonSocialId: RAZON_SOCIAL_ID,
      sedeId: SEDE_ID,
      cargoId: await porNombre(Cargo, f.cargo),
      centroCosto: f.centroCosto,
      epsId: await entidad('eps', f.eps),
      arlId: await entidad('arl', f.arl),
      afpId: await entidad('afp', f.afp),
      afcId: await entidad('afc', f.afc),
      ccfId: await entidad('ccf', f.ccf),
    }
    const funciones = FUNCIONES[f.cargo]

    let usuario = porDoc
    if (!usuario) {
      const ajeno = await Contrato.query().where('identificacion', f.doc).first()
      if (ajeno) return `OMITIDO, la cédula ya está en el contrato ${ajeno.id}`
      const controlador = new UsuariosController()
      usuario = (await llamarStore((c) => controlador.store(c), actor, {
        ...comun,
        numeroDocumento: f.doc,
        nombres: f.nombres,
        apellidos: f.apellidos,
        correo: f.correo,
        password: f.password,
        rolId: await porNombre(Rol, f.rol),
        direccion,
        celularPersonal: f.celular,
        estado: 'activo',
        recomendaciones: false,
      })) as Usuario
    }

    const contratoPrevio = await Contrato.query().where('usuario_id', usuario.id).first()
    if (!contratoPrevio) {
      const inicio = DateTime.fromISO(f.inicio)
      const controlador = new ContratosController()
      await llamarStore((c) => controlador.store(c), actor, {
        ...comun,
        usuarioId: usuario.id,
        identificacion: f.doc,
        funcionesCargo: funciones,
        fechaInicio: f.inicio,
        fechaTerminacion: f.fin ?? null,
        tipoContrato: 'laboral',
        terminoContrato: f.fin ? 'fijo' : 'indefinido',
        salarioBasico: f.salario,
        bonoSalarial: 0,
        auxilioTransporte: 0,
        auxilioNoSalarial: 0,
        tieneRecomendacionesMedicas: false,
        pasos: PASOS.map((nombrePaso, i) => ({
          fase: 'inicio',
          nombrePaso,
          orden: i + 1,
          completado: true,
          fecha: inicio.minus({ days: DIAS_ANTES[i] }).toISODate(),
          observacion: null,
        })),
      })
    }

    // La app no propaga los fallos al crear el agente: se comprueba aquí.
    const esperado =
      f.rol !== COM ? null : f.cargo === TELE ? 'ASESOR_TELEMERCADEO' : 'ASESOR_COMERCIAL'
    const agente = await AgenteCaptacion.query().where('usuario_id', usuario.id).first()
    if ((agente?.tipo ?? null) !== esperado) {
      throw new Error(`agente ${agente?.tipo ?? 'ninguno'}, se esperaba ${esperado ?? 'ninguno'}`)
    }

    if (!porDoc) return `creado (usuario ${usuario.id}, agente ${agente?.tipo ?? 'ninguno'})`
    return contratoPrevio ? 'ya existía, omitido' : 'ya existía, se completó el contrato'
  }
}
