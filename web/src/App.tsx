import { useEffect, useState } from 'react'
import { createRoom, DEMO, fetchRooms, getAdminToken, type Room } from './api'
import House from './House'
import DownloadButton from './DownloadButton'
import Menu from './Menu'
import RoomView from './RoomView'

export default function App() {
  const [rooms, setRooms] = useState<Room[]>([])
  const [current, setCurrent] = useState<Room | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const load = () =>
    fetchRooms()
      .then(setRooms)
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false))

  useEffect(() => {
    load()
  }, [])

  const onNewRoom = async () => {
    const name = window.prompt('Nombre del nuevo cuarto')?.trim()
    if (!name) return
    const token = getAdminToken()
    if (!token) return
    try {
      await createRoom(name, token)
      setError(null)
      await load()
    } catch (e) {
      setError((e as Error).message)
    }
  }

  if (current) return <RoomView room={current} onBack={() => setCurrent(null)} />

  return (
    <>
      <header className="header">
        <h1>Museo de Fotos</h1>
        <div className="actions">
          {!DEMO && <DownloadButton />}
          <button className="btn primary" onClick={onNewRoom}>Nuevo cuarto</button>
          <Menu />
        </div>
      </header>
      {error && <p className="message error">{error}</p>}
      {loading && <p className="message">Cargando…</p>}
      {!loading && rooms.length === 0 && !error && (
        <p className="message">La casa está vacía. Crea el primer cuarto con «Nuevo cuarto».</p>
      )}
      {rooms.length > 0 && <House rooms={rooms} onEnter={setCurrent} />}
    </>
  )
}
