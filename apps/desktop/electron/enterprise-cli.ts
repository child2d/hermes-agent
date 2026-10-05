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
//   * Never overwrites a config.yaml's unrelated content: the merge is a bounded,
//     line-level edit (see mergePluginEnabled).

import fs from 'node:fs'
import path from 'node:path'

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
  readdirSync: typeof fs.readdirSync
  statSync: typeof fs.statSync
  writeFileSync: (target: string, data: string, options?: { mode?: number }) => void
  chmodSync: typeof fs.chmodSync
}

const DEFAULT_FS: EnterpriseSeedFs = {
  copyFileSync: fs.copyFileSync,
  existsSync: fs.existsSync,
  mkdirSync: fs.mkdirSync,
  readFileSync: (target, encoding) => fs.readFileSync(target, encoding),
  readdirSync: fs.readdirSync,
  statSync: fs.statSync,
  writeFileSync: fs.writeFileSync,
  chmodSync: fs.chmodSync
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

/** True when `contents` already carries `pluginId` under `plugins.enabled`. */
function pluginAlreadyEnabled(contents: string, pluginId: string): boolean {
  return new RegExp(`^\\s*-\\s*['"]?${pluginId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]?\\s*$`, 'm').test(contents)
}

const enabledBlock = (pluginId: string, indent: string): string[] => [`${indent}enabled:`, `${indent}  - ${pluginId}`]

/**
 * Ensure `plugins.enabled` lists `pluginId`, editing only that block. Pure and
 * bounded — it never rewrites unrelated keys, and it refuses to guess when it
 * finds an `enabled:` that is not a block (a scalar/flow list) so a hand-edited
 * config is not corrupted. Returns the new contents plus whether it changed.
 */
export function mergePluginEnabled(contents: string, pluginId: string): { contents: string; changed: boolean } {
  if (pluginAlreadyEnabled(contents, pluginId)) {
    return { contents, changed: false }
  }

  const hadTrailingNewline = contents === '' || contents.endsWith('\n')
  const lines = contents === '' ? [] : contents.replace(/\n$/, '').split('\n')

  // Locate a top-level `plugins:` mapping (column 0, not commented).
  const pluginsAt = lines.findIndex(line => /^plugins:\s*(?:#.*)?$/.test(line))

  if (pluginsAt === -1) {
    const block = ['plugins:', ...enabledBlock(pluginId, '  ')]
    const next = lines.length === 0 ? `${block.join('\n')}\n` : `${lines.join('\n')}\n${block.join('\n')}\n`

    return { contents: next, changed: true }
  }

  // End of the `plugins:` block = the next column-0 non-blank line.
  let end = lines.length
  for (let i = pluginsAt + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() !== '' && !/^\s/.test(line)) {
      end = i
      break
    }
  }

  const enabledAt = lines.findIndex((line, i) => i > pluginsAt && i < end && /^\s+enabled:/.test(line))

  if (enabledAt === -1) {
    const indent = (/^(\s+)/.exec(lines.slice(pluginsAt + 1, end).find(line => /^\s/.test(line)) || '') || [])[1] || '  '
    lines.splice(pluginsAt + 1, 0, ...enabledBlock(pluginId, indent))
  } else {
    // Only splice into a block list; a scalar/flow `enabled:` is left alone.
    const after = lines[enabledAt].replace(/^\s+enabled:\s*/, '')
    const isBlockList = after === '' || after.startsWith('#')
    if (!isBlockList) {
      return { contents, changed: false }
    }
    const indent = `${/^(\s*)/.exec(lines[enabledAt])![1]}  `
    lines.splice(enabledAt + 1, 0, `${indent}- ${pluginId}`)
  }

  const joined = lines.join('\n')
  return { contents: hadTrailingNewline ? `${joined}\n` : joined, changed: true }
}

function copyIfChanged(fsModule: EnterpriseSeedFs, source: string, dest: string, mode?: number): boolean {
  try {
    const [srcStat, destStat] = [fsModule.statSync(source), fsModule.existsSync(dest) ? fsModule.statSync(dest) : null]
    if (destStat && destStat.size === srcStat.size && destStat.mtimeMs >= srcStat.mtimeMs) {
      return false
    }
  } catch {
    return false
  }

  fsModule.mkdirSync(path.dirname(dest), { recursive: true })
  fsModule.copyFileSync(source, dest)
  if (mode !== undefined) {
    try {
      fsModule.chmodSync(dest, mode)
    } catch {
      // best effort — a filesystem without POSIX modes (Windows) still has a runnable copy
    }
  }

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
): { changed: boolean; contents: string } {
  let current = ''
  try {
    current = fsModule.readFileSync(configPath, 'utf8')
  } catch {
    current = ''
  }

  const merged = mergePluginEnabled(current, pluginId)
  if (!merged.changed) {
    return { changed: false, contents: current }
  }

  fsModule.mkdirSync(path.dirname(configPath), { recursive: true })
  fsModule.writeFileSync(configPath, merged.contents, { mode: 0o600 })
  try {
    fsModule.chmodSync(configPath, 0o600)
  } catch {
    void 0
  }

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
    notes.push(`plugins.enabled ${enabled.changed ? 'updated' : 'present'}: ${configPath}`)

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
