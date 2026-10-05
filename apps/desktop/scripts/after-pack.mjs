/**
 * after-pack.mjs — electron-builder afterPack hook.
 *
 * Per-platform post-pack work on the unpacked app: payload relocation, nested
 * Chromium + wheel signing on macOS, PE signature sanitizing and batch signing
 * on Windows. The exe identity stamp lives in after-extract.mjs (#105629).
 *
 * electron-builder passes a context with:
 *   - electronPlatformName: 'win32' | 'darwin' | 'linux'
 *   - appOutDir:            the unpacked app directory for this target
 *   - packager.appInfo.productFilename: the exe basename (e.g. 'Hermes')
 */

import path from 'node:path'
import fs from 'node:fs'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { runPython } from '../../../scripts/build/python.mjs'

import { assertPackagedBackendReadyArtifact, resolvePackagedAsarPath } from './backend-ready-artifact.mjs'
import { batchSignAppTree } from './batch-sign-binaries.mjs'
import { rehashPayloadDigests } from './payload-digests.mjs'
import { resolveSigningIdentity, signNestedChromium } from './sign-nested-chromium.mjs'
import { signWheelZipMembers } from './sign-wheel-zips.mjs'
import { sanitizeTree } from './sanitize-pe-signatures.mjs'

/**
 * Put our full-resolution `assets/icon.icns` back as the bundle's legacy icon.
 * When `mac.icon` is the Icon Composer package, electron-builder replaces the
 * bundled `icon.icns` with actool's 256px fallback; macOS <= 15 shows that
 * file, so it must be the 16→1024 artwork the generator produced.
 *
 * The artwork base follows the build variant (product-identity `iconBase`):
 * `assets/icon` for upstream, `assets/plankton/icon` for the enterprise fork.
 * @param {{ appOutDir: string, packager: { appInfo: { productFilename: string } } }} context
 * @param {string} [appDir] the apps/desktop directory
 */
export async function restoreLegacyMacIcon({ appOutDir, packager }, appDir = path.resolve(import.meta.dirname, '..')) {
  const identity = createRequire(import.meta.url)(path.join(appDir, 'product-identity.cjs'))
  const iconBase = identity.iconBase || 'assets/icon'
  await copyFile(path.join(appDir, `${iconBase}.icns`), path.join(packager.getResourcesDir(appOutDir), 'icon.icns'))
}

/** electron-builder Arch enum → directory name (see before-pack.mjs). */
const ARCH_NAMES = Object.freeze({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' })

/**
 * R1 (PLANKTON-MIGRATION-BATCH2.md): FAIL-CLOSED when an enterprise
 * extraResource is missing from the packed app.
 *
 * electron-builder SILENTLY skips an `extraResources` entry whose `from` does
 * not exist, so one typo'd path ships an artifact with no CLI / no plugin and a
 * completely green build (the KI-PLANKTON-0056 hazard class). This asserts each
 * expected resource is present, NON-EMPTY, and — for the CLI — carries the
 * executable bit; a truncated (0-byte) seed, a lost mode, or a missing
 * `__init__.py` / `dashboard/manifest.json` (which would detach the plugin's
 * dashboard API while the build stays green) all turn the pack RED. Upstream
 * variants (`enterprise` false) assert nothing, so their Resources stay
 * bit-for-bit unchanged.
 *
 * @param {{ appOutDir: string, electronPlatformName: string, arch?: number|string, packager: { appInfo: { productFilename: string } } }} context
 * @param {string} [appDir] the apps/desktop directory
 * @returns {string[]} the verified resource-relative paths (empty for upstream)
 */
export function assertEnterpriseResourcesPresent(
  { appOutDir, electronPlatformName, arch, packager },
  appDir = path.resolve(import.meta.dirname, '..')
) {
  const identity = createRequire(import.meta.url)(path.join(appDir, 'product-identity.cjs'))
  if (!identity.enterprise) {
    return []
  }

  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources')
  const archName = typeof arch === 'number' ? ARCH_NAMES[arch] : arch
  const exe = electronPlatformName === 'win32' ? 'shaoke-cli.exe' : 'shaoke-cli'
  const cliRelative = `enterprise/cli/${electronPlatformName}-${archName}/${exe}`
  const expected = [
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    'enterprise/model-seed.json',
    'enterprise/plankton-enterprise/plugin.yaml',
    'enterprise/plankton-enterprise/__init__.py',
    'enterprise/plankton-enterprise/dashboard/manifest.json',
    'enterprise/plankton-enterprise/dashboard/plugin_api.py',
    'enterprise/plankton-enterprise/desktop/plugin.js',
    cliRelative
  ]

  const missing = expected.filter(relative => !fs.existsSync(path.join(resources, relative)))
  if (missing.length > 0) {
    throw new Error(
      `[after-pack] enterprise extraResources missing from ${resources}: ${missing.join(', ')} ` +
        '— electron-builder skips a missing `from` silently, so the pack would ship without them ' +
        '(fix the extraResources path or the staging step; see scripts/plankton-pack.sh)'
    )
  }

  const empty = expected.filter(relative => fs.statSync(path.join(resources, relative)).size === 0)
  if (empty.length > 0) {
    throw new Error(
      `[after-pack] enterprise extraResources are EMPTY in ${resources}: ${empty.join(', ')} ` +
        '— a zero-byte seed (truncated CLI / plugin payload) would ship a crippled artifact with a green build'
    )
  }

  // A staged-but-chmod-stripped CLI is not runnable; POSIX only (Windows has no
  // exec bit and relies on the .exe extension).
  if (electronPlatformName !== 'win32') {
    const cliPath = path.join(resources, cliRelative)
    if ((fs.statSync(cliPath).mode & 0o111) === 0) {
      throw new Error(
        `[after-pack] enterprise CLI is not executable: ${cliPath} ` +
          '— the staged shaoke-cli lost its exec bit (see scripts/plankton-pack.sh); a non-executable seed is unrunnable'
      )
    }
  }

  return expected
}

/**
 * Restore the empty app-level localizations dropped during Electron extraction.
 * Runs after language filtering and before signing; the markers come from the
 * packaged framework, not the host's Electron (which may be another version).
 * Non-blocking: a failed restore leaves a usable package and says so.
 */
export async function restoreMacLocaleMarkers({ appOutDir, packager }) {
  try {
    const resources = packager.getResourcesDir(appOutDir)
    const framework = packager.getMacOsElectronFrameworkResourcesDir(appOutDir)
    const entries = await readdir(framework, { withFileTypes: true })
    // Chromium also ships grammatical-gender packs; these are not macOS locales.
    const locales = entries.filter(
      entry =>
        entry.isDirectory() && entry.name.endsWith('.lproj') && !/_(FEMININE|MASCULINE|NEUTER)\.lproj$/.test(entry.name)
    )
    await Promise.all(locales.map(entry => mkdir(path.join(resources, entry.name), { recursive: true })))
  } catch (error) {
    console.warn(
      `[after-pack] macOS locale markers were not restored: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export default async function afterPack(context) {
  const platform = context.electronPlatformName
  // Artifact-skew guard (#60772): before any platform work, prove the packed
  // bundle's readiness parser still accepts both ready tokens. This runs for
  // every packed build — first install, `hermes desktop`, the installer's
  // --update rebuild — so a stale matcher fails the pack here instead of
  // killing healthy backends on user machines.
  const asarPath = resolvePackagedAsarPath(context)
  assertPackagedBackendReadyArtifact(asarPath)
  console.log(`[after-pack] verified backend readiness parser in ${asarPath}`)
  // R1: prove every enterprise extraResource actually landed. electron-builder
  // silently skips a missing `from`, so a typo'd path would otherwise ship a
  // crippled artifact with a green build (KI-PLANKTON-0056 hazard class).
  const verifiedResources = assertEnterpriseResourcesPresent(context)
  if (verifiedResources.length > 0) {
    console.log(`[after-pack] verified ${verifiedResources.length} enterprise resources present`)
  }
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const payload = path.join(resources, 'agent-payload')
  if (platform !== 'win32' && fs.existsSync(path.join(payload, 'manifest.json'))) {
    runPython([
      path.resolve(import.meta.dirname, '../../../scripts/bundles/payload.py'), 'relocate', payload], { stdio: 'inherit' })
  }
  if (platform === 'darwin') {
    await restoreLegacyMacIcon(context)
    await restoreMacLocaleMarkers(context)
    if (fs.existsSync(payload)) {
      const entitlements = path.join(import.meta.dirname, '..', 'electron', 'entitlements.mac.inherit.plist')
      const { identity, keychain } = await resolveSigningIdentity(context.packager)
      const nested = signNestedChromium(payload, { entitlements, identity, keychain })
      console.log(
        `[after-pack] repaired ${nested.repaired} framework links; signed ${nested.signed} nested chromium targets` +
          (identity ? ` as ${identity}` : ' (no Developer ID in the builder keychain)')
      )
      // uv-cache wheel zips carry Mach-O members the notary validates but
      // electron-osx-sign cannot reach; sign them in place (see module doc).
      const wheels = signWheelZipMembers(payload, { identity, keychain })
      if (wheels.signed > 0) {
        console.log(
          `[after-pack] signed ${wheels.signed} Mach-O members across ${wheels.wheels} payload wheel zips` +
            (identity ? ` as ${identity}` : ' (no Developer ID in the builder keychain)'))
      }
      // The macOS signer refreshes this again before sealing the outer app.
      // Unsigned builds end here and still need final-byte facts.
      rehashPayloadDigests(payload)
    }
    return
  }
  if (platform === 'linux') {
    return
  }
  if (platform !== 'win32') {
    return
  }

  const productName = context.packager?.appInfo?.productFilename || 'Hermes'
  const exe = path.join(context.appOutDir, `${productName}.exe`)

  // Repair dangling PE certificate tables BEFORE electron-builder signs the
  // tree. A stripped-but-still-declared signature makes signtool reject the
  // file with 0x800700C1, and AppxSIP inspects every PE inside the MSIX, so
  // one bad payload DLL fails the whole package. Unlike the stamp below this
  // is NOT best-effort: shipping past it means shipping an unsignable bundle.
  // this is a hack until https://github.com/astral-sh/python-build-standalone/pull/1217 is merged.
  const { scanned, repaired } = sanitizeTree(context.appOutDir)
  console.log(`[after-pack] ${scanned} PEs scanned, ${repaired.length} dangling certificate tables cleared`)
  for (const file of repaired) {
    console.log(`  ${file}`)
  }

  // The identity stamp already ran from afterExtract on the pristine exe
  // (scripts/after-extract.mjs, #105629); rcedit cannot commit to the
  // ASAR-integrity-rewritten PE we hold here.

  // Batch-sign every payload binary AFTER sanitize (above) and the rcedit
  // stamp: a dangling certificate table or a subsequent resource edit would
  // invalidate the signature. The product exe is excluded here and signed
  // per-file by the customSign hook (scripts/batch-sign-binaries.mjs) after
  // electron-builder's own rcedit + fuses pass. No-op with a loud warning when
  // the AZURE_SIGN_* environment is absent (unsigned/fork/canary lanes).
  await batchSignAppTree(context.appOutDir, exe, {
    config: context.packager.config,
    resourcesDir: context.packager.buildResourcesDir,
  })
  rehashPayloadDigests(payload)
}
