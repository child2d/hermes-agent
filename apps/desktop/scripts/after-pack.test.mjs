import {
  assertPackagedBackendReadyArtifact,
  assertBackendReadyArtifactSourceAcceptsBothTokens,
  resolvePackagedAsarPath
} from './backend-ready-artifact.mjs'
import { assertEnterpriseResourcesPresent } from './after-pack.mjs'
import { chmod, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { Platform, PlatformPackager } from 'app-builder-lib'
import { expect, it, vi } from 'vitest'

const require = createRequire(import.meta.url)
const desktopRoot = path.resolve(import.meta.dirname, '..')
// The builder config is electron-builder.config.cjs (package.json carries no `build` block).
const builderConfig = require(path.join(desktopRoot, 'electron-builder.config.cjs'))

async function configuredHook(context) {
  const hook = await import(new URL(`../${builderConfig.afterPack}`, import.meta.url).href)
  await hook.default(context)
}

// The afterPack readiness guard reads the packaged bundle's unpacked main;
// every fixture here packs a valid dual-token matcher so the tests keep
// exercising the locale/signing paths the hook also performs.
async function seedPackagedMain(context) {
  const asarPath = resolvePackagedAsarPath(context)
  await mkdir(path.dirname(asarPath), { recursive: true })
  await writeFile(asarPath, 'stub archive')
  await mkdir(path.join(`${asarPath}.unpacked`, 'dist'), { recursive: true })
  await writeFile(
    path.join(`${asarPath}.unpacked`, 'dist', 'electron-main.mjs'),
    'const re = /HERMES_(?:BACKEND|DASHBOARD)_READY[^\\n]*port=(\\d+)/m\n'
  )
}

function context(appOutDir, productFilename = 'Hermes Preview') {
  // Use electron-builder's real bundle path resolution, including branding.
  const packager = Object.assign(Object.create(PlatformPackager.prototype), {
    platform: Platform.MAC,
    appInfo: { productFilename },
    info: { framework: { distMacOsAppName: 'Electron.app' } }
  })
  return { appOutDir, electronPlatformName: 'darwin', packager }
}

it('restores app localizations from the filtered framework without copying locale data', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-locale-pack-'))
  try {
    const ctx = context(root)
    await seedPackagedMain(ctx)
    const framework = ctx.packager.getMacOsElectronFrameworkResourcesDir(root)
    const resources = ctx.packager.getResourcesDir(root)
    await mkdir(resources, { recursive: true })
    for (const name of ['nb.lproj', 'en_GB.lproj', 'nb_FEMININE.lproj']) {
      await mkdir(path.join(framework, name), { recursive: true })
      await writeFile(path.join(framework, name, 'locale.pak'), 'untouched locale data')
    }
    await writeFile(path.join(framework, 'not-a-directory.lproj'), 'not a locale')
    await mkdir(path.join(framework, 'other'), { recursive: true })
    await configuredHook(ctx)
    await configuredHook(ctx)
    expect((await readdir(resources)).filter(name => name.endsWith('.lproj')).sort())
      .toEqual(['en_GB.lproj', 'nb.lproj'])
    expect(await readdir(resources)).toContain('icon.icns')
    expect(await readdir(path.join(resources, 'nb.lproj'))).toEqual([])
    expect(await readFile(path.join(framework, 'nb.lproj', 'locale.pak'), 'utf8')).toBe('untouched locale data')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('puts the full-resolution .icns back after electron-builder packaged the layered icon', async () => {
  // With `mac.icon` pointing at the Icon Composer package, electron-builder
  // bundles actool's 256px fallback as icon.icns; macOS <= 15 shows that file.
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-mac-icon-'))
  try {
    const ctx = context(root)
    await seedPackagedMain(ctx)
    const resources = ctx.packager.getResourcesDir(root)
    await mkdir(ctx.packager.getMacOsElectronFrameworkResourcesDir(root), { recursive: true })
    await mkdir(resources, { recursive: true })
    await writeFile(path.join(resources, 'icon.icns'), 'actool fallback')
    await configuredHook(ctx)
    const restored = await readFile(path.join(resources, 'icon.icns'))
    expect(restored.equals(await readFile(path.join(desktopRoot, 'assets', 'icon.icns')))).toBe(true)
    expect(restored.subarray(0, 4).toString('latin1')).toBe('icns')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('leaves Linux alone and reports a missing framework without failing packaging', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-locale-pack-'))
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    // win32 is not a no-op here: the same hook sanitizes and batch-signs the PE tree.
    const linuxCtx = { appOutDir: root, electronPlatformName: 'linux' }
    await seedPackagedMain(linuxCtx)
    await configuredHook(linuxCtx)
    expect(warn).not.toHaveBeenCalled()
    const ctx = context(root)
    await seedPackagedMain(ctx)
    await configuredHook(ctx)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('macOS locale markers were not restored'))
    expect((await readdir(root)).sort()).toEqual(['Hermes Preview.app', 'resources'])
    expect(await readdir(ctx.packager.getResourcesDir(root))).toContain('icon.icns')
  } finally {
    warn.mockRestore()
    await rm(root, { recursive: true, force: true })
  }
})

// R1 (PLANKTON-MIGRATION-BATCH2.md): electron-builder silently skips a missing
// `extraResources.from`, so a typo'd enterprise resource path would otherwise
// ship a crippled artifact with a green build. After-pack must FAIL the pack.
const REQUIRED_ENTERPRISE = [
  'LICENSE',
  'THIRD-PARTY-NOTICES.md',
  'enterprise/model-seed.json',
  'enterprise/plankton-enterprise/plugin.yaml',
  'enterprise/plankton-enterprise/__init__.py',
  'enterprise/plankton-enterprise/dashboard/manifest.json',
  'enterprise/plankton-enterprise/dashboard/plugin_api.py',
  'enterprise/plankton-enterprise/desktop/plugin.js',
  'enterprise/cli/darwin-arm64/shaoke-cli'
]

/** Write a complete, valid enterprise Resources tree (CLI executable). */
async function seedEnterpriseResources(resources) {
  for (const relative of REQUIRED_ENTERPRISE) {
    const target = path.join(resources, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, 'x')
  }
  await chmod(path.join(resources, 'enterprise', 'cli', 'darwin-arm64', 'shaoke-cli'), 0o755)
}

async function enterpriseAppDir(root, name) {
  const appDir = path.join(root, name)
  await mkdir(appDir, { recursive: true })
  await writeFile(path.join(appDir, 'product-identity.cjs'), 'module.exports = { enterprise: true, iconBase: "assets/icon" }\n')
  return appDir
}

it('R1: fails the pack when an enterprise extraResource is missing, passes when present', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-enterprise-res-'))
  try {
    const appDir = await enterpriseAppDir(root, 'apps-desktop')
    const appOutDir = path.join(root, 'out')
    const resources = path.join(appOutDir, 'Plankton.app', 'Contents', 'Resources')
    await seedEnterpriseResources(resources)

    const ctx = { appOutDir, electronPlatformName: 'darwin', arch: 3, packager: { appInfo: { productFilename: 'Plankton' } } }
    expect(assertEnterpriseResourcesPresent(ctx, appDir)).toEqual(REQUIRED_ENTERPRISE)

    // Counter-proof: the exact wrong-path hazard (missing CLI) → RED build.
    await rm(path.join(resources, 'enterprise', 'cli', 'darwin-arm64'), { force: true, recursive: true })
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/enterprise\/cli\/darwin-arm64\/shaoke-cli/)

    // Upstream variants assert NOTHING — their Resources stay untouched.
    const upstreamDir = path.join(root, 'apps-desktop-upstream')
    await mkdir(upstreamDir, { recursive: true })
    await writeFile(path.join(upstreamDir, 'product-identity.cjs'), 'module.exports = { enterprise: false, iconBase: "assets/icon" }\n')
    expect(assertEnterpriseResourcesPresent(ctx, upstreamDir)).toEqual([])
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// F6: an in-place (present-but-broken) resource is just as damaging as a missing
// one and must also fail the pack: a 0-byte CLI, a CLI without its exec bit, and
// a missing __init__.py / dashboard/manifest.json (which detaches the plugin's
// dashboard API) each turn the build RED.
it('F6: empty CLI, stripped exec bit, and missing required files each fail the pack', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-enterprise-broken-'))
  try {
    const appDir = await enterpriseAppDir(root, 'apps-desktop')
    const appOutDir = path.join(root, 'out')
    const resources = path.join(appOutDir, 'Plankton.app', 'Contents', 'Resources')
    const cli = path.join(resources, 'enterprise', 'cli', 'darwin-arm64', 'shaoke-cli')
    const ctx = { appOutDir, electronPlatformName: 'darwin', arch: 3, packager: { appInfo: { productFilename: 'Plankton' } } }

    // Baseline: a fully valid tree passes.
    await seedEnterpriseResources(resources)
    expect(assertEnterpriseResourcesPresent(ctx, appDir)).toEqual(REQUIRED_ENTERPRISE)

    // (1) zero-byte CLI → RED.
    await writeFile(cli, '')
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/EMPTY/)

    // (2) CLI present and non-empty but not executable → RED.
    await writeFile(cli, 'x')
    await chmod(cli, 0o644)
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/not executable/)

    // (3) required file missing (dashboard/manifest.json) → RED.
    await chmod(cli, 0o755)
    await rm(path.join(resources, 'enterprise', 'plankton-enterprise', 'dashboard', 'manifest.json'))
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/dashboard\/manifest\.json/)

    // (4) __init__.py missing → RED.
    await writeFile(path.join(resources, 'enterprise', 'plankton-enterprise', 'dashboard', 'manifest.json'), 'x')
    await rm(path.join(resources, 'enterprise', 'plankton-enterprise', '__init__.py'))
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/__init__\.py/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
