/**
 * 批 4 · W6 —— **边界护栏（机器载体）** 的桌面/后端半边（§8 W6 / §6 / §9.0）。
 *
 * 与 `tests/test_audit_egress.py` 互补：那边钉**出口模块本身**的行为与结构；这边钉**客户端插件
 * 这半边不得因 W5/W6 而多开一扇门**：
 *
 *   1. **不新增产品写口**：桌面 plugin.js 的执行器/写编排**不增**（仍各一处）；客户端后端
 *      **没有**任何 `/audit*` 的写路由（POST/PUT/PATCH/DELETE）——W5/W6 只加**只读**可见面；
 *   2. **W5/W6 的承载真的在产物清单里**（`plankton-pack.sh` 列 `audit_egress.py`）；
 *   3. **出口契约的关键字面量在**（`CONVERSATION_REFUSAL_NOTE` / `check_audit_landing` /
 *      `AuditBuffer` / `client-cannot-attest-human` / `buffer-full` / `no-transport`），且**不得**
 *      出现真实端点 URL / CLI 用量表引用；
 *   4. **装配点唯一** 不因本批而变（仍是宿主不认识具体包的那一条）。
 *
 * Run:
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-w6-egress-boundary.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_JS = path.resolve(HERE, '..', 'desktop', 'plugin.js')
const PLUGIN_API = path.resolve(HERE, '..', 'dashboard', 'plugin_api.py')
const EGRESS = path.resolve(HERE, '..', 'audit_egress.py')
const PACK_SH = path.resolve(HERE, '..', '..', '..', 'scripts', 'plankton-pack.sh')

const JS = fs.readFileSync(PLUGIN_JS, 'utf8')
const API = fs.readFileSync(PLUGIN_API, 'utf8')
const EGRESS_SRC = fs.readFileSync(EGRESS, 'utf8')
const PACK = fs.readFileSync(PACK_SH, 'utf8')

/** 去掉 Python docstring 与注释，只留会执行的代码（结构断言针对代码，不针对说明文字）。 */
function pyCodeOnly(src) {
  return src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
}

// ── 1 · 不新增产品写口 ──────────────────────────────────────────────────────

test('W6 护栏：桌面写通道不因 W5/W6 多开（执行器/写编排仍各一处）', () => {
  assert.equal((JS.match(/function createPackExecutor\(/g) ?? []).length, 1, '执行器定义仍应只有一处')
  assert.equal((JS.match(/=\s*createPackExecutor\(/g) ?? []).length, 1, '执行器仍应只装配一次')
  assert.equal((JS.match(/function createPackActions\(/g) ?? []).length, 1, '写编排仍应只有一处')
  assert.equal((JS.match(/async function spawnCli\s*\(/g) ?? []).length, 1, 'spawn 点仍应只有一个')
})

test('W6 护栏：桌面半边不调用任何 /audit 端点（审计出口不占桌面写口）', () => {
  assert.ok(!/['"`][^'"`]*\/audit/.test(JS), 'plugin.js 不得引用 /audit 端点（本批客户端出口只在后端只读面）')
})

test('W6 护栏：客户端后端没有 /audit 的写路由（只读面）', () => {
  const code = pyCodeOnly(API)
  for (const verb of ['post', 'put', 'patch', 'delete']) {
    const re = new RegExp(`@router\\.${verb}\\(\\s*['"]/audit`)
    assert.ok(!re.test(code), `不得新增 /audit 的 ${verb.toUpperCase()} 写路由`)
  }
  assert.ok(code.includes('@router.get("/audit/buffer")'), '必须有只读缓冲健康路由')
  assert.ok(code.includes('@router.get("/audit/landing-check")'), '必须有只读落点自检路由')
})

// ── 2 · W5/W6 承载真的在产物清单里 ──────────────────────────────────────────

test('W6 护栏：产物 payload 清单含 audit_egress.py（否则打包会静默漏 W5/W6）', () => {
  assert.ok(PACK.includes('audit_egress.py'), 'plankton-pack.sh 必须列 audit_egress.py')
})

// ── 3 · 出口契约关键字面量 + 无真实端点/CLI 表 ──────────────────────────────

test('W6 护栏：出口模块带 W5/W6 关键字面量且无真实端点/CLI 表', () => {
  for (const marker of [
    'class AuditBuffer',
    'CONVERSATION_REFUSAL_NOTE',
    'check_audit_landing',
    'LANDING_ACTIONABLE_HINT',
    'client-cannot-attest-human',
    'no-transport',
    'buffer-full'
  ]) {
    assert.ok(EGRESS_SRC.includes(marker), `audit_egress.py 必须带 ${marker}`)
  }
  const code = pyCodeOnly(EGRESS_SRC)
  assert.ok(!code.includes('cli_usage_log'), '不得复用 CLI 用量表')
  assert.ok(!code.includes('common_auth'), '不得引用 common_auth')
  assert.ok(!code.includes('http://') && !code.includes('https://'), '不得内建真实端点')
})

// ── 4 · 装配点唯一（不因本批而变） ───────────────────────────────────────────

test('W6 护栏：装配点唯一不因本批而变（恰好一处 load 绑定）', () => {
  const loaders = JS.match(/load:\s*\(\)\s*=>/g) ?? []
  assert.equal(loaders.length, 1, `装配点只能有一处 load 绑定，实测 ${loaders.length} 处`)
})

// ── 承重反证：判据自身有效（拿掉「无写路由」判据 ⇒ 人造一条写路由必须被抓） ──────

test('W6 承重反证：人造一条 /audit 写路由 ⇒ 上面的只读判据必须变红', () => {
  const mutated = API.replace(
    '@router.get("/audit/buffer")',
    '@router.post("/audit/buffer")\ndef _sneak():\n    return {}'
  )
  const code = pyCodeOnly(mutated)
  assert.ok(
    /@router\.post\(\s*['"]\/audit/.test(code),
    '人造写路由后判据必须命中（证明它不是在空转）'
  )
})
