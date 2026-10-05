/**
 * plankton-auth.ts — the Plankton SSO login driver + session store.
 *
 * WHY THIS SHAPE
 * --------------
 * Ported from the old shell's `electron/main.js` SSO block (WP-4). Two parts:
 *
 *  1. `runPlanktonLogin` — the login *driver*. It reuses upstream's loopback
 *     shape (`native-oauth-login.ts`): bind 127.0.0.1, open the system browser
 *     at the authorize URL, catch the `?code=&state=` redirect, verify `state`,
 *     redeem the code. It differs from upstream only where shaoke 240 SSO
 *     differs: the authorize/token/userinfo URLs (`plankton-sso.ts`) and the
 *     `client_secret` Basic exchange (not PKCE — KI-PLANKTON-0001). Every side
 *     effect is injected, so the whole chain runs against a local stub without
 *     booting Electron (`plankton-auth.test.ts`).
 *
 *  2. The session store — persists the WHOAMI and refresh token to
 *     `<sessionDir>/session.json` at mode **0600**. The access token is never
 *     written; the file is the only artifact of a login. As in the old shell,
 *     a fresh launch trusts the persisted session (token refresh is a
 *     follow-up — KI-PLANKTON-0006).
 *
 * NO `import 'electron'`: main.ts supplies `app.getPath('userData')` and
 * `shell.openExternal`; tests supply stubs. That keeps this unit-testable with
 * the `electron` vitest project.
 */

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import { parseTokenResponse } from './native-oauth'
import { planktonSessionIdentity, type PlanktonSessionIdentity } from './plankton-session-gate'
import {
  newPlanktonState,
  normalizeLoginChannel,
  normalizeWhoami,
  parsePlanktonCallback,
  planktonAuthorizeUrl,
  planktonBasicAuth,
  planktonMissingSecretMessage,
  type PlanktonSsoConfig,
  planktonTokenUrl,
  planktonUserinfoUrl,
  type PlanktonWhoami,
  resolvePlanktonSsoConfig,
  restoreWhoami,
  validatePlanktonCallback
} from './plankton-sso'

export const PLANKTON_SESSION_FILE = 'session.json'
export const PLANKTON_LOGIN_TIMEOUT_MS = 5 * 60 * 1000

/** One HTTP response, reduced to what the driver needs. Never carries the request headers. */
export interface PlanktonHttpResult {
  status: number
  body: any
}

export interface PlanktonAuthDeps {
  /** Resolve the client config (env → enterprise state dir). */
  resolveConfig: () => PlanktonSsoConfig
  /** Directory holding `session.json` (the desktop userData's plankton state). */
  sessionDir: string
  /** Open a URL in the user's system browser (shell.openExternal in prod). */
  openExternal: (url: string) => Promise<void>
  /** POST an x-www-form-urlencoded body with extra headers (token exchange). */
  postForm: (
    url: string,
    form: Record<string, string>,
    headers: Record<string, string>,
    opts?: { timeoutMs?: number }
  ) => Promise<PlanktonHttpResult>
  /** GET JSON with headers (userinfo). */
  getJson: (url: string, headers: Record<string, string>, opts?: { timeoutMs?: number }) => Promise<PlanktonHttpResult>
  createServer?: typeof http.createServer
  timeoutMs?: number
  /** Diagnostic sink. MUST NOT receive token/secret values. */
  log?: (line: string) => void
}

export interface PlanktonLoginResult {
  ok: boolean
  whoami?: PlanktonWhoami
  error?: string
}

export interface PlanktonStatus {
  ok: true
  /** Login is possible at all — the client config has a secret. */
  loginReady: boolean
  loginBlockedReason: string | null
  loggedIn: boolean
  whoami: PlanktonWhoami | null
  identity: PlanktonSessionIdentity | null
}

interface StoredSession {
  whoami: PlanktonWhoami
  refreshToken: string | null
}

export interface PlanktonAuth {
  isLoggedIn: () => boolean
  identity: () => PlanktonSessionIdentity | null
  status: () => PlanktonStatus
  login: (provider?: unknown) => Promise<PlanktonLoginResult>
  logout: () => void
  /** Test seam: drop the in-memory cache so the next read hits disk. */
  _resetForTest: () => void
}

/** A safe summary of a whoami for logs — subject only, never email/token. */
function whoamiLogLabel(whoami: PlanktonWhoami | null): string {
  return whoami ? `subject=${whoami.subject}` : 'none'
}

export function createPlanktonAuth(deps: PlanktonAuthDeps): PlanktonAuth {
  const timeoutMs = deps.timeoutMs ?? PLANKTON_LOGIN_TIMEOUT_MS
  const log = deps.log || (() => undefined)
  let cached: StoredSession | null = null
  let loaded = false

  const sessionFile = (): string => path.join(deps.sessionDir, PLANKTON_SESSION_FILE)

  const loadPersisted = (): StoredSession | null => {
    try {
      const raw = JSON.parse(fs.readFileSync(sessionFile(), 'utf-8'))
      const whoami = restoreWhoami(raw?.whoami)

      if (!whoami) {
        return null
      }

      return { whoami, refreshToken: typeof raw?.refreshToken === 'string' ? raw.refreshToken : null }
    } catch {
      return null
    }
  }

  const persist = (session: StoredSession): void => {
    // Owner-only (0700) directory AND 0600 file. `mkdirSync`'s mode applies only
    // to directories it actually creates, so chmod the leaf dir explicitly too —
    // otherwise a pre-existing world-readable dir would leak the session file.
    fs.mkdirSync(deps.sessionDir, { recursive: true, mode: 0o700 })

    try {
      fs.chmodSync(deps.sessionDir, 0o700)
    } catch {
      // best-effort (e.g. a filesystem without POSIX modes)
    }

    const payload = JSON.stringify(
      { whoami: { ...session.whoami, raw: undefined }, refreshToken: session.refreshToken },
      null,
      2
    )

    fs.writeFileSync(sessionFile(), payload, { mode: 0o600 })
    fs.chmodSync(sessionFile(), 0o600)
  }

  const ensureLoaded = (): void => {
    if (!loaded) {
      cached = loadPersisted()
      loaded = true
    }
  }

  const isLoggedIn = (): boolean => {
    ensureLoaded()

    return cached !== null
  }

  const identity = (): PlanktonSessionIdentity | null => {
    ensureLoaded()

    return planktonSessionIdentity(cached?.whoami ?? null)
  }

  const status = (): PlanktonStatus => {
    const config = deps.resolveConfig()
    const loginReady = config.ok
    const whoami = (ensureLoaded(), cached?.whoami ?? null)

    return {
      ok: true,
      loginReady,
      loginBlockedReason: loginReady ? null : planktonMissingSecretMessage(config.candidateFiles),
      loggedIn: whoami !== null,
      whoami,
      identity: planktonSessionIdentity(whoami)
    }
  }

  const exchange = async (config: PlanktonSsoConfig, code: string, redirectUri: string): Promise<PlanktonLoginResult> => {
    const tokenRes = await deps.postForm(
      planktonTokenUrl(config),
      { grant_type: 'authorization_code', code, redirect_uri: redirectUri },
      { Authorization: `Basic ${planktonBasicAuth(config)}` }
    )

    if (tokenRes.status < 200 || tokenRes.status >= 300) {
      // The IdP's `error` field is safe to surface; the body is not echoed whole.
      const reason = typeof tokenRes.body?.error === 'string' ? tokenRes.body.error : `HTTP ${tokenRes.status}`

      return { ok: false, error: `token 交换失败: ${reason}` }
    }

    const tokenSet = parseTokenResponse(tokenRes.body)

    const userRes = await deps.getJson(planktonUserinfoUrl(config), {
      Authorization: `Bearer ${tokenSet.accessToken}`
    })

    if (userRes.status < 200 || userRes.status >= 300) {
      const reason = typeof userRes.body?.error === 'string' ? userRes.body.error : `HTTP ${userRes.status}`

      return { ok: false, error: `userinfo 失败: ${reason}` }
    }

    const whoami = normalizeWhoami(userRes.body)

    if (!whoami) {
      // No stable subject ⇒ no session. A blank/underspecified userinfo must not
      // produce an "authenticated" state we cannot attribute writes to.
      return { ok: false, error: 'userinfo 缺少 sub，无法确定身份' }
    }

    cached = { whoami, refreshToken: tokenSet.refreshToken || null }
    loaded = true
    persist(cached)
    log(`[plankton-sso] signed in (${whoamiLogLabel(whoami)})`)

    return { ok: true, whoami }
  }

  const login = async (provider?: unknown): Promise<PlanktonLoginResult> => {
    const config = deps.resolveConfig()

    if (!config.clientSecret) {
      return { ok: false, error: planktonMissingSecretMessage(config.candidateFiles) }
    }

    const channel = normalizeLoginChannel(provider)
    const state = newPlanktonState()

    let redirect: URL

    try {
      redirect = new URL(config.redirectUri)
    } catch {
      return { ok: false, error: `SSO 回调地址无效：${config.redirectUri}` }
    }

    // The redirect URI pins a fixed loopback port (18922 by default) because the
    // IdP has that redirect registered. If another local process holds the port,
    // `listen` fails and login is refused (server 'error' → finishEarly) — a
    // local DoS on login, not a data leak: no token is exchanged and no session
    // is created. Accepted for now (a random port would need IdP-side dynamic
    // redirect registration); the failure surfaces as a clear bind error.
    const requestedPort = redirect.port ? Number(redirect.port) : redirect.protocol === 'https:' ? 443 : 80
    const createServer = deps.createServer || http.createServer

    return new Promise<PlanktonLoginResult>(resolve => {
      let settled = false
      let timer: NodeJS.Timeout | null = null

      const server = createServer((req, res) => {
        const url = req.url || '/'

        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
        res.end(
          '<!doctype html><meta charset="utf-8"><title>登录完成</title>' +
            '<body style="font:15px system-ui;margin:3rem;text-align:center">' +
            '<h2>✓ 登录已完成</h2><p>请关闭此窗口并返回 Plankton。</p></body>'
        )

        if (settled) {
          return
        }

        // Only the configured callback PATH is a candidate (fail-closed): a
        // request to any other path — a favicon probe, a stray local page —
        // must not reach the token exchange even if it happens to carry
        // `?code=`. Without this, a cross-origin/local request could feed an
        // attacker-chosen code/state into the flow.
        let callbackPath = ''

        try {
          callbackPath = new URL(url, 'http://127.0.0.1').pathname
        } catch {
          return
        }

        if (callbackPath !== redirect.pathname) {
          return
        }

        // Wait for the actual callback path, not a favicon probe.
        if (!/[?&](code|error|state)=/.test(url)) {
          return
        }

        const decision = validatePlanktonCallback(parsePlanktonCallback(url), state)

        if (!decision.ok) {
          finish({ ok: false, error: (decision as { error: string }).error })

          return
        }

        finish(null)
        // Redeem out-of-band, after the browser has been answered.
        exchange(config, decision.code, effectiveRedirectUri)
          .then(result => resolve(result))
          .catch(error =>
            resolve({ ok: false, error: `SSO 登录失败：${error instanceof Error ? error.message : String(error)}` })
          )
      })

      let effectiveRedirectUri = config.redirectUri

      const cleanup = (): void => {
        if (timer) {
          clearTimeout(timer)
        }

        try {
          server.close()
        } catch {
          // already closed
        }
      }

      const finishEarly = (result: PlanktonLoginResult): void => {
        if (settled) {
          return
        }

        settled = true
        cleanup()
        resolve(result)
      }

      // `finish` is the failure/timeout path only; the success path resolves in
      // the exchange chain above.
      const finish = (result: PlanktonLoginResult | null): void => {
        if (settled) {
          return
        }

        settled = true
        cleanup()

        if (result) {
          resolve(result)
        }
      }

      server.on('error', (error: Error) => finishEarly({ ok: false, error: `无法绑定登录回调端口：${error.message}` }))

      server.listen(requestedPort, redirect.hostname, () => {
        const address = server.address() as AddressInfo | null

        if (!address || typeof address === 'string') {
          finishEarly({ ok: false, error: '无法确定登录回调端口' })

          return
        }

        // Port 0 (tests) yields an ephemeral port — the authorize URL and the
        // token exchange must both use the ACTUAL one.
        effectiveRedirectUri = `${redirect.protocol}//${redirect.hostname}:${address.port}${redirect.pathname}`

        timer = setTimeout(
          () => finishEarly({ ok: false, error: 'SSO 登录超时：请在浏览器中完成登录后重试' }),
          timeoutMs
        )

        const authorizeUrl = planktonAuthorizeUrl(
          { clientId: config.clientId, issuer: config.issuer, redirectUri: effectiveRedirectUri },
          { state, channel }
        )

        log(`[plankton-sso] opening system browser for ${channel} sign-in`)

        deps.openExternal(authorizeUrl).catch((error: unknown) =>
          finishEarly({
            ok: false,
            error: `无法打开系统浏览器进行登录：${error instanceof Error ? error.message : String(error)}`
          })
        )
      })
    })
  }

  const logout = (): void => {
    cached = null
    loaded = true

    try {
      fs.unlinkSync(sessionFile())
    } catch {
      // already gone
    }
  }

  return {
    isLoggedIn,
    identity,
    status,
    login,
    logout,
    _resetForTest: () => {
      cached = null
      loaded = false
    }
  }
}

/** Build the production config resolver bound to an Electron main's data roots. */
export function planktonConfigResolver(options: {
  stateDir: string
  configDir: string
  isPackaged: boolean
  env?: NodeJS.ProcessEnv
}): () => PlanktonSsoConfig {
  return () =>
    resolvePlanktonSsoConfig({
      env: options.env ?? process.env,
      stateDir: options.stateDir,
      configDir: options.configDir,
      isPackaged: options.isPackaged
    })
}
