import { useEffect, useMemo, useRef, useState } from 'react'
import {
  clearAdminToken,
  fetchPhotoBlob,
  fetchTagSuggestions,
  getAdminToken,
  replacePhoto,
  updatePhotoMeta,
  uploadPhoto,
  type Photo,
  type PhotoTags,
  type PersonTag,
  type TagSuggestions,
} from './api'
import Cropper, { fitCrop, type Crop } from './Cropper'
import { autoAdjust, cropCanvas, developNegative, rotateCanvas, type Adjust } from './develop'
import { FULL_CROP, PREVIEW_SIDE, RATIOS, SLIDERS, scaled, toBlob } from './NegativeDeveloper'

interface Props {
  photo: Photo
  roomId: string
  onClose: () => void
  /** Se llama cuando la foto original cambio (nombre o imagen). */
  onUpdated: (photo: Photo) => void
  /** Se llama cuando se guardo una copia como foto nueva. */
  onCreated: (photo: Photo) => void
}

// Ajustes neutros: al abrir, la foto se ve igual que el original.
const NEUTRAL: Adjust = {
  exposure: 0, contrast: 1, warmth: 0, saturation: 1,
  noiseLuma: 0, noiseColor: 0, sharpness: 0, shadows: 0, highlights: 0, dust: 0,
}
const EDIT_MAX_SIDE = 4096

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('No se pudo abrir la imagen'))
    img.src = url
  })
}

const withExtension = (name: string) => (/\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.jpg`)

export default function PhotoEditor({ photo, roomId, onClose, onUpdated, onCreated }: Props) {
  const [stage, setStage] = useState<'crop' | 'adjust'>('crop')
  const [full, setFull] = useState<HTMLCanvasElement | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  const [quarter, setQuarter] = useState(0)
  const [fine, setFine] = useState(0)
  const [ratioKey, setRatioKey] = useState('free')
  const [crop, setCrop] = useState<Crop>(FULL_CROP)
  const [adjust, setAdjust] = useState<Adjust>(NEUTRAL)
  const [positiveUrl, setPositiveUrl] = useState<string | null>(null)

  const [name, setName] = useState(photo.name)

  // Etiquetas: personas marcadas con un punto sobre la foto y lugar.
  const [people, setPeople] = useState<PersonTag[]>(photo.tags?.people ?? [])
  const [place, setPlace] = useState(photo.tags?.place ?? '')
  const [savedTags, setSavedTags] = useState<PhotoTags>(photo.tags ?? { people: [] })
  const [tagMode, setTagMode] = useState(false)
  const [suggestions, setSuggestions] = useState<TagSuggestions>({ people: [], places: [] })
  const [notice, setNotice] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  const angle = quarter * 90 + fine
  const ratio = RATIOS.find((r) => r.key === ratioKey)?.value ?? null

  // Descarga la foto completa y la dibuja en un canvas.
  useEffect(() => {
    let url: string | null = null
    let cancelled = false
    fetchPhotoBlob(photo.id, photo.modifiedTime)
      .then(async (blob) => {
        url = URL.createObjectURL(blob)
        const img = await loadImage(url)
        if (cancelled) return
        const scale = Math.min(1, EDIT_MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.naturalWidth * scale)
        canvas.height = Math.round(img.naturalHeight * scale)
        canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height)
        setFull(canvas)
      })
      .catch((e: Error) => !cancelled && setLoadError(e.message))
      .finally(() => url && URL.revokeObjectURL(url))
    return () => {
      cancelled = true
    }
  }, [photo.id, photo.modifiedTime])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const preview = useMemo(() => (full ? scaled(full, PREVIEW_SIDE) : null), [full])
  const rotatedPreview = useMemo(() => (preview ? rotateCanvas(preview, angle) : null), [preview, angle])
  const rotatedUrl = useMemo(() => rotatedPreview?.toDataURL('image/jpeg', 0.85) ?? null, [rotatedPreview])
  const imgAspect = rotatedPreview ? rotatedPreview.width / rotatedPreview.height : 1

  useEffect(() => {
    setCrop(ratio ? fitCrop(ratio, imgAspect) : FULL_CROP)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [quarter])

  useEffect(() => {
    if (ratio) setCrop(fitCrop(ratio, imgAspect))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ratioKey, fine])

  // Vista previa del resultado.
  useEffect(() => {
    if (stage !== 'adjust' || !rotatedPreview) return
    const id = window.setTimeout(() => {
      setPositiveUrl(developNegative(cropCanvas(rotatedPreview, crop), adjust, [], true).toDataURL('image/jpeg', 0.9))
    }, 40)
    return () => window.clearTimeout(id)
  }, [stage, rotatedPreview, crop, adjust])

  const geometryChanged =
    angle !== 0 || crop.x !== 0 || crop.y !== 0 || crop.w !== 1 || crop.h !== 1
  const imageChanged = geometryChanged || JSON.stringify(adjust) !== JSON.stringify(NEUTRAL)
  const nameChanged = name.trim() !== '' && name.trim() !== photo.name

  // Sugerencias de nombres y lugares ya guardados.
  useEffect(() => {
    fetchTagSuggestions().then(setSuggestions).catch(() => undefined)
  }, [])

  // Los puntos quedan fijados a la imagen: si cambia el encuadre, dejan de coincidir y se quitan.
  const geometryKey = JSON.stringify([angle, crop])
  const lastGeometry = useRef(geometryKey)
  useEffect(() => {
    if (geometryKey === lastGeometry.current) return
    lastGeometry.current = geometryKey
    if (people.length > 0) {
      setPeople([])
      setNotice('Se quitaron los puntos de personas porque cambió el recorte o el giro. Márcalos de nuevo en la foto final.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [geometryKey])

  // Solo se guardan las personas que tienen nombre.
  const currentTags = (): PhotoTags => {
    const named = people
      .map((p) => ({ ...p, name: p.name.trim() }))
      .filter((p) => p.name)
      .map((p) => ({ name: p.name, x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)) }))
    const cleanPlace = place.trim()
    return cleanPlace ? { place: cleanPlace, people: named } : { people: named }
  }
  const tagsChanged = JSON.stringify(currentTags()) !== JSON.stringify(savedTags)

  const addPerson = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!tagMode) return
    const rect = e.currentTarget.getBoundingClientRect()
    setPeople((list) => [
      ...list,
      { name: '', x: (e.clientX - rect.left) / rect.width, y: (e.clientY - rect.top) / rect.height },
    ])
    setNotice(null)
  }

  // Nombres para el texto predictivo: los guardados mas los de esta foto.
  const peopleOptions = [...new Set([...suggestions.people, ...people.map((p) => p.name.trim()).filter(Boolean)])]
  const placeOptions = [...new Set([...suggestions.places, place.trim()].filter(Boolean))]

  const finalBlob = () => {
    if (!full) throw new Error('La foto todavia no se ha cargado')
    return toBlob(developNegative(cropCanvas(rotateCanvas(full, angle), crop), adjust, [], true))
  }

  const run = async (action: (token: string) => Promise<string>) => {
    const token = getAdminToken()
    if (!token) return
    setSaving(true)
    setStatus(null)
    try {
      setStatus({ ok: true, text: await action(token) })
    } catch (e) {
      const message = (e as Error).message
      if (message === 'No autorizado') clearAdminToken()
      setStatus({ ok: false, text: message })
    } finally {
      setSaving(false)
    }
  }

  const saveChanges = () =>
    run(async (token) => {
      const finalName = withExtension(name.trim() || photo.name)
      const tags = currentTags()
      if (imageChanged) {
        const blob = await finalBlob()
        let updated = await replacePhoto(photo.id, new File([blob], finalName, { type: 'image/jpeg' }), finalName, token)
        if (tagsChanged) updated = await updatePhotoMeta(photo.id, { tags }, token)
        setSavedTags(tags)
        onUpdated(updated)
        return 'Cambios guardados: se reemplazó la foto original.'
      }
      if (nameChanged || tagsChanged) {
        const updated = await updatePhotoMeta(
          photo.id,
          { name: nameChanged ? finalName : undefined, tags: tagsChanged ? tags : undefined },
          token,
        )
        setSavedTags(tags)
        onUpdated(updated)
        return 'Cambios guardados.'
      }
      return 'No hay cambios que guardar.'
    })

  const saveCopy = () =>
    run(async (token) => {
      let copyName = withExtension(name.trim() || photo.name)
      if (copyName === photo.name) copyName = copyName.replace(/(\.[a-z0-9]+)$/i, ' (copia)$1')
      const blob = await finalBlob()
      let created = await uploadPhoto(roomId, new File([blob], copyName, { type: 'image/jpeg' }), token)
      const tags = currentTags()
      if (tags.place || tags.people.length > 0) created = await updatePhotoMeta(created.id, { tags }, token)
      onCreated(created)
      return `Copia guardada como «${copyName}».`
    })

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Editar foto">
      <div className="modal-head">
        <h2>Editar foto</h2>
        <button className="btn" onClick={onClose}>Cerrar</button>
      </div>

      {loadError && <p className="message error">{loadError}</p>}
      {!loadError && !full && <p className="message">Cargando foto…</p>}

      {full && stage === 'crop' && rotatedUrl && (
        <div className="modal-body">
          <p className="step-title">1. Recorta y gira</p>

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
                <button key={r.key} className={`btn${ratioKey === r.key ? ' primary' : ''}`} onClick={() => setRatioKey(r.key)}>
                  {r.label}
                </button>
              ))}
            </div>
          </div>

          <div className="modal-actions">
            <button className="btn" onClick={onClose}>Cancelar</button>
            <button className="btn primary" onClick={() => setStage('adjust')}>Siguiente →</button>
          </div>
        </div>
      )}

      {full && stage === 'adjust' && (
        <div className="modal-body">
          <p className="step-title">2. Nombre y ajustes</p>

          <div className="result-stage">
            {positiveUrl ? (
              <div className={`result-wrap${tagMode ? ' retouching' : ''}`}>
                <img src={positiveUrl} alt="Vista previa" onClick={addPerson} draggable={false} />
                {people.map((p, i) => (
                  <span key={i} className="person-dot" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
                    <i>{p.name.trim() || '?'}</i>
                  </span>
                ))}
              </div>
            ) : (
              <div className="compare-wait">Procesando…</div>
            )}
          </div>

          <div className="save-box">
            <label htmlFor="photo-place">Lugar</label>
            <input
              id="photo-place"
              className="text-input"
              list="places-list"
              value={place}
              maxLength={100}
              placeholder="¿Dónde se tomó la foto?"
              autoComplete="off"
              onChange={(e) => {
                setPlace(e.target.value)
                setStatus(null)
              }}
            />
            <datalist id="places-list">
              {placeOptions.map((p) => <option key={p} value={p} />)}
            </datalist>

            <label>Personas</label>
            <button className={`btn${tagMode ? ' primary' : ''}`} onClick={() => setTagMode((v) => !v)}>
              {tagMode ? 'Terminar de marcar personas' : '＋ Marcar persona en la foto'}
            </button>
            {tagMode && <p className="hint">Toca la foto, sobre la cara de cada persona, y escribe su nombre.</p>}
            {notice && <p className="light-hint light-flat">{notice}</p>}

            {people.map((p, i) => (
              <div key={i} className="person-row">
                <span className="person-num">{i + 1}</span>
                <input
                  className="text-input"
                  list="people-list"
                  value={p.name}
                  maxLength={60}
                  placeholder="Nombre de la persona"
                  autoComplete="off"
                  autoFocus={tagMode && i === people.length - 1 && p.name === ''}
                  onChange={(e) => {
                    const value = e.target.value
                    setPeople((list) => list.map((q, j) => (j === i ? { ...q, name: value } : q)))
                    setStatus(null)
                  }}
                />
                <button className="btn" aria-label="Quitar persona" onClick={() => setPeople((list) => list.filter((_, j) => j !== i))}>✕</button>
              </div>
            ))}
            <datalist id="people-list">
              {peopleOptions.map((n) => <option key={n} value={n} />)}
            </datalist>
          </div>

          <div className="save-box">
            <label htmlFor="photo-name">Nombre de la foto</label>
            <input
              id="photo-name"
              className="text-input"
              value={name}
              maxLength={120}
              onChange={(e) => {
                setName(e.target.value)
                setStatus(null)
              }}
            />
          </div>

          <div className="adjust-box">
            <div className="chips">
              <button className="btn primary" onClick={() => rotatedPreview && setAdjust(autoAdjust(cropCanvas(rotatedPreview, crop), true))}>
                ✨ Automejora
              </button>
              <button className="btn" onClick={() => setAdjust(NEUTRAL)}>Restablecer ajustes</button>
            </div>
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
          </div>

          <div className="save-box">
            <button className="btn primary" onClick={saveChanges} disabled={saving || (!imageChanged && !nameChanged && !tagsChanged)}>
              {saving ? 'Guardando…' : 'Guardar cambios (reemplaza la original)'}
            </button>
            <button className="btn" onClick={saveCopy} disabled={saving}>Guardar como copia</button>
            {status && <p className={status.ok ? 'light-hint light-good' : 'message error'}>{status.text}</p>}
          </div>

          <div className="modal-actions">
            <button className="btn" onClick={() => setStage('crop')}>← Recortar</button>
            <button className="btn" onClick={onClose}>Cerrar</button>
          </div>
        </div>
      )}
    </div>
  )
}
