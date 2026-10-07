import { useEffect, useRef, useState } from 'react'
import {
  clearAdminToken,
  fetchGroups,
  fetchTagSuggestions,
  getAdminToken,
  photoUrl,
  saveGroups,
  sortLeftToRight,
  updatePhotoMeta,
  type Group,
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
  const [photoGroups, setPhotoGroups] = useState<string[]>(photo.tags?.groups ?? [])
  const [savedTags, setSavedTags] = useState<PhotoTags>(photo.tags ?? { people: [] })

  const [tagMode, setTagMode] = useState(false)
  const [suggestions, setSuggestions] = useState<TagSuggestions>({ people: [], places: [] })
  const [allGroups, setAllGroups] = useState<Group[]>([])
  const [groupName, setGroupName] = useState('')

  const [saving, setSaving] = useState(false)
  const [status, setStatus] = useState<{ ok: boolean; text: string } | null>(null)

  useEffect(() => {
    fetchTagSuggestions().then(setSuggestions).catch(() => undefined)
    fetchGroups().then(setAllGroups).catch(() => undefined)
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
    if (photoGroups.length > 0) tags.groups = photoGroups
    return tags
  }
  const tagsChanged = JSON.stringify(currentTags()) !== JSON.stringify(savedTags)

  const unplaced = people.find((p) => p.x === undefined)

  const onPhotoClick = (e: React.MouseEvent<HTMLImageElement>) => {
    if (!tagMode) return
    const rect = e.currentTarget.getBoundingClientRect()
    const x = (e.clientX - rect.left) / rect.width
    const y = (e.clientY - rect.top) / rect.height
    setStatus(null)
    // Si hay una persona esperando su punto (por ejemplo, de un grupo), el toque es para ella.
    if (unplaced) {
      setPeople((list) => list.map((p) => (p.id === unplaced.id ? { ...p, x, y } : p)))
    } else {
      setPeople((list) => [...list, { id: newId(), name: '', x, y }])
    }
  }

  const peopleOptions = [...new Set([...suggestions.people, ...people.map((p) => p.name.trim()).filter(Boolean)])]
  const placeOptions = [...new Set([...suggestions.places, place.trim()].filter(Boolean))]

  // --- Grupos ---
  const toggleGroup = (group: Group) => {
    setStatus(null)
    if (photoGroups.includes(group.name)) {
      setPhotoGroups((g) => g.filter((n) => n !== group.name))
      return
    }
    setPhotoGroups((g) => [...g, group.name])
    // Se agregan los integrantes que todavia no estan; esperan su punto en la foto.
    const have = new Set(people.map((p) => p.name.trim().toLowerCase()))
    const missing = group.members.filter((m) => !have.has(m.toLowerCase()))
    if (missing.length > 0) {
      setPeople((list) => [...list, ...missing.map((name) => ({ id: newId(), name }))])
      setTagMode(true)
    }
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

  const buildGroup = () =>
    run(async (token) => {
      const name = groupName.trim()
      const members = currentTags().people.map((p) => p.name)
      if (!name) throw new Error('Escribe un nombre para el grupo')
      if (members.length === 0) throw new Error('Marca al menos una persona con nombre para armar el grupo')
      const exists = allGroups.some((g) => g.name.toLowerCase() === name.toLowerCase())
      if (exists && !window.confirm(`Ya existe el grupo «${name}». ¿Reemplazar sus integrantes?`)) {
        return 'No se cambió el grupo.'
      }
      const others = allGroups.filter((g) => g.name.toLowerCase() !== name.toLowerCase())
      setAllGroups(await saveGroups([...others, { name, members }], token))
      setPhotoGroups((g) => (g.includes(name) ? g : [...g, name]))
      setGroupName('')
      return `Grupo «${name}» guardado con ${members.length} persona${members.length === 1 ? '' : 's'}.`
    })

  const removeGroup = (group: Group) =>
    run(async (token) => {
      if (!window.confirm(`¿Eliminar el grupo «${group.name}»? Las fotos conservan sus personas.`)) {
        return 'No se eliminó el grupo.'
      }
      setAllGroups(await saveGroups(allGroups.filter((g) => g.name !== group.name), token))
      setPhotoGroups((g) => g.filter((n) => n !== group.name))
      return `Grupo «${group.name}» eliminado.`
    })

  const save = () =>
    run(async (token) => {
      const tags = currentTags()
      const updated = await updatePhotoMeta(photo.id, { tags }, token)
      setSavedTags(tags)
      onUpdated(updated)
      return 'Información guardada.'
    })

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
              {unplaced
                ? `Toca la foto para ubicar a «${unplaced.name.trim() || 'la persona nueva'}».`
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
          <label>Grupos</label>
          {allGroups.length === 0 && <p className="hint">Todavía no hay grupos. Arma el primero abajo.</p>}
          <div className="chips">
            {allGroups.map((g) => (
              <span key={g.name} className="group-chip">
                <button
                  className={`btn${photoGroups.includes(g.name) ? ' primary' : ''}`}
                  title={g.members.join(', ')}
                  onClick={() => toggleGroup(g)}
                >
                  {g.name} ({g.members.length})
                </button>
                <button className="btn" aria-label={`Eliminar grupo ${g.name}`} disabled={saving} onClick={() => removeGroup(g)}>✕</button>
              </span>
            ))}
          </div>
          <p className="hint">Toca un grupo para añadir sus integrantes a esta foto.</p>

          <div className="person-row">
            <input
              className="text-input"
              list="groups-list"
              value={groupName}
              maxLength={60}
              placeholder="Nombre del nuevo grupo, por ejemplo Familia"
              autoComplete="off"
              onChange={(e) => setGroupName(e.target.value)}
            />
            <datalist id="groups-list">
              {allGroups.map((g) => <option key={g.name} value={g.name} />)}
            </datalist>
            <button className="btn" disabled={saving || !groupName.trim()} onClick={buildGroup}>Armar grupo</button>
          </div>
          <p className="hint">«Armar grupo» guarda las personas de esta foto con ese nombre, para usarlas en otras fotos.</p>
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
