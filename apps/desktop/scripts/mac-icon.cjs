// Which macOS icon resource electron-builder packages, decided per build host.
//
// `assets/icon.icon` is the Icon Composer package for macOS 26 (the system
// masks its layers itself, so the border ring follows the real outline).
// electron-builder compiles it to `Contents/Resources/Assets.car` with
// actool, which exists only in Xcode >= 26; on any other host it throws and
// the whole build fails. Choosing at config time keeps a dev Mac on Xcode
// 16 building the .icns-only app it always built, while release CI selects
// Xcode 26 (`DEVELOPER_DIR`) and asserts the version before packaging so a
// silent fallback can never ship from there.
//
// Whichever resource is chosen, after-pack.mjs restores `assets/icon.icns`
// as the bundle's legacy icon: electron-builder's own `.icon` path replaces
// it with actool's 256px fallback, and macOS <= 15 shows the .icns.
// @ts-check
'use strict'

const path = require('node:path')
const fs = require('node:fs')
const { spawnSync } = require('node:child_process')

const ICON_COMPOSER = 'assets/icon.icon'
const LEGACY_ICNS = 'assets/icon.icns'

const DEFAULT_ICON_BASE = 'assets/icon'

/**
 * The actool short version from `actool --version` plist output, or null
 * when actool is missing or answers with something else.
 * @param {string} output
 * @returns {string | null}
 */
function parseActoolVersion(output) {
  const match = /<key>short-bundle-version<\/key>\s*<string>([^<]+)<\/string>/.exec(output)
  return match ? match[1].trim() : null
}

/**
 * @param {string | null} version
 * @returns {boolean}
 */
function actoolSupportsIconComposer(version) {
  if (!version) return false
  const major = Number.parseInt(version.split('.')[0], 10)
  return Number.isInteger(major) && major >= 26
}

/**
 * @param {(command: string, args: string[]) => { status: number | null, stdout?: string | Buffer | null, stderr?: string | Buffer | null }} run
 * @returns {string | null}
 */
function installedActoolVersion(run = (command, args) => spawnSync(command, args, { encoding: 'utf8' })) {
  try {
    const result = run('actool', ['--version'])
    if (result.status !== 0) return null
    return parseActoolVersion(`${result.stdout ?? ''}${result.stderr ?? ''}`)
  } catch {
    return null
  }
}

/**
 * The `mac.icon` value for this host: the Icon Composer package when actool
 * can compile it AND the package exists for this variant, otherwise the
 * legacy .icns alone.
 *
 * `iconBase` is the variant's extensionless artwork base (product-identity
 * `iconBase`). Enterprise variants ship only .icns/.ico/.png, so the layered
 * package is absent and the .icns is packaged.
 * @param {string} appDir the apps/desktop directory
 * @param {{ platform?: string, actoolVersion?: string | null, iconBase?: string, composerExists?: (file: string) => boolean, log?: (message: string) => void }} [options]
 * @returns {string}
 */
function macIconResource(appDir, options = {}) {
  const platform = options.platform ?? process.platform
  const iconBase = options.iconBase ?? DEFAULT_ICON_BASE
  const composer = `${iconBase}.icon`
  const legacy = `${iconBase}.icns`
  if (platform !== 'darwin') return legacy
  const version = options.actoolVersion === undefined ? installedActoolVersion() : options.actoolVersion
  const composerExists = options.composerExists ?? ((/** @type {string} */ file) => fs.existsSync(path.join(appDir, file)))
  if (actoolSupportsIconComposer(version) && composerExists(composer)) return composer
  const log = options.log ?? (message => console.warn(message))
  log(
    actoolSupportsIconComposer(version) && !composerExists(composer)
      ? `[mac-icon] no layered icon at ${path.join(appDir, composer)}: packaging ${legacy} only`
      : `[mac-icon] actool ${version ?? 'not found'}: packaging ${legacy} only; ` +
        `the macOS 26 layered icon (${path.join(appDir, composer)}) needs Xcode 26 or newer`
  )
  return legacy
}

module.exports = {
  DEFAULT_ICON_BASE,
  ICON_COMPOSER,
  LEGACY_ICNS,
  actoolSupportsIconComposer,
  installedActoolVersion,
  macIconResource,
  parseActoolVersion
}
