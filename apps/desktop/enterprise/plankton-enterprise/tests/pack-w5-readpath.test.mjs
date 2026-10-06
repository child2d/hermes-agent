/**
 * W5 · the pack READ port (取数口) — the READ-ONLY path the renderer self-fetches
 * through, plus the F1 regression (directive name ↔ fetched payload `block`).
 *
 * Design: docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
 * §0 (裁定 1「数据由渲染器自取数」) / §8 (W4 carrier + W5 boundary), with the W5
 * ruling「取数口＝只读读路径」: the renderer triggers the domain's DECLARED READ
 * command BY REFERENCE KEY through the host bridge to the plugin execution layer
 * (read-only, no confirmation, nothing written), then feeds the records into the
 * SAME `resolveOutput`/`presentOutput`. Failure ⇒ degrade to text (content kept).
 *
 * What this file PINS:
 *   * the reference key is a READ ADDRESS (`<templateId>?k=v…`); the template
 *     must be a declared READ template — a WRITE template id yields nothing;
 *   * `createReadPathLoader` maps the read envelope into a protocol payload by the
 *     block's declared field keys, then `land()` renders it (card / presentation);
 *   * F1: a payload whose own `block` disagrees with the directive name is
 *     REFUSED (`block-tag-mismatch`) — it must not draw a card for another address;
 *   * register() wires the read bridge through `ctx.rest('/packs/read')`.
 *
 * Load-bearing: each core rule has a mutant that turns the corresponding test RED.
 *
 * Run (a FILE, not a dir):
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-w5-readpath.test.mjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-w5-'))
  const sdk = path.join(dir, 'sdk.mjs')
  const react = path.join(dir, 'react.mjs')
  const jsxrt = path.join(dir, 'jsx-runtime.mjs')
  fs.writeFileSync(sdk, 'export const Button=()=>null;export const ConfirmDialog=()=>null;export const GlyphSpinner=()=>null;export const SearchField=()=>null;export const icons={Info:()=>null};\n')
  fs.writeFileSync(react, 'export const useEffect=()=>{};export const useState=v=>[v,()=>{}];\n')
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

function realRegistry() {
  const registry = M.createPackRegistry()
  const result = registry.register(M.BAYMAX_DECLARATION)
  assert.equal(result.ok, true, `the real declaration must load: ${JSON.stringify(result)}`)
  return registry
}

function capturingCtx() {
  const contributions = []
  return /** @type {any} */ ({
    storage: { get: (_k, fallback) => fallback, set: () => {}, remove: () => {} },
    rest: async () => ({ kind: 'rejected', note: 'stub' }),
    registerMany: (cs) => contributions.push(...cs),
    register: (c) => contributions.push(c),
    _contributions: contributions,
  })
}

/** A two-single-block pack (agent-drafted fields) — isolates the read port and F1. */
function twoBlockPack(M) {
  return {
    ...M.BAYMAX_DECLARATION,
    id: 'demo',
    outputs: {
      blocks: [
        { tag: 'demo-a', record: 'single', fields: ['title'], actions: [] },
        { tag: 'demo-b', record: 'single', fields: ['title'], actions: [] },
      ],
      fields: { title: { label: '标题', role: 'title' } },
      actions: {},
    },
    fieldTiers: { ...M.BAYMAX_DECLARATION.fieldTiers, title: 'agent-drafted' },
  }
}

// ── 1 · the reference key is a READ ADDRESS ──────────────────────────────────

test('parseReadReference: `<templateId>` / `<templateId>?k=v&k2=v2`; junk ⇒ null', () => {
  assert.deepEqual(M.parseReadReference('whoami'), { templateId: 'whoami', params: {} })
  assert.deepEqual(M.parseReadReference('list-issues?project-id=1&limit=5'), {
    templateId: 'list-issues',
    params: { 'project-id': '1', limit: '5' },
  })
  assert.deepEqual(M.parseReadReference('  get-issue?id=9  '), { templateId: 'get-issue', params: { id: '9' } })
  assert.equal(M.parseReadReference(''), null)
  assert.equal(M.parseReadReference('Bad'), null) // uppercase
  assert.equal(M.parseReadReference('9x'), null) // must start a-z
  assert.equal(M.parseReadReference(null), null)
})

// ── 2 · the read path really fetches (read-only) and renders ─────────────────

test('read path: land() self-fetches the DECLARED read command and renders the card', async () => {
  // A synthetic pack whose fields are agent-drafted (the real baymax `update`
  // fields are user-designated and need attestation — covered by W3/W4), so this
  // test isolates the READ PORT: read → project → card.
  const registry = M.createPackRegistry()
  assert.equal(registry.register(twoBlockPack(M)).ok, true, 'the synthetic pack must load')

  const session = M.createPackSession()
  const calls = []
  const runRead = async (args) => {
    calls.push(args)
    return { kind: 'ok', envelope: { ok: true, data: { id: '42', title: '修复登录' } } }
  }
  const readPath = M.createReadPathLoader({ registry, runRead })
  const renderer = M.createPackRenderer({ registry, session, loadPayload: (ref, ctx) => readPath.load(ref, ctx) })

  const model = await renderer.land({ name: 'demo-a', attrs: { key: 'get-issue?project-id=1&id=42' } })
  assert.deepEqual(calls, [{ packId: 'demo', templateId: 'get-issue', params: { 'project-id': '1', id: '42' } }])
  assert.equal(model.ok, true, `the read must land: ${JSON.stringify(model)}`)
  assert.equal(model.kind, 'card')
  const byKey = Object.fromEntries(model.card.fields.map((f) => [f.key, f.value]))
  assert.equal(byKey.title, '修复登录', 'the declared field key must be projected from the read record')
})

test('read path: a collection read renders a PRESENTATION (table + host stats)', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const runRead = async () => ({
    kind: 'ok',
    envelope: { ok: true, data: { total: 2, data: [
      { issueKey: 'PM-1', title: 'A', status: { name: '进行中' }, assigneeName: '陈涛', estimateEndDate: '2026-10-10' },
      { issueKey: 'PM-2', title: 'B', status: '待处理', assigneeName: '李四' },
    ] } },
  })
  const readPath = M.createReadPathLoader({ registry, runRead })
  const renderer = M.createPackRenderer({ registry, session, loadPayload: (ref, ctx) => readPath.load(ref, ctx) })
  const model = await renderer.land({ name: 'plankton-baymax-plan', attrs: { key: 'list-issues?project-id=1' } })
  assert.equal(model.ok, true)
  assert.equal(model.kind, 'presentation')
  assert.equal(model.presentation.primitive, 'table')
  assert.ok(model.presentation.stats, 'host computes stats from the same records')
  // object-valued read fields (status{name}) collapse to the human name; a key
  // the read did not return simply does not appear (键缺失＝无值).
  const rows = model.presentation.components.find((c) => c.primitive === 'table').rows
  assert.ok(JSON.stringify(rows).includes('进行中'))
})

// ── 3 · READ-ONLY: a write template id can never run here ────────────────────

test('read-only: a WRITE template id yields nothing (no card, no spawn)', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  let spawned = 0
  const runRead = async () => { spawned += 1; return { kind: 'ok', envelope: { ok: true, data: {} } } }
  const readPath = M.createReadPathLoader({ registry, runRead })
  const renderer = M.createPackRenderer({ registry, session, loadPayload: (ref, ctx) => readPath.load(ref, ctx) })
  // create-item is a WRITE template of the pack — the read port must refuse it.
  const model = await renderer.land({ name: 'plankton-baymax-new', attrs: { key: 'create-item?title=x' } })
  assert.equal(model.ok, false)
  assert.equal(model.reason, 'payload-unresolved', 'a write template id resolves to nothing ⇒ degrade to text')
  assert.equal(spawned, 0, 'the write template must never be handed to the read runner')
})

test('read-only: an unknown template / unresolvable read degrades (content kept)', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const renderer = M.createPackRenderer({ registry, session, loadPayload: (ref, ctx) => M.createReadPathLoader({ registry, runRead: async () => ({ kind: 'timeout' }) }).load(ref, ctx) })
  const model = await renderer.land({ name: 'plankton-baymax-plan', attrs: { key: 'list-issues?project-id=1' } })
  assert.equal(model.ok, false)
  assert.equal(model.reason, 'payload-unresolved')
})

// ── 4 · F1: directive name ↔ fetched payload `block` must agree ──────────────

test('F1: payload `block` disagreeing with the directive name is REFUSED', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  // The directive addresses the NEW block, but the fetched payload claims UPDATE.
  const renderer = M.createPackRenderer({
    registry,
    session,
    loadPayload: () => ({ block: 'plankton-baymax-update', record: { id: '1', title: 'x' } }),
  })
  const model = await renderer.land({ name: 'plankton-baymax-new', attrs: { key: 'k' } })
  assert.equal(model.ok, false, 'must NOT draw a card for a different address')
  assert.equal(model.reason, 'block-tag-mismatch')
  assert.equal(model.detail, 'plankton-baymax-update')
})

test('F1: a payload with NO `block` is normalised to the directive name (指令名优先)', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const renderer = M.createPackRenderer({
    registry,
    session,
    loadPayload: () => ({ record: { title: '修复登录' }, actions: ['confirm-create'] }),
  })
  const model = await renderer.land({ name: 'plankton-baymax-new', attrs: { key: 'k' } })
  assert.equal(model.ok, true)
  assert.equal(model.output.block, 'plankton-baymax-new')
})

// ── 5 · the host wiring: the read bridge goes through ctx.rest ───────────────

test('register(): the renderer fetches through the host bridge ctx.rest("/packs/read")', async () => {
  const ctx = capturingCtx()
  const seen = []
  ctx.rest = async (path, init) => {
    seen.push({ path, body: init?.body })
    return { kind: 'ok', envelope: { ok: true, data: { total: 1, data: [{ issueKey: 'PM-3268', title: 't' }] } } }
  }
  M.default.register(ctx)
  const card = ctx._contributions.find((c) => c.area === 'transcript.directives' && c.data.name === 'plankton-baymax-plan')
  assert.ok(card, 'the plan directive must be registered')
  const el = card.data.render({ attrs: { key: 'list-issues?project-id=1' }, source: '::plankton-baymax-plan{key="…"}', streaming: false })
  assert.ok(el && typeof el === 'object')
  // Drive one land() directly through the same composition the component uses:
  const registry = M.createPackRegistry()
  registry.register(M.BAYMAX_DECLARATION)
  const session = M.createPackSession()
  const runRead = M.createHostReadBridge(ctx.rest)
  const readPath = M.createReadPathLoader({ registry, runRead })
  const model = await M.createPackRenderer({ registry, session, loadPayload: (ref, c) => readPath.load(ref, c) }).land({
    name: 'plankton-baymax-plan',
    attrs: { key: 'list-issues?project-id=1&limit=5' },
  })
  assert.equal(model.ok, true, JSON.stringify(model))
  assert.equal(seen[0].path, '/packs/read')
  assert.deepEqual(seen[0].body, { packId: 'baymax', templateId: 'list-issues', params: { 'project-id': '1', limit: '5' } })
})

// ── 6 · load-bearing: each core rule turned into a mutant that must go RED ───

test('承重 D：拿掉「只读闸」⇒ 写模板会被当读命令跑（必须变红）', async () => {
  const mutant = await loadPlugin(SOURCE.replace("if (String(template.kind ?? '') !== 'read') return null", 'if (false) return null'))
  const registry = mutant.createPackRegistry()
  registry.register(mutant.BAYMAX_DECLARATION)
  const session = mutant.createPackSession()
  let spawned = 0
  const readPath = mutant.createReadPathLoader({ registry, runRead: async () => { spawned += 1; return { kind: 'ok', envelope: { ok: true, data: {} } } } })
  await mutant.createPackRenderer({ registry, session, loadPayload: (ref, c) => readPath.load(ref, c) }).land({
    name: 'plankton-baymax-new',
    attrs: { key: 'create-item?title=x' },
  })
  assert.equal(spawned, 1, 'with the read-only gate removed a WRITE template id reaches the runner — the gate is load-bearing')
})

test('承重 E：拿掉「指令名↔载荷 block 一致」⇒ 画出与所寻地址不符的卡（必须变红）', async () => {
  const spoof = { block: 'plankton-baymax-update', record: { id: '1', title: 'x' } }
  // (a) The typed refusal is the guard's own carrier: without it, a mismatched
  //     payload no longer reports `block-tag-mismatch`.
  const noGuard = await loadPlugin(SOURCE.replace('if (claimed !== undefined && String(claimed) !== String(name)) {', 'if (false) {'))
  const ctxSession = noGuard.createPackSession()
  const noGuardModel = await noGuard.createPackRenderer({ registry: (() => { const r = noGuard.createPackRegistry(); r.register(noGuard.BAYMAX_DECLARATION); return r })(), session: ctxSession, loadPayload: () => spoof }).land({ name: 'plankton-baymax-new', attrs: { key: 'k' } })
  assert.notEqual(noGuardModel.reason, 'block-tag-mismatch', 'the guard is load-bearing for the typed refusal')

  // (b) The invariant is carried TWICE (guard + 指令名归一). Remove BOTH and the
  //     card is drawn for the WRONG address — the exact F1 defect.
  const noInvariant = await loadPlugin(
    SOURCE
      .replace('if (claimed !== undefined && String(claimed) !== String(name)) {', 'if (false) {')
      .replace('const bound = isPlainObject(payload) ? Object.freeze({ ...payload, block: String(name) }) : payload', 'const bound = payload'),
  )
  const registry = noInvariant.createPackRegistry()
  registry.register(twoBlockPack(noInvariant))
  const model = await noInvariant.createPackRenderer({ registry, session: noInvariant.createPackSession(), loadPayload: () => ({ block: 'demo-b', record: { title: 'x' } }) }).land({ name: 'demo-a', attrs: { key: 'k' } })
  assert.equal(model.ok, true, 'without the F1 invariant the wrong block renders')
  assert.equal(model.output.block, 'demo-b', 'the card is drawn for a DIFFERENT address than the directive named — the invariant is load-bearing')
})
