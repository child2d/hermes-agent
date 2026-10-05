// enterprise-cli.ts — the enterprise fork's first-launch asset seed: the bundled
// `shaoke-cli` binary and the `plankton-enterprise` engine plugin.
//
// WHAT AND WHY (PLANKTON-MIGRATION-BATCH2.md, D2 + card point 1)
// --------------------------------------------------------------
//  1. CLI: the artifact carries a per-OS/arch `shaoke-cli` under
//     `<Resources>/enterprise/cli/<os>-<arch>/`. On first launch it is copied
//     (idempotently) to `<HERMES_HOME>/bin/shaoke-cli` with the executable bit
//     set — a clean machine is usable with NO network and NO pre-installed CLI.
//  2. PATH: `<HERMES_HOME>/bin` is front-loaded ahead of `~/.local/bin` for the
//     spawned backend (see guest-onboarding.ts), so a stale/personal CLI cannot
//     shadow the enterprise copy (KI-PLANKTON-0013).
//  3. Plugin: the artifact carries the `plankton-enterprise` package under
//     `<Resources>/enterprise/plankton-enterprise/`. Its AGENT half + dashboard
//     backend land under `<HERMES_HOME>/plugins/plankton-enterprise/`, and its
//     DESKTOP half lands under `<HERMES_HOME>/desktop-plugins/plankton-enterprise/`.
//     The desktop half takes the STANDALONE door on purpose: the
//     `plugins/<name>/desktop/` unified-package door materializes a
//     `.hermes-package.json` marker that caps the plugin at `defaultEnabled:
//     false` (inert until a user toggle, whose state lives in the renderer's
//     localStorage and cannot be seeded from the main process). The standalone
//     door is marker-free and therefore loads on the very first launch.
//  4. Config: `plugins.enabled` in `<HERMES_HOME>/config.yaml` must list the
//     plugin, or the engine refuses to import its `dashboard/plugin_api.py`
//     (GHSA-mcfc-hp25-cjv7 — user plugins are opt-in for their Python half).
//
// RED LINES
//   * Enterprise-only: every entry point returns `not-enterprise` for any other
//     variant, so upstream builds are untouched.
//   * No secrets: nothing here reads or writes a token/credential file.
//   * Never overwrites a config.yaml's unrelated content: the edit is made with
//     a real YAML parser, scoped to `plugins.enabled` only (see
//     mergePluginEnabled), and published atomically (temp-then-rename).

import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { isMap, isScalar, isSeq, parseDocument } from 'yaml'

export const ENTERPRISE_PLUGIN_ID = 'plankton-enterprise'
export const ENTERPRISE_CLI_NAME = 'shaoke-cli'
/** Resource subtree the plugin payload is copied from (see the pack config). */
export const ENTERPRISE_PLUGIN_RESOURCE_DIR = 'enterprise'

export type EnterpriseSeedReason = 'not-enterprise' | 'no-resources' | 'seeded' | 'partial'

export interface EnterpriseAssetSeedResult {
  seeded: boolean
  reason: EnterpriseSeedReason
  /** Absolute path to the seeded (or already-present) CLI. */
  cliPath?: string
  cliCopied?: boolean
  /** `<HERMES_HOME>/plugins/<id>` when the agent half was written. */
  pluginPath?: string
  /** `<HERMES_HOME>/desktop-plugins/<id>/plugin.js` when the desktop half landed. */
  desktopPluginPath?: string
  /** `<HERMES_HOME>/config.yaml` when `plugins.enabled` was ensured. */
  configPath?: string
  configUpdated?: boolean
  /** Human-readable notes for the launch log (never secret). */
  notes: string[]
}

/** The minimal fs surface this module needs (injected in tests). */
export interface EnterpriseSeedFs {
  copyFileSync: typeof fs.copyFileSync | ((from: string, to: string) => void)
  existsSync: (target: string) => boolean
  mkdirSync: (target: string, options?: { recursive?: boolean }) => unknown
  readFileSync: (target: string, encoding: BufferEncoding) => string
  /** Raw bytes, for content-hash comparison (never decode text). */
  readFileBuffer: (target: string) => Buffer
  readdirSync: typeof fs.readdirSync
  statSync: typeof fs.statSync
  writeFileSync: (target: string, data: string, options?: { mode?: number }) => void
  chmodSync: typeof fs.chmodSync
  /** Atomic publish step for a temp-then-rename write. */
  renameSync: (from: string, to: string) => void
}

const DEFAULT_FS: EnterpriseSeedFs = {
  copyFileSync: fs.copyFileSync,
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
  readFileBuffer: target => fs.readFileSync(target),
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  writeFileSync: fs.writeFileSync,
  chmodSync: fs.chmodSync,
  renameSync: fs.renameSync
}

function pathsFor(platform: NodeJS.Platform): typeof path.posix | typeof path.win32 {
  return platform === 'win32' ? path.win32 : path.posix
}

/** The executable name for a platform. */
export function enterpriseCliFileName(platform: NodeJS.Platform): string {
  return platform === 'win32' ? `${ENTERPRISE_CLI_NAME}.exe` : ENTERPRISE_CLI_NAME
}

/** Resource-relative segments for the bundled CLI: `enterprise/cli/<os>-<arch>/<exe>`. */
export function enterpriseCliResourceRelative(platform: NodeJS.Platform, arch: string): string[] {
  return [ENTERPRISE_PLUGIN_RESOURCE_DIR, 'cli', `${platform === 'darwin' ? 'darwin' : platform}-${arch}`, enterpriseCliFileName(platform)]
}

/** Resource-relative dir for the plugin payload: `enterprise/plankton-enterprise`. */
export function enterprisePluginResourceRelative(): string[] {
  return [ENTERPRISE_PLUGIN_RESOURCE_DIR, ENTERPRISE_PLUGIN_ID]
}

/** `<HERMES_HOME>/bin` — the front-loaded directory that carries the CLI copy. */
export function enterpriseBinDir(hermesHome: string, platform: NodeJS.Platform = process.platform): string {
  return pathsFor(platform).join(hermesHome, 'bin')
}

/**
 * Front-load `<HERMES_HOME>/bin` onto a PATH value. Pure. Idempotent (an
 * existing copy of the entry is moved, not duplicated) and case-insensitive on
 * Windows. A non-enterprise caller never reaches this.
 */
export function prependEnterpriseBinToPath(
  pathValue: unknown,
  options: { hermesHome: string; delimiter: string; platform?: NodeJS.Platform }
): string {
  const platform = options.platform ?? process.platform
  const bin = enterpriseBinDir(options.hermesHome, platform)
  const fold = (value: string) => (platform === 'win32' ? value.toLowerCase() : value)
  const want = fold(bin)
  const entries = String(pathValue ?? '')
    .split(options.delimiter)
    .filter(entry => entry && fold(entry) !== want)

  return [bin, ...entries].join(options.delimiter)
}

/**
 * Ensure `plugins.enabled` lists `pluginId`.
 *
 * Implemented with a REAL YAML parser (the repo's `yaml` dependency), never
 * string splicing. The review found that a line-level splice produced
 * structurally invalid YAML whenever the existing file used a style the
 * hardcoded indentation did not match (the engine's own writer emits
 * *indentless* block sequences, `enabled:` followed by `- item` at the SAME
 * column — mixing that with an indented item makes the engine's loader raise
 * `ParserError` → `InvalidUserConfigError`). Other line-level hazards the
 * parser removes by construction:
 *   - a flow `plugins: {}` / `plugins: &anchor {...}` no longer appends a
 *     SECOND top-level `plugins:` key;
 *   - a nested `enabled:` under some other submap is never mistaken for
 *     `plugins.enabled`;
 *   - `pluginAlreadyEnabled` is scoped to `plugins.enabled`, so a same-named
 *     entry under `plugins.disabled` is no longer read as "already enabled".
 *
 * Scope discipline: it touches ONLY `plugins.enabled`. When the file cannot be
 * parsed, or `plugins` / `plugins.enabled` exists in a shape we cannot turn
 * into a list without guessing (a scalar, or a non-mapping `plugins`), it
 * returns the ORIGINAL contents unchanged with an `error` — it never writes a
 * half-guessed edit. Pure.
 */
export function mergePluginEnabled(
  contents: string,
  pluginId: string
): { contents: string; changed: boolean; error?: string } {
  const original = contents ?? ''
  let doc
  try {
    doc = parseDocument(original)
  } catch {
    return { contents: original, changed: false, error: 'unparseable' }
  }
  if (doc.errors.length > 0) {
    return { contents: original, changed: false, error: 'unparseable' }
  }

  const plugins = doc.has('plugins') ? doc.get('plugins') : undefined

  // No `plugins:` key yet (or an empty `plugins:` → null) → write the mapping
  // with just our allow-list entry. `setIn` cannot traverse a null, so set the
  // whole key.
  if (plugins === undefined || plugins === null) {
    doc.set('plugins', doc.createNode({ enabled: [pluginId] }))
    return { contents: doc.toString(), changed: true }
  }

  // A scalar / sequence `plugins:` cannot carry an `enabled:` list safely.
  if (!isMap(plugins)) {
    return { contents: original, changed: false, error: 'plugins-not-a-mapping' }
  }

  if (!plugins.has('enabled')) {
    plugins.set('enabled', doc.createNode([pluginId]))
    return { contents: doc.toString(), changed: true }
  }

  const enabled = plugins.get('enabled')
  if (enabled === null || enabled === undefined || isSeq(enabled)) {
    const seq = enabled as { items: unknown[]; add: (value: unknown) => void } | null
    if (seq && seq.items.some(item => (isScalar(item) ? item.value : item) === pluginId)) {
      return { contents: original, changed: false }
    }
    if (seq) {
      seq.add(doc.createNode(pluginId))
    } else {
      plugins.set('enabled', doc.createNode([pluginId]))
    }
    return { contents: doc.toString(), changed: true }
  }

  // A scalar (e.g. `enabled: true`) — refuse rather than guess a list out of it.
  return { contents: original, changed: false, error: 'enabled-not-a-sequence' }
}

/** Content digest of a file (bytes, never decoded). Throws if unreadable. */
function fileDigest(fsModule: EnterpriseSeedFs, file: string): string {
  return createHash('sha256').update(fsModule.readFileBuffer(file)).digest('hex')
}

/** A sibling temp path used for an atomic temp-then-rename publish. */
function tempSibling(target: string): string {
  return `${target}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
}

/**
 * Write `data` to `target` atomically: a full temp file is fsync'd by the OS on
 * close, then renamed over the destination. A crash mid-write can therefore
 * never leave a half-written config.yaml / cli. `mode` is applied to the temp
 * file BEFORE the rename, so the destination is never briefly mis-permissioned.
 */
function atomicWriteFile(fsModule: EnterpriseSeedFs, target: string, data: string, mode?: number): void {
  const tmp = tempSibling(target)
  fsModule.writeFileSync(tmp, data, mode === undefined ? undefined : { mode })
  if (mode !== undefined) {
    try {
      fsModule.chmodSync(tmp, mode)
    } catch {
      void 0
    }
  }
  fsModule.renameSync(tmp, target)
}

/**
 * Copy `source` → `dest` only when the CONTENT differs (sha256), not on
 * size+mtime. Size+mtime is a weak proxy: two different builds can share a size
 * and a stale copy can carry a newer mtime, either of which silently keeps a
 * wrong binary. The copy itself is atomic (temp-then-rename) so a reader never
 * observes a partial file. Returns whether a copy happened.
 */
function copyIfChanged(fsModule: EnterpriseSeedFs, source: string, dest: string, mode?: number): boolean {
  try {
    if (fsModule.existsSync(dest) && fileDigest(fsModule, source) === fileDigest(fsModule, dest)) {
      // Content already matches; still make sure the mode (exec bit) is right.
      if (mode !== undefined) {
        try {
          fsModule.chmodSync(dest, mode)
        } catch {
          void 0
        }
      }
      return false
    }
  } catch {
    // Unreadable dest/source — fall through and (re)write.
  }

  fsModule.mkdirSync(path.dirname(dest), { recursive: true })
  const tmp = tempSibling(dest)
  fsModule.copyFileSync(source, tmp)
  if (mode !== undefined) {
    try {
      fsModule.chmodSync(tmp, mode)
    } catch {
      // best effort — a filesystem without POSIX modes (Windows) still has a runnable copy
    }
  }
  fsModule.renameSync(tmp, dest)

  return true
}

/** Recursively mirror `sourceDir` into `destDir`, copying only changed files. */
function mirrorDir(fsModule: EnterpriseSeedFs, sourceDir: string, destDir: string): string[] {
  const written: string[] = []
  for (const entry of fsModule.readdirSync(sourceDir, { withFileTypes: true })) {
    const from = path.join(sourceDir, entry.name)
    const to = path.join(destDir, entry.name)
    if (entry.isDirectory()) {
      written.push(...mirrorDir(fsModule, from, to))
    } else if (copyIfChanged(fsModule, from, to)) {
      written.push(to)
    }
  }

  return written
}

function ensurePluginEnabled(
  fsModule: EnterpriseSeedFs,
  configPath: string,
  pluginId: string
): { changed: boolean; contents: string; error?: string } {
  let current = ''
  try {
    current = fsModule.readFileSync(configPath, 'utf8')
  } catch {
    current = ''
  }

  const merged = mergePluginEnabled(current, pluginId)
  if (merged.error) {
    // Refuse to touch an unparseable / ambiguous config: report it, leave the
    // file exactly as it was. Better a loud no-op than a corrupted config.yaml.
    return { changed: false, contents: current, error: merged.error }
  }
  if (!merged.changed) {
    return { changed: false, contents: current }
  }

  fsModule.mkdirSync(path.dirname(configPath), { recursive: true })
  atomicWriteFile(fsModule, configPath, merged.contents, 0o600)

  return { changed: true, contents: merged.contents }
}

/**
 * Seed the enterprise CLI + plugin on (a signed-in) first launch.
 *
 * Precedence, deliberately narrow: enterprise identity only; the resource
 * source is `<Resources>/enterprise/...`. A missing resource is reported
 * (`no-resources`), never a crash — but the pack-time after-pack assertion
 * (see scripts/after-pack.mjs) is what turns a missing resource into a RED
 * build, so this runtime leniency cannot ship a silently-crippled artifact.
 */
export function seedEnterpriseAssets(options: {
  identity: { enterprise?: boolean } | null | undefined
  hermesHome: string
  resourcesPath: string
  platform?: NodeJS.Platform
  arch?: string
  fsModule?: EnterpriseSeedFs
  log?: (line: string) => void
}): EnterpriseAssetSeedResult {
  if (!options.identity?.enterprise) {
    return { seeded: false, reason: 'not-enterprise', notes: [] }
  }

  const fsModule = options.fsModule ?? DEFAULT_FS
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch
  const p = pathsFor(platform)
  const notes: string[] = []

  const result: EnterpriseAssetSeedResult = { seeded: false, reason: 'no-resources', notes }

  // ── 1. CLI ────────────────────────────────────────────────────────────────
  const cliSource = p.join(options.resourcesPath, ...enterpriseCliResourceRelative(platform, arch))
  const cliDest = p.join(enterpriseBinDir(options.hermesHome, platform), enterpriseCliFileName(platform))

  if (fsModule.existsSync(cliSource)) {
    result.cliCopied = copyIfChanged(fsModule, cliSource, cliDest, 0o755)
    result.cliPath = cliDest
    notes.push(`cli ${result.cliCopied ? 'copied' : 'present'}: ${cliDest}`)
  } else {
    notes.push(`cli resource missing: ${cliSource}`)
  }

  // ── 2. Plugin ─────────────────────────────────────────────────────────────
  const pluginSource = p.join(options.resourcesPath, ...enterprisePluginResourceRelative())
  if (fsModule.existsSync(pluginSource)) {
    const pluginDest = p.join(options.hermesHome, 'plugins', ENTERPRISE_PLUGIN_ID)
    const desktopDest = p.join(options.hermesHome, 'desktop-plugins', ENTERPRISE_PLUGIN_ID)

    // Agent half + dashboard backend: everything EXCEPT `desktop/`.
    for (const entry of fsModule.readdirSync(pluginSource, { withFileTypes: true })) {
      if (entry.name === 'desktop') {
        continue
      }
      const from = p.join(pluginSource, entry.name)
      const to = p.join(pluginDest, entry.name)
      if (entry.isDirectory()) {
        mirrorDir(fsModule, from, to)
      } else if (copyIfChanged(fsModule, from, to)) {
        notes.push(`plugin file: ${to}`)
      }
    }
    result.pluginPath = pluginDest

    // Desktop half: the STANDALONE door (marker-free → default-ON).
    const desktopEntry = p.join(pluginSource, 'desktop', 'plugin.js')
    if (fsModule.existsSync(desktopEntry)) {
      const desktopFile = p.join(desktopDest, 'plugin.js')
      copyIfChanged(fsModule, desktopEntry, desktopFile)
      result.desktopPluginPath = desktopFile
      notes.push(`desktop plugin: ${desktopFile}`)
    }

    // ── 3. plugins.enabled (the user-plugin Python gate) ────────────────────
    const configPath = p.join(options.hermesHome, 'config.yaml')
    const enabled = ensurePluginEnabled(fsModule, configPath, ENTERPRISE_PLUGIN_ID)
    result.configPath = configPath
    result.configUpdated = enabled.changed
    if (enabled.error) {
      notes.push(`plugins.enabled NOT updated (${enabled.error}); ${configPath} left unchanged`)
    } else {
      notes.push(`plugins.enabled ${enabled.changed ? 'updated' : 'present'}: ${configPath}`)
    }

    result.seeded = Boolean(result.cliPath) && Boolean(result.pluginPath)
    result.reason = result.seeded ? 'seeded' : 'partial'
  } else {
    notes.push(`plugin resource missing: ${pluginSource}`)
    result.reason = result.cliPath ? 'partial' : 'no-resources'
  }

  for (const line of notes) {
    options.log?.(`[enterprise] ${line}`)
  }

  return result
}
