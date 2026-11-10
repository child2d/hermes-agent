/**
 * autocode-payload.ts
 *
 * Managed runtime for the embedded AutoCode service.
 *
 * Why this exists: the page must work on a colleague's machine that has neither
 * the AutoCode checkout nor a build toolchain, and an AutoCode logic change
 * must NOT require re-packaging Plankton. So the service code lives in a
 * managed directory the app owns, and it updates itself from a published
 * manifest:
 *
 *   %LOCALAPPDATA%/AutoCode/
 *     runtime/<sha>/        backend/ + frontend/dist/ + requirements.lock + venv/
 *     current.json          { sha, requirementsHash, previousSha, badShas }
 *
 * The artifact is a `tar.gz` — deliberately NOT a zip:
 *   - Node ships gzip, and a tar header is 512 bytes of fixed layout, so this
 *     module needs no third-party extractor (a transitive electron dep would be
 *     an undeclared dependency we do not control).
 *   - CI produces it with plain `tar czf`, no tooling on the Windows side.
 *
 * Security posture: the archive comes from an internal host, but it is still
 * untrusted input. Every entry is validated (no absolute paths, no `..`, no
 * symlinks/hardlinks, no devices) and the whole archive is verified against the
 * manifest's sha256 before a single byte is written outside a staging dir.
 */

import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

export const PAYLOAD_SCHEMA = 1

/** Files the runtime cannot start without. Checked after extraction. */
const REQUIRED_ENTRIES = [
  'backend/app/main.py',
  'backend/requirements.lock',
  'frontend/dist/index.html'
]

export interface PayloadManifest {
  schema: number
  /** Git commit the payload was built from. Doubles as the install dir name. */
  sha: string
  version: string
  builtAt: string
  /** Hash of requirements.lock; a change means the venv must be rebuilt. */
  requirementsHash: string
  /** Oldest Plankton that may install this payload. */
  minPlankton?: string
  /** Path relative to the manifest URL. */
  archive: string
  archiveSha256: string
  archiveBytes: number
}

export interface RuntimeState {
  sha: string
  requirementsHash: string
  /** Previously working sha, for rollback after a failed start. */
  previousSha?: string
  /** Shas that failed to boot; never auto-installed again. */
  badShas: string[]
}

export class PayloadError extends Error {}

// ─────────────────────────────────────────────────────────── manifest

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new PayloadError(`manifest.${field} 缺失或不是字符串`)
  }

  return value.trim()
}

/**
 * Validate a manifest. Throws instead of coercing: a half-valid manifest would
 * install a half-valid runtime and the failure would surface as a confusing
 * "backend won't start" much later.
 */
export function parseManifest(raw: unknown): PayloadManifest {
  if (!raw || typeof raw !== 'object') throw new PayloadError('manifest 不是 JSON 对象')
  const obj = raw as Record<string, unknown>

  const schema = typeof obj.schema === 'number' ? obj.schema : Number(obj.schema)
  if (schema !== PAYLOAD_SCHEMA) {
    throw new PayloadError(`manifest.schema=${String(obj.schema)}，本版本只支持 ${PAYLOAD_SCHEMA}`)
  }

  const sha = asString(obj.sha, 'sha')
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new PayloadError(`manifest.sha 不像 commit: ${sha}`)

  const archiveSha256 = asString(obj.archiveSha256, 'archiveSha256').toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(archiveSha256)) {
    throw new PayloadError('manifest.archiveSha256 不是 sha256')
  }

  const bytes = Number(obj.archiveBytes)
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new PayloadError('manifest.archiveBytes 非法')
  }

  const requirementsHash = asString(obj.requirementsHash, 'requirementsHash')
  const archive = asString(obj.archive, 'archive')
  if (archive.includes('..') || path.isAbsolute(archive)) {
    throw new PayloadError(`manifest.archive 路径非法: ${archive}`)
  }

  return {
    schema,
    sha,
    version: typeof obj.version === 'string' ? obj.version : sha.slice(0, 8),
    builtAt: typeof obj.builtAt === 'string' ? obj.builtAt : '',
    requirementsHash,
    minPlankton: typeof obj.minPlankton === 'string' ? obj.minPlankton : undefined,
    archive,
    archiveSha256,
    archiveBytes: bytes
  }
}

/** True when the running build is at least `minimum` (dotted numeric compare). */
export function versionAtLeast(current: string, minimum: string): boolean {
  const parse = (value: string): number[] =>
    value
      .split(/[.+-]/)
      .map(part => Number.parseInt(part, 10))
      .map(n => (Number.isFinite(n) ? n : 0))
  const a = parse(current)
  const b = parse(minimum)
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const left = a[i] ?? 0
    const right = b[i] ?? 0
    if (left !== right) return left > right
  }

  return true
}

export interface InstallDecision {
  install: boolean
  reason: string
}

/**
 * Decide whether to install.
 *
 * A sha that previously failed to boot is skipped even if it is newer: retrying
 * a known-bad build on every click turns the rail entry into a slow failure
 * loop. Only a NEWER sha clears the bad mark implicitly.
 */
export function decideInstall(
  state: RuntimeState | null,
  manifest: PayloadManifest,
  planktonVersion: string
): InstallDecision {
  if (manifest.minPlankton && !versionAtLeast(planktonVersion, manifest.minPlankton)) {
    return { install: false, reason: `payload 需要 Plankton >= ${manifest.minPlankton}` }
  }
  if (state?.sha === manifest.sha) {
    return { install: false, reason: '已是最新' }
  }
  if (state?.badShas?.includes(manifest.sha)) {
    return { install: false, reason: `该版本启动失败过，已跳过: ${manifest.sha.slice(0, 8)}` }
  }

  return { install: true, reason: state ? `更新 ${state.sha.slice(0, 8)} → ${manifest.sha.slice(0, 8)}` : '首次安装' }
}

// ─────────────────────────────────────────────────────────── tar

export interface TarEntry {
  path: string
  data: Buffer
  mode: number
}

const BLOCK = 512

function readString(block: Buffer, offset: number, length: number): string {
  const slice = block.subarray(offset, offset + length)
  const end = slice.indexOf(0)

  return slice.subarray(0, end === -1 ? slice.length : end).toString('utf8')
}

function readOctal(block: Buffer, offset: number, length: number): number {
  const text = readString(block, offset, length).trim()
  if (!text) return 0
  const value = Number.parseInt(text, 8)

  return Number.isFinite(value) ? value : 0
}

/** Normalize an entry path, rejecting anything that could escape the target. */
function safeEntryPath(raw: string): string {
  const normalized = raw.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!normalized) throw new PayloadError('归档里有空路径条目')
  if (normalized.startsWith('/') || /^[a-zA-Z]:/.test(normalized)) {
    throw new PayloadError(`归档里有绝对路径: ${raw}`)
  }
  const segments = normalized.split('/')
  if (segments.some(segment => segment === '..')) {
    throw new PayloadError(`归档里有路径穿越: ${raw}`)
  }

  return segments.filter(segment => segment && segment !== '.').join('/')
}

/**
 * Parse a `.tar.gz` into entries. Rejects links/devices outright: a payload has
 * no legitimate reason to contain them, and following one is how an archive
 * writes outside its own directory.
 */
export function extractTarGz(archive: Buffer): TarEntry[] {
  let tar: Buffer
  try {
    tar = zlib.gunzipSync(archive)
  } catch (error) {
    throw new PayloadError(`不是合法的 gzip: ${(error as Error).message}`)
  }

  const entries: TarEntry[] = []
  let offset = 0
  while (offset + BLOCK <= tar.length) {
    const header = tar.subarray(offset, offset + BLOCK)
    if (header.every(byte => byte === 0)) break

    const name = readString(header, 0, 100)
    const prefix = readString(header, 345, 155)
    const full = prefix ? `${prefix}/${name}` : name
    const size = readOctal(header, 124, 12)
    const typeflag = String.fromCharCode(header[156] || 48)
    const mode = readOctal(header, 100, 8) || 0o644

    const dataStart = offset + BLOCK
    const dataEnd = dataStart + size
    if (dataEnd > tar.length) throw new PayloadError(`条目 ${full} 越界（归档被截断）`)

    if (typeflag === '0' || typeflag === '\0') {
      entries.push({ path: safeEntryPath(full), data: tar.subarray(dataStart, dataEnd), mode })
    } else if (typeflag === '5') {
      // directory: nothing to write, the parent dirs are created on demand
    } else {
      throw new PayloadError(`不支持归档条目类型 ${typeflag}（${full}）`)
    }

    offset = dataStart + Math.ceil(size / BLOCK) * BLOCK
  }

  if (entries.length === 0) throw new PayloadError('归档是空的')

  return entries
}

/** Write entries under `destDir`. Callers extract into a staging dir, never live. */
export function writeTarEntries(entries: TarEntry[], destDir: string): void {
  for (const entry of entries) {
    const target = path.join(destDir, ...entry.path.split('/'))
    const resolved = path.resolve(target)
    const root = path.resolve(destDir)
    if (resolved !== root && !resolved.startsWith(root + path.sep)) {
      throw new PayloadError(`条目逃出目标目录: ${entry.path}`)
    }
    fs.mkdirSync(path.dirname(resolved), { recursive: true })
    fs.writeFileSync(resolved, entry.data)
    try {
      fs.chmodSync(resolved, entry.mode & 0o777)
    } catch {
      // Windows: mode bits are advisory only.
    }
  }
}

/** Build a `.tar.gz` — used by tests and by the publish script's fallback. */
export function buildTarGz(entries: Array<{ path: string; data: Buffer | string }>): Buffer {
  const chunks: Buffer[] = []
  for (const entry of entries) {
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data, 'utf8')
    const header = Buffer.alloc(BLOCK)
    header.write(entry.path, 0, 100, 'utf8')
    header.write('0000644\0', 100, 8, 'ascii')
    header.write('0000000\0', 108, 8, 'ascii')
    header.write('0000000\0', 116, 8, 'ascii')
    header.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii')
    header.write('00000000000\0', 136, 12, 'ascii')
    header.write('        ', 148, 8, 'ascii')
    header.write('0', 156, 1, 'ascii')
    header.write('ustar\0', 257, 6, 'ascii')
    header.write('00', 263, 2, 'ascii')
    let checksum = 0
    for (const byte of header) checksum += byte
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii')
    chunks.push(header, data)
    const pad = (BLOCK - (data.length % BLOCK)) % BLOCK
    if (pad) chunks.push(Buffer.alloc(pad))
  }
  chunks.push(Buffer.alloc(BLOCK * 2))

  return zlib.gzipSync(Buffer.concat(chunks))
}

// ─────────────────────────────────────────────────────────── state

export function statePath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'current.json')
}

export function readState(runtimeRoot: string): RuntimeState | null {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath(runtimeRoot), 'utf8')) as RuntimeState
    if (!parsed || typeof parsed.sha !== 'string') return null

    return { badShas: [], ...parsed }
  } catch {
    return null
  }
}

export function writeState(runtimeRoot: string, state: RuntimeState): void {
  fs.mkdirSync(runtimeRoot, { recursive: true })
  const target = statePath(runtimeRoot)
  const tmp = `${target}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, target)
}

export function runtimeDirFor(runtimeRoot: string, sha: string): string {
  return path.join(runtimeRoot, 'runtime', sha)
}

/** Where the service actually runs from: `<runtimeRoot>/runtime/<sha>`. */
export function activeHome(runtimeRoot: string, state: RuntimeState | null): string | null {
  if (!state?.sha) return null
  const dir = runtimeDirFor(runtimeRoot, state.sha)

  return fs.existsSync(path.join(dir, 'backend', 'app', 'main.py')) ? dir : null
}

// ─────────────────────────────────────────────────────────── install

export interface InstallInput {
  runtimeRoot: string
  manifest: PayloadManifest
  archive: Buffer
  /** Reject the same failure twice in a row instead of looping. */
  markBad?: boolean
}

export function sha256(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

/**
 * Verify, extract into a staging dir, then swap into place.
 *
 * Staging + rename means a crash mid-extract leaves the previous runtime
 * untouched — the failure mode is "still on the old version", never "half a
 * runtime that cannot start".
 */
export function installPayload(input: InstallInput): string {
  const { runtimeRoot, manifest, archive } = input

  if (archive.length !== manifest.archiveBytes) {
    throw new PayloadError(
      `归档大小不符：期望 ${manifest.archiveBytes}，实际 ${archive.length}（下载可能被截断）`
    )
  }
  const got = sha256(archive)
  if (got !== manifest.archiveSha256) {
    throw new PayloadError(`归档校验失败：期望 ${manifest.archiveSha256.slice(0, 12)}… 实际 ${got.slice(0, 12)}…`)
  }

  const entries = extractTarGz(archive)
  const present = new Set(entries.map(entry => entry.path))
  const missing = REQUIRED_ENTRIES.filter(required => !present.has(required))
  if (missing.length) {
    throw new PayloadError(`归档缺少必需文件: ${missing.join(', ')}`)
  }

  const dest = runtimeDirFor(runtimeRoot, manifest.sha)
  const staging = `${dest}.staging`
  fs.rmSync(staging, { recursive: true, force: true })
  fs.mkdirSync(staging, { recursive: true })
  try {
    writeTarEntries(entries, staging)
    // Persist the manifest next to the code: rollbackState reads it back to
    // restore the previous dir's requirementsHash.
    fs.writeFileSync(
      path.join(staging, 'manifest.json'),
      JSON.stringify(manifest, null, 2),
      'utf8'
    )
    fs.rmSync(dest, { recursive: true, force: true })
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.renameSync(staging, dest)
  } catch (error) {
    fs.rmSync(staging, { recursive: true, force: true })
    throw error
  }

  return dest
}

/**
 * Record a successful switch. `previousSha` is kept so a boot failure can go
 * back exactly one step.
 */
export function commitState(runtimeRoot: string, manifest: PayloadManifest, previous: RuntimeState | null): RuntimeState {
  const next: RuntimeState = {
    sha: manifest.sha,
    requirementsHash: manifest.requirementsHash,
    previousSha: previous?.sha,
    badShas: previous?.badShas ?? []
  }
  writeState(runtimeRoot, next)

  return next
}

/** Roll back to the previous working sha and remember the failed one. */
export function rollbackState(runtimeRoot: string, failedSha: string): RuntimeState | null {
  const state = readState(runtimeRoot)
  if (!state) return null
  const badShas = Array.from(new Set([...(state.badShas ?? []), failedSha]))
  const previous = state.previousSha
  if (!previous) {
    const stuck: RuntimeState = { ...state, badShas }
    writeState(runtimeRoot, stuck)

    return stuck
  }
  const next: RuntimeState = {
    sha: previous,
    requirementsHash: '',
    previousSha: undefined,
    badShas
  }
  // Keep the old requirementsHash so the venv of the rolled-back dir is reused.
  const oldDir = runtimeDirFor(runtimeRoot, previous)
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(oldDir, 'manifest.json'), 'utf8')) as PayloadManifest
    next.requirementsHash = manifest.requirementsHash ?? ''
  } catch {
    next.requirementsHash = state.requirementsHash
  }
  writeState(runtimeRoot, next)

  return next
}
