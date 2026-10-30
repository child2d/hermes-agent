import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'vitest'

import { handoffReadmeFor } from './write-handoff-readme.mjs'

// The hand-off note is the only thing standing between a colleague and "已损坏" —
// it must carry THIS artifact's facts (sha256 above all) and the three commands
// that diagnose, fix and trace the Gatekeeper block.

function fixture(name = 'PlanktonTest-0.1.2-mac-arm64.dmg', bytes = 'not really a dmg') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-handoff-'))
  const artifact = path.join(root, name)
  fs.writeFileSync(artifact, bytes)

  return { root, artifact }
}

test('the note carries the artifact facts and the commands a colleague needs', () => {
  const { artifact } = fixture()
  const built = handoffReadmeFor({ artifactPath: artifact, env: 'test' })
  const expected = crypto.createHash('sha256').update('not really a dmg').digest('hex')

  assert.equal(built.sha256, expected, 'the sha256 is the artifact’s own')
  assert.match(built.markdown, new RegExp(expected), 'and it is what the reader verifies against')
  assert.match(built.markdown, /PlanktonTest-0\.1\.2-mac-arm64\.dmg/)
  assert.match(built.markdown, /0\.1\.2/)
  // Diagnose → fix → trace.
  assert.match(built.markdown, /xattr -p com\.apple\.quarantine/)
  assert.match(built.markdown, /xattr -dr com\.apple\.quarantine/)
  assert.match(built.markdown, /log show --last 5m/)
  assert.match(built.markdown, /hdiutil verify/)
  // Paths come from the environment table, not from a guess.
  assert.match(built.markdown, /~\/\.plankton\/test\/engine\/home/)
  assert.ok(built.markdown.includes('Application Support/PlanktonTest'), 'desktop state dir for test')
  assert.ok(!built.markdown.includes('undefined'), 'no template hole left in the note')
})

test('prod keeps the historical engine root (no environment segment)', () => {
  const { artifact } = fixture('Plankton-0.1.2-mac-arm64.dmg')
  const built = handoffReadmeFor({ artifactPath: artifact, env: 'prod' })

  assert.equal(built.envName, 'prod')
  assert.ok(built.markdown.includes('`~/.plankton/engine/home`'), 'prod engine home is the historical root')
  assert.ok(!built.markdown.includes('~/.plankton/prod/'), 'the prod segment flip has not happened yet')
})

test('an artifact under release/<env>/ selects the environment by itself', () => {
  const { artifact } = fixture()
  const nested = path.join(path.dirname(artifact), 'release', 'test')
  fs.mkdirSync(nested, { recursive: true })
  const moved = path.join(nested, path.basename(artifact))
  fs.renameSync(artifact, moved)

  const built = handoffReadmeFor({ artifactPath: moved })

  assert.equal(built.envName, 'test', 'release/test/ is the environment signal')
})
