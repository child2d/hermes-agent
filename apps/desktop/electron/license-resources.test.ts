import assert from 'node:assert/strict'
import { createRequire } from 'node:module'

import { afterEach, test } from 'vitest'

// The enterprise distribution must carry the upstream MIT license and a third-party notice,
// emitted by the build (extraResources), never copied into the .app by hand. Gated to the
// plankton variant so every upstream artifact's Resources stay byte-for-byte unchanged.

const require: NodeJS.Require = createRequire(import.meta.url)

interface ResourceEntry {
  from: string
  to: string
}

const CONFIG_FILES = ['../product-identity.cjs', '../electron-builder.config.cjs'] as const

function loadResources(variant: string | undefined): ResourceEntry[] {
  if (variant === undefined) {
    delete process.env.HERMES_DESKTOP_VARIANT
  } else {
    process.env.HERMES_DESKTOP_VARIANT = variant
  }

  for (const file of CONFIG_FILES) {
    delete require.cache[require.resolve(file)]
  }

  return require('../electron-builder.config.cjs').extraResources as ResourceEntry[]
}

afterEach((): void => {
  delete process.env.HERMES_DESKTOP_VARIANT

  for (const file of CONFIG_FILES) {
    delete require.cache[require.resolve(file)]
  }
})

test('the enterprise artifact ships the upstream LICENSE and the third-party notice', (): void => {
  const resources = loadResources('plankton')
  const byTarget = new Map(resources.map(entry => [entry.to, entry.from]))

  assert.ok(byTarget.has('LICENSE'), 'LICENSE must be packaged into Resources')
  assert.ok(byTarget.has('THIRD-PARTY-NOTICES.md'), 'the third-party notice must be packaged')
  // The license is the repository-root, unmodified upstream file, not a fork-local copy.
  assert.ok(byTarget.get('LICENSE')!.endsWith('LICENSE'), byTarget.get('LICENSE'))
})

test('no upstream variant gains the enterprise license resources', (): void => {
  for (const variant of [undefined, 'bundled', 'store', 'light'] as const) {
    const targets = loadResources(variant).map(entry => entry.to)
    assert.ok(!targets.includes('LICENSE'), `variant ${variant} must not add LICENSE`)
    assert.ok(!targets.includes('THIRD-PARTY-NOTICES.md'), `variant ${variant} must not add the notice`)
  }
})
