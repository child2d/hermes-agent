/**
 * plankton-session-gate.test.ts — behavior contract for the fail-closed gate.
 *
 * These assert the CONTRACT (inputs → decision), not source strings: a
 * refactor that keeps the behavior keeps passing; one that lets a data channel
 * through while logged out cannot.
 */

import { describe, expect, it } from 'vitest'

import {
  isPlanktonGatedChannel,
  isPlanktonPublicChannel,
  PLANKTON_GATED_CHANNELS,
  PLANKTON_PUBLIC_CHANNELS,
  planktonDeniedPayload,
  planktonGateDecision,
  planktonIdentityLabel,
  planktonSessionIdentity
} from './plankton-session-gate'

describe('plankton session gate — fail-closed while unauthenticated', () => {
  it('refuses every gated data channel while logged out (exhaustive, not sampled)', () => {
    for (const channel of PLANKTON_GATED_CHANNELS) {
      const decision = planktonGateDecision({ channel, loggedIn: false })

      expect(decision.allow, `${channel} must be refused`).toBe(false)
      expect(decision.reason).toBe('not-authenticated')
      expect(decision.payload).toEqual(planktonDeniedPayload(channel))
    }
  })

  it('the session list path (hermes:api) is refused while logged out', () => {
    // The single most important channel: every session/chat/config read goes
    // through it, so "no session list while unauthenticated" rides on this.
    expect(planktonGateDecision({ channel: 'hermes:api', loggedIn: false }).allow).toBe(false)
  })

  it('allows the login surface channels while logged out (else login is impossible)', () => {
    for (const channel of PLANKTON_PUBLIC_CHANNELS) {
      expect(planktonGateDecision({ channel, loggedIn: false }).allow, `${channel} must be allowed`).toBe(true)
    }
  })

  it('allows gated channels once authenticated', () => {
    for (const channel of [...PLANKTON_GATED_CHANNELS, ...PLANKTON_PUBLIC_CHANNELS]) {
      expect(planktonGateDecision({ channel, loggedIn: true }).allow, `${channel} must be allowed`).toBe(true)
    }
  })

  it('treats only the strict boolean true as authenticated', () => {
    for (const bogus of ['true', 1, {}, [], null, undefined, 'yes']) {
      expect(
        planktonGateDecision({ channel: 'hermes:api', loggedIn: bogus }).allow,
        `loggedIn=${JSON.stringify(bogus)} must not pass`
      ).toBe(false)
    }
  })

  it('does not accept near-miss channel names as public', () => {
    expect(isPlanktonPublicChannel('plankton:sso-login')).toBe(true)
    expect(planktonGateDecision({ channel: 'PLANKTON:SSO-LOGIN', loggedIn: false }).allow).toBe(false)
    expect(planktonGateDecision({ channel: ' plankton:sso-login', loggedIn: false }).allow).toBe(false)
    expect(isPlanktonGatedChannel('hermes:api ')).toBe(false)
  })

  it('a malformed channel is a refusal, never a pass', () => {
    expect(planktonGateDecision({ channel: '', loggedIn: false }).reason).toBe('bad-channel')
    expect(planktonGateDecision({ channel: 123, loggedIn: false }).allow).toBe(false)
  })

  it('the refusal payload is machine-distinguishable', () => {
    const payload = planktonDeniedPayload('hermes:api')

    expect(payload.ok).toBe(false)
    expect(payload.code).toBe('not-authenticated')
    expect(payload.error).toContain('hermes:api')
  })
})

describe('plankton session identity injection', () => {
  it('derives a subject-bearing identity from whoami', () => {
    const identity = planktonSessionIdentity({ subject: 'u-123', displayName: '张三' })

    expect(identity).toEqual({ subject: 'u-123', displayName: '张三', authSource: 'plankton-sso' })
    expect(planktonIdentityLabel(identity)).toBe('张三')
  })

  it('returns null (cannot attribute) when there is no subject — never a placeholder', () => {
    expect(planktonSessionIdentity(null)).toBeNull()
    expect(planktonSessionIdentity({})).toBeNull()
    expect(planktonSessionIdentity({ subject: '   ' })).toBeNull()
    expect(planktonIdentityLabel(null)).toBeNull()
  })

  it('falls back to the subject as the label when unnamed', () => {
    expect(planktonIdentityLabel(planktonSessionIdentity({ subject: 'u-9' }))).toBe('u-9')
  })
})
