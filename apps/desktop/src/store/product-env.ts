import { atom } from 'nanostores'

/**
 * Which environment this artifact is: 'dev' | 'test' | 'prod', or null when the
 * artifact has no environment at all (every upstream variant).
 *
 * Read from the preload bridge before first paint, like `$enterpriseEnabled`.
 * `prod` is a real, present value here — surfaces that MARK an environment (the
 * sidebar badge) render for the non-shipped ones only, so the shipping artifact
 * keeps the UI it always had. Knowing which is which is also the whole point of
 * the three-app split: the sidebar wordmark reads "Plankton" in all three, and
 * a screenshot cannot otherwise be attributed to one.
 */
export const $productEnv = atom<string | null>(
  typeof window !== 'undefined' && typeof window.hermesDesktop?.productEnv === 'string'
    ? window.hermesDesktop.productEnv
    : null
)
