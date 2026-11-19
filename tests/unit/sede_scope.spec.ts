import { test } from '@japa/runner'
import {
  aplicarSede,
  conSede,
  resolverSedeActiva,
  scopeActual,
  sedeParaEscritura,
  sedeSql,
  sinFiltroDeSede,
} from '#services/sede_scope'

// Multi-sede Fase 2 — regla de la sede activa y helpers de SQL (sin BD).

const ACTIVAS = [1, 2] // la sede QA (3) está inactiva

test.group('sede_scope · resolverSedeActiva', () => {
  for (const rol of ['SUPER_ADMIN', 'GERENCIA']) {
    test(`${rol}: sin cabecera → su sede`, ({ assert }) => {
      const r = resolverSedeActiva({ rol, sedeUsuario: 1, cabecera: null, sedesActivas: ACTIVAS })
      assert.deepEqual(r, {
        ok: true,
        scope: {
          sedeIds: [1],
          todas: false,
          sedeEscritura: 1,
          sedeUsuario: 1,
          puedeCambiarSede: true,
        },
      })
    })

    test(`${rol}: X-Sede-Id de otra sede activa → esa sede`, ({ assert }) => {
      const r = resolverSedeActiva({ rol, sedeUsuario: 1, cabecera: '2', sedesActivas: ACTIVAS })
      assert.isTrue(r.ok)
      assert.deepEqual((r as any).scope.sedeIds, [2])
      assert.equal((r as any).scope.sedeEscritura, 2)
    })

    test(`${rol}: "todas" → todas las activas, sin sede de escritura`, ({ assert }) => {
      const r = resolverSedeActiva({ rol, sedeUsuario: 3, cabecera: 'TODAS', sedesActivas: [2, 1] })
      assert.deepEqual((r as any).scope.sedeIds, [1, 2])
      assert.isTrue((r as any).scope.todas)
      assert.isNull((r as any).scope.sedeEscritura)
    })

    test(`${rol}: cabecera inválida o sede inactiva → 400`, ({ assert }) => {
      for (const cab of ['3', '99', 'abc', '-1', '1.5']) {
        const r = resolverSedeActiva({ rol, sedeUsuario: 1, cabecera: cab, sedesActivas: ACTIVAS })
        assert.deepEqual(
          r,
          { ok: false, status: 400, message: `X-Sede-Id inválido: "${cab}"` },
          cab
        )
      }
    })

    test(`${rol}: sin sede y sin cabecera → 403; con cabecera válida → esa sede`, ({ assert }) => {
      const a = resolverSedeActiva({
        rol,
        sedeUsuario: null,
        cabecera: null,
        sedesActivas: ACTIVAS,
      })
      assert.equal((a as any).status, 403)
      const b = resolverSedeActiva({ rol, sedeUsuario: null, cabecera: '2', sedesActivas: ACTIVAS })
      assert.deepEqual((b as any).scope.sedeIds, [2])
    })
  }

  for (const rol of [
    'COMERCIAL',
    'OPERATIVO_TURNOS',
    'CONTABILIDAD',
    'TALENTO_HUMANO',
    'TRAMITADOR',
    'TURNERO',
    null,
  ]) {
    test(`${rol ?? '(sin rol)'}: la cabecera se ignora, siempre su sede`, ({ assert }) => {
      for (const cab of [null, '2', 'todas', 'basura']) {
        const r = resolverSedeActiva({ rol, sedeUsuario: 1, cabecera: cab, sedesActivas: ACTIVAS })
        assert.deepEqual(
          r,
          {
            ok: true,
            scope: {
              sedeIds: [1],
              todas: false,
              sedeEscritura: 1,
              sedeUsuario: 1,
              puedeCambiarSede: false,
            },
          },
          String(cab)
        )
      }
    })

    test(`${rol ?? '(sin rol)'}: sin sede → 403 aunque mande cabecera`, ({ assert }) => {
      const r = resolverSedeActiva({ rol, sedeUsuario: null, cabecera: '1', sedesActivas: ACTIVAS })
      assert.isFalse(r.ok)
      assert.equal((r as any).status, 403)
    })
  }

  test('la sede propia vale aunque esté inactiva (sede QA)', ({ assert }) => {
    const r = resolverSedeActiva({
      rol: 'COMERCIAL',
      sedeUsuario: 3,
      cabecera: null,
      sedesActivas: ACTIVAS,
    })
    assert.deepEqual((r as any).scope.sedeIds, [3])
  })
})

test.group('sede_scope · contexto y SQL', () => {
  test('fail-closed: sin sede activa, sedeSql y aplicarSede lanzan error', ({ assert }) => {
    assert.isNull(scopeActual())
    assert.throws(() => sedeSql('t'), /sin sede activa/)
    assert.throws(() => aplicarSede({ whereIn: () => {} }, 't.sede_id'), /sin sede activa/)
  })

  test('conSede: filtra por las sedes dadas', ({ assert }) => {
    conSede([2], () => {
      assert.equal(sedeSql('t'), 't.sede_id IN (2)')
      assert.equal(sedeSql('ft.sede_id'), 'ft.sede_id IN (2)')
      assert.equal(sedeParaEscritura(), 2)
      const llamadas: any[] = []
      aplicarSede({ whereIn: (c: string, v: number[]) => llamadas.push([c, v]) }, 'd.sede_id')
      assert.deepEqual(llamadas, [['d.sede_id', [2]]])
    })
    conSede([1, 2], () => {
      assert.equal(sedeSql('t'), 't.sede_id IN (1,2)')
      assert.throws(() => sedeParaEscritura(), /sede concreta/)
    })
  })

  test('sinFiltroDeSede: bypass explícito', ({ assert }) => {
    sinFiltroDeSede(() => {
      assert.equal(scopeActual(), 'sin_filtro')
      assert.equal(sedeSql('t'), '1=1')
      const llamadas: any[] = []
      aplicarSede({ whereIn: () => llamadas.push(1) }, 't.sede_id')
      assert.lengthOf(llamadas, 0)
      assert.isNull(sedeParaEscritura())
    })
  })

  test('el contexto no se filtra fuera de su callback (también async)', async ({ assert }) => {
    await conSede([1], async () => {
      await new Promise((r) => setTimeout(r, 5))
      assert.equal(sedeSql('t'), 't.sede_id IN (1)')
    })
    assert.isNull(scopeActual())
  })

  test('columnas inválidas se rechazan (sin inyección)', ({ assert }) => {
    conSede([1], () => {
      for (const c of ['t; DROP TABLE x', 't.sede_id OR 1=1', '', '1t', 'a.b.c']) {
        assert.throws(() => sedeSql(c), /inválida/, c)
      }
    })
    assert.throws(() => conSede([], () => 0), /inválida/)
    assert.throws(() => conSede([0], () => 0), /inválida/)
  })
})
