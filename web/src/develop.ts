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

/**
 * Convierte la foto de un negativo en positivo a color:
 * 1. Estira los niveles de cada canal por separado (esto elimina la dominante naranja del negativo).
 * 2. Invierte los valores.
 */
export function developNegative(source: HTMLCanvasElement): HTMLCanvasElement {
  const out = document.createElement('canvas')
  out.width = source.width
  out.height = source.height
  const ctx = out.getContext('2d')
  const srcCtx = source.getContext('2d')
  if (!ctx || !srcCtx) throw new Error('No se pudo procesar la imagen')

  const image = srcCtx.getImageData(0, 0, source.width, source.height)
  const { data } = image
  const total = data.length / 4
  const clip = Math.floor(total * 0.005)

  const luts: Uint8ClampedArray[] = []
  for (let c = 0; c < 3; c++) {
    const hist = new Uint32Array(256)
    for (let i = c; i < data.length; i += 4) hist[data[i]]++

    let low = 0
    let acc = 0
    while (low < 255 && acc + hist[low] <= clip) acc += hist[low++]
    let high = 255
    acc = 0
    while (high > 0 && acc + hist[high] <= clip) acc += hist[high--]
    if (high <= low) {
      low = 0
      high = 255
    }

    const lut = new Uint8ClampedArray(256)
    for (let v = 0; v < 256; v++) {
      const stretched = Math.min(Math.max((v - low) / (high - low), 0), 1)
      lut[v] = 255 - Math.round(stretched * 255)
    }
    luts.push(lut)
  }

  for (let i = 0; i < data.length; i += 4) {
    data[i] = luts[0][data[i]]
    data[i + 1] = luts[1][data[i + 1]]
    data[i + 2] = luts[2][data[i + 2]]
  }
  ctx.putImageData(image, 0, 0)
  return out
}
