/**
 * Real-process integration: the supervisor path main.ts actually runs.
 *
 * Everything else about `ensureAutocodeService` is asserted with injected fakes.
 * This one spawns the real backend through `backendArgs()` + `backendEnv()` and
 * waits on a real HTTP `/health`, so a break in either helper, in the venv
 * resolution, or in the PYTHONPATH scrub shows up here instead of on the user's
 * first click.
 *
 * Self-gating: skips when the port is busy (a dev server is already up — the
 * supervisor would correctly report `running` without spawning, which the unit
 * tests already cover) or when this machine has no AutoCode checkout.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  AUTOCODE_PORT,
  backendArgs,
  backendEnv,
  ensureAutocodeService,
  resolveAutocodeHome,
  resolveBackendPythonWith
} from './autocode-service'

function portFree(port: number): Promise<boolean> {
  return new Promise(resolve => {
    const socket = net.connect({ host: '127.0.0.1', port })
    socket.once('connect', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(true))
    socket.setTimeout(1000, () => {
      socket.destroy()
      resolve(true)
    })
  })
}

function healthy(): Promise<boolean> {
  return new Promise(resolve => {
    const req = http.get({ host: '127.0.0.1', port: AUTOCODE_PORT, path: '/health', timeout: 1500 }, res => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
    req.on('error', () => resolve(false))
  })
}

describe('ensureAutocodeService (real process)', () => {
  const spawned: ReturnType<typeof spawn>[] = []

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      if (child.exitCode === null) child.kill()
    }
  })

  test('spawns the real backend and reports running', async () => {
    const home = resolveAutocodeHome({ env: process.env, exists: existsSync })
    if (!home) {
      console.warn('[autocode int] skipped: no AutoCode checkout on this machine')
      return
    }
    const python = resolveBackendPythonWith(home, existsSync)
    if (!python) {
      console.warn('[autocode int] skipped: checkout has no backend/.venv')
      return
    }
    if (!(await portFree(AUTOCODE_PORT))) {
      console.warn(`[autocode int] skipped: :${AUTOCODE_PORT} already in use`)
      return
    }

    const status = await ensureAutocodeService({
      exists: existsSync,
      isHealthy: healthy,
      spawnBackend: (homeDir, pythonExe, env) => {
        const child = spawn(pythonExe, backendArgs(), {
          cwd: path.join(homeDir, 'backend'),
          env,
          stdio: 'ignore'
        })
        spawned.push(child)

        return child.pid
      },
      env: process.env as Record<string, string | undefined>,
      resourcesPath: 'C:/nowhere',
      log: () => {},
      // uvicorn + config load over ~260 task dirs: allow a generous boot.
      readyTimeoutMs: 60_000
    })

    expect(status.state).toBe('running')
    expect(status.spawned).toBe(true)
    expect(await healthy()).toBe(true)
  }, 120_000)

  test('backendEnv keeps the venv importable when the parent leaks PYTHONPATH', () => {
    // The exact failure: inherited engine site-packages shadow the venv and
    // pydantic_core fails to load. Assert the scrub holds for the spawn env.
    const env = backendEnv({
      env: { ...process.env, PYTHONPATH: 'C:/engine/venv/Lib/site-packages' },
      home: 'D:/codeup/AutoCode',
      hermesHome: 'C:/home',
      agentPayload: 'C:/payload'
    })
    expect(Object.keys(env).map(key => key.toUpperCase())).not.toContain('PYTHONPATH')
    expect(env.AUTOCODE_AGENT_PAYLOAD).toBe('C:/payload')
    expect(env.HERMES_HOME).toBe('C:/home')
  })
})
