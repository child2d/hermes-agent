/**
 * plankton-session-gate.ts — the fail-closed登录门禁 contract for the
 * enterprise (Plankton) build.
 *
 * WHY A MAIN-PROCESS CONTRACT
 * ---------------------------
 * Ported from the old shell's `electron/session-gate.js`. The old lesson holds
 * unchanged: hiding entry points in the renderer is a *convenience*, not a
 * gate — any IPC (or, here, the `hermes:api` transport) can be reached directly,
 * and a future call site silently bypasses a UI-only check. So the rule — "not
 * authenticated ⇒ enterprise data is neither shown nor reachable" — lives here
 * as a pure, exhaustively testable decision, and is *enforced* in main.ts before
 * any data handler runs.
 *
 * WHAT CHANGED FROM THE OLD SHELL
 * -------------------------------
 * The old shell routed every renderer action through one `guardIpc` wrapper and
 * enumerated ~21 channel names. The lesson of that design is what matters, not
 * the enumeration: the gate must live at the ONE registration point, so a new
 * channel cannot be forgotten. This base keeps that shape — an explicit public
 * allowlist and *everything else denied* while logged out — but adapts it to
 * this architecture, which has two enforcement surfaces:
 *
 *   1. **IPC** — `installPlanktonIpcGate()` in electron/main.ts wraps the single
 *      `ipcMain.handle` registration point. Every invoke channel (chat/session
 *      `hermes:api`, connections, agents roster, gateway WS URLs, file reads,
 *      clipboard, logs, …) is refused before its business handler runs unless it
 *      is on the public allowlist. This is the old `guardIpc` equivalence:
 *      default-closed, so an omitted channel is refused, not allowed.
 *   2. **Backend spawn** — `assertPlanktonAuthenticated()` is called at the
 *      lowest local-spawn chokepoint (`spawnOwnedBackend`) AND at each spawn
 *      entry (`startHermes`, `ensureBackend`, `ensureRegistryBackend`,
 *      `spawnPoolBackend`, `restoreBundledBackend`), so no caller can reach a
 *      `hermes serve` child — and thus create/append the enterprise engine home
 *      (`~/.plankton/engine/home`) — while logged out.
 *
 * PURE: every input is a parameter; no electron, no fs, no network.
 */

/**
 * The one and only public surface while logged out: the login flow itself and
 * the pre-render identity facts the shell reads before any window content.
 * EVERYTHING else is refused (default-closed). Kept explicit and frozen, as the
 * old shell's list was: adding an entry must be a conscious change.
 *
 * Channels the default-closed IPC wrap therefore refuses while logged out
 * include (not exhaustive — it is the point that the list need not be): the
 * session/chat transport `hermes:api`; connection resolution
 * (`hermes:connection`, `:for`, `:revalidate`, `hermes:backend:touch`); gateway
 * URLs (`hermes:gateway:ws-url`, `:ws-url-for`); `hermes:connections:list` /
 * `:test` and `hermes:connection-config:test`; `hermes:agents:roster`;
 * `hermes:plugin-profile-routes`; `hermes:saveGatewayFile`; and every
 * file / clipboard / log channel (`hermes:readFileText`,
 * `hermes:readFileDataUrl`, `hermes:readFileDataUrlForAttach`,
 * `hermes:readPluginSource`, `hermes:watchDirectory`,
 * `hermes:watchPreviewFile`, `hermes:selectPaths`, `hermes:readClipboard`,
 * `hermes:logs:recent`).
 */
export const PLANKTON_PUBLIC_CHANNELS = Object.freeze([
  // The login flow (this batch) — the only new channels.
  'plankton:sso-login',
  'plankton:sso-status',
  'plankton:sso-logout',
  // Pre-render / identity facts the login surface renders with. Read-only and
  // carry no enterprise data.
  'hermes:version',
  'hermes:feature-flags',
  'hermes:boot-progress:get'
])

export type PlanktonGateReason = 'authenticated' | 'public-channel' | 'not-authenticated' | 'bad-channel'

export interface PlanktonGateDecision {
  allow: boolean
  reason: PlanktonGateReason
  /** Present only on a refusal — the uniform `{ok:false}` shape handlers use. */
  payload?: { ok: false; code: 'not-authenticated'; error: string }
}

export function isPlanktonPublicChannel(channel: unknown): boolean {
  return typeof channel === 'string' && PLANKTON_PUBLIC_CHANNELS.includes(channel)
}

/** The uniform refusal payload — identical shape to every handler's `{ok:false}`. */
export function planktonDeniedPayload(channel: unknown): {
  ok: false
  code: 'not-authenticated'
  error: string
} {
  return {
    ok: false,
    code: 'not-authenticated',
    error: `未登录：${String(channel)} 不可用（请先登录 SSO）`
  }
}

/**
 * One data-path admission decision. Fail-closed at every edge:
 *   - `loggedIn` must be the strict boolean `true` (a truthy string/number/object
 *     is NOT authenticated);
 *   - a non-string / empty channel is a refusal, not a pass;
 *   - only the exact public channel strings pass while logged out.
 */
export function planktonGateDecision(input: { channel: unknown; loggedIn: unknown }): PlanktonGateDecision {
  const { channel, loggedIn } = input

  if (typeof channel !== 'string' || !channel) {
    return { allow: false, reason: 'bad-channel', payload: planktonDeniedPayload(channel) }
  }

  if (loggedIn === true) {
    return { allow: true, reason: 'authenticated' }
  }

  if (isPlanktonPublicChannel(channel)) {
    return { allow: true, reason: 'public-channel' }
  }

  return { allow: false, reason: 'not-authenticated', payload: planktonDeniedPayload(channel) }
}

/**
 * The session identity every write action must be able to answer "who confirmed
 * this" with. Derived from the logged-in identity — never fabricated: with no
 * identity it is `null`, and a caller must treat that as "cannot attribute"
 * (fail-closed), not as "someone".
 */
export interface PlanktonSessionIdentity {
  subject: string
  displayName: string | null
  authSource: 'plankton-sso'
}

export function planktonSessionIdentity(
  whoami: { subject?: unknown; displayName?: unknown } | null | undefined
): PlanktonSessionIdentity | null {
  const subject = typeof whoami?.subject === 'string' ? whoami.subject.trim() : ''

  if (!subject) {
    return null
  }

  return {
    subject,
    displayName: typeof whoami?.displayName === 'string' && whoami.displayName.trim() ? whoami.displayName.trim() : null,
    authSource: 'plankton-sso'
  }
}

/** A stable, human-readable label for logs/UI ("subject" fallback when unnamed). */
export function planktonIdentityLabel(identity: PlanktonSessionIdentity | null): string | null {
  if (!identity) {
    return null
  }

  return identity.displayName || identity.subject
}
