/**
 * Bot Mode's surface contract, asserted by running the real `register()`
 * against a recording plugin context:
 *
 *  - the roster is the `/bots` route's LIST COLUMN, paired with an activity-bar
 *    entry. No new pane is registered: the sessions zone must not grow a
 *    会话 | 机器人 tab strip. The nav label follows locale changes.
 *  - Bot Mode never registers an extra pane. Schedules have their own activity-
 *    bar route; opening a bot must leave only the standing list and main area.
 */

import type * as HermesSdk from '@hermes/plugin-sdk'
import type { PluginContext } from '@hermes/plugin-sdk'
import { atom } from 'nanostores'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type * as DataModule from './data'
import type * as RoutingModule from './routing'

const mocks = vi.hoisted(() => ({
  botChatOwnsWorkspace: vi.fn(() => false),
  paneVisibility: vi.fn(),
  sessionOwnsWorkspace: vi.fn(() => false),
  setWorkspaceScope: vi.fn(),
  undismissPane: vi.fn()
}))

vi.mock('@hermes/plugin-sdk', async importOriginal => {
  const original = await importOriginal<typeof HermesSdk>()

  return {
    ...original,
    host: {
      ...original.host,
      onEvent: undefined,
      paneVisibility: mocks.paneVisibility,
      setWorkspaceScope: mocks.setWorkspaceScope,
      undismissPane: mocks.undismissPane
    }
  }
})

// Everything below is a boundary this test does not exercise: clocks, sockets,
// storage sweeps and the panes' own render trees.
vi.mock('./avatar', () => ({ startFaceClock: vi.fn(), stopFaceClock: vi.fn() }))
vi.mock('./relay', () => ({ startBotRelay: vi.fn(), stopBotRelay: vi.fn() }))
vi.mock('./session-sweep', () => ({ startHideSweepScheduler: vi.fn() }))
vi.mock('./canonical-chat', () => ({ isCanonicalChatOnScreen: () => false, openBotCanonicalChat: vi.fn() }))
vi.mock('./chat-empty', () => ({ BotChatEmpty: () => null }))
vi.mock('./bots-page', () => ({ BotsPage: () => null }))
vi.mock('./hygiene', () => ({ annotateOrphanedGroupChatMembers: () => ({ changed: false, rooms: {} }) }))
vi.mock('./cron', () => ({ bindProfileSync: () => () => undefined, RoutinesPane: () => null }))
vi.mock('./roster-pane', () => ({
  botChatOwnsWorkspace: mocks.botChatOwnsWorkspace,
  BotsPane: () => null,
  releaseStaleOpenBotChat: vi.fn(),
  selectedRosterBot: () => null,
  sessionOwnsWorkspace: mocks.sessionOwnsWorkspace
}))
vi.mock('./group-chat', async () => {
  const { atom: nanoAtom } = await import('nanostores')

  return {
    $groupChats: nanoAtom({}),
    $groupChatWorkspace: nanoAtom(null),
    assignLegacyThreads: (log: unknown[]) => log,
    handleSessionsGatewayTransition: vi.fn(),
    pullGroupChatServerState: async () => false,
    scheduleGroupChatServerSync: vi.fn(),
    setGroupChatSyncDisposed: vi.fn(),
    stopGroupChatServerSync: vi.fn(),
    sweepGroupChatMembersForRemovedConnection: vi.fn(),
    updateGroupChat: vi.fn()
  }
})
vi.mock('./data', async importOriginal => {
  const original = await importOriginal<typeof DataModule>()

  return { ...original, migrateBotMeta: async () => undefined }
})
vi.mock('./routing', async importOriginal => {
  const original = await importOriginal<typeof RoutingModule>()

  return { ...original, setBotsWorkspaceOwner: vi.fn() }
})

const plugin = (await import('./plugin')).default
const { $botsPageActive } = await import('./bot-state')

interface Registration {
  area: string
  data?: Record<string, unknown>
  id: string
}

/** A recording `PluginContext`: registrations, their disposers, teardown, and
 *  a locale-change emitter for the nav row's re-registration. */
function recordingContext() {
  const disposers: (() => void)[] = []
  const localeListeners: (() => void)[] = []
  const registrations: Registration[] = []
  const unregisters = new Map<string, () => void>()

  const ctx = {
    i18n: {
      onLocaleChange: (fn: () => void) => {
        localeListeners.push(fn)

        return () => undefined
      },
      register: () => () => undefined,
      t: (key: string) => key
    },
    onDispose: (fn: () => void) => disposers.push(fn),
    register: (registration: Registration) => {
      registrations.push(registration)

      const unregister = vi.fn(() => {
        registrations.splice(registrations.indexOf(registration), 1)
      })

      unregisters.set(registration.id, unregister)

      return unregister
    },
    storage: { get: async () => undefined, set: async () => undefined }
  }

  return {
    ctx: ctx as unknown as PluginContext,
    dispose: () => disposers.forEach(fn => fn()),
    emitLocaleChange: () => localeListeners.forEach(fn => fn()),
    find: (id: string) => registrations.find(registration => registration.id === id),
    unregisters
  }
}

/** Nanostore stand-ins for the SDK's per-pane visibility stores. */
function paneStores() {
  const stores = new Map<string, ReturnType<typeof atom<boolean>>>()

  mocks.paneVisibility.mockImplementation((id: string) => {
    if (!stores.has(id)) {
      stores.set(id, atom(false))
    }

    return stores.get(id)
  })

  return (id: string) => {
    mocks.paneVisibility(id)

    return stores.get(id)!
  }
}

/** The plugin defers one reconcile to a macrotask so it never re-enters the
 *  tree store mid-mutation. */
const settle = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  vi.clearAllMocks()
  $botsPageActive.set(false)
  mocks.botChatOwnsWorkspace.mockReturnValue(false)
  mocks.sessionOwnsWorkspace.mockReturnValue(false)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('the roster surface', () => {
  it('registers a route-owned list and activity-bar entry, and no extra pane', () => {
    paneStores()

    const harness = recordingContext()

    plugin.register(harness.ctx)

    expect(harness.find('pane')).toBeUndefined()

    const page = harness.find('page')!
    expect(page.area).toBe('routes')
    expect(page.data!.path).toBe('/bots')
    expect(page.data!.list).toEqual({ render: expect.any(Function), workspaceMode: 'bots' })

    const nav = harness.find('nav')!
    expect(nav.area).toBe('sidebar.nav')
    expect(nav.data!.path).toBe('/bots')
    expect(nav.data!.codicon).toBe('hubot')

    harness.dispose()
  })

  it('re-registers the nav row on a locale change so the label follows it', () => {
    paneStores()

    const harness = recordingContext()

    plugin.register(harness.ctx)

    const first = harness.find('nav')!
    const disposeFirst = harness.unregisters.get('nav')!

    harness.emitLocaleChange()

    // A fresh registration replaces the old one under the same id.
    expect(harness.find('nav')).not.toBe(first)
    expect(disposeFirst).toHaveBeenCalled()

    harness.dispose()
  })
})

describe('two-pane Bot Mode', () => {
  it('never registers or reopens a third pane when a bot conversation owns main', async () => {
    paneStores()
    const harness = recordingContext()
    mocks.botChatOwnsWorkspace.mockReturnValue(true)
    $botsPageActive.set(true)

    try {
      plugin.register(harness.ctx)
      await settle()
      expect(harness.find('routines')).toBeUndefined()
      expect(mocks.undismissPane).not.toHaveBeenCalled()
    } finally {
      harness.dispose()
    }
  })
})

describe('Bot Mode lifecycle teardown', () => {
  it('stops ownership listeners when disabled', async () => {
    paneStores()
    const harness = recordingContext()
    plugin.register(harness.ctx)
    await settle()
    harness.dispose()
    $botsPageActive.set(true)
    $botsPageActive.set(false)
    expect(mocks.setWorkspaceScope).not.toHaveBeenCalled()
  })
})

describe('leaving the bots world', () => {
  it('strands the workspace owner once nothing holds Bot Mode (#120277)', async () => {
    paneStores()

    const harness = recordingContext()
    const { $pendingBotOpen } = await import('./shared')

    plugin.register(harness.ctx)
    await settle()
    $botsPageActive.set(true)
    $pendingBotOpen.set({ generation: 1, key: 'local::bravo' })

    // An open in flight IS the bots world: the page unmounts on the way to the
    // session it just opened, and reading that alone as "left" would bump the
    // very generation the open is racing.
    $botsPageActive.set(false)

    expect($pendingBotOpen.get()).not.toBeNull()
    expect(mocks.setWorkspaceScope).not.toHaveBeenCalled()

    // The open settled into nothing (it failed). Now the leave is real: the
    // pending booking drops and the workspace goes back to Sessions.
    $pendingBotOpen.set(null)

    expect($pendingBotOpen.get()).toBeNull()
    expect(mocks.setWorkspaceScope).toHaveBeenCalledWith('sessions')

    harness.dispose()
  })
})

describe('a desktop without host.paneVisibility', () => {
  it('does not create a third pane on older SDKs either', async () => {
    const { host } = await import('@hermes/plugin-sdk')
    const restore = host.paneVisibility

    // @ts-expect-error modelling an older SDK that lacks the export entirely
    host.paneVisibility = undefined

    const harness = recordingContext()

    plugin.register(harness.ctx)

    expect(harness.find('routines')).toBeUndefined()

    harness.dispose()
    host.paneVisibility = restore
  })
})
