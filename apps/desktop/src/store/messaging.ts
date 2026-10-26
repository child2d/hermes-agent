import { atom, computed } from 'nanostores'

import { getMessagingPlatforms, getPairing, type MessagingPlatformInfo, type PairingUser } from '@/hermes'
import { translateNow } from '@/i18n'
import { notifyError } from '@/store/notifications'
import { $settingsRequestProfile } from '@/store/settings-scope'

export interface MessagingPairing {
  approved: PairingUser[]
  pending: PairingUser[]
}

/** The settings scope a payload was read for: `undefined` = follow the active
 *  profile, which is a scope of its own (see store/settings-scope). */
type ScopeKey = string | undefined

interface Scoped<T> {
  scope: ScopeKey
  value: T
}

// The platform roster is read by two surfaces that cannot see each other's
// React state: the standing list column (`MessagingPlatformsPane`, swapped in
// by WorkspaceListPane) and the platform detail page. One cache here feeds
// both, so the column and the page can never disagree about what the roster is.
//
// Every payload is tagged with the settings scope it was read from and
// published through a computed that hides a mismatch: a scope switch makes the
// previous profile's snapshot disappear in the very render it is switched in,
// instead of letting it paint under the new scope until an effect lands
// (#96542).
const EMPTY_PAIRING: MessagingPairing = { approved: [], pending: [] }

const $platformsData = atom<null | Scoped<MessagingPlatformInfo[]>>(null)
const $pairingData = atom<null | Scoped<MessagingPairing>>(null)

/** Platforms for the current scope. `null` = this scope has no snapshot yet. */
export const $messagingPlatforms = computed(
  [$platformsData, $settingsRequestProfile],
  (data, scope) => (data && data.scope === scope ? data.value : null)
)

/** Pairing rows for the current scope (empty until its own fetch lands). */
export const $messagingPairing = computed(
  [$pairingData, $settingsRequestProfile],
  (data, scope) => (data && data.scope === scope ? data.value : EMPTY_PAIRING)
)

export function setMessagingPlatforms(scope: ScopeKey, platforms: MessagingPlatformInfo[]): void {
  $platformsData.set({ scope, value: platforms })
}

/** In-place edit so a toggle repaints before the authoritative refetch lands.
 *  A no-op when the cache belongs to another scope: the write this reflects was
 *  issued for that scope, and publishing it here would leak across profiles. */
export function updateMessagingPlatforms(
  scope: ScopeKey,
  map: (platforms: MessagingPlatformInfo[]) => MessagingPlatformInfo[]
): void {
  const data = $platformsData.get()

  if (data && data.scope === scope) {
    $platformsData.set({ scope, value: map(data.value) })
  }
}

export function setMessagingPairing(scope: ScopeKey, pairing: MessagingPairing): void {
  $pairingData.set({ scope, value: pairing })
}

export async function refreshMessagingPlatforms(scope: ScopeKey, silent = false): Promise<void> {
  try {
    const result = await getMessagingPlatforms(scope)

    // A response is only allowed to land while the scope it was issued for is
    // still the rendered one: A→B, A's snapshot would repaint B's roster.
    if ($settingsRequestProfile.get() === scope) {
      setMessagingPlatforms(scope, result.platforms)
    }
  } catch (err) {
    if (!silent) {
      notifyError(err, translateNow('messaging.loadFailed'))
    }
  }
}

export async function refreshMessagingPairing(scope: ScopeKey): Promise<void> {
  try {
    const result = await getPairing(scope)

    if ($settingsRequestProfile.get() === scope) {
      setMessagingPairing(scope, { approved: result.approved ?? [], pending: result.pending ?? [] })
    }
  } catch {
    // Pairing has its own signal and its own failure mode: an older backend
    // without the endpoint must show no rows, not an error over a working page
    // — and a failure leaves the last known rows in place rather than blanking
    // them.
  }
}
