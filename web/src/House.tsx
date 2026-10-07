import { useEffect, useRef, useState } from 'react'
import type { Room } from './api'

interface Props {
  rooms: Room[]
  onEnter: (room: Room) => void
}

// Medidas del plano en % de la casa: cuartos arriba (0-40), pasillo (40-60), cuartos abajo (60-100).
const HALL_TOP = 40
const HALL_BOTTOM = 60
const MARGIN = 3
const SPEED = 45 // % por segundo

type Side = 'top' | 'bottom'
type Placed = { room: Room; col: number; side: Side }

function layout(rooms: Room[]) {
  const topCount = Math.ceil(rooms.length / 2)
  const placed: Placed[] = rooms.map((room, i) =>
    i < topCount
      ? { room, col: i, side: 'top' as Side }
      : { room, col: i - topCount, side: 'bottom' as Side },
  )
  const cols = Math.max(topCount, rooms.length - topCount, 1)
  return { placed, cols }
}

const MOVES: Record<string, [number, number]> = {
  ArrowLeft: [-1, 0], a: [-1, 0],
  ArrowRight: [1, 0], d: [1, 0],
  ArrowUp: [0, -1], w: [0, -1],
  ArrowDown: [0, 1], s: [0, 1],
}

const normalizeKey = (key: string) => (key.length === 1 ? key.toLowerCase() : key)

export default function House({ rooms, onEnter }: Props) {
  const { placed, cols } = layout(rooms)
  const colWidth = 100 / cols

  const [pos, setPos] = useState({ x: 50, y: 50 })
  const posRef = useRef(pos)
  const keys = useRef(new Set<string>())
  const target = useRef<{ x: number; y: number; enter?: Room } | null>(null)

  // Refs para que el bucle de animacion vea siempre los datos actuales.
  const stateRef = useRef({ placed, cols, onEnter })
  stateRef.current = { placed, cols, onEnter }

  const roomAt = (x: number, y: number): Room | undefined => {
    const { placed, cols } = stateRef.current
    const col = Math.min(Math.floor(x / (100 / cols)), cols - 1)
    const side: Side = y < 50 ? 'top' : 'bottom'
    return placed.find((p) => p.col === col && p.side === side)?.room
  }
  const active = roomAt(pos.x, pos.y)

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLElement && e.target.closest('input, textarea')) return
      const key = normalizeKey(e.key)
      if (key in MOVES) {
        e.preventDefault()
        target.current = null
        keys.current.add(key)
      } else if (key === 'Enter' || key === 'e') {
        const room = roomAt(posRef.current.x, posRef.current.y)
        if (room) stateRef.current.onEnter(room)
      }
    }
    const onKeyUp = (e: KeyboardEvent) => {
      keys.current.delete(normalizeKey(e.key))
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)

    let last = performance.now()
    let frame = requestAnimationFrame(function tick(now) {
      const dt = Math.min((now - last) / 1000, 0.05)
      last = now
      let { x, y } = posRef.current
      let dx = 0
      let dy = 0
      for (const k of keys.current) {
        dx += MOVES[k][0]
        dy += MOVES[k][1]
      }

      if (target.current) {
        const t = target.current
        const vx = t.x - x
        const vy = t.y - y
        const dist = Math.hypot(vx, vy)
        if (dist < 0.8) {
          x = t.x
          y = t.y
          const room = t.enter
          target.current = null
          if (room) stateRef.current.onEnter(room)
        } else {
          x += (vx / dist) * SPEED * dt
          y += (vy / dist) * SPEED * dt
        }
      } else if (dx || dy) {
        // Empujar contra el borde del pasillo donde hay una puerta entra al cuarto.
        const atTop = y <= HALL_TOP + MARGIN + 0.1
        const atBottom = y >= HALL_BOTTOM - MARGIN - 0.1
        if ((dy < 0 && atTop) || (dy > 0 && atBottom)) {
          const room = roomAt(x, dy < 0 ? HALL_TOP - 1 : HALL_BOTTOM + 1)
          if (room) {
            keys.current.clear()
            stateRef.current.onEnter(room)
          }
        }
        const len = Math.hypot(dx, dy)
        x += (dx / len) * SPEED * dt
        y += (dy / len) * SPEED * dt
      }

      x = Math.min(Math.max(x, MARGIN), 100 - MARGIN)
      y = Math.min(Math.max(y, HALL_TOP + MARGIN), HALL_BOTTOM - MARGIN)
      if (x !== posRef.current.x || y !== posRef.current.y) {
        posRef.current = { x, y }
        setPos({ x, y })
      }
      frame = requestAnimationFrame(tick)
    })

    return () => {
      cancelAnimationFrame(frame)
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [])

  const walkTo = (p: Placed) => {
    const x = p.col * colWidth + colWidth / 2
    const y = p.side === 'top' ? HALL_TOP + MARGIN : HALL_BOTTOM - MARGIN
    keys.current.clear()
    target.current = { x, y, enter: p.room }
  }

  const onHallClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.parentElement!.getBoundingClientRect()
    keys.current.clear()
    target.current = {
      x: ((e.clientX - rect.left) / rect.width) * 100,
      y: ((e.clientY - rect.top) / rect.height) * 100,
    }
  }

  return (
    <div className="house-wrap">
      <div className="house">
        {placed.map((p) => (
          <button
            key={p.room.id}
            className={`room${active?.id === p.room.id ? ' active' : ''}`}
            style={{
              left: `${p.col * colWidth}%`,
              width: `${colWidth}%`,
              top: p.side === 'top' ? '0%' : `${HALL_BOTTOM}%`,
              height: `${p.side === 'top' ? HALL_TOP : 100 - HALL_BOTTOM}%`,
            }}
            onClick={() => walkTo(p)}
          >
            <span className="room-name">{p.room.name}</span>
            <span className={`door door-${p.side}`} />
          </button>
        ))}

        <div
          className="hall"
          style={{ top: `${HALL_TOP}%`, height: `${HALL_BOTTOM - HALL_TOP}%` }}
          onClick={onHallClick}
        />

        <div className="player" style={{ left: `${pos.x}%`, top: `${pos.y}%` }} />
      </div>

      <p className="hint">
        {active
          ? `Pulsa Enter, empuja hacia la puerta o haz clic para entrar a «${active.name}»`
          : 'Muévete con las flechas (o WASD) o haz clic en el pasillo'}
      </p>
    </div>
  )
}
