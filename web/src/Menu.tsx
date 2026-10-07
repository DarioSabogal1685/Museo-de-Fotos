import { useEffect, useRef, useState } from 'react'
import NegativeDeveloper from './NegativeDeveloper'

export default function Menu() {
  const [open, setOpen] = useState(false)
  const [developing, setDeveloping] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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
          <div className="menu-item menu-info" role="menuitem">
            Versión {__APP_VERSION__}
          </div>
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

      {developing && <NegativeDeveloper onClose={() => setDeveloping(false)} />}
    </div>
  )
}
