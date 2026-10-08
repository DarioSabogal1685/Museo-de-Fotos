import { useEffect, useMemo, useRef, useState } from 'react'
import { clearAdminToken, createRoom, fetchRooms, getAdminToken, uploadPhoto } from './api'
import Cropper, { fitCrop, type Crop } from './Cropper'
import { applyCameraSettings } from './cameraLock'
import { startLivePreview } from './liveDevelop'
import {
  analyzeLight,
  applySpots,
  autoAdjust,
  cropCanvas,
  DEFAULT_ADJUST,
  developNegative,
  mirrorCanvas,
  rotateCanvas,
  type Adjust,
  type LightState,
  type Spot,
} from './develop'

interface Props {
  onClose: () => void
}

type Stage = 'camera' | 'edit'

const LIGHT_MESSAGES: Record<LightState, string> = {
  dark: 'Muy oscuro: pon una pantalla blanca o una caja de luz detrás del negativo.',
  bright: 'Demasiada luz: baja el brillo de la pantalla o aleja un poco la cámara.',
  flat: 'No se distingue la imagen: acerca la cámara hasta ver bien el negativo.',
  good: 'Luz correcta. Mantén quieto el celular y pulsa el botón redondo.',
}

export const MAX_SIDE = 3200
export const PREVIEW_SIDE = 1000
/** Tamano de la version nitida de la vista previa, que se calcula cuando se deja de mover un ajuste. */
const LARGE_SIDE = 1800
/** Tiempo que se deja a la camara para ajustar la exposicion antes de bloquearla. */
const LOCK_DELAY_MS = 1200
export const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 }
const LOW_RES_WIDTH = 1200

/** Ancho del cuadro con el que se calcula la vista previa en vivo (pequeno para que sea fluido). */
const LIVE_WIDTH = 480
/** Mismos ajustes que al revelar, sin los filtros pesados (ruido, nitidez, polvo). */
const LIVE_ADJUST: Adjust = { ...DEFAULT_ADJUST, noiseLuma: 0, noiseColor: 0, sharpness: 0, dust: 0 }

export const RATIOS: { key: string; label: string; value: number | null }[] = [
  { key: 'free', label: 'Libre', value: null },
  { key: '1:1', label: '1:1', value: 1 },
  { key: '3:2', label: '3:2', value: 3 / 2 },
  { key: '4:3', label: '4:3', value: 4 / 3 },
  { key: '16:9', label: '16:9', value: 16 / 9 },
]

/** Herramientas de la fila deslizable, como en el editor de fotos del iPhone. */
type Tool = keyof Adjust | 'crop' | 'mirror' | 'retouch'

interface SliderTool {
  id: keyof Adjust
  icon: string
  label: string
  min: number
  max: number
  step: number
}

const SLIDER_TOOLS: SliderTool[] = [
  { id: 'exposure', icon: '☀️', label: 'Brillo', min: -1, max: 1, step: 0.02 },
  { id: 'contrast', icon: '◐', label: 'Contraste', min: 0, max: 2, step: 0.02 },
  { id: 'shadows', icon: '🌑', label: 'Sombras', min: -1, max: 1, step: 0.02 },
  { id: 'highlights', icon: '🌕', label: 'Luces', min: -1, max: 1, step: 0.02 },
  { id: 'evenLight', icon: '💡', label: 'Luz pareja', min: 0, max: 1, step: 0.02 },
  { id: 'warmth', icon: '🌡️', label: 'Calidez', min: -1, max: 1, step: 0.02 },
  { id: 'saturation', icon: '🎨', label: 'Color', min: 0, max: 2, step: 0.02 },
  { id: 'red', icon: '🔴', label: 'Rojo', min: -1, max: 1, step: 0.02 },
  { id: 'green', icon: '🟢', label: 'Verde', min: -1, max: 1, step: 0.02 },
  { id: 'blue', icon: '🔵', label: 'Azul', min: -1, max: 1, step: 0.02 },
  { id: 'sharpness', icon: '🔺', label: 'Nitidez', min: 0, max: 1, step: 0.02 },
  { id: 'noiseLuma', icon: '🌫️', label: 'Ruido', min: 0, max: 1, step: 0.02 },
  { id: 'noiseColor', icon: '💧', label: 'Ruido color', min: 0, max: 1, step: 0.02 },
  { id: 'dust', icon: '🧹', label: 'Polvo', min: 0, max: 1, step: 0.02 },
]

interface Captured {
  /** Foto del negativo en alta resolucion (para el resultado final). */
  full: HTMLCanvasElement
  /** Version reducida para que los ajustes respondan al instante. */
  preview: HTMLCanvasElement
  /** Version mas grande, para ver la foto nitida cuando no se esta moviendo un ajuste. */
  large: HTMLCanvasElement
}

export function scaled(source: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(source.width * scale)
  canvas.height = Math.round(source.height * scale)
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

export const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo crear la imagen'))), 'image/jpeg', 0.93),
  )

/** Valor mostrado como en el iPhone: 0 es el punto de partida y se mueve hacia + o -. */
const displayValue = (tool: SliderTool, value: number) => {
  const v = Math.round((value - DEFAULT_ADJUST[tool.id]) * 100)
  return v > 0 ? `+${v}` : `${v}`
}

/** Sala donde se guardan siempre las fotos reveladas. Desde ahi se pasan a la sala que corresponda. */
const STAGING_ROOM = 'Cuarto de revelaciones'
const normalizeName = (s: string) =>
  s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

export default function NegativeDeveloper({ onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const livePreviewRef = useRef<HTMLCanvasElement>(null)
  // Vista previa en vivo: se muestra la foto ya revelada antes de capturar.
  // Al abrir la camara se ve el negativo sin revelar; el boton del ojo activa la vista revelada.
  const [liveOn, setLiveOn] = useState(false)
  // Exposicion y balance de blancos bloqueados: la vista previa deja de cambiar sola y coincide con la foto.
  const [locked, setLocked] = useState(false)
  const streamRef = useRef<MediaStream | null>(null)
  const [stage, setStage] = useState<Stage>('camera')
  const [light, setLight] = useState<LightState>('dark')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)

  const [captured, setCaptured] = useState<Captured | null>(null)
  const [tool, setTool] = useState<Tool>('exposure')
  const [adjust, setAdjust] = useState<Adjust>(DEFAULT_ADJUST)
  const [developed, setDeveloped] = useState<HTMLCanvasElement | null>(null)

  // Giro y recorte: siempre sobre la foto ya revelada.
  // `mirrored` voltea la imagen de izquierda a derecha ANTES de girarla; los botones de espejo lo traducen
  // a lo que se ve en pantalla (ver flipScreen).
  const [mirrored, setMirrored] = useState(false)
  const skipCropReset = useRef({ quarter: false, ratio: false })
  const [quarter, setQuarter] = useState(0)
  const [fine, setFine] = useState(0)
  const [ratioKey, setRatioKey] = useState('free')
  const [crop, setCrop] = useState<Crop>(FULL_CROP)

  // Retoque manual de manchas.
  const [spots, setSpots] = useState<Spot[]>([])
  const [brush, setBrush] = useState(0.012)

  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  const angle = quarter * 90 + fine
  const ratio = RATIOS.find((r) => r.key === ratioKey)?.value ?? null

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  const startCamera = async () => {
    setCameraError(null)
    setLocked(false) // una camara nueva vuelve al modo automatico
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Este navegador no permite usar la cámara aquí. Puedes elegir una foto del negativo desde tus archivos.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        // 1080p a 30 cuadros: la vista en vivo es fluida. La maxima resolucion se pide solo al capturar.
        video: {
          facingMode: { ideal: 'environment' },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30 },
        },
        audio: false,
      })
      streamRef.current = stream
      // Enfoque automatico continuo, si el dispositivo lo permite.
      const track = stream.getVideoTracks()[0]
      await track
        ?.applyConstraints({ advanced: [{ focusMode: 'continuous' }] } as unknown as MediaTrackConstraints)
        .catch(() => undefined)
      const video = videoRef.current
      if (video) {
        video.srcObject = stream
        await video.play().catch(() => undefined)
      }
      // Exposicion y color bloqueados por defecto: se espera un momento a que la camara se ajuste sola a la luz
      // y despues se fijan. El candado permite liberarlos. Si el dispositivo no puede, queda en automatico.
      window.setTimeout(async () => {
        if (streamRef.current !== stream) return
        if (await applyCameraSettings(track, { lock: true }) && streamRef.current === stream) setLocked(true)
      }, LOCK_DELAY_MS)
    } catch {
      setCameraError('No se pudo abrir la cámara. Revisa el permiso del navegador o elige una foto desde tus archivos.')
    }
  }

  useEffect(() => {
    startCamera()
    return stopCamera
  }, [])

  // Cierra con Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // Revisa la luz mientras la camara esta activa.
  useEffect(() => {
    if (stage !== 'camera' || cameraError) return
    const id = window.setInterval(() => {
      const video = videoRef.current
      if (video && video.videoWidth) setLight(analyzeLight(video))
    }, 500)
    return () => window.clearInterval(id)
  }, [stage, cameraError])

  // Vista previa en vivo. Lo normal es revelar cada cuadro con la tarjeta grafica (fluido); si el navegador
  // no tiene WebGL, se revela un cuadro pequeno unas 10 veces por segundo con el procesador.
  useEffect(() => {
    if (stage !== 'camera' || cameraError || !liveOn || processing) return
    const liveVideo = videoRef.current
    const liveCanvas = livePreviewRef.current
    if (liveVideo && liveCanvas) {
      const stopGpu = startLivePreview(liveVideo, liveCanvas, LIVE_ADJUST)
      if (stopGpu) return stopGpu
    }
    let cancelled = false
    let timer = 0
    const scratch = document.createElement('canvas')
    const tick = () => {
      if (cancelled) return
      const video = videoRef.current
      const target = livePreviewRef.current
      if (video && video.videoWidth && target) {
        scratch.width = LIVE_WIDTH
        scratch.height = Math.round((LIVE_WIDTH * video.videoHeight) / video.videoWidth)
        scratch.getContext('2d', { willReadFrequently: true })?.drawImage(video, 0, 0, scratch.width, scratch.height)
        try {
          const result = developNegative(scratch, LIVE_ADJUST)
          target.width = result.width
          target.height = result.height
          target.getContext('2d')?.drawImage(result, 0, 0)
        } catch {
          /* se intenta de nuevo con el siguiente cuadro */
        }
      }
      // Se espera a terminar un cuadro antes de pedir el siguiente, para no atascar el telefono.
      timer = window.setTimeout(tick, 100)
    }
    tick()
    return () => {
      cancelled = true
      window.clearTimeout(timer)
    }
  }, [stage, cameraError, liveOn, processing])

  // El aviso de "foto guardada" desaparece solo.
  useEffect(() => {
    if (!toast) return
    const id = window.setTimeout(() => setToast(null), 4000)
    return () => window.clearTimeout(id)
  }, [toast])

  // --- Revelado: la foto aparece ya revelada y se vuelve a revelar al mover un ajuste ---
  useEffect(() => {
    if (!captured) {
      setDeveloped(null)
      return
    }
    const id = window.setTimeout(() => setDeveloped(developNegative(captured.preview, adjust)), 40)
    return () => window.clearTimeout(id)
  }, [captured, adjust])

  // Version nitida: mientras se mueve un ajuste se ve la rapida (1000 px); al soltarlo se calcula esta (1800 px),
  // que es la que se ve en reposo. Asi la foto en pantalla se parece mas a lo que se guarda.
  const [developedLarge, setDevelopedLarge] = useState<HTMLCanvasElement | null>(null)
  useEffect(() => {
    setDevelopedLarge(null)
    if (!captured) return
    const id = window.setTimeout(() => setDevelopedLarge(developNegative(captured.large, adjust)), 450)
    return () => window.clearTimeout(id)
  }, [captured, adjust])
  const base = developedLarge ?? developed

  // --- Giro y recorte sobre la foto revelada ---
  const rotated = useMemo(
    () => (base ? rotateCanvas(mirrored ? mirrorCanvas(base) : base, angle) : null),
    [base, angle, mirrored],
  )
  const imgAspect = rotated ? rotated.width / rotated.height : 1
  // Solo se genera la imagen del recorte cuando se esta usando, para no gastar en cada arrastre.
  const rotatedUrl = useMemo(
    () => (tool === 'crop' && rotated ? rotated.toDataURL('image/jpeg', 0.85) : null),
    [tool, rotated],
  )
  const resultUrl = useMemo(
    () => (tool !== 'crop' && rotated ? applySpots(cropCanvas(rotated, crop), spots).toDataURL('image/jpeg', 0.95) : null),
    [tool, rotated, crop, spots],
  )

  // Al girar 90 grados se reinicia el recorte (salvo que el cambio venga de un espejo, que ya lo ajusta).
  useEffect(() => {
    if (skipCropReset.current.quarter) {
      skipCropReset.current.quarter = false
      return
    }
    setCrop(ratio ? fitCrop(ratio, imgAspect) : FULL_CROP)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quarter])

  // Con proporcion fija, el recuadro se reajusta al cambiar la proporcion o enderezar.
  useEffect(() => {
    if (skipCropReset.current.ratio) {
      skipCropReset.current.ratio = false
      return
    }
    if (ratio) setCrop(fitCrop(ratio, imgAspect))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratioKey, fine])

  /**
   * Espejo segun lo que se ve en pantalla. Voltear la imagen ya girada equivale a voltearla antes de girar
   * y invertir el giro: horizontal -> angulo = -angulo; vertical -> angulo = 180 - angulo.
   * El recuadro de recorte tambien se refleja para que siga sobre la misma zona.
   */
  const flipScreen = (axis: 'h' | 'v') => {
    const nextQuarter = axis === 'h' ? (4 - quarter) % 4 : (6 - quarter) % 4
    const nextFine = fine === 0 ? 0 : -fine
    skipCropReset.current = { quarter: nextQuarter !== quarter, ratio: nextFine !== fine }
    setMirrored((m) => !m)
    setQuarter(nextQuarter)
    setFine(nextFine)
    setCrop((c) => (axis === 'h' ? { ...c, x: 1 - c.x - c.w } : { ...c, y: 1 - c.y - c.h }))
  }

  // Los retoques manuales dependen del encuadre: si cambia, se descartan.
  useEffect(() => {
    setSpots([])
  }, [crop, angle])

  const cropPixels = useMemo(() => {
    if (!captured || !rotated || !base) return null
    const scale = captured.full.width / base.width
    return { w: Math.round(crop.w * rotated.width * scale), h: Math.round(crop.h * rotated.height * scale) }
  }, [captured, rotated, crop, base])

  const finalCanvas = () => {
    if (!captured) throw new Error('No hay foto')
    const full = developNegative(captured.full, adjust)
    return applySpots(cropCanvas(rotateCanvas(mirrored ? mirrorCanvas(full) : full, angle), crop), spots)
  }

  const addSpot = (e: React.MouseEvent<HTMLImageElement>) => {
    if (tool !== 'retouch') return
    const rect = e.currentTarget.getBoundingClientRect()
    setSpots((list) => [
      ...list,
      { x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height, r: brush },
    ])
  }

  // Tamano de la imagen recortada, para dibujar los marcadores de retoque a su escala.
  const outW = rotated ? crop.w * rotated.width : 1
  const outH = rotated ? crop.h * rotated.height : 1
  const outSide = Math.max(outW, outH)

  // --- Captura ---
  const process = (source: CanvasImageSource, sw: number, sh: number) => {
    setProcessing(true)
    // Deja que React pinte "Procesando…" antes del calculo pesado.
    window.setTimeout(() => {
      try {
        const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh))
        const full = document.createElement('canvas')
        full.width = Math.round(sw * scale)
        full.height = Math.round(sh * scale)
        full.getContext('2d')?.drawImage(source, 0, 0, full.width, full.height)
        skipCropReset.current = { quarter: false, ratio: false }
        setMirrored(false)
        setQuarter(0)
        setFine(0)
        setRatioKey('free')
        setCrop(FULL_CROP)
        setSpots([])
        setAdjust(DEFAULT_ADJUST)
        setTool('exposure')
        setSaveError(null)
        setCaptured({ full, preview: scaled(full, PREVIEW_SIDE), large: scaled(full, LARGE_SIDE) })
        setStage('edit')
        stopCamera()
      } catch (e) {
        setCameraError((e as Error).message)
      } finally {
        setProcessing(false)
      }
    }, 30)
  }

  const capture = async () => {
    const video = videoRef.current
    if (!video?.videoWidth) return
    // La foto se toma del MISMO video que se ve en pantalla, no del modo de foto fija de la camara: ese modo
    // procesa la imagen distinto (otro brillo, color y encuadre) y la foto salia diferente a la vista previa.
    // La resolucion de 4K sobra, porque la foto se reduce a MAX_SIDE de todos modos.
    const track = streamRef.current?.getVideoTracks()[0]
    if (track) {
      setProcessing(true)
      // En la misma llamada se sube la resolucion y se bloquea la exposicion y el color (cada llamada
      // reemplaza a la anterior, y por separado una soltaria a la otra).
      await applyCameraSettings(track, {
        lock: true,
        extra: { width: { ideal: 3840 }, height: { ideal: 2160 } },
      })
      await new Promise((resolve) => window.setTimeout(resolve, 450))
    }
    process(video, video.videoWidth, video.videoHeight)
  }

  /** Bloquea o libera la exposicion y el balance de blancos desde el boton del candado. */
  const toggleLock = async () => {
    const track = streamRef.current?.getVideoTracks()[0]
    if (!track) return
    const ok = await applyCameraSettings(track, { lock: !locked })
    if (ok) {
      setLocked(!locked)
      setToast(locked ? 'Exposición y color en automático' : '🔒 Exposición y color bloqueados')
    } else {
      setToast('Este dispositivo o navegador no permite bloquear la exposición')
    }
  }

  // Espacio o Enter disparan la foto (teclado, o control remoto Bluetooth que envie esas teclas).
  const captureRef = useRef(capture)
  captureRef.current = capture
  useEffect(() => {
    if (stage !== 'camera' || cameraError || processing) return
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || (e.key !== ' ' && e.key !== 'Enter')) return
      e.preventDefault()
      captureRef.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [stage, cameraError, processing])

  const onFile = async (file: File | undefined) => {
    if (!file) return
    const bitmap = await createImageBitmap(file)
    process(bitmap, bitmap.width, bitmap.height)
  }

  // --- Guardar y pasar solo a la foto siguiente ---
  const save = async () => {
    const token = getAdminToken()
    if (!token) return
    setSaving(true)
    setSaveError(null)
    try {
      const blob = await toBlob(finalCanvas())
      // La sala se busca por nombre en cada guardado; si no existe, se crea.
      const rooms = await fetchRooms()
      const room =
        rooms.find((r) => normalizeName(r.name) === normalizeName(STAGING_ROOM)) ??
        (await createRoom(STAGING_ROOM, token))
      await uploadPhoto(room.id, new File([blob], `negativo-revelado-${Date.now()}.jpg`, { type: 'image/jpeg' }), token)
      setToast(`✓ Foto guardada en «${room.name}». Lista para la siguiente.`)
      // Vuelve directo a la camara para tomar la siguiente foto.
      setCaptured(null)
      setStage('camera')
      startCamera()
    } catch (e) {
      const message = (e as Error).message
      if (message === 'No autorizado') clearAdminToken()
      setSaveError(message)
    } finally {
      setSaving(false)
    }
  }

  // --- Interfaz ---
  if (stage === 'camera') {
    return (
      <div className="cam-full" role="dialog" aria-modal="true" aria-label="Revelar negativo">
        <video ref={videoRef} className="cam-video" playsInline muted />
        <canvas ref={livePreviewRef} className={`cam-video cam-live${liveOn ? '' : ' hidden'}`} />

        <div className="cam-top">
          <button className="cam-icon" aria-label="Cerrar" onClick={onClose}>✕</button>
          <p className={cameraError ? 'cam-hint light-dark' : `cam-hint light-${light}`}>
            {cameraError ?? LIGHT_MESSAGES[light]}
          </p>
          <button
            className={`cam-icon${locked ? ' cam-icon-on' : ''}`}
            aria-label={locked ? 'Liberar exposición y color' : 'Bloquear exposición y color'}
            aria-pressed={locked}
            title={locked ? 'Liberar exposición y color' : 'Bloquear exposición y color'}
            onClick={toggleLock}
            disabled={Boolean(cameraError)}
          >
            {locked ? '🔒' : '🔓'}
          </button>
        </div>

        {toast && <div className="cam-toast">{toast}</div>}
        {!cameraError && <div className="cam-badge">{liveOn ? 'Así quedará revelada' : 'Negativo sin revelar'}</div>}

        <div className="cam-bottom">
          <label className="cam-icon cam-file" aria-label="Elegir archivo" title="Elegir archivo">
            🖼
            <input type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
          <button
            className="shutter"
            aria-label="Capturar foto"
            onClick={capture}
            disabled={Boolean(cameraError) || processing}
          />
          <button
            className={`cam-icon${liveOn ? ' cam-icon-on' : ''}`}
            aria-label={liveOn ? 'Ver el negativo sin revelar' : 'Ver cómo quedará revelada'}
            aria-pressed={liveOn}
            title={liveOn ? 'Ver el negativo sin revelar' : 'Ver cómo quedará revelada'}
            onClick={() => setLiveOn((v) => !v)}
          >
            👁
          </button>
        </div>

        {processing && <div className="camera-overlay">Procesando…</div>}
      </div>
    )
  }

  const sliderTool = SLIDER_TOOLS.find((t) => t.id === tool)
  const isChanged = (t: SliderTool) => adjust[t.id] !== DEFAULT_ADJUST[t.id]

  return (
    <div className="editor" role="dialog" aria-modal="true" aria-label="Revelar negativo">
      <div className="editor-head">
        <button className="btn" onClick={onClose}>Cerrar</button>
        <strong>Revelar negativo</strong>
        <span className="editor-head-spacer" />
      </div>

      <div className="editor-photo">
        {tool === 'crop' && rotatedUrl ? (
          <Cropper src={rotatedUrl} imgAspect={imgAspect} ratio={ratio} crop={crop} onChange={setCrop} />
        ) : resultUrl ? (
          <div className={`result-wrap${tool === 'retouch' ? ' retouching' : ''}`}>
            <img src={resultUrl} alt="Foto revelada a color" onClick={addSpot} draggable={false} />
            {tool === 'retouch' &&
              spots.map((s, i) => (
                <span
                  key={i}
                  className="spot-mark"
                  style={{
                    left: `${s.x * 100}%`,
                    top: `${s.y * 100}%`,
                    width: `${((2 * s.r * outSide) / outW) * 100}%`,
                    height: `${((2 * s.r * outSide) / outH) * 100}%`,
                  }}
                />
              ))}
          </div>
        ) : (
          <div className="compare-wait">Revelando…</div>
        )}
      </div>

      <div className="editor-controls">
        {/* Barra de la herramienta elegida */}
        <div className="tool-panel">
          {sliderTool && (
            <>
              <div className="tool-panel-head">
                <span>{sliderTool.label}</span>
                <strong>{displayValue(sliderTool, adjust[sliderTool.id])}</strong>
                <button
                  className="link-btn"
                  disabled={!isChanged(sliderTool)}
                  onClick={() => setAdjust((a) => ({ ...a, [sliderTool.id]: DEFAULT_ADJUST[sliderTool.id] }))}
                >
                  Restablecer
                </button>
              </div>
              <input
                type="range"
                className="tool-slider"
                min={sliderTool.min}
                max={sliderTool.max}
                step={sliderTool.step}
                value={adjust[sliderTool.id]}
                onChange={(e) => setAdjust((a) => ({ ...a, [sliderTool.id]: Number(e.target.value) }))}
              />
            </>
          )}

          {tool === 'crop' && (
            <div className="crop-panel">
              <div className="chips">
                <button className="btn" onClick={() => setQuarter((q) => (q + 3) % 4)}>⟲ 90°</button>
                <button className="btn" onClick={() => setQuarter((q) => (q + 1) % 4)}>⟳ 90°</button>
                {RATIOS.map((r) => (
                  <button key={r.key} className={`btn${ratioKey === r.key ? ' primary' : ''}`} onClick={() => setRatioKey(r.key)}>
                    {r.label}
                  </button>
                ))}
                <button
                  className="link-btn"
                  onClick={() => {
                    skipCropReset.current = { quarter: false, ratio: false }
                    setMirrored(false)
                    setQuarter(0)
                    setFine(0)
                    setRatioKey('free')
                    setCrop(FULL_CROP)
                  }}
                >
                  Restablecer
                </button>
              </div>
              <label className="slider">
                <span>Enderezar ({fine > 0 ? '+' : ''}{fine.toFixed(1)}°)</span>
                <input type="range" min={-45} max={45} step={0.5} value={fine} onChange={(e) => setFine(Number(e.target.value))} />
              </label>
              {cropPixels && (
                <p className={cropPixels.w < LOW_RES_WIDTH ? 'light-hint light-flat' : 'hint'}>
                  Resolución: {cropPixels.w} × {cropPixels.h} px
                  {cropPixels.w < LOW_RES_WIDTH && ' — baja: acerca más la cámara al negativo.'}
                </p>
              )}
            </div>
          )}

          {tool === 'mirror' && (
            <div className="crop-panel">
              <div className="chips">
                <button className="btn" onClick={() => flipScreen('h')}>↔ Espejo horizontal</button>
                <button className="btn" onClick={() => flipScreen('v')}>↕ Espejo vertical</button>
              </div>
              <p className="hint">
                Voltea la foto como en un espejo: horizontal cambia izquierda por derecha; vertical cambia arriba por abajo.
                Toca de nuevo para deshacerlo.
              </p>
            </div>
          )}

          {tool === 'retouch' && (
            <div className="crop-panel">
              <p className="hint">Toca cada mancha o rayón de la foto para borrarlo.</p>
              <label className="slider">
                <span>Tamaño del pincel</span>
                <input type="range" min={0.004} max={0.04} step={0.002} value={brush} onChange={(e) => setBrush(Number(e.target.value))} />
              </label>
              <div className="chips">
                <button className="btn" disabled={spots.length === 0} onClick={() => setSpots((l) => l.slice(0, -1))}>Deshacer</button>
                <button className="btn" disabled={spots.length === 0} onClick={() => setSpots([])}>
                  Quitar todos ({spots.length})
                </button>
              </div>
            </div>
          )}
        </div>

        {/* Fila de herramientas: se desliza de lado a lado; al tocar una, se abre su barra */}
        <div className="tool-row" role="tablist" aria-label="Herramientas">
          <button
            className="tool"
            onClick={() => captured && setAdjust(autoAdjust(captured.preview))}
          >
            <span className="tool-icon">✨</span>
            <span>Auto</span>
          </button>
          <button
            className={`tool${tool === 'crop' ? ' active' : ''}${angle !== 0 || crop !== FULL_CROP ? ' changed' : ''}`}
            role="tab"
            aria-selected={tool === 'crop'}
            onClick={() => setTool('crop')}
          >
            <span className="tool-icon">✂️</span>
            <span>Recortar</span>
          </button>
          <button
            className={`tool${tool === 'mirror' ? ' active' : ''}${mirrored ? ' changed' : ''}`}
            role="tab"
            aria-selected={tool === 'mirror'}
            onClick={() => setTool('mirror')}
          >
            <span className="tool-icon">🪞</span>
            <span>Espejo</span>
          </button>
          {SLIDER_TOOLS.map((t) => (
            <button
              key={t.id}
              className={`tool${tool === t.id ? ' active' : ''}${isChanged(t) ? ' changed' : ''}`}
              role="tab"
              aria-selected={tool === t.id}
              onClick={() => setTool(t.id)}
            >
              <span className="tool-icon">{t.icon}</span>
              <span>{t.label}</span>
            </button>
          ))}
          <button
            className={`tool${tool === 'retouch' ? ' active' : ''}${spots.length > 0 ? ' changed' : ''}`}
            role="tab"
            aria-selected={tool === 'retouch'}
            onClick={() => setTool('retouch')}
          >
            <span className="tool-icon">🩹</span>
            <span>Retocar</span>
          </button>
        </div>

        {/* Las fotos reveladas siempre van a la sala de revelado; desde ahi se pasan a otra sala */}
        <div className="save-line">
          <span className="save-target">Se guardará en «{STAGING_ROOM}»</span>
          <button className="btn primary" onClick={save} disabled={saving || !developed}>
            {saving ? 'Guardando…' : 'Guardar en Drive'}
          </button>
        </div>
        {saveError && <p className="message error save-error">{saveError}</p>}
      </div>
    </div>
  )
}
