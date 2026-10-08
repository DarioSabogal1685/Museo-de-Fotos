import { fetchPhotos, fetchRooms, photoUrl, type Photo, type Room } from './api'

export interface RemotePhoto {
  room: Room
  photo: Photo
}

/** Foto ya guardada en el equipo; sirve para saber que no hay que volver a bajarla. */
interface DownloadRecord {
  id: string
  /** Ruta dentro de la carpeta elegida: [cuarto, archivo]. */
  path: [string, string]
  md5?: string
  size: number
  at: number
  /** true si el archivo se leyo del disco para comprobarlo; false si solo se pudo descargar por el navegador. */
  verifiedOnDisk: boolean
}

/** Chrome y Edge permiten guardar directo en una carpeta (por ejemplo, de un disco externo). */
export const supportsFolders = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'

// --- Memoria local (IndexedDB): carpeta elegida y fotos ya descargadas ---
const DB_NAME = 'museo-descargas'

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      req.result.createObjectStore('handles')
      req.result.createObjectStore('records', { keyPath: 'id' })
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore<T>(store: string, mode: IDBTransactionMode, run: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb()
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = run(db.transaction(store, mode).objectStore(store))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    })
  } finally {
    db.close()
  }
}

async function getRecords(): Promise<Map<string, DownloadRecord>> {
  const all = await withStore<DownloadRecord[]>('records', 'readonly', (s) => s.getAll())
  return new Map(all.map((r) => [r.id, r]))
}

const putRecord = (record: DownloadRecord) => withStore('records', 'readwrite', (s) => s.put(record))

export async function getSavedFolder(): Promise<FileSystemDirectoryHandle | null> {
  try {
    return (await withStore<FileSystemDirectoryHandle | undefined>('handles', 'readonly', (s) => s.get('dir'))) ?? null
  } catch {
    return null
  }
}

// --- Carpeta de destino ---
export async function hasPermission(dir: FileSystemDirectoryHandle, request: boolean): Promise<boolean> {
  const opts = { mode: 'readwrite' as const }
  try {
    if (dir.queryPermission && (await dir.queryPermission(opts)) === 'granted') return true
    if (request && dir.requestPermission) return (await dir.requestPermission(opts)) === 'granted'
  } catch {
    /* el disco puede no estar conectado */
  }
  return false
}

/** Comprueba que la carpeta (por ejemplo, en un disco externo) se pueda leer ahora mismo. */
export async function folderReachable(dir: FileSystemDirectoryHandle): Promise<boolean> {
  try {
    const entries = (dir as unknown as { keys(): AsyncIterable<string> }).keys()
    await entries[Symbol.asyncIterator]().next()
    return true
  } catch {
    return false
  }
}

async function chooseFolder(): Promise<FileSystemDirectoryHandle> {
  const dir = await window.showDirectoryPicker!({ mode: 'readwrite', id: 'museo-fotos' })
  await withStore('handles', 'readwrite', (s) => s.put(dir, 'dir'))
  return dir
}

/**
 * Devuelve la carpeta donde guardar: la recordada (pidiendo permiso otra vez si hace falta) o una nueva.
 * Debe llamarse justo al hacer clic, antes de cualquier otra espera, porque el navegador lo exige.
 */
export async function ensureFolder(forcePick = false): Promise<FileSystemDirectoryHandle> {
  if (!forcePick) {
    const saved = await getSavedFolder()
    if (saved && (await hasPermission(saved, true))) return saved
  }
  return chooseFolder()
}

// --- Lista de fotos y plan de descarga ---
export async function fetchAllPhotos(): Promise<RemotePhoto[]> {
  const rooms = await fetchRooms()
  const lists = await Promise.all(rooms.map((room) => fetchPhotos(room.id).then((photos) => photos.map((photo) => ({ room, photo })))))
  return lists.flat()
}

const sanitize = (name: string) =>
  // eslint-disable-next-line no-control-regex
  name.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/[. ]+$/, '').slice(0, 150) || 'sin-nombre'

/** El registro corresponde a la version actual de la foto (misma huella o, si no hay, mismo tamano). */
const isCurrent = (record: DownloadRecord, photo: Photo) =>
  photo.md5 ? record.md5 === photo.md5 : record.size === photo.size

async function sizeOnDisk(dir: FileSystemDirectoryHandle, path: [string, string]): Promise<number | null> {
  try {
    const roomDir = await dir.getDirectoryHandle(path[0])
    return (await (await roomDir.getFileHandle(path[1])).getFile()).size
  } catch {
    return null
  }
}

export interface Plan {
  pending: RemotePhoto[]
  /** Fotos ya descargadas que siguen en la carpeta con el tamano correcto. */
  upToDate: number
}

/** Decide que fotos faltan. Con carpeta accesible, comprueba ademas que los archivos sigan en el disco. */
export async function planDownloads(all: RemotePhoto[], dir: FileSystemDirectoryHandle | null): Promise<Plan> {
  const records = await getRecords()
  const pending: RemotePhoto[] = []
  let upToDate = 0
  for (const rp of all) {
    const record = records.get(rp.photo.id)
    if (!record || !isCurrent(record, rp.photo)) {
      pending.push(rp)
      continue
    }
    if (dir && record.verifiedOnDisk && (await sizeOnDisk(dir, record.path)) !== record.size) {
      pending.push(rp)
      continue
    }
    upToDate++
  }
  return { pending, upToDate }
}

// --- Descarga y verificacion ---
export interface SyncProgress {
  done: number
  total: number
  current: string
}

export interface SyncResult {
  mode: 'folder' | 'browser'
  folderName?: string
  /** Fotos que habia que bajar en esta pasada. */
  total: number
  /** Descargadas y comprobadas. */
  ok: string[]
  failed: { name: string; reason: string }[]
  /** Fotos que ya estaban y siguen correctas. */
  alreadyOk: number
}

async function exists(dir: FileSystemDirectoryHandle, name: string): Promise<boolean> {
  try {
    await dir.getFileHandle(name)
    return true
  } catch {
    return false
  }
}

const withSuffix = (name: string, id: string) =>
  name.includes('.') ? name.replace(/(\.[^.]+)$/, ` [${id.slice(0, 6)}]$1`) : `${name} [${id.slice(0, 6)}]`

async function downloadToFolder(dir: FileSystemDirectoryHandle, rp: RemotePhoto, previous?: DownloadRecord) {
  const { photo, room } = rp
  const roomName = sanitize(room.name)
  const roomDir = await dir.getDirectoryHandle(roomName, { create: true })

  // Si dos fotos se llaman igual, la segunda lleva un trozo de su id para no pisar a la primera.
  let fileName = previous?.path[0] === roomName ? previous.path[1] : sanitize(photo.name)
  if (!(previous?.path[0] === roomName) && (await exists(roomDir, fileName))) fileName = withSuffix(fileName, photo.id)

  const fileHandle = await roomDir.getFileHandle(fileName, { create: true })
  const res = await fetch(photoUrl(photo.id, photo.md5 ?? photo.modifiedTime))
  if (!res.ok || !res.body) throw new Error(`El servidor respondió ${res.status}`)

  // pipeTo escribe por partes y cierra el archivo al terminar; si falla, el archivo anterior queda intacto.
  await res.body.pipeTo(await fileHandle.createWritable())

  // Confirmacion: se vuelve a abrir el archivo desde el disco y se compara su tamano con el de Drive.
  const written = (await fileHandle.getFile()).size
  if (written === 0) throw new Error('El archivo quedó vacío')
  if (photo.size && written !== photo.size) throw new Error(`Tamaño incorrecto (${written} de ${photo.size} bytes)`)

  await putRecord({ id: photo.id, path: [roomName, fileName], md5: photo.md5, size: written, at: Date.now(), verifiedOnDisk: true })
}

async function downloadByBrowser(rp: RemotePhoto) {
  const { photo, room } = rp
  const res = await fetch(photoUrl(photo.id, photo.md5 ?? photo.modifiedTime))
  if (!res.ok) throw new Error(`El servidor respondió ${res.status}`)
  const blob = await res.blob()
  if (blob.size === 0) throw new Error('El archivo llegó vacío')
  if (photo.size && blob.size !== photo.size) throw new Error(`Llegó incompleta (${blob.size} de ${photo.size} bytes)`)

  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${sanitize(room.name)} - ${sanitize(photo.name)}`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 10_000)

  await putRecord({
    id: photo.id,
    path: [sanitize(room.name), sanitize(photo.name)],
    md5: photo.md5,
    size: blob.size,
    at: Date.now(),
    verifiedOnDisk: false,
  })
}

/** Baja las fotos que faltan, una por una, y devuelve el resultado de cada una. */
export async function syncDownloads(
  all: RemotePhoto[],
  dir: FileSystemDirectoryHandle | null,
  onProgress: (p: SyncProgress) => void,
): Promise<SyncResult> {
  const records = await getRecords()
  const plan = await planDownloads(all, dir)
  const result: SyncResult = {
    mode: dir ? 'folder' : 'browser',
    folderName: dir?.name,
    total: plan.pending.length,
    ok: [],
    failed: [],
    alreadyOk: plan.upToDate,
  }

  for (const [i, rp] of plan.pending.entries()) {
    onProgress({ done: i, total: plan.pending.length, current: rp.photo.name })
    try {
      if (dir) await downloadToFolder(dir, rp, records.get(rp.photo.id))
      else await downloadByBrowser(rp)
      result.ok.push(rp.photo.name)
    } catch (e) {
      result.failed.push({ name: rp.photo.name, reason: (e as Error).message || 'Error desconocido' })
    }
  }
  onProgress({ done: plan.pending.length, total: plan.pending.length, current: '' })
  return result
}
