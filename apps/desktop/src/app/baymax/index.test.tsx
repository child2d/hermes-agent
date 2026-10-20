import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  pluginRest.mockImplementation((_plugin: string, _path: string, opts: { body: { params: Record<string, string>; templateId: string } }) => {
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
  })
}

function renderView() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })

  return render(
    <QueryClientProvider client={client}>
      <BaymaxView />
    </QueryClientProvider>
  )
}

const requestedScenes = () =>
  pluginRest.mock.calls
    .filter(call => call[2]?.body?.templateId === 'list-issues')
    .map(call => call[2].body.params.scene)

beforeEach(() => {
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
    const [plugin, path, opts] = call as [string, string, { body: { packId: string; params: Record<string, string> }; method: string }]

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
    const dueSoon = screen.getByRole('tab', { name: 'Due soon' })

    // Radix Tabs activates on mousedown (roving tabindex), not on a bare click.
    fireEvent.mouseDown(dueSoon)
    fireEvent.click(dueSoon)

    await waitFor(() => expect(requestedScenes()).toContain('DUE_SOON'))
  })

  it('surfaces the door diagnosis instead of pretending the list is empty', async () => {
    stubDoor({ failure: { kind: 'spawn-error', note: 'cli-not-found' } })
    renderView()

    expect(await screen.findByText(/cli-not-found/)).toBeTruthy()
  })
})
