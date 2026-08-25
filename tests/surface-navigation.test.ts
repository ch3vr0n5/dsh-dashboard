import { describe, expect, it, vi } from 'vitest'
import { DashboardUiController } from '../src/client/controller.ts'
import {
  announcePluginSurfaceOpen,
  closeWhenOtherPluginSurfaceOpens,
} from '../src/client/surface-navigation.ts'

describe('exclusive plugin surface navigation', () => {
  it('closes the current plugin when another plugin surface opens', () => {
    const target = new EventTarget()
    const dashboard = new DashboardUiController(() => { announcePluginSurfaceOpen('dsh-dashboard', target) })
    const close = vi.spyOn(dashboard, 'close')
    const dispose = closeWhenOtherPluginSurfaceOpens('dsh-dashboard', dashboard.close, target)

    dashboard.open()
    expect(dashboard.getSnapshot()).toBe(true)
    announcePluginSurfaceOpen('gibb-services', target)

    expect(close).toHaveBeenCalledOnce()
    expect(dashboard.getSnapshot()).toBe(false)
    dispose()
  })

  it('does not close itself when announcing its own open transition', () => {
    const target = new EventTarget()
    const dashboard = new DashboardUiController(() => { announcePluginSurfaceOpen('dsh-dashboard', target) })
    const dispose = closeWhenOtherPluginSurfaceOpens('dsh-dashboard', dashboard.close, target)

    dashboard.open()

    expect(dashboard.getSnapshot()).toBe(true)
    dispose()
  })
})
