/**
 * plankton-auth.test.ts — the REQUIREMENT-level chain, against a local stub
 * auth service: 发起登录 → 回调（正确 / 错误）→ 令牌落盘 0600 → 门禁放行/拒绝.
 *
 * This is the acceptance evidence the batch asks for, minus a real human
 * browser login (which cannot be automated — see the handover notes). Every
 * side effect the driver needs is injected, so the WHOLE chain runs for real:
 * a live loopback listener, a live stub OIDC server, real HTTP redirects, a
 * real 0600 file. No source-string assertions.
 */

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createPlanktonAuth, PLANKTON_SESSION_FILE, type PlanktonHttpResult } from './plankton-auth'
import { planktonGateDecision } from './plankton-session-gate'
import { resolvePlanktonSsoConfig } from './plankton-sso'

type StubMode = 'ok' | 'error' | 'badstate' | 'badtoken'
type Stub = { url: string; close: () => Promise<void> }

/** A minimal shaoke-240-SSO-shaped authorization server for tests. */
async function startStubService(mode: StubMode): Promise<Stub> {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1')

    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    }

    if (url.pathname === '/oidc/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri') || ''
      const state = url.searchParams.get('state') || ''
      const target = new URL(redirectUri)

      if (mode === 'error') {
        target.searchParams.set('error', 'access_denied')
      } else {
        target.searchParams.set('code', 'code-1')
        target.searchParams.set('state', mode === 'badstate' ? `wrong-${state}` : state)
      }

      res.writeHead(302, { Location: target.toString() })
      res.end()

      return
    }

    if (url.pathname === '/oidc/token') {
      let body = ''

      req.on('data', chunk => {
        body += chunk
      })
      req.on('end', () => {
        const auth = String(req.headers.authorization || '')
        const form = new URLSearchParams(body)

        if (mode === 'badtoken' || !auth.startsWith('Basic ') || form.get('grant_type') !== 'authorization_code') {
          json(401, { error: 'invalid_client' })

          return
        }

        json(200, { access_token: 'at-fake-value', refresh_token: 'rt-fake-value', token_type: 'Bearer', expires_in: 3600 })
      })

      return
    }

    if (url.pathname === '/oidc/userinfo') {
      const auth = String(req.headers.authorization || '')

      if (!auth.startsWith('Bearer at-')) {
        json(401, { error: 'invalid_token' })

        return
      }

      json(200, { sub: 'u-123', name: '张三', email: 'zhang@example.com' })

      return
    }

    res.writeHead(404)
    res.end()
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return { url: `http://127.0.0.1:${port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}

const postForm = async (
  url: string,
  form: Record<string, string>,
  headers: Record<string, string>
): Promise<PlanktonHttpResult> => {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString()
  })

  return { status: res.status, body: await res.json().catch(() => ({})) }
}

const getJson = async (url: string, headers: Record<string, string>): Promise<PlanktonHttpResult> => {
  const res = await fetch(url, { headers })

  return { status: res.status, body: await res.json().catch(() => ({})) }
}

/** The "system browser": follows the authorize redirect into the loopback listener. */
const openExternal = async (url: string): Promise<void> => {
  await fetch(url)
}

let workDir: string
let stub: Stub | null = null

beforeEach(() => {
  // OUTSIDE ~/.hermes on purpose: the enterprise isolation red line.
  workDir = fs.mkdtempSync(path.join(os.homedir(), 'plankton-verify-auth-'))
})

afterEach(async () => {
  if (stub) {
    await stub.close()
    stub = null
  }

  fs.rmSync(workDir, { recursive: true, force: true })
})

function makeAuth(
  opts: { issuer?: string; secret?: string; sessionDir?: string; timeoutMs?: number } = {}
): ReturnType<typeof createPlanktonAuth> {
  const config = resolvePlanktonSsoConfig({
    env: {
      PLANKTON_OIDC_CLIENT_ID: 'plankton',
      PLANKTON_OIDC_ISSUER: opts.issuer ?? stub?.url ?? 'http://127.0.0.1:1',
      PLANKTON_OIDC_REDIRECT_URI: 'http://127.0.0.1:0/callback',
      ...(opts.secret === undefined ? { PLANKTON_OIDC_CLIENT_SECRET: 'test-client-secret' } : { PLANKTON_OIDC_CLIENT_SECRET: opts.secret })
    }
  })

  return createPlanktonAuth({
    resolveConfig: () => config,
    sessionDir: opts.sessionDir ?? workDir,
    openExternal,
    postForm,
    getJson,
    timeoutMs: opts.timeoutMs ?? 5000
  })
}

describe('plankton SSO login — full chain against a local stub service', () => {
  it('happy path: 发起 → 回调 → 令牌落盘 0600 → 门禁放行', async () => {
    stub = await startStubService('ok')
    const auth = makeAuth()

    const result = await auth.login('feishu')

    expect(result.ok).toBe(true)
    expect(result.whoami?.subject).toBe('u-123')

    // Gate now opens for enterprise data.
    expect(auth.isLoggedIn()).toBe(true)
    expect(planktonGateDecision({ channel: 'hermes:api', loggedIn: auth.isLoggedIn() }).allow).toBe(true)
    expect(auth.identity()).toEqual({ subject: 'u-123', displayName: '张三', authSource: 'plankton-sso' })

    // Token file exists at 0600 and carries NO access token.
    const file = path.join(workDir, PLANKTON_SESSION_FILE)
    expect(fs.existsSync(file)).toBe(true)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)

    const onDisk = fs.readFileSync(file, 'utf-8')
    expect(onDisk).not.toContain('at-fake-value')
    expect(onDisk).toContain('u-123')
  })

  it('wrong result (IdP error) → rejected, gate stays closed', async () => {
    stub = await startStubService('error')
    const auth = makeAuth()

    const result = await auth.login('feishu')

    expect(result.ok).toBe(false)
    expect(auth.isLoggedIn()).toBe(false)
    expect(planktonGateDecision({ channel: 'hermes:api', loggedIn: auth.isLoggedIn() }).allow).toBe(false)
    expect(fs.existsSync(path.join(workDir, PLANKTON_SESSION_FILE))).toBe(false)
  })

  it('wrong result (state mismatch / CSRF) → rejected, gate stays closed', async () => {
    stub = await startStubService('badstate')
    const auth = makeAuth()

    const result = await auth.login('feishu')

    expect(result.ok).toBe(false)
    expect(result.error).toContain('state')
    expect(auth.isLoggedIn()).toBe(false)
    expect(planktonGateDecision({ channel: 'hermes:api', loggedIn: auth.isLoggedIn() }).allow).toBe(false)
  })

  it('wrong result (token exchange rejected) → no session, gate stays closed', async () => {
    stub = await startStubService('badtoken')
    const auth = makeAuth()

    const result = await auth.login('password')

    expect(result.ok).toBe(false)
    expect(auth.isLoggedIn()).toBe(false)
    expect(planktonGateDecision({ channel: 'hermes:api', loggedIn: auth.isLoggedIn() }).allow).toBe(false)
  })

  it('missing client_secret → login is not ready and login fails loudly', async () => {
    stub = await startStubService('ok')
    const auth = makeAuth({ secret: '' })

    const status = auth.status()

    expect(status.loginReady).toBe(false)
    expect(status.loginBlockedReason).toContain('client_secret')

    const result = await auth.login('feishu')

    expect(result.ok).toBe(false)
    expect(auth.isLoggedIn()).toBe(false)
    expect(planktonGateDecision({ channel: 'hermes:api', loggedIn: auth.isLoggedIn() }).allow).toBe(false)
  })

  it('restart path: a persisted session restores login without re-auth', async () => {
    stub = await startStubService('ok')
    const first = makeAuth()

    expect((await first.login('feishu')).ok).toBe(true)

    // Fresh instance, same session dir — as a relaunch would construct it.
    const relaunched = makeAuth()

    expect(relaunched.isLoggedIn()).toBe(true)
    expect(relaunched.identity()?.subject).toBe('u-123')
    expect(planktonGateDecision({ channel: 'hermes:api', loggedIn: relaunched.isLoggedIn() }).allow).toBe(true)
  })

  it('logout clears the session and re-closes the gate (token file removed)', async () => {
    stub = await startStubService('ok')
    const auth = makeAuth()

    await auth.login('feishu')
    auth.logout()

    expect(auth.isLoggedIn()).toBe(false)
    expect(fs.existsSync(path.join(workDir, PLANKTON_SESSION_FILE))).toBe(false)
    expect(planktonGateDecision({ channel: 'list-sessions', loggedIn: auth.isLoggedIn() }).allow).toBe(false)
  })
})
