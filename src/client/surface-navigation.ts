/** Shared browser coordinator for plugin surfaces and normal Harness navigation. */
const COORDINATOR_KEY = Symbol.for('dsh.plugin-surface-coordinator.v2')

export interface SessionNavigation {
  open(id: unknown): void
}

type SurfaceRegistration = {
  readonly id: string
  readonly isOpen: () => boolean
  readonly close: () => void
  readonly ownsSession?: ((id: unknown) => boolean) | undefined
  readonly beforeSessionClose?: ((id: unknown) => void) | undefined
}

type Coordinator = {
  readonly entries: Map<symbol, SurfaceRegistration>
  sessions?: SessionNavigation | undefined
  originalOpen?: SessionNavigation['open'] | undefined
  wrappedOpen?: SessionNavigation['open'] | undefined
  openWasOwnProperty?: boolean | undefined
}

export interface PluginSurfaceNavigation {
  open(): void
  close(): void
  dispose(): void
}

export function installPluginSurfaceNavigation(
  registration: SurfaceRegistration,
  sessions: SessionNavigation,
  target: object = window,
): PluginSurfaceNavigation {
  const coordinator = coordinatorFor(target)
  installSessionBoundary(coordinator, sessions)
  const token = Symbol(registration.id)
  coordinator.entries.set(token, registration)

  return {
    open: () => {
      for (const entry of [...coordinator.entries.values()]) {
        if (entry.id !== registration.id && entry.isOpen()) entry.close()
      }
    },
    close: () => {},
    dispose: () => {
      coordinator.entries.delete(token)
      if (coordinator.entries.size === 0) restoreSessionBoundary(coordinator)
    },
  }
}

function coordinatorFor(target: object): Coordinator {
  const shared = target as Record<symbol, Coordinator | undefined>
  return shared[COORDINATOR_KEY] ??= { entries: new Map() }
}

function installSessionBoundary(coordinator: Coordinator, sessions: SessionNavigation): void {
  if (coordinator.sessions !== undefined) {
    if (coordinator.sessions !== sessions) throw new Error('plugin surfaces received different Harness session runtimes')
    return
  }
  const original = sessions.open
  const wrapped: SessionNavigation['open'] = function (id: unknown): void {
    for (const entry of [...coordinator.entries.values()]) {
      if (entry.isOpen() && !entry.ownsSession?.(id)) {
        entry.beforeSessionClose?.(id)
        entry.close()
      }
    }
    original.call(sessions, id)
  }
  coordinator.sessions = sessions
  coordinator.originalOpen = original
  coordinator.wrappedOpen = wrapped
  coordinator.openWasOwnProperty = Object.prototype.hasOwnProperty.call(sessions, 'open')
  sessions.open = wrapped
}

function restoreSessionBoundary(coordinator: Coordinator): void {
  const { sessions, originalOpen, wrappedOpen, openWasOwnProperty } = coordinator
  if (sessions !== undefined && originalOpen !== undefined && sessions.open === wrappedOpen) {
    if (openWasOwnProperty) sessions.open = originalOpen
    else delete (sessions as { open?: SessionNavigation['open'] }).open
  }
  coordinator.sessions = undefined
  coordinator.originalOpen = undefined
  coordinator.wrappedOpen = undefined
  coordinator.openWasOwnProperty = undefined
}
