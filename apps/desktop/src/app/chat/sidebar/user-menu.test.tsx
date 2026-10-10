import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PlanktonAuthGate } from '@/app/plankton-auth-gate'
import { SETTINGS_ROUTE } from '@/app/routes'
import { $enterpriseEnabled } from '@/store/enterprise-flag'

import { SidebarUserMenu } from './user-menu'

/**
 * The sidebar's account row: the enterprise identity at the sidebar foot and
 * the account panel behind it. Off-enterprise it must not exist at all — that
 * is what keeps upstream's sidebar foot byte-identical.
 */

const navigate = vi.fn()

vi.mock('react-router', () => ({
  useNavigate: () => navigate
}))

interface Bridge {
  status: ReturnType<typeof vi.fn>
  login: ReturnType<typeof vi.fn>
  logout: ReturnType<typeof vi.fn>
}

function setBridge(whoami: { subject: string; displayName: string | null } | null): Bridge {
  const api: Bridge = {
    status: vi.fn().mockResolvedValue({
      ok: true,
      loginReady: true,
      loginBlockedReason: null,
      loggedIn: whoami !== null,
      whoami
    }),
    login: vi.fn().mockResolvedValue({ ok: true }),
    logout: vi.fn().mockResolvedValue({ ok: true })
  }

  ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
    planktonAuthRequired: true,
    enterpriseEnabled: true,
    planktonAuth: api
  }

  return api
}

function renderMenu(): void {
  render(
    <PlanktonAuthGate>
      <SidebarUserMenu />
    </PlanktonAuthGate>
  )
}

describe('SidebarUserMenu', () => {
  beforeEach((): void => {
    vi.clearAllMocks()
    $enterpriseEnabled.set(true)
  })

  afterEach((): void => {
    cleanup()
    delete (window as unknown as { hermesDesktop?: unknown }).hermesDesktop
    $enterpriseEnabled.set(false)
  })

  it('renders the signed-in display name and opens the settings page from its row', async (): Promise<void> => {
    setBridge({ subject: 'perry.chen', displayName: '陈涛' })

    renderMenu()

    const row = await screen.findByRole('button', { name: '陈涛' })
    // Collapsed it is just the identity; the actions live behind the panel.
    expect(screen.queryByRole('button', { name: '退出登录' })).toBeNull()

    fireEvent.click(row)
    fireEvent.click(screen.getByRole('button', { name: '设置' }))

    await waitFor(() => expect(navigate).toHaveBeenCalledWith(SETTINGS_ROUTE))
    // The panel closes behind the navigation, never left floating over the app.
    await waitFor(() => expect(screen.queryByRole('button', { name: '设置' })).toBeNull())
  })

  it('falls back to the subject when the SSO identity carries no display name', async (): Promise<void> => {
    setBridge({ subject: 'perry.chen@shaoke.com', displayName: null })

    renderMenu()

    expect(await screen.findByText('perry.chen@shaoke.com')).toBeTruthy()
  })

  it('is absent when the enterprise gate is not active', (): void => {
    ;(window as unknown as { hermesDesktop: unknown }).hermesDesktop = {
      planktonAuthRequired: false,
      enterpriseEnabled: false
    }
    $enterpriseEnabled.set(false)

    renderMenu()

    expect(screen.queryByRole('button', { name: '企业账号' })).toBeNull()
  })
})
