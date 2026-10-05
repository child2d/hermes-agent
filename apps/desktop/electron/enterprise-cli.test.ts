import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { parseDocument } from 'yaml'

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

  /** Parse the merged output and read `plugins.enabled` as plain strings. */
  function enabledAfter(merged: string): string[] {
    const doc = parseDocument(merged)
    expect(doc.errors, `merged YAML must parse: ${merged}`).toHaveLength(0)
    const seq = doc.getIn(['plugins', 'enabled']) as { items?: unknown[] } | undefined
    return (seq?.items ?? []).map(item =>
      typeof item === 'object' && item !== null && 'value' in item ? String((item as { value: unknown }).value) : String(item)
    )
  }

  /** Count top-level `plugins:` keys (must never become 2). */
  function topLevelPluginsCount(merged: string): number {
    const doc = parseDocument(merged)
    const map = doc.contents as { items?: Array<{ key: { value?: unknown } }> } | null
    return (map?.items ?? []).filter(entry => String(entry.key?.value) === 'plugins').length
  }

  it('creates a plugins.enabled block when the config is empty', () => {
    const { contents, changed } = mergePluginEnabled('', id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toContain(id)
  })

  it('fills an empty (null) plugins: key', () => {
    const { contents, changed } = mergePluginEnabled('plugins:\n', id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toContain(id)
    expect(topLevelPluginsCount(contents)).toBe(1)
  })

  it('fills an empty (null) enabled: key', () => {
    const { contents, changed } = mergePluginEnabled('plugins:\n  enabled:\n', id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toContain(id)
  })

  it('appends a plugins block when the config has none (other keys survive)', () => {
    const { contents, changed } = mergePluginEnabled('model:\n  provider: "deepseek"\n', id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toContain(id)
    const doc = parseDocument(contents)
    expect(doc.getIn(['model', 'provider'])).toBe('deepseek')
  })

  it('adds enabled: inside an existing plugins: mapping', () => {
    const { contents, changed } = mergePluginEnabled('plugins:\n  disabled:\n    - old\n', id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toContain(id)
    expect(parseDocument(contents).getIn(['plugins', 'disabled', 0])).toBe('old')
  })

  it('appends the id to an existing enabled list', () => {
    const { contents, changed } = mergePluginEnabled('plugins:\n  enabled:\n    - other\n', id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toEqual(expect.arrayContaining([id, 'other']))
  })

  it('is a no-op when the id is already enabled (idempotent)', () => {
    const source = `plugins:\n  enabled:\n    - ${id}\n`
    const { contents, changed } = mergePluginEnabled(source, id)

    expect(changed).toBe(false)
    expect(contents).toBe(source)
  })

  // ── F1 counterexample: the engine's OWN (indentless) style ───────────────
  it('F1: edits an engine-style indentless block list without breaking its parse', () => {
    // Exactly what the engine's ruamel writer emits: sequence items at the SAME
    // column as the key. The old line-splice inserted an indented item and the
    // engine then raised ParserError → InvalidUserConfigError.
    const source = 'model:\n  provider: deepseek\nplugins:\n  enabled:\n  - other\n'
    const { contents, changed } = mergePluginEnabled(source, id)

    expect(changed).toBe(true)
    // Parses cleanly (no mixed indent) and both entries are present.
    expect(enabledAfter(contents)).toEqual(expect.arrayContaining([id, 'other']))
    expect(parseDocument(contents).getIn(['model', 'provider'])).toBe('deepseek')
  })

  // ── F2: flow `plugins: {}` must not append a SECOND top-level plugins: ────
  it('F2: flow plugins:{} gets enabled inside it, no duplicate top-level key', () => {
    const { contents, changed } = mergePluginEnabled('plugins: {}\n', id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toContain(id)
    expect(topLevelPluginsCount(contents)).toBe(1)
  })

  // ── F3: an anchored plugins mapping is reused, not duplicated ────────────
  it('F3: an anchored plugins mapping is edited in place (no duplicate key)', () => {
    const source = 'x: &anchor\n  keep: 1\nplugins: &plugins\n  enabled: []\n'
    const { contents, changed } = mergePluginEnabled(source, id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toContain(id)
    expect(topLevelPluginsCount(contents)).toBe(1)
    expect(parseDocument(contents).getIn(['x', 'keep'])).toBe(1)
  })

  // ── F4: a nested `enabled:` under another submap is not plugins.enabled ──
  it('F4: a nested enabled: elsewhere is NOT mistaken for plugins.enabled', () => {
    const source = 'plugins:\n  other:\n    enabled: true\n'
    const { contents, changed } = mergePluginEnabled(source, id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toContain(id)
    // The unrelated nested `enabled: true` is untouched.
    expect(parseDocument(contents).getIn(['plugins', 'other', 'enabled'])).toBe(true)
  })

  // ── F4: a same-named id under `disabled` is not "already enabled" ────────
  it('F4: an id listed under plugins.disabled is still (re)added to enabled', () => {
    const source = `plugins:\n  disabled:\n    - ${id}\n`
    const { contents, changed } = mergePluginEnabled(source, id)

    expect(changed).toBe(true)
    expect(enabledAfter(contents)).toContain(id)
    expect(parseDocument(contents).getIn(['plugins', 'disabled', 0])).toBe(id)
  })

  it('refuses to turn a scalar enabled: into a list (file untouched)', () => {
    const source = 'plugins:\n  enabled: true\n'
    expect(mergePluginEnabled(source, id)).toEqual({ contents: source, changed: false, error: 'enabled-not-a-sequence' })
  })

  it('refuses a non-mapping plugins: (file untouched)', () => {
    const source = 'plugins:\n  - a\n'
    expect(mergePluginEnabled(source, id)).toEqual({ contents: source, changed: false, error: 'plugins-not-a-mapping' })
  })

  it('refuses unparseable YAML (file untouched)', () => {
    const source = 'a: [1, 2\n'
    expect(mergePluginEnabled(source, id)).toEqual({ contents: source, changed: false, error: 'unparseable' })
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

  it('F1: seeds into an engine-style (indentless) config and keeps it parseable', () => {
    const home = tempDir('plankton-home-')
    const resources = fakeResources(tempDir('plankton-res-'))
    const config = path.join(home, 'config.yaml')
    // The engine's own writer style: sequence items at the key's column.
    write(config, 'model:\n  provider: deepseek\nplugins:\n  enabled:\n  - other\n')

    const result = seedEnterpriseAssets({ identity: { enterprise: true }, hermesHome: home, resourcesPath: resources })

    expect(result.configUpdated).toBe(true)
    const merged = fs.readFileSync(config, 'utf8')
    const doc = parseDocument(merged)
    expect(doc.errors, merged).toHaveLength(0)
    expect(doc.getIn(['model', 'provider'])).toBe('deepseek')
    const enabled = (doc.getIn(['plugins', 'enabled']) as { items: Array<{ value: string }> }).items.map(i => i.value)
    expect(enabled).toEqual(expect.arrayContaining([ENTERPRISE_PLUGIN_ID, 'other']))
  })

  it('F1 refusal: an ambiguous `enabled:` scalar leaves config.yaml byte-for-byte unchanged', () => {
    const home = tempDir('plankton-home-')
    const resources = fakeResources(tempDir('plankton-res-'))
    const config = path.join(home, 'config.yaml')
    const original = 'plugins:\n  enabled: true\n'
    write(config, original)

    const result = seedEnterpriseAssets({ identity: { enterprise: true }, hermesHome: home, resourcesPath: resources })

    expect(result.configUpdated).toBe(false)
    expect(fs.readFileSync(config, 'utf8')).toBe(original)
  })

  it('F8: a same-size but different CLI is re-copied (content hash, not size+mtime)', () => {
    const home = tempDir('plankton-home-')
    const resources = fakeResources(tempDir('plankton-res-'))
    seedEnterpriseAssets({ identity: { enterprise: true }, hermesHome: home, resourcesPath: resources })

    const cli = path.join(enterpriseBinDir(home), process.platform === 'win32' ? 'shaoke-cli.exe' : 'shaoke-cli')
    const before = fs.readFileSync(cli)
    // Same byte length, different bytes, and a NEWER mtime — the old size+mtime
    // check would have kept this stale copy.
    const corrupted = Buffer.from(before)
    corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1] === 0x0a ? 0x0b : 0x0a
    fs.writeFileSync(cli, corrupted)
    const future = new Date(Date.now() + 60_000)
    fs.utimesSync(cli, future, future)

    const second = seedEnterpriseAssets({ identity: { enterprise: true }, hermesHome: home, resourcesPath: resources })

    expect(second.cliCopied).toBe(true)
    expect(fs.readFileSync(cli).equals(before)).toBe(true)
  })

  it('reports no-resources (never throws) when the resource tree is absent', () => {
    const home = tempDir('plankton-home-')
    const result = seedEnterpriseAssets({ identity: { enterprise: true }, hermesHome: home, resourcesPath: tempDir('empty-') })

    expect(result.seeded).toBe(false)
    expect(result.reason).toBe('no-resources')
  })
})
