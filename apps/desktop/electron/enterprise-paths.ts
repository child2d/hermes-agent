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
// Desktop userData (`~/Library/Application Support/Plankton` on macOS):
//   Electron derives userData from the baked `appNamePascal`
//   (applyDesktopIdentity pins it for enterprise builds), so it is already
//   per-identity — no path literal is needed here.
//
// OVERRIDE
// --------
// Only the DEFAULT changes. An explicit `HERMES_HOME` (or
// `HERMES_DESKTOP_USER_DATA_DIR`) in the environment still wins — that is
// what keeps multi-instance runs and the sandbox launch tests isolated.

import path from 'node:path'

import { platformDefaultHermesHome } from './data-paths'

/** Segments appended to $HOME on POSIX (macOS/Linux). */
export const ENTERPRISE_HOME_SEGMENTS = ['.plankton', 'engine', 'home'] as const

/** Segments appended to %LOCALAPPDATA% on Windows. Windows hides dot-dirs. */
export const ENTERPRISE_WINDOWS_HOME_SEGMENTS = ['plankton', 'engine', 'home'] as const

/** The only identity shape this helper needs (kept structural so the module
 *  stays dependency-free and cheap to import from the pre-launch entry). */
export interface EnterpriseIdentity {
  enterprise?: boolean
}

/**
 * The enterprise engine-home default for this machine, or `null` for any
 * non-enterprise identity (in which case upstream's platform default applies
 * unchanged).
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

  if (platform === 'win32') {
    const base = (env.LOCALAPPDATA || '').trim() || path.win32.join(options.home, 'AppData', 'Local')
    return path.win32.join(base, ...ENTERPRISE_WINDOWS_HOME_SEGMENTS)
  }

  return path.posix.join(options.home, ...ENTERPRISE_HOME_SEGMENTS)
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

