import { readFile } from 'node:fs/promises'
import app from '@adonisjs/core/services/app'

/** Datos personales de los usuarios de prueba de Bogotá. Nunca en git: el repo es público. */
export interface PersonaBogota {
  doc: string
  nombres: string
  apellidos: string
  correo: string
  celular: string
  password: string
}

const TOTAL = 12
const CAMPOS = ['doc', 'nombres', 'apellidos', 'correo', 'celular', 'password'] as const

/** Lee el JSON { direccion, usuarios: PersonaBogota[12] } y lo valida. */
export async function leerUsuariosBogota(): Promise<{
  direccion: string
  usuarios: PersonaBogota[]
}> {
  const ruta =
    process.env.USUARIOS_BOGOTA_JSON || app.makePath('tmp/usuarios_bogota_credenciales.json')
  const datos = JSON.parse(await readFile(ruta, 'utf8'))
  const usuarios: PersonaBogota[] = (datos.usuarios ?? []).map((u: any) =>
    Object.fromEntries(CAMPOS.map((c) => [c, String(u[c] ?? '').trim()]))
  )
  const cedulas = new Set(usuarios.map((u) => u.doc))
  const completos = usuarios.every((u) => CAMPOS.every((c) => u[c]) && /^\d{6,10}$/.test(u.doc))
  if (usuarios.length !== TOTAL || cedulas.size !== TOTAL || !completos) {
    throw new Error(`${ruta}: se esperaban ${TOTAL} usuarios completos con cédulas distintas`)
  }
  return { direccion: String(datos.direccion ?? '').trim(), usuarios }
}
