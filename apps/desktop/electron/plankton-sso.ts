/**
 * plankton-sso.ts — pure SSO(OIDC) config + URL/callback logic for the
 * enterprise (Plankton) build.
 *
 * WHAT THIS IS
 * ------------
 * The old plankton shell (`electron/sso-config.js` + `login-window.js` in
 * `~/Repository/shaoke/codeup/plankton`) resolved a shaoke 240-SSO/OIDC
 * client config and drove an embedded BrowserWindow that intercepted the
 * `http://127.0.0.1:<port>/callback` redirect. This module keeps the two
 * *pure* halves of that port — config resolution and callback/URL handling —
 * so they unit-test with the `electron` vitest project without an Electron
 * runtime.
 *
 * REUSE DECISION (why not upstream's OAuth wholesale)
 * ---------------------------------------------------
 * Upstream's `native-oauth.ts` implements RFC 8252 (system browser + loopback
 * redirect + PKCE) against a Hermes *gateway* (`/auth/native/{authorize,token}`).
 * shaoke 240 SSO is a different authorization server (`<issuer>/oidc/authorize`,
 * `/oidc/token`, `/oidc/userinfo`) that today authenticates the desktop with
 * `client_secret` (Basic), not PKCE — see KI-PLANKTON-0001 (PKCE not yet
 * implemented) and KI-PLANKTON-0005 (authorize URL's provider parameter).
 * Upstream's exact endpoints therefore cannot be reused verbatim.
 *
 * What we DO reuse: the loopback shape itself. Plankton's redirect URI is
 * already `http://127.0.0.1:18922/callback` (a loopback callback), so we keep
 * upstream's *loopback-server* mechanism (see plankton-auth.ts) rather than the
 * old shell's embedded-window redirect interception. The old interception had a
 * real, twice-shipped defect — Electron rejects the initial `loadURL()` with
 * `ERR_ABORTED` when we cancel the redirect, racing the code we just captured
 * (`login-window.js`'s whole rationale). A loopback listener has no such race.
 *
 * KEPT PURE OF ELECTRON: no `import 'electron'`, no network.
 */

import fs from 'node:fs'

import { generateState } from './native-oauth'

/** Default client config for the shaoke 240 SSO (PLK-REQ-0002). */
export const PLANKTON_SSO_DEFAULTS = Object.freeze({
  clientId: 'plankton',
  issuer: 'https://tech.shaoke.com/sso',
  redirectUri: 'http://127.0.0.1:18922/callback'
})

/** The local file name a state-dir config may use (same shape as the old shell). */
export const PLANKTON_SSO_CONFIG_FILE = 'sso-config.local.json'

/** Env var per config key — the highest-precedence source, secret included. */
export const PLANKTON_SSO_ENV_KEYS = Object.freeze({
  clientId: 'PLANKTON_OIDC_CLIENT_ID',
  clientSecret: 'PLANKTON_OIDC_CLIENT_SECRET',
  issuer: 'PLANKTON_OIDC_ISSUER',
  redirectUri: 'PLANKTON_OIDC_REDIRECT_URI'
})

export const PLANKTON_LOGIN_CHANNELS = Object.freeze(['feishu', 'password'] as const)
export type PlanktonLoginChannel = (typeof PLANKTON_LOGIN_CHANNELS)[number]

export interface PlanktonSsoConfig {
  clientId: string
  clientSecret: string
  issuer: string
  redirectUri: string
  /** Where the client_secret came from — lets the UI name the exact fix. */
  clientSecretSource: 'env' | 'state' | 'none'
  clientSecretFile: string | null
  /** Candidate files the resolver consulted, in precedence order. */
  candidateFiles: string[]
  /** True when a client_secret is available at all (login readiness). */
  ok: boolean
}

export interface ResolvePlanktonSsoOptions {
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>
  /** The enterprise data root's `state/` dir; the only packaged file source. */
  stateDir?: string | null
  /** Test/dev fallback dir. Ignored when `isPackaged` is true. */
  configDir?: string | null
  isPackaged?: boolean
  /** Injected for tests; defaults to fs.readFileSync. */
  readFile?: (file: string, encoding: string) => string
}

function trimmed(value: unknown): string {
  return typeof value === 'string' && value.trim() ? value.trim() : ''
}

/** Parse one config file; missing / unreadable / non-object shapes count as "none". */
function readConfig(
  reader: (file: string, encoding: string) => string,
  file: string
): Record<string, unknown> {
  try {
    const parsed = JSON.parse(reader(file, 'utf-8'))

    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/**
 * Resolve the Plankton SSO client config.
 *
 * Precedence per key: env → `<stateDir>/sso-config.local.json` → (dev only)
 * `<configDir>/sso-config.local.json` → built-in default. A packaged build
 * NEVER reads a bundled config file: the client_secret must stay out of the
 * asar (the old shell's hard-won rule — a build machine without the local file
 * produced an app that could not log in, silently). The secret value is never
 * logged or returned anywhere but this struct.
 */
export function resolvePlanktonSsoConfig(
  options: ResolvePlanktonSsoOptions = {}
): PlanktonSsoConfig {
  const env = options.env || {}

  const reader =
    options.readFile || ((file: string, encoding: string) => fs.readFileSync(file, encoding as BufferEncoding))

  const candidates: { source: 'state' | 'bundled'; file: string }[] = []

  if (options.stateDir) {
    candidates.push({ source: 'state', file: `${options.stateDir}/${PLANKTON_SSO_CONFIG_FILE}` })
  }

  if (!options.isPackaged && options.configDir) {
    candidates.push({ source: 'bundled', file: `${options.configDir}/${PLANKTON_SSO_CONFIG_FILE}` })
  }

  const cache = new Map<string, Record<string, unknown>>()

  const dataOf = (file: string): Record<string, unknown> => {
    if (!cache.has(file)) {
      cache.set(file, readConfig(reader, file))
    }

    return cache.get(file) as Record<string, unknown>
  }

  const pick = (
    key: keyof typeof PLANKTON_SSO_ENV_KEYS
  ): { value: string; source: 'env' | 'state' | 'bundled' | 'none'; file: string | null } => {
    const fromEnv = trimmed(env[PLANKTON_SSO_ENV_KEYS[key]])

    if (fromEnv) {
      return { value: fromEnv, source: 'env', file: null }
    }

    for (const candidate of candidates) {
      const value = trimmed(dataOf(candidate.file)[key])

      if (value) {
        return { value, source: candidate.source, file: candidate.file }
      }
    }

    return { value: '', source: 'none', file: null }
  }

  const clientId = pick('clientId')
  const clientSecret = pick('clientSecret')
  const issuer = pick('issuer')
  const redirectUri = pick('redirectUri')

  return {
    clientId: clientId.value || PLANKTON_SSO_DEFAULTS.clientId,
    clientSecret: clientSecret.value,
    issuer: (issuer.value || PLANKTON_SSO_DEFAULTS.issuer).replace(/\/+$/, ''),
    redirectUri: redirectUri.value || PLANKTON_SSO_DEFAULTS.redirectUri,
    clientSecretSource: clientSecret.source === 'bundled' ? 'state' : clientSecret.source,
    clientSecretFile: clientSecret.source === 'bundled' ? candidates[0]?.file ?? null : clientSecret.file,
    candidateFiles: candidates.map(candidate => candidate.file),
    ok: Boolean(clientSecret.value)
  }
}

/** Missing-secret message that names the exact file a packaged build reads. */
export function planktonMissingSecretMessage(candidateFiles: string[] = []): string {
  const where = candidateFiles[0] || `<应用数据根>/state/${PLANKTON_SSO_CONFIG_FILE}`

  return `未配置 plankton client_secret：请写入 ${where}（或设环境变量 ${PLANKTON_SSO_ENV_KEYS.clientSecret}）`
}

/** Whitelist a login channel fail-closed: anything but 'password' is the Feishu flow. */
export function normalizeLoginChannel(value: unknown): PlanktonLoginChannel {
  return value === 'password' ? 'password' : 'feishu'
}

/**
 * Build the OIDC authorize URL the system browser opens. `state` is CSRF
 * defense; `provider` selects the enterprise login channel (KI-PLANKTON-0005).
 */
export function planktonAuthorizeUrl(
  config: Pick<PlanktonSsoConfig, 'clientId' | 'issuer' | 'redirectUri'>,
  params: { state: string; channel: PlanktonLoginChannel }
): string {
  const query = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    scope: 'openid profile email',
    state: params.state,
    provider: params.channel
  })

  return `${config.issuer}/oidc/authorize?${query.toString()}`
}

export function planktonTokenUrl(config: Pick<PlanktonSsoConfig, 'issuer'>): string {
  return `${config.issuer}/oidc/token`
}

export function planktonUserinfoUrl(config: Pick<PlanktonSsoConfig, 'issuer'>): string {
  return `${config.issuer}/oidc/userinfo`
}

/** A fresh high-entropy CSRF `state` (reuses upstream's generator). */
export function newPlanktonState(): string {
  return generateState()
}

export interface ParsedPlanktonCallback {
  code: string | null
  receivedState: string | null
  /** Present when the IdP rejected the flow or the URL could not be parsed. */
  error: string | null
}

/**
 * Parse the loopback callback URL. Unlike upstream's `parseLoopbackCallback`
 * (which throws), this returns the old shell's `{ code, receivedState, error }`
 * shape — the caller decides, so a parse failure is a value, not an exception.
 * No throw also keeps the authorization code out of any thrown stack/log.
 */
export function parsePlanktonCallback(requestUrl: string): ParsedPlanktonCallback {
  try {
    const parsed = new URL(requestUrl, 'http://127.0.0.1')

    return {
      code: parsed.searchParams.get('code'),
      receivedState: parsed.searchParams.get('state'),
      error: parsed.searchParams.get('error')
    }
  } catch {
    return { code: null, receivedState: null, error: '回调地址无法解析' }
  }
}

/**
 * Decide whether a callback is acceptable. Fail-closed: a missing code, an IdP
 * `error`, or a state mismatch is a rejection, never a silent success.
 */
export function validatePlanktonCallback(
  parsed: ParsedPlanktonCallback,
  expectedState: string
): { ok: true; code: string } | { ok: false; error: string } {
  if (parsed.error) {
    return { ok: false, error: `SSO 回调返回错误：${parsed.error}` }
  }

  if (!parsed.code) {
    return { ok: false, error: 'SSO 回调缺少 code' }
  }

  if (!expectedState || parsed.receivedState !== expectedState) {
    return { ok: false, error: 'state 不匹配，拒绝接受回调' }
  }

  return { ok: true, code: parsed.code }
}

/** Basic auth header value for the client_secret token exchange (never logged). */
export function planktonBasicAuth(config: Pick<PlanktonSsoConfig, 'clientId' | 'clientSecret'>): string {
  return Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')
}

/** The identity the app binds to sessions — derived from OIDC userinfo. */
export interface PlanktonWhoami {
  subject: string
  displayName: string | null
  email: string | null
  raw: Record<string, unknown>
}

/**
 * Normalize an OIDC userinfo body into the identity we bind to sessions.
 * Returns null when there is no stable subject — a write action must never be
 * attributed to "someone" (fail-closed: no identity, no attribution).
 */
export function normalizeWhoami(body: unknown): PlanktonWhoami | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    return null
  }

  const record = body as Record<string, unknown>
  const subject = trimmed(record.sub)

  if (!subject) {
    return null
  }

  return {
    subject,
    displayName: trimmed(record.name) || trimmed(record.preferred_username) || null,
    email: trimmed(record.email) || null,
    raw: record
  }
}

/**
 * Restore the identity we persisted. The STORED shape already uses our field
 * names (`subject`/`displayName`), NOT the raw OIDC userinfo (`sub`/`name`) —
 * so it must NOT be run back through `normalizeWhoami`. Crossing the two read
 * the stored session as "no subject" and surfaced as "signed out after every
 * restart" (the same defect class upstream hit in native-token-store.ts).
 */
export function restoreWhoami(stored: unknown): PlanktonWhoami | null {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return null
  }

  const record = stored as Record<string, unknown>
  const subject = trimmed(record.subject)

  if (!subject) {
    return null
  }

  return {
    subject,
    displayName: trimmed(record.displayName) || null,
    email: trimmed(record.email) || null,
    raw: {}
  }
}
