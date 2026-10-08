import { thumbUrl, type Room } from './api'

interface Props {
  rooms: Room[]
  onEnter: (room: Room) => void
}

// Medidas del plano en % de la casa: salas arriba (0-40), pasillo (40-60), salas abajo (60-100).
const HALL_TOP = 40
const HALL_BOTTOM = 60

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

export default function House({ rooms, onEnter }: Props) {
  const { placed, cols } = layout(rooms)
  const colWidth = 100 / cols

  return (
    <div className="house-wrap">
      <div className="house">
        {placed.map((p) => (
          <button
            key={p.room.id}
            className="room"
            style={{
              left: `${p.col * colWidth}%`,
              width: `${colWidth}%`,
              top: p.side === 'top' ? '0%' : `${HALL_BOTTOM}%`,
              height: `${p.side === 'top' ? HALL_TOP : 100 - HALL_BOTTOM}%`,
            }}
            onClick={() => onEnter(p.room)}
            aria-label={`Entrar a ${p.room.name}`}
          >
            {p.room.cover && (
              <img
                className="room-cover"
                src={thumbUrl(p.room.cover, 600)}
                alt=""
                loading="lazy"
                draggable={false}
                onError={(e) => {
                  e.currentTarget.style.display = 'none'
                }}
              />
            )}
            <span className="room-name">{p.room.name}</span>
            <span className={`door door-${p.side}`} />
          </button>
        ))}

        <div className="hall" style={{ top: `${HALL_TOP}%`, height: `${HALL_BOTTOM - HALL_TOP}%` }} />
      </div>

      <p className="hint">Toca una sala para entrar.</p>
    </div>
  )
}
