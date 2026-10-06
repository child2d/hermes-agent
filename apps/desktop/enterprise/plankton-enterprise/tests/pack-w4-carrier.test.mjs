/**
 * W4 · carrier entry — semantics of the REWRITTEN `pack-render` (directive
 * components + reference payload), accepted by "语义等价、换载体" (裁定 5).
 *
 * Design: docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
 * §8 (W4 = pack-render + 前端适配; also收编 render-protocol's `parseCarrierBlocks`),
 * §0 / §3.1 / §5 (载体与呈现), 裁定 1 (指令式组件 + 引用式载荷), 裁定 2 (画法优先 HTML、
 * 不可用退化 markdown), 裁定 4 (写动作落实到人). Old shell baseline read-only:
 * ~/Repository/shaoke/codeup/plankton @ e305ce1, electron/{pack-render,render-protocol}.js.
 *
 * What this file PINS:
 *   * the directive carrier entry replaces the fenced one: a directive NAME is a
 *     declared block tag; a directive is only claimed by a plugin whose pack
 *     declares that tag (unclaimed names stay prose);
 *   * the payload is a REFERENCE (`key`), self-fetched by the renderer through an
 *     INJECTED loader — the message carries no JSON (绕开三硬约束);
 *   * 取块 → 过协议 → 落卡片: same `resolveOutput`/`presentOutput`, card vs table;
 *   * register() truly registers ONE transcript directive per declared block (the
 *     host registration point is `ctx.registerMany`);
 *   * the write path is W3's, unchanged: the directive calls the SAME
 *     `packActions.run`, the confirmer is the server-issued identity, and NO
 *     identity ⇒ `not-signed-in` (fail-closed) — no second write door.
 *
 * Load-bearing: each core rule has a mutant that turns the corresponding test RED.
 *
 * Run (a FILE, not a dir):
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-w4-carrier.test.mjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-w4-'))
  const sdk = path.join(dir, 'sdk.mjs')
  const react = path.join(dir, 'react.mjs')
  const jsxrt = path.join(dir, 'jsx-runtime.mjs')
  fs.writeFileSync(sdk, 'export const Button=()=>null;export const ConfirmDialog=()=>null;export const GlyphSpinner=()=>null;export const SearchField=()=>null;export const icons={Info:()=>null};\n')
  fs.writeFileSync(react, 'export const useEffect=()=>{};export const useState=v=>[v,()=>{}];\n')
  // jsx/jsxs return a describable element so a test can prove the render ran.
  fs.writeFileSync(jsxrt, 'export const jsx=(t,p)=> ({ __el: typeof t === "function" ? (t.name||"fn") : t, props: p||{} });export const jsxs=(t,p)=> ({ __el: typeof t === "function" ? (t.name||"fn") : t, props: p||{} });\n')
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

/** The three REAL declared block tags (the directive names the plugin claims). */
const BLOCK_TAGS = ['plankton-baymax-new', 'plankton-baymax-update', 'plankton-baymax-plan']

/** A fresh registry holding the REAL baymax pack (the load-time-validated declaration). */
function realRegistry() {
  const registry = M.createPackRegistry()
  const result = registry.register(M.BAYMAX_DECLARATION)
  assert.equal(result.ok, true, `the real declaration must load: ${JSON.stringify(result)}`)
  return registry
}

/** A capturing ctx — the host's registration point, recorded (not a fake render). */
function capturingCtx() {
  const contributions = []
  return {
    storage: { get: (_k, fallback) => fallback, set: () => {}, remove: () => {} },
    registerMany: (cs) => contributions.push(...cs),
    register: (c) => contributions.push(c),
    _contributions: contributions,
  }
}

// ── 1 · the directive form (new carrier's flat-kv reference) ─────────────────

test('directive name: lowercase [a-z0-9-], ≤64 — anything else is never claimed', () => {
  assert.equal(M.isDirectiveName('plankton-baymax-new'), true)
  assert.equal(M.isDirectiveName('task-1'), true)
  assert.equal(M.isDirectiveName('Task'), false) // uppercase
  assert.equal(M.isDirectiveName('a b'), false) // space
  assert.equal(M.isDirectiveName('9task'), false) // must start a-z
  assert.equal(M.isDirectiveName('x'.repeat(65)), false) // 65 > 64
  assert.equal(M.isDirectiveName('x'.repeat(64)), true) // 64 ok
})

test('reference key: flat kv `key` (trimmed); empty / non-string ⇒ null', () => {
  assert.equal(M.directiveReference({ key: 'tree-1' }), 'tree-1')
  assert.equal(M.directiveReference({ key: '  tree-1  ' }), 'tree-1')
  assert.equal(M.directiveReference({ key: '   ' }), null)
  assert.equal(M.directiveReference({ key: 7 }), null)
  assert.equal(M.directiveReference({ other: 'x' }), null)
  assert.equal(M.directiveReference(null), null)
})

test('blockForDirective: a directive name maps to a DECLARED block tag, nothing else', () => {
  const registry = realRegistry()
  for (const tag of BLOCK_TAGS) {
    const hit = M.blockForDirective(registry, tag)
    assert.ok(hit, `declared tag must resolve: ${tag}`)
    assert.equal(String(hit.block.tag), tag)
    assert.equal(hit.pack.id, 'baymax')
  }
  assert.equal(M.blockForDirective(registry, 'plankton-baymax-nope'), null)
  assert.equal(M.blockForDirective(registry, 'NotADirective'), null)
})

// ── 2 · 取块 → 过协议 → 落卡片 (reference payload self-fetched) ───────────────

test('land(): reference key is SELF-FETCHED — the message carries no payload', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const seenRefs = []
  const payload = { block: 'plankton-baymax-new', key: 'tree-1', record: { title: '修复登录' }, actions: ['confirm-create', 'discard'] }
  const renderer = M.createPackRenderer({
    registry,
    session,
    loadPayload: (ref) => {
      seenRefs.push(ref)
      return payload
    },
  })
  const model = await renderer.land({ name: 'plankton-baymax-new', attrs: { key: 'tree-1' } })
  assert.deepEqual(seenRefs, ['tree-1'], 'the renderer must fetch by the reference key')
  assert.equal(model.ok, true)
  assert.equal(model.kind, 'card')
  assert.equal(model.packId, 'baymax')
  const fieldKeys = model.card.fields.map((f) => f.key)
  assert.ok(fieldKeys.includes('title'), 'the card must carry the declared title field')
  assert.ok(model.output.actions.map((a) => a.id).includes('confirm-create'))
})

test('land(): a collection block renders as a PRESENTATION (table + host-computed stats)', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const record = { issueKey: 'PM-1', title: 'A', status: '进行中', assignee: '陈涛', estimateEnd: '2026-10-10' }
  const renderer = M.createPackRenderer({ registry, session, loadPayload: () => ({ block: 'plankton-baymax-plan', records: [record], actions: ['refresh'] }) })
  const model = await renderer.land({ name: 'plankton-baymax-plan', attrs: { key: 'plan-1' } })
  assert.equal(model.ok, true)
  assert.equal(model.kind, 'presentation')
  assert.equal(model.presentation.primitive, 'table')
  assert.ok(model.presentation.stats, 'host computes the stats from the same records')
})

test('land(): every refusal degrades to text — undeclared name / missing ref / unresolved / bad payload', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const base = { registry, session, loadPayload: () => ({ block: 'plankton-baymax-new', record: { title: 'x' } }) }
  const renderer = M.createPackRenderer(base)

  const undeclared = await renderer.land({ name: 'plankton-baymax-nope', attrs: { key: 'k' } })
  assert.equal(undeclared.ok, false)
  assert.equal(undeclared.reason, 'directive-not-declared')

  const noRef = await renderer.land({ name: 'plankton-baymax-new', attrs: {} })
  assert.equal(noRef.ok, false)
  assert.equal(noRef.reason, 'directive-reference-missing')

  const unresolved = await M.createPackRenderer({ registry, session, loadPayload: () => null }).land({ name: 'plankton-baymax-new', attrs: { key: 'k' } })
  assert.equal(unresolved.ok, false)
  assert.equal(unresolved.reason, 'payload-unresolved')

  // A declared block carrying an undeclared field key ⇒ resolveOutput refuses (宁缺勿猜).
  const badPayload = await M.createPackRenderer({ registry, session, loadPayload: () => ({ block: 'plankton-baymax-new', record: { nope: 'x' } }) }).land({ name: 'plankton-baymax-new', attrs: { key: 'k' } })
  assert.equal(badPayload.ok, false)
  assert.equal(badPayload.reason, 'field-not-declared')
})

// ── 3 · the host registers the directive components (real registration) ──────

test('carrierDirectiveContributions(): one `transcript.directives` contribution per declared block', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const contributions = M.carrierDirectiveContributions({
    registry,
    renderer: M.createPackRenderer({ registry, session }),
    runAction: async () => ({ ok: true }),
    identityProvider: { current: () => null, refresh: async () => null },
  })
  const names = contributions.map((c) => c.data.name)
  assert.deepEqual([...names].sort(), [...BLOCK_TAGS].sort(), 'exactly the declared block tags, nothing extra')
  for (const c of contributions) {
    assert.equal(c.area, M.CARRIER_AREA)
    assert.equal(c.area, 'transcript.directives')
    assert.equal(typeof c.data.render, 'function')
  }
})

test('the directive component RENDERS (render() produces an element; a refused ref degrades to source)', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const contributions = M.carrierDirectiveContributions({
    registry,
    renderer: M.createPackRenderer({ registry, session, loadPayload: () => ({ block: 'plankton-baymax-new', record: { title: 'x' }, actions: ['confirm-create'] }) }),
    runAction: async () => ({ ok: true }),
    identityProvider: { current: () => null, refresh: async () => null },
  })
  const card = contributions.find((c) => c.data.name === 'plankton-baymax-new')
  const el = card.data.render({ attrs: { key: 'k' }, source: '::plankton-baymax-new{key="k"}', streaming: false })
  assert.ok(el && typeof el === 'object', 'render returns a React element')
  assert.equal(el.__el, 'CarrierDirective', 'the host-mounted component is the carrier card')

  // A name that is claimed but whose reference cannot resolve degrades to the
  // ORIGINAL source text (markdown fallback: content is never lost).
  const refused = M.carrierDirectiveContributions({ registry, renderer: M.createPackRenderer({ registry, session, loadPayload: () => null }), runAction: async () => ({ ok: true }), identityProvider: { current: () => null } })
  const el2 = refused.find((c) => c.data.name === 'plankton-baymax-new').data.render({ attrs: { key: 'k' }, source: '::plankton-baymax-new{key="k"}', streaming: false })
  assert.ok(el2 && typeof el2 === 'object', 'still an element while the async load resolves (loading state)')
})

test('register(ctx): the plugin REALLY registers the carrier directives on the host', () => {
  const ctx = capturingCtx()
  M.default.register(ctx)
  const directives = ctx._contributions.filter((c) => c.area === 'transcript.directives')
  const names = directives.map((c) => c.data.name)
  assert.deepEqual([...names].sort(), [...BLOCK_TAGS].sort(), 'register() must claim every declared block tag')
  assert.ok(ctx._contributions.length >= 7, 'the two pages + two navs + the three carrier directives')
})

// ── 4 · the write path is W3's, unchanged (确认 + 服务端铸发身份) ───────────────

test('write path: NO identity ⇒ not-signed-in (fail-closed); the directive adds no write door', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  // Build a real draft card through the carrier entry (reference payload).
  const renderer = M.createPackRenderer({ registry, session, loadPayload: () => ({ block: 'plankton-baymax-new', record: { title: '修复登录' }, actions: ['confirm-create'] }) })
  const model = await renderer.land({ name: 'plankton-baymax-new', attrs: { key: 'tree-1' } })
  assert.equal(model.ok, true)

  const identityProvider = M.createIdentityProvider({ read: async () => null })
  await identityProvider.refresh()
  assert.equal(identityProvider.identityOf(), null)

  let spawned = 0
  const executor = M.createPackExecutor({ registry, cliPath: '/fake/shaoke-cli', execFileImpl: (_f, _a, _o, cb) => { spawned += 1; cb(null, '{"ok":true,"data":{"issueKey":"D-1"}}', '') } })
  const actions = M.createPackActions({ registry, executor, session, identityOf: identityProvider.identityOf })
  const result = await actions.run({ packId: 'baymax', cardId: model.card.id, actionId: 'confirm-create' })
  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-signed-in', 'no server-issued identity ⇒ refuse, do not write')
  assert.equal(spawned, 0, 'nothing may be spawned without a concrete confirmer')
})

test('write path: WITH identity the SAME W3 layer runs (server-issued whoami → confirmer)', async () => {
  // A synthetic pack keeps the assertion about the ONE W3 executor, without
  // fighting the real pack's user-designated/lookup gates (already covered by W3).
  const declaration = {
    id: 'demo',
    displayName: 'Demo pack',
    discriminant: 'the envelope ok flag',
    failureMap: { ok: 'written', rejected: 'failed', refused: 'blocked', unparsed: 'write-unknown', timeout: 'write-unknown', 'spawn-error': 'write-unknown' },
    requiredParams: { '+item-create': ['--title'] },
    destructiveParams: [{ name: 'parent-id', semantics: 'reparent' }],
    valueLookup: { title: { template: 'item-list', labelField: 'name', valueField: 'id' } },
    steps: [{ id: 'create-parent', then: 'create-child' }],
    lookupFields: { title: { exists: 'by key' } },
    outputParsing: { envelope: 'ok', itemsPath: 'data.data', totalPath: 'data.total' },
    fieldTiers: { title: 'agent-drafted' },
    landing: { module: 'demo', assemblyPoint: 'demo', note: 'synthetic' },
    skill: ['demo'],
    broadcastPredicate: () => ({ hasContent: false }),
    templates: [
      { id: 'item-create', kind: 'write', module: 'demo', command: '+item-create', required: ['title'], optional: [], args: ['--title', { field: 'title' }], refPath: 'data.issueKey' },
      { id: 'item-list', kind: 'read', module: 'demo', command: '+item-list', required: [], optional: [], shape: 'paged', itemsPath: 'data.data', totalPath: 'data.total', args: [] },
    ],
    requiredBeyondCli: {},
    outputs: { fields: { title: { label: '标题', role: 'title' } }, actions: { 'confirm-create': { label: '确认新建', human: 'confirm', writes: 'item-create' } }, blocks: [{ tag: 'demo-new', record: 'single', fields: ['title'], actions: ['confirm-create'] }] },
    skillDoc: { fileName: 'SKILL.md', markdown: '# demo' },
  }
  const registry = M.createPackRegistry()
  const loaded = registry.register(declaration)
  assert.equal(loaded.ok, true, `synthetic declaration must load: ${JSON.stringify(loaded)}`)

  const session = M.createPackSession()
  const renderer = M.createPackRenderer({ registry, session, loadPayload: () => ({ block: 'demo-new', record: { title: '修复登录' }, actions: ['confirm-create'] }) })
  const model = await renderer.land({ name: 'demo-new', attrs: { key: 'k' } })
  assert.equal(model.ok, true)

  // `planktonAuth.status()` shape: whoami{subject,displayName,email} is normalized by W3.
  const identityProvider = M.createIdentityProvider({ read: async () => ({ ok: true, loggedIn: true, whoami: { subject: 'u-1', displayName: '陈涛', email: null } }) })
  await identityProvider.refresh()
  assert.equal(M.normalizeIdentity(identityProvider.identityOf()), '陈涛')

  let spawned = 0
  const executor = M.createPackExecutor({
    registry,
    cliPath: '/fake/shaoke-cli',
    execFileImpl: (_f, args, opts, cb) => {
      spawned += 1
      assert.equal(opts.shell, false, 'array args, no shell')
      assert.deepEqual(args.slice(0, 2), ['demo', '+item-create'])
      cb(null, '{"ok":true,"data":{"issueKey":"D-1","id":"1"}}', '')
    },
  })
  const actions = M.createPackActions({ registry, executor, session, identityOf: identityProvider.identityOf })
  const result = await actions.run({ packId: 'demo', cardId: model.card.id, actionId: 'confirm-create' })
  assert.equal(spawned, 1, 'the write went through the one W3 executor (spawn = 1)')
  assert.equal(result.ok, true)
  assert.equal(result.outcome.kind, 'ok', 'the action layer handled the outcome through W3')
})

// ── 5 · load-bearing: each core rule turned into a mutant that must go RED ───

test('承重 A：改掉指令注册区 ⇒ register() 不再认领指令（必须变红）', async () => {
  const mutant = await loadPlugin(SOURCE.replace("const CARRIER_AREA = 'transcript.directives'", "const CARRIER_AREA = 'nope.not.directives'"))
  const ctx = capturingCtx()
  mutant.default.register(ctx)
  assert.equal(ctx._contributions.filter((c) => c.area === 'transcript.directives').length, 0, '移除指令区后不应有线上的 directive 贡献')
})

test('承重 B：拿掉身份闸 ⇒ 无身份也会写（必须变红）', async () => {
  const mutant = await loadPlugin(SOURCE.replace("if (!identity) return { ok: false, reason: 'not-signed-in' }", 'if (!identity) { /* removed */ }'))
  const registry = mutant.createPackRegistry()
  registry.register(mutant.BAYMAX_DECLARATION)
  const session = mutant.createPackSession()
  const renderer = mutant.createPackRenderer({ registry, session, loadPayload: () => ({ block: 'plankton-baymax-new', record: { title: 'x' }, actions: ['confirm-create'] }) })
  const model = await renderer.land({ name: 'plankton-baymax-new', attrs: { key: 'k' } })
  let spawned = 0
  const executor = mutant.createPackExecutor({ registry, cliPath: '/fake', execFileImpl: (_f, _a, _o, cb) => { spawned += 1; cb(null, '{"ok":true,"data":{"issueKey":"D-1"}}', '') } })
  const identityProvider = mutant.createIdentityProvider({ read: async () => null })
  await identityProvider.refresh()
  const actions = mutant.createPackActions({ registry, executor, session, identityOf: identityProvider.identityOf })
  const result = await actions.run({ packId: 'baymax', cardId: model.card.id, actionId: 'confirm-create' })
  assert.notEqual(result.reason, 'not-signed-in', 'with the gate removed the refusal is gone — the gate is load-bearing')
})

test('承重 C：拿掉「从 attrs 取引用键」⇒ 引用式载荷落空（必须变红）', async () => {
  const mutant = await loadPlugin(SOURCE.replace('const ref = directiveReference(attrs)', 'const ref = null /* mutated */'))
  const registry = mutant.createPackRegistry()
  registry.register(mutant.BAYMAX_DECLARATION)
  const session = mutant.createPackSession()
  const renderer = mutant.createPackRenderer({ registry, session, loadPayload: () => ({ block: 'plankton-baymax-new', record: { title: 'x' } }) })
  const result = await renderer.land({ name: 'plankton-baymax-new', attrs: { key: 'k' } })
  assert.equal(result.ok, false, 'with the reference read removed nothing resolves')
  assert.equal(result.reason, 'directive-reference-missing', 'the reference key is load-bearing')
})
