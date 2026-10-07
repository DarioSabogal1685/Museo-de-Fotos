import { useEffect, useRef, useState } from 'react'
import Menu from './Menu'
import PhotoEditor from './PhotoEditor'
import {
  deletePhoto,
  fetchPhotos,
  getAdminToken,
  photoUrl,
  sortLeftToRight,
  thumbUrl,
  uploadPhoto,
  type Photo,
  type Room,
} from './api'

interface Props {
  room: Room
  onBack: () => void
}

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE = 10

const hasInfo = (photo: Photo) =>
  Boolean(photo.tags && (photo.tags.place || photo.tags.people.length > 0 || photo.tags.groups?.length))

export default function RoomView({ room, onBack }: Props) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)
  const [menuId, setMenuId] = useState<string | null>(null)
  const [editing, setEditing] = useState<Photo | null>(null)
  const [showInfo, setShowInfo] = useState(false)

  // La informacion siempre arranca oculta al abrir otra foto.
  useEffect(() => {
    setShowInfo(false)
  }, [selected])

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
    const onKey = (e: KeyboardEvent) => {
      if (editing) return
      if (e.key === 'Escape' && menuId) {
        setMenuId(null)
        return
      }
      if (selected === null) {
        if (e.key === 'Escape') onBack()
        return
      }
      if (e.key === 'Escape') setSelected(null)
      if (e.key === 'ArrowRight') setSelected((i) => (i === null ? i : Math.min(i + 1, photos.length - 1)))
      if (e.key === 'ArrowLeft') setSelected((i) => (i === null ? i : Math.max(i - 1, 0)))
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, photos.length, onBack, menuId, editing])

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

  // --- Pulsacion larga sobre la miniatura ---
  const cancelPress = () => {
    if (pressTimer.current !== null) window.clearTimeout(pressTimer.current)
    pressTimer.current = null
  }

  const startPress = (e: React.PointerEvent, photo: Photo) => {
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
    if (longPressed.current) {
      longPressed.current = false
      return
    }
    if (menuId) {
      setMenuId(null)
      return
    }
    setSelected(index)
    void photo
  }

  const current = selected !== null ? photos[selected] : null

  return (
    <>
      <div className="toolbar">
        <button className="btn" onClick={onBack}>← Volver al pasillo</button>
        <h2>{room.name}</h2>
        <div className="actions">
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
          <Menu currentRoomId={room.id} />
        </div>
      </div>

      {error && <p className="message error">{error}</p>}
      {loading && <p className="message">Cargando…</p>}
      {!loading && !error && photos.length === 0 && <p className="message">Este cuarto está vacío por ahora.</p>}
      {photos.length > 0 && <p className="hint">Mantén pulsada una foto para editarla o eliminarla.</p>}

      <div className="grid">
        {photos.map((p, i) => (
          <div
            key={p.id}
            className="card"
            role="button"
            tabIndex={0}
            onClick={() => onCardClick(i, p)}
            onKeyDown={(e) => e.key === 'Enter' && setSelected(i)}
            onPointerDown={(e) => startPress(e, p)}
            onPointerMove={movePress}
            onPointerUp={cancelPress}
            onPointerLeave={cancelPress}
            onPointerCancel={cancelPress}
            onContextMenu={(e) => {
              e.preventDefault()
              cancelPress()
              longPressed.current = true
              setMenuId(p.id)
            }}
          >
            <img src={thumbUrl(p.id, 400, p.modifiedTime)} alt={p.name} loading="lazy" draggable={false} />
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

      {current && (
        <div className="lightbox" onClick={() => setSelected(null)}>
          <img src={photoUrl(current.id, current.modifiedTime)} alt={current.name} />
          <p>{current.name} · {(selected ?? 0) + 1} / {photos.length}</p>

          {hasInfo(current) && (
            <div className="info-area" onClick={(e) => e.stopPropagation()}>
              <button className="info-toggle" onClick={() => setShowInfo((v) => !v)}>
                {showInfo ? 'Ocultar información' : 'Revelar información'}
              </button>
              {showInfo && (
                <div className="info-panel">
                  {current.tags?.place && <p>📍 {current.tags.place}</p>}
                  {current.tags?.groups && current.tags.groups.length > 0 && (
                    <p>Grupos: {current.tags.groups.join(', ')}</p>
                  )}
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
