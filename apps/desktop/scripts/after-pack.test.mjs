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
  'enterprise/plankton-enterprise/skills/baymax/SKILL.md',
  'enterprise/cli/darwin-arm64/shaoke-cli'
]

const VALID_PLUGIN_YAML =
  'name: plankton-enterprise\nversion: 0.1.0\ndescription: x\nauthor: Shaoke\n'
const VALID_MANIFEST_JSON = JSON.stringify({ name: 'plankton-enterprise', api: 'plugin_api.py' })

/**
 * A minimal but FORMAT-VALID Mach-O executable header for the given arch, so the
 * after-pack format/arch check accepts the fixture (a bare 'x' no longer does).
 */
function macho(arch) {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32LE(0xfeedfacf, 0) // MH_MAGIC_64, little-endian
  buffer.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4) // cputype
  buffer.writeUInt32LE(0, 8) // cpusubtype
  buffer.writeUInt32LE(2, 12) // filetype = MH_EXECUTE
  return buffer
}

/** Write a complete, valid enterprise Resources tree (CLI executable + parseable payloads). */
async function seedEnterpriseResources(resources) {
  const contents = {
    'enterprise/plankton-enterprise/plugin.yaml': VALID_PLUGIN_YAML,
    'enterprise/plankton-enterprise/dashboard/manifest.json': VALID_MANIFEST_JSON,
    'enterprise/model-seed.json': '{"provider":"deepseek"}'
  }
  for (const relative of REQUIRED_ENTERPRISE) {
    const target = path.join(resources, relative)
    await mkdir(path.dirname(target), { recursive: true })
    await writeFile(target, contents[relative] ?? 'x')
  }
  const cli = path.join(resources, 'enterprise', 'cli', 'darwin-arm64', 'shaoke-cli')
  await writeFile(cli, macho('arm64'))
  await chmod(cli, 0o755)
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

    // (5) the baymax pack's ONE skill missing → RED (W2 carrier; __init__.py's
    // register() is fail-closed on it, so without this an artifact would load
    // green and only die at plugin load).
    await writeFile(path.join(resources, 'enterprise', 'plankton-enterprise', '__init__.py'), 'x')
    await rm(path.join(resources, 'enterprise', 'plankton-enterprise', 'skills', 'baymax', 'SKILL.md'))
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/skills\/baymax\/SKILL\.md/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// P3 (second review): present + non-empty + exec is NOT enough. A directory, a
// garbage/wrong-arch binary, an invalid plugin.yaml and an invalid
// dashboard/manifest.json each shipped GREEN before — every one must now be RED.
it('P3: a directory at the CLI path, a non-binary CLI, and a wrong-arch CLI each fail the pack', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-enterprise-cli-fmt-'))
  try {
    const appDir = await enterpriseAppDir(root, 'apps-desktop')
    const appOutDir = path.join(root, 'out')
    const resources = path.join(appOutDir, 'Plankton.app', 'Contents', 'Resources')
    const ctx = { appOutDir, electronPlatformName: 'darwin', arch: 3, packager: { appInfo: { productFilename: 'Plankton' } } }
    const cli = path.join(resources, 'enterprise', 'cli', 'darwin-arm64', 'shaoke-cli')

    // Baseline: a valid Mach-O arm64 passes.
    await seedEnterpriseResources(resources)
    expect(assertEnterpriseResourcesPresent(ctx, appDir)).toEqual(REQUIRED_ENTERPRISE)

    // (1) a DIRECTORY at the CLI path (non-empty, 0755) → RED.
    await rm(cli, { force: true })
    await mkdir(path.join(cli, 'inside'), { recursive: true })
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/not a regular file/)
    await rm(cli, { force: true, recursive: true })

    // (2) present, non-empty, executable, but NOT a binary (text placeholder) → RED.
    await writeFile(cli, 'this is not a mach-o executable')
    await chmod(cli, 0o755)
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/not a darwin executable/)

    // (3) a well-formed Mach-O of the WRONG arch (x64 under darwin-arm64) → RED.
    await writeFile(cli, macho('x64'))
    await chmod(cli, 0o755)
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/architecture x64/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('P3: an invalid plugin.yaml and an invalid dashboard/manifest.json each fail the pack', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-enterprise-content-'))
  try {
    const appDir = await enterpriseAppDir(root, 'apps-desktop')
    const appOutDir = path.join(root, 'out')
    const resources = path.join(appOutDir, 'Plankton.app', 'Contents', 'Resources')
    const ctx = { appOutDir, electronPlatformName: 'darwin', arch: 3, packager: { appInfo: { productFilename: 'Plankton' } } }

    await seedEnterpriseResources(resources)
    expect(assertEnterpriseResourcesPresent(ctx, appDir)).toEqual(REQUIRED_ENTERPRISE)

    // (4) plugin.yaml that does not parse as YAML → RED.
    const pluginYaml = path.join(resources, 'enterprise', 'plankton-enterprise', 'plugin.yaml')
    await writeFile(pluginYaml, 'name: [unterminated\n')
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/plugin\.yaml is not a valid plugin manifest/)
    await writeFile(pluginYaml, VALID_PLUGIN_YAML)

    // (5) dashboard/manifest.json that does not parse as JSON → RED.
    const manifest = path.join(resources, 'enterprise', 'plankton-enterprise', 'dashboard', 'manifest.json')
    await writeFile(manifest, '{ this is not json')
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/manifest\.json is not a loadable dashboard manifest/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// P3-2 (third review): PARSEABLE is not enough — the engine loads these by
// SHAPE. `plugin.yaml = [1,2,3]` and `manifest.json = {}` / `[1,2,3]` are all
// valid YAML/JSON and shipped GREEN, yet the plugin/dashboard can never load.
it('P3-2: a well-formed but wrong-SHAPED plugin.yaml / manifest.json fails the pack', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'hermes-enterprise-shape-'))
  try {
    const appDir = await enterpriseAppDir(root, 'apps-desktop')
    const appOutDir = path.join(root, 'out')
    const resources = path.join(appOutDir, 'Plankton.app', 'Contents', 'Resources')
    const ctx = { appOutDir, electronPlatformName: 'darwin', arch: 3, packager: { appInfo: { productFilename: 'Plankton' } } }
    const pluginYaml = path.join(resources, 'enterprise', 'plankton-enterprise', 'plugin.yaml')
    const manifest = path.join(resources, 'enterprise', 'plankton-enterprise', 'dashboard', 'manifest.json')

    await seedEnterpriseResources(resources)
    expect(assertEnterpriseResourcesPresent(ctx, appDir)).toEqual(REQUIRED_ENTERPRISE)

    // (1) plugin.yaml is VALID YAML but a sequence, not a mapping → RED.
    await writeFile(pluginYaml, '[1, 2, 3]\n')
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/not a valid plugin manifest/)

    // (2) plugin.yaml is a mapping but misses the engine's required fields → RED.
    await writeFile(pluginYaml, 'name: plankton-enterprise\n')
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/missing required field/)
    await writeFile(pluginYaml, VALID_PLUGIN_YAML)

    // (3) manifest.json is VALID JSON but an empty mapping → RED (name + api absent).
    await writeFile(manifest, '{}')
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/not a loadable dashboard manifest/)

    // (4) manifest.json is VALID JSON but a sequence → RED.
    await writeFile(manifest, '[1, 2, 3]')
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/not a loadable dashboard manifest/)

    // (5) manifest.json declares an api file that does not exist → RED (the
    // dashboard tab would render but its backend would never mount).
    await writeFile(manifest, JSON.stringify({ name: 'plankton-enterprise', api: 'missing_api.py' }))
    expect(() => assertEnterpriseResourcesPresent(ctx, appDir)).toThrow(/declared api file is missing/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
