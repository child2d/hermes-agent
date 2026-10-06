/**
 * W3 · LOAD-BEARING evidence for the four hard boundaries of the execution side
 * (the "拿掉核心就变红" half of the acceptance).
 *
 * The semantic suite (pack-w3-exec-actions.test.mjs) proves the modules MATCH
 * the bounds. It does NOT prove those bounds are the things doing the work. So
 * here each core mechanism is short-circuited IN MEMORY (one exact string
 * replacement, asserted to have landed), the mutated plugin is loaded, and the
 * SAME predicate the acceptance uses must FLIP.
 *
 * Method mirrors the W1/W2 load-bearing suites (mutate → run → red → revert).
 * Nothing in the repo is modified: the mutation lives in a temp copy. Every
 * fixture is SYNTHETIC; no enterprise data is read or written.
 *
 * Run:
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-w3-loadbearing.test.mjs
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

async function loadPlugin(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-w3-lb-'))
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

/** Short-circuit one exact anchor; it must exist exactly once. */
async function mutated(from, to) {
  const first = SOURCE.indexOf(from)
  assert.notEqual(first, -1, `mutation anchor not found: ${from}`)
  assert.equal(SOURCE.indexOf(from, first + 1), -1, `mutation anchor is not unique: ${from}`)
  const next = SOURCE.slice(0, first) + to + SOURCE.slice(first + from.length)
  assert.notEqual(next, SOURCE)
  return loadPlugin(next)
}

/** Apply several exact anchors at once (each must be unique) — for "拿掉两道判据" 类反证. */
async function mutatedAll(pairs) {
  let next = SOURCE
  for (const [from, to] of pairs) {
    const first = next.indexOf(from)
    assert.notEqual(first, -1, `mutation anchor not found: ${from}`)
    assert.equal(next.indexOf(from, first + 1), -1, `mutation anchor is not unique: ${from}`)
    next = next.slice(0, first) + to + next.slice(first + from.length)
  }
  assert.notEqual(next, SOURCE)
  return loadPlugin(next)
}

const INTACT = await loadPlugin(SOURCE)

function demo() {
  return {
    id: 'demo', displayName: 'Demo pack', discriminant: 'the envelope ok flag',
    failureMap: { ok: 'written', rejected: 'failed', refused: 'blocked', unparsed: 'write-unknown', timeout: 'write-unknown', 'spawn-error': 'write-unknown' },
    requiredParams: { '+item-create': ['--project-id', '--title'], '+item-delete': ['--id'], '+item-get': ['--project-id', '--id'], '+project-list': [] },
    destructiveParams: [{ name: 'parent-id', semantics: 'reparent' }],
    valueLookup: { 'project-id': { template: 'project-list', labelField: 'name', valueField: 'id' }, id: { readback: 'by key' }, 'parent-id': { derived: 'step' } },
    steps: [{ id: 'create-parent', then: 'create-child' }],
    lookupFields: { title: { exists: 'by key' } },
    outputParsing: { envelope: 'ok', itemsPath: 'data.data', totalPath: 'data.total' },
    fieldTiers: { title: 'agent-drafted', 'project-id': 'user-designated', 'parent-id': 'user-designated', id: 'user-designated' },
    landing: { module: 'demo', assemblyPoint: 'demo', note: 'synthetic' },
    skill: ['demo'], broadcastPredicate: () => ({ hasContent: false }),
    templates: [
      { id: 'item-create', kind: 'write', module: 'demo', command: '+item-create', required: ['project-id', 'title'], optional: ['parent-id'], args: ['--project-id', { field: 'project-id' }, '--title', { field: 'title' }], refPath: 'data.issueKey', readback: { template: 'item-get', idFrom: 'data.id', scope: ['project-id'], check: [{ field: 'title', read: 'title' }] } },
      { id: 'item-delete', kind: 'write', module: 'demo', command: '+item-delete', required: ['id'], optional: [], args: ['--id', { field: 'id' }], refPath: 'data.id' },
      { id: 'item-get', kind: 'read', module: 'demo', command: '+item-get', required: ['project-id', 'id'], optional: [], shape: 'object', args: [] },
      { id: 'project-list', kind: 'read', module: 'demo', command: '+project-list', required: [], optional: [], shape: 'paged', itemsPath: 'data.data', totalPath: 'data.total', args: [] },
    ],
    requiredBeyondCli: {},
    outputs: {
      fields: { title: { label: '标题', role: 'title' }, 'project-id': { label: '项目', role: '' }, 'parent-id': { label: '上级', role: '' }, id: { label: 'id', role: '' } },
      actions: { 'confirm-create': { label: '确认新建', human: 'confirm', writes: 'item-create' }, 'confirm-delete': { label: '删除', human: 'confirm', writes: 'item-delete' }, discard: { label: '丢草稿', human: 'discard' }, refresh: { label: '刷新', human: 'progress', reads: 'item-get' } },
      blocks: [{ tag: 'demo-new', record: 'single', fields: ['title', 'project-id'], actions: ['confirm-create', 'discard'] }, { tag: 'demo-plan', record: 'collection', fields: ['title'], actions: ['refresh'] }],
    },
    skillDoc: { fileName: 'SKILL.md', markdown: '# demo' },
  }
}

const registryWith = (M, declaration) => {
  const registry = M.createPackRegistry()
  const r = registry.register(declaration)
  assert.equal(r.ok, true, JSON.stringify(r))
  return registry
}

function cardFor(title = '写一份东西') {
  return {
    id: 'demo-new:abc', title: 'Demo card', state: 'confirmed', confirmedBy: '陈涛',
    fields: [
      { key: 'title', label: '标题', value: title, tier: 'agent-drafted', source: 'agent' },
      { key: 'project-id', label: '项目', value: '1', tier: 'user-designated', source: 'human', attestation: { kind: 'lookup', field: 'project-id' } },
    ],
  }
}

function fakeSession(card) {
  let current = card
  return {
    get: () => current,
    replace: (n) => { current = n; return { ok: true, card: n } },
    confirm: (id, { by }) => { current = { ...current, state: 'confirmed', confirmedBy: by }; return { ok: true, card: current } },
    reopen: () => ({ ok: true, card: current }),
    discard: () => ({ ok: true, card: current }),
    presentations: () => [current],
    current: () => current,
  }
}

const fakeExecutor = (read) => ({
  async runRead(req) {
    if (read) return read(req)
    if (req.templateId === 'project-list') return { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '1', name: 'P1' }], total: 1 } } }
    return { kind: 'ok', envelope: { ok: true, data: { title: '别的' } } } // read-back MISMATCH
  },
  async runTemplate() { return { kind: 'ok', ref: 'D-99', envelope: { ok: true, data: { id: '99', issueKey: 'D-99' } } } },
})

// ── (a) read-back gate is what keeps a phantom write from being `written` ────

test('(a) short-circuit the read-back gate ⇒ the mismatch case flips to `written`', async () => {
  const run = async (M) => {
    const registry = registryWith(M, demo())
    const session = fakeSession(cardFor())
    const actions = M.createPackActions({ registry, executor: fakeExecutor(), session, identityOf: () => ({ whoami: { displayName: '陈涛' } }) })
    await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
    return session.current().state
  }
  assert.equal(await run(INTACT), 'write-unknown')
  const M = await mutated('if (readback && readback.ok === true) {', 'if (readback) {')
  assert.equal(await run(M), 'written', 'removing the read-back confirmation must let a phantom write pass ⇒ the gate is load-bearing')
})

// ── (b) identity fail-closed is what blocks an anonymous write ───────────────

test('(b) short-circuit the identity gate ⇒ a no-identity write is no longer refused', async () => {
  const run = async (M) => {
    const registry = registryWith(M, demo())
    const session = fakeSession(cardFor())
    const actions = M.createPackActions({ registry, executor: fakeExecutor((r) => (r.templateId === 'item-get' ? { kind: 'ok', envelope: { ok: true, data: { title: '写一份东西' } } } : { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '1', name: 'P1' }] } } })), session, identityOf: () => null })
    const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
    return res.reason ?? `state=${session.current().state}`
  }
  assert.equal(await run(INTACT), 'not-signed-in')
  const M = await mutated("if (!identity) return { ok: false, reason: 'not-signed-in' }", 'if (false) return { ok: false, reason: \'not-signed-in\' }')
  assert.match(await run(M), /^state=/, 'removing the identity gate must let the write proceed ⇒ the gate is load-bearing')
})

// ── (c) the delete guard is what keeps delete out of the action set ──────────

test('(c) short-circuit the delete guard ⇒ a delete command resolves', async () => {
  const verdict = (M) => M.packExec.resolveTemplate(demo(), 'item-delete', { id: '5' })
  assert.equal(verdict(INTACT).refusal, 'command-forbidden-delete')
  const M = await mutated("if (isDeleteCommand(template.command)) return { ok: false, refusal: 'command-forbidden-delete' }", 'if (false) return { ok: false, refusal: \'command-forbidden-delete\' }')
  assert.equal(verdict(M).ok, true, 'removing the delete guard must let a delete template resolve ⇒ the guard is load-bearing')
})

// ── (d) the executor refuses without a spawner (no silent no-op) ─────────────

test('(d) short-circuit the spawner guard ⇒ a write with no spawner is no longer refused', async () => {
  const res = async (M) => {
    const registry = registryWith(M, demo())
    const executor = M.createPackExecutor({ registry, cliPath: '' })
    return (await executor.runTemplate({ packId: 'demo', templateId: 'item-create', card: cardFor() })).refusal ?? 'ran'
  }
  assert.equal(await res(INTACT), 'spawner-missing')
  // Replace the single guard with a no-op AND give the spawner a body that cannot run.
  const M = await mutated("if (!spawnable) return refuse('spawner-missing')\n    if (!isPlainObject(card)) return refuse('card-required')", "if (false) return refuse('spawner-missing')\n    if (!isPlainObject(card)) return refuse('card-required')")
  await assert.rejects(res(M).catch((e) => { throw e }), /execFileImpl is not a function|not a function|Cannot read/, 'without the guard the missing spawner is dereferenced ⇒ the guard was the thing refusing')
})

// ── (e)(f) 复核 F1：空更新（根因）与「零字段比对」地板（拿掉即又落 written）────

/** 一条纯更新写模板：必填＝定位字段（project-id/id）；readback.check 只认 title（本次为空）。 */
function updateDecl() {
  const base = demo()
  return {
    ...base,
    requiredParams: { ...base.requiredParams, '+item-update': ['--project-id', '--id'] },
    templates: [...base.templates, {
      id: 'item-update', kind: 'write', module: 'demo', command: '+item-update',
      required: ['project-id', 'id'], optional: ['title', 'parent-id'],
      args: ['--project-id', { field: 'project-id' }, '--id', { field: 'id' },
        { when: 'title', args: ['--title', { field: 'title' }] },
        { when: 'parent-id', args: ['--parent-id', { field: 'parent-id' }] }],
      refPath: 'data.id',
      readback: { template: 'item-get', idFrom: 'data.id', scope: ['project-id'], check: [{ field: 'title', read: 'title' }] },
    }],
    outputs: { ...base.outputs, actions: { ...base.outputs.actions, 'confirm-update': { label: '确认更新', human: 'confirm', writes: 'item-update' } } },
  }
}

/** 更新卡：定位字段恒有；内容字段（title / parent-id）按需。 */
function updateCard({ title = '', parentId = '' } = {}) {
  const fields = /** @type {any[]} */ ([
    { key: 'project-id', label: '项目', value: '1', tier: 'user-designated', source: 'human', attestation: { kind: 'lookup', field: 'project-id' } },
    { key: 'id', label: 'id', value: '3268', tier: 'user-designated', source: 'human', attestation: { kind: 'derived', from: 'item-get', source: 'by key' } },
  ])
  if (parentId !== '') fields.push({ key: 'parent-id', label: '上级', value: parentId, tier: 'user-designated', source: 'human', attestation: { kind: 'derived', from: 'item-get', source: 'by key' } })
  if (title !== '') fields.push({ key: 'title', label: '标题', value: title, tier: 'agent-drafted', source: 'agent' })
  return { id: 'demo-update:abc', title: 'Demo update card', state: 'confirmed', confirmedBy: '陈涛', fields }
}

const updateState = async (M, card) => {
  const registry = registryWith(M, updateDecl())
  const session = fakeSession(card)
  const actions = M.createPackActions({ registry, executor: fakeExecutor(), session, identityOf: () => ({ whoami: { displayName: '陈涛' } }) })
  await actions.run({ packId: 'demo', cardId: 'demo-update:abc', actionId: 'confirm-update' })
  return session.current().state
}

test('(e) short-circuit the read-back floor ⇒ a zero-field read-back flips to `written`', async () => {
  // parent-id 填了（避开空更新判据），title 空 ⇒ 本次**一个字段都没比到**
  assert.equal(await updateState(INTACT, updateCard({ parentId: '7' })), 'write-unknown')
  const M = await mutated(
    "if (checked.length === 0) return { ok: false, reason: 'readback-no-field-checked', checked: [] }",
    "if (false) return { ok: false, reason: 'readback-no-field-checked', checked: [] }",
  )
  assert.equal(await updateState(M, updateCard({ parentId: '7' })), 'written', '拿掉地板：零字段比对的写卡又落 written ⇒ 地板承重')
})

test('(f) 原场景复现（F1）：只给 project-id/id 的更新，修后不落 written；拿掉两道判据即又落 written', async () => {
  assert.notEqual(await updateState(INTACT, updateCard()), 'written', '修后：空更新在执行前被拒 ⇒ 绝不落 written')
  const M = await mutatedAll([
    ["if (isEmptyWrite(pack.declaration, resolved.template, params)) return refuse('no-op-write')", "if (false) return refuse('no-op-write')"],
    ["if (checked.length === 0) return { ok: false, reason: 'readback-no-field-checked', checked: [] }", "if (false) return { ok: false, reason: 'readback-no-field-checked', checked: [] }"],
  ])
  assert.equal(await updateState(M, updateCard()), 'written', '拿掉两道判据 ⇒ 空更新又落 written ⇒ 它们就是拦住这条路径的东西')
})

// ── (g) 复核 F3：参数里的破坏性字面量（拿掉判据即放行）────────────────────────

test('(g) short-circuit the arg-literal guard ⇒ a template carrying `--delete` resolves', async () => {
  const decl = () => ({
    ...demo(),
    templates: [{ id: 'x', kind: 'write', module: 'demo', command: '+item-get', required: [], optional: ['id'], args: ['--delete', { field: 'id' }] }],
  })
  const verdict = (M) => M.packExec.resolveTemplate(decl(), 'x', { id: '5' })
  assert.equal(verdict(INTACT).refusal, 'arg-forbidden-delete')
  const M = await mutated('if (forbiddenLiterals.length) return', 'if (false) return')
  assert.equal(verdict(M).ok, true, '拿掉参数面判据 ⇒ 带 --delete 的模板又通过 ⇒ 该判据承重')
})

test('(h) short-circuit the load-time destructive-command rule ⇒ an undeclared write command loads', async () => {
  const decl = () => ({
    ...demo(),
    templates: [...demo().templates, { id: 'item-remove', kind: 'write', module: 'demo', command: '+relation-remove', required: [], optional: [], args: [] }],
  })
  const loads = (M) => M.validateDeclaration(decl()).ok
  assert.equal(loads(INTACT), false, '修后：未声明的写命令装载即拒')
  const M = await mutated('if (declaredCommandSet.size > 0 && String(template.kind ', 'if (false && String(template.kind ')
  assert.equal(loads(M), true, '拿掉装载期正向规则 ⇒ 该声明又通过 ⇒ 该规则承重')
})
