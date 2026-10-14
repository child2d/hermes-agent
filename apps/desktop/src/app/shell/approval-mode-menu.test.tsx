import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { StatusbarControls } from '@/app/shell/statusbar-controls'
import { $approvalModes } from '@/store/approval-mode'
import { requestGatewayForProfile } from '@/store/gateway'
import { stubMenuDomApis, stubResizeObserver } from '@/test/jsdom'

import { useApprovalModeStatusbarItem } from './approval-mode-menu'

// The control builds its own profile-scoped dispatcher (`useApprovalModeControl`),
// so the gateway module is the seam.
vi.mock('@/store/gateway', () => ({
  requestGatewayForProfile: vi.fn(async (_profile: string, method: string, params?: Record<string, unknown>) =>
    method === 'config.get' ? { value: 'smart' } : { value: params?.value ?? 'smart' }
  )
}))

beforeAll(() => {
  stubResizeObserver()
  stubMenuDomApis()
})

afterEach(() => {
  cleanup()
  $approvalModes.set({})
})

function Harness({ profile = 'default' }: { profile?: string }) {
  const item = useApprovalModeStatusbarItem(profile)

  return (
    <MemoryRouter>
      <StatusbarControls items={[item]} />
    </MemoryRouter>
  )
}

describe('approval mode statusbar item', () => {
  it('writes the selected mode through the gateway and updates its shared trigger label', async () => {
    render(<Harness profile="work" />)

    fireEvent.pointerDown(screen.getByRole('button', { name: /smart/i }), { button: 0 })
    fireEvent.click(await screen.findByRole('menuitemradio', { name: /manual/i }))

    await waitFor(() => {
      // The menu shows the "work" profile, so the write must name it (#125969); an unscoped
      // `config.set` would edit whichever profile the backend was launched with instead.
      expect(requestGatewayForProfile).toHaveBeenCalledWith('work', 'config.set', {
        key: 'approvals.mode',
        profile: 'work',
        value: 'manual'
      })
      expect(screen.getByRole('button', { name: /manual/i })).toBeTruthy()
    })
  })
})
