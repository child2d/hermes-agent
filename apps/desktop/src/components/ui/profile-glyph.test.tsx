import { cleanup, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { defaultCharacterAvatar } from '@/lib/character-avatars'
import { queryClient } from '@/lib/query-client'

const { request, remote } = vi.hoisted(() => ({ request: vi.fn(), remote: vi.fn() }))
vi.mock('@/store/gateway', async () => {
  const { atom } = await import('nanostores')

  return { $gateway: atom({ request }), requestGatewayForAgent: remote }
})
vi.mock('@/store/session', async () => {
  const { atom } = await import('nanostores')

  return { $connection: atom({ connectionId: 'local', baseUrl: 'fixture' }) }
})

import { ProfileGlyph } from './profile-glyph'

afterEach(() => {
  cleanup()
  queryClient.clear()
  vi.clearAllMocks()
})

describe('ProfileGlyph', () => {
  it('shares stable character defaults across scripts and preserves native span props', async () => {
    request.mockResolvedValue({ found: false })

    for (const name of ['default', '研究助手', '👨‍💻', '']) {
      const { container, unmount } = render(
        <ProfileGlyph aria-hidden="true" color={null} isDefault={name === 'default'} name={name} />
      )

      expect(container.querySelector('img')?.getAttribute('src')).toBe(defaultCharacterAvatar(name).image)
      expect(container.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
      unmount()
    }

    await waitFor(() =>
      expect(request).toHaveBeenCalledWith('profiles.get_asset', { name: 'default', asset: 'avatar' })
    )
  })

  it('replaces only legacy face backfills, not explicitly uploaded same-size pictures', async () => {
    const bytes = new Uint8Array(24)
    bytes[19] = 160
    bytes[23] = 160
    const image = `data:image/png;base64,${btoa(String.fromCharCode(...bytes))}`
    request.mockImplementation(async (method: string) =>
      method === 'profiles.get_asset'
        ? { found: true, data: image }
        : {
            profiles: [
              { name: 'legacy', ui_meta: { 'hermes-bots': { imageKind: 'shape' } } },
              { name: 'photo', ui_meta: { 'hermes-bots': { imageKind: 'photo' } } }
            ]
          }
    )
    const legacy = render(<ProfileGlyph color={null} isDefault={false} name="legacy" />)
    const photo = render(<ProfileGlyph color={null} isDefault={false} name="photo" />)
    await waitFor(() => expect(photo.container.querySelector('img')?.getAttribute('src')).toBe(image))
    expect(legacy.container.querySelector('img')?.getAttribute('src')).toBe(defaultCharacterAvatar('legacy').image)
  })

  it('reads each source separately and honors persisted custom art after remount', async () => {
    const image = 'data:image/png;base64,custom'
    request.mockResolvedValue({ found: true, data: image })
    remote.mockResolvedValue({ found: false })
    const { container, unmount } = render(<ProfileGlyph color={null} isDefault={false} name="scout" />)
    await waitFor(() => expect(container.querySelector('img')?.getAttribute('src')).toBe(image))
    unmount()
    const again = render(<ProfileGlyph color={null} isDefault={false} name="scout" />)
    expect(again.container.querySelector('img')?.getAttribute('src')).toBe(image)
    const other = render(<ProfileGlyph color={null} connectionId="remote" isDefault={false} name="scout" />)
    await waitFor(() =>
      expect(remote).toHaveBeenCalledWith('remote', 'default', 'profiles.get_asset', { name: 'scout', asset: 'avatar' })
    )
    expect(other.container.querySelector('img')?.getAttribute('src')).toBe(defaultCharacterAvatar('scout').image)
  })
})
