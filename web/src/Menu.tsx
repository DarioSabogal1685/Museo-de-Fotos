import { useEffect, useRef, useState } from 'react'
import NegativeDeveloper from './NegativeDeveloper'

interface Props {
  /** Cuarto donde se esta (se preselecciona al guardar una foto revelada). */
  currentRoomId?: string
}

type UpdateState =
  | { status: 'idle' }
  | { status: 'checking' }
  | { status: 'latest' }
  | { status: 'available'; version: string }
  | { status: 'error' }

/** Compara versiones tipo "0.5.0": positivo si a es mas nueva que b. */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] || 0) - (pb[i] || 0)
    if (diff !== 0) return diff
  }
  return 0
}

export default function Menu({ currentRoomId }: Props) {
  const [open, setOpen] = useState(false)
  const [developing, setDeveloping] = useState(false)
  const [update, setUpdate] = useState<UpdateState>({ status: 'idle' })
  const ref = useRef<HTMLDivElement>(null)

  // Pide version.json sin cache y lo compara con la version que esta abierta.
  const checkForUpdates = async () => {
    setUpdate({ status: 'checking' })
    try {
      const res = await fetch(`${import.meta.env.BASE_URL}version.json?t=${Date.now()}`, { cache: 'no-store' })
      if (!res.ok) throw new Error(String(res.status))
      const { version } = (await res.json()) as { version?: string }
      if (!version) throw new Error('sin version')
      setUpdate(compareVersions(version, __APP_VERSION__) > 0 ? { status: 'available', version } : { status: 'latest' })
    } catch {
      setUpdate({ status: 'error' })
    }
  }

  // Recarga con un parametro nuevo en la URL para saltarse la pagina guardada en cache.
  const applyUpdate = (version: string) => {
    window.location.replace(`${window.location.pathname}?v=${encodeURIComponent(version)}`)
  }

  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onClick)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu" ref={ref}>
      <button
        className="btn menu-button"
        aria-label="Menú"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className="dots" aria-hidden="true">⋮</span>
      </button>

      {open && (
        <div className="menu-panel" role="menu">
          <button
            className="menu-item menu-info"
            role="menuitem"
            disabled={update.status === 'checking'}
            onClick={checkForUpdates}
          >
            Versión {__APP_VERSION__}
            <small className="menu-sub">
              {update.status === 'idle' && 'Toca para buscar actualizaciones'}
              {update.status === 'checking' && 'Buscando…'}
              {update.status === 'latest' && '✓ Tienes la última versión'}
              {update.status === 'available' && `Hay una versión nueva: ${update.version}`}
              {update.status === 'error' && 'No se pudo comprobar. Intenta de nuevo.'}
            </small>
          </button>
          {update.status === 'available' && (
            <button className="menu-item menu-update" role="menuitem" onClick={() => applyUpdate(update.version)}>
              Actualizar ahora
            </button>
          )}
          <button
            className="menu-item"
            role="menuitem"
            onClick={() => {
              setOpen(false)
              setDeveloping(true)
            }}
          >
            Revelar negativo
          </button>
        </div>
      )}

      {developing && <NegativeDeveloper defaultRoomId={currentRoomId} onClose={() => setDeveloping(false)} />}
    </div>
  )
}
