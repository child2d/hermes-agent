import { isCanaryTag } from './feature-flags'
import type { InstallStamp } from './install-stamp'
import { COMMIT_BUILD_UPDATE_MESSAGE } from './updater/external'

export interface AppVersionInfo {
  appVersion: string
  baseVersion?: string
  channel?: string | null
  sequence?: number
  buildId?: string
  distance?: number
  commit?: string | null
  branch?: string | null
  source?: InstallStamp['source']
  distribution?: string
  updateMechanism?: InstallStamp['updateMechanism']
  /** The artifact kind of the app carrying this version info ('bootstrap' |
   *  'bundled' | 'light'). The Distribution label keys on it: a bootstrap
   *  artifact is the old-style installer shell over a managed checkout. */
  payload?: InstallStamp['payload']
  /** True when the runtime checkout carries the bootstrap installers'
   *  `.hermes-bootstrap-complete` receipt — install.sh / install.ps1 (or the
   *  desktop bootstrap) created it, as opposed to a manual git clone. */
  installedByScript?: boolean
  dirty?: boolean
}

/** A release channel is an artifact identity, not a user preference. */
export function packagedReleaseChannel(stamp: Readonly<InstallStamp> | null): string | null {
  if (stamp?.channelBuild) {
    return stamp.channelBuild.channel
  }

  if (!stamp?.tag || stamp.source === 'commit-build') {
    return null
  }

  return isCanaryTag(stamp.tag) ? 'canary' : 'stable'
}

/** Values that mean "no version known" rather than a real release: the empty
 *  backend reply, the backend's own unknown marker, and the 0.0.0 placeholder
 *  both package.json files carry on main (real releases are date-based, and
 *  channel builds override the version at pack time). Repeating any of these
 *  in About is how the panel ends up reporting Version 0.0.0 (#124581). */
const PLACEHOLDER_VERSIONS = new Set(['', '0.0.0', 'v0.0.0', 'unknown'])

function firstRealVersion(candidates: Array<string | null | undefined>): string {
  for (const candidate of candidates) {
    if (candidate && !PLACEHOLDER_VERSIONS.has(candidate)) {
      return candidate
    }
  }

  return ''
}

/** Map version info to the native About panel string. Unlike the renderer —
 *  which renders '' as its localized "unavailable" copy — an empty
 *  applicationVersion falls back to the bundle version (the 0.0.0 placeholder
 *  on local builds), so unknown must become an explicit label. Commit
 *  spelling matches the backend's untagged-checkout display_version
 *  (`git.<short>[.dirty]`).
 *  ponytail: English-only fallback; localize if the native panel ever needs it. */
export function nativeAboutVersion(info: AppVersionInfo): string {
  const version = firstRealVersion([info.appVersion, info.baseVersion])

  if (version) {
    return version
  }

  if (info.commit && !/^0+$/.test(info.commit)) {
    return `git.${info.commit.slice(0, 7)}${info.dirty ? '.dirty' : ''}`
  }

  return 'unknown'
}

/**
 * Second line of the native About panel: which environment this artifact is and
 * which engine home it picked.
 *
 * Neither fact is visible anywhere else on that panel, and a product that ships
 * more than one environment shows the same name and version in all of them —
 * "which home is this app actually using" is the first question once two of them
 * run side by side. Empty when there is no environment (every upstream variant),
 * so their panel stays exactly as it was.
 *
 * ponytail: English-only, like nativeAboutVersion above — the native panel has
 * no localization path of its own.
 */
export function aboutCredits(opts: { env?: string | null; home?: string | null; homedir?: string | null }): string {
  const env = opts.env?.trim()

  if (!env) {
    return ''
  }

  const home = opts.home?.trim()
  const homedir = opts.homedir?.trim()
  // `~` instead of the operator's real name: this line ends up in screenshots.
  const shown = home ? (homedir && home.startsWith(`${homedir}/`) ? `~${home.slice(homedir.length)}` : home) : null

  return shown ? `Environment: ${env}\nHome: ${shown}` : `Environment: ${env}`
}

/** The backend may live on another machine and run a different release. */
export function appVersionInfo(
  stamp: Readonly<InstallStamp> | null,
  runtimeVersion: string,
  packageVersion: string
): AppVersionInfo {
  if (!stamp) {
    return { appVersion: firstRealVersion([runtimeVersion, packageVersion]), baseVersion: packageVersion }
  }

  const build = stamp.channelBuild

  return {
    appVersion: build
      ? `${build.sourceVersion} (${build.channel} #${build.sequence}, ${build.commit.slice(0, 8)})`
      : stamp.payload === 'bootstrap'
        ? firstRealVersion([runtimeVersion, stamp.displayVersion, stamp.baseVersion, packageVersion])
        : firstRealVersion([stamp.displayVersion, stamp.baseVersion, packageVersion, runtimeVersion]),
    baseVersion: build?.sourceVersion ?? stamp.baseVersion ?? undefined,
    sequence: build?.sequence,
    buildId: build?.buildId,
    channel: packagedReleaseChannel(stamp),
    distance: stamp.distance ?? undefined,
    commit: stamp.commit,
    branch: stamp.branch,
    source: stamp.source ?? undefined,
    distribution: stamp.distribution ?? undefined,
    updateMechanism: stamp.updateMechanism,
    payload: stamp.payload,
    dirty: stamp.dirty
  }
}

export function assertSourceUpdateChannel(stamp: Readonly<InstallStamp> | null): void {
  if (stamp?.source === 'commit-build') {
    throw new Error(COMMIT_BUILD_UPDATE_MESSAGE)
  }

  if (stamp && stamp.payload !== 'bootstrap') {
    throw new Error('This package has a fixed update channel. Install the other package to change channels.')
  }
}
