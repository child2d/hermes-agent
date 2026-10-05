/**
 * Card point 1 (PLANKTON-MIGRATION-BATCH2.md §7): WHICH desktop-plugin door can
 * load on the very first launch?
 *
 * This is the empirical settlement, using the repo's OWN functions:
 *   - `reconcileUnifiedDesktopHalves` (electron/desktop-plugins-root.ts) is what
 *     Electron runs when it resolves the desktop-plugins root.
 *   - `pluginActive` (src/contrib/plugins-store.ts) is the loader's exact
 *     activation decision.
 *
 * FINDING: the unified-package half (`plugins/<name>/desktop/plugin.js`) is
 * COPIED into the app root WITH a `.hermes-package.json` marker, and the loader
 * caps a marked entry at `defaultEnabled: false` — "installed but inert"
 * (GHSA-mcfc-hp25-cjv7). Its enable state lives in the renderer's localStorage,
 * which a first launch cannot seed from the main process. The standalone door
 * (`desktop-plugins/<name>/plugin.js`, NO marker) is default-ON. The enterprise
 * plugin therefore ships its desktop half through the STANDALONE door.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import { PACKAGE_MARKER, reconcileUnifiedDesktopHalves } from './desktop-plugins-root'

const PLUGIN_ID = 'plankton-enterprise'
const PLUGIN_SRC = `export default { id: '${PLUGIN_ID}', defaultEnabled: true, register() {} }\n`

const homes: string[] = []

function makeHome(): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-doors-'))
  homes.push(home)

  return home
}

function write(file: string, contents: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

/**
 * The runtime loader's EXACT activation decision, mirrored from
 * `src/contrib/runtime-loader.ts` (the disk scan) +
 * `src/contrib/plugins-store.ts` (`pluginActive`: a user decision, else the
 * default). On a first launch there is no user decision, so:
 *   optionsDefaultEnabled = marker ? false : undefined
 *   active = (plugin.defaultEnabled ?? true) && (optionsDefaultEnabled ?? true)
 */
function effectiveActive(hasMarker: boolean, pluginDefaultEnabled = true): boolean {
  const optionsDefaultEnabled = hasMarker ? false : undefined

  return pluginDefaultEnabled && (optionsDefaultEnabled ?? true)
}

afterEach(() => {
  for (const home of homes.splice(0)) {
    fs.rmSync(home, { force: true, recursive: true })
  }
})

describe('desktop-plugin doors', () => {
  it('unified door (plugins/<n>/desktop/plugin.js) materializes a MARKER and is INERT on first launch', async () => {
    const home = makeHome()
    const appRoot = path.join(home, 'desktop-plugins')
    write(path.join(home, 'plugins', PLUGIN_ID, 'desktop', 'plugin.js'), PLUGIN_SRC)

    // A fresh app root has nothing: the unified door is a SOURCE, not a load site.
    expect(fs.existsSync(path.join(appRoot, PLUGIN_ID, 'plugin.js'))).toBe(false)

    await reconcileUnifiedDesktopHalves(home, appRoot)

    // It IS copied out (so it would load), but WITH the marker…
    expect(fs.existsSync(path.join(appRoot, PLUGIN_ID, 'plugin.js'))).toBe(true)
    expect(fs.existsSync(path.join(appRoot, PLUGIN_ID, PACKAGE_MARKER))).toBe(true)
    // …and the loader then caps it at defaultEnabled:false → inert until a
    // renderer toggle that a first launch cannot preseed.
    expect(effectiveActive(true)).toBe(false)
    // Sanity: even with the plugin's own defaultEnabled true, the marker wins.
    expect(effectiveActive(true, true)).toBe(false)
  })

  it('standalone door (desktop-plugins/<n>/plugin.js) has NO marker and is ACTIVE on first launch', async () => {
    const home = makeHome()
    const appRoot = path.join(home, 'desktop-plugins')
    write(path.join(appRoot, PLUGIN_ID, 'plugin.js'), PLUGIN_SRC)

    // No reconcile involvement and no marker: the loader sees an unmarked entry.
    expect(fs.existsSync(path.join(appRoot, PLUGIN_ID, PACKAGE_MARKER))).toBe(false)
    // Reconcile is a no-op for a standalone entry (it is not a `plugins/` source).
    await reconcileUnifiedDesktopHalves(home, appRoot)
    expect(fs.existsSync(path.join(appRoot, PLUGIN_ID, PACKAGE_MARKER))).toBe(false)
    expect(effectiveActive(false)).toBe(true)
  })
})
