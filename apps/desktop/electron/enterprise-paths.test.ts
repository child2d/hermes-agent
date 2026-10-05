import assert from 'node:assert/strict'

import { test } from 'vitest'

import {
  ENTERPRISE_HOME_SEGMENTS,
  ENTERPRISE_WINDOWS_HOME_SEGMENTS,
  enterpriseHermesHomeFor,
  enterpriseHomeIsolationIssue
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

// The isolation trap: the engine's get_default_hermes_root() treats any
// HERMES_HOME under the personal root as a PROFILE of that root and returns the
// personal root — so a home inside ~/.hermes silently reads/writes personal state.
test('a home outside the personal root is not flagged', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    for (const candidate of [
      '/Users/u/.plankton/engine/home',
      '/Users/u/plankton-verify/home',
      '/Users/u/.hermes-enterprise',
      '/Users/u/.hermesx'
    ]) {
      assert.equal(
        enterpriseHomeIsolationIssue(candidate, { home: '/Users/u', platform }),
        null,
        `${candidate} must not be flagged on ${platform}`
      )
    }
  }
})

test('a home inside (or equal to) the personal root is flagged', () => {
  for (const candidate of [
    '/Users/u/.hermes',
    '/Users/u/.hermes/enterprise',
    '/Users/u/.hermes/profiles/work',
    '/Users/u/.hermes/../.hermes/enterprise'
  ]) {
    assert.ok(
      enterpriseHomeIsolationIssue(candidate, { home: '/Users/u', platform: 'darwin' }),
      `${candidate} must be flagged`
    )
  }
})

test('the flagged message names both the home and the personal root', () => {
  const issue = enterpriseHomeIsolationIssue('/Users/u/.hermes/profiles/work', {
    home: '/Users/u',
    platform: 'darwin'
  })

  assert.ok(issue)
  assert.match(issue, /\.hermes\/profiles\/work/)
  assert.match(issue, /\.hermes/)
})

test('a HERMES_DATA_DIR_SUFFIX moves the personal root with it', () => {
  // ~/.hermes-canary is the personal root for a suffixed run, so a sibling
  // enterprise home under it is still a profiles-style fallback — flagged.
  assert.ok(
    enterpriseHomeIsolationIssue('/Users/u/.hermes-canary/enterprise', {
      home: '/Users/u',
      platform: 'darwin',
      env: { HERMES_DATA_DIR_SUFFIX: '-canary' }
    })
  )
  assert.equal(
    enterpriseHomeIsolationIssue('/Users/u/.hermes/enterprise', {
      home: '/Users/u',
      platform: 'darwin',
      env: { HERMES_DATA_DIR_SUFFIX: '-canary' }
    }),
    null
  )
})

test('windows comparison is case-insensitive', () => {
  // On Windows the personal root is %LOCALAPPDATA%\hermes; the drive-letter and
  // directory casing must not defeat the check.
  assert.ok(
    enterpriseHomeIsolationIssue('C:\\Users\\u\\AppData\\Local\\HERMES\\enterprise', {
      home: 'C:\\Users\\u',
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
    })
  )
  assert.equal(
    enterpriseHomeIsolationIssue('C:\\plankton\\engine\\home', {
      home: 'C:\\Users\\u',
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
    }),
    null
  )
})
