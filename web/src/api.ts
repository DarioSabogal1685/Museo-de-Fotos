export interface Room {
  id: string
  name: string
}

export interface PersonTag {
  name: string
  /** Posicion del punto sobre la foto, de 0 a 1. Sin punto, la persona va al final de la lista. */
  x?: number
  y?: number
}

export interface PhotoTags {
  place?: string
  /** Siempre ordenadas de izquierda a derecha. */
  people: PersonTag[]
  /** Grupo de fotos al que pertenece; su nombre es el nombre del negativo. */
  group?: string
}

export interface TagSuggestions {
  people: string[]
  places: string[]
  /** Nombres de grupo (de negativo) ya usados. */
  groups: string[]
}

export interface Photo {
  id: string
  name: string
  createdTime: string
  tags?: PhotoTags
  /** Tamano en bytes y huella MD5 del contenido (para verificar descargas). */
  size?: number
  md5?: string
  /** Cambia al editar la foto; se usa para saltarse la cache del navegador. */
  modifiedTime?: string
  width?: number
  height?: number
}

// Sin VITE_API_URL la web funciona en modo demo, con cuartos y fotos de ejemplo.
const API: string | undefined = import.meta.env.VITE_API_URL || undefined
export const DEMO = !API

const DEMO_ROOMS: Room[] = ['Sala', 'Comedor', 'Cocina', 'Biblioteca', 'Jardín', 'Estudio', 'Terraza'].map(
  (name, i) => ({ id: `demo${i}`, name }),
)

/** Imagen de ejemplo generada a partir del id (degradado + etiqueta). */
function demoImage(id: string, w: number, h: number): string {
  let hash = 0
  for (const c of id) hash = (hash * 31 + c.charCodeAt(0)) % 360
  const label = id.replace(/^demo(\d+)-(\d+)$/, (_, r, p) => `${DEMO_ROOMS[Number(r)]?.name ?? ''} ${Number(p) + 1}`)
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">` +
    `<stop offset="0" stop-color="hsl(${hash},60%,45%)"/><stop offset="1" stop-color="hsl(${(hash + 60) % 360},65%,25%)"/>` +
    `</linearGradient></defs><rect width="100%" height="100%" fill="url(#g)"/>` +
    `<text x="50%" y="50%" fill="#fff" fill-opacity=".85" font-family="sans-serif" font-size="${Math.round(w / 12)}" ` +
    `text-anchor="middle" dominant-baseline="middle">${label}</text></svg>`
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`
}

const version = (v?: string) => (v ? `&v=${encodeURIComponent(v)}` : '')

export const thumbUrl = (id: string, w = 400, v?: string) =>
  DEMO ? demoImage(id, w, w) : `${API}/api/photos/${id}/thumb?w=${w}${version(v)}`
export const photoUrl = (id: string, v?: string) =>
  DEMO ? demoImage(id, 1600, 1066) : `${API}/api/photos/${id}?${version(v).slice(1)}`

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, init)
  if (!res.ok) {
    const data = await res.json().catch(() => ({}))
    throw new Error(data.error ?? `Error ${res.status}`)
  }
  return res.json()
}

const auth = (token: string) => ({ Authorization: `Bearer ${token}` })

const demoOnly = () => Promise.reject(new Error('Modo demo: conecta Google Drive para crear cuartos y subir fotos'))

export const fetchRooms = () => (DEMO ? Promise.resolve(DEMO_ROOMS) : request<Room[]>('/api/rooms'))

export const fetchPhotos = (roomId: string) =>
  DEMO
    ? Promise.resolve(
        Array.from({ length: 12 }, (_, i) => ({
          id: `${roomId}-${i}`,
          name: `Foto ${i + 1}`,
          createdTime: new Date().toISOString(),
        })),
      )
    : request<Photo[]>(`/api/rooms/${roomId}/photos`)

export const createRoom = (name: string, token: string) =>
  DEMO
    ? demoOnly()
    : request<Room>('/api/rooms', {
        method: 'POST',
        headers: { ...auth(token), 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })

export function uploadPhoto(roomId: string, file: File, token: string) {
  if (DEMO) return demoOnly()
  const body = new FormData()
  body.append('file', file)
  return request<Photo>(`/api/rooms/${roomId}/photos`, {
    method: 'POST',
    headers: auth(token),
    body,
  })
}

export function deletePhoto(id: string, token: string) {
  if (DEMO) return demoOnly()
  return request<{ ok: true }>(`/api/photos/${id}`, { method: 'DELETE', headers: auth(token) })
}

/** Cambia el nombre y/o las etiquetas (personas y lugar) sin tocar la imagen. */
export function updatePhotoMeta(id: string, changes: { name?: string; tags?: PhotoTags }, token: string) {
  if (DEMO) return demoOnly()
  return request<Photo>(`/api/photos/${id}`, {
    method: 'PATCH',
    headers: { ...auth(token), 'Content-Type': 'application/json' },
    body: JSON.stringify(changes),
  })
}

/** Personas ordenadas de izquierda a derecha; las que no tienen punto van al final. */
export function sortLeftToRight<T extends { x?: number }>(people: T[]): T[] {
  return [...people].sort((a, b) => (a.x ?? Infinity) - (b.x ?? Infinity))
}

/** Nombres, lugares y grupos ya guardados, para el texto predictivo. */
export const fetchTagSuggestions = (): Promise<TagSuggestions> =>
  DEMO
    ? Promise.resolve({
        people: ['Ana', 'Luis', 'María'],
        places: ['Casa', 'Playa', 'Bogotá'],
        groups: ['Negativo 1', 'Negativo 2'],
      })
    : request<TagSuggestions>('/api/tags')

/** Reemplaza la imagen de una foto existente (y opcionalmente su nombre). */
export function replacePhoto(id: string, file: File, name: string, token: string) {
  if (DEMO) return demoOnly()
  const body = new FormData()
  body.append('file', file)
  body.append('name', name)
  return request<Photo>(`/api/photos/${id}`, { method: 'PUT', headers: auth(token), body })
}

/** Descarga la foto completa para editarla. */
export async function fetchPhotoBlob(id: string, v?: string): Promise<Blob> {
  const res = await fetch(photoUrl(id, v))
  if (!res.ok) throw new Error('No se pudo descargar la foto')
  return res.blob()
}

/** Olvida la clave guardada (por ejemplo, si el servidor la rechazo). */
export function clearAdminToken() {
  try {
    sessionStorage.removeItem('adminToken')
  } catch {
    /* sin almacenamiento disponible */
  }
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
