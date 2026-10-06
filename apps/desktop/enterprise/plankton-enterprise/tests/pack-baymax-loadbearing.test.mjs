/**
 * W2 · LOAD-BEARING evidence for the baymax pack + the single assembly point
 * (the "拿掉核心就变红" half of the acceptance).
 *
 * Semantic equivalence (pack-baymax.test.mjs) proves the pack MATCHES the
 * measured command surface and the old shell's semantics. It does NOT prove
 * that the assembly point, the load-time cross-checks and the ownership map are
 * the things doing the work. So each core mechanism is short-circuited IN
 * MEMORY (one exact string replacement, asserted to have landed), the mutated
 * plugin is loaded, and the SAME predicate the acceptance uses must FLIP.
 *
 * Method mirrors the W1 pack-loadbearing.test.mjs / PLANKTON-MIGRATION-BATCH2
 * §11.4 (mutate → run → red → revert). Nothing in the repo is modified: the
 * mutation lives in a temp copy. Every fixture is SYNTHETIC; no enterprise data
 * is read or written, no home directory is touched.
 *
 * Run:
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-baymax-loadbearing.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..', 'desktop', 'plugin.js')
const SKILL_FILE = path.resolve(HERE, '..', 'skills', 'baymax', 'SKILL.md')
const SOURCE = fs.readFileSync(PLUGIN, 'utf8')

async function loadPlugin(source) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-baymax-lb-'))
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

const INTACT = await loadPlugin(SOURCE)

// ── predicates: the SAME checks the acceptance suite runs ───────────────────

/** 「拔包即消失」：the assembly point is the only thing that can produce a write path. */
function writePathSurvives(M) {
  const { registry } = M.assemblePacks()
  return registry.hasAnyWritePath()
}

/** Load-time cross-check (PLK-REQ-0032/0033 machine face) applied to OUR declaration. */
function declarationLoads(M) {
  return M.validateDeclaration(M.BAYMAX_DECLARATION).ok
}

/** Drift guard: every template's direction must match the measured surface. */
function directionDrifts(M) {
  const D = M.BAYMAX_DECLARATION
  return D.templates.some((t) => D.surface[t.command] !== t.kind)
}

/** 「一份 skill」byte lock: the inline markdown must equal the committed file. */
function skillLockHolds(M) {
  return M.BAYMAX_DECLARATION.skillDoc.markdown === fs.readFileSync(SKILL_FILE, 'utf8')
}

/** Ownership map: every contract item sits on the carrier N2 §0.1 assigns it. */
const EXPECTED_CARRIERS = {
  discriminant: 'plugin', failureMap: 'plugin', fieldTiers: 'plugin',
  destructiveParams: 'plugin', broadcastPredicate: 'plugin', landing: 'plugin',
  outputs: 'boundary',
  requiredParams: 'skill', valueLookup: 'skill', steps: 'skill',
  lookupFields: 'skill', outputParsing: 'skill', templates: 'skill',
  skill: 'skill', skillDoc: 'skill'
}
function ownershipIsCorrect(M) {
  return M.PACK_CONTRACT_ITEMS.every((item) => M.carrierOf(item.key) === EXPECTED_CARRIERS[item.key])
}

// ── controls (intact) ───────────────────────────────────────────────────────

test('CONTROL: intact plugin — all four predicates hold', () => {
  assert.equal(declarationLoads(INTACT), true)
  assert.equal(writePathSurvives(INTACT), true)
  assert.equal(directionDrifts(INTACT), false)
  assert.equal(skillLockHolds(INTACT), true)
  assert.equal(ownershipIsCorrect(INTACT), true)
})

// ── 1. the assembly point ───────────────────────────────────────────────────

test('LOAD-BEARING: emptying the assembly point removes the write path entirely', async () => {
  const M = await mutated(
    "    { id: 'baymax', load: () => BAYMAX_DECLARATION }\n",
    '',
  )
  assert.equal(writePathSurvives(M), false, '拔掉装配点里那一行 ⇒ 注册表为空 ⇒ 写路径消失')
  const { registry, results } = M.assemblePacks()
  assert.deepEqual(results, [])
  assert.equal(registry.get('baymax'), null)
  assert.deepEqual(registry.failures(), [])
})

// ── 2. the load-time field cross-check ──────────────────────────────────────

test('LOAD-BEARING: a block carrying an undeclared field key fails the load', async () => {
  const M = await mutated(
    "          'label-ids',\n          'parent-id'\n        ],\n        actions: ['confirm-create', 'discard']",
    "          'label-ids',\n          'parent-id',\n          'no-such-field'\n        ],\n        actions: ['confirm-create', 'discard']",
  )
  assert.equal(declarationLoads(M), false, '未声明字段键必须让声明不可装载')
  assert.ok(
    M.validateDeclaration(M.BAYMAX_DECLARATION).invalid.some((e) => String(e).includes('no-such-field')),
    '失败原因必须指名是哪个字段（否则不可装载只是一句黑话）',
  )
})

// ── 3. the stricter-than-CLI cross-check ────────────────────────────────────

test('LOAD-BEARING: loosening create-item to the CLI\'s own required set fails the load', async () => {
  const M = await mutated(
    "    required: ['project-id', 'type-id', 'title'],",
    "    required: ['project-id', 'title'],",
  )
  assert.equal(declarationLoads(M), false, '比 CLI 更严的 --type-id 一旦被放松，声明必须不可装载')
  const invalid = M.validateDeclaration(M.BAYMAX_DECLARATION).invalid.join(' | ')
  assert.ok(invalid.includes('--type-id') || invalid.includes('type-id'), `失败原因必须指名 type-id：${invalid}`)
})

// ── 4. the direction drift guard (does the measured surface still bite?) ────

test('LOAD-BEARING: flipping a measured direction is caught by the drift guard', async () => {
  const M = await mutated("    '+whoami': 'read'", "    '+whoami': 'write'")
  assert.equal(directionDrifts(M), true, '方向表被改动后，漂移判据必须报出不一致')
})

// ── 5. the byte lock between the declaration and the committed skill ────────

test('LOAD-BEARING: touching the inlined skill text breaks the byte lock', async () => {
  const M = await mutated('  "name: baymax",', '  "name: baymaxx",')
  assert.equal(skillLockHolds(M), false, '内联正文与仓内 SKILL.md 一旦不同，同值锁必须报红')
})

// ── 6. the ownership map (which carrier owns what) ──────────────────────────

test('LOAD-BEARING: moving a contract item to the wrong carrier is caught', async () => {
  const M = await mutated("  landing: 'plugin',", "  landing: 'skill',")
  assert.equal(ownershipIsCorrect(M), false, '宿主侧事实被搬进 skill ⇒ 归属判据必须报红')
  // 双证：别的键不动时判据仍绿（说明它认的是逐项归属，不是「文件改过就红」）
  const N = await mutated("  skill: 'skill',", "  skill: 'plugin',")
  assert.equal(ownershipIsCorrect(N), false)
})
