/** Relacion de aspecto del recuadro guia (una toma de 35 mm es 3:2). */
export const GUIDE_ASPECT = 3 / 2
/** Fraccion maxima del cuadro de video que ocupa el recuadro guia. */
export const GUIDE_FILL = 0.84

/** Recuadro guia en pixeles del video, centrado. */
export function guideRect(vw: number, vh: number) {
  let w = vw * GUIDE_FILL
  let h = w / GUIDE_ASPECT
  if (h > vh * GUIDE_FILL) {
    h = vh * GUIDE_FILL
    w = h * GUIDE_ASPECT
  }
  return { x: (vw - w) / 2, y: (vh - h) / 2, w, h }
}

export type LightState = 'dark' | 'bright' | 'flat' | 'good'

/** Mide la luz dentro del recuadro para guiar al usuario antes de capturar. */
export function analyzeLight(video: HTMLVideoElement): LightState {
  const vw = video.videoWidth
  const vh = video.videoHeight
  if (!vw || !vh) return 'dark'
  const r = guideRect(vw, vh)
  const canvas = document.createElement('canvas')
  canvas.width = 64
  canvas.height = Math.round(64 / GUIDE_ASPECT)
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return 'good'
  ctx.drawImage(video, r.x, r.y, r.w, r.h, 0, 0, canvas.width, canvas.height)
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)

  let sum = 0
  let sumSq = 0
  let clipped = 0
  const n = data.length / 4
  for (let i = 0; i < data.length; i += 4) {
    const y = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]
    sum += y
    sumSq += y * y
    if (y > 250) clipped++
  }
  const mean = sum / n
  const sd = Math.sqrt(Math.max(sumSq / n - mean * mean, 0))
  if (mean < 60) return 'dark'
  if (mean > 235 || clipped / n > 0.4) return 'bright'
  if (sd < 12) return 'flat'
  return 'good'
}


export interface Adjust {
  /** -1 (mas oscura) a 1 (mas clara). */
  exposure: number
  /** 0 (plano) a 2 (fuerte); 1 es neutro. */
  contrast: number
  /** -1 (frio) a 1 (calido). */
  warmth: number
  /** 0 (blanco y negro) a 2 (muy saturado); 1 es neutro. */
  saturation: number
}

export const DEFAULT_ADJUST: Adjust = { exposure: 0, contrast: 1.2, warmth: 0, saturation: 1.15 }

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1)

/**
 * Convierte la foto de un negativo en positivo a color.
 * 1. Mide solo la zona central (ignora bordes, perforaciones y la luz de fondo).
 * 2. Estira los niveles de cada canal por separado (quita la dominante naranja de la base).
 * 3. Invierte, ajusta la exposicion automaticamente y equilibra los blancos.
 * 4. Aplica contraste (curva en S) y saturacion segun los ajustes.
 */
export function developNegative(source: HTMLCanvasElement, adjust: Adjust = DEFAULT_ADJUST): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const ctx = out.getContext('2d')
  const srcCtx = source.getContext('2d', { willReadFrequently: true })
  if (!ctx || !srcCtx) throw new Error('No se pudo procesar la imagen')

  const w = source.width
  const h = source.height
  const image = srcCtx.getImageData(0, 0, w, h)
  const { data } = image

  // 1. Histograma por canal, solo del 80 % central.
  const x0 = Math.floor(w * 0.1)
  const x1 = Math.ceil(w * 0.9)
  const y0 = Math.floor(h * 0.1)
  const y1 = Math.ceil(h * 0.9)
  const hist = [new Uint32Array(256), new Uint32Array(256), new Uint32Array(256)]
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * w + x) * 4
      hist[0][data[i]]++
      hist[1][data[i + 1]]++
      hist[2][data[i + 2]]++
    }
  }
  const count = (x1 - x0) * (y1 - y0)
  const clip = Math.floor(count * 0.005)

  // 2. Niveles por canal + inversion (valores 0..1).
  const levels: Float32Array[] = []
  for (let c = 0; c < 3; c++) {
    let low = 0
    let acc = 0
    while (low < 255 && acc + hist[c][low] <= clip) acc += hist[c][low++]
    let high = 255
    acc = 0
    while (high > 0 && acc + hist[c][high] <= clip) acc += hist[c][high--]
    if (high - low < 8) {
      low = 0
      high = 255
    }
    const lut = new Float32Array(256)
    for (let v = 0; v < 256; v++) lut[v] = 1 - clamp01((v - low) / (high - low))
    levels.push(lut)
  }

  // Medias de la imagen ya invertida (muestreando) para exposicion y balance de blancos.
  const mean = [0, 0, 0]
  let samples = 0
  for (let y = y0; y < y1; y += 3) {
    for (let x = x0; x < x1; x += 3) {
      const i = (y * w + x) * 4
      mean[0] += levels[0][data[i]]
      mean[1] += levels[1][data[i + 1]]
      mean[2] += levels[2][data[i + 2]]
      samples++
    }
  }
  for (let c = 0; c < 3; c++) mean[c] /= samples || 1
  const lum = 0.299 * mean[0] + 0.587 * mean[1] + 0.114 * mean[2]

  // 3. Exposicion automatica: gamma que lleva la luminosidad media al objetivo.
  const target = Math.min(Math.max(0.45 + adjust.exposure * 0.2, 0.15), 0.8)
  const exponent = Math.min(Math.max(Math.log(target) / Math.log(Math.max(lum, 0.02)), 0.4), 2.5)

  // Balance de blancos (mundo gris) aplicado al 70 %, mas el ajuste calido/frio.
  const grayMean = (mean[0] + mean[1] + mean[2]) / 3
  const gains = mean.map((m) => Math.min(Math.max(Math.pow(grayMean / Math.max(m, 0.02), 0.7), 0.6), 1.6))
  gains[0] *= 1 + 0.15 * adjust.warmth
  gains[2] *= 1 - 0.15 * adjust.warmth

  // 4. LUT final por canal: gamma + balance + contraste (curva suave en S).
  const t = adjust.contrast - 1
  const finalLut: Uint8ClampedArray[] = levels.map((lv, c) => {
    const lut = new Uint8ClampedArray(256)
    for (let v = 0; v < 256; v++) {
      let p = clamp01(Math.pow(lv[v], exponent) * gains[c])
      const smooth = p * p * (3 - 2 * p)
      p = clamp01(p + t * (smooth - p))
      lut[v] = Math.round(p * 255)
    }
    return lut
  })

  const sat = adjust.saturation
  for (let i = 0; i < data.length; i += 4) {
    const r = finalLut[0][data[i]]
    const g = finalLut[1][data[i + 1]]
    const b = finalLut[2][data[i + 2]]
    const l = 0.299 * r + 0.587 * g + 0.114 * b
    data[i] = l + (r - l) * sat
    data[i + 1] = l + (g - l) * sat
    data[i + 2] = l + (b - l) * sat
  }
  ctx.putImageData(image, 0, 0)
  return out
}
