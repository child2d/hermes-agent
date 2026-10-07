/**
 * 批 4 · **客户端接线**（线 ①②③④）的边界护栏（机器载体）。
 *
 * 与 `tests/test_audit_wiring.py` / `tests/test_audit_transport.py` 互补：那两份钉**行为**（承重+反证）；
 * 这份钉**客户端这半边不得因接线而多开一扇门 / 不得写死端点**，以及**接线真的进了产物清单**：
 *
 *   1. **接线入口真的在**：`__init__.py` 的 `register(ctx)` 调用 `_wire_audit`（否则又是 0 调用方）；
 *   2. **不新增产品写口**：`/audit*` 仍**没有**写路由（POST/PUT/PATCH/DELETE）；接线状态面只读；
 *   3. **接线承载在产物清单里**（`plankton-pack.sh` 与 `scripts/after-pack.mjs` 都列 `audit_wiring.py`
 *      / `audit_transport.py`）——否则打包会静默漏；
 *   4. **传输不得写死端点**（`audit_transport.py` 不得出现真实 URL 字面量）；
 *   5. **不改上游引擎**：接线只经 `ctx.register_hook`（本仓 `apps/desktop/**` 内不出现对引擎核心的改动）。
 *
 * Run:
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-w7-wiring.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(HERE, '..')
const INIT = fs.readFileSync(path.join(PLUGIN_DIR, '__init__.py'), 'utf8')
const PLUGIN_API = fs.readFileSync(path.join(PLUGIN_DIR, 'dashboard', 'plugin_api.py'), 'utf8')
const WIRING = fs.readFileSync(path.join(PLUGIN_DIR, 'audit_wiring.py'), 'utf8')
const TRANSPORT = fs.readFileSync(path.join(PLUGIN_DIR, 'audit_transport.py'), 'utf8')
const PACK_SH = fs.readFileSync(path.resolve(HERE, '..', '..', '..', 'scripts', 'plankton-pack.sh'), 'utf8')
const AFTER_PACK = fs.readFileSync(path.resolve(HERE, '..', '..', '..', 'scripts', 'after-pack.mjs'), 'utf8')

/** 去掉 Python docstring 与注释行，只留会执行的代码（结构断言针对代码，不针对说明文字）。 */
function pyCodeOnly(src) {
  return src
    .replace(/"""[\s\S]*?"""/g, '')
    .replace(/'''[\s\S]*?'''/g, '')
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
}

// ── 1 · 接线入口真的在（否则又是 0 调用方） ────────────────────────────────────

test('接线：register(ctx) 真的调用审计接线入口（_wire_audit）', () => {
  assert.match(INIT, /def register\(ctx/, '__init__.py 必须仍有 register(ctx)')
  assert.match(INIT, /_wire_audit\(ctx\)/, 'register(ctx) 必须调用 _wire_audit（本批接线的唯一入口）')
  assert.match(INIT, /register_audit_wiring\(ctx\)/, '接线必须落到 register_audit_wiring')
})

test('接线：会话入口/收尾/启动自检三根线都在接线模块里', () => {
  const code = pyCodeOnly(WIRING)
  assert.match(code, /on_session_start/, '线 ③：会话入口准入钩子')
  assert.match(code, /on_session_finalize/, '线 ①：会话收尾钩子（真实会话边界）')
  assert.match(code, /check_audit_landing/, '线 ②：启动期落点自检')
  assert.match(code, /admit_conversation/, '线 ③：缓冲准入')
  assert.match(code, /record_and_flush/, '线 ①：先入缓冲再上传')
  assert.match(code, /register_hook/, '只经引擎既有钩子面接线')
})

// ── 2 · 不新增产品写口（只加只读面） ─────────────────────────────────────────

test('接线：后端仍无任何 /audit 写路由；接线状态面只读', () => {
  assert.doesNotMatch(PLUGIN_API, /@router\.(post|put|patch|delete)\(\s*["']\/audit/, '不得新增 /audit 写路由')
  assert.match(PLUGIN_API, /@router\.get\("\/audit\/wiring"\)/, '接线状态面必须存在且只读')
})

test('接线：接线状态面不触发会话、不上传（纯只读描述）', () => {
  const code = pyCodeOnly(WIRING)
  // 状态函数只读：不得在 wiring_status 里 flush / record_and_flush。
  const statusBody = code.split('def wiring_status')[1]?.split('\ndef ')[0] ?? ''
  assert.ok(statusBody.length > 0, 'wiring_status 必须存在')
  assert.doesNotMatch(statusBody, /record_and_flush|\.flush\(|admit_conversation/, 'wiring_status 只读，不触发会话/上传')
})

// ── 3 · 接线承载真的在产物清单里 ──────────────────────────────────────────────

test('产物清单：plankton-pack.sh 必需 payload 含接线两模块', () => {
  assert.match(PACK_SH, /audit_wiring\.py/, 'pack 必需 payload 必须含 audit_wiring.py')
  assert.match(PACK_SH, /audit_transport\.py/, 'pack 必需 payload 必须含 audit_transport.py')
})

test('产物清单：after-pack.mjs 也枚举接线两模块（丢失在打包期变红）', () => {
  assert.match(AFTER_PACK, /audit_wiring\.py/, 'after-pack 期望清单必须含 audit_wiring.py')
  assert.match(AFTER_PACK, /audit_transport\.py/, 'after-pack 期望清单必须含 audit_transport.py')
  assert.match(AFTER_PACK, /audit_egress\.py/, 'after-pack 期望清单必须含 audit_egress.py（W5/W6 补齐）')
})

// ── 4 · 传输不得写死端点 ──────────────────────────────────────────────────────

test('传输：不得写死端点（真实 URL 字面量）', () => {
  const code = pyCodeOnly(TRANSPORT)
  for (const scheme of ['http://', 'https://']) {
    assert.ok(!code.includes(`"${scheme}`) && !code.includes(`'${scheme}`), `传输源码不得写死端点（${scheme}）`)
  }
  assert.match(TRANSPORT, /no-transport/, '默认安全态＝无传输')
  assert.ok(!/cli_usage_log|common_auth/.test(code), '不复用 CLI 用量表（不新增写口）')
  assert.match(code, /build_transport/, '必须由配置决定传输（默认 None）')
})

// ── 5 · 不改上游引擎 ─────────────────────────────────────────────────────────

test('接线：只经 ctx.register_hook，不改上游引擎', () => {
  const code = pyCodeOnly(WIRING)
  assert.match(code, /register_hook\(/)
  // 不得 import 引擎私有实现（tui_gateway.server 私有名等）。
  for (const forbidden of ['_broadcast_global_event', 'import tui_gateway.server']) {
    assert.ok(!code.includes(forbidden), `接线不得触碰引擎私有实现（${forbidden}）`)
  }
})
