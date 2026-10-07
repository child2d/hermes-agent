import { atom } from 'nanostores'
import { afterEach, expect, it, vi } from 'vitest'

import type { HermesConnection } from '@/global'
import type { ProfileInfo } from '@/types/hermes'

// Keep profile.ts's side-effecting imports inert — same seam as
// profile-cache.test.ts: the gateway socket layer and the REST query client
// must not run for real in a unit test.
vi.mock('@/store/gateway', () => ({ $gateway: atom(null) }))
vi.mock('@/lib/query-client', () => ({ invalidateProfileScopedQueries: vi.fn() }))
vi.mock('@/store/starmap', () => ({ resetStarmapGraph: vi.fn() }))

const { $profiles, $profilesByConnection, invalidateProfileListFetches, refreshProfiles } = await import('./profile')

const { $connection } = await import('./session')

const descriptor = (connectionId: string): HermesConnection =>
  ({ connectionId, baseUrl: `https://${connectionId}.example.com`, mode: 'remote', profile: 'default' }) as HermesConnection

afterEach(() => {
  invalidateProfileListFetches()
  $connection.set(null)
  $profiles.set([])
  $profilesByConnection.set(new Map())
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// Regression: right after a successful login the app pulls the profile list
// before the local backend is allowed to spawn, and that response can come
// back WITHOUT the `profiles` field. getProfiles() destructures `{ profiles }`
// → undefined, which used to be written straight into $profiles (and into the
// $profilesByConnection cache); the app-shell renderer then died on
// `profiles.find(...)`
// (TypeError: Cannot read properties of undefined (reading 'find')).
it('keeps $profiles (and the per-connection cache) an array when /api/profiles omits the profiles field', async () => {
  $connection.set(descriptor('stub-source'))
  const api = vi.fn(async () => ({})) // body: no `profiles` key at all
  vi.stubGlobal('window', { hermesDesktop: { api } })

  await refreshProfiles()

  expect(Array.isArray($profiles.get())).toBe(true)
  expect($profiles.get()).toEqual([])
  // A value here is summed as `list.length` by use-desktop-metrics — it must be
  // an array too, never `undefined`.
  expect(Array.isArray($profilesByConnection.get().get('stub-source'))).toBe(true)
})

it('keeps a healthy array payload byte-identical', async () => {
  $connection.set(descriptor('stub-source'))

  const list: ProfileInfo[] = [
    {
      has_env: false,
      is_default: true,
      model: null,
      name: 'default',
      path: '/tmp/hermes/default',
      provider: null,
      skill_count: 0
    }
  ]

  const api = vi.fn(async () => ({ profiles: list }))
  vi.stubGlobal('window', { hermesDesktop: { api } })

  await refreshProfiles()

  // Same identity — the guard must not copy or re-wrap a valid list.
  expect($profiles.get()).toBe(list)
  expect($profilesByConnection.get().get('stub-source')).toBe(list)
})
