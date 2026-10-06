/**
 * W1 · LOAD-BEARING evidence (the "拿掉核心实现就变红" half of the acceptance).
 *
 * N7 §8 (W1) requires the migrated pure logic to be accepted by "语义等价、换载体"
 * (裁定 5). Semantic equivalence alone proves the port MATCHES the old shell; it
 * does not prove the guards are the thing doing the work. So here each core
 * guard is short-circuited IN MEMORY (one exact string replacement, asserted to
 * have landed), the mutated plugin is loaded, and the behaviour must FLIP.
 *
 * A guard whose removal changes nothing was never load-bearing. Method mirrors
 * PLANKTON-MIGRATION-BATCH2.md §11.4 (mutate → run → red → revert).
 *
 * Nothing in the repo is modified: the mutation lives in a temp copy. Every
 * fixture is SYNTHETIC; no enterprise data is read or written.
 *
 * Run:
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-loadbearing.test.mjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-loadbearing-'))
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

/** Short-circuit one exact guard; the anchor must exist exactly once. */
async function mutated(from, to) {
  const first = SOURCE.indexOf(from)
  assert.notEqual(first, -1, `mutation anchor not found: ${from}`)
  assert.equal(SOURCE.indexOf(from, first + 1), -1, `mutation anchor is not unique: ${from}`)
  const next = SOURCE.slice(0, first) + to + SOURCE.slice(first + from.length)
  assert.notEqual(next, SOURCE)
  return loadPlugin(next)
}

const INTACT = await loadPlugin(SOURCE)

const pack = {
  id: 'demo',
  declaration: {
    id: 'demo',
    fieldTiers: { title: 'agent-drafted', 'priority-id': 'user-designated' },
    outputs: {
      fields: { title: { label: '标题', role: 'title' } },
      actions: {},
      blocks: [{ tag: 'demo-new', record: 'single', fields: ['title'], actions: [] }],
    },
    templates: [],
    valueLookup: { 'priority-id': { gap: 'no dictionary outlet' } },
  },
}

const draftCard = INTACT.createPlanCard({ id: 'c1', fields: [{ key: 'title', tier: 'agent-drafted', value: 't' }] }).card

// ── 1. the state machine's "a draft is not writable" gate ────────────────────

test('LOAD-BEARING: neutering assertWritable lets an unconfirmed draft be written', async () => {
  // control: the intact gate refuses, exactly as the design demands
  assert.throws(() => INTACT.markWritten(draftCard, { ref: 'DEMO-1' }), /plan-card-not-writable/)

  const M = await mutated(
    "  if (!card || card.state !== 'confirmed') {\n",
    '  if (false) {\n',
  )
  const drafted = M.createPlanCard({ id: 'c1', fields: [{ key: 'title', tier: 'agent-drafted', value: 't' }] }).card
  const written = M.markWritten(drafted, { ref: 'DEMO-1' })
  assert.equal(written.ok, true, 'with the gate short-circuited, a draft must become writable')
  assert.equal(written.card.state, 'written')
})

// ── 2. "a human field cannot be filled by the agent" at card creation ────────

test('LOAD-BEARING: neutering the tier guard lets the agent fill a human field', async () => {
  const human = { key: 'due', tier: 'user-fact', value: '2026-10-10', source: 'agent' }
  assert.equal(INTACT.createPlanCard({ id: 'c1', fields: [human] }).ok, false)

  const M = await mutated(
    "    if (HUMAN_TIERS.includes(f.tier) && filled(f.value) && f.source !== 'human') {\n",
    '    if (false) {\n',
  )
  assert.equal(M.createPlanCard({ id: 'c1', fields: [human] }).ok, true)
})

// ── 3. the single value gate (`isLosslessValue`) ────────────────────────────

test('LOAD-BEARING: neutering isLosslessValue lets non-lossless values into a payload', async () => {
  // an array is not an entry object, so it reaches the value gate itself
  const payload = { block: 'demo-new', record: { title: ['a'] } }
  assert.equal(INTACT.resolveOutput(pack, payload).reason, 'field-value-malformed')

  const M = await mutated('const isLosslessValue = (v) =>\n', 'const isLosslessValue = (v) =>\n  true ||\n')
  const out = M.resolveOutput(pack, payload)
  assert.equal(out.ok, true, 'with the value gate open, an object value must slip through')
})

// ── 4. the failureMap floor (a may-have-run kind may never read as failed) ───

test('LOAD-BEARING: neutering the failureMap floor lets "timeout" read as a definite failure', async () => {
  const timedOutToFailed = {
    discriminant: 'ok',
    failureMap: { ok: 'written', rejected: 'blocked', refused: 'blocked', unparsed: 'write-unknown', timeout: 'failed', 'spawn-error': 'write-unknown' },
    requiredParams: { '+c': ['--x'] },
    destructiveParams: [{ flag: '--y', meaning: 'm' }],
    valueLookup: { x: { template: 't' } },
    steps: [{ id: 's' }],
    lookupFields: { x: { exists: 'e' } },
    outputParsing: { envelope: 'ok' },
    fieldTiers: { x: 'user-designated' },
    landing: { installDir: 'p' },
    skill: ['s'],
    broadcastPredicate: () => ({ hasContent: false }),
    templates: [{ id: 't', command: '+c', kind: 'read', required: ['x'] }],
    requiredBeyondCli: {},
    outputs: { fields: { x: { label: 'X' } }, actions: {}, blocks: [{ tag: 'b', record: 'single', fields: ['x'], actions: [] }] },
    skillDoc: { fileName: 'SKILL.md', markdown: '# x' },
  }
  const intactVerdict = INTACT.validateDeclaration(timedOutToFailed)
  assert.ok(intactVerdict.invalid.some((e) => e.includes('failureMap.timeout')), JSON.stringify(intactVerdict))

  const M = await mutated(
    "      if (mayHaveRun.has(String(kind)) && String(state) !== 'write-unknown') {\n",
    '      if (false) {\n',
  )
  assert.deepEqual(M.validateDeclaration(timedOutToFailed), { ok: true, missing: [], invalid: [] })
})

// ── 5. reopen is limited to a definite failure ──────────────────────────────

test('LOAD-BEARING: neutering reopen lets a may-already-be-written card go back to draft', async () => {
  const confirmed = INTACT.confirm(draftCard, { by: 'Perry' }).card
  const unknown = INTACT.markWriteUnknown(confirmed, { reason: 'timeout' }).card
  assert.equal(INTACT.reopen(unknown).reason, 'not-reopenable')

  const M = await mutated(
    "  if (!card || card.state !== 'failed') return { ok: false, reason: 'not-reopenable', state: card?.state ?? 'none' }\n",
    "  if (false) return { ok: false, reason: 'not-reopenable', state: card?.state ?? 'none' }\n",
  )
  const reopened = M.reopen({ ...unknown })
  assert.equal(reopened.ok, true)
  assert.equal(reopened.card.state, 'draft')
})

// ── 6. the outlet-aware attestation check ───────────────────────────────────

test('LOAD-BEARING: neutering evidenceOk lets a lookup attestation pass a gap outlet', async () => {
  const field = { key: 'priority-id', value: 'p', attestation: { kind: 'lookup', field: 'priority-id' } }
  assert.equal(INTACT.evidenceOk(pack.declaration, field).reason, 'designated-value-needs-quote')

  const M = await mutated(
    '  const fail = (reason) => Object.freeze({ ok: false, reason, field: key })\n',
    '  const fail = (reason) => Object.freeze({ ok: true, reason, field: key })\n',
  )
  assert.equal(M.evidenceOk(pack.declaration, field).ok, true)
})
