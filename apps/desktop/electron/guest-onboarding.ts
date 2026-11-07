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
