import assert from 'node:assert/strict'

import { test } from 'vitest'

import { resolveDesktopHermesHome } from './data-paths'
import {
  ENTERPRISE_HOME_SEGMENTS,
  ENTERPRISE_WINDOWS_HOME_SEGMENTS,
  enterpriseHermesHomeFor,
  enterpriseHomeIsolationIssue,
  enterpriseHomeSelection
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

// --- startup contract: the home the enterprise app actually uses -------------
//
// These compose the REAL startup chain (resolveDesktopHermesHome with the
// enterprise default, then enterpriseHomeSelection) rather than asserting on
// source strings, so they pin the behavior a launched artifact shows.

/** The home main.ts would use, plus whether an ambient personal root was discarded. */
function startupHome(
  env: Record<string, string | undefined>,
  options: { home?: string; platform?: NodeJS.Platform; enterprise?: boolean } = {}
): { home: string; discarded: string | null; isolationIssue: string | null } {
  const home = options.home ?? '/Users/u'
  const platform = options.platform ?? 'darwin'
  const identity = { enterprise: options.enterprise ?? true }
  const enterpriseDefault = enterpriseHermesHomeFor(identity, { home, platform, env })
  const requestedHome = resolveDesktopHermesHome({
    home,
    env,
    platform,
    directoryExists: () => false,
    readWindowsHome: () => null,
    defaultHome: enterpriseDefault
  })
  const selection = enterpriseHomeSelection({
    identity,
    requestedHome,
    enterpriseDefault,
    home,
    platform,
    env
  })
  return {
    home: selection.home,
    discarded: selection.discardedAmbientPersonalRoot,
    isolationIssue: enterpriseHomeIsolationIssue(selection.home, { home, platform, env })
  }
}

test('no home env at all lands on the enterprise default (the real user path)', () => {
  for (const platform of ['darwin', 'linux'] as const) {
    const got = startupHome({}, { home: '/Users/u', platform })
    assert.equal(got.home, '/Users/u/.plankton/engine/home')
    assert.equal(got.discarded, null)
    assert.equal(got.isolationIssue, null)
  }
})

test('an inherited HERMES_HOME of the personal root is discarded, not obeyed', () => {
  // This is the ambient value a Hermes CLI shell / the Hermes desktop app
  // exports to its children; a double-clicked artifact inherits it.
  const got = startupHome({ HERMES_HOME: '/Users/u/.hermes' })
  assert.equal(got.discarded, '/Users/u/.hermes')
  assert.equal(got.home, '/Users/u/.plankton/engine/home')
  assert.equal(got.isolationIssue, null)
})

test('an inherited personal root is discarded under a HERMES_DATA_DIR_SUFFIX run', () => {
  const got = startupHome({ HERMES_HOME: '/Users/u/.hermes', HERMES_DATA_DIR_SUFFIX: '-canary' })
  assert.equal(got.discarded, '/Users/u/.hermes')
  assert.equal(got.home, '/Users/u/.plankton/engine/home')
})

test('a home INSIDE the personal root is kept, so the isolation check fail-closes', () => {
  const got = startupHome({ HERMES_HOME: '/Users/u/.hermes/enterprise' })
  assert.equal(got.discarded, null)
  assert.equal(got.home, '/Users/u/.hermes/enterprise')
  assert.ok(got.isolationIssue)
})

test('a profiles-rooted personal home normalizes to the personal root, so it is discarded', () => {
  // resolveDesktopHermesHome's upstream profile normalization collapses
  // ~/.hermes/profiles/<name> to ~/.hermes — the personal root exactly — so the
  // ambient-personal-root rule applies and the enterprise default wins.
  const got = startupHome({ HERMES_HOME: '/Users/u/.hermes/profiles/work' })
  assert.equal(got.discarded, '/Users/u/.hermes')
  assert.equal(got.home, '/Users/u/.plankton/engine/home')
  assert.equal(got.isolationIssue, null)
})

test('a legitimate explicit override still wins', () => {
  const got = startupHome({ HERMES_HOME: '/Users/u/plankton-verify/home' })
  assert.equal(got.home, '/Users/u/plankton-verify/home')
  assert.equal(got.discarded, null)
  assert.equal(got.isolationIssue, null)
})

test('a HERMES_DESKTOP_USER_DATA_DIR rehearsal is untouched', () => {
  const got = startupHome({ HERMES_DESKTOP_USER_DATA_DIR: '/tmp/rehearsal' })
  assert.equal(got.home, '/tmp/rehearsal/hermes-home')
  assert.equal(got.discarded, null)
  assert.equal(got.isolationIssue, null)
})

test('upstream variants keep bit-for-bit resolution (no selection happens)', () => {
  for (const enterprise of [false]) {
    const got = startupHome({}, { enterprise })
    assert.equal(got.home, '/Users/u/.hermes')
    assert.equal(got.discarded, null)
    // Upstream variants run no enterprise selection at all: an explicit
    // HERMES_HOME is returned verbatim, and no isolation check exists.
    const withEnv = startupHome({ HERMES_HOME: '/Users/u/.hermes-work' }, { enterprise })
    assert.equal(withEnv.home, '/Users/u/.hermes-work')
    assert.equal(withEnv.discarded, null)
  }
})

test('windows: an inherited %LOCALAPPDATA%\\hermes is discarded too', () => {
  const env = { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local', HERMES_HOME: 'C:\\Users\\u\\AppData\\Local\\hermes' }
  const got = startupHome(env, { home: 'C:\\Users\\u', platform: 'win32' })
  assert.equal(got.discarded, 'C:\\Users\\u\\AppData\\Local\\hermes')
  assert.equal(got.home, 'C:\\Users\\u\\AppData\\Local\\plankton\\engine\\home')
  assert.equal(got.isolationIssue, null)
})
