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
