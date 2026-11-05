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

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

const ISSUE = (over: Record<string, unknown> = {}) => ({
  actualWorkload: 3,
  assigneeName: '陈涛',
  estimateEndDate: daysAgo(2),
  estimateStartDate: daysAgo(9),
  id: '1089',
  issueKey: 'PM-1089',
  priority: { name: 'P1' },
  status: { id: '5', isClosed: false, name: 'DEVELOPMENT/开发中' },
  title: 'PGTS 税金单回传',
  updatedAt: daysAgo(1),
  ...over
})

const ok = (data: unknown) => ({ envelope: { data, ok: true }, kind: 'ok' })

interface DoorOptions {
  failure?: { kind: string; note: string }
  issuesByScene?: Record<string, unknown[]>
  projects?: unknown
  total?: number
}

/** Route the mocked door by template id; `issues` is per-scene. */
function stubDoor({
  failure,
  issuesByScene = { ALL_TODO: [ISSUE()] },
  projects = ok({ data: [{ id: '1', keyPrefix: 'PM', projectName: '技术中心需求管理' }], total: 1 }),
  total
}: DoorOptions = {}) {
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

        return Promise.resolve(ok({ data: rows, total: total ?? rows.length }))
      }

      if (templateId === 'get-issue') {
        const rows = Object.values(issuesByScene).flat() as Array<Record<string, unknown>>
        const found = rows.find(row => row.id === params.id) ?? ISSUE()

        return Promise.resolve(ok({ ...found, comments: [], description: 'Detail body' }))
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

const groupOf = (key: string) =>
  globalThis.document.querySelector<HTMLElement>(`.baymax-group-block[data-group="${key}"]`)

const cardsIn = (key: string) => groupOf(key)?.querySelectorAll('.baymax-card').length ?? 0

/** The page seeds `project` into the URL on first paint; interact after that. */
async function seeded() {
  await waitFor(() => expect(screen.getByTestId('route-search').textContent).toContain('project='))
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
  it('reads the workbench through the enterprise read door, states its coverage, and never writes', async () => {
    stubDoor({ total: 240 })
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

    expect(screen.getByText('Loaded 1 / 240')).toBeTruthy()
    expect(screen.getAllByText('Read-only · no writes').length).toBeGreaterThan(0)
    expect(screen.getByText(/^Today \d{2}-\d{2}$/)).toBeTruthy()
    expect(
      pluginRest.mock.calls.every(call =>
        ['whoami', 'project-list', 'list-issues', 'get-issue'].includes(call[2].body.templateId)
      )
    ).toBe(true)
  })

  it('groups open tickets by disposition, with a count and a hint per group, and drops closed rows', async () => {
    stubDoor({
      issuesByScene: {
        ALL_TODO: [
          ISSUE({ id: 'late-a', title: 'Late A' }),
          ISSUE({ id: 'late-b', title: 'Late B' }),
          ISSUE({ estimateEndDate: new Date().toISOString(), id: 'due', title: 'Due today' }),
          ISSUE({ estimateEndDate: undefined, id: 'plan', title: 'Plan this work' }),
          ISSUE({ id: 'parked', status: { isClosed: false, name: '挂起' }, title: 'Parked work' }),
          ISSUE({ estimateEndDate: daysAgo(-6), id: 'ahead', title: 'Ahead later' }),
          ISSUE({ id: 'closed', status: { isClosed: true }, title: 'Finished work' })
        ]
      }
    })
    renderView()

    await screen.findByText('Late A')

    expect(cardsIn('overdue')).toBe(2)
    expect(groupOf('overdue')?.textContent).toContain('Carried over')
    expect(groupOf('overdue')?.textContent).toContain('Past its plan date')
    expect(cardsIn('today')).toBe(1)
    expect(cardsIn('upcoming')).toBe(1)
    expect(cardsIn('undated')).toBe(1)
    expect(cardsIn('suspended')).toBe(1)
    expect(screen.queryByText('Finished work')).toBeNull()

    expect(screen.getByRole('button', { name: /Carried over 2/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Today 1/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /No plan date 1/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /All 6/ })).toBeTruthy()
  })

  it('marks a past deadline in days and keeps a parked ticket out of late', async () => {
    stubDoor({
      issuesByScene: {
        ALL_TODO: [
          ISSUE(),
          ISSUE({
            id: 'parked',
            issueKey: 'PM-PARKED',
            status: { isClosed: false, name: '挂起' },
            title: 'Parked work'
          })
        ]
      }
    })
    renderView()

    expect((await screen.findByRole('button', { name: /PM-1089/ })).textContent).toContain('2d late')
    expect(screen.getByRole('button', { name: /PM-PARKED/ }).textContent).toContain('Suspended')
  })

  it('selects a card with a ring and opens one detail sheet with chips, facts and no nested cards', async () => {
    stubDoor()
    renderView()

    const row = await screen.findByRole('button', { name: /PM-1089/ })

    await seeded()
    expect(row.getAttribute('aria-selected')).toBe('false')
    fireEvent.click(row)

    const sheet = await screen.findByTestId('baymax-issue-detail-card')

    expect(screen.getByRole('button', { name: /PM-1089/ }).getAttribute('aria-selected')).toBe('true')
    expect(within(sheet).getByText('DEVELOPMENT/开发中')).toBeTruthy()
    expect(within(sheet).getByText('P1')).toBeTruthy()
    expect(within(sheet).getByText('2d late')).toBeTruthy()
    expect(within(sheet).getByText('陈涛')).toBeTruthy()
    expect(within(sheet).getByText('3')).toBeTruthy()
    expect(within(sheet).getByText(/→/)).toBeTruthy()
    expect(sheet.querySelector('[data-slot="card"]')).toBeNull()
    expect(screen.getByTestId('route-search').textContent).toContain('issue=1089')
    expect(screen.getByRole('heading', { name: 'PGTS 税金单回传' })).toBeTruthy()

    await waitFor(() =>
      expect(globalThis.document.activeElement).toBe(screen.getByRole('region', { name: 'Issue details' }))
    )
  })

  it('moves the selection with arrows only while focus is outside a text field', async () => {
    stubDoor({
      issuesByScene: {
        ALL_TODO: [ISSUE(), ISSUE({ id: 'next', issueKey: 'PM-NEXT', title: 'Next issue' })]
      }
    })
    renderView()

    const first = await screen.findByRole('button', { name: /PM-1089/ })
    const second = screen.getByRole('button', { name: /PM-NEXT/ })

    await seeded()
    first.focus()
    expect(fireEvent.keyDown(first, { key: 'ArrowDown' })).toBe(false)
    expect(globalThis.document.activeElement).toBe(second)
    expect(second.getAttribute('aria-selected')).toBe('true')
    expect(Element.prototype.scrollIntoView).toHaveBeenLastCalledWith({ block: 'nearest' })
    expect(screen.getByTestId('route-search').textContent).toContain('issue=next')

    const search = screen.getByRole('textbox', { name: 'Search issues' })

    search.focus()
    fireEvent.keyDown(search, { key: 'ArrowUp' })
    expect(globalThis.document.activeElement).toBe(search)
    expect(second.getAttribute('aria-selected')).toBe('true')

    fireEvent.keyDown(search, { key: '/' })
    expect(globalThis.document.activeElement).toBe(search)

    fireEvent.keyDown(globalThis.document.body, { key: '/' })
    expect(globalThis.document.activeElement).toBe(search)
  })

  it('clears a selection the search filters away and shows the pick-an-issue card', async () => {
    stubDoor({
      issuesByScene: {
        ALL_TODO: [
          ISSUE(),
          ISSUE({ estimateEndDate: undefined, id: 'other', issueKey: 'PM-OTHER', title: 'Other work' })
        ]
      }
    })
    renderView()

    const row = await screen.findByRole('button', { name: /PM-1089/ })

    await seeded()
    fireEvent.click(row)
    await screen.findByTestId('baymax-issue-detail-card')

    fireEvent.change(screen.getByRole('textbox', { name: 'Search issues' }), { target: { value: 'other' } })

    expect(screen.getByTestId('route-search').textContent).not.toContain('issue=')
    expect(screen.queryByTestId('baymax-issue-detail-card')).toBeNull()
    expect(screen.getByText('Choose an issue')).toBeTruthy()
    expect(screen.getByRole('button', { name: /PM-OTHER/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /No plan date 1/ })).toBeTruthy()
  })

  it('offers a way out of an empty group and focuses the first row on the way back', async () => {
    stubDoor({
      issuesByScene: {
        ALL_TODO: [ISSUE(), ISSUE({ id: 'late-b', issueKey: 'PM-B', title: 'Late B' })]
      }
    })
    renderView()

    await screen.findByText('PGTS 税金单回传')
    await seeded()
    fireEvent.click(screen.getByRole('button', { name: /Today 0/ }))

    expect(groupOf('overdue')).toBeNull()
    expect(groupOf('today')?.textContent).toContain('Nothing in this group')
    expect(screen.getByTestId('route-search').textContent).toContain('focus=today')

    fireEvent.click(screen.getByRole('button', { name: 'View all' }))

    await waitFor(() => expect(globalThis.document.activeElement).toBe(screen.getByRole('button', { name: /PM-1089/ })))
    expect(cardsIn('overdue')).toBe(2)
    expect(screen.getByTestId('route-search').textContent).not.toContain('focus=')
  })

  it('scrolls the detail back to the top when the ticket changes', async () => {
    stubDoor({
      issuesByScene: {
        ALL_TODO: [ISSUE(), ISSUE({ id: 'next', issueKey: 'PM-NEXT', title: 'Next issue' })]
      }
    })
    renderView()

    const row = await screen.findByRole('button', { name: /PM-1089/ })

    await seeded()
    fireEvent.click(row)
    await screen.findByTestId('baymax-issue-detail-card')

    const work = globalThis.document.querySelector<HTMLElement>('.baymax-work')!

    Object.defineProperty(work, 'scrollTop', { configurable: true, value: 180, writable: true })

    fireEvent.click(screen.getByRole('button', { name: /PM-NEXT/ }))
    await screen.findByText('Next issue')

    expect(work.scrollTop).toBe(0)
  })

  it('switches the scene tab into a DUE_SOON read of the same project and retires the open detail', async () => {
    stubDoor({
      issuesByScene: {
        ALL_TODO: [ISSUE()],
        DUE_SOON: [ISSUE()],
        MY_CREATED: [ISSUE()],
        MY_PROCESSING: [ISSUE()]
      }
    })
    renderView()

    const row = await screen.findByRole('button', { name: /PM-1089/ })

    await seeded()
    fireEvent.click(row)
    await screen.findByTestId('baymax-issue-detail-card')

    await chooseScene('Due soon')

    await waitFor(() => expect(requestedScenes()).toContain('DUE_SOON'))
    await screen.findByRole('button', { name: /PM-1089/ })
    expect(screen.getByTestId('route-search').textContent).toContain('scene=DUE_SOON')
    expect(screen.getByTestId('route-search').textContent).not.toContain('issue=')
    expect(screen.getByText('Choose an issue')).toBeTruthy()

    for (const name of ['Created by me', 'In progress']) {
      await chooseScene(name)
      await screen.findByRole('button', { name: /PM-1089/ })
    }

    expect(new Set(requestedScenes())).toEqual(new Set(['ALL_TODO', 'DUE_SOON', 'MY_CREATED', 'MY_PROCESSING']))
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
              : ok({ ...ISSUE(), comments: [], description: 'Detail body' })
          )
        : original(plugin, path, opts)
    )

    renderView()

    const row = await screen.findByRole('button', { name: /PM-1089/ })

    await seeded()
    fireEvent.click(row)
    expect(await screen.findByText(/detail-unavailable/)).toBeTruthy()
    expect(screen.getByRole('region', { name: 'Issue details' }).getAttribute('aria-busy')).toBe('false')

    failed = false
    fireEvent.click(
      within(screen.getByRole('region', { name: 'Issue details' })).getByRole('button', { name: 'Retry' })
    )
    expect(await screen.findByText('Detail body')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: 'Back to queue' }))
    await waitFor(() => expect(globalThis.document.activeElement).toBe(row))
    expect(screen.queryByTestId('baymax-issue-detail-card')).toBeNull()
    expect(screen.getByText('Choose an issue')).toBeTruthy()
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

    const row = await screen.findByRole('button', { name: /PM-1089/ })

    await seeded()
    fireEvent.click(row)
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
  })

  it('shows no projects as their own state and does not read a queue', async () => {
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
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
  })
})
