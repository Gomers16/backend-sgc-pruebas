import { compose } from '@adonisjs/core/helpers'
import { SedeScoped } from '#models/mixins/sede_scoped'
import { DateTime } from 'luxon'
import { BaseModel, column, belongsTo } from '@adonisjs/lucid/orm'
import type { BelongsTo } from '@adonisjs/lucid/types/relations'
import Tramite from '#models/tramite'

export type ClaseVehiculo =
  | 'automovil'
  | 'bus'
  | 'buseta'
  | 'camion'
  | 'camioneta'
  | 'campero'
  | 'microbus'
  | 'tractocamion'
  | 'motocicleta'
  | 'motocarro'
  | 'mototriciciclo'
  | 'cuatrimoto'
  | 'volqueta'
  | 'otro'

export type Combustible =
  | 'gasolina'
  | 'diesel'
  | 'gas'
  | 'electrico'
  | 'hibrido'
  | 'etanol'
  | 'biodiesel'

export type TipoServicioVehiculo =
  | 'particular'
  | 'publico'
  | 'diplomatico'
  | 'oficial'
  | 'especial'
  | 'otros'

export type TipoDocumento =
  | 'cc'
  | 'nit'
  | 'nn'
  | 'pasaporte'
  | 'c_extranjeria'
  | 't_identidad'
  | 'nuip'
  | 'c_diplomatico'

export type ImportacionTipo =
  | 'manif_o_acta'
  | 'dec_importacion'
  | 'acta'
  | 'entidad'
  | 'lugar'
  | 'codigo'

export default class FormularioRunt extends compose(BaseModel, SedeScoped) {
  // Multi-sede: 3f, hereda la sede del trámite.
  static sedeVia = { atributo: 'tramiteId', columna: 'tramite_id', tablaPadre: 'tramites' }

  public static table = 'formularios_runt'

  @column({ isPrimary: true })
  declare id: number

  // ── Relación con trámite
  @column({ columnName: 'tramite_id' })
  declare tramiteId: number

  @belongsTo(() => Tramite, { foreignKey: 'tramiteId' })
  declare tramite: BelongsTo<typeof Tramite>

  // ── Datos del vehículo
  @column()
  declare placa: string | null

  @column()
  declare marca: string | null

  @column()
  declare linea: string | null

  @column()
  declare modelo: string | null

  @column()
  declare color: string | null

  @column({ columnName: 'clase_vehiculo' })
  declare claseVehiculo: ClaseVehiculo | null

  @column()
  declare combustible: Combustible | null

  @column({ columnName: 'no_motor' })
  declare noMotor: string | null

  @column({ columnName: 'no_chasis' })
  declare noChasis: string | null

  @column({ columnName: 'no_serie' })
  declare noSerie: string | null

  @column({ columnName: 'no_vin' })
  declare noVin: string | null

  @column({ columnName: 'tipo_servicio' })
  declare tipoServicio: TipoServicioVehiculo | null

  @column({ columnName: 'carroceria_codigo' })
  declare carroceriaCodigo: string | null

  @column({ columnName: 'carroceria_tipo' })
  declare carroceriaTipo: string | null

  @column({ columnName: 'capacidad_kg' })
  declare capacidadKg: string | null

  @column()
  declare blindaje: boolean

  @column({ columnName: 'potencia_hp' })
  declare potenciaHp: string | null

  @column()
  declare cilindrada: string | null

  @column()
  declare puertas: number | null

  // ── Datos del propietario
  @column({ columnName: 'prop_primer_apellido' })
  declare propPrimerApellido: string | null

  @column({ columnName: 'prop_segundo_apellido' })
  declare propSegundoApellido: string | null

  @column({ columnName: 'prop_nombres' })
  declare propNombres: string | null

  @column({ columnName: 'prop_tipo_documento' })
  declare propTipoDocumento: TipoDocumento | null

  @column({ columnName: 'prop_no_documento' })
  declare propNoDocumento: string | null

  @column({ columnName: 'prop_direccion' })
  declare propDireccion: string | null

  @column({ columnName: 'prop_ciudad' })
  declare propCiudad: string | null

  @column({ columnName: 'prop_telefono' })
  declare propTelefono: string | null

  @column({ columnName: 'prop_correo' })
  declare propCorreo: string | null

  // ── Datos del comprador (solo traspaso)
  @column({ columnName: 'comp_primer_apellido' })
  declare compPrimerApellido: string | null

  @column({ columnName: 'comp_segundo_apellido' })
  declare compSegundoApellido: string | null

  @column({ columnName: 'comp_nombres' })
  declare compNombres: string | null

  @column({ columnName: 'comp_tipo_documento' })
  declare compTipoDocumento: TipoDocumento | null

  @column({ columnName: 'comp_no_documento' })
  declare compNoDocumento: string | null

  @column({ columnName: 'comp_direccion' })
  declare compDireccion: string | null

  @column({ columnName: 'comp_ciudad' })
  declare compCiudad: string | null

  @column({ columnName: 'comp_telefono' })
  declare compTelefono: string | null

  @column({ columnName: 'comp_correo' })
  declare compCorreo: string | null

  // ── Importación o remate
  @column({ columnName: 'importacion_tipo' })
  declare importacionTipo: ImportacionTipo | null

  @column({ columnName: 'importacion_no_documento' })
  declare importacionNoDocumento: string | null

  @column.date({ columnName: 'importacion_fecha' })
  declare importacionFecha: DateTime | null

  // ── Alertas
  @column({ columnName: 'alerta_hurto' })
  declare alertaHurto: boolean

  @column({ columnName: 'alerta_lim_propiedad' })
  declare alertaLimPropiedad: boolean

  @column({ columnName: 'alerta_embargo' })
  declare alertaEmbargo: boolean

  @column({ columnName: 'alerta_otro' })
  declare alertaOtro: string | null

  // ── Regrabado
  @column({ columnName: 'motor_regrabado' })
  declare motorRegrabado: boolean

  @column({ columnName: 'chasis_regrabado' })
  declare chasisRegrabado: boolean

  @column({ columnName: 'serie_regrabado' })
  declare serieRegrabado: boolean

  // ── Datos del mandatario
  @column({ columnName: 'mandatario_nombre' })
  declare mandatarioNombre: string | null

  @column({ columnName: 'mandatario_documento' })
  declare mandatarioDocumento: string | null

  // ── Observaciones
  @column()
  declare observaciones: string | null

  @column.dateTime({ autoCreate: true, columnName: 'created_at' })
  declare createdAt: DateTime

  @column.dateTime({ autoCreate: true, autoUpdate: true, columnName: 'updated_at' })
  declare updatedAt: DateTime
}
