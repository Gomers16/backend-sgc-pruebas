import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Sede from '#models/sede'

export default class TramiteChecklist extends BaseModel {
  public static table = 'tramite_checklists'

  @column({ isPrimary: true })
  declare id: number

  // ── Identidad del turno
  @column({ columnName: 'sede_id' })
  declare sedeId: number

  @belongsTo(() => Sede, { foreignKey: 'sedeId' })
  declare sede: BelongsTo<typeof Sede>

  @column.date()
  declare fecha: DateTime

  @column({ columnName: 'turno_numero' })
  declare turnoNumero: number

  // ── Documentos
  @column({ columnName: 'tarjeta_propiedad' })
  declare tarjetaPropiedad: boolean | null

  @column()
  declare soat: boolean | null

  @column({ columnName: 'runt_vendedor' })
  declare runtVendedor: boolean | null

  @column({ columnName: 'runt_comprador' })
  declare runtComprador: boolean | null

  @column({ columnName: 'antecedentes_comprador' })
  declare antecedentesComprador: boolean | null

  @column({ columnName: 'antecedentes_vendedor' })
  declare antecedentesVendedor: boolean | null

  @column({ columnName: 'levanta_prenda_original' })
  declare levantaPrendaOriginal: boolean | null

  @column({ columnName: 'inscribe_prenda_original' })
  declare inscribePrendaOriginal: boolean | null

  @column({ columnName: 'camara_comercio' })
  declare camaraComercio: boolean | null

  @column({ columnName: 'certificado_impuestos' })
  declare certificadoImpuestos: boolean | null

  @column({ columnName: 'declaracion_extrajuicio' })
  declare declaracionExtrajuicio: boolean | null

  @column({ columnName: 'paz_salvo_empresa' })
  declare pazSalvoEmpresa: boolean | null

  @column({ columnName: 'cesion_derecho_empresa' })
  declare cesionDerechoEmpresa: boolean | null

  @column({ columnName: 'fotocopia_cedula' })
  declare fotocopiaCedula: boolean | null

  @column()
  declare observaciones: string | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
