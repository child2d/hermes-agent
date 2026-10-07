import { afterEach, beforeEach, expect, it, vi } from 'vitest'

import type { ProfileInfo } from '@/types/hermes'

// getProfiles() is the single door every renderer consumer of /api/profiles
// shares, so this is the right place to pin its output contract: the resolved
// envelope is ALWAYS `{ profiles: ProfileInfo[] }` with object-only elements,
// while a healthy payload keeps its exact identity.
const { getProfiles } = await import('./profiles')

const healthy: ProfileInfo = {
  has_env: false,
  is_default: true,
  model: null,
  name: 'default',
  path: '/tmp/hermes/default',
  provider: null,
  skill_count: 0
}

let warn: ReturnType<typeof vi.spyOn>

function stubApi(result: unknown) {
  const api = vi.fn(async () => result)
  Object.defineProperty(window, 'hermesDesktop', { configurable: true, value: { api } })

  return api
}

beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterEach(() => {
  warn.mockRestore()
  Reflect.deleteProperty(window, 'hermesDesktop')
})

it('passes a healthy response through with byte-identical identity and no warn', async () => {
  const raw = { profiles: [healthy] }
  const api = stubApi(raw)

  const result = await getProfiles()

  // Same envelope object AND same array — the success path is untouched.
  expect(result).toBe(raw)
  expect(result.profiles).toBe(raw.profiles)
  expect(warn).not.toHaveBeenCalled()

  // The request itself is unchanged too.
  expect(api).toHaveBeenCalledWith(expect.objectContaining({ path: '/api/profiles' }))
})

it('turns a response that omits `profiles` into an empty list and warns', async () => {
  stubApi({ offset: 0, total: 5 }) // 2xx body with no `profiles` key

  const result = await getProfiles()

  // The app shell runs `profiles.find(...)` on every render — the exact line
  // that took the renderer down. It must not throw on this payload (without
  // the guard this is `TypeError: … reading 'find'`).
  expect(() => result.profiles.find(profile => profile.is_default)).not.toThrow()
  expect(result.profiles).toEqual([])
  // Observable, not silent — shape/keys only.
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('[profiles]'))
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("'profiles' absent"))
})

it('turns a null `profiles` into an empty list and warns', async () => {
  stubApi({ profiles: null })

  const result = await getProfiles()

  expect(result.profiles).toEqual([])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("'profiles' null"))
})

it('turns a non-array `profiles` into an empty list and warns', async () => {
  stubApi({ profiles: 'not-a-list' })

  const result = await getProfiles()

  expect(result.profiles).toEqual([])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining("'profiles' string"))
})

it('drops a null element so a downstream `profiles.find(p => p.name)` cannot throw', async () => {
  // The review's exact repro: { profiles: [null, {name:'ok'}] } used to survive
  // the container-only guard, and the modal's find() then threw
  // `TypeError: Cannot read properties of null (reading 'name')`.
  stubApi({ profiles: [null, { ...healthy, is_default: false, name: 'ok' }] })

  const result = await getProfiles()

  expect(result.profiles.map(profile => profile.name)).toEqual(['ok'])
  expect(() => result.profiles.find(profile => (profile.name ?? '').trim())).not.toThrow()
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 1 non-object element'))
})

it('drops every non-object element (string, number, array, null) and keeps records', async () => {
  stubApi({
    profiles: ['x', 42, [], null, { ...healthy, is_default: false, name: 'kept' }]
  })

  const result = await getProfiles()

  expect(result.profiles.map(profile => profile.name)).toEqual(['kept'])
  expect(warn).toHaveBeenCalledWith(expect.stringContaining('dropped 4 non-object element(s) of 5'))
})

it('keeps the warn shape-level: element VALUES never reach the log', async () => {
  stubApi({ profiles: ['sk-live-DEADBEEF-token'] })

  const result = await getProfiles()

  expect(result.profiles).toEqual([])

  const messages = warn.mock.calls.map((call: unknown[]) => String(call[0]))
  expect(messages.join('\n')).not.toContain('sk-live-DEADBEEF-token')
})
