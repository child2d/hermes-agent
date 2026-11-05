import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ReactNode } from 'react'
import { Link, MemoryRouter, useLocation } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSidebarRouteColumn } from '@/app/contrib/use-sidebar-route-column'
import { contributedRoutes, ROUTES_AREA } from '@/app/routes'
import { allPaneIds, findGroupOfPane } from '@/components/pane-shell/tree/model'
import { $layoutTree, setTreeGroupMinimized } from '@/components/pane-shell/tree/store'
import { ContribRender } from '@/contrib/react/boundary'
import { registry } from '@/contrib/registry'

// Leave the production shell, tree, route-list contribution and fold effect real.
// Only the unrelated gateway/chat lifecycle is absent in this offline fixture.
vi.mock('@/app/contrib/wiring', () => ({
  ContribWiring: ({ children }: { children: ReactNode }) => {
    useSidebarRouteColumn()

    return children
  },
  WiredPane: ({ part }: { part: string }) => {
    const { pathname } = useLocation()
    const route = contributedRoutes().find(item => item.path === pathname)

    return part === 'chatRoutes' && route ? (
      <ContribRender render={route.render} />
    ) : (
      <div data-testid={`wired-${part}`}>{part}</div>
    )
  }
}))
vi.mock('@/api/plugins', () => ({
  pluginRest: async (_plugin: string, _path: string, opts: { body: { templateId: string } }) => ({
    kind: 'ok',
    envelope: {
      ok: true,
      data:
        opts.body.templateId === 'project-list'
          ? { data: [{ id: '1', projectName: 'Fixture project' }] }
          : opts.body.templateId === 'list-issues'
            ? { data: [{ id: 'a', issueKey: 'PM-A', title: 'Queue lives here' }], total: 1 }
            : { id: 'a', issueKey: 'PM-A', title: 'Queue lives here', description: 'One main card' }
    }
  })
}))

const { ContribController } = await import('@/app/contrib/controller')

afterEach(cleanup)

describe('Baymax in the production standing shell', () => {
  it('reveals the existing list on entry, has one main ticket, and restores session/cron/messaging defaults', async () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter>
          <Link to="/baymax">fixture baymax</Link>
          <Link to="/stored-session">fixture chat</Link>
          <Link to="/cron">fixture cron</Link>
          <Link to="/messaging">fixture messaging</Link>
          <ContribController />
        </MemoryRouter>
      </QueryClientProvider>
    )
    const ids = allPaneIds($layoutTree.get()!)
    const group = findGroupOfPane($layoutTree.get()!, 'sessions')!
    act(() => setTreeGroupMinimized(group.id, true))
    expect(findGroupOfPane($layoutTree.get()!, 'sessions')?.minimized).toBe(true)
    fireEvent.click(screen.getByText('fixture baymax'))
    await screen.findByText('Queue lives here')
    await waitFor(() => expect(findGroupOfPane($layoutTree.get()!, 'sessions')?.minimized).toBe(false))
    const list = screen.getByTestId('baymax-list-pane')
    expect(list.closest('[data-tree-group]')?.getAttribute('data-tree-group')).toBe(group.id)
    expect(screen.queryByTestId('wired-sidebar')).toBeNull()
    fireEvent.click(within(list).getByRole('button', { name: /PM-A/ }))
    await screen.findByText('One main card')
    expect(screen.getAllByTestId('baymax-issue-detail-card')).toHaveLength(1)
    expect(screen.getByTestId('baymax-issue-detail-card').closest('[data-slot="list-column"]')).toBeNull()
    act(() => setTreeGroupMinimized(group.id, true))

    let dispose = () => {}
    act(() => {
      dispose = registry.register({
        area: ROUTES_AREA,
        id: 'unrelated-fixture',
        data: { path: '/unrelated-fixture' },
        render: () => null
      })
    })
    expect(findGroupOfPane($layoutTree.get()!, 'sessions')?.minimized).toBe(true)
    act(() => dispose())
    fireEvent.click(screen.getByRole('button', { name: 'Back to queue' }))
    await waitFor(() => expect(findGroupOfPane($layoutTree.get()!, 'sessions')?.minimized).toBe(false))
    expect(screen.queryByTestId('baymax-issue-detail-card')).toBeNull()
    expect(allPaneIds($layoutTree.get()!)).toEqual(ids)
    expect(ids.filter(id => id === 'sessions')).toHaveLength(1)
    fireEvent.click(screen.getByText('fixture chat'))
    expect(screen.getAllByTestId('wired-sidebar')).toHaveLength(1)
    expect(screen.queryByTestId('baymax-list-pane')).toBeNull()

    for (const name of ['fixture cron', 'fixture messaging']) {
      fireEvent.click(screen.getByText(name))
      expect(globalThis.document.querySelectorAll('[data-slot="list-column"]')).toHaveLength(1)
      expect(globalThis.document.querySelector('[data-slot="list-pane"]')).not.toBeNull()
      expect(screen.queryByTestId('baymax-list-pane')).toBeNull()
    }

    expect(allPaneIds($layoutTree.get()!)).toEqual(ids)
  })
})
