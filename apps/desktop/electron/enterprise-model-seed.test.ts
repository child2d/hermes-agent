// Behavior tests for the enterprise first-launch model seed. These exercise
// real files on disk (temp dirs), not the source: "existing config not
// overwritten", the 0600 mode, and "no secret written" are all asserted by
// reading back the bytes/mode the app would actually produce.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, test } from 'vitest'

import { loadEnterpriseModelSeed, renderSeedConfigYaml, seedEnterpriseModelConfig } from './enterprise-model-seed'

const ENTERPRISE = { enterprise: true }
const roots: string[] = []

function sandboxHome(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-seed-'))
  roots.push(dir)
  return dir
}

function writeSeedFile(dir: string, seed: unknown, name = 'model-seed.json'): string {
  const file = path.join(dir, name)
  fs.writeFileSync(file, typeof seed === 'string' ? seed : JSON.stringify(seed), 'utf8')
  return file
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

test('does nothing for a non-enterprise identity', () => {
  const home = sandboxHome()
  const result = seedEnterpriseModelConfig({ identity: { enterprise: false }, hermesHome: home })
  assert.deepEqual(result, { seeded: false, reason: 'not-enterprise' })
  assert.equal(fs.existsSync(path.join(home, 'config.yaml')), false)
})

test('with no seed source it is a no-op and writes nothing', () => {
  const home = sandboxHome()
  const result = seedEnterpriseModelConfig({ identity: ENTERPRISE, hermesHome: home, env: {} })
  assert.equal(result.seeded, false)
  assert.equal(result.reason, 'no-source')
  assert.equal(fs.existsSync(path.join(home, 'config.yaml')), false)
})

test('a $HERMES_ENTERPRISE_MODEL_SEED file writes a usable, secret-free config.yaml at 0600', () => {
  const home = sandboxHome()
  const source = writeSeedFile(sandboxHome(), {
    provider: 'deepseek',
    model: 'deepseek-chat',
    base_url: 'https://api.deepseek.example/v1',
    // Documentation-only: the key env var NAME must never become a value here.
    api_key_env: 'DEEPSEEK_API_KEY'
  })

  const result = seedEnterpriseModelConfig({
    identity: ENTERPRISE,
    hermesHome: home,
    env: { HERMES_ENTERPRISE_MODEL_SEED: source }
  })

  assert.deepEqual(result, { seeded: true, reason: 'seeded', configPath: path.join(home, 'config.yaml'), source })

  const configPath = path.join(home, 'config.yaml')
  const body = fs.readFileSync(configPath, 'utf8')
  assert.match(body, /^model:$/m)
  assert.match(body, /provider: "deepseek"/)
  assert.match(body, /default: "deepseek-chat"/)
  assert.match(body, /base_url: "https:\/\/api\.deepseek\.example\/v1"/)
  // No key-shaped material anywhere in the file.
  assert.ok(!/api_key:/.test(body), 'config.yaml must contain no api_key field')
  assert.ok(!body.includes('DEEPSEEK_API_KEY'), 'the api_key_env name must not be written as a value')
  assert.ok(!/sk-[A-Za-z0-9]/.test(body), 'no key-shaped token may appear')

  const mode = fs.statSync(configPath).mode & 0o777
  assert.equal(mode, 0o600, `config.yaml must be 0600, got ${mode.toString(8)}`)
})

test('an install-time <hermesHome>/enterprise/model-seed.json is honored', () => {
  const home = sandboxHome()
  fs.mkdirSync(path.join(home, 'enterprise'), { recursive: true })
  writeSeedFile(path.join(home, 'enterprise'), { provider: 'openai', model: 'gpt-4.1-mini' })

  const result = seedEnterpriseModelConfig({ identity: ENTERPRISE, hermesHome: home, env: {} })
  assert.equal(result.seeded, true)
  assert.equal(result.source, path.join(home, 'enterprise', 'model-seed.json'))
  const body = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')
  assert.match(body, /provider: "openai"/)
  assert.match(body, /default: "gpt-4\.1-mini"/)
  assert.ok(!/base_url/.test(body))
})

test('an existing config.yaml is never overwritten (byte-for-byte)', () => {
  const home = sandboxHome()
  const configPath = path.join(home, 'config.yaml')
  const original = 'model:\n  provider: custom\n  default: keep-me\n  api_key: from-the-user\n'
  fs.writeFileSync(configPath, original, 'utf8')
  const source = writeSeedFile(sandboxHome(), { provider: 'deepseek', model: 'deepseek-chat' })

  const result = seedEnterpriseModelConfig({
    identity: ENTERPRISE,
    hermesHome: home,
    env: { HERMES_ENTERPRISE_MODEL_SEED: source }
  })

  assert.equal(result.seeded, false)
  assert.equal(result.reason, 'exists')
  assert.equal(fs.readFileSync(configPath, 'utf8'), original)
})

test('a present-but-invalid seed file is reported, not silently ignored', () => {
  const home = sandboxHome()
  const source = writeSeedFile(sandboxHome(), '{ not json')
  const result = seedEnterpriseModelConfig({
    identity: ENTERPRISE,
    hermesHome: home,
    env: { HERMES_ENTERPRISE_MODEL_SEED: source }
  })
  assert.equal(result.reason, 'invalid-source')
  assert.equal(fs.existsSync(path.join(home, 'config.yaml')), false)

  // Well-formed JSON that lacks provider/model is also invalid.
  const missing = writeSeedFile(sandboxHome(), { provider: 'deepseek' }, 'missing.json')
  assert.deepEqual(loadEnterpriseModelSeed({ hermesHome: home, env: { HERMES_ENTERPRISE_MODEL_SEED: missing } }), {
    kind: 'invalid',
    source: missing
  })
})

test('seed values are YAML-quoted so hostile characters cannot break the file', () => {
  const rendered = renderSeedConfigYaml({
    provider: 'custom:evil',
    model: 'a"b\nc',
    base_url: 'https://x/#y'
  })
  const lines = rendered.split('\n')
  assert.ok(lines.includes('  provider: "custom:evil"'))
  assert.ok(lines.includes('  default: "a\\"b\\nc"'))
  assert.ok(lines.includes('  base_url: "https://x/#y"'))
})

test('a key-bearing seed writes the key to .env (0600), never into config.yaml', () => {
  const home = sandboxHome()
  const source = writeSeedFile(sandboxHome(), {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    base_url: 'https://api.deepseek.com',
    api_key_env: 'DEEPSEEK_API_KEY',
    api_key: 'sk-test-seed-value-1234567890'
  })

  const result = seedEnterpriseModelConfig({
    identity: ENTERPRISE,
    hermesHome: home,
    env: { HERMES_ENTERPRISE_MODEL_SEED: source }
  })

  assert.equal(result.seeded, true)
  assert.equal(result.envPath, path.join(home, '.env'))

  const configBody = fs.readFileSync(path.join(home, 'config.yaml'), 'utf8')
  assert.ok(!configBody.includes('sk-test-seed-value'), 'config.yaml must never carry the key')
  assert.ok(!/api_key:/.test(configBody), 'config.yaml must contain no api_key field')

  const envPath = path.join(home, '.env')
  const envBody = fs.readFileSync(envPath, 'utf8')
  assert.match(envBody, /^DEEPSEEK_API_KEY=sk-test-seed-value-1234567890$/m)
  assert.equal(fs.statSync(envPath).mode & 0o777, 0o600, '.env must be 0600')
})

test('the seeded key env var name is honored, and defaults to DEEPSEEK_API_KEY', () => {
  const home = sandboxHome()
  const source = writeSeedFile(sandboxHome(), {
    provider: 'openai',
    model: 'gpt-4.1-mini',
    api_key_env: 'OPENAI_API_KEY',
    api_key: 'sk-openai-seed'
  })
  seedEnterpriseModelConfig({
    identity: ENTERPRISE,
    hermesHome: home,
    env: { HERMES_ENTERPRISE_MODEL_SEED: source }
  })
  assert.match(fs.readFileSync(path.join(home, '.env'), 'utf8'), /^OPENAI_API_KEY=sk-openai-seed$/m)
})

test('an existing .env is never overwritten by the key seed', () => {
  const home = sandboxHome()
  const envPath = path.join(home, '.env')
  const original = 'OTHER=keep-me\n'
  fs.writeFileSync(envPath, original, 'utf8')
  const source = writeSeedFile(sandboxHome(), {
    provider: 'deepseek',
    model: 'deepseek-v4-flash',
    api_key: 'sk-should-not-land'
  })

  const result = seedEnterpriseModelConfig({
    identity: ENTERPRISE,
    hermesHome: home,
    env: { HERMES_ENTERPRISE_MODEL_SEED: source }
  })
  assert.equal(result.seeded, true)
  assert.equal(result.envPath, undefined)
  assert.equal(fs.readFileSync(envPath, 'utf8'), original)
})

test('a keyless seed writes no .env at all', () => {
  const home = sandboxHome()
  const source = writeSeedFile(sandboxHome(), { provider: 'deepseek', model: 'deepseek-v4-flash' })
  seedEnterpriseModelConfig({
    identity: ENTERPRISE,
    hermesHome: home,
    env: { HERMES_ENTERPRISE_MODEL_SEED: source }
  })
  assert.equal(fs.existsSync(path.join(home, '.env')), false)
})

test('the packaged resource seed is the lowest-precedence source', () => {
  const home = sandboxHome()
  const resources = sandboxHome()
  fs.mkdirSync(path.join(resources, 'enterprise'), { recursive: true })
  writeSeedFile(path.join(resources, 'enterprise'), { provider: 'packaged', model: 'from-resources' })

  const source = seedEnterpriseModelConfig({ identity: ENTERPRISE, hermesHome: home, env: {}, resourcesPath: resources })
  assert.equal(source.seeded, true)
  assert.match(fs.readFileSync(path.join(home, 'config.yaml'), 'utf8'), /provider: "packaged"/)
})
