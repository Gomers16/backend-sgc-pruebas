// app/services/importacion_bogota/lector_xls.ts
//
// Lector mínimo de Excel 97-2003 (.xls = BIFF8 dentro de un contenedor CFB),
// solo para VALORES de celdas de la primera hoja. Sin dependencias: ExcelJS
// solo lee .xlsx.
//
// Soporta: CFB v3/v4 (FAT, DIFAT, mini-stream), SST con CONTINUE, LABELSST,
// LABEL, NUMBER, RK, MULRK, FORMULA (número, texto vía STRING, booleano),
// BOOLERR y DATEMODE (sistema 1904). Ignora formatos, estilos y fórmulas.
// Verificado celda por celda contra Excel (BD 2022 ACT.xls, 11.439 × 42).

export type CeldaXls = string | number | boolean | null

export interface HojaXls {
  nombre: string
  filas: CeldaXls[][]
  /** true si el libro usa el sistema de fechas 1904. */
  fecha1904: boolean
}

const FIRMA_CFB = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])
const FIN_CADENA = 0xfffffffe
const LIBRE = 0xffffffff

export function esXls(buf: Buffer): boolean {
  return buf.length >= 8 && buf.subarray(0, 8).equals(FIRMA_CFB)
}

/* ============================ CFB ============================ */

function leerStreamCfb(buf: Buffer, nombres: string[]): Buffer {
  if (!esXls(buf)) throw new Error('No es un archivo Excel 97-2003 (.xls)')
  const tamSector = 1 << buf.readUInt16LE(0x1e)
  const tamMini = 1 << buf.readUInt16LE(0x20)
  const primerDir = buf.readUInt32LE(0x30)
  const corteMini = buf.readUInt32LE(0x38)
  const primerMiniFat = buf.readUInt32LE(0x3c)
  let sigDifat = buf.readUInt32LE(0x44)
  const nDifat = buf.readUInt32LE(0x48)

  const offset = (sid: number) => (sid + 1) * tamSector
  const sector = (sid: number) => {
    const o = offset(sid)
    if (o + tamSector > buf.length) throw new Error('Archivo .xls truncado o dañado')
    return buf.subarray(o, o + tamSector)
  }

  // Sectores de la FAT: 109 en la cabecera + cadena DIFAT.
  const sectoresFat: number[] = []
  for (let i = 0; i < 109; i++) {
    const s = buf.readUInt32LE(0x4c + i * 4)
    if (s !== LIBRE) sectoresFat.push(s)
  }
  const porDifat = tamSector / 4 - 1
  for (let n = 0; n < nDifat && sigDifat !== FIN_CADENA && sigDifat !== LIBRE; n++) {
    const sec = sector(sigDifat)
    for (let i = 0; i < porDifat; i++) {
      const s = sec.readUInt32LE(i * 4)
      if (s !== LIBRE) sectoresFat.push(s)
    }
    sigDifat = sec.readUInt32LE(porDifat * 4)
  }
  const fat: number[] = []
  for (const s of sectoresFat) {
    const sec = sector(s)
    for (let i = 0; i < tamSector / 4; i++) fat.push(sec.readUInt32LE(i * 4))
  }

  const cadena = (inicio: number, tabla: number[]): number[] => {
    const out: number[] = []
    const vistos = new Set<number>()
    for (let s = inicio; s !== FIN_CADENA && s !== LIBRE; s = tabla[s]) {
      if (vistos.has(s) || s >= tabla.length) throw new Error('Cadena de sectores inválida')
      vistos.add(s)
      out.push(s)
    }
    return out
  }
  const leerCadena = (inicio: number, tam: number) =>
    Buffer.concat(cadena(inicio, fat).map(sector)).subarray(0, tam)

  // Directorio
  const dir = Buffer.concat(cadena(primerDir, fat).map(sector))
  type Entrada = { nombre: string; tipo: number; inicio: number; tam: number }
  const entradas: Entrada[] = []
  for (let o = 0; o + 128 <= dir.length; o += 128) {
    const largo = dir.readUInt16LE(o + 64)
    const nombre = largo >= 2 ? dir.toString('utf16le', o, o + largo - 2) : ''
    entradas.push({
      nombre,
      tipo: dir[o + 66],
      inicio: dir.readUInt32LE(o + 116),
      tam: dir.readUInt32LE(o + 120),
    })
  }
  const raiz = entradas.find((e) => e.tipo === 5)
  const ent = entradas.find((e) => e.tipo === 2 && nombres.includes(e.nombre))
  if (!ent) throw new Error('El archivo .xls no contiene un libro de Excel (stream Workbook)')

  if (ent.tam >= corteMini) return leerCadena(ent.inicio, ent.tam)

  // Stream pequeño: mini-stream + mini-FAT.
  if (!raiz) throw new Error('Archivo .xls sin entrada raíz')
  const miniStream = leerCadena(raiz.inicio, raiz.tam)
  const miniFat: number[] = []
  if (primerMiniFat !== FIN_CADENA) {
    const mf = Buffer.concat(cadena(primerMiniFat, fat).map(sector))
    for (let i = 0; i + 4 <= mf.length; i += 4) miniFat.push(mf.readUInt32LE(i))
  }
  return Buffer.concat(
    cadena(ent.inicio, miniFat).map((s) => miniStream.subarray(s * tamMini, (s + 1) * tamMini))
  ).subarray(0, ent.tam)
}

/* ============================ BIFF8 ============================ */

interface Registro {
  tipo: number
  datos: Buffer
  pos: number
}

function registros(wb: Buffer): Registro[] {
  const out: Registro[] = []
  let o = 0
  while (o + 4 <= wb.length) {
    const tipo = wb.readUInt16LE(o)
    const largo = wb.readUInt16LE(o + 2)
    out.push({ tipo, datos: wb.subarray(o + 4, o + 4 + largo), pos: o })
    o += 4 + largo
  }
  return out
}

/** Lector de cadenas que pueden continuar en registros CONTINUE (SST). */
class LectorPartes {
  private i = 0
  private o = 0
  constructor(private partes: Buffer[]) {}
  private actual() {
    while (this.i < this.partes.length && this.o >= this.partes[this.i].length) {
      this.i++
      this.o = 0
    }
    if (this.i >= this.partes.length) throw new Error('SST truncada')
    return this.partes[this.i]
  }
  u8() {
    const b = this.actual()
    return b[this.o++]
  }
  u16() {
    return this.u8() | (this.u8() << 8)
  }
  u32() {
    return (this.u16() | (this.u16() << 16)) >>> 0
  }
  saltar(n: number) {
    for (let k = 0; k < n; k++) this.u8()
  }
  /** Caracteres de una XLUnicodeString; al cruzar a un CONTINUE se relee el byte de opciones. */
  chars(cch: number, alto: boolean): string {
    let s = ''
    let enAlto = alto
    let quedan = cch
    while (quedan > 0) {
      let b = this.actual()
      if (this.o >= b.length) continue
      const disp = enAlto ? Math.floor((b.length - this.o) / 2) : b.length - this.o
      if (disp <= 0) {
        // Fin de la parte: el siguiente CONTINUE empieza con el byte de opciones.
        this.i++
        this.o = 0
        b = this.actual()
        enAlto = (b[this.o++] & 0x01) === 1
        continue
      }
      const n = Math.min(disp, quedan)
      s += enAlto
        ? b.toString('utf16le', this.o, this.o + n * 2)
        : b.toString('latin1', this.o, this.o + n)
      this.o += enAlto ? n * 2 : n
      quedan -= n
      if (quedan > 0 && this.o >= b.length) {
        this.i++
        this.o = 0
        const nb = this.actual()
        enAlto = (nb[this.o++] & 0x01) === 1
      }
    }
    return s
  }
}

function leerSst(partes: Buffer[]): string[] {
  const r = new LectorPartes(partes)
  r.u32() // total
  const unicas = r.u32()
  const out: string[] = []
  for (let k = 0; k < unicas; k++) {
    const cch = r.u16()
    const opc = r.u8()
    const runs = opc & 0x08 ? r.u16() : 0
    const ext = opc & 0x04 ? r.u32() : 0
    out.push(r.chars(cch, (opc & 0x01) === 1))
    r.saltar(runs * 4 + ext)
  }
  return out
}

/** XLUnicodeString dentro de un solo registro (LABEL, STRING, nombre de hoja). */
function cadenaSimple(d: Buffer, o: number, cch: number): string {
  const alto = (d[o] & 0x01) === 1
  const ini = o + 1
  return alto ? d.toString('utf16le', ini, ini + cch * 2) : d.toString('latin1', ini, ini + cch)
}

function rk(v: number): number {
  const div100 = (v & 0x01) !== 0
  let n: number
  if (v & 0x02) {
    n = v >> 2 // entero con signo de 30 bits
  } else {
    const b = Buffer.alloc(8)
    b.writeUInt32LE((v & 0xfffffffc) >>> 0, 4)
    n = b.readDoubleLE(0)
  }
  return div100 ? n / 100 : n
}

/** Lee la PRIMERA hoja de cálculo de un .xls. */
export function leerXls(buf: Buffer): HojaXls {
  const wb = leerStreamCfb(buf, ['Workbook', 'Book'])
  const regs = registros(wb)

  // Globales: SST, hojas, DATEMODE.
  let sst: string[] = []
  let fecha1904 = false
  const hojas: Array<{ nombre: string; pos: number; tipo: number }> = []
  for (let k = 0; k < regs.length; k++) {
    const { tipo, datos } = regs[k]
    if (tipo === 0x0022) fecha1904 = datos.readUInt16LE(0) === 1
    else if (tipo === 0x0085) {
      const cch = datos[6]
      hojas.push({
        pos: datos.readUInt32LE(0),
        tipo: datos[5],
        nombre: cadenaSimple(datos, 7, cch),
      })
    } else if (tipo === 0x00fc) {
      const partes = [datos]
      for (let j = k + 1; j < regs.length && regs[j].tipo === 0x003c; j++)
        partes.push(regs[j].datos)
      sst = leerSst(partes)
    } else if (tipo === 0x000a) break // fin de los globales
  }
  const hoja = hojas.find((h) => h.tipo === 0)
  if (!hoja) throw new Error('El archivo .xls no tiene hojas de cálculo')

  const filas: CeldaXls[][] = []
  const poner = (f: number, c: number, v: CeldaXls) => {
    while (filas.length <= f) filas.push([])
    filas[f][c] = v
  }

  const inicio = regs.findIndex((r) => r.pos === hoja.pos)
  if (inicio < 0) throw new Error('No se encontró el inicio de la hoja en el .xls')
  let formulaPend: { f: number; c: number } | null = null
  for (let k = inicio + 1; k < regs.length; k++) {
    const { tipo, datos: d } = regs[k]
    if (tipo === 0x000a) break // EOF de la hoja
    switch (tipo) {
      case 0x00fd: // LABELSST
        poner(d.readUInt16LE(0), d.readUInt16LE(2), sst[d.readUInt32LE(6)] ?? '')
        break
      case 0x0204: // LABEL
        poner(d.readUInt16LE(0), d.readUInt16LE(2), cadenaSimple(d, 8, d.readUInt16LE(6)))
        break
      case 0x0203: // NUMBER
        poner(d.readUInt16LE(0), d.readUInt16LE(2), d.readDoubleLE(6))
        break
      case 0x027e: // RK
        poner(d.readUInt16LE(0), d.readUInt16LE(2), rk(d.readInt32LE(6)))
        break
      case 0x00bd: {
        // MULRK
        const f = d.readUInt16LE(0)
        const c0 = d.readUInt16LE(2)
        const n = (d.length - 6) / 6
        for (let j = 0; j < n; j++) poner(f, c0 + j, rk(d.readInt32LE(4 + j * 6 + 2)))
        break
      }
      case 0x0205: // BOOLERR
        poner(d.readUInt16LE(0), d.readUInt16LE(2), d[7] === 0 ? d[6] !== 0 : null)
        break
      case 0x0006: {
        // FORMULA: valor en caché
        const f = d.readUInt16LE(0)
        const c = d.readUInt16LE(2)
        if (d.readUInt16LE(12) === 0xffff) {
          const t = d[6]
          if (t === 0)
            formulaPend = { f, c } // texto en el STRING siguiente
          else if (t === 1) poner(f, c, d[8] !== 0)
          else poner(f, c, null)
        } else {
          poner(f, c, d.readDoubleLE(6))
        }
        break
      }
      case 0x0207: // STRING (resultado de la fórmula anterior)
        if (formulaPend) {
          poner(formulaPend.f, formulaPend.c, cadenaSimple(d, 2, d.readUInt16LE(0)))
          formulaPend = null
        }
        break
    }
  }
  // Huecos → null
  for (const fila of filas)
    for (let c = 0; c < fila.length; c++) if (fila[c] === undefined) fila[c] = null

  return { nombre: hoja.nombre, filas, fecha1904 }
}
