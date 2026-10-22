// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { TitlebarControls } from '@/app/shell/titlebar-controls'
import { findGroupOfPane, group, split } from '@/components/pane-shell/tree/model'
import { foldsToRailInShell, minimizedTrackFor } from '@/components/pane-shell/tree/renderer/track-model'
import { $collapsedTreeSides, $hiddenTreePanes, $layoutTree } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'
import { I18nProvider } from '@/i18n'
import { setSidebarOpen } from '@/store/layout'

// The titlebar's left button and the fold it drives belong together: the button
// resolves "everything physically left of main" from the LIVE tree and folds
// that zone, and the zone's folded form is NOTHING — its rail is window chrome
// (AppRail), so no strip and no track survive. The sessions zone stacks tabs in
// practice (Bots), which the fold has to survive: requiring a single pane there
// left a 28px tab rail standing where the list column had been.

const BOTS = 'hermes-bots:pane'

class TestResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

beforeAll(() => {
  vi.stubGlobal('ResizeObserver', TestResizeObserver)
  vi.stubGlobal('CSS', { ...globalThis.CSS, escape: (value: string) => value })
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => undefined
  Element.prototype.releasePointerCapture ??= () => undefined
  HTMLElement.prototype.scrollIntoView ??= () => undefined
})

const disposers: (() => void)[] = []

beforeEach(() => {
  disposers.push(
    registry.registerMany([
    {
      id: 'sessions',
      area: 'panes',
      title: 'Sessions',
      data: { collapsible: true, hideOnly: true, placement: 'left', railInShell: true, width: '237px' },
      render: () => null
    },
    { id: BOTS, area: 'panes', title: 'Bots', data: { placement: 'left' }, render: () => null },
      { id: 'workspace', area: 'panes', title: 'Chat', data: { placement: 'main' }, render: () => null }
    ])
  )

  window.localStorage.clear()
  $collapsedTreeSides.set(new Set())
  $hiddenTreePanes.set(new Set())
  setSidebarOpen(true)
})

afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
})

/** The live shape: sessions + Bots stacked in the left zone, chat beside it. */
const listZone = () => group(['sessions', BOTS], { id: 'grp-list' })
const withChat = () => split('row', [listZone(), group(['workspace'], { id: 'grp-main' })])

describe('titlebar left button folds the list zone', () => {
  it('minimizes the physically-left column when pressed', () => {
    $layoutTree.set(withChat())

    render(
      <MemoryRouter initialEntries={['/']}>
        <I18nProvider configClient={null} initialLocale="en">
          <TitlebarControls />
        </I18nProvider>
      </MemoryRouter>
    )

    const button = screen.getAllByRole('button').find(b => (b.getAttribute('aria-label') ?? '').includes('idebar'))

    expect(button, 'the left cluster carries no sidebar button').toBeTruthy()

    button!.click()

    expect(findGroupOfPane($layoutTree.get()!, 'sessions')?.minimized).toBe(true)
  })

  it('folds to nothing, tabs and all — the same predicate the zone renders from', () => {
    const chrome = new Map([
      ['sessions', { data: { railInShell: true } }],
      [BOTS, { data: {} }]
    ])

    const chromeFor = (id: string) => chrome.get(id)?.data as { railInShell?: boolean } | undefined

    // Sessions + Bots in one zone: still nothing left behind, because the rail
    // that replaces the column is the window's own.
    expect(foldsToRailInShell(['sessions', BOTS], chromeFor)).toBe(true)
    // A zone whose panes live in their own strip keeps its 28px rail.
    expect(foldsToRailInShell([BOTS], chromeFor)).toBe(false)
  })

  it('reserves no track for the folded zone', () => {
    const chrome = new Map([
      ['sessions', { data: { railInShell: true } }],
      [BOTS, { data: {} }]
    ])

    const ctx = { paneFor: (id: string) => chrome.get(id) }

    expect(minimizedTrackFor(listZone(), ctx as never)).toBe('0px')
  })
})
