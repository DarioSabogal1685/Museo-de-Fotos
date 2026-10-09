import { useEffect, useMemo, useRef, useState } from 'react'
import DownloadButton from './DownloadButton'
import Menu from './Menu'
import PhotoEditor from './PhotoEditor'
import { addPending, loadPending, removePending, type Pending } from './pendingReplacements'
import {
  DEMO,
  deletePhoto,
  fetchPhotos,
  fetchPhotoBlob,
  fetchRooms,
  movePhoto,
  replacePhoto,
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

/** "hace 5 min", "hace 3 h", "hace 2 días". */
function timeAgo(at: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000))
  if (minutes < 1) return 'hace un momento'
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return `hace ${hours} h`
  return `hace ${Math.round(hours / 24)} días`
}

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

  // Pasar una foto a otra sala.
  const [moving, setMoving] = useState<Photo | null>(null)
  const [roomChoices, setRoomChoices] = useState<Room[] | null>(null)
  const [moveBusy, setMoveBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  // Fotos mandadas a la galeria para editarlas fuera de la app y que esperan su version editada.
  const [pendings, setPendings] = useState<Pending[]>(() => loadPending())
  const roomPendings = pendings.filter((p) => p.roomId === room.id)
  const [replacingId, setReplacingId] = useState<string | null>(null)
  // La foto se descarga en cuanto se abren los botones, para poder compartirla en el mismo toque
  // (iPhone exige que "compartir" ocurra justo despues del toque, sin esperas de red).
  const prefetched = useRef<{ id: string; blob: Blob } | null>(null)
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
      if (moving) {
        if (e.key === 'Escape' && !moveBusy) setMoving(null)
        return
      }
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
  }, [selected, visible.length, onBack, menuId, editing, selecting, moving, moveBusy])

  // El aviso de "foto movida" desaparece solo.
  useEffect(() => {
    if (!notice) return
    const id = window.setTimeout(() => setNotice(null), 4000)
    return () => window.clearTimeout(id)
  }, [notice])

  // Toca fuera de los botones: se cierran.
  useEffect(() => {
    if (!menuId) return
    const onDown = (e: PointerEvent) => {
      if (!(e.target as HTMLElement).closest('[data-actions]')) setMenuId(null)
    }
    document.addEventListener('pointerdown', onDown)
    return () => document.removeEventListener('pointerdown', onDown)
  }, [menuId])

  // Se descarga por adelantado la foto de los botones que estan abiertos.
  useEffect(() => {
    if (!menuId) return
    const photo = photos.find((p) => p.id === menuId)
    if (!photo || prefetched.current?.id === photo.id) return
    let cancelled = false
    fetchPhotoBlob(photo.id, photo.md5 ?? photo.modifiedTime)
      .then((blob) => {
        if (!cancelled) prefetched.current = { id: photo.id, blob }
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [menuId, photos])

  const extensionFor = (name: string, type: string) =>
    /\.[a-z0-9]{2,4}$/i.test(name) ? name : `${name}.${type === 'image/png' ? 'png' : 'jpg'}`

  /** Manda la foto a la galeria del telefono (hoja de compartir -> «Guardar imagen») o, sin ella, la descarga. */
  const onReplace = async (photo: Photo) => {
    setMenuId(null)
    setError(null)
    try {
      const blob =
        prefetched.current?.id === photo.id
          ? prefetched.current.blob
          : await fetchPhotoBlob(photo.id, photo.md5 ?? photo.modifiedTime)
      const file = new File([blob], extensionFor(photo.name, blob.type), { type: blob.type || 'image/jpeg' })

      let how: 'shared' | 'downloaded' = 'downloaded'
      if (navigator.canShare?.({ files: [file] })) {
        try {
          await navigator.share({ files: [file], title: photo.name })
          how = 'shared'
        } catch (e) {
          // Si cerro la hoja sin guardar, no se queda esperando nada.
          if ((e as Error).name === 'AbortError') return
        }
      }
      if (how === 'downloaded') {
        const url = URL.createObjectURL(file)
        const a = document.createElement('a')
        a.href = url
        a.download = file.name
        a.click()
        window.setTimeout(() => URL.revokeObjectURL(url), 10_000)
      }
      setPendings(addPending({ id: photo.id, name: photo.name, roomId: room.id, at: Date.now() }))
      setNotice(
        how === 'shared'
          ? 'En la hoja que se abrió elige «Guardar imagen». Edítala y vuelve aquí.'
          : 'La foto se descargó. Edítala y vuelve aquí para subirla.',
      )
    } catch (e) {
      setError((e as Error).message)
    }
  }

  /** Pone la version editada en lugar de la original (misma foto, sin duplicado). */
  const applyReplacement = async (pending: Pending, file: File) => {
    const token = getAdminToken()
    if (!token) return
    setReplacingId(pending.id)
    setError(null)
    try {
      const updated = await replacePhoto(pending.id, file, pending.name, token)
      setPhotos((list) => list.map((p) => (p.id === updated.id ? updated : p)))
      setPendings(removePending(pending.id))
      setNotice(`✓ «${pending.name}» se reemplazó por la versión editada, sin duplicarla.`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setReplacingId(null)
    }
  }

  const onUpload = async (files: FileList | null) => {
    if (!files?.length) return

    // Una sola foto subida mientras hay una en espera: lo normal es que sea su version editada.
    if (files.length === 1 && roomPendings.length === 1) {
      const target = roomPendings[0]
      if (
        window.confirm(
          `¿Esta foto es la versión editada de «${target.name}»?\n\nAceptar: reemplaza la original (sin duplicar).\nCancelar: se sube como foto nueva.`,
        )
      ) {
        await applyReplacement(target, files[0])
        return
      }
    }

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

  const openMove = (photo: Photo) => {
    setMenuId(null)
    setMoving(photo)
    setRoomChoices(null)
    setError(null)
    fetchRooms()
      .then((list) => setRoomChoices(list.filter((r) => r.id !== room.id)))
      .catch((e: Error) => {
        setMoving(null)
        setError(e.message)
      })
  }

  const doMove = async (target: Room) => {
    if (!moving) return
    const token = getAdminToken()
    if (!token) return
    setMoveBusy(true)
    try {
      await movePhoto(moving.id, target.id, token)
      const moved = moving
      setPhotos((list) => list.filter((p) => p.id !== moved.id))
      // Si era la portada de esta sala, vuelve a mostrarse la primera foto que quede.
      if (room.cover === moved.id) onRoomUpdated({ ...room, cover: photos.find((p) => p.id !== moved.id)?.id })
      setNotice(`✓ «${moved.name}» pasó a «${target.name}».`)
      setMoving(null)
    } catch (e) {
      setError((e as Error).message)
      setMoving(null)
    } finally {
      setMoveBusy(false)
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
          <Menu />
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

      {/* Espacio fijo de la sala: fotos mandadas a la galeria que esperan su version editada */}
      <section className="pending-section" aria-label="Fotos por reemplazar">
        <h3>⏳ Por reemplazar{roomPendings.length > 0 ? ` (${roomPendings.length})` : ''}</h3>
        {roomPendings.length === 0 ? (
          <p className="hint pending-empty">
            No hay fotos por reemplazar. Mantén pulsada una foto y toca «Reemplazar» para editarla fuera de la app.
          </p>
        ) : (
          <>
            <p className="hint pending-empty">
              Fotos que mandaste a tu galería para editarlas. Cuando estén listas, sube aquí la versión editada.
            </p>
            <div className="pending-list">
              {roomPendings.map((p) => {
                const photo = photos.find((x) => x.id === p.id)
                return (
                  <div key={p.id} className="pending-card">
                    {photo ? (
                      <img src={thumbUrl(photo.id, 160, photo.modifiedTime)} alt={p.name} draggable={false} />
                    ) : (
                      <span className="pending-noimg">{loading ? '…' : '?'}</span>
                    )}
                    <div className="pending-info">
                      <strong title={p.name}>{p.name}</strong>
                      <small>
                        {photo || loading ? `Enviada ${timeAgo(p.at)}` : 'Esta foto ya no está en la sala (se movió o se borró)'}
                      </small>
                      <div className="pending-actions">
                        {photo && (
                          <label className={`btn primary${replacingId === p.id ? ' disabled' : ''}`}>
                            {replacingId === p.id ? 'Subiendo…' : 'Subir editada'}
                            <input
                              type="file"
                              accept="image/*"
                              hidden
                              disabled={replacingId !== null}
                              onChange={(e) => {
                                const file = e.target.files?.[0]
                                e.target.value = ''
                                if (file) applyReplacement(p, file)
                              }}
                            />
                          </label>
                        )}
                        <button className="btn" disabled={replacingId !== null} onClick={() => setPendings(removePending(p.id))}>
                          {photo ? 'Cancelar' : 'Quitar'}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </>
        )}
      </section>

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
            {!selecting && roomPendings.some((x) => x.id === p.id) && <span className="pending-badge">⏳ Por reemplazar</span>}
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
                  className="card-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    openMove(p)
                  }}
                >
                  Mover
                </button>
                <button
                  className="card-btn"
                  onClick={(e) => {
                    e.stopPropagation()
                    onReplace(p)
                  }}
                >
                  Reemplazar
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

      {notice && <div className="move-toast">{notice}</div>}

      {moving && (
        <div className="sheet-backdrop" onClick={() => !moveBusy && setMoving(null)}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="Mover foto" onClick={(e) => e.stopPropagation()}>
            <div className="sheet-head">
              <strong>Mover «{moving.name}» a…</strong>
              <button className="btn" onClick={() => setMoving(null)} disabled={moveBusy}>Cancelar</button>
            </div>
            {roomChoices === null && <p className="hint">Cargando salas…</p>}
            {roomChoices?.length === 0 && <p className="hint">No hay otras salas. Crea una con «Nuevo cuarto» en la casa.</p>}
            <div className="sheet-list">
              {roomChoices?.map((r) => (
                <button key={r.id} className="sheet-item" disabled={moveBusy} onClick={() => doMove(r)}>
                  {r.cover ? (
                    <img src={thumbUrl(r.cover, 120)} alt="" draggable={false} onError={(e) => (e.currentTarget.style.visibility = 'hidden')} />
                  ) : (
                    <span className="sheet-noimg" />
                  )}
                  <span>{r.name}</span>
                </button>
              ))}
            </div>
          </div>
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
