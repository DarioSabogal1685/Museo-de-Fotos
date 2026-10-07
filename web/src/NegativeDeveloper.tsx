import { useEffect, useRef, useState } from 'react'
import { clearAdminToken, fetchRooms, getAdminToken, uploadPhoto, type Room } from './api'
import {
  analyzeLight,
  DEFAULT_ADJUST,
  developNegative,
  guideRect,
  type Adjust,
  type LightState,
} from './develop'

interface Props {
  defaultRoomId?: string
  onClose: () => void
}

const LIGHT_MESSAGES: Record<LightState, string> = {
  dark: 'Muy oscuro: pon una pantalla blanca o una caja de luz detrás del negativo.',
  bright: 'Demasiada luz: baja el brillo de la pantalla o aleja un poco la cámara.',
  flat: 'No se distingue la imagen: acerca la cámara hasta que el negativo llene el recuadro.',
  good: 'Luz correcta. Mantén quieto el celular y pulsa «Capturar».',
}

const MAX_SIDE = 2400
const PREVIEW_SIDE = 900

interface Captured {
  full: HTMLCanvasElement
  preview: HTMLCanvasElement
  negativeUrl: string
}

const SLIDERS: { key: keyof Adjust; label: string; min: number; max: number; step: number }[] = [
  { key: 'exposure', label: 'Brillo', min: -1, max: 1, step: 0.05 },
  { key: 'contrast', label: 'Contraste', min: 0, max: 2, step: 0.05 },
  { key: 'warmth', label: 'Frío ↔ Cálido', min: -1, max: 1, step: 0.05 },
  { key: 'saturation', label: 'Color', min: 0, max: 2, step: 0.05 },
]

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
  const [aspect, setAspect] = useState(4 / 3)
  const [guide, setGuide] = useState({ left: 8, top: 8, width: 84, height: 84 })
  const [light, setLight] = useState<LightState>('dark')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [captured, setCaptured] = useState<Captured | null>(null)
  const [adjust, setAdjust] = useState<Adjust>(DEFAULT_ADJUST)
  const [positiveUrl, setPositiveUrl] = useState<string | null>(null)
  const [processing, setProcessing] = useState(false)
  const [rooms, setRooms] = useState<Room[]>([])
  const [roomId, setRoomId] = useState(defaultRoomId ?? '')
  const [saving, setSaving] = useState(false)
  const [saveStatus, setSaveStatus] = useState<{ ok: boolean; text: string } | null>(null)

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
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      })
      streamRef.current = stream
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

  // Revisa la luz del recuadro mientras la camara esta activa.
  useEffect(() => {
    if (captured || cameraError) return
    const id = window.setInterval(() => {
      const video = videoRef.current
      if (video && video.videoWidth) setLight(analyzeLight(video))
    }, 500)
    return () => window.clearInterval(id)
  }, [captured, cameraError])

  // Re-revela la vista previa cada vez que cambia un ajuste.
  useEffect(() => {
    if (!captured) {
      setPositiveUrl(null)
      return
    }
    const id = window.setTimeout(() => {
      setPositiveUrl(developNegative(captured.preview, adjust).toDataURL('image/jpeg', 0.9))
    }, 40)
    return () => window.clearTimeout(id)
  }, [captured, adjust])

  const onMetadata = () => {
    const video = videoRef.current
    if (!video?.videoWidth) return
    const { videoWidth: vw, videoHeight: vh } = video
    const r = guideRect(vw, vh)
    setAspect(vw / vh)
    setGuide({
      left: (r.x / vw) * 100,
      top: (r.y / vh) * 100,
      width: (r.w / vw) * 100,
      height: (r.h / vh) * 100,
    })
  }

  const process = (source: CanvasImageSource, sx: number, sy: number, sw: number, sh: number) => {
    setProcessing(true)
    // Deja que React pinte "Revelando…" antes del calculo pesado.
    window.setTimeout(() => {
      try {
        const scale = Math.min(1, MAX_SIDE / Math.max(sw, sh))
        const full = document.createElement('canvas')
        full.width = Math.round(sw * scale)
        full.height = Math.round(sh * scale)
        full.getContext('2d')?.drawImage(source, sx, sy, sw, sh, 0, 0, full.width, full.height)
        const preview = scaled(full, PREVIEW_SIDE)
        setAdjust(DEFAULT_ADJUST)
        setCaptured({ full, preview, negativeUrl: preview.toDataURL('image/jpeg', 0.85) })
        stopCamera()
      } catch (e) {
        setCameraError((e as Error).message)
      } finally {
        setProcessing(false)
      }
    }, 30)
  }

  const capture = () => {
    const video = videoRef.current
    if (!video?.videoWidth) return
    const r = guideRect(video.videoWidth, video.videoHeight)
    process(video, r.x, r.y, r.w, r.h)
  }

  const onFile = async (file: File | undefined) => {
    if (!file) return
    const bitmap = await createImageBitmap(file)
    process(bitmap, 0, 0, bitmap.width, bitmap.height)
  }

  const retake = () => {
    setCaptured(null)
    setSaveStatus(null)
    startCamera()
  }

  const download = async () => {
    if (!captured) return
    const blob = await toBlob(developNegative(captured.full, adjust))
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `foto-revelada-${Date.now()}.jpg`
    a.click()
    URL.revokeObjectURL(url)
  }

  const save = async () => {
    if (!captured || !roomId) return
    const token = getAdminToken()
    if (!token) return
    setSaving(true)
    setSaveStatus(null)
    try {
      const blob = await toBlob(developNegative(captured.full, adjust))
      const file = new File([blob], `negativo-revelado-${Date.now()}.jpg`, { type: 'image/jpeg' })
      await uploadPhoto(roomId, file, token)
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

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Revelar negativo">
      <div className="modal-head">
        <h2>Revelar negativo</h2>
        <button className="btn" onClick={onClose}>Cerrar</button>
      </div>

      {!captured && (
        <div className="modal-body">
          <div className="camera" style={{ aspectRatio: aspect }}>
            <video ref={videoRef} playsInline muted onLoadedMetadata={onMetadata} />
            {!cameraError && (
              <div
                className={`guide guide-${light}`}
                style={{
                  left: `${guide.left}%`,
                  top: `${guide.top}%`,
                  width: `${guide.width}%`,
                  height: `${guide.height}%`,
                }}
              >
                <span className="corner tl" /><span className="corner tr" />
                <span className="corner bl" /><span className="corner br" />
              </div>
            )}
            {processing && <div className="camera-overlay">Revelando…</div>}
          </div>

          {cameraError ? (
            <p className="message error">{cameraError}</p>
          ) : (
            <p className={`light-hint light-${light}`}>{LIGHT_MESSAGES[light]}</p>
          )}

          <ol className="tips">
            <li>Coloca el negativo sobre una pantalla blanca o una caja de luz.</li>
            <li>Que el negativo llene el recuadro y quede recto, sin reflejos.</li>
            <li>Apaga las otras luces del cuarto para evitar brillos.</li>
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

      {captured && (
        <div className="modal-body">
          <div className="compare">
            <figure>
              <img src={captured.negativeUrl} alt="Negativo capturado" />
              <figcaption>Negativo</figcaption>
            </figure>
            <figure>
              {positiveUrl ? <img src={positiveUrl} alt="Foto revelada a color" /> : <div className="compare-wait">Revelando…</div>}
              <figcaption>Revelada</figcaption>
            </figure>
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
            {saveStatus && (
              <p className={saveStatus.ok ? 'light-hint light-good' : 'message error'}>{saveStatus.text}</p>
            )}
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={retake}>Tomar otra</button>
            <button className="btn" onClick={download}>Descargar foto</button>
          </div>
        </div>
      )}
    </div>
  )
}
