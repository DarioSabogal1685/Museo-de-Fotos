import { useEffect, useState } from 'react'
import {
  ensureFolder,
  fetchAllPhotos,
  folderReachable,
  getSavedFolder,
  hasPermission,
  planDownloads,
  supportsFolders,
  syncDownloads,
  type Plan,
  type SyncProgress,
  type SyncResult,
} from './downloads'

type Check =
  | { state: 'checking' }
  | { state: 'ready'; plan: Plan; total: number; diskMissing: boolean }
  | { state: 'error'; message: string }

export default function DownloadButton() {
  const [check, setCheck] = useState<Check>({ state: 'checking' })
  const [open, setOpen] = useState(false)
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState<SyncProgress | null>(null)
  const [result, setResult] = useState<SyncResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Al abrir la app, revisa cuantas fotos faltan por descargar.
  const refresh = async () => {
    setCheck({ state: 'checking' })
    try {
      const all = await fetchAllPhotos()
      let dir: FileSystemDirectoryHandle | null = null
      let diskMissing = false
      if (supportsFolders) {
        const saved = await getSavedFolder()
        // Sin permiso todavia (se pide al pulsar el boton) se usa solo la memoria local.
        if (saved && (await hasPermission(saved, false))) {
          if (await folderReachable(saved)) dir = saved
          else diskMissing = true
        }
      }
      setCheck({ state: 'ready', plan: await planDownloads(all, dir), total: all.length, diskMissing })
    } catch (e) {
      setCheck({ state: 'error', message: (e as Error).message })
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  const start = async (forcePick = false) => {
    setOpen(true)
    setRunning(true)
    setResult(null)
    setError(null)
    setProgress(null)
    try {
      let dir: FileSystemDirectoryHandle | null = null
      if (supportsFolders) {
        // Primero y sin esperas antes: el navegador solo deja elegir carpeta justo despues de un clic.
        dir = await ensureFolder(forcePick)
        if (!(await folderReachable(dir))) {
          throw new Error(
            `No encuentro la carpeta «${dir.name}». Si está en un disco externo, conéctalo y vuelve a intentar, o elige otra carpeta.`,
          )
        }
      }
      const all = await fetchAllPhotos()
      setResult(await syncDownloads(all, dir, setProgress))
      await refresh()
    } catch (e) {
      const err = e as Error
      if (err.name === 'AbortError') setOpen(false) // cerro el selector de carpeta
      else setError(err.name === 'SecurityError' ? 'El navegador no permite esa carpeta. Crea una carpeta nueva (por ejemplo «Museo de Fotos») en el disco y elígela.' : err.message)
    } finally {
      setRunning(false)
    }
  }

  const pending = check.state === 'ready' ? check.plan.pending.length : 0
  const label =
    check.state === 'checking'
      ? 'Revisando fotos…'
      : check.state === 'error'
        ? '⬇ Descargar fotos'
        : pending > 0
          ? `⬇ Descargar fotos (${pending})`
          : '✓ Fotos descargadas'

  return (
    <>
      <button
        className={`btn${pending > 0 ? ' primary' : ''}`}
        disabled={check.state === 'checking' || running}
        onClick={() => start()}
        title={check.state === 'ready' && check.diskMissing ? 'No encuentro el disco o la carpeta de descarga' : undefined}
      >
        {label}
      </button>
      {check.state === 'ready' && check.diskMissing && <span className="disk-warning">💾 Disco no conectado</span>}

      {open && (
        <div className="modal" role="dialog" aria-modal="true" aria-label="Descargar fotos">
          <div className="modal-head">
            <h2>Descargar fotos</h2>
            <button className="btn" onClick={() => setOpen(false)} disabled={running}>Cerrar</button>
          </div>

          <div className="modal-body">
            {running && !progress && !error && <p className="message">Preparando…</p>}

            {running && progress && (
              <>
                <p className="step-title">
                  Descargando {Math.min(progress.done + 1, progress.total)} de {progress.total}
                </p>
                <div className="progress-track"><div className="progress-fill" style={{ width: `${(progress.done / Math.max(progress.total, 1)) * 100}%` }} /></div>
                <p className="hint">{progress.current}</p>
                <p className="hint">No cierres esta ventana ni desconectes el disco hasta que termine.</p>
              </>
            )}

            {error && (
              <>
                <p className="message error">{error}</p>
                <div className="modal-actions">
                  <button className="btn primary" onClick={() => start()}>Reintentar</button>
                  {supportsFolders && <button className="btn" onClick={() => start(true)}>Elegir otra carpeta</button>}
                </div>
              </>
            )}

            {result && !running && (
              <>
                {result.failed.length === 0 ? (
                  <p className="light-hint light-good big">
                    {result.ok.length > 0
                      ? `✓ Se descargaron y verificaron ${result.ok.length} foto${result.ok.length === 1 ? '' : 's'}.`
                      : `✓ No había fotos nuevas. Las ${result.alreadyOk} foto${result.alreadyOk === 1 ? '' : 's'} ya estaban descargadas y siguen completas.`}
                  </p>
                ) : (
                  <p className="light-hint light-flat big">
                    Se verificaron {result.ok.length} de {result.total}. {result.failed.length} no se pudo descargar.
                  </p>
                )}

                {result.mode === 'folder' && result.ok.length > 0 && (
                  <p className="hint">
                    Guardadas en la carpeta «{result.folderName}», dentro de una subcarpeta por cuarto. Cada archivo se leyó
                    del disco y su tamaño coincide con el de Drive.
                    {result.alreadyOk > 0 && ` Otras ${result.alreadyOk} ya estaban y siguen correctas.`}
                  </p>
                )}
                {result.mode === 'browser' && (
                  <p className="hint">
                    Tu navegador no permite elegir carpeta, así que las fotos se guardaron en tu carpeta de Descargas. Llegaron
                    completas, pero desde aquí no puedo comprobar el archivo en el disco. Para guardar en un disco externo y
                    verificarlo, usa Chrome o Edge.
                  </p>
                )}

                {result.failed.length > 0 && (
                  <ul className="fail-list">
                    {result.failed.map((f) => (
                      <li key={f.name}><strong>{f.name}</strong>: {f.reason}</li>
                    ))}
                  </ul>
                )}

                <div className="modal-actions">
                  {result.failed.length > 0 && <button className="btn primary" onClick={() => start()}>Reintentar las fallidas</button>}
                  {supportsFolders && <button className="btn" onClick={() => start(true)}>Cambiar carpeta o disco</button>}
                  <button className="btn" onClick={() => setOpen(false)}>Listo</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}
    </>
  )
}
