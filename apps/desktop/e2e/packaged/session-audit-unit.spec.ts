/**
 * 批 4 · W1 —— 产物级证据：**会话级审计单元的组装** + **应用发稳定 profileId**（只读、**不上传**）。
 *
 * 这一条在**仓外打包产物**（`PLANKTON_APP` 指向的 `Plankton.app`，不是 dev checkout）里跑，读的是
 * 产物自带的企业插件：
 *   * 产物字节必须带 W1 的承载（`audit_unit.py` 的确定性键/两方字段/profileId 发号 + 后端两条只读路由）；
 *   * 真渲染器 → 主机桥 `window.hermesDesktop.api` → 插件后端 `/audit/profile-id`：
 *     同一 profile（键＝稳定身份）**改名不改 ID**，且台账**真落在企业 home**（`profile-ids.json`）；
 *   * 真渲染器 → `/audit/unit`：从企业 home 内的只读会话事实库组出**该会话全部聊天记录**的单元，
 *     `human.auth_user_id` **恒空**（服务端盖章）、`agent` 全 **self-reported**、**无原始密钥**；
 *   * 反例：**未知会话**与**企业 home 外的库**都 fail-closed（拒），且**不产单元**；
 *   * **本包不发送**：全程只读（没有上传调用点，源码级断言 + 行为只读）。
 *
 * 入口（在 apps/desktop 下）：
 *   PLANKTON_OUTPUT_DIR=/tmp/… npm run pack:plankton      # 仓外产物
 *   PLANKTON_APP=/tmp/…/Plankton.app npm run test:e2e:packaged
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron, expect, test } from '@playwright/test'

import { writeEnvFile, writeMockProviderConfig } from '../../../../tests-js/scripts/mock-provider-config'
import { startMockServer } from '../../../../tests-js/scripts/mock-server'
import { createSandbox, type Sandbox, waitForAppReady } from '../fixtures'

test.describe.configure({ timeout: 360_000 })

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function resolvePackagedApp(): string {
  const explicit = process.env.PLANKTON_APP
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`PLANKTON_APP points at a missing path: ${explicit}`)
    return explicit
  }
  const candidates = [
    path.join(DESKTOP_ROOT, 'release', 'mac-arm64', 'Plankton.app'),
    path.join(DESKTOP_ROOT, 'release', 'mac', 'Plankton.app')
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(
      'No packaged Plankton.app found — this lane tests the ARTIFACT:\n' +
        `  cd apps/desktop && PLANKTON_OUTPUT_DIR=/tmp/… npm run pack:plankton && PLANKTON_APP=… npm run test:e2e:packaged\n(looked in ${candidates.join(', ')})`
    )
  }
  return found
}

/** 产物自身字节的身份断言（企业 payload + W1 承载），非环境变量可伪造。 */
function assertEnterpriseArtifactIdentity(appPath: string): void {
  const resources = path.join(appPath, 'Contents', 'Resources')
  const stamp = JSON.parse(fs.readFileSync(path.join(resources, 'install-stamp.json'), 'utf8')) as {
    identityVariant?: string
  }
  expect(stamp.identityVariant, '产物身份戳必须命名 plankton 变体').toBe('plankton')

  const pluginDir = path.join(resources, 'enterprise', 'plankton-enterprise')
  for (const relative of [
    'audit_unit.py',
    'audit_egress.py',
    // 批 4 · 客户端接线：审计出口的接线模块与可配置传输，都必须在产物字节里。
    'audit_wiring.py',
    'audit_transport.py',
    'dashboard/plugin_api.py',
    '__init__.py',
    'plugin.yaml'
  ]) {
    const file = path.join(pluginDir, relative)
    expect(fs.existsSync(file), `企业插件 payload 缺失：${relative}`).toBe(true)
    expect(fs.statSync(file).size, `企业插件 payload 为空：${relative}`).toBeGreaterThan(0)
  }

  // W1 承载必须**真的在产物字节里**（不是源码里）。
  const audit = fs.readFileSync(path.join(pluginDir, 'audit_unit.py'), 'utf8')
  for (const marker of ['derive_session_audit_id', 'audit_hygiene_problem', 'resolve_profile_id', 'self-reported']) {
    expect(audit, `产物 audit_unit.py 必须带单元生产者（缺 ${marker}）`).toContain(marker)
  }
  // 批 4 W5/W6 承载也必须**真的在产物字节里**。
  const egress = fs.readFileSync(path.join(pluginDir, 'audit_egress.py'), 'utf8')
  for (const marker of [
    'class AuditBuffer',
    'CONVERSATION_REFUSAL_NOTE',
    'check_audit_landing',
    'LANDING_ACTIONABLE_HINT',
    'client-cannot-attest-human'
  ]) {
    expect(egress, `产物 audit_egress.py 必须带 W5/W6 承载（缺 ${marker}）`).toContain(marker)
  }
  const api = fs.readFileSync(path.join(pluginDir, 'dashboard/plugin_api.py'), 'utf8')
  expect(api, '产物后端必须带只读 profile-id 路由').toContain('@router.get("/audit/profile-id")')
  expect(api, '产物后端必须带只读 unit 路由').toContain('@router.get("/audit/unit")')
  expect(api, '产物后端必须带只读缓冲健康路由').toContain('@router.get("/audit/buffer")')
  expect(api, '产物后端必须带只读落点自检路由').toContain('@router.get("/audit/landing-check")')
  // 批 4 · 客户端接线：只读的接线状态面也必须真在产物里。
  expect(api, '产物后端必须带只读接线状态路由').toContain('@router.get("/audit/wiring")')
  // 本批不新增产品写口：后端不得出现任何 /audit 写路由。
  expect(api, 'W5/W6 不得带 /audit 写路由').not.toMatch(/@router\.(post|put|patch|delete)\(\s*"\/audit/)

  // 批 4 · 客户端接线（线 ①②③④）的承载必须**真的在产物字节里**——否则又是「模块在、0 调用方」。
  const init = fs.readFileSync(path.join(pluginDir, '__init__.py'), 'utf8')
  expect(init, '产物插件入口必须接线审计出口（register → _wire_audit）').toContain('_wire_audit(ctx)')
  expect(init, '产物插件入口必须落到 register_audit_wiring').toContain('register_audit_wiring(ctx)')

  const wiring = fs.readFileSync(path.join(pluginDir, 'audit_wiring.py'), 'utf8')
  for (const marker of [
    'record_and_flush', // 线 ①：会话收尾先入缓冲再上传
    'check_audit_landing', // 线 ②：启动期落点自检
    'admit_conversation', // 线 ③：会话入口准入
    'on_session_finalize', // 会话边界钩子（不是每轮）
    'register_hook', // 只经引擎既有钩子面
    'no-transport' // 默认安全态
  ]) {
    expect(wiring, `产物 audit_wiring.py 必须带接线承载（缺 ${marker}）`).toContain(marker)
  }

  const transport = fs.readFileSync(path.join(pluginDir, 'audit_transport.py'), 'utf8')
  for (const marker of ['build_transport', 'load_transport_config', 'describe_transport', 'no-transport']) {
    expect(transport, `产物 audit_transport.py 必须带传输承载（缺 ${marker}）`).toContain(marker)
  }
  // 传输不得写死端点（端点只来自企业 home 配置）。
  expect(transport, '产物传输不得写死 http(s) 端点').not.toMatch(/["']https?:\/\//)
}

function packagedEnv(sandbox: Sandbox): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || key.startsWith('HERMES_')) continue
    if (/_(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS|ACCESS_KEY|PRIVATE_KEY)$/.test(key)) continue
    env[key] = value
  }
  env.HOME = sandbox.root
  env.HERMES_HOME = sandbox.hermesHome
  env.HERMES_DESKTOP_USER_DATA_DIR = sandbox.userDataDir
  env.HERMES_DESKTOP_SKIP_QUIT_CONFIRM = '1'
  return env
}

/** 在企业 home 内造一只**只读会话事实库**夹具（与引擎 state.db 的 messages 表同形）。 */
function seedSessionDb(dbPath: string, sessionId: string, rows: Array<[string, string]>): void {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true })
  const sql = [
    'CREATE TABLE messages (id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, role TEXT, content TEXT, timestamp REAL NOT NULL, active INTEGER DEFAULT 1);',
    ...rows.map(
      ([role, content], index) =>
        `INSERT INTO messages (session_id, role, content, timestamp) VALUES ('${sessionId}', '${role}', '${content.replace(
          /'/g,
          "''"
        )}', ${1000 + index});`
    )
  ].join('\n')
  execFileSync('/usr/bin/sqlite3', [dbPath, sql])
}

/** 真渲染器 → 主机桥 → 插件后端的只读 GET。 */
async function pluginGet(page: Awaited<ReturnType<Awaited<ReturnType<typeof _electron.launch>>['firstWindow']>>, urlPath: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (target: string) => {
    const desktop = (window as unknown as { hermesDesktop: { api: (req: { path: string; method: string }) => Promise<unknown> } })
      .hermesDesktop
    return (await desktop.api({ path: target, method: 'GET' })) as Record<string, unknown>
  }, urlPath)
}

const B = '/api/plugins/plankton-enterprise'
const RAW_TOKEN = 'sk-abcdefghijklmnopqrstuvwx'

test('产物真实渲染器：profileId 稳定 + 会话单元组装（人方空值/agent 非权威/无密钥）且不上传', async () => {
  const appPath = resolvePackagedApp()
  assertEnterpriseArtifactIdentity(appPath)

  const executable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'))
  expect(fs.existsSync(executable), `产物可执行文件缺失：${executable}`).toBe(true)

  const mock = await startMockServer({ replyForPrompt: () => 'ok' })
  const sandbox = createSandbox('ent-audit-packaged')
  const home = sandbox.hermesHome

  writeMockProviderConfig(home, mock.url, undefined, 'plugins:\n  enabled:\n    - plankton-enterprise\n')
  writeEnvFile(home)

  // 企业产物在 SSO 后 fail-closed：播种 app 自己的持久化会话形状（本地事实，无密钥）。
  const ssoDir = path.join(sandbox.userDataDir, 'plankton-state', 'sso')
  fs.mkdirSync(ssoDir, { recursive: true })
  fs.writeFileSync(
    path.join(ssoDir, 'session.json'),
    JSON.stringify({ whoami: { subject: 'e2e-tester', displayName: 'E2E Tester' }, refreshToken: null }, null, 2)
  )

  // 只读会话事实库夹具，落在企业 home 内（越界会被路由拒）。
  const fixtureDb = path.join(home, 'e2e-audit-fixture.db')
  seedSessionDb(fixtureDb, 'sess-e2e', [
    ['user', '第一条：你好'],
    ['assistant', '回答一'],
    ['user', `第二条：拿这个 token ${RAW_TOKEN}`],
    ['assistant', '回答二']
  ])

  const app = await _electron.launch({
    executablePath: executable,
    args: ['--disable-gpu', '--no-sandbox'],
    env: packagedEnv(sandbox),
    cwd: os.tmpdir()
  })

  try {
    const page = await app.firstWindow()
    await waitForAppReady({ page, app } as unknown as Parameters<typeof waitForAppReady>[0], 120_000)
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { hermesDesktop?: { enterpriseEnabled?: boolean } }).hermesDesktop?.enterpriseEnabled ===
          true
      ),
      '启动的产物必须报告企业身份'
    ).toBe(true)

    // ── profileId：首次纳管发号并持久化；改名不改 ID ─────────────────────────
    const first = await pluginGet(page, `${B}/audit/profile-id?profileKey=alpha&name=Alpha`)
    expect(first.kind, `profile-id 路由必须可用：${JSON.stringify(first)}`).toBe('ok')
    const id = String(first.profileId)
    expect(id.startsWith('pid_'), 'profileId 必须是应用发的稳定 ID（pid_ 前缀）').toBe(true)

    const renamed = await pluginGet(page, `${B}/audit/profile-id?profileKey=alpha&name=Alpha%20Renamed`)
    expect(renamed.profileId, '同一 profile 改名必须复用同一 profileId').toBe(id)

    const other = await pluginGet(page, `${B}/audit/profile-id?profileKey=beta&name=Alpha`)
    expect(other.profileId, '不同 profile（即便重名）必须得到不同 ID').not.toBe(id)

    const store = path.join(home, 'plankton-enterprise', 'profile-ids.json')
    expect(fs.existsSync(store), `profileId 台账必须落在企业 home：${store}`).toBe(true)
    expect(fs.readFileSync(store, 'utf8')).toContain(id)

    // ── 单元组装：全部聊天记录 / 人方空值 / agent 非权威 / 无密钥 ─────────────
    const unitResp = await pluginGet(
      page,
      `${B}/audit/unit?session=sess-e2e&profileKey=alpha&name=Alpha&db=${encodeURIComponent(fixtureDb)}`
    )
    expect(unitResp.kind, `unit 路由必须可用：${JSON.stringify(unitResp)}`).toBe('ok')
    const unit = unitResp.unit as Record<string, unknown>
    expect(unit.session_audit_id, '幂等键＝确定性派生 plankton:<会话 id>').toBe('plankton:sess-e2e')
    expect(unit.human, '人这一方上送恒空（服务端盖章）').toEqual({ auth_user_id: null })
    const agent = unit.agent as Record<string, unknown>
    expect(agent.authoritative, 'agent 一方必须非权威').toBe(false)
    expect(agent.note).toBe('self-reported')
    expect(typeof agent.profileId).toBe('string')

    const transcript = unit.transcript as Array<{ role: string; content: string }>
    expect(transcript.length, '单元必须含该会话**全部聊天记录**（不抽样/不摘要）').toBe(4)
    expect(transcript.map((entry) => entry.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    expect(transcript[0].content).toBe('第一条：你好')

    const blob = JSON.stringify(unit)
    expect(blob, '单元里不得出现原始令牌').not.toContain(RAW_TOKEN)

    // ── W5/W6 · 只读可见面：缓冲健康 + 落点自检（真渲染器 → 主机桥 → 后端） ────
    const buffer = await pluginGet(page, `${B}/audit/buffer`)
    expect(buffer.kind, `缓冲健康路由必须可用：${JSON.stringify(buffer)}`).toBe('ok')
    expect(buffer.pending, '空缓冲的 pending 应为 0').toBe(0)
    expect(buffer.dropped, '本实现从不静默丢弃单元').toBe(0)

    const landing = await pluginGet(page, `${B}/audit/landing-check`)
    expect(landing.ok, `正常企业 home 的落点自检必须通过：${JSON.stringify(landing)}`).toBe(true)
    expect(landing.findings).toEqual([])

    // ── 批 4 · 客户端接线（线 ①②③④）：真渲染器 → 主机桥 → 后端的**只读接线状态** ─
    // 证明接线**真的挂上了**（不是「模块在、0 调用方」）：产物引擎在加载插件时跑了
    // register(ctx) → register_hook，把会话入口/收尾两根钩子挂上；且**默认无传输**（安全态）。
    const wiring = await pluginGet(page, `${B}/audit/wiring`)
    expect(wiring.kind, `接线状态路由必须可用：${JSON.stringify(wiring)}`).toBe('ok')
    expect(wiring.wired, '审计出口的会话钩子必须**真的挂上**（接线承重）').toBe(true)
    expect(wiring.hooks).toEqual(['on_session_start', 'on_session_finalize'])
    expect((wiring.startup as Record<string, unknown>).usable, '正常企业 home ⇒ 允许进入可用状态').toBe(true)
    const transport = wiring.transport as Record<string, unknown>
    expect(transport.mode, '默认无传输：产物不带端点配置 ⇒ 一个字节都不外发').toBe('no-transport')
    expect(transport.endpointConfigured, '默认未配置端点').toBe(false)
    expect(transport.credentialConfigured, '默认无凭据').toBe(false)
    expect(JSON.stringify(wiring), '接线状态面不得回显任何端点/凭据原值').not.toMatch(/https?:\/\//)

    // ── 反例：未知会话、企业 home 外的库 ⇒ fail-closed，且不产单元 ─────────────
    const unknown = await pluginGet(page, `${B}/audit/unit?session=does-not-exist&db=${encodeURIComponent(fixtureDb)}`)
    expect(unknown).toEqual({ kind: 'rejected', note: 'no-session' })

    const outsideDb = path.join(sandbox.root, 'outside.db')
    seedSessionDb(outsideDb, 'sess-e2e', [['user', 'x']])
    const outside = await pluginGet(
      page,
      `${B}/audit/unit?session=sess-e2e&db=${encodeURIComponent(outsideDb)}`
    )
    expect(outside, '企业 home 外的库必须被拒（只读回路的边界）').toEqual({
      kind: 'rejected',
      note: 'session-db-outside-enterprise-home'
    })

    expect(await page.locator('body').innerText()).not.toContain('Minified React error')
  } finally {
    await app.close()
  }
})

/**
 * 批 4 · 反证（**产物级**）：启动自检不通过 ⇒ **不进入可用状态**。
 *
 * 把 `HERMES_HOME` 钉进**个人 Hermes 根内部**（`$HOME/.hermes/enterprise-home`）——正是审计落点自检
 * （`check_audit_landing`）要拦的红线（写个人 `~/.hermes`，审计不成立）。产物引擎在加载插件时跑
 * 落点自检，必须 **fail-closed**：把 `startup.usable` 置 false（会话准入据此拒），并给可行动提示——
 * 绝不「装作可用」。
 *
 * 观测点＝真渲染器 → 主机桥 → 只读 `/audit/wiring`（与带外注入无关：这是引擎进程加载插件时的裁决）。
 */
test('产物：HERMES_HOME 落进个人 ~/.hermes ⇒ 自检报 usable:false（裁决层面）+ 可行动提示 + 默认无传输；注：本引擎无会话闸门，应用仍起（裁决≠执行，见 KI-PLANKTON-0082）', async () => {
  const appPath = resolvePackagedApp()
  assertEnterpriseArtifactIdentity(appPath)

  const executable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'))
  const mock = await startMockServer({ replyForPrompt: () => 'ok' })
  const sandbox = createSandbox('ent-audit-failclosed')
  const isolatedHome = path.join(sandbox.root, '.hermes', 'enterprise-home')
  fs.mkdirSync(isolatedHome, { recursive: true })
  writeMockProviderConfig(isolatedHome, mock.url, undefined, 'plugins:\n  enabled:\n    - plankton-enterprise\n')
  writeEnvFile(isolatedHome)

  // 与主用例同：企业产物在 SSO 后 fail-closed——播种本地 SSO 事实，让窗口能起来（审计自检与登录无关）。
  const ssoDir = path.join(sandbox.userDataDir, 'plankton-state', 'sso')
  fs.mkdirSync(ssoDir, { recursive: true })
  fs.writeFileSync(
    path.join(ssoDir, 'session.json'),
    JSON.stringify({ whoami: { subject: 'e2e-tester', displayName: 'E2E Tester' }, refreshToken: null }, null, 2)
  )

  const app = await _electron.launch({
    executablePath: executable,
    args: ['--disable-gpu', '--no-sandbox'],
    env: { ...packagedEnv(sandbox), HOME: sandbox.root, HERMES_HOME: isolatedHome },
    cwd: os.tmpdir()
  })

  try {
    const page = await app.firstWindow()
    await waitForAppReady({ page, app } as unknown as Parameters<typeof waitForAppReady>[0], 120_000)

    const wiring = await pluginGet(page, `${B}/audit/wiring`)
    expect(wiring.kind, `接线状态路由必须可用：${JSON.stringify(wiring)}`).toBe('ok')
    const startup = wiring.startup as Record<string, unknown>
    expect(
      startup.usable,
      `HERMES_HOME 落进个人 ~/.hermes ⇒ 必须 fail-closed 不进入可用状态：${JSON.stringify(startup)}`
    ).toBe(false)
    expect(startup.kind).toBe('landing-inside-personal-home')
    expect(String(startup.hint).length, '必须给可行动提示（不静默回退）').toBeGreaterThan(0)

    // 只读落点自检也报同一事实。
    const landing = await pluginGet(page, `${B}/audit/landing-check`)
    expect(landing.ok, '落点自检必须报不通过').toBe(false)

    // **裁决 ≠ 执行**（批 4 验收实测，KI-PLANKTON-0082）：尽管 startup.usable=false，**本应用确实起来了**
    // （窗口在、本只读面可达）——引擎无会话闸门、宿主无准入闸，落点自检只「报」不「拦」，故此用例只断言
    // 「报出的裁决」，不声称「应用被拦在可用状态之外」。两钩子仍真挂上（Observer 合同，无拒绝通道）。
    expect(wiring.hooks, '两钩子真挂上（Observer，无拒绝通道）').toEqual(['on_session_start', 'on_session_finalize'])

    // 默认无传输：即便落点不成立，也绝不会把数据发出去。
    expect((wiring.transport as Record<string, unknown>).mode).toBe('no-transport')
  } finally {
    await app.close()
  }
})
