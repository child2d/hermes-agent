import { existsSync, readFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { app } from 'electron'

import { resolveDesktopHermesHome } from './data-paths'
import { enterpriseHermesHomeFor } from './enterprise-paths'
import { readDesktopLaunchConfig } from './renderer-heap-flags'
import { wslgLaunchArgs } from './wslg-launch'
import { spawnWslgLaunch } from './wslg-launch-process'

// The baked product identity is a build-time global (see product-identity.ts).
// Read it defensively instead of importing the accessor: importing pulls in
// product-identity.ts, whose dev fallback `require('../product-identity.cjs')`
// is absent beside a dev/test bundle and would abort this pre-launch module.
// `undefined` (dev bundle) simply means "not an enterprise artifact".
declare const __HERMES_PRODUCT_IDENTITY__: { enterprise?: boolean } | undefined

function bakedEnterpriseIdentity(): { enterprise?: boolean } | null {
  return typeof __HERMES_PRODUCT_IDENTITY__ === 'undefined' ? null : __HERMES_PRODUCT_IDENTITY__
}

function configuredElectronFlags(env: NodeJS.ProcessEnv): string[] {
  // Resolve the home exactly like main.ts does, through the shared resolver:
  // HERMES_DATA_DIR_SUFFIX channel installs and profiles/-rooted HERMES_HOME
  // values must pick the same config.yaml before the relaunch and inside the
  // app, or desktop.electron_flags silently never reaches the relaunch.
  const home = resolveDesktopHermesHome({
    home: os.homedir(),
    env,
    // Linux-only pre-launch path; the win32 legacy-migration probe is never
    // consulted on posix, so its directoryExists callback is not needed here.
    directoryExists: () => false,
    readWindowsHome: () => null,
    // Enterprise builds read config.yaml from the enterprise home here too, so
    // pre-launch flags and the running app agree.
    defaultHome: enterpriseHermesHomeFor(bakedEnterpriseIdentity(), {
      home: os.homedir(),
      platform: process.platform,
      env
    })
  })

  try {
    return readDesktopLaunchConfig(readFileSync(path.join(home, 'config.yaml'), 'utf8')).electronFlags
  } catch {
    return []
  }
}

const linux = process.platform === 'linux'
const electronFlags = linux ? configuredElectronFlags(process.env) : []
// Present only when the NVIDIA proprietary kernel module is loaded (not
// nouveau, not WSL's dxg passthrough).
const nvidiaProprietaryDriver = linux && existsSync('/proc/driver/nvidia/version')

const args = wslgLaunchArgs(
  process.argv.slice(1),
  process.env,
  process.platform,
  electronFlags,
  nvidiaProprietaryDriver
)

if (args) {
  // Keep the launcher alive until the child exits: npm's concurrently must not
  // tear down Vite during this handoff. No backend, windows or single-instance
  // lock are created in this parent. The child has an explicit platform flag,
  // so it goes straight into main on its first pass.
  const child = spawnWslgLaunch(args)

  child.once('error', error => {
    console.error('[hermes] Wayland ozone launch failed:', error)
    app.exit(1)
  })
  child.once('exit', code => app.exit(code ?? 1))

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => child.kill(signal))
  }
} else {
  await import('./main')
}
