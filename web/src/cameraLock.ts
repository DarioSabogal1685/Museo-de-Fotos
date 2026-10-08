/**
 * Bloquea (o libera) la exposicion y el balance de blancos de la camara.
 * Con la camara en automatico, el brillo y los colores cambian solos al mover el celular y la foto puede salir
 * distinta de lo que se ve; bloqueados, la vista previa y la foto coinciden.
 *
 * `extra` permite pedir otras restricciones (por ejemplo la resolucion) en la misma llamada, porque cada
 * applyConstraints reemplaza a la anterior y soltaria el bloqueo.
 *
 * Devuelve true si el dispositivo permitio bloquear/liberar; false si no lo soporta (por ejemplo, iPhone con Safari).
 */
export async function applyCameraSettings(
  track: MediaStreamTrack,
  options: { lock: boolean; extra?: MediaTrackConstraints },
): Promise<boolean> {
  const caps = (track.getCapabilities?.() ?? {}) as Record<string, unknown>
  const settings = track.getSettings() as Record<string, unknown>
  const modes = (key: string) => (Array.isArray(caps[key]) ? (caps[key] as string[]) : [])
  const wanted = options.lock ? 'manual' : 'continuous'

  const advanced: Record<string, unknown>[] = []

  if (modes('exposureMode').includes(wanted)) {
    const c: Record<string, unknown> = { exposureMode: wanted }
    if (options.lock) {
      if (typeof settings.exposureTime === 'number') c.exposureTime = settings.exposureTime
      if (typeof settings.iso === 'number') c.iso = settings.iso
    }
    advanced.push(c)
  }

  if (modes('whiteBalanceMode').includes(wanted)) {
    const c: Record<string, unknown> = { whiteBalanceMode: wanted }
    if (options.lock && typeof settings.colorTemperature === 'number') c.colorTemperature = settings.colorTemperature
    advanced.push(c)
  }

  try {
    await track.applyConstraints({
      ...(options.extra ?? {}),
      ...(advanced.length > 0 ? { advanced } : {}),
    } as MediaTrackConstraints)
  } catch {
    return false
  }
  return advanced.length > 0
}
