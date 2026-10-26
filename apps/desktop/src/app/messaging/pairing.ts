import type { PairingUser } from '@/hermes'

/** Stable row identity: a user id is only unique within its platform. */
export const pairingKey = (user: PairingUser) => `${user.platform}:${user.user_id}`

export const pairingLabel = (user: PairingUser) => user.user_name || user.user_id

/** Group pairing rows by platform id so a column or a detail pane can slice
 *  its own — the roster's pending badge and the detail's list read the same
 *  grouping. */
export function byPlatform(rows: PairingUser[]): Record<string, PairingUser[]> {
  const grouped: Record<string, PairingUser[]> = {}

  for (const row of rows) {
    grouped[row.platform] = [...(grouped[row.platform] ?? []), row]
  }

  return grouped
}
