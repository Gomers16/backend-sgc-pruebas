// app/controllers/ocr_controller.ts
import type { HttpContext } from '@adonisjs/core/http'
import { cuid } from '@adonisjs/core/helpers'
import app from '@adonisjs/core/services/app'
import fs from 'node:fs/promises'
import path from 'node:path'
import Tesseract from 'tesseract.js'

const TMP_DIR = app.makePath('uploads/ocr_tmp')

type OCRWord = {
  text: string
  bbox: { x0: number; y0: number; x1: number; y1: number }
  confidence: number
}

export default class OcrController {
  /** POST /api/ocr/parse-ticket (archivo image/*) */
  public async parseTicket({ request, response }: HttpContext) {
    const file = request.file('archivo', { size: '8mb', extnames: ['jpg', 'jpeg', 'png'] })
    if (!file) return response.badRequest({ ok: false, message: 'archivo (image/*) requerido' })
    if (!file.isValid) return response.badRequest({ ok: false, message: file.errors })

    await fs.mkdir(TMP_DIR, { recursive: true })
    const name = `${cuid()}.${file.extname}`
    const srcPath = path.join(TMP_DIR, `src_${name}`)
    const prePath = path.join(TMP_DIR, `pre_${name}`)
    await fs.copyFile(file.tmpPath!, srcPath)

    try {
      // 1) Preproceso (si hay sharp)
      const usedSharp = await this.tryPreprocessWithSharp(srcPath, prePath)
      const imagePath = usedSharp ? prePath : srcPath

      // 2) OCR global
      const { data } = await Tesseract.recognize(imagePath, 'spa+eng', {
        tessedit_pageseg_mode: '6',
        preserve_interword_spaces: '1',
        user_defined_dpi: '300',
      } as any)

      const text = (data?.text || '').trim()
      // Accede a las palabras con type assertion
      const words = ((data as any)?.words || []) as OCRWord[]
      const one = text.replace(/\s{2,}/g, ' ')

      // 3) Detector de plantilla Activautos → extractor dedicado
      let campos: any | null = null
      if (/activautos\.com|TIQUETE\s+POS\s+NO/i.test(text)) {
        const base = this.extractActivAutos(text)
        const rois = await this.extractByROI(imagePath, words)
        let pinFinal = rois.pin || base.pin
        if (rois.pin) {
          const tieneSufijo = /\s[A-Z]\d{1,3}$/.test(rois.pin)
          if (!tieneSufijo) {
            // Buscar sufijo directamente en la línea del PIN del texto original
            const pinLinea = (text.match(/^.*\bPIN\b[:\s]*(.+)$/im) || [])[1] || ''
            const sufijoTexto = pinLinea.toUpperCase().match(/\b([A-Z]\d{1,3})\s*$/)?.[1] || null
            pinFinal = sufijoTexto ? `${rois.pin} ${sufijoTexto}` : rois.pin
          }
        }
        campos = { ...base, pin: pinFinal }
      }

      if (!campos) {
        // 4) Fallback: por texto + ROI y combinación
        const base = this.extractByText(one)
        const rois = await this.extractByROI(imagePath, words)
        campos = {
          placa: this.normalizePlate(rois.placa || base.placa),
          nit: rois.nit || base.nit,
          pin: rois.pin || base.pin,
          marca: rois.marca || base.marca,
          vendedor: rois.vendedor || base.vendedor,
          prefijo: rois.prefijo || base.prefijo,
          consecutivo: rois.consecutivo || base.consecutivo,
          // fecha/hora por texto suele ser más robusto
          fechaHora: base.fechaHora,
          subtotal: rois.subtotal ?? base.subtotal ?? 0,
          iva: rois.iva ?? base.iva ?? 0,
          totalFactura: rois.totalFactura ?? base.totalFactura ?? base.total ?? 0,
          total: rois.totalFactura ?? base.total ?? 0,
        }
      }

      const pinTieneAmbiguos = /[08]/.test(campos.pin || '')
      return {
        ok: true,
        text,
        campos,
        advertencias: pinTieneAmbiguos
          ? ['El PIN puede contener dígitos 0/8 confundidos, verifique manualmente']
          : [],
      }
    } catch (err) {
      console.error('OCR backend error:', err)
      return response.internalServerError({ ok: false, message: 'Error ejecutando OCR' })
    } finally {
      fs.rm(srcPath).catch(() => {})
      fs.rm(prePath).catch(() => {})
    }
  }

  // ================= PREPROCESO (sharp opcional) =================
  private async tryPreprocessWithSharp(src: string, out: string): Promise<boolean> {
    try {
      const mod = await import('sharp').catch(() => null)
      const sharp = mod?.default
      if (!sharp) return false
      await sharp(src)
        .rotate()
        .resize({ width: 2200, withoutEnlargement: true })
        .grayscale()
        .normalize()
        .sharpen(1.2, 1, 0.7)
        .threshold(165)
        .toFormat('png', { compressionLevel: 9 })
        .toFile(out)
      return true
    } catch {
      return false
    }
  }

  // ================== EXTRACTOR ESPECIALIZADO (ACTIVAUTOS) ==================
  private extractActivAutos(fullText: string) {
    const txt = norm(fullText)

    // ——— Cabecera: líneas que contienen FECHA/HORA (pueden venir juntas) ———
    const fechaLine = (txt.match(/(^|\n).*?FECHA[^\n]*/im) || [])[0] || ''
    const horaLine = fechaLine || (txt.match(/(^|\n).*?HORA[^\n]*/im) || [])[0] || ''

    // Tokens robustos
    const fechaTok = this.pickDate(fechaLine) || this.pickDate(matchAfterLabel(txt, /FECHA/i) || '')
    const horaTok = this.pickTime(horaLine) || this.pickTime(matchAfterLabel(txt, /HORA/i) || '')

    const nit = matchAfterLabel(txt, /NIT\b/i)
    const vendedor = matchAfterLabel(txt, /VEND(?:EDOR)?/i)
    const placaRaw = matchAfterLabel(txt, /PLACA\b/i)
    const pinLine =
      (txt.match(/^.*\bPIN\b[:\s]*(.+)$/im) || [])[1] || matchAfterLabel(txt, /PIN\b/i)
    const pinRaw = pinLine
    const marcaRaw = matchAfterLabel(txt, /MARCA\b/i)

    // En la misma línea de cabecera suele estar "FV FE: 1960" (o variantes)
    const fvLinea =
      (txt.match(/(^|\n).*FV\s*FE\s*[:\-]?\s*([A-Z]{0,3})?[\s\-:]*?(\d{2,6}).*$/im) || [])[0] || ''

    let prefijo: string | null = null
    let consecutivo: string | null = null

    const mv = fvLinea.toUpperCase().match(/\b(FV|FE)\b/)
    const mc = fvLinea.match(/\b(\d{2,6})\b/)
    if (mv) prefijo = mv[1]
    if (mc) consecutivo = mc[1]

    // Totales (líneas exactas)
    const subLine =
      txt.match(/^\s*SUBTOTAL\s+([$\d\.\, ]+)/im)?.[1] ||
      matchAfterLabel(txt, /SUB\s*TOTAL|SUBTOTAL/i)
    const ivaLine = txt.match(/^\s*IVA\s+([$\d\.\, ]+)/im)?.[1] || matchAfterLabel(txt, /IVA\b/i)
    const totFac =
      txt.match(/^\s*TOTAL\s+FACTURA\s+([$\d\.\, ]+)/im)?.[1] ||
      matchAfterLabel(txt, /TOTAL\s*FACTURA/i) ||
      matchAfterLabel(txt, /^TOTAL$/i)

    // Normalizaciones
    const placa = this.normalizePlate(placaRaw || '')
    const pin = this.cleanPin(
      (pinRaw || '')
        .toUpperCase()
        .replace(/[^A-Z0-9\- ]/g, '')
        .trim()
    )
    const marca = this.cleanSimple(marcaRaw || '')
    const vendedorOk = this.cleanSimple(vendedor || '')

    // Fecha/hora finales en ISO local (hora opcional → 00:00:00)
    const fechaHora = this.toLocalDatetimeISO(fechaTok || null, horaTok || null)

    return {
      placa: placa || null,
      nit: this.cleanNit(nit || ''),
      pin,
      marca,
      vendedor: vendedorOk,
      prefijo,
      consecutivo,
      fechaHora,
      subtotal: moneyToInt(subLine),
      iva: moneyToInt(ivaLine),
      totalFactura: moneyToInt(totFac),
      total: moneyToInt(totFac),
    }
  }

  // ================= EXTRACCIÓN POR ROI =================
  private async extractByROI(imagePath: string, words: OCRWord[]) {
    const lines = this.groupByLine(words)

    const roi = (label: RegExp) => this.findRightROI(lines, label)
    const read = async (r: any, whitelist?: string) => {
      if (!r) return null
      const buf = await this.crop(imagePath, r)
      const { data } = await Tesseract.recognize(buf, 'spa+eng', {
        tessedit_pageseg_mode: '7',
        user_defined_dpi: '300',
        ...(whitelist ? { tessedit_char_whitelist: whitelist } : {}),
      } as any)
      return (data?.text || '').trim()
    }

    // ROIs
    const roiPlaca = roi(/^\s*PLACA\b/i)
    const roiNit = roi(/\bNIT\b/i)
    const roiPin = roi(/\bPIN\b/i)
    const roiMarca = roi(/\bMARCA\b/i)
    const roiVen = roi(/\bVEN(?:DEDOR)?\b/i)
    const roiFV = roi(/\b(FV|FE)\b/i)
    const roiSub = roi(/\bSUB\s*TOTAL\b|\bSUBTOTAL\b/i)
    const roiIva = roi(/\bIVA\b/i)
    const roiTot = roi(/\bTOTAL\s*FACTURA\b/i) || roi(/\bTOTAL\b/i)

    // Lecturas con whitelist
    const placaRaw = await read(roiPlaca, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ')
    const nitRaw = await read(roiNit, '0123456789.- ')
    // PIN: multipass para mayor precisión en dígitos 0↔8
    const pinMulti = roiPin ? await this.readPinMultipass(imagePath, roiPin) : null
    const pinFullRaw = await read(roiPin, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 ')
    const pinRaw = this.combinePin(pinMulti, pinFullRaw)
    const marcaRaw = await read(roiMarca)
    const venRaw = await read(roiVen)
    const fvRaw = await read(roiFV, 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789- ')
    const subRaw = await read(roiSub, '$0123456789., ')
    const ivaRaw = await read(roiIva, '$0123456789., ')
    const totRaw = await read(roiTot, '$0123456789., ')

    const cleanMoney = (s?: string | null) => (s ? Number(s.replace(/[^\d]/g, '') || '0') : 0)
    const prefCons = this.pickPrefijoConsec(fvRaw)

    return {
      placa: this.normalizePlate(this.takeFirstToken(placaRaw)),
      nit: this.cleanNit(nitRaw),
      pin: this.cleanPin(pinRaw),
      marca: this.cleanSimple(marcaRaw),
      vendedor: this.cleanSimple(venRaw),
      prefijo: prefCons.prefijo,
      consecutivo: prefCons.consecutivo,
      subtotal: cleanMoney(subRaw),
      iva: cleanMoney(ivaRaw),
      totalFactura: cleanMoney(totRaw),
    }
  }

  private async crop(imagePath: string, r: { x0: number; y0: number; x1: number; y1: number }) {
    const { default: sharp } = await import('sharp')
    const left = Math.max(r.x0 - 6, 0)
    const top = Math.max(r.y0 - 6, 0)
    const width = Math.max(r.x1 - r.x0 + 12, 12)
    const height = Math.max(r.y1 - r.y0 + 12, 12)
    return sharp(imagePath)
      .extract({ left, top, width, height })
      .grayscale()
      .normalize()
      .toFormat('png')
      .toBuffer()
  }

  // ================= MULTIPASS PIN (voto por mayoría dígito a dígito) =================
  private async readPinMultipass(
    imagePath: string,
    roi: { x0: number; y0: number; x1: number; y1: number }
  ): Promise<string | null> {
    const { default: sharp } = await import('sharp')
    const left = Math.max(roi.x0 - 6, 0)
    const top = Math.max(roi.y0 - 6, 0)
    const width = Math.max(roi.x1 - roi.x0 + 12, 12)
    const height = Math.max(roi.y1 - roi.y0 + 12, 12)

    // 3 pasadas con distintos thresholds
    const thresholds = [140, 165, 190]
    const resultados: string[] = []

    for (const t of thresholds) {
      const buf = await sharp(imagePath)
        .extract({ left, top, width, height })
        .resize(width * 4)
        .grayscale()
        .normalize()
        .sharpen(2, 1, 0.5)
        .threshold(t)
        .toFormat('png')
        .toBuffer()

      const { data } = await Tesseract.recognize(buf, 'eng', {
        tessedit_pageseg_mode: '7',
        user_defined_dpi: '300',
        tessedit_char_whitelist: '0123456789',
      } as any)

      const digits = (data?.text || '').replace(/\D/g, '')
      if (digits.length >= 6) resultados.push(digits)
    }

    if (!resultados.length) return null

    // Voto por mayoría dígito a dígito
    const maxLen = Math.max(...resultados.map((r) => r.length))
    let pinFinal = ''
    for (let i = 0; i < maxLen; i++) {
      const votos: Record<string, number> = {}
      for (const r of resultados) {
        const d = r[i]
        if (d) votos[d] = (votos[d] || 0) + 1
      }
      const ganador = Object.entries(votos).sort((a, b) => b[1] - a[1])[0]?.[0] || '0'
      pinFinal += ganador
    }

    return pinFinal.length >= 6 ? pinFinal : null
  }

  private takeFirstToken(s?: string | null) {
    if (!s) return null
    const t = s.replace(/\s+/g, ' ').trim()
    const tok = t.split(' ')[0] || ''
    return tok.replace(/[^\w-]/g, '') || null
  }

  private pickPrefijoConsec(s?: string | null) {
    if (!s) return { prefijo: null, consecutivo: null }
    const m = s.toUpperCase().match(/\b(FV|FE)[\s\-:]*[A-Z]*\s*[-:]?\s*(\d{2,6})\b/)
    return m ? { prefijo: m[1], consecutivo: m[2] } : { prefijo: null, consecutivo: null }
  }

  // ================= EXTRACCIÓN POR TEXTO (GENÉRICO) =================
  private extractByText(one: string) {
    const pullNum = (s?: string | null) => (s ? Number(String(s).replace(/[^\d]/g, '')) || 0 : 0)

    const pickLine = (re: RegExp) => {
      const m = one.match(new RegExp(`(^|\\n)\\s*${re.source}[:\\s-]*([^\\n]+)`, re.flags + ''))
      return m ? m[2].trim() : null
    }

    const placa = this.normalizePlate(
      this.takeFirstToken(pickLine(/PLACA/i)) ||
        this.takeFirstToken(one.match(/\b([A-Z]{3}\d{2,3}[A-Z]?)\b/)?.[1])
    )
    const nit = this.cleanNit(pickLine(/NIT/i))
    const pin = this.cleanPin(pickLine(/PIN/i))
    const marca = this.cleanSimple(pickLine(/MARCA/i))
    const vendedor = this.cleanSimple(pickLine(/VEN(?:DEDOR)?/i))

    const fvfeRaw = pickLine(/(FV|FE)/i) || one
    const fvfe = fvfeRaw
      ? fvfeRaw.toUpperCase().match(/\b(FV|FE)[\s\-:]*[A-Z]*\s*[-:]?\s*(\d{2,6})\b/)
      : null
    const prefijo = fvfe?.[1] || null
    const consecutivo = fvfe?.[2] || null

    // Línea que contenga FECHA y posiblemente HORA
    const rawFechaLine = (one.match(/(^|\n).*?FECHA[^\n]*$/im) || [])[0] || ''
    const fechaTok = this.pickDate(rawFechaLine) || this.pickDate(pickLine(/FECHA/i) || '')
    const horaTok = this.pickTime(rawFechaLine) || this.pickTime(pickLine(/HORA/i) || '')
    const fechaHora = this.toLocalDatetimeISO(fechaTok, horaTok)

    const mSub =
      one.match(/\bSUB\s*TOTAL[:\s]*\$?\s*([\d\.,]+)/i) ||
      one.match(/\bSUBTOTAL[:\s]*\$?\s*([\d\.,]+)/i)
    const mIva = one.match(/\bIVA(?:\s*\(\d+%?\))?[:\s]*\$?\s*([\d\.,]+)/i)
    const mTotFac = one.match(/\bTOTAL\s*FACTURA[:\s]*\$?\s*([\d\.,]+)/i)
    const mTot = one.match(/\bTOTAL[:\s]*\$?\s*([\d\.,]+)/i)

    return {
      placa,
      nit,
      pin,
      marca,
      vendedor,
      prefijo,
      consecutivo,
      fechaHora,
      subtotal: pullNum(mSub?.[1]),
      iva: pullNum(mIva?.[1]),
      totalFactura: pullNum(mTotFac?.[1]) || pullNum(mTot?.[1]),
      total: pullNum(mTot?.[1]),
    }
  }

  // ================= UTILIDADES ROI/LÍNEA =================
  private groupByLine(words: OCRWord[]) {
    if (!words?.length) return [] as OCRWord[][]
    const sorted = [...words].sort((a, b) => a.bbox.y0 - b.bbox.y0 || a.bbox.x0 - b.bbox.x0)
    const lines: OCRWord[][] = []
    const tol = 10
    for (const w of sorted) {
      const cy = (w.bbox.y0 + w.bbox.y1) / 2
      const last = lines[lines.length - 1]
      if (!last) {
        lines.push([w])
        continue
      }
      const ly = (last[0].bbox.y0 + last[0].bbox.y1) / 2
      if (Math.abs(cy - ly) <= tol) last.push(w)
      else lines.push([w])
    }
    for (const line of lines) line.sort((a, b) => a.bbox.x0 - b.bbox.x0)
    return lines
  }

  private findRightROI(lines: OCRWord[][], keyRegex: RegExp) {
    const labelRegex =
      /\b(PLACA|NIT|PIN|MARCA|VEN(?:DEDOR)?|FV|FE|SUB\s*TOTAL|SUBTOTAL|TOTAL\s*FACTURA|TOTAL|IVA|HORA|FECHA)\b/i
    for (const line of lines) {
      const lineText = line.map((w) => w.text).join(' ')
      if (!keyRegex.test(lineText)) continue
      const idx = line.findIndex((w) => keyRegex.test(w.text))
      if (idx === -1) continue

      let r = idx + 1
      while (r < line.length && !labelRegex.test(line[r].text)) r++
      const toks = line.slice(idx + 1, r)
      if (!toks.length) continue

      const x0 = Math.min(...toks.map((t) => t.bbox.x0))
      const x1 = Math.max(...toks.map((t) => t.bbox.x1))
      const y0 = Math.min(...toks.map((t) => t.bbox.y0))
      const y1 = Math.max(...toks.map((t) => t.bbox.y1))
      if (x1 - x0 < 8 || y1 - y0 < 8) continue
      return { x0, y0, x1, y1 }
    }
    return null
  }

  // ================= NORMALIZADORES =================
  private cleanSimple(s?: string | null) {
    if (!s) return null
    return (
      s
        .replace(/\s{2,}/g, ' ')
        .replace(/[^\wÁÉÍÓÚÑ°\s\-\.]/g, '')
        .trim() || null
    )
  }

  private cleanNit(s?: string | null) {
    if (typeof s !== 'string') return null
    const t = s.trim()
    if (!t) return null
    return t.replace(/\s+/g, '').replace(/[^\d\-\.]/g, '') || null
  }

  private cleanPin(s?: string | null) {
    if (!s) return null
    return s.trim() || null
  }

  private combinePin(numPart?: string | null, fullPart?: string | null): string | null {
    const num = (numPart || '').replace(/\D/g, '')
    if (!num || num.length < 6) return null
    const sufijo = (fullPart || '').toUpperCase().match(/\b([A-Z]\d{1,3})\b/)?.[1] || null
    return sufijo ? `${num} ${sufijo}` : num
  }

  /** Normaliza placas colombianas (AAA123 / AAA12A) corrigiendo O↔0, I↔1, S↔5 por posición sin forzar cambios injustificados */
  private normalizePlate(p?: string | null) {
    if (!p) return null
    let s = p.toUpperCase().replace(/[\s\-]/g, '')
    if (s.length < 5 || s.length > 6) return s

    const toLetter: Record<string, string> = { '0': 'O', '1': 'I', '5': 'S', '8': 'B' }
    const toDigit: Record<string, string> = { O: '0', I: '1', S: '5', B: '8' }

    // Primeros 3 usualmente letras
    for (let i = 0; i < Math.min(3, s.length); i++) {
      if (!/[A-Z]/.test(s[i]) && toLetter[s[i]]) s = s.slice(0, i) + toLetter[s[i]] + s.slice(i + 1)
    }
    // Pos. 3-4 suelen ser dígitos
    if (s.length >= 5) {
      for (let i = 3; i <= 4 && i < s.length; i++) {
        if (!/\d/.test(s[i]) && toDigit[s[i]]) s = s.slice(0, i) + toDigit[s[i]] + s.slice(i + 1)
      }
    }
    return s
  }

  // ================= FECHA / HORA ROBUSTAS =================
  private pickDate(s?: string | null): string | null {
    if (!s) return null
    // dd/mm/yyyy o dd-mm-yyyy (también con año 2 dígitos)
    const m1 = s.match(/(\b\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4}\b)/)
    if (m1) {
      const d = m1[1].padStart(2, '0')
      const m = m1[2].padStart(2, '0')
      const y = m1[3].length === 2 ? `20${m1[3]}` : m1[3]
      return `${d}/${m}/${y}`
    }
    // yyyy-mm-dd
    const m2 = s.match(/\b(\d{4})-(\d{2})-(\d{2})\b/)
    if (m2) return `${m2[3]}/${m2[2]}/${m2[1]}`
    return null
  }

  private pickTime(s?: string | null): string | null {
    if (!s) return null
    // 05:03:14 PM | 05.03.14 PM | 17:03:14 | 17:03
    const m = s.match(/\b(\d{1,2}[:\.]\d{2}(?:[:\.]\d{2})?\s?(?:AM|PM)?)\b/i)
    return m ? m[1].replace(/\./g, ':') : null
  }

  /**
   * Corrige errores comunes del OCR en fechas
   * Recibe formato DD/MM/YYYY y devuelve formato corregido DD/MM/YYYY
   */
  private corregirFechaOCR(fechaStr: string): string {
    if (!fechaStr) return fechaStr

    const parts = fechaStr.replace(/-/g, '/').split('/')
    if (parts.length !== 3) return fechaStr

    let [dia, mes, ano] = parts.map((p) => Number.parseInt(p, 10))

    // 1. Año absurdo (>2030 o <2020)
    if (ano > 2030 || ano < 2020) {
      if (ano >= 2600 && ano <= 2699) {
        ano = 2000 + (ano - 2600)
        console.log('🔧 OCR Backend: Año 26XX → 20XX:', ano)
      } else if (ano >= 2100 && ano <= 2199) {
        ano = 2000 + (ano - 2100)
        console.log('🔧 OCR Backend: Año 21XX → 20XX:', ano)
      } else if (ano >= 3000 && ano <= 3099) {
        ano = 2000 + (ano - 3000)
        console.log('🔧 OCR Backend: Año 30XX → 20XX:', ano)
      }
    }

    // 2. Mes inválido (>12)
    if (mes > 12) {
      if (mes === 18) {
        mes = 10
        console.log('🔧 OCR Backend: Mes 18 → 10')
      } else if (mes >= 13 && mes <= 17) {
        mes = mes - 10
        console.log('🔧 OCR Backend: Mes 1X → 0X:', mes)
      } else if (mes === 19) {
        mes = 9
        console.log('🔧 OCR Backend: Mes 19 → 09')
      } else if (mes >= 20 && mes <= 29) {
        mes = mes - 20
        console.log('🔧 OCR Backend: Mes 2X → 0X:', mes)
      } else if (mes >= 60 && mes <= 69) {
        mes = mes - 60
        console.log('🔧 OCR Backend: Mes 6X → 0X (confusión OCR 0↔6):', mes)
      } else if (mes >= 70 && mes <= 79) {
        mes = mes - 70
        console.log('🔧 OCR Backend: Mes 7X → 0X:', mes)
      } else if (mes >= 80 && mes <= 89) {
        mes = mes - 80
        console.log('🔧 OCR Backend: Mes 8X → 0X:', mes)
      }
    }

    // 3. Día inválido (>31)
    if (dia > 31) {
      if (dia === 38) {
        dia = 28
        console.log('🔧 OCR Backend: Día 38 → 28')
      } else if (dia >= 32 && dia <= 37) {
        dia = dia - 10
        console.log('🔧 OCR Backend: Día 3X → 2X:', dia)
      } else if (dia === 39) {
        dia = 29
        console.log('🔧 OCR Backend: Día 39 → 29')
      }
    }

    // 4. Validación final
    if (dia < 1 || dia > 31) {
      console.warn('⚠️ OCR Backend: Día fuera de rango después de corrección:', dia)
      return fechaStr
    }
    if (mes < 1 || mes > 12) {
      console.warn('⚠️ OCR Backend: Mes fuera de rango después de corrección:', mes)
      return fechaStr
    }
    if (ano < 2020 || ano > 2030) {
      console.warn('⚠️ OCR Backend: Año fuera de rango después de corrección:', ano)
      return fechaStr
    }

    const fechaCorregida = `${String(dia).padStart(2, '0')}/${String(mes).padStart(2, '0')}/${ano}`
    console.log('✅ OCR Backend: Fecha corregida:', fechaStr, '→', fechaCorregida)
    return fechaCorregida
  }

  /**
   * Aplica corrección de errores OCR antes de convertir a ISO
   */
  private toLocalDatetimeISO(fecha?: string | null, hora?: string | null): string | null {
    if (!fecha) return null

    const fechaCorregida = this.corregirFechaOCR(fecha)

    let yyyy = ''
    let mm = ''
    let dd = ''
    const f = (fechaCorregida || '').trim()
    if (/^\d{4}-\d{2}-\d{2}$/.test(f)) {
      ;[yyyy, mm, dd] = f.split('-')
    } else {
      const m = f.replace(/-/g, '/').match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/)
      if (!m) return null
      dd = m[1].padStart(2, '0')
      mm = m[2].padStart(2, '0')
      const yRaw = m[3]
      yyyy = yRaw.length === 2 ? `20${yRaw}` : yRaw
    }

    const mmNum = Number(mm)
    const ddNum = Number(dd)
    if (mmNum < 1 || mmNum > 12 || ddNum < 1 || ddNum > 31) {
      console.warn('⚠️ Fecha final fuera de rango tras corrección, descartando:', `${yyyy}-${mm}-${dd}`)
      return null
    }

    const t = this.to24h((hora || '').trim() || '00:00')
    if (!t) return null
    return `${yyyy}-${mm}-${dd}T${t}`
  }

  private to24h(h: string): string | null {
    if (!h) return '00:00:00'
    const t = h.replace(/\./g, ':').replace(/\s+/g, ' ').trim()
    const ampm = /(AM|PM)$/i.test(t)
    let [hh, mm = '00', ss = '00'] = t.replace(/\s?(AM|PM)$/i, '').split(':')
    if (!/^\d+$/.test(hh || '')) return null
    let H = Number(hh)
    if (ampm) {
      const isPM = /PM$/i.test(t)
      if (isPM && H < 12) H += 12
      if (!isPM && H === 12) H = 0
    }
    if (H < 0 || H > 23) return null
    return `${String(H).padStart(2, '0')}:${String(mm || '00').padStart(2, '0')}:${String(ss || '00').padStart(2, '0')}`
  }
} // ← cierra la clase

/* ===== Helpers fuera de la clase ===== */
function norm(text: string) {
  return text
    .replace(/\r/g, '')
    .replace(/[·•]/g, '.')
    .replace(/[""]/g, '"')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
}

function matchAfterLabel(src: string, label: RegExp) {
  const re = new RegExp(`${label.source}[\\s:]*\\n?\\s*([^\\n]+)`, label.flags)
  const m = src.match(re)
  return m ? m[1].trim() : null
}

function moneyToInt(s?: string | null) {
  return s ? Number(s.replace(/[^\d]/g, '') || '0') : 0
}
