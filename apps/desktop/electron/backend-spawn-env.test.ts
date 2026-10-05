import assert from 'node:assert/strict'

import { test } from 'vitest'

import { desktopBackendSpawnEnv, guestOnboardingEnabled } from './guest-onboarding'

// Coverage for the desktop spawn env that used to live in guest-onboarding-flag.test.ts
// (deleted on main ahead of the guided-onboarding rewrite) plus the #118080 stay-alive stamp.

test('guestOnboardingEnabled: exactly "1" in env or --guest-onboarding on argv turns the free tier on', () => {
  assert.equal(guestOnboardingEnabled([], { HERMES_GUEST_ONBOARDING: '1' }), true)
  assert.equal(guestOnboardingEnabled(['electron', '.', '--guest-onboarding'], {}), true)

  assert.equal(guestOnboardingEnabled([], {}), false)
  assert.equal(guestOnboardingEnabled([], { HERMES_GUEST_ONBOARDING: 'true' }), false)
  assert.equal(guestOnboardingEnabled([], { HERMES_GUEST_ONBOARDING: '0' }), false)
  assert.equal(guestOnboardingEnabled(['electron', '.', '--local'], { HERMES_GUEST_ONBOARDING: '' }), false)
})

test('desktopBackendSpawnEnv stamps the launch decision last and never lets an inherited value leak', () => {
  const base = {
    HERMES_HOME: '/tmp/home',
    HERMES_DESKTOP: '1',
    HERMES_GUEST_ONBOARDING: '1',
    GATEWAY_ON_ALL_ADAPTERS_DOWN: 'exit',
    PATH: '/usr/bin'
  }

  const on = desktopBackendSpawnEnv({ ...base, HERMES_GUEST_ONBOARDING: '0' }, true)
  assert.equal(on.HERMES_GUEST_ONBOARDING, '1')

  const off = desktopBackendSpawnEnv(base, false)
  assert.equal(off.HERMES_GUEST_ONBOARDING, '0', 'a stray inherited "1" must not turn the free tier on')

  for (const env of [on, off]) {
    assert.equal(env.HERMES_HOME, base.HERMES_HOME)
    assert.equal(env.HERMES_DESKTOP, base.HERMES_DESKTOP)
    assert.equal(env.PATH, base.PATH)
    // The desktop spawns `hermes serve` with no supervising service manager, so the
    // child must stay alive on all-adapters-down instead of exiting EX_TEMPFAIL
    // (#118080). Stamped unconditionally — an inherited value cannot opt the child
    // back into the failure exit.
    assert.equal(env.GATEWAY_ON_ALL_ADAPTERS_DOWN, 'stay_alive')
  }
})

// Enterprise (Plankton) identity: the engine has no build selector of its own, so the
// spawn stamps HERMES_ENTERPRISE ('1' only for the enterprise variant) and the backend
// turns it into the local-only shared-metrics default. Stamped for BOTH states so an
// inherited value can never leak in either direction.
test('desktopBackendSpawnEnv stamps the enterprise identity for exactly the enterprise build', () => {
  const base = { HERMES_HOME: '/tmp/home', HERMES_DESKTOP: '1', PATH: '/usr/bin' }

  assert.equal(desktopBackendSpawnEnv(base, false, true).HERMES_ENTERPRISE, '1')
  assert.equal(desktopBackendSpawnEnv(base, false, false).HERMES_ENTERPRISE, '0')
  // Default (no third argument) is upstream: never enterprise.
  assert.equal(desktopBackendSpawnEnv(base, false).HERMES_ENTERPRISE, '0')
  // A stray inherited marker must not leak in either direction.
  assert.equal(desktopBackendSpawnEnv({ ...base, HERMES_ENTERPRISE: '1' }, false, false).HERMES_ENTERPRISE, '0')
  assert.equal(desktopBackendSpawnEnv({ ...base, HERMES_ENTERPRISE: '0' }, false, true).HERMES_ENTERPRISE, '1')
})

// Batch 2: an enterprise spawn front-loads `<HERMES_HOME>/bin` so the seeded
// `shaoke-cli` resolves ahead of a personal `~/.local/bin` copy (KI-0013). The
// home is pinned in the base; upstream variants (third arg absent/false) keep
// PATH bit-for-bit.
test('desktopBackendSpawnEnv front-loads <HERMES_HOME>/bin for the enterprise build only', () => {
  const base = { HERMES_HOME: '/tmp/plankton-home', PATH: '/usr/bin:/Users/me/.local/bin:/bin' }

  const enterprise = desktopBackendSpawnEnv(base, false, true)
  // PATH key lookup is case-insensitive; the enterprise bin is first.
  const pathKey = Object.keys(enterprise).find(key => key.toUpperCase() === 'PATH')!
  const entries = String(enterprise[pathKey] || '').split(':')
  assert.equal(entries[0], '/tmp/plankton-home/bin')
  assert.ok(entries.includes('/Users/me/.local/bin'))
  assert.ok(entries.indexOf('/tmp/plankton-home/bin') < entries.indexOf('/Users/me/.local/bin'))

  // Upstream: unchanged.
  assert.equal(desktopBackendSpawnEnv(base, false, false).PATH, base.PATH)
  assert.equal(desktopBackendSpawnEnv(base, false).PATH, base.PATH)

  // No HERMES_HOME in the base ⇒ nothing to front-load; PATH untouched.
  assert.equal(desktopBackendSpawnEnv({ PATH: '/usr/bin' }, false, true).PATH, '/usr/bin')
})
