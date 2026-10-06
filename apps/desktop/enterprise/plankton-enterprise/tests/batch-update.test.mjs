/**
 * F3 counterexample — the batch-update aggregate must be HONEST.
 *
 * `summarizeBatchUpdate` is the pure fold the desktop half uses for the batch
 * update banner. Before the fix the component reported "批量更新完成（N 条）"
 * unconditionally: it only awaited the promises, ignoring both a resolved
 * `{ok:false}` (the backend answers 200 even when a write fails) and a rejected
 * request. This loads the REAL `plugin.js` (bare imports rewritten to stubs, so
 * no SDK/react runtime is needed) and checks the aggregation directly.
 *
 * Run (file, not directory — `node --test <dir>` fails to resolve):
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/batch-update.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..', 'desktop', 'plugin.js')

async function loadPlugin() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-plugin-'))
  const sdk = path.join(dir, 'sdk.mjs')
  const react = path.join(dir, 'react.mjs')
  const jsxrt = path.join(dir, 'jsx-runtime.mjs')
  fs.writeFileSync(
    sdk,
    'export const Button = () => null; export const ConfirmDialog = () => null; ' +
      'export const GlyphSpinner = () => null; export const SearchField = () => null; ' +
      'export const icons = { Info: () => null };\n'
  )
  fs.writeFileSync(react, 'export const useEffect = () => {}; export const useState = v => [v, () => {}];\n')
  fs.writeFileSync(jsxrt, 'export const jsx = () => null; export const jsxs = () => null;\n')

  const src = fs
    .readFileSync(PLUGIN, 'utf8')
    .replace("'@hermes/plugin-sdk'", JSON.stringify(pathToFileURL(sdk).href))
    .replace('"@hermes/plugin-sdk"', JSON.stringify(pathToFileURL(sdk).href))
    .replace("'react/jsx-runtime'", JSON.stringify(pathToFileURL(jsxrt).href))
    .replace("from 'react'", `from ${JSON.stringify(pathToFileURL(react).href)}`)
  const out = path.join(dir, 'plugin.mjs')
  fs.writeFileSync(out, src)
  return import(pathToFileURL(out).href)
}

test('a resolved {ok:false} in a batch is reported as a failure, never "完成"', async () => {
  const { summarizeBatchUpdate } = await loadPlugin()
  const summary = summarizeBatchUpdate([
    { skill: { name: 'a', installPath: 'cat/a' }, result: { ok: true } },
    { skill: { name: 'b', installPath: 'cat/b' }, result: { ok: false, kind: 'write-failed' } }
  ])
  assert.equal(summary.ok, false)
  assert.equal(summary.tone, 'error')
  assert.doesNotMatch(summary.text, /完成/)
  assert.match(summary.text, /成功 1 条、失败 1 条/)
  assert.match(summary.text, /b：写入企业侧技能目录失败（write-failed）/)
})

test('a local-edits failure in a batch is plain language, never a bare token', async () => {
  const { summarizeBatchUpdate } = await loadPlugin()
  const summary = summarizeBatchUpdate([
    { skill: { name: 'a' }, result: { ok: true } },
    { skill: { name: 'x' }, result: { ok: false, kind: 'local-edits' } }
  ])
  assert.equal(summary.ok, false)
  assert.match(summary.text, /本地已修改/)
  assert.match(summary.text, /需你确认覆盖/)
  assert.doesNotMatch(summary.text, /失败项：x（local-edits）/)
})

test('a rejected request is folded into the same honest banner', async () => {
  const { summarizeBatchUpdate } = await loadPlugin()
  const summary = summarizeBatchUpdate([
    { skill: { name: 'a' }, result: { ok: true } },
    { skill: { name: 'b' }, result: { ok: false, kind: 'request-failed' } }
  ])
  assert.equal(summary.ok, false)
  assert.match(summary.text, /request-failed/)
})

test('a fully successful batch still reports success', async () => {
  const { summarizeBatchUpdate } = await loadPlugin()
  const summary = summarizeBatchUpdate([
    { skill: { name: 'a' }, result: { ok: true } },
    { skill: { name: 'b' }, result: { ok: true } }
  ])
  assert.equal(summary.ok, true)
  assert.equal(summary.tone, 'ok')
  assert.match(summary.text, /批量更新完成（2 条）/)
})

// Q1: the update confirmation must SAY the local edits will be lost — a hash
// marker alone is not enough — and must flag the dialog destructive.

test('an update over local edits warns in plain language and is destructive', async () => {
  const { writeConfirmCopy } = await loadPlugin()
  const copy = writeConfirmCopy('update', { name: 'x', installPath: 'cat/x', hashState: 'mismatch' })
  assert.equal(copy.title, '更新技能「x」？')
  assert.equal(copy.destructive, true)
  assert.match(copy.description, /本地已修改/)
  assert.match(copy.description, /会覆盖并丢失这些本地改动/)
})

test('the backend localEdits fact alone also turns the warning on', async () => {
  const { writeConfirmCopy } = await loadPlugin()
  assert.equal(writeConfirmCopy('update', { name: 'x', localEdits: true }).destructive, true)
})

test('an untouched update carries no overwrite warning', async () => {
  const { writeConfirmCopy } = await loadPlugin()
  const copy = writeConfirmCopy('update', { name: 'x', installPath: 'x', hashState: 'match' })
  assert.equal(copy.destructive, false)
  assert.doesNotMatch(copy.description, /本地已修改/)
})

// P1: when the engine record cannot settle whether the landing was edited, the
// dialog must say exactly that — "已修改" would be a claim nobody can make.
test('a cannot-decide local-edit state warns in plain language and is destructive', async () => {
  const { writeConfirmCopy } = await loadPlugin()
  const copy = writeConfirmCopy('update', { name: 'x', installPath: 'x', localEditsUnknown: true })
  assert.equal(copy.destructive, true)
  assert.equal(copy.localEditsUnknown, true)
  assert.match(copy.description, /无法判定本地是否有改动/)
  assert.doesNotMatch(copy.description, /本地已修改/)
})

test('a confirmed local edit still wins over the cannot-decide wording', async () => {
  const { writeConfirmCopy } = await loadPlugin()
  const copy = writeConfirmCopy('update', { name: 'x', localEdits: true, localEditsUnknown: true })
  assert.match(copy.description, /本地已修改/)
  assert.doesNotMatch(copy.description, /无法判定/)
})

// F-1: the manage buttons are gated on the ENGINE's RECORD, never on the
// displayed version state. Gating them on `installState !== 'version-unknown'`
// left uninstall/disable permanently disabled for real installs.
test('manage actions follow the engine record, not the displayed version state', async () => {
  const { canManageSkill } = await loadPlugin()
  // A real install whose version could not be compared: still manageable.
  assert.equal(canManageSkill({ installState: 'version-unknown', ownedByEngine: true }), true)
  assert.equal(canManageSkill({ installState: 'consistent', ownedByEngine: true }), true)
  assert.equal(canManageSkill({ installState: 'version-differs', ownedByEngine: true }), true)
  assert.equal(canManageSkill({ installState: 'disabled', ownedByEngine: true }), true)
  // Nothing installed here → no manage action.
  assert.equal(canManageSkill({ installState: 'not-installed', ownedByEngine: false }), false)
  assert.equal(canManageSkill({ installState: 'name-missing', ownedByEngine: false }), false)
  // Content at the landing that no record of ours claims → uninstall would be
  // a no-record failure, so it is not offered.
  assert.equal(canManageSkill({ installState: 'version-unknown', ownedByEngine: false }), false)
})

// F-1/F-3: the batch entry only carries items whose local-edit status is
// CONFIRMED clean (the batch has no per-item overwrite acknowledgement).
test('only confirmed-clean skills ride the batch update', async () => {
  const { canBatchUpdate } = await loadPlugin()
  assert.equal(canBatchUpdate({ installState: 'version-differs' }), true)
  assert.equal(canBatchUpdate({ installState: 'version-differs', localEdits: false, localEditsUnknown: false }), true)
  // A confirmed edit would deterministically fail; a cannot-decide could silently
  // replace the user's work. Both go the individual route.
  assert.equal(canBatchUpdate({ installState: 'version-differs', localEdits: true }), false)
  assert.equal(canBatchUpdate({ installState: 'version-differs', localEditsUnknown: true }), false)
  assert.equal(canBatchUpdate({ installState: 'consistent' }), false)
  assert.equal(canBatchUpdate({ installState: 'not-installed' }), false)
})

// F-3: when the engine's record names a DIFFERENT landing than the write plans
// to use, the dialog must say so — the refusal is about a directory the user
// cannot otherwise see.
test('a record landing that differs from the plan is named in the dialog', async () => {
  const { writeConfirmCopy } = await loadPlugin()
  const copy = writeConfirmCopy('update', {
    name: 'x',
    installPath: 'x',
    recordInstallPath: 'legacy/x',
    localEdits: true
  })
  assert.match(copy.description, /本地已修改/)
  assert.match(copy.description, /落点是 legacy\/x/)
  assert.equal(copy.destructive, true)
  // Same plan and record landing → no noise.
  const same = writeConfirmCopy('update', { name: 'x', installPath: 'x', recordInstallPath: 'x' })
  assert.doesNotMatch(same.description, /落点是/)
})

// F-2/F-3: the acknowledgement the confirm button actually SENDS. Without it the
// backend refuses with `local-edits` — a refusal nobody could answer is a dead
// end, so the payload is asserted here rather than assumed.
test('the confirm payload acknowledges every not-confirmed-clean landing', async () => {
  const { overwriteLocalEditsFor } = await loadPlugin()
  // Confirmed drift…
  assert.equal(overwriteLocalEditsFor({ localEdits: true }), true)
  // …the page-side mismatch signal…
  assert.equal(overwriteLocalEditsFor({ hashState: 'mismatch' }), true)
  // …"cannot decide" (no record at the landing / record without a hash)…
  assert.equal(overwriteLocalEditsFor({ localEditsUnknown: true }), true)
  // …and a plain, confirmed-clean write needs no acknowledgement.
  assert.equal(overwriteLocalEditsFor({ hashState: 'match' }), false)
  assert.equal(overwriteLocalEditsFor({}), false)
})

// The write-path self-check must be VISIBLE on the page: a failing verdict
// (redirected skill root / redirected or non-regular install record) refuses all
// writes at the backend, so the read page may never render it as silence.
test('a failing write-path self-check is stated loudly, and a passing one is silent', async () => {
  const { writeGuardNotice } = await loadPlugin()

  // Passing (or absent) → no noise at all.
  assert.equal(writeGuardNotice({ ok: true }), null)
  assert.equal(writeGuardNotice(null), null)
  assert.equal(writeGuardNotice(undefined), null)

  const notice = writeGuardNotice({
    ok: false,
    findings: [
      { check: 'symlink-in-path-chain', layer: 'skills-root', path: '/h/skills', message: '技能根目录本身是符号链接，指向 /outside' },
      { check: 'record-is-symlink', layer: 'install-record', path: '/h/skills/.hub/lock.json', message: '引擎取用记录是一个符号链接' }
    ]
  })

  assert.match(notice, /fail-closed/)
  assert.match(notice, /拒绝全部写动作/)
  assert.match(notice, /列表与状态仍可读/)
  // Every finding is named, with its check id and its layer.
  assert.match(notice, /symlink-in-path-chain/)
  assert.match(notice, /skills-root/)
  assert.match(notice, /record-is-symlink/)
  assert.match(notice, /install-record/)
  // A malware-shaped empty findings list must still not read as "fine".
  assert.match(writeGuardNotice({ ok: false, findings: [] }), /拒绝全部写动作/)
})
