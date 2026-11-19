import { test } from '@japa/runner'
import {
  normalizarId,
  validarGestionUsuario,
  validarSedeContrato,
} from '#services/usuario_permisos_service'

// Multi-sede Fase 0, decisión 9: SUPER_ADMIN todo; GERENCIA cualquier sede
// menos SUPER_ADMIN; TALENTO_HUMANO solo su sede, sin SUPER_ADMIN ni GERENCIA.

const IBAGUE = 1
const BOGOTA = 2

const SA = { rol: 'SUPER_ADMIN', sedeId: IBAGUE }
const GER = { rol: 'GERENCIA', sedeId: IBAGUE }
const TH = { rol: 'TALENTO_HUMANO', sedeId: IBAGUE }

test.group('usuario_permisos_service · validarGestionUsuario', () => {
  test('SUPER_ADMIN crea SUPER_ADMIN en otra sede', ({ assert }) => {
    const r = validarGestionUsuario(SA, null, { rol: 'SUPER_ADMIN', sedeId: BOGOTA })
    assert.deepEqual(r, { ok: true, sedeId: BOGOTA })
  })

  test('GERENCIA crea en cualquier sede, pero no SUPER_ADMIN', ({ assert }) => {
    assert.deepEqual(validarGestionUsuario(GER, null, { rol: 'COMERCIAL', sedeId: BOGOTA }), {
      ok: true,
      sedeId: BOGOTA,
    })
    assert.deepEqual(validarGestionUsuario(GER, null, { rol: 'GERENCIA', sedeId: BOGOTA }), {
      ok: true,
      sedeId: BOGOTA,
    })
    const r = validarGestionUsuario(GER, null, { rol: 'super_admin ', sedeId: IBAGUE })
    assert.isFalse(r.ok)
    assert.equal((r as any).status, 403)
  })

  test('GERENCIA no edita ni borra un SUPER_ADMIN', ({ assert }) => {
    const objetivo = { rol: 'SUPER_ADMIN', sedeId: IBAGUE }
    assert.isFalse(validarGestionUsuario(GER, objetivo, { sedeId: BOGOTA }).ok)
    assert.isFalse(validarGestionUsuario(GER, objetivo, {}).ok)
  })

  test('GERENCIA no se promueve a SUPER_ADMIN editándose', ({ assert }) => {
    const r = validarGestionUsuario(
      GER,
      { rol: 'GERENCIA', sedeId: IBAGUE },
      { rol: 'SUPER_ADMIN' }
    )
    assert.isFalse(r.ok)
  })

  test('TALENTO_HUMANO: alta sin sede queda en su sede', ({ assert }) => {
    assert.deepEqual(validarGestionUsuario(TH, null, { rol: 'COMERCIAL' }), {
      ok: true,
      sedeId: IBAGUE,
    })
    assert.deepEqual(validarGestionUsuario(TH, null, { rol: 'COMERCIAL', sedeId: null }), {
      ok: true,
      sedeId: IBAGUE,
    })
  })

  test('TALENTO_HUMANO: no asigna otra sede ni roles reservados', ({ assert }) => {
    assert.isFalse(validarGestionUsuario(TH, null, { rol: 'COMERCIAL', sedeId: BOGOTA }).ok)
    assert.isFalse(validarGestionUsuario(TH, null, { rol: 'SUPER_ADMIN', sedeId: IBAGUE }).ok)
    assert.isFalse(validarGestionUsuario(TH, null, { rol: 'GERENCIA', sedeId: IBAGUE }).ok)
  })

  test('TALENTO_HUMANO: no edita usuarios de otra sede ni SA/GER, ni los mueve de sede', ({
    assert,
  }) => {
    assert.isFalse(validarGestionUsuario(TH, { rol: 'COMERCIAL', sedeId: BOGOTA }, {}).ok)
    assert.isFalse(validarGestionUsuario(TH, { rol: 'GERENCIA', sedeId: IBAGUE }, {}).ok)
    assert.isFalse(validarGestionUsuario(TH, { rol: 'SUPER_ADMIN', sedeId: IBAGUE }, {}).ok)
    assert.isFalse(
      validarGestionUsuario(TH, { rol: 'COMERCIAL', sedeId: IBAGUE }, { sedeId: BOGOTA }).ok
    )
    assert.deepEqual(
      validarGestionUsuario(TH, { rol: 'COMERCIAL', sedeId: IBAGUE }, { rol: 'CONTABILIDAD' }),
      { ok: true, sedeId: IBAGUE }
    )
  })

  test('TALENTO_HUMANO: usuario legado sin sede se puede editar y se le asigna la suya', ({
    assert,
  }) => {
    assert.deepEqual(validarGestionUsuario(TH, { rol: 'COMERCIAL', sedeId: null }, {}), {
      ok: true,
      sedeId: null,
    })
    assert.deepEqual(
      validarGestionUsuario(TH, { rol: 'COMERCIAL', sedeId: null }, { sedeId: IBAGUE }),
      { ok: true, sedeId: IBAGUE }
    )
  })

  test('TALENTO_HUMANO sin sede no gestiona nada', ({ assert }) => {
    const r = validarGestionUsuario({ rol: 'TALENTO_HUMANO', sedeId: null }, null, {
      rol: 'COMERCIAL',
    })
    assert.isFalse(r.ok)
  })

  test('cualquier otro rol queda denegado', ({ assert }) => {
    for (const rol of ['COMERCIAL', 'OPERATIVO_TURNOS', 'CONTABILIDAD', 'TURNERO', null]) {
      assert.isFalse(validarGestionUsuario({ rol, sedeId: IBAGUE }, null, { rol: 'COMERCIAL' }).ok)
    }
  })
})

test.group('usuario_permisos_service · validarSedeContrato', () => {
  const usuarioIbague = { rol: 'COMERCIAL', sedeId: IBAGUE }

  test('SUPER_ADMIN y GERENCIA: cualquier sede', ({ assert }) => {
    const datos = { sedeContrato: BOGOTA, sedeContratoActual: IBAGUE, usuario: usuarioIbague }
    assert.isTrue(validarSedeContrato(SA, datos).ok)
    assert.isTrue(validarSedeContrato(GER, datos).ok)
  })

  test('GERENCIA no toca contratos de un SUPER_ADMIN', ({ assert }) => {
    const r = validarSedeContrato(GER, {
      sedeContrato: IBAGUE,
      sedeContratoActual: null,
      usuario: { rol: 'SUPER_ADMIN', sedeId: IBAGUE },
    })
    assert.isFalse(r.ok)
  })

  test('TALENTO_HUMANO: contrato de su sede para usuario de su sede', ({ assert }) => {
    assert.isTrue(
      validarSedeContrato(TH, {
        sedeContrato: IBAGUE,
        sedeContratoActual: null,
        usuario: usuarioIbague,
      }).ok
    )
  })

  test('TALENTO_HUMANO: no mueve a nadie a otra sede vía contrato', ({ assert }) => {
    assert.isFalse(
      validarSedeContrato(TH, {
        sedeContrato: BOGOTA,
        sedeContratoActual: null,
        usuario: usuarioIbague,
      }).ok
    )
    assert.isFalse(
      validarSedeContrato(TH, {
        sedeContrato: IBAGUE,
        sedeContratoActual: BOGOTA,
        usuario: usuarioIbague,
      }).ok
    )
    assert.isFalse(
      validarSedeContrato(TH, {
        sedeContrato: IBAGUE,
        sedeContratoActual: null,
        usuario: { rol: 'COMERCIAL', sedeId: BOGOTA },
      }).ok
    )
    assert.isFalse(
      validarSedeContrato(TH, {
        sedeContrato: IBAGUE,
        sedeContratoActual: null,
        usuario: { rol: 'GERENCIA', sedeId: IBAGUE },
      }).ok
    )
  })
})

test.group('usuario_permisos_service · normalizarId', () => {
  test('acepta números y strings, distingue ausente de vacío', ({ assert }) => {
    assert.isUndefined(normalizarId(undefined))
    assert.isNull(normalizarId(null))
    assert.isNull(normalizarId(''))
    assert.equal(normalizarId('2'), 2)
    assert.equal(normalizarId(3), 3)
    assert.isNaN(normalizarId('abc'))
    assert.isNaN(normalizarId(-1))
    assert.isNaN(normalizarId(1.5))
  })
})

test.group('usuario_permisos_service · Fase 2: nadie queda sin sede', () => {
  test('alta sin sede → sede del actor, para cualquier rol que pueda crear', ({ assert }) => {
    assert.deepEqual(validarGestionUsuario(SA, null, { rol: 'COMERCIAL' }), {
      ok: true,
      sedeId: IBAGUE,
    })
    assert.deepEqual(
      validarGestionUsuario({ rol: 'GERENCIA', sedeId: BOGOTA }, null, {
        rol: 'COMERCIAL',
        sedeId: null,
      }),
      {
        ok: true,
        sedeId: BOGOTA,
      }
    )
  })

  test('quitar la sede en una edición → 422', ({ assert }) => {
    const r = validarGestionUsuario(SA, { rol: 'COMERCIAL', sedeId: IBAGUE }, { sedeId: null })
    assert.deepEqual(r, { ok: false, status: 422, message: 'La sede del usuario es obligatoria.' })
  })
})
