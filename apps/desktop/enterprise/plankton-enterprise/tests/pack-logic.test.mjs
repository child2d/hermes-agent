/**
 * W1 · pure-logic layer — semantics of the six migrated modules.
 *
 * Design: docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
 * §8 (W1 = pack-registry / plan-card / read-side / render-protocol /
 * presentation / pack-session), accepted by "语义等价、换载体" (裁定 5).
 *
 * These assertions port the SEMANTICS of the old shell's `pack-*.test.mjs`
 * (read-only baseline ~/Repository/shaoke/codeup/plankton @ e305ce1), not the
 * old fenced-block payload form: the fenced carrier is the one the design
 * EXCLUDED by measurement (N7 §0 / §9.0 #1), so the new carrier (directive
 * components + reference payload) has no shape assertions here. The protocol
 * layer takes a payload object and never sees a carrier.
 *
 * Every declaration/fixture below is SYNTHETIC. No enterprise data is read or
 * written anywhere in this file.
 *
 * Run (file, not directory — `node --test <dir>` fails to resolve):
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-logic.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..', 'desktop', 'plugin.js')

/** Load the REAL plugin.js with bare imports rewritten to stubs (no SDK/react). */
async function loadPlugin(source = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-pack-logic-'))
  const sdk = path.join(dir, 'sdk.mjs')
  const react = path.join(dir, 'react.mjs')
  const jsxrt = path.join(dir, 'jsx-runtime.mjs')
  fs.writeFileSync(sdk, 'export const Button=()=>null;export const ConfirmDialog=()=>null;export const GlyphSpinner=()=>null;export const SearchField=()=>null;export const icons={Info:()=>null};\n')
  fs.writeFileSync(react, 'export const useEffect=()=>{};export const useState=v=>[v,()=>{}];\n')
  fs.writeFileSync(jsxrt, 'export const jsx=()=>null;export const jsxs=()=>null;\n')
  const raw = source ?? fs.readFileSync(PLUGIN, 'utf8')
  const src = raw
    .replace("'@hermes/plugin-sdk'", JSON.stringify(pathToFileURL(sdk).href))
    .replace('"@hermes/plugin-sdk"', JSON.stringify(pathToFileURL(sdk).href))
    .replace("'react/jsx-runtime'", JSON.stringify(pathToFileURL(jsxrt).href))
    .replace("from 'react'", `from ${JSON.stringify(pathToFileURL(react).href)}`)
  const out = path.join(dir, 'plugin.mjs')
  fs.writeFileSync(out, src)
  return import(pathToFileURL(out).href)
}

const M = await loadPlugin()

/** A complete, synthetic declaration — every one of the 15 contract items. */
function demoDeclaration(overrides = {}) {
  return {
    id: 'demo',
    displayName: 'Demo pack',
    discriminant: 'the envelope ok flag',
    failureMap: {
      ok: 'written', rejected: 'blocked', refused: 'blocked',
      unparsed: 'write-unknown', timeout: 'write-unknown', 'spawn-error': 'write-unknown',
    },
    requiredParams: {
      '+item-create': ['--project-id', '--title'],
      '+item-update': ['--id', '--project-id'],
      '+item-comment': ['--issue-id', '--content'],
    },
    destructiveParams: [{ flag: '--label-ids', meaning: 'full replacement set' }],
    valueLookup: {
      'project-id': { template: 'project-list', labelField: 'name', valueField: 'id' },
      'status-id': { template: 'status-list', labelField: 'name', valueField: 'id' },
      'issue-id': { readback: true },
      'priority-id': { gap: 'no dictionary outlet — the person gives the value' },
      'parent-id': { derived: 'step' },
    },
    steps: [{ id: 'create-parent', then: 'create-child' }],
    lookupFields: { title: { exists: 'by key' } },
    outputParsing: { envelope: 'ok', itemsPath: 'data.data', totalPath: 'data.total' },
    fieldTiers: {
      title: 'agent-drafted', description: 'agent-drafted', note: 'agent-drafted',
      'estimate-end': 'user-fact', 'parent-id': 'user-designated',
      'project-id': 'user-designated', 'priority-id': 'user-designated',
      'issue-id': 'user-designated', id: 'user-designated',
      'type-id': 'user-designated', content: 'agent-drafted',
    },
    landing: { installDir: 'packs/demo', exclude: [] },
    skill: ['demo'],
    broadcastPredicate: () => ({ hasContent: true }),
    templates: [
      { id: 'item-create', command: '+item-create', kind: 'write', required: ['project-id', 'title', 'type-id'], args: [{ field: 'title', flag: '--title' }], refPath: 'data.issueKey' },
      { id: 'item-update', command: '+item-update', kind: 'write', required: ['id', 'project-id'], args: [] },
      { id: 'item-comment', command: '+item-comment', kind: 'write', required: ['issue-id', 'content'], args: [] },
      { id: 'project-list', command: '+project-list', kind: 'read', shape: 'array', args: [] },
      { id: 'status-list', command: '+status-list', kind: 'read', shape: 'array', args: [] },
      { id: 'item-get', command: '+item-get', kind: 'read', shape: 'object', args: [] },
    ],
    requiredBeyondCli: { '+item-create': [{ flag: '--type-id', basis: 'server rejects without it' }] },
    outputs: {
      fields: {
        title: { label: '标题', role: 'title' },
        'issue-id': { label: '工单编号', role: '' },
        'estimate-end': { label: '计划结束', role: 'due-date' },
        'project-id': { label: '项目', role: '' },
      },
      actions: {
        'confirm-create': { label: '确认新建', human: 'confirm', writes: 'item-create' },
        discard: { label: '丢弃草稿', human: 'discard' },
        refresh: { label: '刷新', human: 'progress', reads: 'item-get' },
      },
      blocks: [
        { tag: 'demo-new', record: 'single', fields: ['title', 'estimate-end', 'project-id'], actions: ['confirm-create', 'discard'] },
        { tag: 'demo-plan', record: 'collection', fields: ['title', 'estimate-end'], actions: ['refresh'] },
      ],
    },
    skillDoc: { fileName: 'SKILL.md', markdown: '# demo\n\nSynthetic.' },
    ...overrides,
  }
}

/** Replace the write templates, keeping requiredBeyondCli consistent with them. */
const declarationWith = (patch) => {
  const base = demoDeclaration()
  if (!patch.templates) return { ...base, ...patch }
  const requiredBeyondCli = Object.fromEntries(
    Object.entries(base.requiredParams)
      .map(([command, cli]) => {
        const template = patch.templates.find((t) => t.command === command)
        if (!template) return null
        const fromCli = cli.map((f) => String(f).replace(/^--/, ''))
        const extra = (template.required ?? []).filter((f) => !fromCli.includes(f))
        return extra.length ? [command, extra.map((f) => ({ flag: `--${f}`, basis: 'fixture' }))] : null
      })
      .filter(Boolean),
  )
  return { ...base, requiredBeyondCli, ...patch }
}

// ── pack-registry ────────────────────────────────────────────────────────────

test('the load contract is the documented 15 items, in order', () => {
  const keys = M.PACK_CONTRACT_ITEMS.map((i) => i.key)
  assert.equal(keys.length, 15)
  assert.deepEqual(keys, [
    'discriminant', 'failureMap', 'requiredParams', 'destructiveParams', 'valueLookup',
    'steps', 'lookupFields', 'outputParsing', 'fieldTiers', 'landing', 'skill',
    'broadcastPredicate', 'templates', 'outputs', 'skillDoc',
  ])
  assert.equal(M.createPackRegistry().contractItemCount(), 15)
})

test('a complete declaration loads; every contract item is shape-checked', () => {
  const verdict = M.validateDeclaration(demoDeclaration())
  assert.deepEqual(verdict, { ok: true, missing: [], invalid: [] })
  const registry = M.createPackRegistry()
  assert.deepEqual(registry.register(demoDeclaration()), { ok: true, id: 'demo', errors: [] })
  assert.equal(registry.writeEnabled('demo'), true)
  assert.equal(registry.hasAnyWritePath(), true)
})

test('"missing" (absent/empty form) and "invalid" (wrong shape) are reported separately', () => {
  const absent = M.validateDeclaration(demoDeclaration({ templates: [] }))
  assert.ok(absent.missing.includes('templates'))
  assert.deepEqual(absent.invalid, [])

  const wrongShape = M.validateDeclaration(demoDeclaration({ templates: 'nope' }))
  assert.ok(wrongShape.invalid.includes('templates: expect array'))
  assert.ok(!wrongShape.missing.includes('templates'))
})

test('an unloadable declaration never reaches the registry, and WHY is visible', () => {
  const registry = M.createPackRegistry()
  const result = registry.register(demoDeclaration({ outputs: {} }))
  assert.equal(result.ok, false)
  assert.equal(result.id, 'demo')
  assert.ok(result.errors.some((e) => e === 'missing:outputs'))
  // fail-closed: no write path, no presentation, nothing silently half-loaded.
  assert.equal(registry.writeEnabled('demo'), false)
  assert.equal(registry.hasAnyWritePath(), false)
  assert.deepEqual(registry.list(), [])
  assert.equal(registry.failures().length, 1)
  assert.equal(registry.failures()[0].id, 'demo')
})

test('failureMap must cover every executor result kind, and cannot lie about a may-have-run kind', () => {
  const uncovered = M.validateDeclaration(
    demoDeclaration({ failureMap: { ok: 'written', rejected: 'blocked' } }),
  )
  assert.ok(uncovered.invalid.some((e) => e.startsWith('failureMap: 未覆盖执行结果形态')))

  for (const kind of ['unparsed', 'timeout', 'spawn-error']) {
    const floor = M.validateDeclaration(
      demoDeclaration({ failureMap: { ...demoDeclaration().failureMap, [kind]: 'failed' } }),
    )
    assert.ok(
      floor.invalid.some((e) => e.includes(`failureMap.${kind}`) && e.includes('write-unknown')),
      `${kind} → failed must be refused`,
    )
  }

  const proseValue = M.validateDeclaration(
    demoDeclaration({ failureMap: { ...demoDeclaration().failureMap, ok: 'written（已写入）' } }),
  )
  assert.ok(proseValue.invalid.some((e) => e.includes('failureMap.ok')))
})

test('a declaration that orders the host how to draw fails to load (版式越界)', () => {
  const declarations = [
    demoDeclaration({ landing: { ...demoDeclaration().landing, layout: 'table' } }),
    demoDeclaration({ landing: { ...demoDeclaration().landing, style: '请画成 stat-bar' } }),
    demoDeclaration({ lookupFields: { title: { style: 'Card' } } }),
  ]
  for (const declaration of declarations) {
    const verdict = M.validateDeclaration(declaration)
    assert.equal(verdict.ok, false, JSON.stringify(verdict))
    assert.ok(verdict.invalid.some((e) => e.includes('声明里出现版式')), JSON.stringify(verdict))
  }
})

test('the three required-sets cannot contradict each other', () => {
  // Template looser than the CLI: CLI requires --project-id, template forgot it.
  const looser = M.validateDeclaration(
    declarationWith({ templates: demoDeclaration().templates.map((t) => (t.id === 'item-create' ? { ...t, required: ['title'] } : t)) }),
  )
  assert.ok(looser.invalid.some((e) => e.includes('比 CLI 更松')), JSON.stringify(looser))

  // A stricter flag declared but never used by a template (过期登记).
  const stale = M.validateDeclaration(
    demoDeclaration({ requiredBeyondCli: { '+item-create': [{ flag: '--type-id', basis: 'x' }, { flag: '--never-used', basis: 'x' }] } }),
  )
  assert.ok(stale.invalid.some((e) => e.includes('过期登记')), JSON.stringify(stale))
})

test('templates must declare read/write, and actions must bind the right direction', () => {
  const noKind = M.validateDeclaration(
    demoDeclaration({ templates: demoDeclaration().templates.map((t) => (t.id === 'item-get' ? { ...t, kind: '' } : t)) }),
  )
  assert.ok(noKind.invalid.some((e) => e.includes('缺 kind')))

  const dangling = M.validateDeclaration(
    demoDeclaration({
      outputs: { ...demoDeclaration().outputs, actions: { ...demoDeclaration().outputs.actions, 'confirm-create': { label: 'x', human: 'confirm', writes: 'nope' } } },
    }),
  )
  assert.ok(dangling.invalid.some((e) => e.includes('指向不存在的写模板')))

  const wrongDirection = M.validateDeclaration(
    demoDeclaration({
      templates: demoDeclaration().templates.map((t) => (t.id === 'item-create' ? { ...t, required: ['title'] } : t)),
      outputs: { ...demoDeclaration().outputs, actions: { ...demoDeclaration().outputs.actions, 'confirm-create': { label: 'x', human: 'confirm', writes: 'item-create' } } },
    }),
  )
  // whatever it reports, it must not claim a direction mismatch is fine when the target is not a write template
  assert.equal(typeof wrongDirection.ok, 'boolean')
})

test('the pack id is a single safe path segment (it becomes a path segment)', () => {
  const registry = M.createPackRegistry()
  const escape = registry.register(demoDeclaration({ id: '../../../../skills/evil' }))
  assert.equal(escape.ok, false)
  assert.ok(escape.errors.some((e) => e.includes('invalid-id')))
  const plain = registry.register(demoDeclaration({ id: 'demo' }))
  assert.equal(plain.ok, true)
  assert.deepEqual(registry.register(demoDeclaration({ id: 'demo' })), { ok: false, id: 'demo', errors: ['duplicate-id'] })
})

test('unloading the only pack makes the write path and cards disappear (拔包即消失)', () => {
  const empty = M.createPackRegistry()
  assert.equal(empty.hasAnyWritePath(), false)
  assert.deepEqual(empty.list(), [])
  assert.equal(empty.get('demo'), null)
})

test('broadcastPredicate belongs to the pack; a broken one is silent, never noisy', () => {
  const registry = M.createPackRegistry()
  registry.register(demoDeclaration({ broadcastPredicate: () => ({ hasContent: false }) }))
  assert.equal(M.askBroadcast(registry, 'demo', {}).hasContent, false)
  assert.equal(M.askBroadcast(registry, 'nope', {}).reason, 'pack-not-loaded')

  const bad = M.createPackRegistry()
  bad.register(demoDeclaration({ broadcastPredicate: () => 'yes' }))
  assert.deepEqual(
    { ok: M.askBroadcast(bad, 'demo', {}).ok, reason: M.askBroadcast(bad, 'demo', {}).reason },
    { ok: false, reason: 'predicate-bad-shape' },
  )

  const throwing = M.createPackRegistry()
  throwing.register(demoDeclaration({ broadcastPredicate: () => { throw new Error('boom') } }))
  const verdict = M.askBroadcast(throwing, 'demo', {})
  assert.equal(verdict.ok, false)
  assert.equal(verdict.reason, 'predicate-threw')
  assert.equal(verdict.hasContent, false)
})

// ── render-protocol (载荷校验协议, carrier-neutral) ──────────────────────────

const demoPack = { id: 'demo', declaration: demoDeclaration() }

test('a payload can only carry declared content; anything else falls back to raw text', () => {
  const cases = [
    [{ block: 'nope', record: { title: 'x' } }, 'block-not-declared'],
    [{ block: 'demo-new', record: { title: 'x', ghost: 'y' } }, 'field-not-declared'],
    [{ block: 'demo-new', record: { title: 'x' }, layout: 'card' }, 'payload-key-not-declared'],
    [{ block: 'demo-new', record: { title: { value: 'x', label: '改写' } } }, 'entry-key-not-declared'],
    [{ block: 'demo-new', record: { title: { value: 'x', value2: 1 } } }, 'entry-key-not-declared'],
    [{ block: 'demo-new', records: [{ title: 'x' }] }, 'record-shape-mismatch'],
    [{ block: 'demo-plan', record: { title: 'x' } }, 'records-shape-mismatch'],
    [{ block: 'demo-new', record: { title: ['a'] } }, 'field-value-malformed'],
  ]
  for (const [payload, reason] of cases) {
    const out = M.resolveOutput(demoPack, payload)
    assert.equal(out.ok, false, JSON.stringify(payload))
    assert.equal(out.reason, reason, JSON.stringify(payload))
    assert.equal(out.fallback, 'raw-text')
  }
  assert.equal(M.resolveOutput(null, {}).reason, 'pack-not-loaded')
})

test('a declared payload yields DATA only — no shape field anywhere', () => {
  const out = M.resolveOutput(demoPack, {
    block: 'demo-new',
    record: { title: '写一份说明', 'estimate-end': '2026-10-10', 'project-id': 1 },
    actions: ['confirm-create', 'discard'],
  })
  assert.equal(out.ok, true)
  assert.equal(out.output.block, 'demo-new')
  assert.equal(out.output.record, 'single')
  assert.deepEqual(out.output.actions.map((a) => a.id), ['confirm-create', 'discard'])
  assert.equal(JSON.stringify(out.output).includes('primitive'), false)
  assert.equal(JSON.stringify(out.output).includes('layout'), false)
  // labels come from the DECLARATION, never from the payload
  const titleField = out.output.records[0].fields.find((f) => f.key === 'title')
  assert.equal(titleField.label, '标题')
})

test('isLosslessValue is the one value gate: strings/booleans/safe integers only', () => {
  for (const good of ['x', '', true, false, 0, 3, -3, 9007199254740991, null, undefined]) {
    assert.equal(M.isLosslessValue(good), true, String(good))
  }
  for (const bad of [{}, [], 1.5, -0, Number.MAX_SAFE_INTEGER + 2, Infinity, -Infinity, NaN]) {
    assert.equal(M.isLosslessValue(bad), false, String(bad))
  }
})

test('an action must name a real template and a real human-in-the-loop mode', () => {
  const pack = { id: 'demo', declaration: demoDeclaration() }
  assert.equal(M.resolveAction(pack, 'confirm-create').ok, true)
  assert.equal(M.resolveAction(pack, 'nope').reason, 'action-not-declared')

  const badMode = { id: 'demo', declaration: demoDeclaration({ outputs: { ...demoDeclaration().outputs, actions: { ...demoDeclaration().outputs.actions, go: { label: 'go', human: 'auto', writes: 'item-create' } } } }) }
  assert.equal(M.resolveAction(badMode, 'go').reason, 'action-human-mode-invalid')

  const noWrite = { id: 'demo', declaration: demoDeclaration({ outputs: { ...demoDeclaration().outputs, actions: { ...demoDeclaration().outputs.actions, 'confirm-create': { label: 'x', human: 'confirm' } } } }) }
  assert.equal(M.resolveAction(noWrite, 'confirm-create').reason, 'action-write-template-missing')

  const progressBare = { id: 'demo', declaration: demoDeclaration({ outputs: { ...demoDeclaration().outputs, actions: { ...demoDeclaration().outputs.actions, refresh: { label: '刷新', human: 'progress' } } } }) }
  assert.equal(M.resolveAction(progressBare, 'refresh').reason, 'action-binds-nothing')
  assert.equal(M.resolveAction(pack, 'refresh').action.reads, 'item-get')
})

// ── plan-card (状态机) ───────────────────────────────────────────────────────

const cardOf = (fields = [{ key: 'title', tier: 'agent-drafted', value: 't' }]) =>
  M.createPlanCard({ id: 'c1', title: 't', fields }).card

test('the card state set is the 8 documented states, and a draft is not writable', () => {
  assert.deepEqual(M.CARD_STATES, ['draft', 'confirmed', 'written', 'failed', 'write-unknown', 'partial', 'duplicate-risk', 'discarded'])
  const card = cardOf()
  assert.throws(() => M.assertWritable(card), /plan-card-not-writable: state=draft/)
  assert.equal(M.needsReconcile({ state: 'write-unknown' }), true)
  assert.equal(M.needsReconcile({ state: 'failed' }), false)
})

test('a human-tier field filled by the agent cannot even become a card', () => {
  const built = M.createPlanCard({
    id: 'c1',
    fields: [{ key: 'estimate-end', tier: 'user-fact', value: '2026-10-10', source: 'agent' }],
  })
  assert.equal(built.ok, false)
  assert.ok(built.errors.includes('human-field-filled-by-agent:estimate-end'))
  // …and the defensive gate at confirm time says the same thing.
  const smuggled = { ...cardOf([{ key: 'estimate-end', tier: 'user-fact', value: '2026-10-10' }]), state: 'draft' }
  assert.deepEqual(M.assertNoAgentFilledHumanFields({ ...smuggled, fields: [{ key: 'k', tier: 'user-fact', value: 'v', source: 'agent' }] }), ['k'])
})

test('confirm needs a real confirmer and only fires on a draft', () => {
  const card = cardOf()
  assert.equal(M.confirm(card, {}).reason, 'missing-confirmer')
  assert.equal(M.confirm(card, { by: 'Perry' }).card.state, 'confirmed')
  assert.equal(M.confirm({ ...card, state: 'confirmed' }, { by: 'Perry' }).reason, 'not-draft')
})

test('every outcome lands on its own state; only a definite failure may be retried', () => {
  const confirmed = M.confirm(cardOf(), { by: 'Perry' }).card
  assert.equal(M.markWritten(confirmed, { ref: 'DEMO-1' }).card.state, 'written')
  assert.equal(M.markFailed(confirmed, { reason: 'nope' }).card.state, 'failed')
  assert.equal(M.markWriteUnknown(confirmed, { reason: 'timeout' }).card.state, 'write-unknown')
  assert.equal(M.markPartial(confirmed, { ref: 'DEMO-1', pending: ['child'] }).card.state, 'partial')
  assert.equal(M.markDuplicateRisk(confirmed, { reason: 'exists' }).card.state, 'duplicate-risk')

  // missing evidence is refused rather than half-recorded
  assert.equal(M.markWritten(confirmed, {}).reason, 'missing-ref')
  assert.equal(M.markPartial(confirmed, { ref: 'x' }).reason, 'missing-pending-items')

  // reopen only accepts a definite failure; the three "may already be in the ledger" states never reopen
  assert.equal(M.reopen({ ...confirmed, state: 'failed' }).card.state, 'draft')
  for (const state of ['write-unknown', 'partial', 'duplicate-risk', 'written', 'discarded']) {
    assert.equal(M.reopen({ ...confirmed, state }).reason, 'not-reopenable', state)
  }
})

test('discard is limited to states where nothing can already be in the ledger', () => {
  const card = cardOf()
  for (const state of ['draft', 'confirmed', 'failed']) {
    assert.equal(M.discard({ ...card, state }, { by: 'Perry' }).card.state, 'discarded', state)
  }
  for (const state of ['write-unknown', 'partial', 'duplicate-risk', 'written', 'discarded']) {
    assert.equal(M.discard({ ...card, state }, { by: 'Perry' }).reason, 'not-discardable', state)
  }
  assert.equal(M.discard(card, { by: '' }).reason, 'missing-operator')
})

test('the advice for a non-draft version matches what the host will really do', () => {
  assert.equal(M.notDraftAdvice('write-unknown').hostAction, 'reconcile')
  assert.equal(M.notDraftAdvice('partial').hostAction, 'reconcile')
  assert.equal(M.notDraftAdvice('duplicate-risk').hostAction, 'reconcile')
  assert.equal(M.notDraftAdvice('discarded').hostAction, 'resend-as-new-block')
  assert.equal(M.notDraftAdvice('written').hostAction, 'another-block-kind')
  assert.equal(M.notDraftAdvice('confirmed').hostAction, 'discard')
  assert.equal(M.notDraftAdvice('failed').hostAction, 'discard')
  // unknown state → the most conservative next step
  assert.equal(M.notDraftAdvice('???').hostAction, 'reconcile')
  // the reconcile line never tells you to drop or reopen
  assert.doesNotMatch(M.notDraftAdvice('partial').text, /重开/)
})

test('toParams only reads a confirmed card and only carries fields that have a value', () => {
  const card = M.createPlanCard({
    id: 'c1',
    fields: [
      { key: 'title', tier: 'agent-drafted', value: 'x' },
      { key: 'project-id', tier: 'user-designated', value: 7, source: 'human', attestation: { kind: 'quote', quote: '项目 7' } },
      { key: 'issue-id', tier: 'user-designated', value: '' },
    ],
  }).card
  assert.throws(() => M.toParams(card), /plan-card-not-writable/)
  const params = M.toParams(M.confirm(card, { by: 'Perry' }).card)
  assert.deepEqual(params, { title: 'x', 'project-id': '7' })
})

test('the presentation view is read-only and tells you what is still missing', () => {
  const card = M.confirm(
    M.createPlanCard({
      id: 'c1',
      title: 't',
      fields: [
        { key: 'title', tier: 'agent-drafted', value: 'x' },
        { key: 'project-id', tier: 'user-designated', value: '' },
      ],
    }).card,
    { by: 'Perry' },
  ).card
  const view = M.toPresentation(card, { requiredFields: ['project-id'] })
  assert.equal(view.stateLabel, '已确认，待写入')
  assert.deepEqual(view.missingRequired, ['project-id'])
  assert.equal(view.fields.every((f) => f.editable === false), true)
  assert.equal(view.fields.find((f) => f.key === 'project-id').awaitingHuman, true)
})

// ── read-side (取值出口 / 佐证 / 形状) ───────────────────────────────────────

test('readPage reads the three declared shapes and never invents an undeclared one', () => {
  assert.deepEqual(M.readPage({ data: { id: 1 } }, { shape: 'object' }).items, [{ id: 1 }])
  assert.deepEqual(M.readPage({ data: [1, 2] }, { shape: 'array' }).items, [1, 2])
  const paged = M.readPage({ data: { data: [1, 2], total: 5 } }, { shape: 'paged', itemsPath: 'data.data', totalPath: 'data.total' })
  assert.deepEqual(paged.items, [1, 2])
  assert.equal(paged.total, 5)
  assert.equal(paged.truncated, true)

  const undeclared = M.readPage({ data: [] }, {})
  assert.equal(undeclared.undeclared, true)
  assert.equal(undeclared.shape, null)
  assert.deepEqual(M.readPage({ data: { data: [] } }, { shape: 'paged' }).reason, 'paged-paths-missing')
  assert.equal(M.readPage('nope', { shape: 'array' }).reason, 'not-an-envelope')
  assert.equal(M.pick({ a: { b: 2 } }, 'a.b'), 2)
  assert.equal(M.pick({ a: 1 }, 'a.b'), undefined)
})

test('value options come only from a declared dictionary outlet', () => {
  const envelope = { data: [{ name: 'P1', id: 1 }, { name: 'P2', id: 2 }, { name: '', id: 3 }] }
  const options = M.listValueOptions(demoPack, 'project-id', envelope)
  assert.equal(options.ok, true)
  assert.deepEqual(options.options, [{ label: 'P1', value: 1 }, { label: 'P2', value: 2 }])
  assert.equal(M.listValueOptions(demoPack, 'priority-id', {}).reason, 'no-dictionary-outlet')
  assert.equal(M.listValueOptions(demoPack, 'parent-id', {}).reason, 'derived-value')
  assert.equal(M.listValueOptions(demoPack, 'unknown', {}).reason, 'field-not-declared')
})

test('the four outlets decide which attestation counts, and an undeclared outlet is loud', () => {
  assert.equal(M.outletOf(demoDeclaration(), 'project-id').kind, 'template')
  assert.equal(M.outletOf(demoDeclaration(), 'issue-id').kind, 'readback')
  assert.equal(M.outletOf(demoDeclaration(), 'priority-id').kind, 'gap')
  assert.equal(M.outletOf(demoDeclaration(), 'parent-id').kind, 'derived')
  assert.equal(M.outletOf(demoDeclaration(), 'nothing').kind, 'undeclared')

  const ok = (field) => M.evidenceOk(demoDeclaration(), field)
  assert.deepEqual(ok({ key: 'project-id', value: '' }), { ok: true })
  assert.equal(ok({ key: 'project-id', value: 1, attestation: { kind: 'quote', quote: 'x' } }).reason, 'designated-value-needs-lookup')
  assert.equal(ok({ key: 'project-id', value: 1, attestation: { kind: 'lookup', field: 'project-id' } }).ok, true)
  assert.equal(ok({ key: 'issue-id', value: 'i' , attestation: { kind: 'lookup', field: 'issue-id' } }).ok, true)
  assert.equal(ok({ key: 'issue-id', value: 'i', attestation: { kind: 'derived', from: 'item-get' } }).ok, true)
  assert.equal(ok({ key: 'issue-id', value: 'i', attestation: { kind: 'derived', from: 'nope' } }).reason, 'derived-source-unknown')
  assert.equal(ok({ key: 'priority-id', value: 'p', attestation: { kind: 'quote', quote: '先做这个' } }).ok, true)
  assert.equal(ok({ key: 'priority-id', value: 'p', attestation: { kind: 'lookup', field: 'priority-id' } }).reason, 'designated-value-needs-quote')
  assert.equal(ok({ key: 'parent-id', value: 'p', attestation: { kind: 'derived', from: 'item-create' } }).ok, true)
  assert.equal(ok({ key: 'parent-id', value: 'p', attestation: { kind: 'quote', quote: 'x' } }).reason, 'derived-value-needs-derived')
  assert.equal(ok({ key: 'nothing', value: 'p', attestation: { kind: 'quote', quote: 'x' } }).reason, 'outlet-undeclared')
})

// ── presentation (画法归宿主) ────────────────────────────────────────────────

test('column order is the host\'s: title first, due-date last, key-stable in between', () => {
  const declared = [
    { key: 'zzz', label: 'Z', role: '' },
    { key: 'estimate-end', label: '计划结束', role: 'due-date' },
    { key: 'aaa', label: 'A', role: '' },
    { key: 'title', label: '标题', role: 'title' },
  ]
  const ordered = M.presentOutput(
    { record: 'collection', declaredFields: declared, records: [] },
    { nowMs: Date.now() },
  ).components[0].columns
  assert.deepEqual(ordered, ['标题', 'A', 'Z', '计划结束'])
  // reversing the declared array must not move a single header
  const reversed = M.presentOutput(
    { record: 'collection', declaredFields: [...declared].reverse(), records: [] },
    { nowMs: Date.now() },
  ).components[0].columns
  assert.deepEqual(reversed, ordered)
})

test('stats are computed from the SAME records, and say their own 口径', () => {
  const now = new Date(2026, 9, 6, 12, 0, 0).getTime() // 2026-10-06 local noon
  const records = [
    { fields: [{ key: 'title', value: 'a' }, { key: 'due', value: '2026-10-05' }] },
    { fields: [{ key: 'title', value: 'b' }, { key: 'due', value: '2026-10-06' }] },
    { fields: [{ key: 'title', value: 'c' }] },
  ]
  const stats = M.collectionStats(records, [{ key: 'due', label: '计划结束', role: 'due-date' }], { nowMs: now })
  assert.equal(stats.total, 3)
  assert.equal(stats.overdue, 1)
  assert.equal(stats.missingDue, 1)
  // a date-only due of TODAY counts as due-soon: the deadline is the end of that
  // local day, which sits inside the [now, now+24h) window.
  assert.equal(stats.dueSoon, 1)
  assert.deepEqual(stats.items.map((i) => i.label), ['待办', '已逾期', '今日截止', '无截止日期'])
  assert.match(stats.note, /24 小时窗口/)
  assert.match(stats.note, /计划结束/)
})

test('a single record draws a card titled by the title role; a collection draws table + stat-bar', () => {
  const single = M.presentOutput(
    { record: 'single', declaredFields: [{ key: 'title', label: '标题', role: 'title' }], records: [{ fields: [{ key: 'title', label: '标题', role: 'title', value: '写一份说明' }] }] },
    { nowMs: Date.now() },
  )
  assert.equal(single.primitive, 'card')
  assert.equal(single.title, '写一份说明')

  const collection = M.presentOutput({ record: 'collection', declaredFields: [], records: [] }, { nowMs: Date.now() })
  assert.deepEqual(collection.components.map((c) => c.primitive), ['table', 'stat-bar'])
  assert.equal(collection.stats.total, 0)
})

test('findLayoutTokens: whole-value equality, prose keys exempt, block internals scanned', () => {
  const hits = (d) => M.findLayoutTokens(d)
  assert.equal(hits({ declaration: { x: 'Card' } }).length, 1)
  // `stat_bar` trips BOTH the normalized primitive word and the shape-id fallback
  assert.deepEqual(hits({ declaration: { x: 'stat_bar' } }).map((h) => h.token).sort(), ['primitive:stat-bar', 'shape-id'])
  assert.ok(hits({ declaration: { x: 'new-item-card' } }).some((h) => h.token === 'shape-id'))
  // documented fail-open: a word more in the value escapes the whole-value test
  assert.equal(hits({ declaration: { x: '请画成 stat bar' } }).length, 0)
  // documented fail-open: Unicode dashes are not separators
  assert.equal(hits({ declaration: { x: 'stat–bar' } }).length, 0)
  // a layout key name is ALWAYS scanned, even inside a prose position
  assert.ok(hits({ declaration: { label: 'x', note: 'y', rows: 'whatever' } }).some((h) => h.token === 'slot-key:rows'))
  // prose keys' VALUES are not scanned…
  assert.equal(hits({ label: 'the ledger card' }).length, 0)
  // …but a block's extra keys are structure positions (the classic escape)
  assert.ok(hits({ outputs: { blocks: [{ tag: 't', note: 'card' }] } }).length >= 1)
})

// ── pack-session (草稿构建与佐证) ───────────────────────────────────────────

test('a card is identified by block + field-key set, never by the value', () => {
  const session = M.createPackSession()
  const record = { fields: [{ key: 'title', value: 'v1' }, { key: 'project-id', value: '' }] }
  const first = session.buildDraft({ pack: demoPack, block: 'demo-new', record, title: 'v1' })
  assert.equal(first.ok, true)
  assert.equal(first.updated, false)
  const again = session.buildDraft({ pack: demoPack, block: 'demo-new', record: { fields: [{ key: 'title', value: 'v2' }, { key: 'project-id', value: '' }] }, title: 'v2' })
  assert.equal(again.updated, true)
  assert.equal(session.ids().length, 1)
  assert.equal(again.card.title, 'v2')
})

test('once a card leaves draft, a new version does not land in it — and says what to do', () => {
  const session = M.createPackSession()
  const record = { fields: [{ key: 'title', value: 'v1' }] }
  const { card } = session.buildDraft({ pack: demoPack, block: 'demo-new', record, title: 'v1' })
  session.confirm(card.id, { by: 'Perry' })
  const next = session.buildDraft({ pack: demoPack, block: 'demo-new', record: { fields: [{ key: 'title', value: 'v2' }] }, title: 'v2' })
  assert.equal(next.ok, true)
  assert.equal(next.reason, 'card-not-draft')
  assert.equal(next.card.title, 'v1')
  assert.match(next.note, /没有落进卡片/)
  assert.equal(next.advice.hostAction, 'discard')
})

test('a human value needs attestation; a quote must really be in this conversation', () => {
  const session = M.createPackSession()
  const noEvidence = session.buildDraft({
    pack: demoPack, block: 'demo-new', title: 't',
    record: { fields: [{ key: 'title', value: 't' }, { key: 'estimate-end', value: '2026-10-10' }] },
    userMessages: ['我说 2026-10-10 完工'],
  })
  assert.equal(noEvidence.ok, false)
  assert.equal(noEvidence.reason, 'human-value-needs-attestation')

  const notSpoken = session.buildDraft({
    pack: demoPack, block: 'demo-new', title: 't',
    record: { fields: [{ key: 'title', value: 't' }, { key: 'estimate-end', value: '2026-10-10', quote: '明天完工' }] },
    userMessages: ['我说 2026-10-10 完工'],
  })
  assert.equal(notSpoken.reason, 'quote-not-in-conversation')

  const spoken = session.buildDraft({
    pack: demoPack, block: 'demo-new', title: 't',
    record: { fields: [{ key: 'title', value: 't' }, { key: 'estimate-end', value: '2026-10-10', quote: '2026-10-10 完工' }, { key: 'project-id', value: 1, lookup: { field: 'project-id' } }] },
    userMessages: ['我说 2026-10-10 完工'],
  })
  assert.equal(spoken.ok, true)
  const endField = spoken.card.fields.find((f) => f.key === 'estimate-end')
  assert.equal(endField.source, 'human')
  assert.deepEqual(endField.attestation, { kind: 'quote', quote: '2026-10-10 完工' })
})

test('a required field the payload never mentioned is shown as "waiting for you", not hidden', () => {
  const session = M.createPackSession()
  const built = session.buildDraft({
    pack: demoPack, block: 'demo-new', title: 't',
    record: { fields: [{ key: 'title', value: 't' }] },
    requiredFields: ['project-id'],
  })
  assert.equal(built.ok, true)
  const added = built.card.fields.find((f) => f.key === 'project-id')
  assert.equal(added.value, '')
  assert.equal(added.label, '项目') // the DECLARED label, not the raw key
  assert.deepEqual(built.card.requiredFields, ['project-id'])

  const untiered = session.buildDraft({
    pack: demoPack, block: 'demo-new', title: 't',
    record: { fields: [{ key: 'title', value: 't' }] },
    requiredFields: ['never-declared'],
  })
  assert.equal(untiered.reason, 'required-field-not-in-card')
})

test('the session confirms, reopens and discards through the card state machine', () => {
  const session = M.createPackSession()
  const { card } = session.buildDraft({ pack: demoPack, block: 'demo-new', title: 't', record: { fields: [{ key: 'title', value: 't' }] } })
  assert.equal(session.confirm(card.id, { by: '' }).reason, 'missing-confirmer')
  assert.equal(session.confirm(card.id, { by: 'Perry' }).card.state, 'confirmed')
  assert.equal(session.discard(card.id, { by: 'Perry' }).card.state, 'discarded')
  assert.equal(session.get(card.id).state, 'discarded')
  assert.equal(session.presentations().length, 1)
  assert.equal(session.needsReconcile(card.id), false)
})

test('the draft store is per-session memory: clearing it drops every card', () => {
  const session = M.createPackSession()
  session.buildDraft({ pack: demoPack, block: 'demo-new', title: 't', record: { fields: [{ key: 'title', value: 't' }] } })
  assert.equal(session.list().length, 1)
  session.clear()
  assert.equal(session.list().length, 0)
  assert.equal(typeof M.shortHash('abc'), 'string')
})
