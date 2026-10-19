import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { registry } from '@/contrib/registry'

import { findGroupOfPane, group } from './model'
import {
  $dismissedPanes,
  $hiddenTreePanes,
  $layoutTree,
  moveTreePane,
  removeTreePane,
  tabStripVisibleForGroup
} from './store'

// Two session tabs in main, drag the second one to the right edge: main is left
// a lone uncloseable workspace. That zone now trades its strip for a title band
// (no tab to switch to, no ✕ to carry), while the tile it split from keeps its
// own strip — a closeable tile with no neighbor IS stranded. Pins the store's
// answer (the one ⌘⌥T toggles against) across the gesture and its undo.

const disposers: (() => void)[] = []

beforeEach(() => {
  window.localStorage.clear()
  $dismissedPanes.set(new Set())
  $hiddenTreePanes.set(new Set())

  for (const [id, data] of [
    ['workspace', { placement: 'main', uncloseable: true }],
    ['session-tile:b', { placement: 'main' }]
  ] as const) {
    disposers.push(registry.register({ area: 'panes', data, id, render: () => null, title: id }))
  }

  $layoutTree.set(group(['workspace', 'session-tile:b'], { active: 'session-tile:b', id: 'grp-main' }))
})

afterEach(() => disposers.splice(0).forEach(dispose => dispose()))

const zoneOf = (paneId: string) => findGroupOfPane($layoutTree.get()!, paneId)!

describe('dragging a session tab into its own zone', () => {
  it('drops main to a title band once it holds only the workspace, and keeps the tile\'s strip', () => {
    expect(tabStripVisibleForGroup(zoneOf('workspace'))).toBe(true)

    moveTreePane('session-tile:b', { groupId: 'grp-main', pos: 'right' })

    expect(zoneOf('workspace').id).not.toBe(zoneOf('session-tile:b').id)
    expect(tabStripVisibleForGroup(zoneOf('workspace'))).toBe(false)
    expect(tabStripVisibleForGroup(zoneOf('session-tile:b'))).toBe(true)
    // Nothing was written to the zone to get there — it is still on auto.
    expect(zoneOf('workspace').tabStrip).toBeUndefined()

    removeTreePane('session-tile:b')

    // A lone workspace strands nothing: it has no ✕, its session stays reachable
    // from the sidebar, and ⌘⌥T still brings the strip back.
    expect(tabStripVisibleForGroup(zoneOf('workspace'))).toBe(false)
  })
})
