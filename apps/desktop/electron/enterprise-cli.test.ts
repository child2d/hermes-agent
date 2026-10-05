import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'

import {
  ENTERPRISE_PLUGIN_ID,
  enterpriseBinDir,
  enterpriseCliResourceRelative,
  mergePluginEnabled,
  prependEnterpriseBinToPath,
  seedEnterpriseAssets
} from './enterprise-cli'

const temps: string[] = []

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  temps.push(dir)

  return dir
}

function write(file: string, contents: string, mode?: number): string {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
  if (mode !== undefined) {
    fs.chmodSync(file, mode)
  }

  return file
}

/** Build a fake `<Resources>/enterprise/...` tree the seeder reads from. */
function fakeResources(root: string, platform = process.platform, arch = process.arch): string {
  write(path.join(root, ...enterpriseCliResourceRelative(platform, arch)), '#!/bin/sh\necho cli', 0o644)
  const plugin = path.join(root, 'enterprise', ENTERPRISE_PLUGIN_ID)
  write(path.join(plugin, 'plugin.yaml'), 'name: plankton-enterprise\nversion: 0.1.0\ndescription: x\n')
  write(path.join(plugin, '__init__.py'), 'def register(ctx):\n    return None\n')
  write(path.join(plugin, 'dashboard', 'manifest.json'), '{"name":"plankton-enterprise","api":"plugin_api.py"}')
  write(path.join(plugin, 'dashboard', 'plugin_api.py'), 'router = None\n')
  write(path.join(plugin, 'desktop', 'plugin.js'), 'export default { id: "plankton-enterprise", register() {} }\n')

  return root
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    fs.rmSync(dir, { force: true, recursive: true })
  }
})

describe('prependEnterpriseBinToPath', () => {
  it('front-loads <HERMES_HOME>/bin ahead of a personal ~/.local/bin', () => {
    const home = '/tmp/plankton-home'
    const out = prependEnterpriseBinToPath('/usr/bin:/Users/me/.local/bin:/bin', {
      hermesHome: home,
      delimiter: ':'
    })

    expect(out.split(':')[0]).toBe(`${home}/bin`)
    expect(out.split(':')).toContain('/Users/me/.local/bin')
    expect(out.split(':').indexOf(`${home}/bin`)).toBeLessThan(out.split(':').indexOf('/Users/me/.local/bin'))
  })

  it('is idempotent and case-insensitive on Windows', () => {
    const first = prependEnterpriseBinToPath('C:\\bin;C:\\Users\\Me\\.local\\bin', {
      hermesHome: 'C:\\Plankton',
      delimiter: ';',
      platform: 'win32'
    })
    const second = prependEnterpriseBinToPath(first, { hermesHome: 'C:\\Plankton', delimiter: ';', platform: 'win32' })

    expect(second).toBe(first)
    expect(first.split(';')[0].toLowerCase()).toBe('c:\\plankton\\bin')

    // A pre-existing, differently-cased copy is moved to the front, not duplicated.
    const moved = prependEnterpriseBinToPath('c:\\PLANKTON\\bin;C:\\bin', {
      hermesHome: 'C:\\Plankton',
      delimiter: ';',
      platform: 'win32'
    })
    expect(moved.split(';').filter(entry => entry.toLowerCase() === 'c:\\plankton\\bin')).toHaveLength(1)
    expect(moved.split(';')[0].toLowerCase()).toBe('c:\\plankton\\bin')
  })

  it('handles an empty PATH', () => {
    expect(prependEnterpriseBinToPath('', { hermesHome: '/h', delimiter: ':' })).toBe('/h/bin')
  })
})

describe('mergePluginEnabled', () => {
  const id = ENTERPRISE_PLUGIN_ID

  it('creates a plugins.enabled block when the config is empty', () => {
    const { contents, changed } = mergePluginEnabled('', id)

    expect(changed).toBe(true)
    expect(contents).toContain('plugins:')
    expect(contents).toContain(`  - ${id}`)
  })

  it('appends a plugins block when the config has none', () => {
    const { contents, changed } = mergePluginEnabled('model:\n  provider: "deepseek"\n', id)

    expect(changed).toBe(true)
    expect(contents).toMatch(/model:\n {2}provider: "deepseek"\nplugins:\n {2}enabled:\n {4}- plankton-enterprise\n/)
  })

  it('adds enabled: inside an existing plugins: mapping', () => {
    const { contents, changed } = mergePluginEnabled('plugins:\n  disabled:\n    - old\n', id)

    expect(changed).toBe(true)
    expect(contents).toContain('  disabled:')
    expect(contents).toMatch(/^plugins:\n {2}enabled:\n {4}- plankton-enterprise\n {2}disabled:\n/)
  })

  it('appends the id to an existing enabled list', () => {
    const { contents, changed } = mergePluginEnabled('plugins:\n  enabled:\n    - other\n', id)

    expect(changed).toBe(true)
    expect(contents).toMatch(/plugins:\n {2}enabled:\n {4}- plankton-enterprise\n {4}- other\n/)
  })

  it('is a no-op when the id is already enabled (idempotent)', () => {
    const source = `plugins:\n  enabled:\n    - ${id}\n`
    const { contents, changed } = mergePluginEnabled(source, id)

    expect(changed).toBe(false)
    expect(contents).toBe(source)
  })

  it('refuses to corrupt a scalar enabled: and leaves the file untouched', () => {
    const source = 'plugins:\n  enabled: []\n'
    expect(mergePluginEnabled(source, id)).toEqual({ contents: source, changed: false })
  })
})

describe('seedEnterpriseAssets', () => {
  it('is a no-op for a non-enterprise identity', () => {
    const home = tempDir('plankton-home-')
    const result = seedEnterpriseAssets({ identity: { enterprise: false }, hermesHome: home, resourcesPath: '/nope' })

    expect(result).toMatchObject({ seeded: false, reason: 'not-enterprise' })
    expect(fs.existsSync(path.join(home, 'bin'))).toBe(false)
  })

  it('lands the CLI (executable), the plugin halves, and plugins.enabled', () => {
    const home = tempDir('plankton-home-')
    const resources = fakeResources(tempDir('plankton-res-'))

    const result = seedEnterpriseAssets({ identity: { enterprise: true }, hermesHome: home, resourcesPath: resources })

    expect(result.reason).toBe('seeded')
    expect(result.cliCopied).toBe(true)

    const cli = path.join(enterpriseBinDir(home), process.platform === 'win32' ? 'shaoke-cli.exe' : 'shaoke-cli')
    expect(fs.existsSync(cli)).toBe(true)
    if (process.platform !== 'win32') {
      expect(fs.statSync(cli).mode & 0o111).not.toBe(0)
    }

    // Agent half + dashboard backend (no desktop/ under plugins/).
    expect(fs.existsSync(path.join(home, 'plugins', ENTERPRISE_PLUGIN_ID, 'plugin.yaml'))).toBe(true)
    expect(fs.existsSync(path.join(home, 'plugins', ENTERPRISE_PLUGIN_ID, 'dashboard', 'plugin_api.py'))).toBe(true)
    expect(fs.existsSync(path.join(home, 'plugins', ENTERPRISE_PLUGIN_ID, 'desktop'))).toBe(false)

    // Desktop half via the standalone door (no marker).
    const desktopFile = path.join(home, 'desktop-plugins', ENTERPRISE_PLUGIN_ID, 'plugin.js')
    expect(fs.existsSync(desktopFile)).toBe(true)
    expect(fs.existsSync(path.join(home, 'desktop-plugins', ENTERPRISE_PLUGIN_ID, '.hermes-package.json'))).toBe(false)

    const config = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')
    expect(config).toMatch(new RegExp(`-\\s*${ENTERPRISE_PLUGIN_ID}`))
  })

  it('is idempotent: a second run copies nothing and leaves plugins.enabled alone', () => {
    const home = tempDir('plankton-home-')
    const resources = fakeResources(tempDir('plankton-res-'))
    seedEnterpriseAssets({ identity: { enterprise: true }, hermesHome: home, resourcesPath: resources })

    const second = seedEnterpriseAssets({ identity: { enterprise: true }, hermesHome: home, resourcesPath: resources })

    expect(second.cliCopied).toBe(false)
    expect(second.configUpdated).toBe(false)
  })

  it('reports no-resources (never throws) when the resource tree is absent', () => {
    const home = tempDir('plankton-home-')
    const result = seedEnterpriseAssets({ identity: { enterprise: true }, hermesHome: home, resourcesPath: tempDir('empty-') })

    expect(result.seeded).toBe(false)
    expect(result.reason).toBe('no-resources')
  })
})
