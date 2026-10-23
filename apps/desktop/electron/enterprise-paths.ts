// enterprise-paths.ts — the enterprise fork's first-launch data roots.
//
// WHY THESE PATHS
// ---------------
// Engine home (`~/.plankton/engine/home`):
//   The engine (the Python `hermes` the desktop shell spawns) resolves its
//   whole world — config.yaml, sessions, skills, logs, the managed tool
//   store — from HERMES_HOME. The enterprise build points that default at a
//   directory of its own instead of the personal `~/.hermes`, so an
//   employee's personal Hermes and the enterprise app never read or write
//   each other's state. `.plankton` keys it to the org (the app/build identity
//   is `plankton`/`Plankton`); `engine/home` leaves room for sibling
//   enterprise state later (cache, toolchain) without moving this one.
//
// ONE APP PER ENVIRONMENT
// -----------------------
// The enterprise fork ships three INDEPENDENT apps (dev / test / prod), and
// each owns a root of its own so a development machine can never be the
// environment someone else runs:
//
//   prod  ~/.plankton/engine/home          (historical — an existing install
//                                           must not move)
//   test  ~/.plankton/test/engine/home
//   dev   ~/.plankton/dev/engine/home
//
// The environment comes from the ARTIFACT's baked identity (`identity.env` /
// `identity.homeDir`, see plankton-envs.cjs + product-identity.cjs), never
// from a variable in the environment the app is launched in: a build handed to
// a colleague must not be redirectable by whatever `HERMES_*` values happen to
// be in their shell. Desktop userData is already per-identity (Electron
// derives it from the baked `appNamePascal`, which `applyDesktopIdentity` pins
// — `Plankton`, `PlanktonTest`, `PlanktonDev`), so the three apps also get
// separate single-instance locks and can run side by side.
//
// OVERRIDE
// --------
// Only the DEFAULT changes. An explicit `HERMES_HOME` (or
// `HERMES_DESKTOP_USER_DATA_DIR`) in the environment still wins — that is
// what keeps multi-instance runs and the sandbox launch tests isolated.

import path from 'node:path'

import { platformDefaultHermesHome } from './data-paths'

/** Segments appended to $HOME on POSIX (macOS/Linux). The prod default. */
export const ENTERPRISE_HOME_SEGMENTS = ['.plankton', 'engine', 'home'] as const

/** Segments appended to %LOCALAPPDATA% on Windows. Windows hides dot-dirs.
 *  The prod default. */
export const ENTERPRISE_WINDOWS_HOME_SEGMENTS = ['plankton', 'engine', 'home'] as const

/** A single path segment and nothing else. The environment is baked at build
 *  time, so a malformed value is a build bug: fail loudly here instead of
 *  silently resolving somewhere outside the product root. */
const HOME_DIR_SEGMENT = /^[a-z0-9][a-z0-9-]*$/

/** The only identity shape this helper needs (kept structural so the module
 *  stays dependency-free and cheap to import from the pre-launch entry). */
export interface EnterpriseIdentity {
  enterprise?: boolean
  /** `dev` / `test` / `prod` — informational; the path keys on `homeDir`. */
  env?: string
  /** The single segment inserted under the product root. `null`/absent = the
   *  historical prod root (`~/.plankton/engine/home`). */
  homeDir?: string | null
}

/**
 * The engine-home segments for this artifact's environment: the historical
 * `.plankton/engine/home` for prod, `.plankton/<env>/engine/home` otherwise.
 */
export function enterpriseHomeSegments(
  identity: EnterpriseIdentity | null | undefined,
  platform: NodeJS.Platform = process.platform
): string[] {
  const base = platform === 'win32' ? [...ENTERPRISE_WINDOWS_HOME_SEGMENTS] : [...ENTERPRISE_HOME_SEGMENTS]
  const segment = identity?.homeDir == null ? '' : String(identity.homeDir).trim()
  if (!segment) {
    return base
  }
  // 'engine' would produce `.plankton/engine/engine/home`, shadowing the prod
  // root's own first segment — ambiguous by construction.
  if (segment === base[1] || !HOME_DIR_SEGMENT.test(segment)) {
    throw new Error(
      `Invalid enterprise homeDir ${JSON.stringify(identity?.homeDir)}: expected one lowercase path segment, or null for the default root`
    )
  }

  return [base[0], segment, ...base.slice(1)]
}

/**
 * The enterprise engine-home default for this machine, or `null` for any
 * non-enterprise identity (in which case upstream's platform default applies
 * unchanged). Keys on the artifact's own environment: prod resolves to the
 * historical `~/.plankton/engine/home`, dev/test to their own sibling roots.
 */
export function enterpriseHermesHomeFor(
  identity: EnterpriseIdentity | null | undefined,
  options: { home: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }
): string | null {
  if (!identity?.enterprise) {
    return null
  }

  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const segments = enterpriseHomeSegments(identity, platform)

  if (platform === 'win32') {
    const base = (env.LOCALAPPDATA || '').trim() || path.win32.join(options.home, 'AppData', 'Local')
    return path.win32.join(base, ...segments)
  }

  return path.posix.join(options.home, ...segments)
}

/**
 * The home an enterprise build will actually use, given the home already
 * resolved by `resolveDesktopHermesHome` (whose first branch honours an
 * ambient `HERMES_HOME` before ever reaching the caller's default).
 *
 * WHY THIS EXISTS
 * ---------------
 * `HERMES_HOME` is exported into the environment of every process descended
 * from a Hermes CLI shell, and the Hermes desktop app exports
 * `HERMES_HOME=<personal root>` to its children. An enterprise build launched
 * from either context (double-click through `open`, a terminal, an installer
 * that inherits the user's shell env) therefore *inherits*
 * `HERMES_HOME=~/.hermes`, the "explicit override" branch wins, and the app
 * starts on the PERSONAL root — the exact failure this fork exists to
 * prevent, with no environment variable the user consciously passed.
 *
 * An `HERMES_HOME` that IS the personal root cannot be an enterprise intent:
 * it is precisely the ambient value the CLI/desktop bake. Discard it and fall
 * back to the enterprise default. A home strictly INSIDE the personal root is
 * a deliberate (or buggy) override into personal state: it is left untouched
 * so the fail-closed isolation check refuses to start.
 *
 * ONE ENVIRONMENT MUST NEVER ADOPT ANOTHER'S STATE
 * ------------------------------------------------
 * The same hole exists between the fork's own environments, and it is not
 * theoretical: a `plankton-dev` app launched from a shell that a PRODUCTION
 * app parented (the agent runs inside the prod app, which exports
 * `HERMES_HOME=~/.plankton/engine/home` to its children) inherits that value,
 * the explicit-override branch wins, and the dev build boots on the
 * production root — logged as `enterprise engine home: …/.plankton/engine/home`
 * with no variable the user consciously passed. So an ambient home that lies
 * inside the product root (`~/.plankton`, `%LOCALAPPDATA%\plankton`) but is NOT
 * this artifact's own engine home is discarded too, and the artifact falls back
 * to its own root. Homes OUTSIDE the product root (`~/plankton-verify/home`,
 * a sandbox, a rehearsal dir) stay honoured: those are deliberate overrides.
 *
 * Pure: every input is a parameter, so the decision is behavior-testable.
 */
export type EnterpriseHomeDiscardReason = 'personal-root' | 'other-environment'

/** The product root every environment's engine home lives under:
 *  `~/.plankton` (POSIX) / `%LOCALAPPDATA%\plankton` (Windows). */
export function enterpriseProductRoot(options: {
  home: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}): string {
  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  if (platform === 'win32') {
    const base = (env.LOCALAPPDATA || '').trim() || path.win32.join(options.home, 'AppData', 'Local')
    return path.win32.join(base, ENTERPRISE_WINDOWS_HOME_SEGMENTS[0])
  }

  return path.posix.join(options.home, ENTERPRISE_HOME_SEGMENTS[0])
}

/** True when `requested` is an engine root of the shape
 *  `<productRoot>/engine/home` (the historical prod root) or
 *  `<productRoot>/<env>/engine/home`. Both inputs must already be folded and
 *  resolved. */
function isEngineRootUnder(options: {
  productRoot: string
  requested: string
  paths: typeof path.posix | typeof path.win32
}): boolean {
  const relative = options.paths.relative(options.productRoot, options.requested)
  if (!relative || relative.startsWith('..')) {
    return false
  }
  const parts = relative.split(options.paths.sep).filter(Boolean)
  if (parts.length !== 2 && parts.length !== 3) {
    return false
  }

  return parts.slice(-2).join('/') === 'engine/home'
}

export function enterpriseHomeSelection(options: {
  identity: EnterpriseIdentity | null | undefined
  requestedHome: string
  enterpriseDefault: string | null
  home: string
  platform?: NodeJS.Platform
  env?: NodeJS.ProcessEnv
}): { home: string; discardedAmbientRoot: string | null; discardedReason: EnterpriseHomeDiscardReason | null } {
  const enterpriseDefault = options.enterpriseDefault
  if (!options.identity?.enterprise || !enterpriseDefault) {
    return { home: options.requestedHome, discardedAmbientRoot: null, discardedReason: null }
  }

  const platform = options.platform ?? process.platform
  const env = options.env ?? process.env
  const paths = platform === 'win32' ? path.win32 : path.posix
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  const requested = fold(paths.resolve(options.requestedHome))
  const keep = { home: options.requestedHome, discardedAmbientRoot: null, discardedReason: null }
  const ownHome = fold(paths.resolve(enterpriseDefault))

  // An ambient value that already IS this artifact's own home is not a
  // redirect: nothing to discard.
  if (requested === ownHome) {
    return keep
  }

  // Compare against the personal root for this run AND the unsuffixed one: a
  // `HERMES_DATA_DIR_SUFFIX` run moves the engine's personal root, but the
  // ambient value a CLI shell exports is still the unsuffixed `~/.hermes`.
  const personalRoots = [
    paths.resolve(platformDefaultHermesHome(options.home, env, platform)),
    paths.resolve(platformDefaultHermesHome(options.home, {}, platform))
  ].map(fold)

  if (personalRoots.includes(requested)) {
    return { home: enterpriseDefault, discardedAmbientRoot: options.requestedHome, discardedReason: 'personal-root' }
  }

  // Another environment's engine root (or the historical prod root inherited by
  // a dev/test build) — see the header. Matched by SHAPE, so arbitrary scratch
  // dirs under the product root (test sandboxes such as
  // `~/.plankton/hermes-desktop-tests/<run>/engine-home`) stay honoured.
  const productRoot = fold(paths.resolve(enterpriseProductRoot({ home: options.home, platform, env })))
  if (isEngineRootUnder({ productRoot, requested, paths })) {
    return { home: enterpriseDefault, discardedAmbientRoot: options.requestedHome, discardedReason: 'other-environment' }
  }

  return keep
}

/**
 * Detect the enterprise home ISOLATION trap: an effective `HERMES_HOME` that
 * lives inside the personal Hermes root.
 *
 * The engine resolves its real root through `hermes_constants.get_default_hermes_root()`,
 * which treats *any* `HERMES_HOME` under the platform default (`~/.hermes`, or
 * `~/.hermes<suffix>`) as a **profile of that default** and returns the default
 * root instead. So an "isolated" home placed inside `~/.hermes` silently reads
 * and writes the PERSONAL state.db, config and sessions — the exact opposite of
 * isolation. The only safe enterprise home is one *outside* the personal root.
 *
 * Returns a human-readable description of the trap, or `null` when the home is
 * genuinely outside the personal root. Pure: every input is a parameter.
 */
export function enterpriseHomeIsolationIssue(
  effectiveHome: string,
  options: { home: string; platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv }
): string | null {
  const platform = options.platform ?? process.platform
  const paths = platform === 'win32' ? path.win32 : path.posix
  // Windows paths are case-insensitive; compare folded so C:\ vs c:\ matches.
  const fold = (value: string): string => (platform === 'win32' ? value.toLowerCase() : value)
  const personal = fold(paths.resolve(platformDefaultHermesHome(options.home, options.env ?? process.env, platform)))
  const resolved = fold(paths.resolve(effectiveHome))

  if (resolved === personal) {
    return `HERMES_HOME is the personal Hermes root itself (${resolved})`
  }

  if (resolved.startsWith(personal + paths.sep)) {
    return `HERMES_HOME (${resolved}) is inside the personal Hermes root (${personal})`
  }

  return null
}

