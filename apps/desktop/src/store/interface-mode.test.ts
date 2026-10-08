/**
 * Interface mode is a resolver input, never a preference writer. These tests
 * pin the precedence contract — sessionReveal ?? policy[mode] ?? userPref —
 * and the promise that matters to an existing install: Advanced is a no-op and
 * a round trip through Simple leaves every preference byte-identical.
 */

import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const MODE_KEY = 'hermes.desktop.interfaceMode.v1'

const loadStore = () => import('./interface-mode')

describe('interface mode persistence', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('never writes a record for Advanced, so an untouched install stays untouched', async () => {
    const { $interfaceMode, setInterfaceMode } = await loadStore()

    expect($interfaceMode.get()).toBe('advanced')
    setInterfaceMode('advanced')
    expect(window.localStorage.getItem(MODE_KEY)).toBeNull()

    setInterfaceMode('simple')
    expect(window.localStorage.getItem(MODE_KEY)).not.toBeNull()

    setInterfaceMode('advanced')
    expect(window.localStorage.getItem(MODE_KEY)).toBeNull()
  })

  it('restores Simple across a reload and treats anything else as Advanced', async () => {
    const first = await loadStore()

    first.setInterfaceMode('simple')
    vi.resetModules()
    expect((await loadStore()).$interfaceMode.get()).toBe('simple')

    window.localStorage.setItem(MODE_KEY, 'intermediate')
    vi.resetModules()
    expect((await loadStore()).$interfaceMode.get()).toBe('advanced')
  })
})

describe('modeBound resolver', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('falls through to the preference in Advanced, and writes reach the preference', async () => {
    const { modeBound } = await loadStore()
    const $pref = atom(true)
    const $bound = modeBound('statusbarVisible', $pref, value => $pref.set(value))

    expect($bound.get()).toBe(true)

    $bound.set(false)
    expect($pref.get()).toBe(false)
    expect($bound.get()).toBe(false)
  })

  it('shadows the preference in Simple without writing it, and lifts the shadow on the way back', async () => {
    const { modeBound, setInterfaceMode } = await loadStore()
    const $pref = atom(true)
    const $bound = modeBound('statusbarVisible', $pref, value => $pref.set(value))

    setInterfaceMode('simple')
    expect($bound.get()).toBe(false)
    expect($pref.get()).toBe(true)

    setInterfaceMode('advanced')
    expect($bound.get()).toBe(true)
  })

  it('routes a toggle made under a shadow to the session layer, cleared on the next mode change', async () => {
    const { modeBound, setInterfaceMode } = await loadStore()
    const $pref = atom(false)
    const $bound = modeBound('terminalOpen', $pref, value => $pref.set(value))

    setInterfaceMode('simple')
    $bound.set(true)
    expect($bound.get()).toBe(true)
    expect($pref.get()).toBe(false)

    setInterfaceMode('advanced')
    expect($bound.get()).toBe(false)

    setInterfaceMode('simple')
    expect($bound.get()).toBe(false)
  })

  it('drops a shadowed write made as layout intent: the mode decides what rests, the preference stays', async () => {
    const { asLayoutIntent, modeBound, setInterfaceMode } = await loadStore()
    const $pref = atom(false)
    const $bound = modeBound('terminalOpen', $pref, value => $pref.set(value))

    setInterfaceMode('simple')
    asLayoutIntent(() => $bound.set(true))
    expect($bound.get()).toBe(false)
    expect($pref.get()).toBe(false)

    setInterfaceMode('advanced')
    asLayoutIntent(() => $bound.set(true))
    expect($pref.get()).toBe(true)
  })

  it('leaves a surface Simple has no opinion on alone', async () => {
    const { modeBound, setInterfaceMode, $modeShadowed } = await loadStore()

    setInterfaceMode('simple')
    expect($modeShadowed('statusbarVisible').get()).toBe(true)

    setInterfaceMode('advanced')
    expect($modeShadowed('statusbarVisible').get()).toBe(false)

    const $pref = atom<'product' | 'technical'>('technical')
    const $bound = modeBound('toolViewMode', $pref, value => $pref.set(value))

    expect($bound.get()).toBe('technical')
  })

  it('keeps the profile rail available in Simple for multiple profiles or gateways', async () => {
    const { modeBound, setInterfaceMode, setModeContext } = await loadStore()
    const $pref = atom(true)
    const $bound = modeBound('profileRailVisible', $pref, value => $pref.set(value))

    setInterfaceMode('simple')
    expect($bound.get()).toBe(false)

    setModeContext({ profileCount: 2 })
    expect($bound.get()).toBe(true)

    setModeContext({ profileCount: 1 })
    expect($bound.get()).toBe(false)

    setModeContext({ connectionCount: 2 })
    expect($bound.get()).toBe(true)

    setModeContext({ connectionCount: 1 })
    expect($bound.get()).toBe(false)
  })
})

describe('tiers', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  it('shows untagged items everywhere and a tiered item only in its mode', async () => {
    const { shownInMode, $showsAdvancedChrome, setInterfaceMode } = await loadStore()

    const items = [
      { id: 'settings' },
      { id: 'hud', tier: 'advanced' as const },
      { id: 'side', tier: 'simple' as const }
    ]

    expect(items.filter(shownInMode('advanced')).map(item => item.id)).toEqual(['settings', 'hud'])
    expect(items.filter(shownInMode('simple')).map(item => item.id)).toEqual(['settings', 'side'])

    expect($showsAdvancedChrome.get()).toBe(true)
    setInterfaceMode('simple')
    expect($showsAdvancedChrome.get()).toBe(false)
  })
})

describe('the build decides where an untouched install rests', () => {
  const upstreamBridge = window.hermesDesktop

  const setEnterpriseBridge = (enterpriseEnabled: boolean) => {
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
      ...(upstreamBridge ?? {}),
      enterpriseEnabled
    }
  }

  beforeEach(() => {
    window.localStorage.clear()
    vi.resetModules()
  })

  afterEach(() => {
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = upstreamBridge
    vi.resetModules()
  })

  it('upstream still rests in Advanced', async () => {
    setEnterpriseBridge(false)

    const { DEFAULT_INTERFACE_MODE, $interfaceMode } = await loadStore()

    expect(DEFAULT_INTERFACE_MODE).toBe('advanced')
    expect($interfaceMode.get()).toBe('advanced')
  })

  it('the enterprise build rests in Simple, and still honours an explicit Advanced', async () => {
    setEnterpriseBridge(true)

    const { DEFAULT_INTERFACE_MODE, $interfaceMode, setInterfaceMode } = await loadStore()

    expect(DEFAULT_INTERFACE_MODE).toBe('simple')
    expect($interfaceMode.get()).toBe('simple')

    // The resting mode is still the ABSENCE of a record…
    setInterfaceMode('simple')
    expect(window.localStorage.getItem(MODE_KEY)).toBeNull()

    // …and picking Advanced is kept, not folded back into the default.
    setInterfaceMode('advanced')
    expect(window.localStorage.getItem(MODE_KEY)).toBe('advanced')
    vi.resetModules()
    expect((await loadStore()).$interfaceMode.get()).toBe('advanced')

    // Choosing the resting mode again clears the record.
    ;(await loadStore()).setInterfaceMode('simple')
    expect(window.localStorage.getItem(MODE_KEY)).toBeNull()
  })

  it('a stored value from the other build still wins over the new default', async () => {
    window.localStorage.setItem(MODE_KEY, 'advanced')
    setEnterpriseBridge(true)

    expect((await loadStore()).$interfaceMode.get()).toBe('advanced')
  })
})
