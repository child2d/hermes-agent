import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { I18nProvider } from '@/i18n'
import { $approvalModes } from '@/store/approval-mode'
import { requestGatewayForProfile } from '@/store/gateway'
import { $activeGatewayProfile } from '@/store/profile'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { ApprovalModeChip } from './approval-mode-chip'

// The chip's own gateway: `config.get` reports Off so the mount-time sync has
// something to adopt, `config.set` echoes whatever was written back.
vi.mock('@/store/gateway', () => ({
  requestGatewayForProfile: vi.fn(async (_profile: string, method: string, params?: Record<string, unknown>) =>
    method === 'config.get' ? { value: 'off' } : { value: params?.value ?? 'smart' }
  )
}))

beforeAll(() => {
  stubResizeObserver()
  stubMenuDomApis()
})

afterEach(() => {
  cleanup()
  $approvalModes.set({})
  $activeGatewayProfile.set('default')
})

const renderChip = () =>
  render(
    <I18nProvider configClient={null} initialLocale="en">
      <ApprovalModeChip />
    </I18nProvider>
  )

describe('composer approval chip', () => {
  // Simple mode hides the statusbar, which used to be the only home of this
  // setting — so the chip has to carry the full contract on its own: read the
  // profile's mode, and write a new one back through the same scoped call.
  it('adopts the profile mode and writes a new one from the composer', async () => {
    renderChip()

    const trigger = await screen.findByRole('button', { name: 'Approval mode: Off' })
    expect(trigger).toBeTruthy()
    expect(requestGatewayForProfile).toHaveBeenCalledWith('default', 'config.get', {
      key: 'approvals.mode',
      profile: 'default'
    })

    fireEvent.pointerDown(trigger, { button: 0 })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /manual/i }))

    const rewritten = await screen.findByRole('button', { name: 'Approval mode: Manual' })
    expect(rewritten).toBeTruthy()
    // Profile named explicitly: an unscoped write would edit whichever profile
    // the backend was launched with instead (#125969).
    expect(requestGatewayForProfile).toHaveBeenCalledWith('default', 'config.set', {
      key: 'approvals.mode',
      profile: 'default',
      value: 'manual'
    })
  })
})
