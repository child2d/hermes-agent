import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Link, MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { allPaneIds } from '@/components/pane-shell/tree/model'
import { $activeTreeGroup, $hoveredTreeGroup, $layoutTree } from '@/components/pane-shell/tree/store'
import { registry } from '@/contrib/registry'

vi.mock('./wiring', () => ({
  ContribWiring: ({ children }: { children: ReactNode }) => children,
  WiredPane: ({ part }: { part: string }) => <div data-testid={`wired-${part}`}>{part}</div>
}))
vi.mock('@/app/chat/sidebar/connection-switcher', () => ({
  ConnectionSwitcher: () => <div data-testid="channel-list">channels</div>
}))

const { ContribController } = await import('./controller')

afterEach(cleanup)

function mountShell() {
  return render(
    <MemoryRouter>
      <Link to="/messaging">test channels</Link>
      <Link to="/cron">test jobs</Link>
      <Link to="/stored-session">test history</Link>
      <ContribController />
    </MemoryRouter>
  )
}

describe('the production shell composition', () => {
  it('mounts top-edge bands in the window bar and leaves lower-zone bands inline', () => {
    mountShell()
    const bar = globalThis.document.querySelector('[data-slot="app-top-bar"]')!
    const row = bar.querySelector('[data-slot="app-band-row"]')!
    const bands = [...globalThis.document.querySelectorAll('[data-panel-header]')]

    expect(bands.length).toBeGreaterThan(0)
    expect(row.querySelector('[data-panel-header]')).not.toBeNull()
    expect(bar.querySelector('[data-tree-group]')).toBeNull()
    expect(globalThis.document.querySelector('[data-tree-group][data-window-top] [data-panel-header]')).toBeNull()
    expect(screen.getByTestId('wired-sidebar').closest('[data-tree-group]')).not.toBeNull()

    const band = row.querySelector<HTMLElement>('[data-zone-band]')!
    fireEvent.pointerOver(band)
    expect($hoveredTreeGroup.get()).toBe(band.dataset.zoneBand)
    fireEvent.pointerDown(band)
    expect($activeTreeGroup.get()).toBe(band.dataset.zoneBand)
  })

  it('changes the one list column without editing or re-adopting the layout, including a history route', () => {
    mountShell()
    const initial = $layoutTree.get()
    const ids = allPaneIds(initial!)
    const listZone = screen.getByTestId('wired-sidebar').closest('[data-tree-group]')
    expect(ids.filter(id => id === 'sessions')).toHaveLength(1)

    for (let round = 0; round < 2; round++) {
      fireEvent.click(screen.getByText('test channels'))
      expect(screen.getByTestId('channel-list').closest('[data-tree-group]')).toBe(listZone)
      expect(screen.queryByTestId('wired-sidebar')).toBeNull()
      fireEvent.click(screen.getByText('test jobs'))
      // The job roster is asserted by its own slot, not by copy: the pane's
      // empty state is a phrasing that changes.
      expect(document.querySelector('[data-slot="list-pane"]')?.closest('[data-tree-group]')).toBe(listZone)
      fireEvent.click(screen.getByText('test history'))
      expect(screen.getAllByTestId('wired-sidebar')).toHaveLength(1)
      // The old implementation re-adopted absent list contributions whenever
      // any contribution changed (workspace retitles are a common trigger).
      const dispose = registry.register({ area: 'test', id: 'layout-probe' })
      dispose()
      expect($layoutTree.get()).toBe(initial)
      expect(allPaneIds($layoutTree.get()!)).toEqual(ids)
    }
  })
})
