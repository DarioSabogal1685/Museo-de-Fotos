import { useEffect, useMemo, useRef, useState } from 'react'
import { clearAdminToken, fetchRooms, getAdminToken, uploadPhoto, type Room } from './api'
import Cropper, { fitCrop, type Crop } from './Cropper'
import {
  analyzeLight,
  cropCanvas,
  DEFAULT_ADJUST,
  developNegative,
  rotateCanvas,
  type Adjust,
  type LightState,
} from './develop'

interface Props {
  defaultRoomId?: string
  onClose: () => void
}

type Stage = 'camera' | 'crop' | 'adjust'

const LIGHT_MESSAGES: Record<LightState, string> = {
  dark: 'Muy oscuro: pon una pantalla blanca o una caja de luz detrás del negativo.',
  bright: 'Demasiada luz: baja el brillo de la pantalla o aleja un poco la cámara.',
  flat: 'No se distingue la imagen: acerca la cámara hasta ver bien el negativo.',
  good: 'Luz correcta. Mantén quieto el celular y pulsa «Capturar».',
}

const MAX_SIDE = 3200
const PREVIEW_SIDE = 1000
const FULL_CROP: Crop = { x: 0, y: 0, w: 1, h: 1 }
const LOW_RES_WIDTH = 1200

const RATIOS: { key: string; label: string; value: number | null }[] = [
  { key: 'free', label: 'Libre', value: null },
  { key: '1:1', label: '1:1', value: 1 },
  { key: '3:2', label: '3:2', value: 3 / 2 },
  { key: '4:3', label: '4:3', value: 4 / 3 },
  { key: '16:9', label: '16:9', value: 16 / 9 },
]

const SLIDERS: { key: keyof Adjust; label: string; min: number; max: number; step: number }[] = [
  { key: 'exposure', label: 'Brillo', min: -1, max: 1, step: 0.05 },
  { key: 'contrast', label: 'Contraste', min: 0, max: 2, step: 0.05 },
  { key: 'warmth', label: 'Frío ↔ Cálido', min: -1, max: 1, step: 0.05 },
  { key: 'saturation', label: 'Color', min: 0, max: 2, step: 0.05 },
]

interface ImageCaptureLike {
  takePhoto(): Promise<Blob>
}
type ImageCaptureCtor = new (track: MediaStreamTrack) => ImageCaptureLike

interface Captured {
  full: HTMLCanvasElement
  preview: HTMLCanvasElement
}

function scaled(source: HTMLCanvasElement, maxSide: number): HTMLCanvasElement {
  const scale = Math.min(1, maxSide / Math.max(source.width, source.height))
  const canvas = document.createElement('canvas')
  canvas.width = Math.round(source.width * scale)
  canvas.height = Math.round(source.height * scale)
  canvas.getContext('2d')?.drawImage(source, 0, 0, canvas.width, canvas.height)
  return canvas
}

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('No se pudo crear la imagen'))), 'image/jpeg', 0.93),
  )

export default function NegativeDeveloper({ defaultRoomId, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [stage, setStage] = useState<Stage>('camera')
  const [aspect, setAspect] = useState(16 / 9)
  const [light, setLight] = useState<LightState>('dark')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)

  const [captured, setCaptured] = useState<Captured | null>(null)
  const [quarter, setQuarter] = useState(0)
  const [fine, setFine] = useState(0)
  const [ratioKey, setRatioKey] = useState('free')
  const [crop, setCrop] = useState<Crop>(FULL_CROP)

  const [adjust, setAdjust] = useState<Adjust>(DEFAULT_ADJUST)
  const [positiveUrl, setPositiveUrl] = useState<string | null>(null)

  const [rooms, setRooms] = useState<Room[]>([])
  const [roomId, setRoomId] = useState(defaultRoomId ?? '')
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; text: string } | null>(null)

  const angle = quarter * 90 + fine
  const ratio = RATIOS.find((r) => r.key === ratioKey)?.value ?? null

  useEffect(() => {
    fetchRooms()
      .then((list) => {
        setRooms(list)
        setRoomId((current) => current || list[0]?.id || '')
      })
      .catch(() => setRooms([]))
  }, [])

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((t) => t.stop())
    streamRef.current = null
  }

  const startCamera = async () => {
    setCameraError(null)
    if (!navigator.mediaDevices?.getUserMedia) {
      setCameraError('Este navegador no permite usar la cámara aquí. Puedes elegir una foto del negativo desde tus archivos.')
      return
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } },
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

  // --- Geometria: rotacion y recorte ---
  const rotatedPreview = useMemo(
    () => (captured ? rotateCanvas(captured.preview, angle) : null),
    [captured, angle],
  )
  const rotatedUrl = useMemo(() => rotatedPreview?.toDataURL('image/jpeg', 0.85) ?? null, [rotatedPreview])
  const imgAspect = rotatedPreview ? rotatedPreview.width / rotatedPreview.height : 1

  // Al girar 90 grados se reinicia el recorte.
  useEffect(() => {
    setCrop(ratio ? fitCrop(ratio, imgAspect) : FULL_CROP)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quarter])

  // Con proporcion fija, el recuadro se reajusta al cambiar la proporcion o enderezar.
  useEffect(() => {
    if (ratio) setCrop(fitCrop(ratio, imgAspect))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratioKey, fine])

  // Resolucion estimada del recorte final.
  const cropPixels = useMemo(() => {
    if (!captured || !rotatedPreview) return null
    const scale = captured.full.width / captured.preview.width
    return {
      w: Math.round(crop.w * rotatedPreview.width * scale),
      h: Math.round(crop.h * rotatedPreview.height * scale),
    }
  }, [captured, rotatedPreview, crop])

  // --- Revelado (vista previa) ---
  useEffect(() => {
    if (stage !== 'adjust' || !rotatedPreview) return
    const id = window.setTimeout(() => {
      const cropped = cropCanvas(rotatedPreview, crop)
      setPositiveUrl(developNegative(cropped, adjust).toDataURL('image/jpeg', 0.9))
    }, 40)
    return () => window.clearTimeout(id)
  }, [stage, rotatedPreview, crop, adjust])

  const finalCanvas = () => {
    if (!captured) throw new Error('No hay foto')
    const rotated = rotateCanvas(captured.full, angle)
    return developNegative(cropCanvas(rotated, crop), adjust)
  }

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
        setQuarter(0)
        setFine(0)
        setRatioKey('free')
        setCrop(FULL_CROP)
        setAdjust(DEFAULT_ADJUST)
        setSaveStatus(null)
        setCaptured({ full, preview: scaled(full, PREVIEW_SIDE) })
        setStage('crop')
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
    // Si el navegador lo permite, se toma una foto a resolucion completa del sensor.
    const IC = (window as unknown as { ImageCapture?: ImageCaptureCtor }).ImageCapture
    const track = streamRef.current?.getVideoTracks()[0]
    if (IC && track) {
      try {
        setProcessing(true)
        const bitmap = await createImageBitmap(await new IC(track).takePhoto())
        process(bitmap, bitmap.width, bitmap.height)
        return
      } catch {
        /* se usa el cuadro de video */
      }
    }
    process(video, video.videoWidth, video.videoHeight)
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    const bitmap = await createImageBitmap(file)
    process(bitmap, bitmap.width, bitmap.height)
  }

  const retake = () => {
    setCaptured(null)
    setPositiveUrl(null)
    setStage('camera')
    startCamera()
  }

  // --- Salidas ---
  const fileName = (prefix: string) => `${prefix}-${Date.now()}.jpg`

  const download = async () => {
    const blob = await toBlob(finalCanvas())
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = fileName('foto-revelada')
    a.click()
    URL.revokeObjectURL(url)
  }

  const save = async () => {
    if (!roomId) return
    const token = getAdminToken()
    if (!token) return
    setSaving(true)
    setSaveStatus(null)
    try {
      const blob = await toBlob(finalCanvas())
      await uploadPhoto(roomId, new File([blob], fileName('negativo-revelado'), { type: 'image/jpeg' }), token)
      const roomName = rooms.find((r) => r.id === roomId)?.name ?? 'el cuarto'
      setSaveStatus({ ok: true, text: `Foto guardada en «${roomName}».` })
    } catch (e) {
      const message = (e as Error).message
      if (message === 'No autorizado') clearAdminToken()
      setSaveStatus({ ok: false, text: message })
    } finally {
      setSaving(false)
    }
  }

  const shareWhatsApp = async () => {
    setSaveStatus(null)
    try {
      const blob = await toBlob(finalCanvas())
      const file = new File([blob], fileName('foto-revelada'), { type: 'image/jpeg' })
      const text = 'Mira esta foto revelada en el Museo de Fotos'
      if (navigator.canShare?.({ files: [file] })) {
        await navigator.share({ files: [file], text })
        return
      }
      // Sin compartir archivos: se descarga la foto y se abre WhatsApp para adjuntarla.
      await download()
      window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener')
      setSaveStatus({ ok: true, text: 'La foto se descargó. Adjúntala en la conversación de WhatsApp que se abrió.' })
    } catch (e) {
      if ((e as Error).name !== 'AbortError') setSaveStatus({ ok: false, text: (e as Error).message })
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Revelar negativo">
      <div className="modal-head">
        <h2>Revelar negativo</h2>
        <button className="btn" onClick={onClose}>Cerrar</button>
      </div>

      {stage === 'camera' && (
        <div className="modal-body">
          <div className="camera" style={{ aspectRatio: aspect }}>
            <video
              ref={videoRef}
              playsInline
              muted
              onLoadedMetadata={(e) => {
                const v = e.currentTarget
                if (v.videoWidth) setAspect(v.videoWidth / v.videoHeight)
              }}
            />
            {processing && <div className="camera-overlay">Procesando…</div>}
          </div>

          {cameraError ? (
            <p className="message error">{cameraError}</p>
          ) : (
            <p className={`light-hint light-${light}`}>{LIGHT_MESSAGES[light]}</p>
          )}

          <ol className="tips">
            <li>Coloca el negativo sobre una pantalla blanca o una caja de luz.</li>
            <li>Acércate lo más posible: cuanto más grande se vea el negativo, más nítida queda la foto.</li>
            <li>Apaga las otras luces del cuarto para evitar reflejos. Luego podrás recortar y girar.</li>
          </ol>

          <div className="modal-actions">
            <label className="btn">
              Elegir archivo
              <input type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <button className="btn primary" onClick={capture} disabled={Boolean(cameraError) || processing}>
              Capturar
            </button>
          </div>
        </div>
      )}

      {stage === 'crop' && rotatedUrl && (
        <div className="modal-body">
          <p className="step-title">1. Recorta y endereza el negativo</p>

          <div className="crop-stage">
            <Cropper src={rotatedUrl} imgAspect={imgAspect} ratio={ratio} crop={crop} onChange={setCrop} />
          </div>

          <div className="adjust-box">
            <div className="chips">
              <button className="btn" onClick={() => setQuarter((q) => (q + 3) % 4)}>⟲ 90°</button>
              <button className="btn" onClick={() => setQuarter((q) => (q + 1) % 4)}>⟳ 90°</button>
              <button
                className="btn"
                onClick={() => {
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

            <div className="chips">
              {RATIOS.map((r) => (
                <button
                  key={r.key}
                  className={`btn${ratioKey === r.key ? ' primary' : ''}`}
                  onClick={() => setRatioKey(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          {cropPixels && (
            <p className={cropPixels.w < LOW_RES_WIDTH ? 'light-hint light-flat' : 'hint'}>
              Resolución del recorte: {cropPixels.w} × {cropPixels.h} px
              {cropPixels.w < LOW_RES_WIDTH && ' — baja: acerca más la cámara al negativo para ganar nitidez.'}
            </p>
          )}

          <div className="modal-actions">
            <button className="btn" onClick={retake}>Tomar otra</button>
            <button className="btn primary" onClick={() => setStage('adjust')}>Revelar →</button>
          </div>
        </div>
      )}

      {stage === 'adjust' && (
        <div className="modal-body">
          <p className="step-title">2. Ajusta la foto revelada</p>

          <div className="result-stage">
            {positiveUrl ? <img src={positiveUrl} alt="Foto revelada a color" /> : <div className="compare-wait">Revelando…</div>}
          </div>

          <div className="adjust-box">
            {SLIDERS.map((s) => (
              <label key={s.key} className="slider">
                <span>{s.label}</span>
                <input
                  type="range"
                  min={s.min}
                  max={s.max}
                  step={s.step}
                  value={adjust[s.key]}
                  onChange={(e) => setAdjust((a) => ({ ...a, [s.key]: Number(e.target.value) }))}
                />
              </label>
            ))}
            <button className="btn" onClick={() => setAdjust(DEFAULT_ADJUST)}>Restablecer ajustes</button>
          </div>

          <div className="save-box">
            <label htmlFor="room-select">¿En qué cuarto la quieres guardar?</label>
            <select
              id="room-select"
              value={roomId}
              onChange={(e) => {
                setRoomId(e.target.value)
                setSaveStatus(null)
              }}
              disabled={saving || rooms.length === 0}
            >
              {rooms.length === 0 && <option value="">No hay cuartos disponibles</option>}
              {rooms.map((r) => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
            <button className="btn primary" onClick={save} disabled={saving || !roomId || saveStatus?.ok}>
              {saving ? 'Guardando…' : 'Guardar en Drive'}
            </button>
            <button className="btn whatsapp" onClick={shareWhatsApp}>Enviar por WhatsApp</button>
            {saveStatus && (
              <p className={saveStatus.ok ? 'light-hint light-good' : 'message error'}>{saveStatus.text}</p>
            )}
          </div>

          <div className="modal-actions">
            <button className="btn" onClick={() => setStage('crop')}>← Recortar</button>
            <button className="btn" onClick={download}>Descargar foto</button>
            <button className="btn" onClick={retake}>Tomar otra</button>
          </div>
        </div>
      )}
    </div>
  )
}
