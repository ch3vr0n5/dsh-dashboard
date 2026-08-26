import { describe, expect, it, vi } from 'vitest'
import { installPluginSurfaceNavigation, type SessionNavigation } from '../src/client/surface-navigation.ts'

describe('plugin and normal-session navigation', () => {
  it('keeps Voice open for its owned session and closes it once for a normal session', () => {
    const target = {}
    const originalOpen = vi.fn()
    const sessions: SessionNavigation = { open: originalOpen }
    let voice = false
    const closeVoice = vi.fn(() => { voice = false })
    const navigation = installPluginSurfaceNavigation({
      id: 'dsh-voice-interface',
      isOpen: () => voice,
      close: closeVoice,
      ownsSession: id => id === 'voice-private',
    }, sessions, target)

    navigation.open(); voice = true
    sessions.open('voice-private')
    expect(voice).toBe(true)
    expect(closeVoice).not.toHaveBeenCalled()

    sessions.open('normal-session')
    expect(voice).toBe(false)
    expect(closeVoice).toHaveBeenCalledOnce()
    expect(originalOpen).toHaveBeenCalledTimes(2)
    navigation.dispose()
  })

  it('closes the active surface on same-session navigation and survives repeated plugin cycles', () => {
    const target = {}
    const originalOpen = vi.fn()
    const sessions: SessionNavigation = { open: originalOpen }
    const state = { dashboard: false, services: false, voice: false }
    const closes = { dashboard: vi.fn(() => { state.dashboard = false }), services: vi.fn(() => { state.services = false }), voice: vi.fn(() => { state.voice = false }) }
    const dashboard = installPluginSurfaceNavigation({ id: 'dsh-dashboard', isOpen: () => state.dashboard, close: closes.dashboard }, sessions, target)
    const services = installPluginSurfaceNavigation({ id: 'gibb-services', isOpen: () => state.services, close: closes.services }, sessions, target)
    const voice = installPluginSurfaceNavigation({ id: 'dsh-voice-interface', isOpen: () => state.voice, close: closes.voice, ownsSession: id => id === 'voice-private' }, sessions, target)
    const sequence = [[dashboard, 'dashboard'], [services, 'services'], [voice, 'voice']] as const

    for (let pass = 0; pass < 20; pass += 1) {
      for (const [navigation, key] of sequence) {
        navigation.open(); state[key] = true
        expect(Object.values(state).filter(Boolean)).toHaveLength(1)
      }
    }

    for (const [navigation, key] of sequence) {
      navigation.open(); state[key] = true
      const before = closes[key].mock.calls.length
      sessions.open('already-selected-normal-session')
      expect(closes[key].mock.calls.length).toBe(before + 1)
      expect(Object.values(state).some(Boolean)).toBe(false)
    }
    expect(originalOpen).toHaveBeenCalledTimes(3)
    expect(originalOpen).toHaveBeenLastCalledWith('already-selected-normal-session')

    dashboard.dispose(); services.dispose(); voice.dispose()
    expect(sessions.open).toBe(originalOpen)
  })
})
