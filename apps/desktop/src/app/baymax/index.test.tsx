import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { WorkspaceListPane } from '@/app/chat/sidebar/list-panes'

import { registerBaymaxPage } from './register'

// The page's ONLY data door: core → the enterprise plugin's read-only pack port.
// Mocking it at the module boundary is what lets these tests prove the request
// SHAPE (pack, template, params) the backend's whitelist will see.
const pluginRest = vi.fn()

vi.mock('@/api/plugins', () => ({
  pluginRest: (...args: unknown[]) => pluginRest(...args)
}))

const { BaymaxView } = await import('./index')

const ISSUE = (over: Record<string, unknown> = {}) => ({
  assigneeName: '陈涛',
  estimateEndDate: '2026-10-19T00:00:00.000Z',
  id: '1089',
  issueKey: 'PM-1089',
  priority: { name: 'P1' },
  status: { id: '5', isClosed: false, name: 'DEVELOPMENT/开发中' },
  title: 'PGTS 税金单回传',
  ...over
})

const ok = (data: unknown) => ({ envelope: { data, ok: true }, kind: 'ok' })

/** Route the mocked door by template id; `issues` is per-scene. */
function stubDoor({
  issuesByScene = { ALL_TODO: [ISSUE()] } as Record<string, unknown[]>,
  projects = ok({ data: [{ id: '1', keyPrefix: 'PM', projectName: '技术中心需求管理' }], total: 1 }),
  failure
}: {
  failure?: { kind: string; note: string }
  issuesByScene?: Record<string, unknown[]>
  projects?: unknown
} = {}) {
  pluginRest.mockImplementation(
    (_plugin: string, _path: string, opts: { body: { params: Record<string, string>; templateId: string } }) => {
      const { templateId, params } = opts.body

      if (failure) {
        return Promise.resolve(failure)
      }

      if (templateId === 'whoami') {
        return Promise.resolve(ok({ account: 'perry.chen@shaoke.com', id: '5', name: '陈涛' }))
      }

      if (templateId === 'project-list') {
        return Promise.resolve(projects)
      }

      if (templateId === 'list-issues') {
        const rows = issuesByScene[params.scene] ?? []

        return Promise.resolve(ok({ data: rows, total: rows.length }))
      }

      return Promise.resolve(ok({}))
    }
  )
}

async function chooseScene(name: string) {
  const trigger = screen.getByRole('combobox', { name: 'Work views' })
  fireEvent.keyDown(trigger, { key: 'ArrowDown' })
  fireEvent.click(await screen.findByRole('option', { name }))
}

function RouteProbe() {
  const location = useLocation()

  return <output data-testid="route-search">{location.search}</output>
}

function renderView(initial = '/baymax') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  const view = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initial]}>
        <RouteProbe />
        <WorkspaceListPane>
          <span>Session list</span>
        </WorkspaceListPane>
        <Routes>
          <Route element={<BaymaxView />} path="/baymax" />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>
  )

  return { ...view, client }
}

const requestedScenes = () =>
  pluginRest.mock.calls
    .filter(call => call[2]?.body?.templateId === 'list-issues')
    .map(call => call[2].body.params.scene)

beforeEach(() => {
  Element.prototype.scrollIntoView = vi.fn()
  registerBaymaxPage()
  globalThis.localStorage.clear()
})

afterEach(() => {
  cleanup()
  pluginRest.mockReset()
})

describe('BaymaxView', () => {
  it('reads the workbench through the enterprise read door, wrapped as a declared baymax template', async () => {
    stubDoor()
    renderView()

    await screen.findByText('PGTS 税金单回传')

    const call = pluginRest.mock.calls.find(item => item[2]?.body?.templateId === 'list-issues')

    const [plugin, path, opts] = call as [
      string,
      string,
      { body: { packId: string; params: Record<string, string> }; method: string }
    ]

    expect(plugin).toBe('plankton-enterprise')
    expect(path).toBe('/packs/read')
    expect(opts.method).toBe('POST')
    expect(opts.body.packId).toBe('baymax')
    expect(opts.body.params['project-id']).toBe('1')
  })

  it('marks a past deadline as late, in days', async () => {
    const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

    stubDoor({ issuesByScene: { ALL_TODO: [ISSUE({ estimateEndDate: daysAgo(3) })] } })
    renderView()

    // The suite's locale is English (no provider switch here).
    expect(await screen.findByText('3d late')).toBeTruthy()
  })

  it('switches the scene tab into a DUE_SOON read of the same project', async () => {
    stubDoor()
    renderView()

    await screen.findByText('PGTS 税金单回传')
    await chooseScene('Due soon')

    await waitFor(() => expect(requestedScenes()).toContain('DUE_SOON'))
  })

  it('filters only loaded issues and keeps parked and closed issues out of the overdue focus', async () => {
    const yesterday = new Date(Date.now() - 3 * 86_400_000).toISOString()
    stubDoor({
      issuesByScene: {
        ALL_TODO: [
          ISSUE({ id: 'late', title: 'Needs follow-up', estimateEndDate: yesterday }),
          ISSUE({
            id: 'parked',
            title: 'Parked work',
            estimateEndDate: yesterday,
            status: { name: '挂起', isClosed: false }
          }),
          ISSUE({ id: 'closed', title: 'Finished work', estimateEndDate: yesterday, status: { isClosed: true } }),
          ISSUE({ id: 'undated', title: 'Plan this work', estimateEndDate: undefined })
        ]
      }
    })
    renderView()
    await screen.findByText('Needs follow-up')
    fireEvent.click(screen.getByRole('button', { name: /Overdue.*1/ }))
    expect(screen.getByText('Needs follow-up')).toBeTruthy()
    expect(screen.queryByText('Parked work')).toBeNull()
    expect(screen.queryByText('Finished work')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /No deadline.*1/ }))
    expect(screen.getByText('Plan this work')).toBeTruthy()
    expect(screen.queryByText('Needs follow-up')).toBeNull()
    expect(requestedScenes()).toEqual(['ALL_TODO'])
  })

  it('waits honestly for counts, opens details only by intent, and retires late details on scene change', async () => {
    let resolveList!: (value: unknown) => void
    let resolveDetail!: (value: unknown) => void
    stubDoor()
    const original = pluginRest.getMockImplementation()!
    pluginRest.mockImplementation((plugin, path, opts) => {
      if (opts.body.templateId === 'list-issues' && opts.body.params.scene === 'ALL_TODO') {
        return new Promise(resolve => {
          resolveList = resolve
        })
      }

      if (opts.body.templateId === 'get-issue') {
        return new Promise(resolve => {
          resolveDetail = resolve
        })
      }

      return original(plugin, path, opts)
    })
    renderView()
    const overdue = await screen.findByRole('button', { name: /Overdue/ })
    expect(overdue.hasAttribute('disabled')).toBe(true)
    expect(overdue.textContent).not.toContain('0')
    await act(async () => resolveList(ok({ data: [ISSUE()], total: 240 })))
    const row = await screen.findByRole('button', { name: /PM-1089/ })
    expect(screen.getByText('Counts and filters cover the 1 loaded issues, not all 240.')).toBeTruthy()
    expect(pluginRest.mock.calls.some(call => call[2]?.body?.templateId === 'get-issue')).toBe(false)
    fireEvent.click(row)
    expect(screen.getByRole('region', { name: 'Issue details' }).getAttribute('aria-busy')).toBe('true')
    await chooseScene('Due soon')
    await act(async () => resolveDetail(ok(ISSUE({ description: 'Old project details' }))))
    expect(screen.queryByText('Old project details')).toBeNull()
    expect(screen.getByText('Choose an issue to read')).toBeTruthy()
  })

  it('shows a detail failure with retry and restores the selected row when returning to the queue', async () => {
    stubDoor()
    const original = pluginRest.getMockImplementation()!
    let failed = true
    pluginRest.mockImplementation((plugin, path, opts) =>
      opts.body.templateId === 'get-issue'
        ? Promise.resolve(
            failed
              ? { kind: 'read-failed', note: 'detail-unavailable' }
              : ok(
                  ISSUE({
                    description: 'The actual issue description',
                    comments: [{ id: 'c1', authorName: 'Owner', content: 'Real progress' }]
                  })
                )
          )
        : original(plugin, path, opts)
    )
    renderView()
    const row = await screen.findByRole('button', { name: /PM-1089/ })
    fireEvent.click(row)
    expect(await screen.findByText(/detail-unavailable/)).toBeTruthy()
    failed = false
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Issue details' })).getByRole('button', { name: 'Retry' })
    )
    expect(await screen.findByText('The actual issue description')).toBeTruthy()
    const comments = screen.getByRole('tab', { name: /comments/i })
    fireEvent.mouseDown(comments)
    fireEvent.click(comments)
    expect(screen.getByText('Real progress')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Back to queue' }))
    await waitFor(() => expect(globalThis.document.activeElement).toBe(row))
    expect(screen.queryByText('The actual issue description')).toBeNull()
  })

  it('scopes details to the project even when issue ids collide, without stealing focus on a background project update', async () => {
    stubDoor()
    const original = pluginRest.getMockImplementation()!
    pluginRest.mockImplementation((plugin, path, opts) =>
      opts.body.templateId === 'get-issue'
        ? Promise.resolve(ok(ISSUE({ description: `Details for project ${opts.body.params['project-id']}` })))
        : original(plugin, path, opts)
    )
    const { client } = renderView()
    fireEvent.click(await screen.findByRole('button', { name: /PM-1089/ }))
    await screen.findByText('Details for project 1')
    const refresh = await screen.findByRole('button', { name: 'Refresh' })
    refresh.focus()
    await act(async () => client.setQueryData(['baymax', 'projects'], [{ id: '2', projectName: 'Second project' }]))
    await waitFor(() => expect(screen.queryByText('Details for project 1')).toBeNull())
    expect(globalThis.document.activeElement).toBe(refresh)
    fireEvent.click(await screen.findByRole('button', { name: /PM-1089/ }))
    expect(await screen.findByText('Details for project 2')).toBeTruthy()

    const detailProjects = pluginRest.mock.calls
      .filter(call => call[2]?.body?.templateId === 'get-issue')
      .map(call => call[2].body.params['project-id'])

    expect(detailProjects).toEqual(['1', '2'])
  })

  it('keeps selection and focus stable on refresh and reads all four business scenes', async () => {
    stubDoor({
      issuesByScene: {
        ALL_TODO: [ISSUE({ estimateEndDate: new Date().toISOString() })],
        DUE_SOON: [ISSUE()],
        MY_CREATED: [ISSUE()],
        MY_PROCESSING: [ISSUE()]
      }
    })
    const original = pluginRest.getMockImplementation()!
    pluginRest.mockImplementation((plugin, path, opts) =>
      opts.body.templateId === 'get-issue'
        ? Promise.resolve(ok(ISSUE({ description: 'Retain this reading context' })))
        : original(plugin, path, opts)
    )
    const { client } = renderView()
    const row = await screen.findByRole('button', { name: /PM-1089/ })
    fireEvent.click(screen.getByRole('button', { name: /Due today.*1/ }))
    fireEvent.click(row)
    await screen.findByText('Retain this reading context')
    const refresh = await screen.findByRole('button', { name: 'Refresh' })
    refresh.focus()
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['baymax'] })
    })
    expect(screen.getByText('Retain this reading context')).toBeTruthy()
    expect(globalThis.document.activeElement).toBe(refresh)

    for (const name of ['Due soon', 'Created by me', 'In progress']) {
      await chooseScene(name)
      await screen.findByRole('button', { name: /PM-1089/ })
      expect(screen.queryByText('Retain this reading context')).toBeNull()
    }

    expect(new Set(requestedScenes())).toEqual(new Set(['ALL_TODO', 'DUE_SOON', 'MY_CREATED', 'MY_PROCESSING']))
  })

  it('keeps project, scene, focus, query and selection in the URL, with persistent project choice', async () => {
    stubDoor({
      projects: ok({
        data: [
          { id: '1', projectName: 'First project' },
          { id: '2', projectName: 'Second project' }
        ]
      })
    })
    globalThis.localStorage.setItem('hermes.desktop.baymax.projectId', '2')
    renderView('/baymax?project=1&scene=ALL_TODO&focus=all&q=PGTS')
    const row = await screen.findByRole('button', { name: /PM-1089/ })
    expect(screen.getByRole('combobox', { name: 'Project' }).textContent).toContain('First project')
    fireEvent.click(row)
    expect(screen.getByTestId('route-search').textContent).toContain('issue=1089')
    fireEvent.change(screen.getByRole('textbox', { name: 'Search issues' }), { target: { value: 'not found' } })
    expect(screen.queryByRole('button', { name: /PM-1089/ })).toBeNull()
    expect(screen.getByTestId('route-search').textContent).not.toContain('issue=')
    expect(screen.getByTestId('route-search').textContent).toContain('q=not+found')
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }))
    await screen.findByRole('button', { name: /PM-1089/ })
    fireEvent.keyDown(screen.getByRole('combobox', { name: 'Project' }), { key: 'ArrowDown' })
    fireEvent.click(await screen.findByRole('option', { name: 'Second project' }))
    await waitFor(() => expect(screen.getByTestId('route-search').textContent).toBe('?project=2'))
    expect(globalThis.localStorage.getItem('hermes.desktop.baymax.projectId')).toBe('2')
    expect(screen.queryByRole('button', { name: /save|reply|delete|chat|attach/i })).toBeNull()
    expect(
      pluginRest.mock.calls.every(call =>
        ['whoami', 'project-list', 'list-issues', 'get-issue'].includes(call[2].body.templateId)
      )
    ).toBe(true)
  })

  it('seeds a new visit from project persistence, supports keyboard list movement and clears an issue on scene change', async () => {
    stubDoor({
      projects: ok({
        data: [
          { id: '1', projectName: 'First project' },
          { id: '2', projectName: 'Second project' }
        ]
      }),
      issuesByScene: { ALL_TODO: [ISSUE(), ISSUE({ id: 'next', issueKey: 'PM-NEXT', title: 'Next issue' })] }
    })
    globalThis.localStorage.setItem('hermes.desktop.baymax.projectId', '2')
    renderView()
    const row = await screen.findByRole('button', { name: /PM-1089/ })
    expect(screen.getByTestId('route-search').textContent).toBe('?project=2')
    row.focus()
    fireEvent.keyDown(row, { key: 'ArrowDown' })
    expect(globalThis.document.activeElement).toBe(screen.getByRole('button', { name: /PM-NEXT/ }))
    fireEvent.keyDown(globalThis.document.activeElement!, { key: 'Home' })
    expect(globalThis.document.activeElement).toBe(row)
    fireEvent.click(row)
    await waitFor(() =>
      expect(globalThis.document.activeElement).toBe(screen.getByRole('region', { name: 'Issue details' }))
    )
    await chooseScene('Due soon')
    expect(screen.getByTestId('route-search').textContent).toBe('?project=2&scene=DUE_SOON')
    expect(screen.queryByTestId('baymax-issue-detail-card')).toBeNull()
  })

  it('shows an empty project state and does not read a queue without a project', async () => {
    stubDoor({ projects: ok({ data: [] }) })
    renderView()
    await screen.findByText('No project available')
    expect(requestedScenes()).toEqual([])
    expect(screen.queryByRole('textbox')).toBeNull()
  })

  it('surfaces the door diagnosis instead of pretending the list is empty', async () => {
    stubDoor({ failure: { kind: 'spawn-error', note: 'cli-not-found' } })
    renderView()

    expect(await screen.findByText(/cli-not-found/)).toBeTruthy()
  })
})
