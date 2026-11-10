/**
 * autocode-service.ts
 *
 * Supervises the local AutoCode orchestration service for the embedded page.
 *
 * AutoCode ships two pieces: a FastAPI backend (default port 8787) and a React
 * SPA. `app.main` also mounts `frontend/dist` at `/`, so a built checkout serves
 * both from ONE process — we only spawn the backend, not a vite dev server.
 *
 * Why the app owns the spawn instead of asking the user to run start.ps1:
 * the sidebar entry must work from a cold start ("点击就能用"). It also lets us
 * hand the child two things it cannot discover on its own:
 *
 *   - AUTOCODE_AGENT_PAYLOAD: absolute path to `agent-payload`. A non-package
 *     process cannot even LIST `C:\Program Files\WindowsApps`, so the backend's
 *     own discovery gets PermissionError; only an explicit path works.
 *   - HERMES_HOME: reuse this install's provider config + credentials, so the
 *     agent runs as the same shaoke-agent the user is already signed into.
 *
 * No electron import: everything platform-ish is injected, so the state machine
 * (probe → spawn → poll → ready/failed) is directly assertable in tests.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'

export const AUTOCODE_PORT = 8787
export const AUTOCODE_URL = `http://127.0.0.1:${AUTOCODE_PORT}`
export const AUTOCODE_EMBED_URL = `${AUTOCODE_URL}/?embed=plankton`

/** Health polling budget after a spawn. uvicorn boots in ~1s on a warm venv. */
export const DEFAULT_READY_TIMEOUT_MS = 30_000
const POLL_INTERVAL_MS = 400

export type AutocodeState = 'running' | 'starting' | 'failed' | 'missing'

export interface AutocodeStatus {
  state: AutocodeState
  url: string
  /** True when THIS call spawned the process (vs. finding it already up). */
  spawned: boolean
  /** Actionable one-liner for the page footer; empty when running. */
  detail: string
  pid?: number
}

export interface AutocodeServiceDeps {
  /** Resolve a candidate AutoCode checkout. Injected so tests don't touch disk. */
  exists: (path: string) => boolean
  /** Cheap liveness probe for the running service. */
  isHealthy: () => Promise<boolean>
  /** Start the backend; returns a pid when the platform exposes one. */
  spawnBackend: (home: string, python: string, env: Record<string, string>) => number | undefined
  env: Record<string, string | undefined>
  resourcesPath: string
  log: (message: string) => void
  /**
   * Managed runtime dir prepared by the updater. Takes precedence over the dev
   * checkout: a colleague has no checkout at all, and an installer-bundled
   * baseline (when we ship one) must not shadow a downloaded newer payload.
   */
  homeOverride?: string | null
  /** Per-user state root for config + task data (see BackendEnvInput). */
  stateRoot?: string | null
  sleep?: (ms: number) => Promise<void>
  readyTimeoutMs?: number
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, ms))

/**
 * Checkout candidates, most specific first.
 *
 * `AUTOCODE_HOME` wins so a machine that keeps the repo elsewhere (or a future
 * packaged copy) needs no code change.
 */
export function autocodeHomeCandidates(env: Record<string, string | undefined>): string[] {
  const out: string[] = []
  const explicit = (env.AUTOCODE_HOME || '').trim()
  if (explicit) out.push(explicit)
  // Matches this machine's checkout; harmless elsewhere.
  out.push('D:/codeup/AutoCode', 'D:/codeup/autoCode')
  const userProfile = (env.USERPROFILE || env.HOME || '').trim()
  if (userProfile) out.push(join(userProfile, 'AutoCode'))
  return out
}

/** A usable checkout is one whose backend entrypoint is actually present. */
export function resolveAutocodeHome(
  deps: Pick<AutocodeServiceDeps, 'env' | 'exists'>
): string | null {
  for (const candidate of autocodeHomeCandidates(deps.env)) {
    const main = join(candidate, 'backend', 'app', 'main.py')
    if (deps.exists(main)) return candidate.replace(/\\/g, '/')
  }
  return null
}

/** venv interpreter for the checkout; the checkout's own deps live there. */
export function resolveBackendPythonWith(
  home: string,
  exists: (path: string) => boolean
): string | null {
  const candidates = [
    // dev checkout: the venv sits inside backend/
    join(home, 'backend', '.venv', 'Scripts', 'python.exe'),
    join(home, 'backend', '.venv', 'bin', 'python'),
    // managed payload: the venv is a sibling of backend/ (built by the updater)
    join(home, 'venv', 'Scripts', 'python.exe'),
    join(home, 'venv', 'bin', 'python')
  ]
  for (const candidate of candidates) {
    if (exists(candidate)) return candidate
  }
  return null
}

/**
 * `agent-payload` next to the app resources. Packaged: <resources>/agent-payload.
 * Dev checkout: <repo>/app/resources/agent-payload when built that way, else null
 * and the backend falls back to its own config.
 */
export function resolveAgentPayload(
  deps: Pick<AutocodeServiceDeps, 'resourcesPath' | 'exists'>
): string | null {
  const candidates = [
    join(deps.resourcesPath, 'agent-payload'),
    // WindowsApps layout: <pkg>/app/resources/agent-payload
    join(deps.resourcesPath, '..', 'agent-payload')
  ]
  for (const candidate of candidates) {
    if (deps.exists(join(candidate, 'bin', 'hermes-acp.exe'))) return candidate
    if (deps.exists(join(candidate, 'bin', 'hermes-acp'))) return candidate
  }
  return null
}

export interface BackendEnvInput {
  env: Record<string, string | undefined>
  hermesHome?: string | null
  agentPayload?: string | null
  home: string
  /**
   * Per-user AutoCode state root (config + task data), OUTSIDE the code dir.
   * The managed runtime dir is replaced wholesale on update, so anything the
   * user would miss after an update must live here.
   */
  stateRoot?: string | null
}

/**
 * Environment for the child.
 *
 * `PYTHONPATH` is deliberately dropped: when AutoCode is launched from inside
 * this app it inherits the engine's own site-packages, and pydantic then loads
 * a pydantic_core built for the engine's Python — the backend dies on import
 * with "No module named 'pydantic_core._pydantic_core'". The venv must win.
 */
export function backendEnv(input: BackendEnvInput): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(input.env)) {
    if (value === undefined) continue
    if (key.toUpperCase() === 'PYTHONPATH') continue
    out[key] = value
  }
  out.AUTOCODE_TRUST_PLANKTON = '1'
  out.AUTOCODE_EMBED = 'plankton'
  out.AUTOCODE_HOME = input.home
  if (input.hermesHome) out.HERMES_HOME = input.hermesHome
  if (input.agentPayload) out.AUTOCODE_AGENT_PAYLOAD = input.agentPayload
  if (input.stateRoot) {
    // Keep config + task data out of the code dir: an update replaces that dir.
    out.AUTOCODE_CONFIG = join(input.stateRoot, 'config.yaml')
    out.AUTOCODE_DATA_DIR = join(input.stateRoot, 'data')
    // The host owns the engine choice: embedded AutoCode always runs the
    // desktop's own agent, so the settings radio cannot silently switch it back
    // to a Cursor/DeepSeek that was never installed.
    out.AUTOCODE_AGENT_BACKEND = 'plankton'
  }
  return out
}

/**
 * Probe, spawn if needed, then wait for the service to answer.
 *
 * Idempotent: a second page mount finds the service already up and reports
 * `running` without spawning a duplicate uvicorn (port would be taken anyway,
 * but the child would linger as a zombie).
 */
export async function ensureAutocodeService(
  deps: AutocodeServiceDeps
): Promise<AutocodeStatus> {
  const sleep = deps.sleep ?? defaultSleep
  const readyTimeout = deps.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS

  if (await deps.isHealthy()) {
    return { state: 'running', url: AUTOCODE_EMBED_URL, spawned: false, detail: '' }
  }

  const home = deps.homeOverride || resolveAutocodeHome(deps)
  if (!home) {
    return {
      state: 'missing',
      url: AUTOCODE_EMBED_URL,
      spawned: false,
      detail:
        '未找到 AutoCode 源码目录。请设置 AUTOCODE_HOME，或把仓库放到 D:/codeup/AutoCode。'
    }
  }

  const python = resolveBackendPythonWith(home, deps.exists)
  if (!python) {
    return {
      state: 'missing',
      url: AUTOCODE_EMBED_URL,
      spawned: false,
      detail: `未找到后端虚拟环境：${home}/backend/.venv（先执行 scripts/setup.ps1）。`
    }
  }

  const payload = resolveAgentPayload(deps)
  const env = backendEnv({
    env: deps.env,
    hermesHome: deps.env.HERMES_HOME ?? null,
    agentPayload: payload,
    home,
    stateRoot: deps.stateRoot ?? null
  })

  deps.log(
    `[autocode] starting backend home=${home} python=${python} payload=${payload ?? '(none)'}`
  )

  let pid: number | undefined
  try {
    pid = deps.spawnBackend(home, python, env)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return {
      state: 'failed',
      url: AUTOCODE_EMBED_URL,
      spawned: false,
      detail: `启动 AutoCode 后端失败：${message}`
    }
  }

  const deadline = Date.now() + readyTimeout
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS)
    if (await deps.isHealthy()) {
      return { state: 'running', url: AUTOCODE_EMBED_URL, spawned: true, detail: '', pid }
    }
  }

  return {
    state: 'failed',
    url: AUTOCODE_EMBED_URL,
    spawned: true,
    detail: `AutoCode 后端 ${readyTimeout / 1000}s 内没有就绪，看日志：${home}/backend 控制台输出。`,
    pid
  }
}

/** True when the checkout has a built SPA, i.e. the backend can serve `/`. */
export function hasBuiltFrontend(
  home: string,
  exists: (path: string) => boolean = existsSync
): boolean {
  return exists(join(home, 'frontend', 'dist', 'index.html'))
}

/** Real-CLI argument list for the backend. Exported for tests + logging. */
export function backendArgs(): string[] {
  return ['-m', 'uvicorn', 'app.main:app', '--host', '127.0.0.1', '--port', String(AUTOCODE_PORT)]
}
