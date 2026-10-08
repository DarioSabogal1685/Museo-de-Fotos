import { useEffect, useRef, useState } from 'react'
import {
  clearAdminToken,
  fetchTagSuggestions,
  getAdminToken,
  photoUrl,
  sortLeftToRight,
  updatePhotoMeta,
  type Photo,
  type PhotoTags,
  type TagSuggestions,
} from './api'

interface Props {
  photo: Photo
  onClose: () => void
  /** Se llama cuando se guardo la informacion de la foto. */
  onUpdated: (photo: Photo) => void
}

/** Persona en edicion; el id solo sirve para identificar la fila mientras se reordena. */
interface Person {
  id: number
  name: string
  x?: number
  y?: number
}

export default function PhotoEditor({ photo, onClose, onUpdated }: Props) {
  const nextId = useRef(1)
  const newId = () => nextId.current++

  const [people, setPeople] = useState<Person[]>(() =>
    (photo.tags?.people ?? []).map((p) => ({ ...p, id: newId() })),
  )
  const [place, setPlace] = useState(photo.tags?.place ?? '')
  const [group, setGroup] = useState(photo.tags?.group ?? '')
  const [savedTags, setSavedTags] = useState<PhotoTags>(photo.tags ?? { people: [] })

  const [tagMode, setTagMode] = useState(false)
  const [suggestions, setSuggestions] = useState<TagSuggestions>({ people: [], places: [], groups: [] })

  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetchTagSuggestions().then(setSuggestions).catch(() => undefined)
  }, [])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // La app siempre ordena a las personas de izquierda a derecha segun su punto.
  const sorted = sortLeftToRight(people)

  // Etiquetas listas para guardar: solo personas con nombre, ya ordenadas.
  const currentTags = (): PhotoTags => {
    const named = sorted
      .map((p) => ({ ...p, name: p.name.trim() }))
      .filter((p) => p.name)
      .map((p) =>
        p.x === undefined || p.y === undefined
          ? { name: p.name }
          : { name: p.name, x: Number(p.x.toFixed(4)), y: Number(p.y.toFixed(4)) },
      )
    const tags: PhotoTags = { people: named }
    if (place.trim()) tags.place = place.trim()
    if (group.trim()) tags.group = group.trim()
    return tags
  }
  const tagsChanged = JSON.stringify(currentTags()) !== JSON.stringify(savedTags)

  const onPhotoClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!tagMode) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    setStatus(null)
    // Si hay una persona agregada sin punto, el toque es para ella.
    const waiting = people.find((p) => p.x === undefined)
    if (waiting) {
      setPeople((list) => list.map((p) => (p.id === waiting.id ? { ...p, x, y } : p)))
    } else {
      setPeople((list) => [...list, { id: newId(), name: '', x, y }])
    }
  }

  const waiting = people.find((p) => p.x === undefined)
  const peopleOptions = [...new Set([...suggestions.people, ...people.map((p) => p.name.trim()).filter(Boolean)])]
  const placeOptions = [...new Set([...suggestions.places, place.trim()].filter(Boolean))]
  const groupOptions = [...new Set([...suggestions.groups, group.trim()].filter(Boolean))]

  const save = async () => {
    const token = getAdminToken()
    if (!token) return
    setSaving(true)
    setStatus(null)
    try {
      const tags = currentTags()
      const updated = await updatePhotoMeta(photo.id, { tags }, token)
      setSavedTags(tags)
      onUpdated(updated)
      setStatus({ ok: true, text: 'Información guardada.' })
    } catch (e) {
      const message = (e as Error).message
      if (message === 'No autorizado') clearAdminToken()
      setStatus({ ok: false, text: message })
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Editar información de la foto">
      <div className="modal-head">
        <h2>Información de la foto</h2>
        <button className="btn" onClick={onClose}>Cerrar</button>
      </div>

      <div className="modal-body">
        <div className="result-stage">
          <div className={`result-wrap${tagMode ? ' retouching' : ''}`}>
            <img src={photoUrl(photo.id, photo.modifiedTime)} alt={photo.name} onClick={onPhotoClick} draggable={false} />
            {sorted.map((p, i) =>
              p.x === undefined || p.y === undefined ? null : (
                <span key={p.id} className="person-dot" style={{ left: `${p.x * 100}%`, top: `${p.y * 100}%` }}>
                  <i>{i + 1}</i>
                </span>
              ),
            )}
          </div>
        </div>

        <div className="save-box">
          <label htmlFor="photo-group">Grupo (nombre del negativo)</label>
          <input
            id="photo-group"
            className="text-input"
            list="groups-list"
            value={group}
            maxLength={80}
            placeholder="Por ejemplo: Negativo Navidad 1998"
            autoComplete="off"
            onChange={(e) => {
              setGroup(e.target.value)
              setStatus(null)
            }}
          />
          <datalist id="groups-list">
            {groupOptions.map((g) => <option key={g} value={g} />)}
          </datalist>
          <p className="hint">Las fotos con el mismo grupo vienen del mismo negativo. Para agrupar varias a la vez, usa «Armar grupo» en el cuarto.</p>

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
        </div>

        <div className="save-box">
          <label>Personas (de izquierda a derecha)</label>
          <div className="chips">
            <button className={`btn${tagMode ? ' primary' : ''}`} onClick={() => setTagMode((v) => !v)}>
              {tagMode ? 'Terminar de marcar' : '＋ Marcar en la foto'}
            </button>
            <button
              className="btn"
              onClick={() => {
                setPeople((list) => [...list, { id: newId(), name: '' }])
                setStatus(null)
              }}
            >
              ＋ Agregar sin punto
            </button>
          </div>
          {tagMode && (
            <p className="hint">
              {waiting
                ? `Toca la foto para ubicar a «${waiting.name.trim() || 'la persona nueva'}».`
                : 'Toca la foto sobre cada persona y escribe su nombre. Se ordenan solas de izquierda a derecha.'}
            </p>
          )}

          {sorted.map((p, i) => (
            <div key={p.id} className="person-row">
              <span className="person-num">{p.x === undefined ? '–' : i + 1}</span>
              <input
                className="text-input"
                list="people-list"
                value={p.name}
                maxLength={60}
                placeholder="Nombre de la persona"
                autoComplete="off"
                autoFocus={p.name === '' && p.id === people[people.length - 1]?.id}
                onChange={(e) => {
                  const value = e.target.value
                  setPeople((list) => list.map((q) => (q.id === p.id ? { ...q, name: value } : q)))
                  setStatus(null)
                }}
              />
              <button
                className="btn"
                aria-label="Quitar persona"
                onClick={() => setPeople((list) => list.filter((q) => q.id !== p.id))}
              >
                ✕
              </button>
            </div>
          ))}
          <datalist id="people-list">
            {peopleOptions.map((n) => <option key={n} value={n} />)}
          </datalist>
        </div>

        <div className="save-box">
          <button className="btn primary" onClick={save} disabled={saving || !tagsChanged}>
            {saving ? 'Guardando…' : 'Guardar información'}
          </button>
          {status && <p className={status.ok ? 'light-hint light-good' : 'message error'}>{status.text}</p>}
        </div>
      </div>
    </div>
  )
}
