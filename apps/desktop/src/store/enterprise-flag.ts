import { atom } from 'nanostores'

/**
 * Build-identity gate for enterprise-only UI decisions.
 *
 * True only when this artifact is the enterprise (Plankton) build, read from
 * the preload bridge before first paint. The renderer uses it to drop surfaces
 * that exist for the upstream build only — today the shared-metrics "Send"
 * row, whose transmission port the enterprise build seals at the engine
 * (see hermes_cli/observability/shared_metrics_send_config.py). False on every
 * upstream variant, so their UI is unchanged.
 */
export const $enterpriseEnabled = atom<boolean>(
  typeof window !== 'undefined' && window.hermesDesktop?.enterpriseEnabled === true
)
