/**
 * 批 3 · 收尾 —— 新建草稿卡的**提案入口**（提案块 + 提案口 + 人类字段硬约束）。
 *
 * 设计：docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
 * §0 / §8（批 3 · 新建草稿卡的提案入口，Perry 2026-10-07 裁定「要」）。
 *
 * 背景：「新建」块的记录**没有台账对象可读**（它是 agent 交上来的草稿），所以只读读路径
 * 永远取不到它。本批新增**一个 agent 工具**（`plankton_propose_draft`，见 `proposals.py`）
 * 把草稿提案存成**具名提案**并返回**引用键**；渲染器按引用键到**提案口**解析成草稿卡。
 *
 * 本文件在**渲染侧**钉住四条：
 *   ① **声明驱动**：只有声明为提案块（`source.proposals`）的块走提案口；别的块不走；
 *   ② **命名空间＝包**：引用键 `<packId>:<token>` 里的包必须与指令所在包一致（多提案不串）；
 *   ③ **取不到 ⇒ 退化文本**（内容不丢）：不可解引用 / 过期 / 异包 一律 `payload-unresolved`；
 *   ④ **不点确认 ⇒ 零写入**：整条渲染链不碰执行器（spawn 计数恒 0）；写仍只经 W3 身份闸 + 确认。
 *
 * 承重（每个核心判据配一条突变，拿掉即变红）：
 *   · 承重 G：拿掉「提案块闸」⇒ 非提案块也用提案键取数（画出一张来路不明的卡）；
 *   · 承重 H：拿掉「命名空间闸」⇒ 别的包的提案键也能解成卡（多提案互串）；
 *   · 承重 I：拿掉「身份闸（两层）」⇒ 无身份也直接写（spawn>0）—— 证明写仍由身份闸兜底。
 *
 * 跑法（文件，不是目录）：
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-w6-proposal.test.mjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-w6-'))
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

/** 提案块（新建）与读块（计划）——真实声明，用来验证「声明驱动分流」。 */
const NEW_BLOCK = 'plankton-baymax-new'
const PLAN_BLOCK = 'plankton-baymax-plan'
const REF = 'baymax:0123456789ab'

function proposalLoader({ registry = realRegistry(), fetchProposal, calls = [] } = /** @type {any} */ ({})) {
  return M.createProposalLoader({
    registry,
    fetchProposal: fetchProposal ?? (async (req) => { calls.push(req); return { kind: 'ok', proposal: { record: { title: '修复登录' }, actions: ['confirm-create', 'discard'] } } }),
  })
}

const blockOf = (registry, tag) => M.blockForDirective(registry, tag).block

// ── 1 · 引用键与提案块（声明驱动）───────────────────────────────────────────

test('isProposalBlock: only a block declaring `source.proposals` is a proposal block', () => {
  const registry = realRegistry()
  assert.equal(M.isProposalBlock(blockOf(registry, NEW_BLOCK)), true, 'the new-draft block is proposal-sourced')
  assert.equal(M.isProposalBlock(blockOf(registry, PLAN_BLOCK)), false, 'a ledger-read block is NOT a proposal block')
  assert.equal(M.isProposalBlock({ tag: 'x', source: {} }), false)
  assert.equal(M.isProposalBlock({ tag: 'x', source: { proposals: false } }), false)
  assert.equal(M.isProposalBlock({ tag: 'x' }), false)
  assert.equal(M.isProposalBlock(null), false)
})

test('parseProposalReference: `<packId>:<token>`; junk / other shapes ⇒ null', () => {
  assert.deepEqual(M.parseProposalReference('baymax:0123456789ab'), { packId: 'baymax', token: '0123456789ab' })
  assert.deepEqual(M.parseProposalReference('  baymax:deadbeef  '), { packId: 'baymax', token: 'deadbeef' })
  assert.equal(M.parseProposalReference('list-issues?project-id=1'), null, 'a READ ADDRESS is not a proposal ref')
  assert.equal(M.parseProposalReference('baymax:'), null)
  assert.equal(M.parseProposalReference(':0123456789ab'), null)
  assert.equal(M.parseProposalReference('Baymax:0123456789ab'), null, 'uppercase pack is not a slug')
  assert.equal(M.parseProposalReference('baymax:ZZZZ'), null, 'token is lowercase hex')
  assert.equal(M.parseProposalReference(''), null)
  assert.equal(M.parseProposalReference(null), null)
})

// ── 2 · 提案口真的解析（引用键 → 草稿卡）────────────────────────────────────

test('提案口：land() 按引用键取回提案并落成**草稿卡**（人在卡上给人类字段）', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const seen = []
  const proposalPath = proposalLoader({ registry, calls: seen })
  const renderer = M.createPackRenderer({
    registry,
    session,
    loadPayload: (ref, context) => M.isProposalBlock(context.block)
      ? proposalPath.load(ref, context)
      : null,
  })
  const model = await renderer.land({ name: NEW_BLOCK, attrs: { key: REF } })
  assert.deepEqual(seen, [{ packId: 'baymax', ref: REF }], 'the ref must be fetched through the proposal port, namespaced by pack')
  assert.equal(model.ok, true, JSON.stringify(model))
  assert.equal(model.kind, 'card', 'a single-record block lands as a CARD (draft)')
  const byKey = Object.fromEntries(model.card.fields.map((f) => [f.key, f.value]))
  assert.equal(byKey.title, '修复登录', 'the agent-drafted field is on the card')
  // 人类字段（类型/项目）没值 ⇒ 卡片显示「等你给」，而不是被 agent 填上
  assert.equal(byKey['type-id'], '', 'a human-designated field the agent did not supply stays EMPTY')
  assert.equal(byKey['project-id'], '', 'a human-designated field the agent did not supply stays EMPTY')
  assert.equal(model.card.state, 'draft', 'a proposal card is a DRAFT — never written by merely rendering it')
})

test('提案口：不是提案块就不认（读块 / 未声明块），取不到 ⇒ 退化文本', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  let fetched = 0
  const resolver = proposalLoader({ registry, fetchProposal: async () => { fetched += 1; return { kind: 'ok', proposal: { record: { title: 'x' } } } } })
  // (a) a ledger-read block must NOT resolve through the proposal port
  const readBlock = await resolver.load(REF, { packId: 'baymax', block: blockOf(registry, PLAN_BLOCK) })
  assert.equal(readBlock, null, 'a non-proposal block is refused by the proposal port')
  assert.equal(fetched, 0, 'a non-proposal block never even reaches the proposal port')

  // (b) the renderer degrades when the port answers nothing (unknown / expired / foreign).
  const missing = M.createProposalLoader({ registry, fetchProposal: async () => ({ kind: 'rejected', note: 'proposal-unresolved' }) })
  const renderer = M.createPackRenderer({
    registry,
    session,
    loadPayload: (ref, context) => M.isProposalBlock(context.block) ? missing.load(ref, context) : null,
  })
  const miss = await renderer.land({ name: NEW_BLOCK, attrs: { key: 'baymax:ffffffffffff' } })
  assert.equal(miss.ok, false)
  assert.equal(miss.reason, 'payload-unresolved', 'an unresolvable ref degrades to text (content kept)')
})

test('提案口：提案带未声明字段键 / 人类字段无佐证 ⇒ 整块拒（退化为文本，宁缺勿猜）', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const land = (record) => M.createPackRenderer({
    registry,
    session,
    loadPayload: () => ({ block: NEW_BLOCK, record }),
  }).land({ name: NEW_BLOCK, attrs: { key: REF } })

  const undeclared = await land({ nope: 'x' })
  assert.equal(undeclared.ok, false)
  assert.equal(undeclared.reason, 'field-not-declared')

  // 纵深（主闸在提案工具那一侧，见 pytest）：即便一个人类字段溜进载荷，只要它**有值而没佐证**，
  // 卡片也造不出来 ⇒ 退化文本。agent 填不了只有人能给的事实。
  const human = await land({ title: 'x', 'assignee-id': '42' })
  assert.equal(human.ok, false)
  assert.equal(human.reason, 'human-value-needs-attestation', 'a human-tier value without attestation cannot become a card')
})

// ── 3 · 不点确认 ⇒ 零写入（整条渲染链不碰执行器）──────────────────────────

test('不点确认 ⇒ 零写入：渲染卡片 / 挂载指令组件都不触达执行器（spawn = 0）', async () => {
  const registry = realRegistry()
  const session = M.createPackSession()
  const spawns = { read: 0, write: 0 }
  const executor = {
    async runRead() { spawns.read += 1; return { kind: 'ok', envelope: { ok: true, data: {} } } },
    async runTemplate() { spawns.write += 1; return { kind: 'ok', ref: 'X-1', envelope: { ok: true, data: {} } } },
  }
  const actions = M.createPackActions({ registry, executor, session, identityOf: () => ({ whoami: { displayName: '陈涛' } }) })
  const proposalPath = proposalLoader({ registry })
  const renderer = M.createPackRenderer({
    registry,
    session,
    loadPayload: (ref, context) => M.isProposalBlock(context.block) ? proposalPath.load(ref, context) : null,
  })
  const model = await renderer.land({ name: NEW_BLOCK, attrs: { key: REF } })
  assert.equal(model.ok, true)
  // 挂载指令组件（返回元素；onClick 未触发）
  const contributions = M.carrierDirectiveContributions({
    registry,
    renderer,
    runAction: (args) => actions.run(args),
    identityProvider: { current: () => ({ whoami: { displayName: '陈涛' } }), refresh: async () => ({}) },
  })
  const card = contributions.find((c) => c.data.name === NEW_BLOCK)
  const el = card.data.render({ attrs: { key: REF }, source: `::${NEW_BLOCK}{key="${REF}"}`, streaming: false })
  assert.ok(el && typeof el === 'object', 'the directive component mounts')
  assert.deepEqual(spawns, { read: 0, write: 0 }, '渲染/挂载一律不得写入台账（确认是唯一入口）')
  assert.equal(session.presentations().length, 1, 'the draft card is held in the session store')
  assert.equal(session.presentations()[0].state, 'draft')
})

// ── 4 · register() 的装配：声明驱动分流经 ctx.rest 走两个口 ───────────────────

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

test('register(): 提案块的引用键走 `/packs/proposal`，读块仍走 `/packs/read`（分流只有一处）', async () => {
  const ctx = capturingCtx()
  const seen = []
  ctx.rest = async (p, init) => {
    seen.push({ path: p, body: init?.body })
    if (p === '/packs/proposal') return { kind: 'ok', proposal: { record: { title: '修复登录' }, actions: ['confirm-create'] } }
    return { kind: 'ok', envelope: { ok: true, data: { total: 1, data: [{ issueKey: 'PM-1', title: 'A' }] } } }
  }
  M.default.register(ctx)

  // Rebuild the SAME composition register() builds, then drive each block.
  const registry = M.createPackRegistry()
  registry.register(M.BAYMAX_DECLARATION)
  const session = M.createPackSession()
  const readPath = M.createReadPathLoader({ registry, runRead: M.createHostReadBridge(ctx.rest) })
  const proposalPath = M.createProposalLoader({ registry, fetchProposal: M.createHostProposalBridge(ctx.rest) })
  const renderer = M.createPackRenderer({
    registry,
    session,
    loadPayload: (ref, context) => M.isProposalBlock(context?.block) ? proposalPath.load(ref, context) : readPath.load(ref, context),
  })

  const card = await renderer.land({ name: NEW_BLOCK, attrs: { key: REF } })
  assert.equal(card.ok, true, JSON.stringify(card))
  assert.equal(seen[0].path, '/packs/proposal')
  assert.deepEqual(seen[0].body, { packId: 'baymax', ref: REF })

  const table = await renderer.land({ name: PLAN_BLOCK, attrs: { key: 'list-issues?project-id=1' } })
  assert.equal(table.ok, true, JSON.stringify(table))
  assert.equal(seen[1].path, '/packs/read', 'the ledger-read block still goes through the read port')
})

// ── 5 · 承重：拿掉核心判据即变红 ──────────────────────────────────────────

/** Short-circuit one exact anchor (must exist exactly once). */
async function mutated(from, to) {
  const first = SOURCE.indexOf(from)
  assert.notEqual(first, -1, `mutation anchor not found: ${from}`)
  assert.equal(SOURCE.indexOf(from, first + 1), -1, `mutation anchor is not unique: ${from}`)
  return loadPlugin(SOURCE.slice(0, first) + to + SOURCE.slice(first + from.length))
}

test('承重 G：拿掉「提案块闸」⇒ 非提案块也用提案键取数（必须变红）', async () => {
  const mutant = await mutated('if (!isProposalBlock(block)) return null', 'if (false) return null')
  const registry = mutant.createPackRegistry()
  registry.register(mutant.BAYMAX_DECLARATION)
  const loader = mutant.createProposalLoader({ registry, fetchProposal: async () => ({ kind: 'ok', proposal: { record: { title: 'x' } } }) })
  const hit = await loader.load(REF, { packId: 'baymax', block: blockOf(registry, PLAN_BLOCK) })
  assert.ok(hit, 'without the proposal-block gate a LEDGER-READ block resolves through the proposal port — the gate is load-bearing')
})

test('承重 H：拿掉「命名空间闸」⇒ 别的包的提案键也能解（必须变红）', async () => {
  const mutant = await mutated('if (String(packId) !== address.packId) return null', 'if (false) return null')
  const registry = mutant.createPackRegistry()
  registry.register(mutant.BAYMAX_DECLARATION)
  const loader = mutant.createProposalLoader({ registry, fetchProposal: async () => ({ kind: 'ok', proposal: { record: { title: 'x' } } }) })
  const foreign = await loader.load('other:0123456789ab', { packId: 'baymax', block: blockOf(registry, NEW_BLOCK) })
  assert.ok(foreign, 'without the namespace gate ANOTHER pack\'s ref resolves under this pack — proposals would cross-talk')
})

/**
 * 承重 I 的夹具：一个最小的合成声明 + 假会话（与 W3 的 `demo()`/`fakeSession` 同源）。
 * 只用到「确认一个草稿卡 ⇒ 经身份闸落到一次写」这条路径。
 */
function demo() {
  return {
    id: 'demo', displayName: 'Demo pack',
    discriminant: 'the envelope ok flag',
    failureMap: { ok: 'written', rejected: 'failed', refused: 'blocked', unparsed: 'write-unknown', timeout: 'write-unknown', 'spawn-error': 'write-unknown' },
    requiredParams: { '+item-create': ['--project-id', '--title'], '+item-get': ['--project-id', '--id'], '+project-list': [] },
    destructiveParams: [{ name: 'parent-id', semantics: 'reparent' }],
    valueLookup: { 'project-id': { template: 'project-list', labelField: 'name', valueField: 'id' }, id: { readback: 'by key' } },
    steps: [{ id: 'create', then: 'create' }],
    lookupFields: { title: { exists: 'by key' } },
    outputParsing: { envelope: 'ok', itemsPath: 'data.data', totalPath: 'data.total' },
    fieldTiers: { title: 'agent-drafted', 'project-id': 'user-designated', id: 'user-designated' },
    landing: { module: 'demo', assemblyPoint: 'demo', note: 'synthetic' },
    skill: ['demo'], broadcastPredicate: () => ({ hasContent: false }),
    templates: [
      { id: 'item-create', kind: 'write', module: 'demo', command: '+item-create', required: ['project-id', 'title'], optional: [], args: ['--project-id', { field: 'project-id' }, '--title', { field: 'title' }], refPath: 'data.issueKey', readback: { template: 'item-get', idFrom: 'data.id', scope: ['project-id'], check: [{ field: 'title', read: 'title' }] } },
      { id: 'item-get', kind: 'read', module: 'demo', command: '+item-get', required: ['project-id', 'id'], optional: [], shape: 'object', args: [] },
      { id: 'project-list', kind: 'read', module: 'demo', command: '+project-list', required: [], optional: [], shape: 'paged', itemsPath: 'data.data', totalPath: 'data.total', args: [] },
    ],
    requiredBeyondCli: {},
    outputs: {
      fields: { title: { label: '标题', role: 'title' }, 'project-id': { label: '项目', role: '' }, id: { label: 'id', role: '' } },
      actions: { 'confirm-create': { label: '确认新建', human: 'confirm', writes: 'item-create' }, discard: { label: '丢草稿', human: 'discard' } },
      blocks: [{ tag: 'demo-new', record: 'single', fields: ['title', 'project-id'], actions: ['confirm-create', 'discard'] }],
    },
    skillDoc: { fileName: 'SKILL.md', markdown: '# demo' },
  }
}

/** A draft card about to be confirmed (the proposal card's shape: agent-drafted text + a human field already attested). */
function draftCard() {
  return {
    id: 'demo-new:abc', title: 'Demo card', state: 'draft', confirmedBy: null,
    fields: [
      { key: 'title', label: '标题', value: '修复登录', tier: 'agent-drafted', source: 'agent' },
      { key: 'project-id', label: '项目', value: '1', tier: 'user-designated', source: 'human', attestation: { kind: 'lookup', field: 'project-id' } },
    ],
  }
}

function fakeSession(card) {
  let current = card
  return {
    get: () => current,
    replace: (next) => { current = next; return { ok: true, card: next } },
    confirm: (id, { by }) => { current = { ...current, state: 'confirmed', confirmedBy: by }; return { ok: true, card: current } },
    discard: () => { current = { ...current, state: 'discarded' }; return { ok: true, card: current } },
    reopen: () => { current = { ...current, state: 'draft' }; return { ok: true, card: current } },
    presentations: () => [current],
    current: () => current,
  }
}

function writeCountingExecutor() {
  const counts = { read: 0, write: 0 }
  return {
    counts,
    async runRead() { counts.read += 1; return { kind: 'ok', envelope: { ok: true, data: { data: [{ id: '1', name: 'P1' }], total: 1 } } } },
    async runTemplate() { counts.write += 1; return { kind: 'ok', ref: 'D-99', envelope: { ok: true, data: { id: '99', issueKey: 'D-99' } } } },
  }
}

test('承重 I：拿掉「身份闸（两层）」⇒ 无身份也直接写（必须变红）', async () => {
  // 正控：有服务端铸发身份 ⇒ 确认一张草稿卡 ⇒ 恰好一次写。
  {
    const registry = M.createPackRegistry()
    assert.equal(registry.register(demo()).ok, true)
    const session = fakeSession(draftCard())
    const executor = writeCountingExecutor()
    const actions = M.createPackActions({ registry, executor, session, identityOf: () => ({ whoami: { displayName: '陈涛' } }) })
    const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
    assert.equal(res.ok, true, JSON.stringify(res))
    assert.equal(executor.counts.write, 1, '正控：有身份、人在卡上确认 ⇒ 恰好一次写')
  }

  // 反例：没有身份 ⇒ fail-closed 拒写，零 spawn。
  {
    const registry = M.createPackRegistry()
    assert.equal(registry.register(demo()).ok, true)
    const executor = writeCountingExecutor()
    const actions = M.createPackActions({ registry, executor, session: fakeSession(draftCard()), identityOf: () => null })
    const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
    assert.equal(res.ok, false)
    assert.equal(res.reason, 'not-signed-in')
    assert.equal(executor.counts.write, 0, '无身份 ⇒ 零写入（fail-closed）')
  }

  // 突变：拿掉身份闸的两层（编排层 `not-signed-in` + 卡片层 `missing-confirmer`）⇒ 无身份也写出去。
  let src = SOURCE
    .replace("if (!identity) return { ok: false, reason: 'not-signed-in' }", "if (false) return { ok: false, reason: 'not-signed-in' }")
    .replace("if (!String(by ?? '').trim()) return { ok: false, reason: 'missing-confirmer', card }", "if (false) return { ok: false, reason: 'missing-confirmer', card }")
  assert.notEqual(src, SOURCE, 'both mutation anchors must land')
  const mutant = await loadPlugin(src)
  const registry = mutant.createPackRegistry()
  assert.equal(registry.register(demo()).ok, true)
  const session = fakeSession(draftCard())
  const executor = writeCountingExecutor()
  const actions = mutant.createPackActions({ registry, executor, session, identityOf: () => null })
  const res = await actions.run({ packId: 'demo', cardId: 'demo-new:abc', actionId: 'confirm-create' })
  assert.equal(executor.counts.write, 1, '拿掉身份闸两层后，无身份也写出去了 —— 身份闸是承重的（写仍只由它兜底）')
  assert.notEqual(res.ok, false, 'the mutated run no longer refuses')
})
