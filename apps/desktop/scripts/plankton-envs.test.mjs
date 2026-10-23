// plankton-envs.test.mjs — the environment table is the single source of the
// three-app split, so these tests hold the invariants that make the split real:
// prod stays byte-identical to what shipped before, the three environments
// cannot collide on any OS-visible marker, every enumeration outside JS agrees
// with the table, and each environment carries its own non-secret manifest.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { test } from 'vitest'

import planktonEnvs from '../plankton-envs.cjs'

// The packaging configuration is CJS and reads the ambient variant at require
// time, so it is loaded for real (not re-implemented) once per environment.
const require = createRequire(import.meta.url)

const { PLANKTON_ENVS, PLANKTON_VARIANTS, isPlanktonVariant, planktonEnvFor, planktonEnvByName } = planktonEnvs

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoRoot = path.resolve(desktopRoot, '..', '..')

/** The identity a variant resolves to, in a fresh process (product-identity.cjs
 *  derives + validates from the ambient HERMES_DESKTOP_VARIANT). */
function identityFor(/** @type {string} */ variant) {
  const raw = execFileSync(
    process.execPath,
    ['-e', 'console.log(JSON.stringify(require(process.argv[1])))', path.join(desktopRoot, 'product-identity.cjs')],
    {
      env: { ...process.env, HERMES_DESKTOP_VARIANT: variant, HERMES_PAYLOAD_TAG: '', HERMES_BUILD_COMMIT: '' },
      encoding: 'utf8'
    }
  )
  return JSON.parse(raw)
}

/** The electron-builder configuration for one variant, freshly required. */
function packagingFor(/** @type {string} */ variant) {
  const productIdentity = path.join(desktopRoot, 'product-identity.cjs')
  const config = path.join(desktopRoot, 'electron-builder.config.cjs')
  process.env.HERMES_DESKTOP_VARIANT = variant
  for (const file of [config, productIdentity]) delete require.cache[require.resolve(file)]
  try {
    return require(config)
  } finally {
    delete process.env.HERMES_DESKTOP_VARIANT
  }
}

test('the table holds exactly the three environments, keyed by env name', () => {
  assert.deepEqual(Object.keys(PLANKTON_ENVS), ['prod', 'test', 'dev'])
  assert.deepEqual(PLANKTON_VARIANTS, ['plankton', 'plankton-test', 'plankton-dev'])
  assert.equal(isPlanktonVariant('plankton'), true)
  assert.equal(isPlanktonVariant('plankton-test'), true)
  assert.equal(isPlanktonVariant('plankton-dev'), true)
  assert.equal(planktonEnvFor('plankton-test')?.env, 'test')
  assert.equal(planktonEnvByName('dev')?.variant, 'plankton-dev')
  // A typo must not be half-recognised as the family, and upstream variants
  // must never be pulled into it.
  for (const other of ['plankton-staging', 'plankton-', 'Plankton', 'bundled', 'store', '', undefined]) {
    assert.equal(isPlanktonVariant(other), false, `${String(other)} is not a Plankton environment variant`)
    assert.equal(planktonEnvFor(other), null)
  }
})

test('prod keeps the historical identity and data root verbatim', () => {
  const prod = PLANKTON_ENVS.prod
  assert.equal(prod.display, 'Plankton')
  assert.equal(prod.pascal, 'Plankton')
  assert.equal(prod.appIdBase, 'com.shaoke.plankton')
  // null = the historical `~/.plankton/engine/home`, so an existing install's
  // sessions and config do not move when the split lands. TRANSITIONAL: the
  // agreed target is the uniform `~/.plankton/prod/engine/home` (see the table
  // header) — flipping it is this one cell plus a migration, held until dev and
  // test are green end to end.
  assert.equal(prod.homeDir, null)

  const identity = identityFor('plankton')
  assert.equal(identity.displayName, 'Plankton')
  assert.equal(identity.appId, 'com.shaoke.plankton')
  assert.equal(identity.appNamePascal, 'Plankton')
  assert.equal(identity.artifactNamePascal, 'Plankton')
  assert.equal(identity.env, 'prod')
  assert.equal(identity.homeDir, null)
})

test('every environment is a distinct app on every OS-visible marker', () => {
  // Per marker, across environments: prod's pascal and display name are the
  // same string by design, so uniqueness is required BETWEEN environments,
  // never between markers of one environment.
  const seen = new Map()
  for (const spec of Object.values(PLANKTON_ENVS)) {
    const identity = identityFor(spec.variant)
    assert.equal(identity.enterprise, true, `${spec.variant} must be an enterprise build`)
    assert.equal(identity.bundledCarrier, true, `${spec.variant} must keep the bundled runtime shape`)
    assert.equal(identity.env, spec.env)
    assert.equal(identity.homeDir, spec.homeDir)
    assert.equal(identity.appId, spec.appIdBase)
    assert.equal(identity.appNamePascal, spec.pascal)
    assert.equal(identity.artifactNamePascal, spec.pascal)
    assert.equal(identity.displayName, spec.display)
    // The desktop userData dir is derived from appNamePascal (see
    // applyDesktopIdentity), so distinct pascals ARE distinct userData dirs and
    // distinct single-instance locks.
    for (const marker of ['appId', 'appNamePascal', 'displayName', 'kebab']) {
      const value = String(identity[marker] ?? spec[marker])
      const owners = seen.get(marker) ?? new Map()
      assert.equal(owners.get(value), undefined, `${marker} ${value} collides between ${owners.get(value)} and ${spec.variant}`)
      owners.set(value, spec.variant)
      seen.set(marker, owners)
    }
  }
  for (const [marker, owners] of seen) {
    assert.equal(owners.size, Object.keys(PLANKTON_ENVS).length, `${marker} must be unique per environment`)
  }
})

test('the engine home is a data root of its own per environment', () => {
  const roots = new Set()
  for (const spec of Object.values(PLANKTON_ENVS)) {
    const identity = identityFor(spec.variant)
    // Mirrors electron/enterprise-paths.ts: the historical segments, with the
    // environment's segment inserted under the product root.
    const segments = ['.plankton', ...(identity.homeDir ? [identity.homeDir] : []), 'engine', 'home']
    const root = path.posix.join('/Users/u', ...segments)
    assert.equal(roots.has(root), false, `${root} is shared by two environments`)
    roots.add(root)
  }
  assert.deepEqual([...roots].sort(), [
    '/Users/u/.plankton/dev/engine/home',
    '/Users/u/.plankton/engine/home',
    '/Users/u/.plankton/test/engine/home'
  ])
})

test('the python stamp writer agrees with the table', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'scripts/write_install_stamp.py'), 'utf8')
  const tuple = /^_BRANDED_PLANKTON = \(([^)]*)\)$/m.exec(source)
  assert.ok(tuple, 'scripts/write_install_stamp.py must define _BRANDED_PLANKTON')
  const variants = tuple[1]
    .split(',')
    .map(part => part.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)

  // Set equality, not order: the python tuple and the JS table must name the
  // same family, or a PM-staged bundle would reject a valid variant.
  assert.deepEqual([...variants].sort(), [...PLANKTON_VARIANTS].sort())
})

test('each environment ships its own NON-SECRET manifest, and the packager selects it', () => {
  for (const spec of Object.values(PLANKTON_ENVS)) {
    const file = path.join(desktopRoot, 'enterprise/envs', `${spec.env}.json`)
    assert.ok(fs.existsSync(file), `${file} must be committed`)
    const raw = fs.readFileSync(file, 'utf8')
    const manifest = JSON.parse(raw)
    assert.equal(manifest.env, spec.env, `${file} must declare its own environment`)
    for (const key of ['sso', 'model', 'update', 'features']) {
      assert.equal(typeof manifest[key], 'object', `${file} must carry ${key}`)
    }
    // The manifest travels inside every artifact: a secret in it would be
    // extractable by every recipient, which is why the resolver keeps the
    // client_secret in a per-machine file instead. Key NAMES are checked
    // recursively — `api_key_env` names an env var and is allowed, a key that
    // holds a key is not.
    const keyNames = []
    const walk = value => {
      if (Array.isArray(value)) value.forEach(walk)
      else if (value && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value)) {
          keyNames.push(key)
          walk(nested)
        }
      }
    }
    walk(manifest)
    for (const forbidden of ['clientSecret', 'client_secret', 'apiKey', 'api_key', 'secret', 'token', 'password']) {
      assert.equal(keyNames.includes(forbidden), false, `${file} must not carry a ${forbidden} field`)
    }

    const config = packagingFor(spec.variant)
    const resources = config.extraResources ?? []
    assert.ok(
      resources.some(entry => entry.from === `enterprise/envs/${spec.env}.json` && entry.to === 'enterprise/env.json'),
      `the ${spec.variant} artifact must carry enterprise/envs/${spec.env}.json as enterprise/env.json`
    )
    assert.equal(config.productName, spec.display)
    assert.equal(config.dmg.title, `${spec.display} Installer`)
  }

  // An upstream variant carries no environment manifest at all.
  const bundled = packagingFor('bundled')
  assert.equal((bundled.extraResources ?? []).some(entry => entry.to === 'enterprise/env.json'), false)
})

test('the prod manifest matches the values the code defaults to', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(desktopRoot, 'enterprise/envs/prod.json'), 'utf8'))

  // Resolver defaults (electron/plankton-sso.ts: PLANKTON_SSO_DEFAULTS) — the
  // manifest must describe prod as the code already behaves, or the two would
  // silently disagree once a consumer reads the manifest.
  const sso = fs.readFileSync(path.join(desktopRoot, 'electron/plankton-sso.ts'), 'utf8')
  const defaultValue = (/** @type {string} */ key) => {
    const match = new RegExp(`${key}:\\s*'([^']+)'`).exec(sso)
    assert.ok(match, `plankton-sso.ts must still default ${key}`)
    return match[1]
  }
  assert.equal(manifest.sso.clientId, defaultValue('clientId'))
  assert.equal(manifest.sso.issuer, defaultValue('issuer'))
  assert.equal(manifest.sso.redirectUri, defaultValue('redirectUri'))

  // The keyless first-launch seed placeholder the pack script writes
  // (scripts/plankton-pack.sh) is prod's provider default.
  const pack = fs.readFileSync(path.join(desktopRoot, 'scripts/plankton-pack.sh'), 'utf8')
  const heredoc = /<<'JSON'\n([\s\S]*?)\nJSON\n/.exec(pack)
  assert.ok(heredoc, 'plankton-pack.sh must still write the keyless seed placeholder')
  const placeholder = JSON.parse(heredoc[1])
  assert.equal(manifest.model.provider, placeholder.provider)
  assert.equal(manifest.model.model, placeholder.model)
  assert.equal(manifest.model.base_url, placeholder.base_url)
})
