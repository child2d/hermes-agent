/**
 * autocode-updater.ts
 *
 * Fetches the published AutoCode payload and keeps the managed runtime current.
 *
 * Source is a base URL that serves `manifest.json` plus the archive paths it
 * names. `file://` (or a bare directory) is supported on purpose: it lets the
 * whole install/update/rollback path be exercised locally before an OSS bucket
 * exists, and it keeps CI able to smoke-test the artifact it just built.
 *
 * Failure policy is "keep the old version running":
 *   - download/verify/extract errors never touch the live dir (install writes to
 *     a staging dir and renames)
 *   - a boot failure rolls back one step and marks the sha bad
 *   - every failure is reported with the step that broke, because "更新失败"
 *     alone gives the user nothing to act on
 */

import { createHmac } from 'node:crypto'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'

import {
  type PayloadManifest,
  type RuntimeState,
  PayloadError,
  activeHome,
  commitState,
  decideInstall,
  installPayload,
  parseManifest,
  readState,
  rollbackState,
  runtimeDirFor,
  statePath
} from './autocode-payload'

export interface UpdateResult {
  home: string | null
  state: RuntimeState | null
  changed: boolean
  /** Human-readable line for the page footer / logs. Empty when up to date. */
  detail: string
}

export interface UpdaterDeps {
  runtimeRoot: string
  /** Base URL ('https://…/autocode', 'file:///d/payloads') or absolute dir. */
  manifestUrl: string
  planktonVersion: string
  log: (message: string) => void
  /** Injected for tests; defaults to node's fs. */
  fetchText?: (url: string) => Promise<string>
  fetchBinary?: (url: string) => Promise<Buffer>
  /** Injected for tests; defaults to the real child-process runner. */
  runCommand?: (command: string, args: string[], cwd: string) => Promise<void>
  /** Python used to create the venv. Resolved lazily so tests can skip it. */
  resolvePython?: () => string | null
}

// ─────────────────────────────────────────────────────────── fetch

function toLocalPath(url: string): string | null {
  if (url.startsWith('file://')) {
    const withoutScheme = url.slice('file://'.length)
    // file:///d/x → /d/x ; file://d:/x → d:/x
    return decodeURIComponent(withoutScheme.replace(/^\/([a-zA-Z]:)/, '$1'))
  }
  if (/^[a-zA-Z]:[\\/]/.test(url) || (!/^[a-z]+:\/\//i.test(url) && path.isAbsolute(url))) {
    return url
  }
  if (url.startsWith('/')) return url

  return null
}

function joinUrl(base: string, rel: string): string {
  const local = toLocalPath(base)
  if (local) return path.join(local, ...rel.split('/'))

  return `${base.replace(/\/+$/, '')}/${rel.replace(/^\/+/, '')}`
}

// ─────────────────────────────────────────────────────────── oss auth

/**
 * OSS V1 signature for a GET.
 *
 * Needed because this bucket sits behind "block public access": anonymous reads
 * are refused and `acs:SourceIp` conditions additionally require
 * `acs:SourceVpc`, which a desktop client on the public internet can never
 * satisfy. So the client authenticates.
 *
 * Signature string (OSS V1, GET with no special headers):
 *   VERB\nContent-MD5\nContent-Type\nDate\nCanonicalizedOSSHeaders + CanonicalizedResource
 * CanonicalizedResource is `/bucket/key` (no sub-resources here).
 */
export function ossSignedHeaders(
  url: string,
  ak: string,
  sk: string,
  date: string = new Date().toUTCString()
): Record<string, string> {
  const parsed = new URL(url)
  const bucket = parsed.hostname.split('.')[0]
  const resource = `/${bucket}${parsed.pathname}`
  const toSign = `GET\n\n\n${date}\n${resource}`
  const signature = createHmac('sha1', sk).update(toSign, 'utf8').digest('base64')

  return { Date: date, Authorization: `OSS ${ak}:${signature}` }
}

function ossCreds(): { ak: string; sk: string } | null {
  const ak = (process.env.AUTOCODE_OSS_AK || '').trim()
  const sk = (process.env.AUTOCODE_OSS_SK || '').trim()
  return ak && sk ? { ak, sk } : null
}

async function authHeadersFor(url: string): Promise<Record<string, string>> {
  const creds = ossCreds()
  return creds ? ossSignedHeaders(url, creds.ak, creds.sk) : {}
}

async function defaultFetchText(url: string): Promise<string> {
  const local = toLocalPath(url)
  if (local) return fs.promises.readFile(local, 'utf8')
  const res = await fetch(url, { headers: await authHeadersFor(url) })
  if (!res.ok) throw new PayloadError(`GET ${url} → HTTP ${res.status}`)

  return res.text()
}

async function defaultFetchBinary(url: string): Promise<Buffer> {
  const local = toLocalPath(url)
  if (local) return fs.promises.readFile(local)
  const res = await fetch(url, { headers: await authHeadersFor(url) })
  if (!res.ok) throw new PayloadError(`GET ${url} → HTTP ${res.status}`)
  const array = await res.arrayBuffer()

  return Buffer.from(array)
}

// ─────────────────────────────────────────────────────────── venv

/** Marker recording which requirements.lock the venv was built from. */
const VENV_MARKER = '.autocode-deps.json'

export function venvPython(home: string): string {
  return process.platform === 'win32'
    ? path.join(home, 'venv', 'Scripts', 'python.exe')
    : path.join(home, 'venv', 'bin', 'python')
}

export function venvReady(home: string, requirementsHash: string): boolean {
  try {
    const marker = JSON.parse(fs.readFileSync(path.join(home, 'venv', VENV_MARKER), 'utf8')) as {
      requirementsHash?: string
    }

    return Boolean(marker.requirementsHash) && marker.requirementsHash === requirementsHash && fs.existsSync(venvPython(home))
  } catch {
    return false
  }
}

/**
 * Environment for python/pip subprocesses.
 *
 * `PYTHONPATH` must go: when the desktop app spawns this, the engine's own
 * site-packages are on it. pip then decides fastapi/pydantic are "already
 * satisfied" and installs nothing, leaving a venv that imports the ENGINE's
 * packages — which breaks the moment the engine venv moves or its python
 * differs. Observed exactly that: 11 packages installed instead of ~30.
 * `PYTHONNOUSERSITE` blocks the same leak via the user site directory.
 */
export function scrubPythonEnv(
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    const upper = key.toUpperCase()
    if (upper === 'PYTHONPATH' || upper === 'PYTHONHOME') continue
    out[key] = value
  }
  out.PYTHONNOUSERSITE = '1'
  out.PIP_DISABLE_PIP_VERSION_CHECK = '1'

  return out
}

function defaultRunCommand(command: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: scrubPythonEnv(),
      stdio: 'ignore',
      windowsHide: true
    })
    child.on('error', error => reject(new PayloadError(`${command} 启动失败: ${error.message}`)))
    child.on('exit', code => {
      if (code === 0) resolve()
      else reject(new PayloadError(`${command} ${args.join(' ')} 退出码 ${code}`))
    })
  })
}

/**
 * Build the venv for a runtime dir. ~180MB of wheels, so it is done once per
 * requirements.lock change, never per code change — that is the whole reason
 * the payload ships `requirements.lock` instead of a venv.
 */
export async function ensureVenv(
  home: string,
  requirementsHash: string,
  deps: Pick<UpdaterDeps, 'log' | 'runCommand' | 'resolvePython'>
): Promise<void> {
  if (venvReady(home, requirementsHash)) return

  const python = deps.resolvePython?.() ?? null
  if (!python) {
    throw new PayloadError(
      '需要 Python 来创建后端运行环境，但没找到解释器。设置 AUTOCODE_PYTHON 指向 python.exe 后重试。'
    )
  }

  const run = deps.runCommand ?? defaultRunCommand
  deps.log(`[autocode] preparing venv at ${home} (python=${python})`)
  const venvDir = path.join(home, 'venv')
  fs.rmSync(venvDir, { recursive: true, force: true })
  await run(python, ['-m', 'venv', venvDir], home)

  // A "successful" venv command that produced no interpreter means the wrong
  // python ran (e.g. a launcher shim). Fail here with the path, not later with
  // an opaque spawn error from the service.
  if (!fs.existsSync(venvPython(home))) {
    throw new PayloadError(`创建虚拟环境失败：${venvPython(home)} 不存在`)
  }

  const locked = path.join(home, 'backend', 'requirements.lock')
  const requirements = fs.existsSync(locked)
    ? locked
    : path.join(home, 'backend', 'requirements.txt')
  await run(venvPython(home), ['-m', 'pip', 'install', '--disable-pip-version-check', '-r', requirements], home)
  fs.mkdirSync(venvDir, { recursive: true })
  fs.writeFileSync(
    path.join(venvDir, VENV_MARKER),
    JSON.stringify({ requirementsHash, createdAt: new Date().toISOString() }, null, 2),
    'utf8'
  )
}

// ─────────────────────────────────────────────────────────── sync

export function manifestLocation(deps: Pick<UpdaterDeps, 'manifestUrl'>): string {
  const base = deps.manifestUrl.trim()
  const local = toLocalPath(base)
  if (local) return path.join(local, 'manifest.json')

  return `${base.replace(/\/+$/, '')}/manifest.json`
}

/**
 * One sync pass: read local state, fetch the manifest, install if needed,
 * ensure the venv, and report where the service should run from.
 *
 * Never throws for "nothing to do" conditions; throws only when an install was
 * attempted and failed, so the caller can decide between rollback and a
 * user-visible error.
 */
export async function syncRuntime(deps: UpdaterDeps): Promise<UpdateResult> {
  if (!deps.manifestUrl.trim()) {
    const state = readState(deps.runtimeRoot)
    return {
      home: activeHome(deps.runtimeRoot, state),
      state,
      changed: false,
      detail: ''
    }
  }

  const getText = deps.fetchText ?? defaultFetchText
  const getBinary = deps.fetchBinary ?? defaultFetchBinary

  const location = manifestLocation(deps)
  let manifest: PayloadManifest
  try {
    manifest = parseManifest(JSON.parse(await getText(location)))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    const state = readState(deps.runtimeRoot)
    return {
      home: activeHome(deps.runtimeRoot, state),
      state,
      changed: false,
      detail: `检查更新失败（继续用当前版本）：${reason}`
    }
  }

  const state = readState(deps.runtimeRoot)
  const decision = decideInstall(state, manifest, deps.planktonVersion)
  if (!decision.install) {
    deps.log(`[autocode] ${decision.reason}`)
    const home = activeHome(deps.runtimeRoot, state)
    if (home) {
      await ensureVenv(home, state?.requirementsHash ?? manifest.requirementsHash, deps)
    }

    return { home, state, changed: false, detail: '' }
  }

  deps.log(`[autocode] ${decision.reason}`)
  const archiveUrl = joinUrl(deps.manifestUrl, manifest.archive)
  const archive = await getBinary(archiveUrl)
  const home = installPayload({
    runtimeRoot: deps.runtimeRoot,
    manifest,
    archive
  })
  const next = commitState(deps.runtimeRoot, manifest, state)
  await ensureVenv(home, manifest.requirementsHash, deps)

  return {
    home,
    state: next,
    changed: true,
    detail: `${decision.reason}`
  }
}

/**
 * Called when the freshly installed runtime fails to boot. Steps back one
 * version so the user keeps a working service instead of a dead rail entry.
 */
export function rollbackRuntime(runtimeRoot: string, failedSha: string): UpdateResult {
  const state = rollbackState(runtimeRoot, failedSha)
  const home = activeHome(runtimeRoot, state)

  return {
    home,
    state,
    changed: true,
    detail: state?.sha
      ? `新版本启动失败，已回退到 ${state.sha.slice(0, 8)}`
      : '新版本启动失败，且没有可回退的旧版本'
  }
}

export { statePath, runtimeDirFor }
