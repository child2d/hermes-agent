import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { createClientSessionState } from '@/lib/chat-runtime'
import { $sessionStates, publishSessionState } from '@/store/session-states'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'
import type { ContextBreakdown } from '@/types/hermes'

import { ContextUsageRing } from './context-usage-ring'

vi.mock('@/store/gateway', () => ({ requestGatewayForProfile: vi.fn(async () => undefined) }))

// The breakdown is the backend's read-only snapshot; the ring's contract is what
// it does with the numbers, so the fetch is stubbed rather than exercised.
const breakdown: ContextBreakdown = {
  categories: [],
  context_estimated: false,
  context_max: 200000,
  context_percent: 50,
  context_used: 100000,
  estimated_total: 100000
}

let fetched: ContextBreakdown | null = null

vi.mock('@/app/shell/hooks/use-context-breakdown', () => ({
  useContextBreakdown: () => ({ breakdown: fetched, loading: false })
}))

const SESSION_ID = 'runtime-1'

beforeAll(() => {
  stubResizeObserver()
  stubMenuDomApis()
})

afterEach(() => {
  cleanup()
  fetched = null
  $sessionStates.set({})
})

function publishUsage(usage: { context_max: number; context_percent: number; context_used: number }) {
  publishSessionState(SESSION_ID, {
    ...createClientSessionState(null),
    usage: { calls: 1, input: 0, output: 0, total: 0, ...usage }
  })
}

const renderRing = (sessionId: null | string = SESSION_ID) =>
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <ContextUsageRing busy={false} sessionId={sessionId} />
    </I18nProvider>
  )

describe('composer context ring', () => {
  it('renders nothing for a composer with no session yet', () => {
    const { container } = renderRing(null)

    expect(container.firstChild).toBeNull()
  })

  it('drains the arc to the reported occupancy and names it on the control', () => {
    publishUsage({ context_max: 200000, context_percent: 25, context_used: 50000 })
    const { container } = renderRing()

    expect(screen.getByRole('button', { name: /^Context usage:/ })).toBeTruthy()
    // Second circle is the progress arc: a quarter of the 6.5px-radius ring.
    const arc = container.querySelectorAll('circle')[1]
    const [drawn] = (arc.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number)

    expect(drawn).toBeCloseTo(0.25 * 2 * Math.PI * 6.5, 1)
  })

  it('lets the measured breakdown override the streamed usage', () => {
    fetched = breakdown
    publishUsage({ context_max: 200000, context_percent: 25, context_used: 50000 })
    const { container } = renderRing()

    const arc = container.querySelectorAll('circle')[1]
    const [drawn] = (arc.getAttribute('stroke-dasharray') ?? '').split(' ').map(Number)

    expect(drawn).toBeCloseTo(0.5 * 2 * Math.PI * 6.5, 1)
  })

  it('opens the same context panel the statusbar opens', async () => {
    publishUsage({ context_max: 200000, context_percent: 25, context_used: 50000 })
    renderRing()

    fireEvent.pointerDown(screen.getByRole('button', { name: /^Context usage:/ }), { button: 0 })

    const panel = (await screen.findByText('Context Usage')).closest('[data-slot="context-usage-panel"]')

    expect(panel).toBeTruthy()
  })
})
