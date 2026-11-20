import { test } from '@japa/runner'
import fs from 'node:fs'
import path from 'node:path'

// Multi-sede — código que corre SIN request (seeders y comandos ace; hoy no
// hay cron ni jobs): un modelo con el mixin SedeScoped sin contexto de sede
// falla (fail-closed) y con "todas" no escribe. Todo seeder o comando que
// use uno de esos modelos tiene que declarar su contexto con
// sinFiltroDeSede() o conSede().

const RAIZ = path.resolve(import.meta.dirname, '..', '..')

function modelosConSede(): string[] {
  const dir = path.join(RAIZ, 'app', 'models')
  const out: string[] = []
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.ts')) continue
    const src = fs.readFileSync(path.join(dir, f), 'utf8')
    const m = src.match(/export default class (\w+) extends compose\(BaseModel, SedeScoped\)/)
    if (m) out.push(m[1])
  }
  return out
}

function archivos(dir: string): string[] {
  const abs = path.join(RAIZ, dir)
  if (!fs.existsSync(abs)) return []
  return fs
    .readdirSync(abs)
    .filter((f) => f.endsWith('.ts'))
    .map((f) => path.join(abs, f))
}

test.group('Multi-sede · seeders y comandos sin request', () => {
  test('usan sinFiltroDeSede()/conSede() si tocan modelos con sede', ({ assert }) => {
    const modelos = modelosConSede()
    assert.isAbove(modelos.length, 10, 'debía encontrar los modelos con SedeScoped')
    const usoModelo = new RegExp(
      `\\b(${modelos.join('|')})\\.(query|find|findBy|findOrFail|findManyBy|create|createMany|firstOrCreate|updateOrCreate|updateOrCreateMany|all|first)\\(`
    )
    const sinContexto: string[] = []
    for (const f of [...archivos('database/seeders'), ...archivos('commands')]) {
      const src = fs.readFileSync(f, 'utf8')
      // Seeders deshabilitados: todo el cuerpo comentado.
      const sinComentarios = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
      if (!usoModelo.test(sinComentarios)) continue
      if (!/sinFiltroDeSede\(|conSede\(/.test(sinComentarios)) {
        sinContexto.push(path.relative(RAIZ, f))
      }
    }
    assert.deepEqual(sinContexto, [], 'seeders/comandos con modelos con sede y sin contexto')
  })
})
