/**
 * W5 · 边界护栏 (N7 §8 优先级第 5 条) — the machine carriers for the three
 * boundary invariants the whole batch rides on:
 *
 *   1. **装配点唯一** — the host core knows no pack; ONE place names a pack
 *      (`installedPacks()`), and the directive registration is derived from the
 *      registry, not from any hardcoded tag list;
 *   2. **拔包即消失** — drop the assembly point's single entry ⇒ the registry is
 *      empty ⇒ no write path (`hasAnyWritePath()` false) AND no carrier
 *      directive AND no card; the host leaves no residue;
 *   3. **写通道唯一** — one executor with ONE spawn point; the carrier's write
 *      goes through the SAME W3 `packActions.run`; the read port is read-only.
 *
 * Behavioural where it can be (the unplug run), static where it must be (the
 * "host learned a pack" accident the W2 boundary test already guards — here we
 * add the WIRING-flavoured half).
 *
 * Run:
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-w5-boundary.test.mjs
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-w5b-'))
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

function capturingCtx() {
  const contributions = []
  return /** @type {any} */ ({
    storage: { get: (_k, f) => f, set: () => {}, remove: () => {} },
    rest: async () => ({ kind: 'rejected', note: 'stub' }),
    registerMany: (cs) => contributions.push(...cs),
    register: (c) => contributions.push(c),
    _contributions: contributions,
  })
}

const BLOCK_TAGS = ['plankton-baymax-new', 'plankton-baymax-update', 'plankton-baymax-plan']

// ── 1 · 装配点唯一：the directive registration is DERIVED, not hardcoded ─────

test('装配点唯一：指令贡献由注册表导出（宿主不认识具体块名）', () => {
  const registry = M.createPackRegistry()
  registry.register(M.BAYMAX_DECLARATION)
  const names = M.carrierDirectiveContributions({ registry, renderer: M.createPackRenderer({ registry, session: M.createPackSession() }), runAction: async () => ({ ok: true }), identityProvider: { current: () => null } }).map((c) => c.data.name)
  assert.deepEqual([...names].sort(), [...BLOCK_TAGS].sort(), 'exactly the declared block tags — derived from the registry')
})

test('装配点唯一：包名只出现在装配点（load 绑定恰好一处）', () => {
  const loaders = SOURCE.match(/load:\s*\(\)\s*=>/g) ?? []
  assert.equal(loaders.length, 1, `装配点只能有一处 load 绑定，实测 ${loaders.length} 处`)
  // The directive names the host may carry must be derived at runtime — the host
  // core must not name a block tag as a string literal.
  for (const tag of BLOCK_TAGS) {
    const occurrences = SOURCE.split(`'${tag}'`).length - 1
    assert.ok(occurrences <= 1, `块 tag ${tag} 只应在包声明里出现一次（装配点不得硬编码指令名），实测 ${occurrences} 次`)
  }
})

// ── 2 · 拔包即消失：drop the single assembly entry ⇒ everything is gone ─────

test('拔包即消失：去掉装配点那一条 ⇒ 注册表为空、无写路径、无指令、无卡', async () => {
  const unplugged = await loadPlugin(SOURCE.replace("{ id: 'baymax', load: () => BAYMAX_DECLARATION }", '/* unplugged by the W5 test */'))
  const assembled = unplugged.assemblePacks()
  assert.equal(assembled.registry.hasAnyWritePath(), false, 'an empty registry must expose NO write path')

  const names = unplugged.carrierDirectiveContributions({ registry: assembled.registry, renderer: unplugged.createPackRenderer({ registry: assembled.registry, session: unplugged.createPackSession() }), runAction: async () => ({ ok: true }), identityProvider: { current: () => null } })
  assert.deepEqual(names, [], 'no pack ⇒ no carrier directive')

  const ctx = capturingCtx()
  unplugged.default.register(ctx)
  assert.equal(ctx._contributions.filter((c) => c.area === 'transcript.directives').length, 0, 'register() must claim no directive when no pack is installed')

  const model = await unplugged.createPackRenderer({ registry: assembled.registry, session: unplugged.createPackSession() }).land({ name: 'plankton-baymax-new', attrs: { key: 'k' } })
  assert.equal(model.ok, false)
  assert.equal(model.reason, 'directive-not-declared', 'with the pack unplugged the name is not claimed')
})

test('正控：装上那一条 ⇒ 写路径与指令都在（排除集非空转）', () => {
  const assembled = M.assemblePacks()
  assert.equal(assembled.registry.hasAnyWritePath(), true, 'the real assembly must expose the write path')
  assert.ok((M.carrierDirectiveContributions({ registry: assembled.registry, renderer: M.createPackRenderer({ registry: assembled.registry, session: M.createPackSession() }), runAction: async () => ({ ok: true }), identityProvider: { current: () => null } }).length) === 3)
})

// ── 3 · 写通道唯一：one executor, one spawn, one orchestration ──────────────
//
// SCOPE OF THIS LOCK (author-not-self-auditing note): the assertions below are a
// STRING lock — they count definitions/spawn-call sites in the source text, so a
// semantic refactor that keeps the invariant but renames a symbol could move
// them. They are deliberately NOT the sole guard: the invariant also has a
// BEHAVIOURAL lock in this batch — this file's 「拔包即消失」 run proves that
// dropping the single assembly entry makes `registry.hasAnyWritePath()` false at
// RUNTIME (write path really disappears, not merely un-referenced), and
// pack-w5-readpath.test.mjs drives the read port and asserts it never reaches the
// single write runner. So: string lock + behavioural lock, together. Making
// 「one executor instance / one spawn point」 purely behavioural would require
// instrumenting internals the module does not expose, at a cost out of proportion
// to the residual risk here.

test('写通道唯一：全宿主只有一个执行器、一个 spawn 点、写只经 packActions.run', () => {
  assert.equal((SOURCE.match(/function createPackExecutor\(/g) ?? []).length, 1, '执行器定义只该一处')
  assert.equal((SOURCE.match(/=\s*createPackExecutor\(/g) ?? []).length, 1, `执行器只该装配一次，实测 ${(SOURCE.match(/=\s*createPackExecutor\(/g) ?? []).length} 次`)
  // ONE spawn helper; nothing else may call the injected spawner.
  assert.equal((SOURCE.match(/async function spawnCli\s*\(/g) ?? []).length, 1, 'spawn 点只该有一个')
  assert.equal((SOURCE.match(/execFileImpl\(cliPath, argv/g) ?? []).length, 1, '注入的 spawner 只该在一处被真的调用')
  assert.ok(/shell: false/.test(SOURCE), 'the one spawn must use array args with shell:false')
  // The carrier's component holds no write path of its own: it takes `runAction`
  // as an injected port (the ONE orchestration).
  assert.ok(/function CarrierDirective\(\{[^}]*runAction[^}]*\}\)/.test(SOURCE), 'CarrierDirective must receive runAction as an injected port')
  assert.ok(/runAction:\s*\(args\)\s*=>\s*carrierActions\.run\(args\)/.test(SOURCE), 'register() must wire runAction to the ONE packActions.run')
  // The read port is a SEPARATE, read-only door: `createPackExecutor` (the write
  // executor) is never handed to the read path.
  assert.ok(!/createReadPathLoader\(\{[^}]*executor/.test(SOURCE), 'the read loader must not receive the write executor')
})

test('承重 F：拆掉装配点那一条 ⇒ 上面「拔包即消失」必须变红（判据自身有效）', async () => {
  // The unplugged mutant proves the assertions above are not tautological: with
  // the entry present they ALL flip back (write path exists, directives exist).
  const assembled = M.assemblePacks()
  assert.equal(assembled.registry.hasAnyWritePath(), true)
  const unplugged = await loadPlugin(SOURCE.replace("{ id: 'baymax', load: () => BAYMAX_DECLARATION }", '/* unplugged */'))
  assert.equal(unplugged.assemblePacks().registry.hasAnyWritePath(), false, 'the unplug mutant must genuinely differ')
})
