// enterprise-model-seed.ts — first-launch model configuration for the
// enterprise fork.
//
// CONTRACT (behavior-tested in enterprise-model-seed.test.ts):
//   1. Runs ONLY for the enterprise identity.
//   2. NEVER overwrites an existing config.yaml or .env (an operator or the
//      user may have written one).
//   3. The seed source may carry a provider `api_key`. When it does, the key is
//      written to `<HERMES_HOME>/.env` under the provider's env var — NOT into
//      config.yaml (a built-in provider resolves its key from the env, and an
//      inline config key would be ignored). config.yaml itself never carries a
//      secret. A key-bearing seed file lives OUTSIDE the repo (a build-machine
//      file copied into Resources at pack time); see ENTERPRISE.md §3.
//   4. Writes config.yaml and .env with mode 0600.
//
// WHERE THE VALUES COME FROM (in precedence order):
//   A. $HERMES_ENTERPRISE_MODEL_SEED   -> absolute path to a JSON file, or
//   B. <HERMES_HOME>/enterprise/model-seed.json  (operator drop), or
//   C. <Resources>/enterprise/model-seed.json    (baked at pack time, plankton
//      only — see electron-builder.config.cjs).
// If none exists the seed is a deliberate no-op ('no-source'): the app still
// boots and the operator can drop the file and relaunch.
//
// SEED JSON SHAPE:
//   {
//     "provider": "deepseek",                  // required
//     "model": "deepseek-v4-flash",            // required
//     "base_url": "https://api.deepseek.com",  // optional
//     "api_key_env": "DEEPSEEK_API_KEY",       // optional, the env var NAME the
//                                              //   key is written under. Defaults
//                                              //   to DEEPSEEK_API_KEY.
//     "api_key": "…"                           // optional, the secret VALUE.
//                                              //   Never committed; written to
//                                              //   <HERMES_HOME>/.env only.
//   }

import fs from 'node:fs'
import path from 'node:path'

export interface EnterpriseModelSeed {
  provider: string
  model: string
  base_url?: string
  api_key_env?: string
  api_key?: string
}

export type SeedReason = 'not-enterprise' | 'exists' | 'no-source' | 'invalid-source' | 'seeded'

export interface SeedResult {
  seeded: boolean
  reason: SeedReason
  configPath?: string
  /** Present only when a key-bearing seed also wrote `<HERMES_HOME>/.env`. */
  envPath?: string
  source?: string
}

export type SeedSource =
  | { kind: 'ok'; seed: EnterpriseModelSeed; source: string }
  | { kind: 'invalid'; source: string }
  | { kind: 'none' }

/** The default env var a seeded key is written under when none is named. */
export const DEFAULT_SEED_API_KEY_ENV = 'DEEPSEEK_API_KEY'

/** The seed file candidates, in precedence order. A present-but-invalid file
 *  is reported as 'invalid' (not silently skipped) so a typo'd install-time
 *  drop is diagnosable. */
export function seedSourceCandidates(options: {
  hermesHome: string
  env?: NodeJS.ProcessEnv
  resourcesPath?: string
}): string[] {
  const env = options.env ?? process.env
  const candidates: string[] = []
  const fromEnv = (env.HERMES_ENTERPRISE_MODEL_SEED || '').trim()
  if (fromEnv) {
    candidates.push(path.resolve(fromEnv))
  }
  candidates.push(path.join(options.hermesHome, 'enterprise', 'model-seed.json'))
  // Baked resource (plankton-only): <app>/Contents/Resources/enterprise/model-seed.json.
  const resources = options.resourcesPath ?? (typeof process !== 'undefined' ? process.resourcesPath : undefined)
  if (typeof resources === 'string' && resources) {
    candidates.push(path.join(resources, 'enterprise', 'model-seed.json'))
  }
  return candidates
}

function normalizeSeed(parsed: unknown): EnterpriseModelSeed | null {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return null
  }
  const record = parsed as Record<string, unknown>
  const provider = typeof record.provider === 'string' ? record.provider.trim() : ''
  const model = typeof record.model === 'string' ? record.model.trim() : ''
  if (!provider || !model) {
    return null
  }
  const seed: EnterpriseModelSeed = { provider, model }
  if (typeof record.base_url === 'string' && record.base_url.trim()) {
    seed.base_url = record.base_url.trim()
  }
  if (typeof record.api_key_env === 'string' && record.api_key_env.trim()) {
    seed.api_key_env = record.api_key_env.trim()
  }
  if (typeof record.api_key === 'string' && record.api_key.trim()) {
    seed.api_key = record.api_key.trim()
  }
  return seed
}

/** Resolve the seed source without writing anything. */
export function loadEnterpriseModelSeed(options: {
  hermesHome: string
  env?: NodeJS.ProcessEnv
  resourcesPath?: string
  fsModule?: Pick<typeof fs, 'readFileSync'>
}): SeedSource {
  const fsModule = options.fsModule ?? fs
  for (const source of seedSourceCandidates(options)) {
    let raw: string
    try {
      raw = fsModule.readFileSync(source, 'utf8')
    } catch {
      continue
    }
    try {
      const seed = normalizeSeed(JSON.parse(raw))
      return seed ? { kind: 'ok', seed, source } : { kind: 'invalid', source }
    } catch {
      return { kind: 'invalid', source }
    }
  }
  return { kind: 'none' }
}

const yamlScalar = (value: string): string => JSON.stringify(value)

/** Render the minimal, secret-free model block. Values are always
 *  double-quoted so any YAML-hostile characters survive. */
export function renderSeedConfigYaml(seed: EnterpriseModelSeed): string {
  const lines = [
    '# Generated by Plankton on first launch (enterprise model seed).',
    '# This file is written only once and is safe to edit.',
    '# The API key is NOT stored here; see ENTERPRISE.md for where it comes from.',
    'model:',
    `  provider: ${yamlScalar(seed.provider)}`,
    `  default: ${yamlScalar(seed.model)}`
  ]
  if (seed.base_url) {
    lines.push(`  base_url: ${yamlScalar(seed.base_url)}`)
  }
  return `${lines.join('\n')}\n`
}

/** Quote a dotenv value when it contains characters dotenv would otherwise
 *  mangle. Plain tokens (the common case) pass through unquoted. */
function dotenvScalar(value: string): string {
  return /[\s#"'\\=]/.test(value) ? JSON.stringify(value) : value
}

/** Render the `.env` body carrying only the seeded provider key. Empty when the
 *  seed carries no key (the '.env' is then not written at all). */
export function renderSeedEnv(seed: EnterpriseModelSeed): string {
  if (!seed.api_key) {
    return ''
  }
  const name = seed.api_key_env || DEFAULT_SEED_API_KEY_ENV
  return `# Generated by Plankton on first launch (enterprise model seed).\n${name}=${dotenvScalar(seed.api_key)}\n`
}

/**
 * Seed `<hermesHome>/config.yaml` on first launch. Idempotent and
 * non-destructive: an existing config.yaml is left byte-for-byte untouched.
 * When the seed carries an `api_key`, `<hermesHome>/.env` receives it (0600),
 * and is likewise never overwritten.
 */
export function seedEnterpriseModelConfig(options: {
  identity: { enterprise?: boolean } | null | undefined
  hermesHome: string
  env?: NodeJS.ProcessEnv
  resourcesPath?: string
  fsModule?: Pick<
    typeof fs,
    'existsSync' | 'mkdirSync' | 'writeFileSync' | 'chmodSync' | 'readFileSync'
  >
}): SeedResult {
  if (!options.identity?.enterprise) {
    return { seeded: false, reason: 'not-enterprise' }
  }

  const fsModule = options.fsModule ?? fs
  const configPath = path.join(options.hermesHome, 'config.yaml')

  if (fsModule.existsSync(configPath)) {
    return { seeded: false, reason: 'exists', configPath }
  }

  const loaded = loadEnterpriseModelSeed(options)
  if (loaded.kind === 'none') {
    return { seeded: false, reason: 'no-source' }
  }
  if (loaded.kind === 'invalid') {
    return { seeded: false, reason: 'invalid-source', source: loaded.source }
  }

  fsModule.mkdirSync(path.dirname(configPath), { recursive: true })
  fsModule.writeFileSync(configPath, renderSeedConfigYaml(loaded.seed), { mode: 0o600 })
  // writeFileSync's mode is masked by the process umask; force 0600 so the
  // file that ends up next to a secret-bearing .env is never world-readable.
  try {
    fsModule.chmodSync(configPath, 0o600)
  } catch {
    void 0 // best effort; the write above still used 0600 as its base mode
  }

  const result: SeedResult = { seeded: true, reason: 'seeded', configPath, source: loaded.source }

  // The provider key, when the seed carries one, goes to the env file — never
  // into config.yaml. A pre-existing .env is left untouched.
  const envBody = renderSeedEnv(loaded.seed)
  if (envBody) {
    const envPath = path.join(options.hermesHome, '.env')
    if (!fsModule.existsSync(envPath)) {
      fsModule.writeFileSync(envPath, envBody, { mode: 0o600 })
      try {
        fsModule.chmodSync(envPath, 0o600)
      } catch {
        void 0
      }
      result.envPath = envPath
    }
  }

  return result
}
