/**
 * W3 · action execution — semantics of the re-homed `pack-exec` + `pack-actions`.
 *
 * Design: docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
 * §8 (W3 = pack-actions + pack-exec), §5 (write path) / §5.5 (executor) /
 * 裁定 4 (写动作落实到人) / §9.0 #6 (the measured write-side facts), accepted by
 * "语义等价、换载体" (裁定 5). The old shell baseline is read-only
 * (~/Repository/shaoke/codeup/plankton @ e305ce1, electron/{pack-exec,pack-actions}.js).
 *
 * What this file PINS (each is a hard boundary in the parent task):
 *   * EXEC_KINDS has ONE definition (the packExec module); the pre-W3 inline copy
 *     is gone — a source-level check keeps it gone.
 *   * 落实到人 — write refuses with no injected identity, and refuses a
 *     system/anonymous identity; the confirmer is never a caller argument.
 *   * 一律经 shaoke-cli — the executor's only spawn is `[module, command, ...argv]`
 *     (array args, shell:false); with no spawner wired it REFUSES (no silent run).
 *   * `ok:true` 不可单独作成功依据 — a write is `written` only after a declared
 *     READ-BACK confirms; unconfirmed ⇒ `write-unknown`.
 *   * 无删除 — a delete-shaped command is refused by BOTH layers.
 *
 * Every declaration/fixture is SYNTHETIC. No enterprise data is read or written.
 *
 * Run (a FILE, not a dir):
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-w3-exec-actions.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..', 'desktop', 'plugin.js')
const SOURCE = fs.readFileSync(PLUGIN, 'utf8')

async function loadPlugin(source = SOURCE) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-w3-'))
  const sdk = path.join(dir, 'sdk.mjs')
  const react = path.join(dir, 'react.mjs')
  const jsxrt = path.join(dir, 'jsx-runtime.mjs')
  fs.writeFileSync(sdk, 'export const Button=()=>null;export const ConfirmDialog=()=>null;export const GlyphSpinner=()=>null;export const SearchField=()=>null;export const icons={Info:()=>null};\n')
  fs.writeFileSync(react, 'export const useEffect=()=>{};export const useState=v=>[v,()=>{}];\n')
  fs.writeFileSync(jsxrt, 'export const jsx=()=>null;export const jsxs=()=>null;\n')
  const src = source
    .replace("'@hermes/plugin-sdk'", JSON.stringify(pathToFileURL(sdk).href))
    .replace('"@hermes/plugin-sdk"', JSON.stringify(pathToFileURL(sdk).href))
    .replace("'react/jsx-runtime'", JSON.stringify(pathToFileURL(jsxrt).href))
    .replace("from 'react'", `from ${JSON.stringify(pathToFileURL(react).href)}`)
  const out = path.join(dir, 'plugin.mjs')
  fs.writeFileSync(out, src)
  return import(pathToFileURL(out).href)
}

const M = await loadPlugin()

// ── synthetic pack declaration ───────────────────────────────────────────────

/** A complete synthetic declaration (all 15 contract items) usable by W3. */
function demo(overrides = {}) {
  return {
    id: 'demo',
    displayName: 'Demo pack',
    discriminant: 'the envelope ok flag',
    failureMap: {
      ok: 'written', rejected: 'failed', refused: 'blocked',
      unparsed: 'write-unknown', timeout: 'write-unknown', 'spawn-error': 'write-unknown',
    },
    requiredParams: {
      '+item-create': ['--project-id', '--title'],
      '+item-delete': ['--id'],
      '+item-get': ['--project-id', '--id'],
      '+project-list': [],
    },
    destructiveParams: [{ name: 'parent-id', semantics: 'reparent' }],
    valueLookup: {
      'project-id': { template: 'project-list', labelField: 'name', valueField: 'id' },
      id: { readback: 'by key' },
      'parent-id': { derived: 'step' },
    },
    steps: [{ id: 'create-parent', then: 'create-child' }],
    lookupFields: { title: { exists: 'by key' } },
    outputParsing: { envelope: 'ok', itemsPath: 'data.data', totalPath: 'data.total' },
    fieldTiers: { title: 'agent-drafted', 'project-id': 'user-designated', 'parent-id': 'user-designated', id: 'user-designated' },
    landing: { module: 'demo', assemblyPoint: 'demo', note: 'synthetic' },
    skill: ['demo'],
    broadcastPredicate: () => ({ hasContent: false }),
    templates: [
      {
        id: 'item-create', kind: 'write', module: 'demo', command: '+item-create',
        required: ['project-id', 'title'], optional: ['parent-id'],
        args: ['--project-id', { field: 'project-id' }, '--title', { field: 'title' },
          { when: 'parent-id', args: ['--parent-id', { field: 'parent-id' }] }],
        refPath: 'data.issueKey',
        readback: {
          template: 'item-get', idFrom: 'data.id', scope: ['project-id'],
          check: [{ field: 'title', read: 'title' }, { field: 'parent-id', read: 'parentId' }],
        },
      },
      { id: 'item-delete', kind: 'write', module: 'demo', command: '+item-delete', required: ['id'], optional: [], args: ['--id', { field: 'id' }], refPath: 'data.id' },
      { id: 'item-get', kind: 'read', module: 'demo', command: '+item-get', required: ['project-id', 'id'], optional: [], shape: 'object', args: ['--project-id', { field: 'project-id' }, '--id', { field: 'id' }] },
      { id: 'project-list', kind: 'read', module: 'demo', command: '+project-list', required: [], optional: [], shape: 'paged', itemsPath: 'data.data', totalPath: 'data.total', args: [] },
    ],
    requiredBeyondCli: {},
    outputs: {
      fields: {
        title: { label: '标题', role: 'title' },
        'project-id': { label: '项目', role: '' },
        'parent-id': { label: '上级', role: '' },
        id: { label: 'id', role: '' },
      },
      actions: {
        'confirm-create': { label: '确认新建', human: 'confirm', writes: 'item-create' },
        'confirm-delete': { label: '删除', human: 'confirm', writes: 'item-delete' },
        discard: { label: '丢草稿', human: 'discard' },
        refresh: { label: '刷新', human: 'progress', reads: 'item-get' },
      },
      blocks: [
        { tag: 'demo-new', record: 'single', fields: ['title', 'project-id'], actions: ['confirm-create', 'discard'] },
        { tag: 'demo-plan', record: 'collection', fields: ['title'], actions: ['refresh'] },
      ],
    },
    skillDoc: { fileName: 'SKILL.md', markdown: '# demo' },
    ...overrides,
  }
}

const registryWith = (declaration) => {
  const registry = M.createPackRegistry()
  const result = registry.register(declaration)
  assert.equal(result.ok, true, `fixture declaration must load: ${JSON.stringify(result)}`)
  return registry
}

function cardFor({ state = 'confirmed', by = '陈涛', title = '写一份东西', parentId = '' } = {}) {
  const fields = [
    { key: 'title', label: '标题', value: title, tier: 'agent-drafted', source: 'agent' },
    { key: 'project-id', label: '项目', value: '1', tier: 'user-designated', source: 'human', attestation: { kind: 'lookup', field: 'project-id' } },
  ]
  if (parentId !== '') fields.push({ key: 'parent-id', label: '上级', value: parentId, tier: 'user-designated', source: 'human', attestation: /** @type {any} */ ({ kind: 'derived', from: 'step', source: 'create-parent' }) })
  return { id: 'demo-new:abc', title: 'Demo card', state, confirmedBy: by, fields }
}

function fakeSession(card) {
  let current = card
  return {
    get: () => current,
    replace: (next) => { current = next; return { ok: true, card: next } },
    confirm: (id, { by }) => { current = { ...current, state: 'confirmed', confirmedBy: by }; return { ok: true, card: current } },
    reopen: () => { current = { ...current, state: 'draft' }; return { ok: true, card: current } },
    discard: () => { current = { ...current, state: 'discarded' }; return { ok: true, card: current } },
    presentations: () => [current],
    current: () => current,
  }
}

/** A fake executor (no spawn, no I/O). `write`/`read` can be overridden per test. */
function fakeExecutor(over = {}) {
  const calls = []
  return {
    calls,
    async runRead(req) {
      calls.push(['read', req.templateId, req.params])
      if (over.read) return over.read(req)
      if (req.templateId === 'project-list') {
        return { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '1', name: 'P1' }], total: 1 } } }
      }
      if (req.templateId === 'item-get') {
        return { kind: 'ok', envelope: { ok: true, data: { id: '99', issueKey: 'D-99', title: '写一份东西', parentId: '7' } } }
      }
      return { kind: 'unparsed', note: 'fake' }
    },
    async runTemplate(req) {
      calls.push(['write', req.templateId])
      if (over.write) return over.write(req)
      return { kind: 'ok', ref: 'D-99', envelope: { ok: true, data: { id: '99', issueKey: 'D-99', title: '写一份东西' } } }
    },
  }
}

// ── 1 · EXEC_KINDS single source (the pre-W3 lock is resolved) ───────────────

test('EXEC_KINDS: exactly one definition, sourced from the packExec module', () => {
  assert.deepEqual([...M.EXEC_KINDS], ['ok', 'rejected', 'unparsed', 'timeout', 'spawn-error', 'refused'])
  assert.equal(M.EXEC_KINDS, M.packExec.EXEC_KINDS, 'top-level EXEC_KINDS must BE the module constant')
  assert.equal(SOURCE.includes('PACK_EXEC_SCOPE'), false, 'the pre-W3 inline copy must be gone')
  // exactly one assignment site
  const defs = SOURCE.match(/const EXEC_KINDS = Object\.freeze\(/g) ?? []
  assert.equal(defs.length, 1, 'EXEC_KINDS must be defined exactly once')
})

test('the baymax action set / templates carry no delete command (命令面无删除)', () => {
  const D = M.BAYMAX_DECLARATION
  const commands = D.templates.map((t) => t.command)
  for (const command of commands) assert.equal(M.packExec.isDeleteCommand(command), false, `${command} must not be delete-shaped`)
  assert.equal(M.packExec.isDeleteCommand('+issue-delete'), true)
  assert.equal(M.packExec.isDeleteCommand('delete'), true)
  // and the executor refuses it (below) — so the action set can never reach a delete.
})

// ── 2 · resolveTemplate (the ONLY argv builder) ──────────────────────────────

test('resolveTemplate: delete command is refused (动作集不得提供删除)', () => {
  const verdict = M.packExec.resolveTemplate(demo(), 'item-delete', { id: '5' })
  assert.equal(verdict.ok, false)
  assert.equal(verdict.refusal, 'command-forbidden-delete')
})

test('resolveTemplate: argv is built as an ARRAY, no free text, optional groups skipped whole', () => {
  const ok = M.packExec.resolveTemplate(demo(), 'item-create', { 'project-id': '1', title: 'T', 'parent-id': '' })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.argv, ['--project-id', '1', '--title', 'T']) // empty optional produces no dangling flag
  const withParent = M.packExec.resolveTemplate(demo(), 'item-create', { 'project-id': '1', title: 'T', 'parent-id': '9' })
  assert.deepEqual(withParent.argv, ['--project-id', '1', '--title', 'T', '--parent-id', '9'])
  assert.deepEqual(withParent.destructiveTouched, ['parent-id'])
})

test('resolveTemplate: unknown template / undeclared command / missing required are refused', () => {
  assert.equal(M.packExec.resolveTemplate(demo(), 'nope', {}).refusal, 'unknown-template')
  assert.equal(M.packExec.resolveTemplate({ ...demo(), templates: [{ id: 'x', kind: 'write', module: 'demo', command: '+nope', args: [] }] }, 'x', {}).refusal, 'command-not-declared')
  const missing = M.packExec.resolveTemplate(demo(), 'item-create', { 'project-id': '1' })
  assert.equal(missing.refusal, 'missing-required-param')
  assert.deepEqual(missing.fields, ['title'])
})

test('buildArgs: a field reference outside the template declaration is refused', () => {
  const verdict = M.packExec.buildArgs([{ field: 'secret' }], { fields: new Set(['title']), params: { secret: 'x' }, argv: [] })
  assert.equal(verdict.refusal, 'template-arg-not-declared:secret')
})

// ── 3 · the executor (single spawn point) ────────────────────────────────────

test('executor refuses to run with NO spawner wired (fail-closed, no silent no-op)', async () => {
  const registry = registryWith(demo())
  const executor = M.createPackExecutor({ registry, cliPath: '' })
  assert.equal(executor.spawnable, false)
  const res = await executor.runTemplate({ packId: 'demo', templateId: 'item-create', card: cardFor() })
  assert.equal(res.kind, 'refused')
  assert.equal(res.refusal, 'spawner-missing')
})

test('executor: 落实到人 — no confirmer and a system identity are both refused', async () => {
  const registry = registryWith(demo())
  const spawns = []
  const executor = M.createPackExecutor({ registry, cliPath: '/fake/shaoke-cli', execFileImpl: (file, args, opts, cb) => { spawns.push([file, args, opts]); cb(null, '{"ok":true,"data":{"issueKey":"D-1","id":"1"}}', '') } })
  const noBy = await executor.runTemplate({ packId: 'demo', templateId: 'item-create', card: cardFor({ by: '' }) })
  assert.equal(noBy.refusal, 'confirmer-missing')
  const sysBy = await executor.runTemplate({ packId: 'demo', templateId: 'item-create', card: cardFor({ by: 'system' }) })
  assert.equal(sysBy.refusal, 'system-identity')
  assert.equal(spawns.length, 0, 'nothing may be spawned when the confirmer is not a concrete person')
})

test('executor: an unconfirmed card is refused (未确认不得写)', async () => {
  const registry = registryWith(demo())
  const executor = M.createPackExecutor({ registry, cliPath: '/fake/shaoke-cli', execFileImpl: () => { throw new Error('must not spawn') } })
  const res = await executor.runTemplate({ packId: 'demo', templateId: 'item-create', card: cardFor({ state: 'draft' }) })
  assert.equal(res.refusal, 'card-not-confirmed')
})

test('executor: spawns `[module, command, ...argv]` with shell:false; envelope ok ⇒ ok with ref', async () => {
  const registry = registryWith(demo())
  const seen = []
  const executor = M.createPackExecutor({
    registry,
    cliPath: '/fake/shaoke-cli',
    execFileImpl: (file, args, opts, cb) => { seen.push({ file, args, opts }); cb(null, '{"ok":true,"data":{"issueKey":"D-9","id":"9"}}', '') },
  })
  const res = await executor.runTemplate({ packId: 'demo', templateId: 'item-create', card: cardFor() })
  assert.equal(res.kind, 'ok')
  assert.equal(res.ref, 'D-9')
  assert.equal(seen.length, 1)
  assert.equal(seen[0].file, '/fake/shaoke-cli')
  assert.deepEqual(seen[0].args, ['demo', '+item-create', '--project-id', '1', '--title', '写一份东西'])
  assert.equal(seen[0].opts.shell, false)
})

test('executor: the envelope is found inside stderr noise; a missing ok ⇒ unparsed, rc≠0 ⇒ spawn-error', async () => {
  const registry = registryWith(demo())
  const withNoise = M.createPackExecutor({
    registry, cliPath: '/fake',
    execFileImpl: (f, a, o, cb) => cb(null, '', 'upgrade available\n{"error":{"type":"validation","message":"bad"},"ok":false}\n'),
  })
  const rejected = await withNoise.runTemplate({ packId: 'demo', templateId: 'item-create', card: cardFor() })
  assert.equal(rejected.kind, 'rejected')
  assert.equal(rejected.error.message, 'bad')

  const unparsed = M.createPackExecutor({ registry, cliPath: '/fake', execFileImpl: (f, a, o, cb) => cb(null, 'not json at all', '') })
  assert.equal((await unparsed.runTemplate({ packId: 'demo', templateId: 'item-create', card: cardFor() })).kind, 'unparsed')

  const spawnError = M.createPackExecutor({ registry, cliPath: '/fake', execFileImpl: (f, a, o, cb) => { const e = /** @type {any} */ (new Error('boom')); e.code = 3; cb(e, '', 'no envelope') } })
  assert.equal((await spawnError.runTemplate({ packId: 'demo', templateId: 'item-create', card: cardFor() })).kind, 'spawn-error')
})

test('executor: runRead refuses a write template (把写伪装成取数 走不通)', async () => {
  const registry = registryWith(demo())
  const executor = M.createPackExecutor({ registry, cliPath: '/fake', execFileImpl: () => { throw new Error('must not spawn') } })
  const res = await executor.runRead({ packId: 'demo', templateId: 'item-create', params: { 'project-id': '1', title: 'T' } })
  assert.equal(res.refusal, 'read-path-cannot-use-write-template')
})

test('findEnvelope / pickRef: whole-document first, then last parseable line; no invented ref', () => {
  assert.deepEqual(M.packExec.pickRef({ data: { id: '1' } }, 'data.id'), '1')
  assert.equal(M.packExec.pickRef({ data: {} }, 'data.id'), null)
  assert.equal(M.packExec.findEnvelope('noise\n{"ok":true}\n').ok, true)
})

// ── 4 · identity normalization (到人 / 服务端铸发) ───────────────────────────

test('normalizeIdentity: a whoami shape resolves; null / system / anonymous resolve to ""', () => {
  assert.equal(M.normalizeIdentity({ whoami: { subject: '5', displayName: '陈涛', email: 'x@y' } }), '陈涛')
  assert.equal(M.normalizeIdentity({ subject: '5', email: 'x@y' }), 'x@y')
  assert.equal(M.normalizeIdentity('  陈涛  '), '陈涛')
  assert.equal(M.normalizeIdentity(null), '')
  assert.equal(M.normalizeIdentity({}), '')
  assert.equal(M.packExec.isSystemIdentity('system'), true)
  assert.equal(M.packExec.isSystemIdentity('Anonymous'), true)
  assert.equal(M.packExec.isSystemIdentity('陈涛'), false)
})

// ── 5 · verifyReadback (ok 不可单独作成功依据) ───────────────────────────────

test('verifyReadback: not declared ⇒ fail-closed; read template must be a declared read', async () => {
  const declaration = demo()
  const pack = { id: 'demo', declaration }
  const noSpec = await M.verifyReadback({ pack, card: cardFor(), template: { id: 'x' }, envelope: { ok: true }, executor: fakeExecutor() })
  assert.equal(noSpec.reason, 'readback-not-declared')
  const toWrite = await M.verifyReadback({ pack, card: cardFor(), template: { id: 'x', readback: { template: 'item-create' } }, envelope: { ok: true }, executor: fakeExecutor() })
  assert.equal(toWrite.reason, 'readback-not-a-read-template')
})

test('verifyReadback: confirmed on match; mismatch / read failure are NOT success', async () => {
  const pack = { id: 'demo', declaration: demo() }
  const template = demo().templates.find((t) => t.id === 'item-create')
  const ok = await M.verifyReadback({ pack, card: cardFor(), template, envelope: { ok: true, data: { id: '99' } }, executor: fakeExecutor() })
  assert.equal(ok.ok, true)
  assert.deepEqual(ok.checked, ['title'])

  const mismatch = await M.verifyReadback({ pack, card: cardFor({ title: '别的东西' }), template, envelope: { ok: true, data: { id: '99' } }, executor: fakeExecutor() })
  assert.equal(mismatch.ok, false)
  assert.equal(mismatch.reason, 'readback-mismatch:title')

  const readFailed = await M.verifyReadback({ pack, card: cardFor(), template, envelope: { ok: true, data: { id: '99' } }, executor: fakeExecutor({ read: () => ({ kind: 'unparsed' }) }) })
  assert.equal(readFailed.reason, 'readback-read-failed')
})

// ── 6 · pack-actions end to end (fake session + fake executor) ───────────────

function runAction({ declaration = demo(), card = cardFor(), identityOf, executor = fakeExecutor() } = /** @type {any} */ ({})) {
  const registry = registryWith(declaration)
  const session = fakeSession(card)
  const actions = M.createPackActions({ registry, executor, session, identityOf: identityOf ?? (() => ({ whoami: { displayName: '陈涛' } })) })
  return { actions, session, executor }
}

test('actions: no server-issued identity ⇒ not-signed-in (fail-closed, nothing spawned)', async () => {
  const { actions, executor } = runAction({ identityOf: () => null })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'not-signed-in')
  assert.deepEqual(executor.calls, [], 'no read and no write may happen without an identity')
})

test('actions: a system identity is refused', async () => {
  const { actions } = runAction({ identityOf: () => 'system' })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
  assert.equal(res.reason, 'system-identity')
})

test('actions: ok + ref + readback confirmed ⇒ written (and it really read back)', async () => {
  const { actions, session, executor } = runAction()
  const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
  assert.equal(res.ok, true)
  assert.equal(res.readback.ok, true)
  assert.equal(session.current().state, 'written')
  assert.equal(session.current().ref, 'D-99')
  const readIds = executor.calls.filter((c) => c[0] === 'read').map((c) => c[1])
  assert.ok(readIds.includes('item-get'), 'a real read-back must have happened')
})

test('actions: ok + ref but NO readback declared ⇒ write-unknown (ok alone is not success)', async () => {
  const noReadback = demo({
    templates: demo().templates.map((t) => (t.id === 'item-create' ? { ...t, readback: undefined } : t)),
  })
  const { actions, session } = runAction({ declaration: noReadback })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
  assert.equal(res.ok, true)
  assert.equal(res.readback.ok, false)
  assert.equal(res.readback.reason, 'readback-not-declared')
  assert.equal(session.current().state, 'write-unknown')
})

test('actions: ok + ref but readback MISMATCH ⇒ write-unknown', async () => {
  const executor = fakeExecutor({ read: (req) => (req.templateId === 'item-get' ? { kind: 'ok', envelope: { ok: true, data: { title: '别的' } } } : { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '1', name: 'P1' }] } } }) })
  const { actions, session } = runAction({ executor })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
  assert.equal(res.ok, true)
  assert.equal(res.readback.ok, false)
  assert.match(res.readback.reason, /readback-mismatch/)
  assert.equal(session.current().state, 'write-unknown')
})

test('actions: an action pointing at a delete template is refused (动作集不得提供删除)', async () => {
  const { actions, executor } = runAction({ card: cardFor({ state: 'confirmed' }) })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-delete' })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'action-forbidden-delete')
  assert.deepEqual(executor.calls.filter((c) => c[0] === 'write'), [])
})

test('actions: the write path is only entered through a card; discard needs a person too', async () => {
  const { actions } = runAction({ card: cardFor({ state: 'draft' }) })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'discard' })
  assert.equal(res.ok, true)
  assert.equal(res.action, 'discard')
})

// ── 7 · 复核 F1：空更新（根因层）与「零字段比对」地板 ────────────────────────

/** 一条「更新」写模板：必填只有定位字段（project-id/id），内容字段全在 optional；读回只认 title。
 *  `parent-id` 是**可写但读不回**的合成字段（登记 unreadable）⇒ 只改它时零命中地板仍可达。 */
function updateDemo(overrides = {}) {
  const base = demo()
  return demo({
    requiredParams: { ...base.requiredParams, '+item-update': ['--project-id', '--id'] },
    templates: [
      ...base.templates,
      {
        id: 'item-update', kind: 'write', module: 'demo', command: '+item-update',
        required: ['project-id', 'id'], optional: ['title', 'parent-id'],
        args: ['--project-id', { field: 'project-id' }, '--id', { field: 'id' },
          { when: 'title', args: ['--title', { field: 'title' }] },
          { when: 'parent-id', args: ['--parent-id', { field: 'parent-id' }] }],
        refPath: 'data.id',
        readback: {
          template: 'item-get', idFrom: 'data.id', scope: ['project-id'],
          check: [{ field: 'title', read: 'title' }],
          unreadable: [{ field: 'parent-id', reason: '（合成夹具）演示「可写但读不回」⇒ 零命中地板可达' }],
        },
      },
    ],
    outputs: {
      ...base.outputs,
      actions: { ...base.outputs.actions, 'confirm-update': { label: '确认更新', human: 'confirm', writes: 'item-update' } },
    },
    ...overrides,
  })
}

/** 更新卡：定位字段恒有（project-id/id），内容字段按需。`id` 出口是 readback ⇒ 佐证用写明来源的 derived。 */
function updateCard({ title = '', parentId = '' } = {}) {
  const fields = /** @type {any[]} */ ([
    { key: 'project-id', label: '项目', value: '1', tier: 'user-designated', source: 'human', attestation: { kind: 'lookup', field: 'project-id' } },
    { key: 'id', label: 'id', value: '3268', tier: 'user-designated', source: 'human', attestation: { kind: 'derived', from: 'item-get', source: 'by key' } },
  ])
  if (parentId !== '') fields.push({ key: 'parent-id', label: '上级', value: parentId, tier: 'user-designated', source: 'human', attestation: { kind: 'derived', from: 'item-get', source: 'by key' } })
  if (title !== '') fields.push({ key: 'title', label: '标题', value: title, tier: 'agent-drafted', source: 'agent' })
  return { id: 'demo-update:abc', title: 'Demo update card', state: 'confirmed', confirmedBy: '陈涛', fields }
}

test('F1 · 空更新（只给 project-id/id，改不了任何东西）⇒ 执行前就拒 no-op-write，绝不出写、绝不落 written', async () => {
  const registry = registryWith(updateDemo())
  const spawns = []
  const executor = M.createPackExecutor({
    registry, cliPath: '/fake/shaoke-cli',
    execFileImpl: (file, args, opts, cb) => {
      spawns.push(args)
      const payload = args[1] === '+project-list'
        ? '{"ok":true,"data":{"data":[{"id":"1","name":"P1"}],"total":1}}'
        : '{"ok":true,"data":{"id":"3268"}}'
      cb(null, payload, '')
    },
  })
  const session = fakeSession(updateCard())
  const actions = M.createPackActions({ registry, executor, session, identityOf: () => ({ whoami: { displayName: '陈涛' } }) })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-update:abc', actionId: 'confirm-update' })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'no-op-write')
  assert.equal(spawns.filter((args) => args[1] === '+item-update').length, 0, '空更新不得 spawn 写命令（连读回都不必发生）')
  assert.notEqual(session.current().state, 'written')
})

test('F1 · 意图判据：写成功（ok:true 带回执）但本次只写了 unreadable 登记的字段 ⇒ write-unknown，绝不落 written', async () => {
  const registry = registryWith(updateDemo())
  const executor = fakeExecutor({
    // 写成功打回执；读回照常返回数据 —— 但本次写的是 parent-id（登记为读不回），title 空
    read: (req) => (req.templateId === 'item-get'
      ? { kind: 'ok', envelope: { ok: true, data: { id: '3268', title: '别的' } } }
      : { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '1', name: 'P1' }], total: 1 } } }),
  })
  const session = fakeSession(updateCard({ parentId: '7' })) // parent-id 填了（避免落 no-op），它登记为 unreadable
  const actions = M.createPackActions({ registry, executor, session, identityOf: () => ({ whoami: { displayName: '陈涛' } }) })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-update:abc', actionId: 'confirm-update' })
  assert.equal(res.ok, true)
  assert.equal(res.readback.ok, false)
  assert.equal(res.readback.reason, 'readback-intent-unreadable:parent-id')
  assert.deepEqual(res.readback.checked, [])
  assert.equal(session.current().state, 'write-unknown')
})

test('F1 · 正控：写成功且读回比到一个字段且一致 ⇒ 仍落 written（地板不误伤真确认）', async () => {
  const registry = registryWith(updateDemo())
  const executor = fakeExecutor({
    read: (req) => (req.templateId === 'item-get'
      ? { kind: 'ok', envelope: { ok: true, data: { id: '3268', title: '写一份东西' } } }
      : { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '1', name: 'P1' }], total: 1 } } }),
  })
  const session = fakeSession(updateCard({ title: '写一份东西' }))
  const actions = M.createPackActions({ registry, executor, session, identityOf: () => ({ whoami: { displayName: '陈涛' } }) })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-update:abc', actionId: 'confirm-update' })
  assert.equal(res.ok, true)
  assert.equal(res.readback.ok, true)
  assert.deepEqual(res.readback.checked, ['title'])
  assert.equal(session.current().state, 'written')
})

test('F1 · 装载期：readback.check 为空、或未覆盖必填 ⇒ 装载即拒', async () => {
  const emptyCheck = M.validateDeclaration(
    demo({ templates: demo().templates.map((t) => (t.id === 'item-create' ? { ...t, readback: { ...t.readback, check: [] } } : t)) }),
  )
  assert.ok(emptyCheck.invalid.some((e) => e.includes('readback.check 为空')), JSON.stringify(emptyCheck))

  const uncovered = M.validateDeclaration(
    demo({ templates: demo().templates.map((t) => (t.id === 'item-create' ? { ...t, readback: { ...t.readback, check: [{ field: 'parent-id', read: 'parentId' }] } } : t)) }),
  )
  assert.ok(uncovered.invalid.some((e) => e.includes('未覆盖必填 title')), JSON.stringify(uncovered))
})

test('F1 · 原场景（真实 BAYMAX 声明）：+issue-update 只给 project-id/id ⇒ 拒 no-op-write，绝不落 written', async () => {
  const registry = M.createPackRegistry()
  const loaded = registry.register(M.BAYMAX_DECLARATION)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  const spawns = []
  const executor = M.createPackExecutor({
    registry, cliPath: '/fake/shaoke-cli',
    execFileImpl: (file, args, opts, cb) => { spawns.push(args); cb(null, '{"ok":true,"data":{"id":"3268"}}', '') },
  })
  const card = {
    id: 'baymax-update:x', title: 'x', state: 'confirmed', confirmedBy: '陈涛',
    fields: [
      { key: 'project-id', label: '项目', value: '1', tier: 'user-designated', source: 'human', attestation: { kind: 'lookup', field: 'project-id' } },
      { key: 'id', label: 'id', value: '3268', tier: 'user-designated', source: 'human', attestation: { kind: 'derived', from: 'get-issue', source: 'by key' } },
    ],
  }
  const res = await executor.runTemplate({ packId: 'baymax', templateId: 'update-item', card })
  assert.equal(res.kind, 'refused')
  assert.equal(res.refusal, 'no-op-write')
  assert.equal(spawns.filter((args) => args[1] === '+issue-update').length, 0, '空更新不得发出 +issue-update')
})

// ── 8 · 复核 F3：「不给删除」按集合判（运行期），不再靠名字字形 ───────────────

test('F3 · resolveTemplate：删除类**集合**（remove/purge/rm/archive/drop + camelCase）一律拒', () => {
  const base = demo()
  const withCommand = (command) => ({
    ...base,
    requiredParams: { ...base.requiredParams, [command]: [] },
    templates: [{ id: 'x', kind: 'write', module: 'demo', command, required: [], optional: [], args: [] }],
  })
  for (const command of ['+relation-remove', '+issue-purge', 'deleteIssue', 'issue-rm', '+archive-item', 'item-drop', 'destroy-item']) {
    assert.equal(M.packExec.resolveTemplate(withCommand(command), 'x', {}).refusal, 'command-forbidden-delete', command)
  }
  // 判据本身：修前那条名字正则会放行的输入，现在一律命中
  assert.equal(M.packExec.isDeleteCommand('+relation-remove'), true)
  assert.equal(M.packExec.isDeleteCommand('+issue-purge'), true)
  assert.equal(M.packExec.isDeleteCommand('deleteIssue'), true)
  // 正常命令不得误伤
  for (const command of ['+issue-create', '+issue-update', '+issue-comment', '+relation-list', '+issue-history', '+user-list']) {
    assert.equal(M.packExec.isDeleteCommand(command), false, command)
  }
})

test('F3 · resolveTemplate：参数里的字面量 --delete 同样拒（arg-forbidden-delete）', () => {
  const base = demo()
  const declaration = {
    ...base,
    templates: [
      { id: 'x', kind: 'write', module: 'demo', command: '+item-get', required: [], optional: ['id'], args: ['--delete', { field: 'id' }] },
    ],
  }
  assert.equal(M.packExec.resolveTemplate(declaration, 'x', { id: '5' }).refusal, 'arg-forbidden-delete')
  // 取值里含这个词不算（那是内容，不是命令）：字段引用不参与字面量扫描
  const valueOk = M.packExec.resolveTemplate(
    { ...base, templates: [{ id: 'y', kind: 'write', module: 'demo', command: '+item-get', required: ['id'], optional: [], args: ['--project-id', { field: 'id' }] }] },
    'y',
    { id: 'delete me' },
  )
  assert.equal(valueOk.ok, true, '用户文本里的 delete 不该被当成命令面')
})

test('F3 · 装载期：未声明的写命令、参数里的破坏性字面量 ⇒ 装载即拒', async () => {
  const rogueCommand = M.validateDeclaration(
    demo({ templates: [...demo().templates, { id: 'item-remove', kind: 'write', module: 'demo', command: '+relation-remove', required: [], optional: [], args: [] }] }),
  )
  assert.ok(rogueCommand.invalid.some((e) => e.includes('不在本包声明的命令集内')), JSON.stringify(rogueCommand))

  const rogueLiteral = M.validateDeclaration(
    demo({ templates: demo().templates.map((t) => (t.id === 'item-create' ? { ...t, args: ['--project-id', { field: 'project-id' }, '--delete', { field: 'title' }] } : t)) }),
  )
  assert.ok(rogueLiteral.invalid.some((e) => e.includes('参数含破坏性字面量')), JSON.stringify(rogueLiteral))
})

test('F3 · 读路径同样拦（读写两路共用 resolveTemplate 的同一份判据）', async () => {
  const base = demo()
  const declaration = {
    ...base,
    requiredParams: { ...base.requiredParams, '+relation-remove': [] },
    templates: [{ id: 'rogue-read', kind: 'read', module: 'demo', command: '+relation-remove', required: [], optional: [], shape: 'object', args: [] }],
    outputs: { ...base.outputs, fields: {}, actions: {}, blocks: [] },
  }
  const registry = registryWith(declaration)
  const executor = M.createPackExecutor({ registry, cliPath: '/fake', execFileImpl: () => { throw new Error('must not spawn') } })
  const res = await executor.runRead({ packId: 'demo', templateId: 'rogue-read', params: {} })
  assert.equal(res.kind, 'refused')
  assert.equal(res.refusal, 'command-forbidden-delete')
})

// ── 9 · W4 复核 B/A + 复验 P1–P4：读回清单覆盖全部可写字段；形状无关口径；意图判据 ──
//
// 本节的**关键教训**（第二轮复验 P1/P2/P3）：回读夹具必须用**实测形状**。把回执写成与卡片
// 同形（「自证式夹具」）会让逐字口径的缺陷永远照绿 —— P1/P2/P3 就是这么漏过去的。所以本节
// 所有回读夹具都取自 2026-10-06 的只读实测（`+issue-get --project-id 1 --id 3268`）。

/** 真实 BAYMAX 更新卡：定位字段（project-id/id，各带本包的佐证）+ 本次要改的内容字段。 */
function baymaxCard(contentFields) {
  return {
    id: 'baymax-update:x', title: 'x', state: 'confirmed', confirmedBy: '陈涛',
    fields: [
      { key: 'project-id', label: '项目', value: '1', tier: 'user-designated', source: 'human', attestation: { kind: 'lookup', field: 'project-id' } },
      { key: 'id', label: 'id', value: '3268', tier: 'user-designated', source: 'human', attestation: { kind: 'derived', from: 'get-issue', source: 'by key' } },
      ...contentFields,
    ],
  }
}

/**
 * **真机回读形状表**（2026-10-06 实测 `+issue-get`；本节所有回读夹具的唯一形状来源）。
 * 左＝卡片里用户填的值，右＝真机回读的同名字段值。三条不同形：
 *   · 日期回 ISO8601 **带时分秒**（`"2026-09-07T00:00:00.000Z"`）而卡片是纯日期；
 *   · 工时回 **JSON number**（8／0.5）而卡片是文本（`"8.0"`）；
 *   · 描述回 **HTML**（`<p>…</p>`）而卡片是纯文本。
 */
const REAL_READBACK_SHAPE = {
  title: { card: '写一份东西（已改）', read: '写一份东西（已改）', mode: 'text' },
  description: { card: '自动化验证用，验完即删。', read: '<p>自动化验证用，验完即删。</p>', mode: 'text' },
  'status-id': { card: '5', read: '5', mode: 'exact' },
  'type-id': { card: '3', read: '3', mode: 'exact' },
  'priority-id': { card: '3', read: '3', mode: 'exact' },
  'assignee-id': { card: '5', read: '5', mode: 'exact' },
  'estimate-start': { card: '2026-09-07', read: '2026-09-07T00:00:00.000Z', mode: 'date' },
  'estimate-end': { card: '2026-11-01', read: '2026-11-01T00:00:00.000Z', mode: 'date' },
  'estimate-workload': { card: '8.0', read: 8, mode: 'number' },
  'actual-workload': { card: '1.0', read: 1, mode: 'number' },
  'parent-id': { card: '3268', read: '3268', mode: 'exact' },
}

/** 形状不同形、逐字口径**恒不等**的那几个（反向证明用：口径拿掉必须变红）。 */
const SHAPE_MISMATCHING_FIELDS = ['description', 'estimate-start', 'estimate-end', 'estimate-workload', 'actual-workload']

/** 用真实 BAYMAX 声明 + 真会话 + 夹具执行器（无 spawn）跑一次 update-item。`reads` 可补读模板。 */
async function runBaymaxUpdate(contentFields, readData, reads = {}) {
  const registry = M.createPackRegistry()
  const loaded = registry.register(M.BAYMAX_DECLARATION)
  assert.equal(loaded.ok, true, JSON.stringify(loaded))
  const executor = fakeExecutor({
    read: (req) => {
      if (reads[req.templateId]) return reads[req.templateId]
      if (req.templateId === 'project-list') return { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '1', projectName: 'P1' }], total: 1 } } }
      return { kind: 'ok', envelope: { ok: true, data: { id: '3268', ...readData } } }
    },
    write: () => ({ kind: 'ok', ref: 'PM-3268', envelope: { ok: true, data: { id: '3268', issueKey: 'PM-3268' } } }),
  })
  const session = fakeSession(baymaxCard(contentFields))
  const actions = M.createPackActions({ registry, executor, session, identityOf: () => ({ whoami: { displayName: '陈涛' } }) })
  const res = await actions.run({ packId: 'baymax', cardId: 'baymax-update:x', actionId: 'confirm-update' })
  return { res, session, executor }
}

test('W4-B 声明面：create-item/update-item 的 check 覆盖全部可写字段（定位字段除外），label-ids 登记 unreadable 且写明理由', () => {
  const D = M.BAYMAX_DECLARATION
  for (const id of ['create-item', 'update-item']) {
    const t = D.templates.find((x) => x.id === id)
    const locators = new Set(['project-id', 'id'])
    const check = t.readback.check.map((c) => c.field)
    const unreadable = (t.readback.unreadable ?? []).map((u) => u.field)
    const writable = [...new Set([...t.required, ...t.optional])].filter((f) => !locators.has(f))
    const uncovered = writable.filter((f) => !check.includes(f) && !unreadable.includes(f))
    assert.deepEqual(uncovered, [], `${id} 仍有未覆盖的可写字段：${uncovered.join(',')}`)
    for (const u of t.readback.unreadable ?? []) assert.ok(u.reason && String(u.reason).trim(), `${id}.${u.field} 须写明读不回的理由`)
    // 同一字段不得既在 check 又在 unreadable（P4 里 unreadable 是否决性的）
    for (const field of unreadable) assert.equal(check.includes(field), false, `${id}.${field} 不得同时在 check 与 unreadable`)
  }
  // 唯一留白就是「读回是对象数组、逐字口径不适用」的 label-ids
  assert.deepEqual(D.templates.find((t) => t.id === 'update-item').readback.unreadable.map((u) => u.field), ['label-ids'])
})

test('P1/P2/P3 声明面：每条 check 的 compare 与真机形状一致（date/number/text）；口径名合法', () => {
  const t = M.BAYMAX_DECLARATION.templates.find((x) => x.id === 'update-item')
  const byField = new Map(t.readback.check.map((c) => [c.field, c]))
  assert.deepEqual([...byField.keys()], Object.keys(REAL_READBACK_SHAPE), 'check 字段集必须与本节的真实形状表一一对应')
  for (const [field, shape] of Object.entries(REAL_READBACK_SHAPE)) {
    assert.equal(String(byField.get(field).compare ?? 'exact'), shape.mode, `${field} 的比对口径应与真机形状相配`)
  }
})

test('P1/P2/P3 正控（读回层·真实形状）：单项改任一可读字段都按声明口径比中（11 × 真机形状）', async () => {
  const D = M.BAYMAX_DECLARATION
  const pack = { id: 'baymax', declaration: D }
  const template = D.templates.find((t) => t.id === 'update-item')
  const readKeyOf = (field) => template.readback.check.find((c) => c.field === field).read
  for (const [field, shape] of Object.entries(REAL_READBACK_SHAPE)) {
    const card = baymaxCard([{ key: field, label: field, value: shape.card, tier: 'agent-drafted', source: 'agent' }])
    const executor = fakeExecutor({ read: (req) => (req.templateId === 'get-issue'
      ? { kind: 'ok', envelope: { ok: true, data: { id: '3268', [readKeyOf(field)]: shape.read } } }
      : { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '1', projectName: 'P1' }], total: 1 } } }) })
    const res = await M.verifyReadback({ pack, card, template, envelope: { ok: true, data: { id: '3268' } }, executor })
    assert.equal(res.ok, true, `${field}: ${JSON.stringify(res)}`)
    assert.deepEqual(res.checked, [field], `${field} 应被比中，checked=${JSON.stringify(res.checked)}`)
  }
})

test('P1/P2/P3 反向证明（同一条真机夹具）：把口径退回逐字 ⇒ 三条不同形的字段必须变红 ⇒ 口径承重', async () => {
  const D = M.BAYMAX_DECLARATION
  const base = D.templates.find((t) => t.id === 'update-item')
  // 只把 compare 抹掉（＝退回默认 exact），其余一字不动
  const exactOnly = { ...base, readback: { ...base.readback, check: base.readback.check.map((c) => ({ field: c.field, read: c.read })) } }
  const pack = { id: 'baymax', declaration: { ...D, templates: D.templates.map((t) => (t.id === 'update-item' ? exactOnly : t)) } }
  for (const field of SHAPE_MISMATCHING_FIELDS) {
    const shape = REAL_READBACK_SHAPE[field]
    const readKey = base.readback.check.find((c) => c.field === field).read
    const card = baymaxCard([{ key: field, label: field, value: shape.card, tier: 'agent-drafted', source: 'agent' }])
    const executor = fakeExecutor({ read: () => ({ kind: 'ok', envelope: { ok: true, data: { id: '3268', [readKey]: shape.read } } }) })
    const res = await M.verifyReadback({ pack, card, template: exactOnly, envelope: { ok: true, data: { id: '3268' } }, executor })
    assert.equal(res.ok, false, `${field} 在逐字口径下必须对不上（这条夹具不是自证式）`)
    assert.equal(res.reason, `readback-mismatch:${field}`, `${field}: ${JSON.stringify(res)}`)
  }
})

test('P1/P2/P3 正控（端到端·真实形状）：单项改 description／estimate-end／estimate-workload ⇒ 落 written', async () => {
  const cases = [
    ['description', { key: 'description', label: '描述', value: '自动化验证用，验完即删。', tier: 'agent-drafted', source: 'agent' }, { description: '<p>自动化验证用，验完即删。</p>' }],
    ['estimate-end', { key: 'estimate-end', label: '计划结束', value: '2026-11-01', tier: 'user-fact', source: 'human' }, { estimateEndDate: '2026-11-01T00:00:00.000Z' }],
    ['estimate-workload', { key: 'estimate-workload', label: '预估工时', value: '8.0', tier: 'user-fact', source: 'human' }, { estimateWorkload: 8 }],
    ['actual-workload', { key: 'actual-workload', label: '实际工时', value: '1.0', tier: 'user-fact', source: 'human' }, { actualWorkload: 1 }],
  ]
  for (const [label, field, readData] of cases) {
    const { res, session } = await runBaymaxUpdate([field], readData)
    assert.equal(res.ok, true, `${label}: ${JSON.stringify(res)}`)
    assert.equal(res.readback?.ok, true, `${label}: ${JSON.stringify(res.readback)}`)
    assert.ok(res.readback.checked.includes(label), `${label} 应计入命中，checked=${JSON.stringify(res.readback.checked)}`)
    assert.equal(session.current().state, 'written', `${label} 应落 written`)
  }
})

test('P5 存量复核：status-id 取值出口声明与真机一致；正控卡走真实数组形状 ⇒ written', async () => {
  // 真机（2026-10-06 实测）：+status-list --project-id 1 ⇒ {"data":[{"id":"5","name":"DEVELOPMENT/开发中","isClosed":false},…],"ok":true}
  // 声明 valueLookup['status-id'] = { template:'status-list', labelField:'name', valueField:'id' } ⇒ 与真机一致（无缺陷）。
  const realShape = { kind: 'ok', envelope: { ok: true, data: [{ id: '5', name: 'DEVELOPMENT/开发中', isClosed: false }] } }
  const cardField = { key: 'status-id', label: '状态', value: '5', tier: 'user-designated', source: 'human', attestation: { kind: 'lookup', field: 'status-id' } }
  const ok = await runBaymaxUpdate([cardField], { statusId: '5' }, { 'status-list': realShape })
  assert.equal(ok.res.ok, true, JSON.stringify(ok.res))
  assert.equal(ok.session.current().state, 'written', JSON.stringify(ok.res.readback))
  // 反例（解释复验看到的 lookup-value-not-found）：夹具若把 status-list 写成**分页双层 data**（错形状），
  // 条目取不到 ⇒ 佐证判 lookup-value-not-found —— 那是夹具形状错，不是声明错。
  const pagedShape = { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '5', name: 'DEVELOPMENT/开发中' }], total: 1 } } }
  const bad = await runBaymaxUpdate([cardField], { statusId: '5' }, { 'status-list': pagedShape })
  assert.equal(bad.res.ok, false)
  assert.equal(bad.res.reason, 'lookup-value-not-found')
  assert.notEqual(bad.session.current().state, 'written')
})

test('W4-P4 反例：只改 label-ids、卡片另带**未改但能比中**的 title ⇒ 不得落 written', async () => {
  // 卡片里 title 没改（且读回与它一致，逐字能比中）、以及本次真正要改的 label-ids（登记 unreadable）
  const title = '【测试勿动】Baymax 写侧验证（自动化，验完即删）'
  const fields = [
    { key: 'title', label: '标题', value: title, tier: 'agent-drafted', source: 'agent' },
    { key: 'label-ids', label: '标签', value: '12', tier: 'user-designated', source: 'human', attestation: { kind: 'quote', quote: '12' } },
  ]
  const { res, session } = await runBaymaxUpdate(fields, { title, labels: [{ id: '12', name: 'x', color: '#fff' }] })
  assert.equal(res.ok, true, '写命令本身发出并成功')
  assert.equal(res.readback?.ok, false, `拿未改的 title 当担保必须不算确认：${JSON.stringify(res.readback)}`)
  assert.equal(res.readback.reason, 'readback-intent-unreadable:label-ids')
  assert.deepEqual(res.readback.checked, [])
  assert.equal(session.current().state, 'write-unknown', '本次要写的字段读不回来 ⇒ 结果未知（先核对，别重写）')
})

test('W4-P4 正控：卡片里只有真改的字段（title）⇒ 仍落 written（意图判据不误伤真确认）', async () => {
  const { res, session } = await runBaymaxUpdate([{ key: 'title', label: '标题', value: '改了标题', tier: 'agent-drafted', source: 'agent' }], { title: '改了标题' })
  assert.equal(res.readback?.ok, true, JSON.stringify(res.readback))
  assert.deepEqual(res.readback.checked, ['title'])
  assert.equal(session.current().state, 'written')
})

test('W4-P4 边界：卡片里只有 label-ids（无其它字段）⇒ 同样 fail-closed（不落 written）', async () => {
  const D = M.BAYMAX_DECLARATION
  const pack = { id: 'baymax', declaration: D }
  const template = D.templates.find((t) => t.id === 'update-item')
  const card = baymaxCard([{ key: 'label-ids', label: '标签', value: '12', tier: 'user-designated', source: 'human' }])
  const executor = fakeExecutor({ read: () => ({ kind: 'ok', envelope: { ok: true, data: { id: '3268', labels: [{ id: '12', name: 'x', color: '#fff' }] } } }) })
  const res = await M.verifyReadback({ pack, card, template, envelope: { ok: true, data: { id: '3268' } }, executor })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'readback-intent-unreadable:label-ids')
  assert.deepEqual(res.checked, [])
})

test('W4 装载期（P1/P2/P3）：compare 口径名不在枚举内 ⇒ 装载即拒', () => {
  const bad = M.validateDeclaration(
    demo({ templates: demo().templates.map((t) => (t.id === 'item-create' ? { ...t, readback: { ...t.readback, check: [{ field: 'title', read: 'title', compare: 'texty' }] } } : t)) }),
  )
  assert.equal(bad.ok, false)
  assert.ok(bad.invalid.some((e) => e.includes('比较口径 texty 未声明')), JSON.stringify(bad))
})

test('W4 装载期（P4）：同一字段既在 check 又在 unreadable ⇒ 装载即拒', () => {
  const bad = M.validateDeclaration(
    demo({ templates: demo().templates.map((t) => (t.id === 'item-create' ? { ...t, readback: { ...t.readback, unreadable: [{ field: 'title', reason: 'x' }] } } : t)) }),
  )
  assert.equal(bad.ok, false)
  assert.ok(bad.invalid.some((e) => e.includes('同时在 check 与 unreadable 里')), JSON.stringify(bad))
})

test('W4-A 反证（装载期）：readback.check 含定位字段 ⇒ 装载即拒', () => {
  const withLocator = M.validateDeclaration(
    demo({ templates: demo().templates.map((t) => (t.id === 'item-create' ? { ...t, readback: { ...t.readback, check: [{ field: 'project-id', read: 'projectId' }, { field: 'title', read: 'title' }] } } : t)) }),
  )
  assert.equal(withLocator.ok, false)
  assert.ok(withLocator.invalid.some((e) => e.includes('含定位字段 project-id')), JSON.stringify(withLocator))
})

test('W4-A 反证（意图闸）：check 只比未变的定位字段、真改的字段未被覆盖 ⇒ 不落 written', async () => {
  const D = M.BAYMAX_DECLARATION
  const base = D.templates.find((t) => t.id === 'update-item')
  const template = { ...base, readback: { template: 'get-issue', idFrom: 'data.id', scope: ['project-id'], check: [{ field: 'project-id', read: 'projectId' }] } }
  const pack = { id: 'baymax', declaration: { ...D, templates: D.templates.map((t) => (t.id === 'update-item' ? template : t)) } }
  // 卡片真改了 title，但 check 里只有**未变的** project-id
  const card = baymaxCard([{ key: 'title', label: '标题', value: '改了标题', tier: 'agent-drafted', source: 'agent' }])
  const executor = fakeExecutor({ read: () => ({ kind: 'ok', envelope: { ok: true, data: { projectId: '1', title: '改了标题' } } }) })
  const res = await M.verifyReadback({ pack, card, template, envelope: { ok: true, data: { id: '3268' } }, executor })
  assert.equal(res.ok, false)
  assert.equal(res.reason, 'readback-intent-uncovered:title')
  assert.deepEqual(res.checked, [])
})
