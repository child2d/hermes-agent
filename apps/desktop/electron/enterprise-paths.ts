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
