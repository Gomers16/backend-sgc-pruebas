import { test } from '@japa/runner'
import fs from 'node:fs/promises'
import path from 'node:path'
import app from '@adonisjs/core/services/app'
import Database from '@adonisjs/lucid/services/db'
import Usuario from '#models/usuario'
import AgenteCaptacion from '#models/agente_captacion'
import { vincularGestionConDateo } from '#services/telemercadeo_gestion_service'

// Dateo desde una gestión de Telemercadeo (POST /api/captacion-dateos con
// telemercadeo_gestion_id) y regresión de store() sin gestión. Escribe en la
// BD compartida: placas TLG1**, teléfonos 39912*, agentes/usuarios
// "TEST TLG", evidencias en uploads/telemercadeo. Limpieza al inicio y al final.

const SEDE_ID = 3
const ROL = { SUPER_ADMIN: 9, COMERCIAL: 11 }
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
)

async function limpiarDatos() {
  const gestiones = await Database.from('telemercadeo_gestiones')
    .where('placa', 'like', 'TLG%')
    .select('evidencia_ruta')
  for (const g of gestiones) {
    await fs.unlink(app.makePath('uploads', ...String(g.evidencia_ruta).split('/'))).catch(() => {})
  }
  await Database.from('telemercadeo_gestiones').where('placa', 'like', 'TLG%').delete()
  await Database.from('telemercadeo_ciclos').where('placa', 'like', 'TLG%').delete()
  await Database.from('captacion_dateos').where('placa', 'like', 'TLG%').delete()
  await Database.from('prospectos').where('placa', 'like', 'TLG%').delete()
}

test.group('Telemercadeo · dateo desde gestión', (group) => {
  group.each.timeout(60_000)

  const usuarios: Usuario[] = []
  const agentes: AgenteCaptacion[] = []
  const tokens: Record<string, string> = {}
  const subidas: string[] = []
  let teleA: AgenteCaptacion
  let teleB: AgenteCaptacion
  let comercial: AgenteCaptacion
  let imagenPath = ''
  let origenId = 0
  let servicioRtm = 0
  let servicioSoat = 0
  let seq = 0

  const bearer = (k: string) => ({ Authorization: `Bearer ${tokens[k]}` })
  const key = () => `tld-${Date.now()}-${++seq}-${Math.random().toString(36).slice(2, 8)}`
  let telSeq = 0
  const tel = () => `39912${String(++telSeq).padStart(5, '0')}`

  async function usuario(k: string, rolId: number) {
    const u = await Usuario.create({
      nombres: 'TEST',
      apellidos: `TLG-D-${k}`,
      correo: `test.tlg.d.${k.toLowerCase()}.${Date.now()}@test.local`,
      password: 'Test1234!Aa',
      rolId,
      sedeId: SEDE_ID,
    } as any)
    usuarios.push(u)
    tokens[k] = (await Usuario.accessTokens.create(u)).value!.release()
    return u
  }

  async function agente(tipo: string, nombre: string, usuarioId: number | null) {
    const a = await AgenteCaptacion.create({
      sedeId: SEDE_ID,
      tipo,
      nombre,
      usuarioId,
    } as any)
    agentes.push(a)
    return a
  }

  /** Registra una gestión (por la API) y devuelve su fila de BD. */
  async function gestion(client: any, placa: string, k = 'TELE_A') {
    const up = await client
      .post('/api/media/upload')
      .headers(bearer(k))
      .field('carpeta', 'telemercadeo')
      .file('file', imagenPath)
    up.assertStatus(201)
    subidas.push(up.body().ruta)
    const r = await client.post('/api/telemercadeo/gestiones').headers(bearer(k)).json({
      placa,
      medio: 'LLAMADA',
      origen_id: origenId,
      resultado: 'INTERESADO',
      idempotency_key: key(),
      evidencia_ruta: up.body().ruta,
    })
    r.assertStatus(201)
    return Database.from('telemercadeo_gestiones').where('id', r.body().gestion.id).first()
  }

  const datear = (client: any, k: string, body: Record<string, unknown>) =>
    client
      .post('/api/captacion-dateos')
      .headers(bearer(k))
      .json({ origen: 'UI', telefono: tel(), ...body })

  const ciclo = (id: number) => Database.from('telemercadeo_ciclos').where('id', id).first()
  const dateosDe = (placa: string) =>
    Database.from('captacion_dateos').where('placa', placa).orderBy('id', 'asc')

  group.setup(async () => {
    await limpiarDatos()
    await usuario('ADMIN', ROL.SUPER_ADMIN)
    const uA = await usuario('TELE_A', ROL.COMERCIAL)
    const uB = await usuario('TELE_B', ROL.COMERCIAL)
    const uC = await usuario('COMERCIAL', ROL.COMERCIAL)
    const s = Date.now()
    teleA = await agente('ASESOR_TELEMERCADEO', `TEST TLG D TELE A ${s}`, uA.id)
    teleB = await agente('ASESOR_TELEMERCADEO', `TEST TLG D TELE B ${s}`, uB.id)
    comercial = await agente('ASESOR_COMERCIAL', `TEST TLG D COMERCIAL ${s}`, uC.id)

    origenId = (await Database.from('telemercadeo_origenes').where('codigo', 'GOOGLE_ADS').first())
      .id
    servicioRtm = (await Database.from('servicios').where('codigo_servicio', 'RTM').first()).id
    servicioSoat = (await Database.from('servicios').where('codigo_servicio', 'SOAT').first()).id

    imagenPath = app.tmpPath(`tst_tld_${Date.now()}.png`)
    await fs.mkdir(path.dirname(imagenPath), { recursive: true })
    await fs.writeFile(imagenPath, PNG_1X1)
  })

  group.teardown(async () => {
    await limpiarDatos()
    for (const r of subidas) {
      await fs.unlink(app.makePath('uploads', ...r.split('/'))).catch(() => {})
    }
    if (imagenPath) await fs.unlink(imagenPath).catch(() => {})
    const ids = agentes.map((a) => a.id)
    await Database.from('meta_telemercadeo_asesor').whereIn('asesor_id', ids).delete()
    await Database.from('configuracion_seguimiento_tele_asesores')
      .whereIn('asesor_id', ids)
      .delete()
    for (const a of agentes) await a.delete()
    for (const u of usuarios) await u.delete()
  })

  /* ═══════════ Con gestión ═══════════ */

  test('canal TELE, agente del token y servicio de la gestión aunque el body mande otros', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG101')
    const r = await datear(client, 'TELE_A', {
      placa: 'tlg-101',
      telemercadeo_gestion_id: g.id,
      agente_id: teleB.id,
      agenteId: comercial.id,
      canal: 'ASESOR',
      servicio_id: servicioSoat,
    })
    r.assertStatus(201)
    const d = await Database.from('captacion_dateos').where('id', r.body().id).first()
    assert.equal(d.canal, 'TELE')
    assert.equal(d.agente_id, teleA.id)
    assert.equal(d.servicio_id, servicioRtm)
    assert.equal(r.body().canal, 'TELE')
  })

  test('gestión → DATEADO con el dateo vinculado y ciclo cerrado DATEADO', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG102')
    const antes = await ciclo(g.ciclo_id)
    assert.isNotNull(antes.abierto_key)

    const r = await datear(client, 'TELE_A', { placa: 'TLG102', telemercadeo_gestion_id: g.id })
    r.assertStatus(201)

    const gDespues = await Database.from('telemercadeo_gestiones').where('id', g.id).first()
    assert.equal(gDespues.resultado, 'DATEADO')
    assert.equal(gDespues.captacion_dateo_id, r.body().id)
    const c = await ciclo(g.ciclo_id)
    assert.isNull(c.abierto_key)
    assert.equal(c.cerrado_motivo, 'DATEADO')
    assert.isNotNull(c.cerrado_at)
  })

  test('re-datear un dateo de Telemercadeo → 409 TELE_NO_REDATEABLE (asesor y admin)', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG119')
    const r = await datear(client, 'TELE_A', { placa: 'TLG119', telemercadeo_gestion_id: g.id })
    r.assertStatus(201)
    // TELE sin gestión (creado por admin a nombre del asesor).
    const sinGestion = await datear(client, 'ADMIN', {
      placa: 'TLG120',
      agente_id: teleA.id,
      canal: 'TELE',
    })
    sinGestion.assertStatus(201)
    const ids = [r.body().id, sinGestion.body().id]
    await Database.from('captacion_dateos').whereIn('id', ids).update({ resultado: 'RE_DATEAR' })
    for (const id of ids) {
      for (const k of ['TELE_A', 'ADMIN']) {
        const x = await client
          .post(`/api/captacion-dateos/${id}/redatear`)
          .headers(bearer(k))
          .json({ evidencia_url: '/api/uploads/dateos/x.png', observacion: 'prueba' })
        x.assertStatus(409)
        assert.equal(x.body().code, 'TELE_NO_REDATEABLE')
      }
    }
    const filas = await Database.from('captacion_dateos').whereIn('id', ids)
    for (const f of filas) assert.equal(f.resultado, 'RE_DATEAR')
  })

  test('segundo dateo con la misma gestión → 409 GESTION_YA_DATEADA, sin dateo nuevo', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG103')
    ;(
      await datear(client, 'TELE_A', { placa: 'TLG103', telemercadeo_gestion_id: g.id })
    ).assertStatus(201)
    const r = await datear(client, 'TELE_A', { placa: 'TLG103', telemercadeo_gestion_id: g.id })
    r.assertStatus(409)
    assert.equal(r.body().code, 'GESTION_YA_DATEADA')
    assert.lengthOf(await dateosDe('TLG103'), 1)
  })

  test('dos dateos en paralelo con la misma gestión → uno 201 y otro 409; un solo dateo', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG104')
    const telefono = tel()
    const rs = await Promise.all([
      datear(client, 'TELE_A', { placa: 'TLG104', telefono, telemercadeo_gestion_id: g.id }),
      datear(client, 'TELE_A', { placa: 'TLG104', telefono, telemercadeo_gestion_id: g.id }),
    ])
    const st = rs.map((r) => r.status()).sort()
    assert.deepEqual(st, [201, 409])
    const ok = rs.find((r) => r.status() === 201)!
    const dateos = await dateosDe('TLG104')
    assert.lengthOf(dateos, 1)
    assert.equal(dateos[0].id, ok.body().id)
    const gDespues = await Database.from('telemercadeo_gestiones').where('id', g.id).first()
    assert.equal(gDespues.captacion_dateo_id, ok.body().id)
  })

  test('carrera dentro de la transacción: si otra trx vincula primero → 409 y el dateo se revierte', async ({
    client,
    assert,
  }) => {
    // Determinista: el test bloquea la fila de la gestión; la petición pasa
    // la validación previa, crea su dateo dentro de su trx y queda esperando
    // el FOR UPDATE de vincularGestionConDateo. Mientras, el test vincula la
    // gestión a otro dateo y suelta el bloqueo.
    const g = await gestion(client, 'TLG113')
    const [otroId] = await Database.table('captacion_dateos').insert({
      sede_id: SEDE_ID,
      canal: 'TELE',
      agente_id: teleA.id,
      placa: 'TLG114',
      telefono: '3991299998',
      origen: 'UI',
      resultado: 'PENDIENTE',
      liberado: 1,
      servicio_id: servicioRtm,
      created_at: new Date(),
      updated_at: new Date(),
    })
    const trx = await Database.transaction()
    try {
      await trx.from('telemercadeo_gestiones').where('id', g.id).forUpdate().first()
      // El request de Japa es perezoso: .then() lo envía ya.
      const pendiente = datear(client, 'TELE_A', {
        placa: 'TLG113',
        telemercadeo_gestion_id: g.id,
      }).then((r: any) => r)
      // Espera a que la petición esté bloqueada en el FOR UPDATE.
      let bloqueada = false
      for (let i = 0; i < 50 && !bloqueada; i++) {
        await new Promise((res) => setTimeout(res, 100))
        const w = await Database.rawQuery(
          `SELECT COUNT(*) AS n FROM information_schema.innodb_trx WHERE trx_state = 'LOCK WAIT'`
        )
        bloqueada = Number(w[0][0].n) > 0
      }
      assert.isTrue(bloqueada, 'la petición nunca llegó al FOR UPDATE')
      await trx
        .from('telemercadeo_gestiones')
        .where('id', g.id)
        .update({ captacion_dateo_id: otroId, resultado: 'DATEADO' })
      await trx.commit()

      const r = await pendiente
      r.assertStatus(409)
      assert.equal(r.body().code, 'GESTION_YA_DATEADA')
    } finally {
      if (!trx.isCompleted) await trx.rollback()
    }
    assert.lengthOf(await dateosDe('TLG113'), 0)
    assert.equal(
      (await Database.from('telemercadeo_gestiones').where('id', g.id).first()).captacion_dateo_id,
      otroId
    )
    // El ciclo no lo cerró la petición revertida.
    assert.isNotNull((await ciclo(g.ciclo_id)).abierto_key)
  })

  test('vincularGestionConDateo: gestión DATEADO y ciclo cerrado en la MISMA trx (rollback deshace ambos)', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG115')
    const [dateoId] = await Database.table('captacion_dateos').insert({
      sede_id: SEDE_ID,
      canal: 'TELE',
      agente_id: teleA.id,
      placa: 'TLG115',
      telefono: '3991299997',
      origen: 'UI',
      resultado: 'PENDIENTE',
      liberado: 1,
      servicio_id: servicioRtm,
      created_at: new Date(),
      updated_at: new Date(),
    })
    const trx = await Database.transaction()
    try {
      assert.isTrue(await vincularGestionConDateo(g.id, dateoId, trx))
      // Dentro de la trx: ambos cambios hechos.
      const gIn = await trx.from('telemercadeo_gestiones').where('id', g.id).first()
      const cIn = await trx.from('telemercadeo_ciclos').where('id', g.ciclo_id).first()
      assert.equal(gIn.resultado, 'DATEADO')
      assert.equal(gIn.captacion_dateo_id, dateoId)
      assert.isNull(cIn.abierto_key)
      assert.equal(cIn.cerrado_motivo, 'DATEADO')
      // Fuera de la trx (otra conexión): ninguno visible todavía.
      const gOut = await Database.from('telemercadeo_gestiones').where('id', g.id).first()
      const cOut = await ciclo(g.ciclo_id)
      assert.isNull(gOut.captacion_dateo_id)
      assert.isNotNull(cOut.abierto_key)
    } finally {
      await trx.rollback()
    }
    const gFin = await Database.from('telemercadeo_gestiones').where('id', g.id).first()
    const cFin = await ciclo(g.ciclo_id)
    assert.isNull(gFin.captacion_dateo_id)
    assert.equal(gFin.resultado, 'INTERESADO')
    assert.isNotNull(cFin.abierto_key)
    assert.isNull(cFin.cerrado_motivo)
  })

  test('con gestión: convenio_id o descuento_id → 400 TELE_SIN_CONVENIO_DESCUENTO, sin dateo', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG118', 'TELE_A')
    const descuento = await Database.from('descuentos').where('activo', 1).first()
    const convenio = await Database.from('convenios').where('activo', 1).first()
    for (const extra of [{ descuento_id: descuento.id }, { convenio_id: convenio?.id ?? 1 }]) {
      const r = await datear(client, 'TELE_A', {
        placa: 'TLG118',
        telemercadeo_gestion_id: g.id,
        ...extra,
      })
      r.assertStatus(400)
      assert.equal(r.body().code, 'TELE_SIN_CONVENIO_DESCUENTO')
    }
    assert.lengthOf(await dateosDe('TLG118'), 0)
    const gFin = await Database.from('telemercadeo_gestiones').where('id', g.id).first()
    assert.isNull(gFin.captacion_dateo_id)
  })

  test('gestión ajena → 403 GESTION_AJENA; comercial con gestión → 403', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG105', 'TELE_A')
    const r = await datear(client, 'TELE_B', { placa: 'TLG105', telemercadeo_gestion_id: g.id })
    r.assertStatus(403)
    assert.equal(r.body().code, 'GESTION_AJENA')
    const rc = await datear(client, 'COMERCIAL', { placa: 'TLG105', telemercadeo_gestion_id: g.id })
    rc.assertStatus(403)
    assert.equal(rc.body().code, 'NO_ES_ASESOR_TELEMERCADEO')
    const rn = await datear(client, 'TELE_A', {
      placa: 'TLG105',
      telemercadeo_gestion_id: 99999999,
    })
    rn.assertStatus(404)
    assert.lengthOf(await dateosDe('TLG105'), 0)
  })

  test('placa distinta a la de la gestión → 400 GESTION_PLACA_DISTINTA', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG106')
    const r = await datear(client, 'TELE_A', { placa: 'TLG107', telemercadeo_gestion_id: g.id })
    r.assertStatus(400)
    assert.equal(r.body().code, 'GESTION_PLACA_DISTINTA')
    assert.lengthOf(await dateosDe('TLG107'), 0)
    assert.isNull(
      (await Database.from('telemercadeo_gestiones').where('id', g.id).first()).captacion_dateo_id
    )
  })

  test('si falla la creación se revierte todo (RE_DATEAR viejo, gestión y ciclo intactos)', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG108')
    const [viejoId] = await Database.table('captacion_dateos').insert({
      sede_id: SEDE_ID,
      canal: 'TELE',
      agente_id: teleA.id,
      placa: 'TLG108',
      telefono: '3991299999',
      origen: 'UI',
      resultado: 'RE_DATEAR',
      liberado: 1,
      servicio_id: servicioRtm,
      created_at: new Date(),
      updated_at: new Date(),
    })
    // imagen_mime es VARCHAR(100): 300 caracteres → ER_DATA_TOO_LONG en el INSERT.
    const r = await datear(client, 'TELE_A', {
      placa: 'TLG108',
      telemercadeo_gestion_id: g.id,
      imagen_mime: 'x'.repeat(300),
    })
    r.assertStatus(500)

    const dateos = await dateosDe('TLG108')
    assert.lengthOf(dateos, 1)
    assert.equal(dateos[0].id, viejoId)
    assert.equal(dateos[0].resultado, 'RE_DATEAR')
    assert.notInclude(String(dateos[0].observacion ?? ''), '[AUTO]')
    const gDespues = await Database.from('telemercadeo_gestiones').where('id', g.id).first()
    assert.isNull(gDespues.captacion_dateo_id)
    assert.equal(gDespues.resultado, 'INTERESADO')
    assert.isNotNull((await ciclo(g.ciclo_id)).abierto_key)

    // Y después se puede datear normalmente: el viejo pasa a REEMPLAZADO.
    const ok = await datear(client, 'TELE_A', { placa: 'TLG108', telemercadeo_gestion_id: g.id })
    ok.assertStatus(201)
    const viejo = await Database.from('captacion_dateos').where('id', viejoId).first()
    assert.equal(viejo.resultado, 'REEMPLAZADO')
  })

  test('tras el commit, el vínculo con prospecto (save() fuera de la trx) sigue funcionando', async ({
    client,
    assert,
  }) => {
    const [prospectoId] = await Database.table('prospectos').insert({
      sede_id: SEDE_ID,
      placa: 'TLG109',
    })
    const g = await gestion(client, 'TLG109')
    const r = await datear(client, 'TELE_A', { placa: 'TLG109', telemercadeo_gestion_id: g.id })
    r.assertStatus(201)
    const d = await Database.from('captacion_dateos').where('id', r.body().id).first()
    assert.equal(d.prospecto_id, prospectoId)
    const p = await Database.from('prospectos').where('id', prospectoId).first()
    assert.isTrue(Boolean(p.archivado))
  })

  test('ficha: dateos-comisiones del asesor de Telemercadeo incluye sus dateos TELE; el comercial no cambia', async ({
    client,
    assert,
  }) => {
    const g = await gestion(client, 'TLG116')
    const d = await datear(client, 'TELE_A', { placa: 'TLG116', telemercadeo_gestion_id: g.id })
    d.assertStatus(201)
    const fichaTele = await client
      .get(`/api/agentes-captacion/${teleA.id}/dateos-comisiones`)
      .headers(bearer('ADMIN'))
      .qs({ perPage: 500 })
    fichaTele.assertStatus(200)
    const idsTele = (fichaTele.body().data as any[]).map((x) => x.id)
    assert.include(idsTele, d.body().id)

    // Un dateo TELE a nombre de un comercial sigue fuera de SU ficha (como antes).
    const dc = await datear(client, 'ADMIN', {
      placa: 'TLG117',
      agente_id: comercial.id,
      canal: 'TELE',
    })
    dc.assertStatus(201)
    const fichaCom = await client
      .get(`/api/agentes-captacion/${comercial.id}/dateos-comisiones`)
      .headers(bearer('ADMIN'))
      .qs({ perPage: 500 })
    fichaCom.assertStatus(200)
    assert.notInclude(
      (fichaCom.body().data as any[]).map((x) => x.id),
      dc.body().id
    )
  })

  /* ═══════════ Regresión: store() sin gestión ═══════════ */

  test('sin gestión: comercial datea con su agente y canal ASESOR_COMERCIAL; no toca gestiones', async ({
    client,
    assert,
  }) => {
    const r = await datear(client, 'COMERCIAL', { placa: 'TLG110' })
    r.assertStatus(201)
    const d = await Database.from('captacion_dateos').where('id', r.body().id).first()
    assert.equal(d.agente_id, comercial.id)
    assert.equal(d.canal, 'ASESOR_COMERCIAL')
    assert.equal(r.body().canal, 'ASESOR')
    const n = await Database.from('telemercadeo_gestiones')
      .where('captacion_dateo_id', d.id)
      .count('* as n')
    assert.equal(Number(n[0].n), 0)
  })

  test('sin gestión: el agente_id y el canal del body se siguen respetando (admin)', async ({
    client,
    assert,
  }) => {
    const r = await datear(client, 'ADMIN', { placa: 'TLG111', agente_id: teleB.id, canal: 'TELE' })
    r.assertStatus(201)
    const d = await Database.from('captacion_dateos').where('id', r.body().id).first()
    assert.equal(d.agente_id, teleB.id)
    assert.equal(d.canal, 'TELE')
  })

  test('caracteriza deuda conocida: ASESOR_TELEMERCADEO sin gestión ni canal queda ASESOR_COMERCIAL', async ({
    client,
    assert,
  }) => {
    // Deuda documentada en HANDOFF.md: el arreglo global en
    // resolverIntentoDateo queda pendiente. Si se arregla, este test debe
    // cambiar a esperar TELE.
    const r = await datear(client, 'TELE_A', { placa: 'TLG112' })
    r.assertStatus(201)
    const d = await Database.from('captacion_dateos').where('id', r.body().id).first()
    assert.equal(d.agente_id, teleA.id)
    assert.equal(d.canal, 'ASESOR_COMERCIAL')
  })
})
