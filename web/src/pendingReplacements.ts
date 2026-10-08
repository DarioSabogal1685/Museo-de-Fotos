/**
 * Fotos que el usuario mando a su galeria para editarlas y que esperan su version editada.
 * Se guardan en el navegador para que sigan ahi aunque la pagina se cierre mientras se edita en otra app.
 */
export interface Pending {
  id: string
  name: string
  roomId: string
  at: number
}

const KEY = 'museo-reemplazos'

function read(): Pending[] {
  try {
    const list = JSON.parse(localStorage.getItem(KEY) ?? '[]') as Pending[]
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function write(list: Pending[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list))
  } catch {
    /* sin almacenamiento disponible: el aviso solo dura mientras la pagina siga abierta */
  }
}

export const loadPending = (): Pending[] => read()

/** Marca una foto como en espera (si ya lo estaba, solo se actualiza). */
export function addPending(p: Pending): Pending[] {
  const list = [...read().filter((x) => x.id !== p.id), p]
  write(list)
  return list
}

export function removePending(id: string): Pending[] {
  const list = read().filter((x) => x.id !== id)
  write(list)
  return list
}
