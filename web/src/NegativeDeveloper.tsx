import { useEffect, useRef, useState } from 'react'
import { analyzeLight, developNegative, guideRect, type LightState } from './develop'

interface Props {
  onClose: () => void
}

const LIGHT_MESSAGES: Record<LightState, string> = {
  dark: 'Muy oscuro: pon una pantalla blanca o una caja de luz detrás del negativo.',
  bright: 'Demasiada luz: baja el brillo de la pantalla o aleja un poco la cámara.',
  flat: 'No se distingue la imagen: acerca la cámara hasta que el negativo llene el recuadro.',
  good: 'Luz correcta. Mantén quieto el celular y pulsa «Capturar».',
}

const MAX_SIDE = 2000

export default function NegativeDeveloper({ onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const [aspect, setAspect] = useState(4 / 3)
  const [guide, setGuide] = useState({ left: 8, top: 8, width: 84, height: 84 })
  const [light, setLight] = useState<LightState>('dark')
  const [cameraError, setCameraError] = useState<string | null>(null)
  const [result, setResult] = useState<{ negative: string; positive: string } | null>(null)
  const [processing, setProcessing] = useState(false)

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
    if (result || cameraError) return
    const id = window.setInterval(() => {
      const video = videoRef.current
      if (video && video.videoWidth) setLight(analyzeLight(video))
    }, 500)
    return () => window.clearInterval(id)
  }, [result, cameraError])

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
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(sw * scale)
        canvas.height = Math.round(sh * scale)
        canvas.getContext('2d')?.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height)
        const positive = developNegative(canvas)
        setResult({ negative: canvas.toDataURL('image/jpeg', 0.9), positive: positive.toDataURL('image/jpeg', 0.92) })
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
    setResult(null)
    startCamera()
  }

  const download = () => {
    if (!result) return
    const a = document.createElement('a')
    a.href = result.positive
    a.download = `foto-revelada-${Date.now()}.jpg`
    a.click()
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Revelar negativo">
      <div className="modal-head">
        <h2>Revelar negativo</h2>
        <button className="btn" onClick={onClose}>Cerrar</button>
      </div>

      {!result && (
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

      {result && (
        <div className="modal-body">
          <div className="compare">
            <figure>
              <img src={result.negative} alt="Negativo capturado" />
              <figcaption>Negativo</figcaption>
            </figure>
            <figure>
              <img src={result.positive} alt="Foto revelada a color" />
              <figcaption>Revelada</figcaption>
            </figure>
          </div>
          <div className="modal-actions">
            <button className="btn" onClick={retake}>Tomar otra</button>
            <button className="btn primary" onClick={download}>Descargar foto</button>
          </div>
        </div>
      )}
    </div>
  )
}
