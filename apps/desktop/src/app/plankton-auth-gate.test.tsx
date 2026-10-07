import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $enterpriseEnabled } from '@/store/enterprise-flag'

import { PlanktonAuthGate } from './plankton-auth-gate'
import { PlanktonAccountSection } from './settings/plankton-account-section'

/**
 * The renderer half of the enterprise SSO session: the gate mounts the app only
 * while signed in, and Settings › About exposes the sign-out entry through the
 * gate's session context. These tests drive the real gate + account section
 * together against a stubbed preload bridge.
 */

interface Bridge {
  status: ReturnType<typeof vi.fn>
  login: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
}

const LOGGED_IN = {
  ok: true,
  loginReady: true,
  loginBlockedReason: null,
  loggedIn: true,
  whoami: { subject: 'subject-1', displayName: '张三' }
}

const LOGGED_OUT = {
  ok: true,
  loginReady: true,
  loginBlockedReason: null,
  loggedIn: false,
  whoami: null
}

function setBridge(overrides: Partial<Bridge> = {}): Bridge {
  const api: Bridge = {
    status: vi.fn().mockResolvedValue(LOGGED_IN),
    login: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    planktonAuthRequired: true,
    enterpriseEnabled: true,
    planktonAuth: api
  }

  return api
}

function renderGate(): void {
  render(
    <PlanktonAuthGate>
      <div data-testid="app">signed-in surface</div>
      <PlanktonAccountSection />
    </PlanktonAuthGate>
  )
}

const logoutButton = (): HTMLElement => screen.getByRole('button', { name: '退出登录' })

describe('PlanktonAuthGate sign-out', () => {
  let reload: ReturnType<typeof vi.fn>
  let originalLocation: PropertyDescriptor | undefined

  beforeEach((): void => {
    vi.clearAllMocks()
    // jsdom's location.reload is not implemented; capture it so the gate's
    // post-logout hard reload is observable instead of a jsdom navigation error.
    originalLocation = Object.getOwnPropertyDescriptor(window, 'location')
    reload = vi.fn()
    Object.defineProperty(window, 'location', {
      configurable: true,
      value: { ...window.location, reload }
    })
  })

  afterEach((): void => {
    cleanup()
    delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
    $enterpriseEnabled.set(false)

    if (originalLocation) {
      Object.defineProperty(window, 'location', originalLocation)
    }
  })

  it('is a transparent pass-through off the enterprise build (no sign-out entry)', (): void => {
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
      planktonAuthRequired: false,
      enterpriseEnabled: false
    }

    renderGate()

    expect(screen.getByTestId('app')).toBeTruthy()
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
  })

  it('shows the signed-in identity and signs out back to the login page', async (): Promise<void> => {
    const api = setBridge()
    $enterpriseEnabled.set(true)

    renderGate()

    // Gate opens after the status probe: the app surfaces and the account entry
    // carries the signed-in identity.
    await screen.findByRole('button', { name: '退出登录' })
    expect(screen.getByText('张三')).toBeTruthy()

    fireEvent.click(logoutButton())

    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1))
    // Back to the login page; every signed-in fact is gone.
    await screen.findByRole('heading', { name: '登录 Plankton' })
    expect(screen.queryByTestId('app')).toBeNull()
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()
    // The renderer hard-reloads so module-level stores/sockets cannot survive
    // into the next sign-in.
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('keeps the app mounted and shows a generic error when sign-out fails', async (): Promise<void> => {
    const api = setBridge({ logout: vi.fn().mockResolvedValue({ ok: false }) })
    $enterpriseEnabled.set(true)

    renderGate()

    await screen.findByRole('button', { name: '退出登录' })
    fireEvent.click(logoutButton())

    await waitFor(() => expect(api.logout).toHaveBeenCalledTimes(1))
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', '退出登录失败，请稍后重试。')
    expect(screen.getByTestId('app')).toBeTruthy()
    expect(screen.queryByRole('heading', { name: '登录 Plankton' })).toBeNull()
    expect(reload).not.toHaveBeenCalled()
  })

  it('does not resurrect the session from a logged-out status read after sign-out', async (): Promise<void> => {
    const api = setBridge()
    $enterpriseEnabled.set(true)

    renderGate()

    await screen.findByRole('button', { name: '退出登录' })
    fireEvent.click(logoutButton())
    await screen.findByRole('heading', { name: '登录 Plankton' })

    // The reloaded renderer re-probes status; the bridge now reports logged out
    // and the login page stays (no stale identity comes back).
    api.status.mockResolvedValue(LOGGED_OUT)
    fireEvent.click(screen.getByRole('button', { name: '重新检查登录状态' }))

    await waitFor(() => expect(api.status).toHaveBeenCalled())
    expect(screen.getByRole('heading', { name: '登录 Plankton' })).toBeTruthy()
    expect(screen.queryByTestId('app')).toBeNull()
  })
})
