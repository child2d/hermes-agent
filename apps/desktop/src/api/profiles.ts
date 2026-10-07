import type {
  ProfileCreatePayload,
  ProfileDesktopOverlay,
  ProfileInfo,
  ProfileSetupCommand,
  ProfileSoul,
  ProfilesResponse
} from '@/types/hermes'

import { capabilityScoped, hermesApi, type ProfileScope, STARTUP_REQUEST_TIMEOUT_MS } from './client'

// ── /api/profiles response shape (the ONE normalization point) ─────────────
// Every renderer consumer reads the profile list as an array of records: the
// $profiles store (and, through it, the app-shell's `profiles.find(...)` in the
// plugin-install modal), the Capabilities scope selector's `profiles.map(...)`,
// the SDK bridge. The backend can answer 2xx WITHOUT that shape — right after
// login it has returned `{}` (the missing-`profiles` crash class) — and each
// consumer falling back on its own turned one bad response into either a
// renderer-wide `TypeError: … reading 'find'` (undefined list) or a silent empty
// list, depending on where it landed. Normalize ONCE here, at the single door
// every caller shares, so no call site has to兜底: the resolved envelope is
// always `{ profiles: ProfileInfo[] }` whose elements are objects.
//
// A HEALTHY payload is returned untouched — same object, same array identity —
// so the success path stays byte-identical to before this guard.
const EMPTY_PROFILE_LIST: ProfileInfo[] = []

/** A profile row must be a non-null, non-array object — the only shape every
 *  consumer treats as a record (`p.name`, `p.is_default`, `normalizeProfileKey`). */
function isProfileRecord(value: unknown): value is ProfileInfo {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Shape-level description of a bad payload, for the warn — TYPES and key NAMES
 *  only, never any value (no labels, no tokens). */
function describeProfilesPayload(raw: unknown): string {
  if (raw === null) {
    return 'response null'
  }

  if (typeof raw !== 'object') {
    return `response ${typeof raw}`
  }

  const keys = Object.keys(raw)
  const { profiles } = raw as { profiles?: unknown }

  const listShape =
    profiles === undefined
      ? "'profiles' absent"
      : Array.isArray(profiles)
        ? `'profiles' array[${profiles.length}]`
        : `'profiles' ${profiles === null ? 'null' : typeof profiles}`

  return `${listShape}; response keys: ${keys.length > 0 ? keys.join(', ') : '(none)'}`
}

function normalizeProfilesResponse(raw: unknown): ProfilesResponse {
  const list = (raw as { profiles?: unknown } | null | undefined)?.profiles

  if (Array.isArray(list) && list.every(isProfileRecord)) {
    return raw as ProfilesResponse
  }

  if (!Array.isArray(list)) {
    console.warn(`[profiles] /api/profiles returned no usable list (${describeProfilesPayload(raw)}); using []`)

    return { profiles: EMPTY_PROFILE_LIST }
  }

  const profiles = list.filter(isProfileRecord)

  console.warn(
    `[profiles] /api/profiles dropped ${list.length - profiles.length} non-object element(s) of ${list.length} ` +
      `(${describeProfilesPayload(raw)})`
  )

  return { profiles }
}

export function getProfiles(scope?: ProfileScope): Promise<ProfilesResponse> {
  return hermesApi<ProfilesResponse>({
    ...(scope === undefined ? {} : capabilityScoped(scope)),
    path: '/api/profiles',
    timeoutMs: STARTUP_REQUEST_TIMEOUT_MS
  }).then(normalizeProfilesResponse)
}

export function createProfile(body: ProfileCreatePayload): Promise<{ name: string; ok: boolean; path: string }> {
  return hermesApi<{ name: string; ok: boolean; path: string }>({
    path: '/api/profiles',
    method: 'POST',
    body
  })
}

// Explicit (connection, profile) pin for a profile that lives on a gateway
// other than the foreground one — the fleet profile rail edits a remote
// square's SOUL/name in place. capabilityScoped now forwards a `'local'` pin
// itself (it must, or a remote registry PRIMARY absorbs "This device" reads),
// so this is a plain alias kept for the call sites' self-documenting name.
function profileOwnerScoped(scope?: ProfileScope): { connectionId?: string; profile?: string } {
  return capabilityScoped(scope)
}

export function renameProfile(
  name: string,
  newName: string,
  scope?: ProfileScope
): Promise<{ name: string; ok: boolean; path: string }> {
  return hermesApi<{ name: string; ok: boolean; path: string }>({
    ...profileOwnerScoped(scope),
    path: `/api/profiles/${encodeURIComponent(name)}`,
    method: 'PATCH',
    body: { new_name: newName }
  })
}

export function deleteProfile(name: string, scope?: ProfileScope): Promise<{ ok: boolean; path: string }> {
  const normalized = name.trim()
  const scopedProfile = scope && typeof scope === 'object' ? scope.profile?.trim() : undefined

  if (!normalized) {
    return Promise.reject(new Error('Profile name required'))
  }

  if (normalized.toLowerCase() === 'default' || scopedProfile?.toLowerCase() === 'default') {
    return Promise.reject(new Error('The default profile cannot be deleted.'))
  }

  return hermesApi<{ ok: boolean; path: string }>({
    ...profileOwnerScoped(scope),
    path: `/api/profiles/${encodeURIComponent(normalized)}`,
    method: 'DELETE'
  })
}

export function getProfileSoul(name: string, scope?: ProfileScope): Promise<ProfileSoul> {
  return hermesApi<ProfileSoul>({
    ...profileOwnerScoped(scope),
    path: `/api/profiles/${encodeURIComponent(name)}/soul`
  })
}

export function updateProfileSoul(name: string, content: string, scope?: ProfileScope): Promise<{ ok: boolean }> {
  return hermesApi<{ ok: boolean }>({
    ...profileOwnerScoped(scope),
    path: `/api/profiles/${encodeURIComponent(name)}/soul`,
    method: 'PUT',
    body: { content }
  })
}

export function getProfileSetupCommand(name: string): Promise<ProfileSetupCommand> {
  return hermesApi<ProfileSetupCommand>({
    path: `/api/profiles/${encodeURIComponent(name)}/setup-command`
  })
}

/** Export a profile to a shareable .tar.gz on the backend's filesystem.
 *  `extraFiles` stages extra root-level files (desktop.json — the appearance/
 *  interface overlay) into the archive alongside the profile's own artifacts. */
export function exportProfileArchive(
  name: string,
  opts: { extraFiles?: Record<string, string>; output?: string } = {}
): Promise<{ archive: string; ok: boolean }> {
  return hermesApi<{ archive: string; ok: boolean }>({
    path: `/api/profiles/${encodeURIComponent(name)}/export`,
    method: 'POST',
    body: { extra_files: opts.extraFiles ?? {}, output: opts.output ?? '' },
    timeoutMs: STARTUP_REQUEST_TIMEOUT_MS
  })
}

/** Import a profile .tar.gz as a new profile. Returns the bundled desktop
 *  appearance overlay too (when the archive carried one) so the caller can
 *  apply theme/layout without another round-trip. */
export function importProfileArchive(
  archive: string,
  name?: string
): Promise<{ desktop: null | ProfileDesktopOverlay; name: string; ok: boolean; path: string }> {
  return hermesApi<{ desktop: null | ProfileDesktopOverlay; name: string; ok: boolean; path: string }>({
    path: '/api/profiles/import',
    method: 'POST',
    body: { archive, name: name || null },
    timeoutMs: STARTUP_REQUEST_TIMEOUT_MS
  })
}
