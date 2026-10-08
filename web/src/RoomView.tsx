import { useEffect, useMemo, useRef, useState } from 'react'
import DownloadButton from './DownloadButton'
import Menu from './Menu'
import PhotoEditor from './PhotoEditor'
import {
  DEMO,
  deletePhoto,
  fetchPhotos,
  fetchTagSuggestions,
  getAdminToken,
  photoUrl,
  sortLeftToRight,
  thumbUrl,
  setRoomCover,
  updatePhotoMeta,
  uploadPhoto,
  type Photo,
  type PhotoTags,
  type Room,
} from './api'

interface Props {
  room: Room
  onBack: () => void
  /** Se llama cuando cambia algo de la sala (por ejemplo, su portada). */
  onRoomUpdated: (room: Room) => void
}

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 10
const NO_GROUP = '__none__'

const hasInfo = (photo: Photo) =>
  Boolean(photo.tags && (photo.tags.place || photo.tags.people.length > 0 || photo.tags.group))

export default function RoomView({ room, onBack, onRoomUpdated }: Props) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Photo | null>(null)
  const [showInfo, setShowInfo] = useState(false)

  // Filtro por grupo (nombre de negativo).
  const [filter, setFilter] = useState<string | null>(null)

  // Modo "armar grupo": se eligen varias fotos y se les pone el mismo nombre de negativo.
  const [selecting, setSelecting] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [groupInput, setGroupInput] = useState('')
  const [savingGroup, setSavingGroup] = useState(false)
  const [suggestedGroups, setSuggestedGroups] = useState<string[]>([])

  // Estado de la pulsacion larga.
  const pressTimer = useRef<number | null>(null)
  const pressStart = useRef({ x: 0, y: 0 })
  const longPressed = useRef(false)

  const load = () =>
    fetchPhotos(room.id)
      .then(setPhotos)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))

  useEffect(() => {
    load()
  }, [room.id])

  useEffect(() => {
    fetchTagSuggestions().then((s) => setSuggestedGroups(s.groups)).catch(() => undefined)
  }, [])

  // Grupos presentes en este cuarto, con cuantas fotos tiene cada uno.
  const roomGroups = useMemo(() => {
    const counts = new Map<string, number>()
    for (const p of photos) if (p.tags?.group) counts.set(p.tags.group, (counts.get(p.tags.group) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [photos])
  const ungroupedCount = photos.filter((p) => !p.tags?.group).length

  const visible = useMemo(() => {
    if (filter === null) return photos
    if (filter === NO_GROUP) return photos.filter((p) => !p.tags?.group)
    return photos.filter((p) => p.tags?.group === filter)
  }, [photos, filter])

  // Si el grupo filtrado desaparece (por ejemplo, al quitar su ultima foto), se vuelve a mostrar todo.
  useEffect(() => {
    if (filter && filter !== NO_GROUP && !roomGroups.some(([g]) => g === filter)) setFilter(null)
  }, [filter, roomGroups])

  // La informacion siempre arranca oculta al abrir otra foto.
  useEffect(() => {
    setShowInfo(false)
  }, [selected])

  useEffect(() => {
    setSelected(null)
  }, [filter])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (editing) return
      if (e.key === 'Escape' && menuId) {
        setMenuId(null)
        return
      }
      if (selected === null) {
        if (e.key === 'Escape') {
          if (selecting) cancelSelecting()
          else onBack()
        }
        return
      }
      if (e.key === 'Escape') setSelected(null)
      if (e.key === 'ArrowRight') setSelected((i) => (i === null ? i : Math.min(i + 1, visible.length - 1)))
      if (e.key === 'ArrowLeft') setSelected((i) => (i === null ? i : Math.max(i - 1, 0)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, visible.length, onBack, menuId, editing, selecting])

  // Toca fuera de los botones: se cierran.
  useEffect(() => {
    if (!menuId) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('[data-actions]')) setMenuId(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [menuId])

  const onUpload = async (files: FileList | null) => {
    if (!files?.length) return
    const token = getAdminToken()
    if (!token) return
    setUploading(true)
    setError(null)
    try {
      for (const file of Array.from(files)) await uploadPhoto(room.id, file, token)
      await load()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setUploading(false)
    }
  }

  const onSetCover = async (photo: Photo) => {
    setMenuId(null)
    const token = getAdminToken()
    if (!token) return
    try {
      onRoomUpdated(await setRoomCover(room.id, photo.id, token))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  const onDelete = async (photo: Photo) => {
    setMenuId(null)
    if (!window.confirm(`¿Eliminar «${photo.name}»? Se enviará a la papelera de Drive.`)) return
    const token = getAdminToken()
    if (!token) return
    try {
      await deletePhoto(photo.id, token)
      setPhotos((list) => list.filter((p) => p.id !== photo.id))
      setError(null)
    } catch (e) {
      setError((e as Error).message)
    }
  }

  // --- Armar grupo de fotos ---
  const cancelSelecting = () => {
    setSelecting(false)
    setPicked(new Set())
    setGroupInput('')
  }

  const startSelecting = () => {
    setMenuId(null)
    setSelected(null)
    setSelecting(true)
  }

  const togglePicked = (id: string) =>
    setPicked((set) => {
      const next = new Set(set)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  /** Pone (o quita, si name es null) el grupo a todas las fotos elegidas. */
  const applyGroup = async (name: string | null) => {
    const token = getAdminToken()
    if (!token) return
    setSavingGroup(true)
    setError(null)
    const updates = new Map<string, Photo>()
    try {
      for (const photo of photos.filter((p) => picked.has(p.id))) {
        if (name === null && !photo.tags?.group) continue
        const tags: PhotoTags = { people: photo.tags?.people ?? [] }
        if (photo.tags?.place) tags.place = photo.tags.place
        if (name !== null) tags.group = name
        updates.set(photo.id, await updatePhotoMeta(photo.id, { tags }, token))
      }
      cancelSelecting()
    } catch (e) {
      setError(
        `${(e as Error).message}${updates.size ? ` (se guardaron ${updates.size} de ${picked.size} fotos)` : ''}`,
      )
    } finally {
      // Se reflejan siempre las fotos que si se alcanzaron a guardar.
      if (updates.size) setPhotos((list) => list.map((p) => updates.get(p.id) ?? p))
      setSavingGroup(false)
    }
  }

  // --- Pulsacion larga sobre la miniatura ---
  const cancelPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
    pressTimer.current = null
  }

  const startPress = (e: React.PointerEvent, photo: Photo) => {
    if (selecting) return
    if (e.pointerType === 'mouse' && e.button !== 0) return
    longPressed.current = false
    pressStart.current = { x: e.clientX, y: e.clientY }
    cancelPress()
    pressTimer.current = window.setTimeout(() => {
      longPressed.current = true
      setMenuId(photo.id)
    }, LONG_PRESS_MS)
  }

  const movePress = (e: React.PointerEvent) => {
    if (pressTimer.current === null) return
    if (Math.hypot(e.clientX - pressStart.current.x, e.clientY - pressStart.current.y) > MOVE_TOLERANCE) cancelPress()
  }

  const onCardClick = (index: number, photo: Photo) => {
    if (selecting) {
      togglePicked(photo.id)
      return
    }
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (menuId) {
      setMenuId(null)
      return
    }
    setSelected(index)
  }

  const current = selected !== null ? visible[selected] : null
  const groupOptions = [...new Set([...suggestedGroups, ...roomGroups.map(([g]) => g)])]

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={onBack}>← Volver al pasillo</button>
        <h2>{room.name}</h2>
        <div className="actions">
          <button className={`btn${selecting ? ' primary' : ''}`} onClick={selecting ? cancelSelecting : startSelecting}>
            {selecting ? 'Cancelar' : 'Armar grupo'}
          </button>
          <label className="btn primary">
            {uploading ? 'Subiendo…' : 'Subir fotos'}
            <input
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif,image/avif"
              multiple
              hidden
              disabled={uploading}
              onChange={(e) => {
                onUpload(e.target.files)
                e.target.value = ''
              }}
            />
          </label>
          {!DEMO && <DownloadButton room={room} />}
          <Menu currentRoomId={room.id} />
        </div>
      </div>

      {room.cover && (
        <div className="room-banner">
          <img
            src={thumbUrl(room.cover, 900)}
            alt={`Portada de ${room.name}`}
            draggable={false}
            onError={(e) => {
              e.currentTarget.parentElement!.style.display = 'none'
            }}
          />
        </div>
      )}

      {error && <p className="message error">{error}</p>}
      {loading && <p className="message">Cargando…</p>}
      {!loading && !error && photos.length === 0 && <p className="message">Este cuarto está vacío por ahora.</p>}

      {roomGroups.length > 0 && (
        <div className="filter-bar">
          <button className={`chip${filter === null ? ' active' : ''}`} onClick={() => setFilter(null)}>
            Todas ({photos.length})
          </button>
          {roomGroups.map(([g, n]) => (
            <button key={g} className={`chip${filter === g ? ' active' : ''}`} onClick={() => setFilter(g)}>
              🎞 {g} ({n})
            </button>
          ))}
          {ungroupedCount > 0 && (
            <button className={`chip${filter === NO_GROUP ? ' active' : ''}`} onClick={() => setFilter(NO_GROUP)}>
              Sin grupo ({ungroupedCount})
            </button>
          )}
        </div>
      )}

      {photos.length > 0 && !selecting && <p className="hint">Mantén pulsada una foto para editarla o eliminarla.</p>}
      {selecting && <p className="hint">Toca las fotos que van juntas (las del mismo negativo) y ponles un nombre abajo.</p>}

      <div className={`grid${selecting ? ' with-bar' : ''}`}>
        {visible.map((p, i) => (
          <div
            key={p.id}
            className={`card${picked.has(p.id) ? ' picked' : ''}`}
            role="button"
            tabIndex={0}
            onClick={() => onCardClick(i, p)}
            onKeyDown={(e) => e.key === 'Enter' && onCardClick(i, p)}
            onPointerDown={(e) => startPress(e, p)}
            onPointerMove={movePress}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            onPointerCancel={cancelPress}
            onContextMenu={(e) => {
              e.preventDefault()
              if (selecting) return
              cancelPress()
              longPressed.current = true
              setMenuId(p.id)
            }}
          >
            <img src={thumbUrl(p.id, 400, p.modifiedTime)} alt={p.name} loading="lazy" draggable={false} />
            {selecting && <span className="card-check">{picked.has(p.id) ? '✓' : ''}</span>}
            {!selecting && room.cover === p.id && <span className="cover-badge">★ Portada</span>}
            {menuId === p.id && (
              <div className="card-actions" data-actions>
                <button
                  className="card-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    setMenuId(null)
                    setEditing(p)
                  }}
                >
                  Editar
                </button>
                <button
                  className="card-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onSetCover(p)
                  }}
                >
                  ★ Portada
                </button>
                <button
                  className="card-btn danger"
                  onClick={(e) => {
                    e.stopPropagation()
                    onDelete(p)
                  }}
                >
                  Eliminar
                </button>
              </div>
            )}
          </div>
        ))}
      </div>

      {selecting && (
        <div className="select-bar">
          <div className="select-row">
            <span>{picked.size} seleccionada{picked.size === 1 ? '' : 's'}</span>
            <button className="btn" onClick={() => setPicked(new Set(visible.map((p) => p.id)))}>Elegir todas</button>
            <button className="btn" disabled={picked.size === 0} onClick={() => setPicked(new Set())}>Ninguna</button>
          </div>
          <div className="select-row">
            <input
              className="text-input"
              list="room-groups-list"
              value={groupInput}
              maxLength={80}
              placeholder="Nombre del negativo (grupo)"
              autoComplete="off"
              onChange={(e) => setGroupInput(e.target.value)}
            />
            <datalist id="room-groups-list">
              {groupOptions.map((g) => <option key={g} value={g} />)}
            </datalist>
            <button
              className="btn primary"
              disabled={savingGroup || picked.size === 0 || !groupInput.trim()}
              onClick={() => applyGroup(groupInput.trim())}
            >
              {savingGroup ? 'Guardando…' : 'Guardar grupo'}
            </button>
            <button className="btn" disabled={savingGroup || picked.size === 0} onClick={() => applyGroup(null)}>
              Quitar grupo
            </button>
          </div>
        </div>
      )}

      {current && (
        <div className="lightbox" onClick={() => setSelected(null)}>
          <img src={photoUrl(current.id, current.modifiedTime)} alt={current.name} />
          <p>{current.name} · {(selected ?? 0) + 1} / {visible.length}</p>

          {hasInfo(current) && (
            <div className="info-area" onClick={(e) => e.stopPropagation()}>
              <button className="info-toggle" onClick={() => setShowInfo((v) => !v)}>
                {showInfo ? 'Ocultar información' : 'Revelar información'}
              </button>
              {showInfo && (
                <div className="info-panel">
                  {current.tags?.group && <p>🎞 Negativo: {current.tags.group}</p>}
                  {current.tags?.place && <p>📍 {current.tags.place}</p>}
                  {current.tags && current.tags.people.length > 0 && (
                    <>
                      <p className="info-label">De izquierda a derecha:</p>
                      <ol className="info-people">
                        {sortLeftToRight(current.tags.people).map((p, i) => (
                          <li key={i}>{p.name}</li>
                        ))}
                      </ol>
                    </>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {editing && (
        <PhotoEditor
          photo={editing}
          onClose={() => setEditing(null)}
          onUpdated={(updated) => {
            setPhotos((list) => list.map((p) => (p.id === updated.id ? updated : p)))
            setEditing(updated)
          }}
        />
      )}
    </>
  )
}
