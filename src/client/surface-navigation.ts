/** Browser-wide protocol for mutually exclusive plugin-owned primary surfaces. */
export const PLUGIN_SURFACE_OPEN_EVENT = 'dsh:plugin-surface-open'

export type PluginSurfaceOpenDetail = {
  readonly id: string
}

export function announcePluginSurfaceOpen(id: string, target: EventTarget = window): void {
  target.dispatchEvent(new CustomEvent<PluginSurfaceOpenDetail>(PLUGIN_SURFACE_OPEN_EVENT, {
    detail: { id },
  }))
}

export function closeWhenOtherPluginSurfaceOpens(
  id: string,
  close: () => void,
  target: EventTarget = window,
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<unknown>).detail
    if (isPluginSurfaceOpenDetail(detail) && detail.id !== id) close()
  }
  target.addEventListener(PLUGIN_SURFACE_OPEN_EVENT, listener)
  return () => { target.removeEventListener(PLUGIN_SURFACE_OPEN_EVENT, listener) }
}

function isPluginSurfaceOpenDetail(value: unknown): value is PluginSurfaceOpenDetail {
  return typeof value === 'object' && value !== null && 'id' in value && typeof value.id === 'string'
}
