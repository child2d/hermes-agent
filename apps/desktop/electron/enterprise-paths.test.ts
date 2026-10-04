import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  ENTERPRISE_HOME_SEGMENTS,
  ENTERPRISE_WINDOWS_HOME_SEGMENTS,
  enterpriseHermesHomeFor
} from './enterprise-paths'

test('the enterprise identity resolves to the org home on posix', () => {
  assert.equal(
    enterpriseHermesHomeFor({ enterprise: true }, { home: '/Users/u', platform: 'darwin' }),
    '/Users/u/.plankton/engine/home'
  )
  assert.equal(
    enterpriseHermesHomeFor({ enterprise: true }, { home: '/home/u', platform: 'linux' }),
    '/home/u/.plankton/engine/home'
  )
})

test('a trailing slash on home does not double up', () => {
  assert.equal(
    enterpriseHermesHomeFor({ enterprise: true }, { home: '/Users/u/', platform: 'darwin' }),
    '/Users/u/.plankton/engine/home'
  )
})

test('the enterprise identity resolves to LOCALAPPDATA on windows', () => {
  assert.equal(
    enterpriseHermesHomeFor(
      { enterprise: true },
      { home: 'C:\\Users\\u', platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } }
    ),
    'C:\\Users\\u\\AppData\\Local\\plankton\\engine\\home'
  )
  // Falls back to <home>\AppData\Local when LOCALAPPDATA is absent.
  assert.equal(
    enterpriseHermesHomeFor({ enterprise: true }, { home: 'C:\\Users\\u', platform: 'win32', env: {} }),
    'C:\\Users\\u\\AppData\\Local\\plankton\\engine\\home'
  )
})

test('every non-enterprise identity keeps upstream behavior (null)', () => {
  for (const identity of [null, undefined, {}, { enterprise: false }]) {
    assert.equal(enterpriseHermesHomeFor(identity, { home: '/Users/u', platform: 'darwin' }), null)
    assert.equal(enterpriseHermesHomeFor(identity, { home: '/Users/u', platform: 'linux' }), null)
    assert.equal(enterpriseHermesHomeFor(identity, { home: 'C:\\Users\\u', platform: 'win32' }), null)
  }
})

test('the enterprise home never points at the personal .hermes', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const home = enterpriseHermesHomeFor({ enterprise: true }, { home: '/Users/u', platform })
    assert.ok(home && !home.includes('.hermes'))
    assert.ok(home.endsWith(ENTERPRISE_HOME_SEGMENTS.join('/')))
  }
  const windows = enterpriseHermesHomeFor(
    { enterprise: true },
    { home: 'C:\\Users\\u', platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' } }
  )
  assert.ok(windows && !windows.includes('.hermes'))
  assert.ok(windows.endsWith(ENTERPRISE_WINDOWS_HOME_SEGMENTS.join('\\')))
})
