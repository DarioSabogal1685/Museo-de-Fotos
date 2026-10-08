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
  /** 0 a 1: reduccion de ruido de luminancia (granulado), conservando bordes. */
  noiseLuma: number
  /** 0 a 1: reduccion de ruido de color (manchas de color). */
  noiseColor: number
  /** 0 a 1: enfoque (mascara de enfoque). */
  sharpness: number
  /** -1 a 1: aclara (+) u oscurece (-) las sombras. */
  shadows: number
  /** -1 a 1: aclara (+) u oscurece (-) las luces; negativo recupera zonas quemadas. */
  highlights: number
  /** 0 a 1: fuerza de la eliminacion automatica de polvo y rayones. */
  dust: number
}

export const DEFAULT_ADJUST: Adjust = {
  exposure: 0,
  contrast: 1.2,
  warmth: 0,
  saturation: 1.15,
  noiseLuma: 0.25,
  noiseColor: 0.4,
  sharpness: 0.3,
  shadows: 0,
  highlights: 0,
  dust: 0,
}

/** Mancha marcada a mano para retocar; coordenadas y radio normalizados (radio respecto al lado mayor). */
export interface Spot {
  x: number
  y: number
  r: number
}

const clamp01 = (v: number) => Math.min(Math.max(v, 0), 1)

/**
 * Convierte la foto de un negativo en positivo a color.
 * 1. Mide solo la zona central (ignora bordes, perforaciones y la luz de fondo).
 * 2. Estira los niveles de cada canal por separado (quita la dominante naranja de la base).
 * 3. Invierte, ajusta la exposicion automaticamente y equilibra los blancos.
 * 4. Aplica contraste (curva en S) y saturacion segun los ajustes.
 */
export function developNegative(
  source: HTMLCanvasElement,
  adjust: Adjust = DEFAULT_ADJUST,
  spots: Spot[] = [],
  /** true: la imagen ya es una foto normal; no se invierte ni se normaliza el color. */
  positive = false,
): HTMLCanvasElement {
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
    if (positive) {
      const identity = new Float32Array(256)
      for (let v = 0; v < 256; v++) identity[v] = v / 255
      levels.push(identity)
      continue
    }
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
  // En una foto normal el brillo solo se desplaza segun el ajuste, sin normalizar.
  const exponent = positive
    ? Math.pow(2, -adjust.exposure)
    : Math.min(Math.max(Math.log(target) / Math.log(Math.max(lum, 0.02)), 0.4), 2.5)

  // Balance de blancos (mundo gris) aplicado al 70 %, mas el ajuste calido/frio.
  const grayMean = (mean[0] + mean[1] + mean[2]) / 3
  const gains = positive
    ? [1, 1, 1]
    : mean.map((m) => Math.min(Math.max(Math.pow(grayMean / Math.max(m, 0.02), 0.7), 0.6), 1.6))
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
    const sr = l + (r - l) * sat
    const sg = l + (g - l) * sat
    const sb = l + (b - l) * sat
    // Sombras y luces: ajuste segun lo oscuro o claro que es cada pixel.
    const lum = (0.299 * sr + 0.587 * sg + 0.114 * sb) / 255
    const shift =
      (adjust.shadows * 0.35 * (1 - lum) * (1 - lum) + adjust.highlights * 0.35 * lum * lum) * 255
    data[i] = sr + shift
    data[i + 1] = sg + shift
    data[i + 2] = sb + shift
  }
  if (adjust.dust > 0) removeDust(data, w, h, adjust.dust)
  if (spots.length) healSpots(data, w, h, spots)
  denoiseAndSharpen(data, w, h, adjust)
  ctx.putImageData(image, 0, 0)
  return out
}

/** Desenfoque de caja separable (media con bordes recortados). */
function boxBlur(src: Float32Array, w: number, h: number, r: number): Float32Array {
  const tmp = new Float32Array(src.length)
  const out = new Float32Array(src.length)
  const prefix = new Float64Array(Math.max(w, h) + 1)

  for (let y = 0; y < h; y++) {
    const row = y * w
    for (let x = 0; x < w; x++) prefix[x + 1] = prefix[x] + src[row + x]
    for (let x = 0; x < w; x++) {
      const lo = Math.max(0, x - r)
      const hi = Math.min(w - 1, x + r)
      tmp[row + x] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
    }
  }
  for (let x = 0; x < w; x++) {
    for (let y = 0; y < h; y++) prefix[y + 1] = prefix[y] + tmp[y * w + x]
    for (let y = 0; y < h; y++) {
      const lo = Math.max(0, y - r)
      const hi = Math.min(h - 1, y + r)
      out[y * w + x] = (prefix[hi + 1] - prefix[lo]) / (hi - lo + 1)
    }
  }
  return out
}

/** Filtro bilateral: promedia vecinos parecidos, asi suaviza el grano sin borrar los bordes. */
function bilateral(luma: Float32Array, w: number, h: number, radius: number, sigmaRange: number): Float32Array {
  const out = new Float32Array(luma.length)
  const size = radius * 2 + 1
  const spatial = new Float32Array(size * size)
  const sigmaS = Math.max(radius / 1.5, 0.8)
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      spatial[(dy + radius) * size + dx + radius] = Math.exp(-(dx * dx + dy * dy) / (2 * sigmaS * sigmaS))
    }
  }
  const range = new Float32Array(256)
  for (let d = 0; d < 256; d++) range[d] = Math.exp(-(d * d) / (2 * sigmaRange * sigmaRange))

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const center = luma[y * w + x]
      let sum = 0
      let weight = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const v = luma[yy * w + xx]
          const wt = spatial[(dy + radius) * size + dx + radius] * range[Math.min(255, Math.abs(v - center) | 0)]
          sum += v * wt
          weight += wt
        }
      }
      out[y * w + x] = sum / weight
    }
  }
  return out
}

/**
 * Trabaja en luminancia/crominancia: reduce el ruido de color (suavizando solo el color),
 * el ruido de luminancia (filtro bilateral) y afina con una mascara de enfoque.
 */
function denoiseAndSharpen(data: Uint8ClampedArray, w: number, h: number, adjust: Adjust) {
  const { noiseLuma, noiseColor, sharpness } = adjust
  if (noiseLuma <= 0 && noiseColor <= 0 && sharpness <= 0) return

  const n = w * h
  const Y = new Float32Array(n)
  const Cb = new Float32Array(n)
  const Cr = new Float32Array(n)
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    Y[p] = 0.299 * r + 0.587 * g + 0.114 * b
    Cb[p] = -0.168736 * r - 0.331264 * g + 0.5 * b
    Cr[p] = 0.5 * r - 0.418688 * g - 0.081312 * b
  }

  // Los radios crecen con el tamano de la imagen para que la vista previa y el resultado final se parezcan.
  const k = Math.max(w, h) / 1000

  let cb: Float32Array = Cb
  let cr: Float32Array = Cr
  if (noiseColor > 0) {
    const r = Math.max(1, Math.round(k * (1 + noiseColor * 6)))
    cb = boxBlur(boxBlur(Cb, w, h, r), w, h, r)
    cr = boxBlur(boxBlur(Cr, w, h, r), w, h, r)
  }

  let luma: Float32Array = Y
  if (noiseLuma > 0) {
    const radius = Math.min(3, Math.max(1, Math.round(k * (1 + noiseLuma) * 1.2)))
    const filtered = bilateral(Y, w, h, radius, 8 + 45 * noiseLuma)
    const mix = Math.min(1, noiseLuma * 1.5)
    luma = new Float32Array(n)
    for (let p = 0; p < n; p++) luma[p] = Y[p] + (filtered[p] - Y[p]) * mix
  }

  if (sharpness > 0) {
    const blurred = boxBlur(luma, w, h, Math.max(1, Math.round(k * 1.5)))
    const amount = sharpness * 1.5
    const sharp = new Float32Array(n)
    for (let p = 0; p < n; p++) sharp[p] = luma[p] + amount * (luma[p] - blurred[p])
    luma = sharp
  }

  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const y = luma[p]
    data[i] = y + 1.402 * cr[p]
    data[i + 1] = y - 0.344136 * cb[p] - 0.714136 * cr[p]
    data[i + 2] = y + 1.772 * cb[p]
  }
}

/** Rota un canvas (grados, en sentido horario). Los huecos de las esquinas se rellenan en gris. */
export function rotateCanvas(src: HTMLCanvasElement, degrees: number): HTMLCanvasElement {
  const deg = ((degrees % 360) + 360) % 360
  if (deg === 0) return src
  const rad = (deg * Math.PI) / 180
  const cos = Math.abs(Math.cos(rad))
  const sin = Math.abs(Math.sin(rad))
  const out = document.createElement('canvas')
  out.width = Math.max(1, Math.round(src.width * cos + src.height * sin))
  out.height = Math.max(1, Math.round(src.width * sin + src.height * cos))
  const ctx = out.getContext('2d')
  if (!ctx) throw new Error('No se pudo girar la imagen')
  ctx.fillStyle = '#808080'
  ctx.fillRect(0, 0, out.width, out.height)
  ctx.translate(out.width / 2, out.height / 2)
  ctx.rotate(rad)
  ctx.drawImage(src, -src.width / 2, -src.height / 2)
  return out
}

/** Recorta un canvas con un rectangulo normalizado (0..1). */
export function cropCanvas(src: HTMLCanvasElement, crop: { x: number; y: number; w: number; h: number }): HTMLCanvasElement {
  const sx = Math.round(crop.x * src.width)
  const sy = Math.round(crop.y * src.height)
  const sw = Math.max(1, Math.min(Math.round(crop.w * src.width), src.width - sx))
  const sh = Math.max(1, Math.min(Math.round(crop.h * src.height), src.height - sy))
  const out = document.createElement('canvas')
  out.width = sw
  out.height = sh
  out.getContext('2d')?.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh)
  return out
}

function median(values: Float32Array, count: number): number {
  const part = values.subarray(0, count)
  part.sort()
  return part[count >> 1]
}

/**
 * Quita polvo y rayones: busca pixeles que destacan mucho respecto a la mediana de su vecindad
 * (motas y lineas finas) y los sustituye por esa mediana. Los bordes grandes no se tocan.
 */
function removeDust(data: Uint8ClampedArray, w: number, h: number, strength: number) {
  const n = w * h
  const Y = new Float32Array(n)
  for (let p = 0, i = 0; p < n; p++, i += 4) Y[p] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]

  const k = Math.max(w, h) / 1000
  const radius = Math.max(2, Math.round(k * 2))
  const threshold = 70 - 55 * strength
  const blurred = boxBlur(Y, w, h, radius)

  const size = (radius * 2 + 1) ** 2
  const win = [new Float32Array(size), new Float32Array(size), new Float32Array(size), new Float32Array(size)]
  const fixes: { p: number; r: number; g: number; b: number }[] = []

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      // Filtro barato para descartar casi todos los pixeles antes de calcular medianas.
      if (Math.abs(Y[p] - blurred[p]) < threshold * 0.4) continue

      let count = 0
      for (let dy = -radius; dy <= radius; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -radius; dx <= radius; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          win[0][count] = Y[q]
          win[1][count] = data[q * 4]
          win[2][count] = data[q * 4 + 1]
          win[3][count] = data[q * 4 + 2]
          count++
        }
      }
      if (Math.abs(Y[p] - median(win[0], count)) < threshold) continue
      fixes.push({ p, r: median(win[1], count), g: median(win[2], count), b: median(win[3], count) })
    }
  }
  // Se aplican al final para que las medianas se calculen siempre sobre la imagen original.
  for (const f of fixes) {
    data[f.p * 4] = f.r
    data[f.p * 4 + 1] = f.g
    data[f.p * 4 + 2] = f.b
  }
}

/** Retoque manual: rellena cada mancha con el color mediano del anillo que la rodea, con borde suave. */
function healSpots(data: Uint8ClampedArray, w: number, h: number, spots: Spot[]) {
  const side = Math.max(w, h)
  for (const s of spots) {
    const cx = s.x * w
    const cy = s.y * h
    const R = Math.max(2, s.r * side)

    const samples: [number[], number[], number[]] = [[], [], []]
    for (const ringScale of [1.3, 1.6]) {
      for (let a = 0; a < 28; a++) {
        const angle = (a / 28) * Math.PI * 2
        const sx = Math.round(cx + Math.cos(angle) * R * ringScale)
        const sy = Math.round(cy + Math.sin(angle) * R * ringScale)
        if (sx < 0 || sx >= w || sy < 0 || sy >= h) continue
        const i = (sy * w + sx) * 4
        samples[0].push(data[i])
        samples[1].push(data[i + 1])
        samples[2].push(data[i + 2])
      }
    }
    if (samples[0].length < 6) continue
    const fill = samples.map((arr) => {
      arr.sort((a, b) => a - b)
      return arr[arr.length >> 1]
    })

    const reach = R * 1.15
    for (let y = Math.max(0, Math.floor(cy - reach)); y <= Math.min(h - 1, Math.ceil(cy + reach)); y++) {
      for (let x = Math.max(0, Math.floor(cx - reach)); x <= Math.min(w - 1, Math.ceil(cx + reach)); x++) {
        const d = Math.hypot(x - cx, y - cy)
        if (d > reach) continue
        // 1 dentro del circulo, baja suavemente hasta 0 en el borde.
        const t = d <= R ? 1 : 1 - (d - R) / (reach - R)
        const i = (y * w + x) * 4
        for (let c = 0; c < 3; c++) data[i + c] = data[i + c] * (1 - t) + fill[c] * t
      }
    }
  }
}

/**
 * Automejora: revela con ajustes neutros, mide la imagen (rango tonal, zonas oscuras y quemadas,
 * color y ruido) y devuelve ajustes razonables para ella.
 */
export function autoAdjust(source: HTMLCanvasElement, positive = false): Adjust {
  const neutral: Adjust = {
    exposure: 0, contrast: 1, warmth: 0, saturation: 1,
    noiseLuma: 0, noiseColor: 0, sharpness: 0, shadows: 0, highlights: 0, dust: 0,
  }
  const small = document.createElement('canvas')
  const scale = Math.min(1, 600 / Math.max(source.width, source.height))
  small.width = Math.max(1, Math.round(source.width * scale))
  small.height = Math.max(1, Math.round(source.height * scale))
  small.getContext('2d')?.drawImage(source, 0, 0, small.width, small.height)

  const developed = developNegative(small, neutral, [], positive)
  const ctx = developed.getContext('2d', { willReadFrequently: true })
  if (!ctx) return { ...DEFAULT_ADJUST }
  const { data } = ctx.getImageData(0, 0, developed.width, developed.height)
  const n = developed.width * developed.height

  const Y = new Float32Array(n)
  const hist = new Uint32Array(256)
  let chroma = 0
  let dark = 0
  let bright = 0
  for (let p = 0, i = 0; p < n; p++, i += 4) {
    const r = data[i]
    const g = data[i + 1]
    const b = data[i + 2]
    const y = 0.299 * r + 0.587 * g + 0.114 * b
    Y[p] = y
    hist[Math.min(255, Math.round(y))]++
    chroma += Math.hypot(-0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b)
    if (y < 25) dark++
    if (y > 235) bright++
  }
  chroma /= n
  const darkFrac = dark / n
  const brightFrac = bright / n

  let acc = 0
  let p1 = 0
  while (p1 < 255 && acc + hist[p1] < n * 0.01) acc += hist[p1++]
  acc = 0
  let p99 = 255
  while (p99 > 0 && acc + hist[p99] < n * 0.01) acc += hist[p99--]
  const range = p99 - p1

  // Ruido estimado: diferencia media entre cada pixel y su entorno inmediato.
  const blurred = boxBlur(Y, developed.width, developed.height, 1)
  let noise = 0
  for (let p = 0; p < n; p++) noise += Math.abs(Y[p] - blurred[p])
  noise /= n

  const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), hi)

  // En una foto normal el brillo no se auto-normaliza al revelar: se corrige aqui hacia una media de 0.45.
  let exposure = 0
  if (positive) {
    let sum = 0
    for (let p = 0; p < n; p++) sum += Y[p]
    const meanLuma = clamp(sum / n / 255, 0.03, 0.97)
    exposure = clamp(-Math.log2(Math.log(0.45) / Math.log(meanLuma)), -1, 1)
  }

  return {
    exposure,
    contrast: range < 200 ? clamp(1 + (200 - range) / 200, 1.05, 1.6) : 1.1,
    warmth: 0,
    saturation: chroma < 20 ? 1.35 : chroma < 35 ? 1.2 : 1.05,
    noiseLuma: clamp(noise / 6, 0.15, 0.6),
    noiseColor: 0.5,
    sharpness: 0.35,
    shadows: darkFrac > 0.1 ? clamp(darkFrac * 2, 0.15, 0.6) : 0.1,
    highlights: brightFrac > 0.03 ? -clamp(brightFrac * 4, 0.15, 0.6) : 0,
    dust: 0.4,
  }
}

/** Aplica los retoques manuales (manchas) a una imagen ya revelada y recortada. */
export function applySpots(source: HTMLCanvasElement, spots: Spot[]): HTMLCanvasElement {
  if (spots.length === 0) return source
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const ctx = out.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('No se pudo retocar la imagen')
  ctx.drawImage(source, 0, 0)
  const image = ctx.getImageData(0, 0, out.width, out.height)
  healSpots(image.data, out.width, out.height, spots)
  ctx.putImageData(image, 0, 0)
  return out
}
