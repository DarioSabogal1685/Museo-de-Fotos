import { useEffect, useState } from 'react'
import Menu from './Menu'
import { fetchPhotos, getAdminToken, photoUrl, thumbUrl, uploadPhoto, type Photo, type Room } from './api'

interface Props {
  room: Room
  onBack: () => void
}

export default function RoomView({ room, onBack }: Props) {
  const [photos, setPhotos] = useState<Photo[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [uploading, setUploading] = useState(false)

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
  }, [selected, photos.length, onBack])

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

      <div className="grid">
        {photos.map((p, i) => (
          <button key={p.id} className="card" onClick={() => setSelected(i)}>
            <img src={thumbUrl(p.id)} alt={p.name} loading="lazy" />
          </button>
        ))}
      </div>

      {current && (
        <div className="lightbox" onClick={() => setSelected(null)}>
          <img src={photoUrl(current.id)} alt={current.name} />
          <p>{current.name} · {(selected ?? 0) + 1} / {photos.length}</p>
        </div>
      )}
    </>
  )
}
