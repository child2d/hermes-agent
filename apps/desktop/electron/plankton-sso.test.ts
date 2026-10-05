/**
 * plankton-sso.test.ts — config precedence + callback validation behavior.
 * Ported intent from the old shell's `tests/sso-config.test.mjs` +
 * `tests/login-window.test.mjs`, expressed as behavior (no source strings).
 */

import { describe, expect, it } from 'vitest'

import {
  normalizeLoginChannel,
  normalizeWhoami,
  parsePlanktonCallback,
  PLANKTON_SSO_DEFAULTS,
  planktonAuthorizeUrl,
  resolvePlanktonSsoConfig,
  validatePlanktonCallback
} from './plankton-sso'

/** A fake fs reader: only the keys present in `files` are readable. */
const readerFor = (files: Record<string, unknown>) => (file: string) => {
  if (!(file in files)) {
    throw new Error(`ENOENT: ${file}`)
  }

  return typeof files[file] === 'string' ? (files[file] as string) : JSON.stringify(files[file])
}

describe('resolvePlanktonSsoConfig — source precedence, secret hygiene', () => {
  it('defaults to the shaoke 240 SSO when nothing is configured', () => {
    const config = resolvePlanktonSsoConfig({ env: {}, stateDir: null, readFile: readerFor({}) })

    expect(config.clientId).toBe(PLANKTON_SSO_DEFAULTS.clientId)
    expect(config.issuer).toBe(PLANKTON_SSO_DEFAULTS.issuer)
    expect(config.redirectUri).toBe(PLANKTON_SSO_DEFAULTS.redirectUri)
    expect(config.ok).toBe(false)
    expect(config.clientSecretSource).toBe('none')
  })

  it('prefers env over the state file, and reports the source', () => {
    const config = resolvePlanktonSsoConfig({
      env: { PLANKTON_OIDC_CLIENT_SECRET: 'env-secret' },
      stateDir: '/state',
      readFile: readerFor({ '/state/sso-config.local.json': { clientSecret: 'file-secret' } })
    })

    expect(config.clientSecret).toBe('env-secret')
    expect(config.clientSecretSource).toBe('env')
    expect(config.ok).toBe(true)
  })

  it('reads the secret from the enterprise state dir, not a bundled file', () => {
    const config = resolvePlanktonSsoConfig({
      env: {},
      stateDir: '/state',
      configDir: '/app/electron',
      isPackaged: true,
      readFile: readerFor({
        '/state/sso-config.local.json': { clientSecret: 'from-state' },
        '/app/electron/sso-config.local.json': { clientSecret: 'from-bundle' }
      })
    })

    expect(config.clientSecret).toBe('from-state')
    expect(config.clientSecretSource).toBe('state')
    expect(config.candidateFiles).toEqual(['/state/sso-config.local.json'])
  })

  it('a packaged build never reads a bundled config file (secret stays out of the asar)', () => {
    const config = resolvePlanktonSsoConfig({
      env: {},
      stateDir: '/state',
      configDir: '/app/electron',
      isPackaged: true,
      readFile: readerFor({ '/app/electron/sso-config.local.json': { clientSecret: 'from-bundle' } })
    })

    expect(config.clientSecret).toBe('')
    expect(config.ok).toBe(false)
  })

  it('treats an unparseable / non-object config file as absent', () => {
    const config = resolvePlanktonSsoConfig({
      env: {},
      stateDir: '/state',
      readFile: readerFor({
        '/state/sso-config.local.json': '{ this is not json',
        '/state/other.json': '[]'
      })
    })

    expect(config.ok).toBe(false)
  })
})

describe('planktonAuthorizeUrl + channel whitelist', () => {
  it('builds the OIDC authorize URL with a provider and escaped params', () => {
    const url = new URL(
      planktonAuthorizeUrl(
        { clientId: 'plankton', issuer: 'https://tech.shaoke.com/sso', redirectUri: 'http://127.0.0.1:18922/callback' },
        { state: 'st-1', channel: 'feishu' }
      )
    )

    expect(url.pathname).toBe('/sso/oidc/authorize')
    expect(url.searchParams.get('client_id')).toBe('plankton')
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:18922/callback')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('state')).toBe('st-1')
    expect(url.searchParams.get('provider')).toBe('feishu')
  })

  it('whitelists the login channel fail-closed (anything but password ⇒ feishu)', () => {
    expect(normalizeLoginChannel('password')).toBe('password')
    expect(normalizeLoginChannel('feishu')).toBe('feishu')
    expect(normalizeLoginChannel('evil')).toBe('feishu')
    expect(normalizeLoginChannel(undefined)).toBe('feishu')
  })
})

describe('parse + validate plankton callback', () => {
  it('extracts code/state from a callback URL', () => {
    const parsed = parsePlanktonCallback('http://127.0.0.1:18922/callback?code=abc&state=st-1')

    expect(parsed).toEqual({ code: 'abc', receivedState: 'st-1', error: null })
  })

  it('a good code + matching state passes', () => {
    const decision = validatePlanktonCallback(
      parsePlanktonCallback('/callback?code=abc&state=st-1'),
      'st-1'
    )

    expect(decision).toEqual({ ok: true, code: 'abc' })
  })

  it('rejects a state mismatch (CSRF)', () => {
    const decision = validatePlanktonCallback(
      parsePlanktonCallback('/callback?code=abc&state=WRONG'),
      'st-1'
    )

    expect(decision.ok).toBe(false)
    expect(decision).toMatchObject({ error: expect.stringContaining('state') })
  })

  it('rejects an IdP error result even when a code is present', () => {
    const decision = validatePlanktonCallback(
      parsePlanktonCallback('/callback?error=access_denied&state=st-1'),
      'st-1'
    )

    expect(decision.ok).toBe(false)
    expect(decision).toMatchObject({ error: expect.stringContaining('access_denied') })
  })

  it('rejects a callback missing the code', () => {
    expect(validatePlanktonCallback(parsePlanktonCallback('/callback?state=st-1'), 'st-1').ok).toBe(false)
  })
})

describe('normalizeWhoami', () => {
  it('requires a stable subject (sub)', () => {
    expect(normalizeWhoami({ name: 'no-sub' })).toBeNull()
    expect(normalizeWhoami({ sub: 'u-1', name: '张三', email: 'a@b.c' })).toMatchObject({ subject: 'u-1', displayName: '张三' })
    expect(normalizeWhoami(null)).toBeNull()
    expect(normalizeWhoami([])).toBeNull()
  })
})
