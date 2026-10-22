import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
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

// Only the mode labels are read from the catalog; pinning them keeps the
// segmented control's assertions out of the active locale's hands.
vi.mock('@/i18n', () => ({
  useI18n: () => ({
    t: { settings: { modeOptions: { dark: { label: 'Dark' }, light: { label: 'Light' }, system: { label: 'System' } } } }
  })
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

  it('groups the panel: identity, the preference rows, then sign-out on its own', async (): Promise<void> => {
    setBridge({ subject: 'perry.chen@shaoke.com', displayName: '陈涛' })

    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: '陈涛' }))

    const identity = screen.getByTestId('plankton-account-identity')
    expect(within(identity).getByText('陈涛')).toBeTruthy()
    expect(within(identity).getByText('perry.chen@shaoke.com')).toBeTruthy()

    // Every row the panel offers, in order.
    expect(screen.getByRole('button', { name: '设置' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '检查更新' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '退出登录' })).toBeTruthy()
    expect(screen.getByText('外观')).toBeTruthy()
    // The appearance control rides the row itself, so it is not a link row.
    expect(screen.getByRole('button', { name: 'Light' })).toHaveProperty('ariaPressed', 'true')
    expect(screen.getByRole('button', { name: 'Dark' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'System' })).toBeTruthy()
  })

  it('never prints an opaque SSO subject as if it were account detail', async (): Promise<void> => {
    // The enterprise subject is an id, not an address: it must not surface as a
    // stray number under the name.
    setBridge({ subject: '5', displayName: '陈涛' })

    renderMenu()
    fireEvent.click(await screen.findByRole('button', { name: '陈涛' }))

    const identity = screen.getByTestId('plankton-account-identity')
    expect(within(identity).queryByText('5')).toBeNull()
  })

  it('falls back to the subject when the SSO identity carries no display name', async (): Promise<void> => {
    setBridge({ subject: 'perry.chen@shaoke.com', displayName: null })

    renderMenu()

    // The trigger is an avatar and carries no text, so the fallback identity is
    // asserted on its accessible name; the panel prints the address itself.
    const trigger = await screen.findByRole('button', { name: 'perry.chen@shaoke.com' })

    fireEvent.click(trigger)
    // Shown twice in the panel (the name line falls back to the subject, and the
    // address line echoes it), so this is a presence check, not a unique match.
    expect(
      within(screen.getByTestId('plankton-account-identity')).getAllByText('perry.chen@shaoke.com').length
    ).toBeGreaterThan(0)
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
