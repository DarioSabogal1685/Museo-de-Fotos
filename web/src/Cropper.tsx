import { useRef } from 'react'

export interface Crop {
  x: number
  y: number
  w: number
  h: number
}

type Handle = 'move' | 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w'

const MIN = 0.05
const clamp = (v: number, lo: number, hi: number) => Math.min(Math.max(v, lo), Math.max(lo, hi))

/** Recuadro mas grande con la proporcion dada (ancho/alto), centrado. */
export function fitCrop(ratio: number, imgAspect: number): Crop {
  let w = 1
  let h = imgAspect / ratio
  if (h > 1) {
    h = 1
    w = ratio / imgAspect
  }
  return { x: (1 - w) / 2, y: (1 - h) / 2, w, h }
}

function resize(handle: Handle, start: Crop, dx: number, dy: number, k: number): Crop {
  if (handle === 'move') {
    return {
      ...start,
      x: clamp(start.x + dx, 0, 1 - start.w),
      y: clamp(start.y + dy, 0, 1 - start.h),
    }
  }
  const hasW = handle.includes('w')
  const hasE = handle.includes('e')
  const hasN = handle.includes('n')
  const hasS = handle.includes('s')

  // Proporcion fija: solo las esquinas, con la esquina opuesta como ancla.
  if (k > 0) {
    const anchorX = hasW ? start.x + start.w : start.x
    const anchorY = hasN ? start.y + start.h : start.y
    const maxW = hasW ? anchorX : 1 - anchorX
    const maxH = hasN ? anchorY : 1 - anchorY
    const rawW = hasW ? start.w - dx : start.w + dx
    const w = clamp(rawW, MIN, Math.min(maxW, maxH / k))
    const h = w * k
    return { x: hasW ? anchorX - w : anchorX, y: hasN ? anchorY - h : anchorY, w, h }
  }

  let { x, y, w, h } = start
  if (hasW) {
    const nx = clamp(start.x + dx, 0, start.x + start.w - MIN)
    w = start.x + start.w - nx
    x = nx
  }
  if (hasE) w = clamp(start.w + dx, MIN, 1 - start.x)
  if (hasN) {
    const ny = clamp(start.y + dy, 0, start.y + start.h - MIN)
    h = start.y + start.h - ny
    y = ny
  }
  if (hasS) h = clamp(start.h + dy, MIN, 1 - start.y)
  return { x, y, w, h }
}

interface Props {
  src: string
  /** ancho / alto de la imagen mostrada. */
  imgAspect: number
  /** Proporcion fija (ancho/alto) o null para recorte libre. */
  ratio: number | null
  crop: Crop
  onChange: (crop: Crop) => void
}

const ALL: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const CORNERS: Handle[] = ['nw', 'ne', 'se', 'sw']

export default function Cropper({ src, imgAspect, ratio, crop, onChange }: Props) {
  const rootRef = useRef<HTMLDivElement>(null)
  const drag = useRef<{ handle: Handle; px: number; py: number; start: Crop } | null>(null)
  const k = ratio ? imgAspect / ratio : 0

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    const handle = (e.target as HTMLElement).dataset.handle as Handle | undefined
    if (!handle) return
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    drag.current = { handle, px: e.clientX, py: e.clientY, start: crop }
  }

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current
    const rect = rootRef.current?.getBoundingClientRect()
    if (!d || !rect) return
    onChange(resize(d.handle, d.start, (e.clientX - d.px) / rect.width, (e.clientY - d.py) / rect.height, k))
  }

  const end = () => {
    drag.current = null
  }

  return (
    <div
      ref={rootRef}
      className="cropper"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <img src={src} alt="Negativo para recortar" draggable={false} />
      <div
        className="crop-box"
        data-handle="move"
        style={{
          left: `${crop.x * 100}%`,
          top: `${crop.y * 100}%`,
          width: `${crop.w * 100}%`,
          height: `${crop.h * 100}%`,
        }}
      >
        {(ratio ? CORNERS : ALL).map((h) => (
          <span key={h} className={`crop-handle h-${h}`} data-handle={h} />
        ))}
      </div>
    </div>
  )
}
