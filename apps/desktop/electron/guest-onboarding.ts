export const GUEST_ONBOARDING_ENV = 'HERMES_GUEST_ONBOARDING'
export const GUEST_ONBOARDING_FLAG = '--guest-onboarding'

// Enterprise (Plankton) build identity marker handed to the spawned `hermes serve`
// backend. The engine has no build selector of its own (the identity is baked into
// this Electron main), so this is the one signal it can trust: it materializes the
// local-only shared-metrics default and never offers the "send to Nous" question.
// '0' for every upstream variant, so their backend env is unchanged.
export const ENTERPRISE_ENV = 'HERMES_ENTERPRISE'

export function guestOnboardingEnabled(
  argv: readonly string[] = process.argv,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return env[GUEST_ONBOARDING_ENV] === '1' || argv.includes(GUEST_ONBOARDING_FLAG)
}

export function desktopBackendSpawnEnv(
  base: NodeJS.ProcessEnv,
  guestOnboarding: boolean,
  enterprise = false
): NodeJS.ProcessEnv {
  return {
    ...base,
    [GUEST_ONBOARDING_ENV]: guestOnboarding ? '1' : '0',
    // Stamped for BOTH states so an inherited value can never leak in either
    // direction (same rule as GUEST_ONBOARDING_ENV). Older runtimes ignore it.
    [ENTERPRISE_ENV]: enterprise ? '1' : '0',
    // The desktop spawns `hermes serve` directly — no systemd/launchd supervisor will
    // revive a failure exit, so EX_TEMPFAIL only severs the UI's websockets and drops
    // in-flight assistant messages (#118080). Tell the gateway to stay alive on
    // all-adapters-down and let the reconnect watcher recover instead. Written LAST
    // (same rule as GUEST_ONBOARDING_ENV) so no earlier spread can override it. Older
    // runtimes ignore the unknown variable and keep the historical exit behavior.
    GATEWAY_ON_ALL_ADAPTERS_DOWN: 'stay_alive'
  }
}
