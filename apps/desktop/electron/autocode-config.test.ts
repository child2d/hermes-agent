/**
 * Payload source resolution — this is what makes a distributed build work with
 * zero setup on a colleague's machine: no env var, just a settings file (or the
 * values baked at pack time).
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import { describeRemoteConfig, readSettingsFile, resolveRemoteConfig, settingsPath } from './autocode-config'

const dirs: string[] = []

function stateRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocode-config-'))
  dirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

describe('resolveRemoteConfig', () => {
  test('reports "none" when nothing is configured (falls back to a local checkout)', () => {
    const root = stateRoot()
    const config = resolveRemoteConfig({}, root)
    expect(config).toMatchObject({ payloadUrl: '', ak: '', sk: '', source: 'none' })
    expect(describeRemoteConfig(config)).toMatch(/未配置更新源/)
  })

  test('settings.json alone is enough — the colleague-machine case', () => {
    const root = stateRoot()
    fs.mkdirSync(root, { recursive: true })
    fs.writeFileSync(
      settingsPath(root),
      JSON.stringify({
        payloadUrl: 'https://auto-code.oss-cn-shenzhen.aliyuncs.com/autocode',
        ossAk: 'AK_FROM_FILE',
        ossSk: 'SK_FROM_FILE'
      })
    )
    const config = resolveRemoteConfig({}, root)
    expect(config.payloadUrl).toBe('https://auto-code.oss-cn-shenzhen.aliyuncs.com/autocode')
    expect(config.ak).toBe('AK_FROM_FILE')
    expect(config.sk).toBe('SK_FROM_FILE')
    expect(config.source).toBe('settings')
  })

  test('environment overrides settings.json (support fix without editing files)', () => {
    const root = stateRoot()
    fs.writeFileSync(
      settingsPath(root),
      JSON.stringify({ payloadUrl: 'https://from-file/autocode', ossAk: 'A', ossSk: 'S' })
    )
    const config = resolveRemoteConfig(
      { AUTOCODE_PAYLOAD_URL: 'https://from-env/autocode', AUTOCODE_OSS_AK: 'ENV_AK' },
      root
    )
    expect(config.payloadUrl).toBe('https://from-env/autocode')
    expect(config.ak).toBe('ENV_AK')
    // Unset in env → still taken from the file.
    expect(config.sk).toBe('S')
    expect(config.source).toBe('env')
  })

  test('a malformed settings file degrades to "none" instead of throwing', () => {
    const root = stateRoot()
    fs.writeFileSync(settingsPath(root), '{ not json')
    expect(readSettingsFile(root)).toBeNull()
    expect(resolveRemoteConfig({}, root).source).toBe('none')
  })

  test('describe names the layer that supplied the URL', () => {
    const root = stateRoot()
    fs.writeFileSync(settingsPath(root), JSON.stringify({ payloadUrl: 'https://auto-code.oss-cn-shenzhen.aliyuncs.com/autocode' }))
    const text = describeRemoteConfig(resolveRemoteConfig({}, root))
    expect(text).toContain('auto-code.oss-cn-shenzhen.aliyuncs.com')
    expect(text).toContain('settings.json')
    // No credentials is called out — it is the difference between "not configured"
    // and "configured but 403".
    expect(text).toContain('未配置凭证')
  })
})
