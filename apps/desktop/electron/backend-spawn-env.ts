import { prependEnterpriseBinToPath } from './enterprise-cli'
import { ENTERPRISE_ENV, GUEST_ONBOARDING_ENV } from './guest-onboarding'

/**
 * The environment every desktop-spawned backend (and `gateway ensure` client)
 * inherits. Three things are pinned here rather than left to the ambient
 * environment:
 *
 * - the build-identity markers, stamped for BOTH states so an inherited value
 *   can never leak in either direction;
 * - `GATEWAY_ON_ALL_ADAPTERS_DOWN`: the desktop spawns the backend itself, so no
 *   systemd/launchd supervisor revives it — EX_TEMPFAIL would only sever the UI's
 *   websockets and drop in-flight turns (#118080). Written last so no earlier
 *   spread can override it; older runtimes ignore the unknown variable;
 * - enterprise only: `<HERMES_HOME>/bin` front-loaded so the seeded `shaoke-cli`
 *   wins over a personal `~/.local/bin` copy (KI-PLANKTON-0013).
 */
export function desktopBackendSpawnEnv(
  base: NodeJS.ProcessEnv,
  guestOnboarding = false,
  enterprise = false
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    [GUEST_ONBOARDING_ENV]: guestOnboarding ? '1' : '0',
    [ENTERPRISE_ENV]: enterprise ? '1' : '0',
    GATEWAY_ON_ALL_ADAPTERS_DOWN: 'stay_alive'
  }

  if (enterprise && base?.HERMES_HOME) {
    const key = Object.keys(env).find(name => name.toUpperCase() === 'PATH') || 'PATH'
    env[key] = prependEnterpriseBinToPath(base[key] || '', {
      hermesHome: String(base.HERMES_HOME),
      delimiter: process.platform === 'win32' ? ';' : ':'
    })
  }

  return env
}
