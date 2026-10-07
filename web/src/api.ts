export interface Room {
  id: string
  name: string
}

export interface Photo {
  id: string
  name: string
  createdTime: string
  width?: number
  height?: number
}

const API = import.meta.env.VITE_API_URL ?? 'http://localhost:8787'

export const thumbUrl = (id: string, w = 400) => `${API}/api/photos/${id}/thumb?w=${w}`
export const photoUrl = (id: string) => `${API}/api/photos/${id}`

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? `Error ${res.status}`)
  }
  return res.json()
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

export const fetchRooms = () => request<Room[]>('/api/rooms')

export const fetchPhotos = (roomId: string) => request<Photo[]>(`/api/rooms/${roomId}/photos`)

export const createRoom = (name: string, token: string) =>
  request<Room>('/api/rooms', {
    method: 'POST',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  })

export function uploadPhoto(roomId: string, file: File, token: string) {
  const body = new FormData()
  body.append('file', file)
  return request<Photo>(`/api/rooms/${roomId}/photos`, {
    method: 'POST',
    headers: auth(token),
    body,
  })
}

/** La clave de administrador se guarda solo mientras la pestaña este abierta. */
export function getAdminToken(): string | null {
  try {
    const saved = sessionStorage.getItem('adminToken')
    if (saved) return saved
    const entered = window.prompt('Clave de administrador')
    if (entered) sessionStorage.setItem('adminToken', entered)
    return entered
  } catch {
    return window.prompt('Clave de administrador')
  }
}
