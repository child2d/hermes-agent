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
  for (const relative of ['audit_unit.py', 'audit_egress.py', 'dashboard/plugin_api.py', '__init__.py', 'plugin.yaml']) {
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
  // 本批不新增产品写口：后端不得出现任何 /audit 写路由。
  expect(api, 'W5/W6 不得带 /audit 写路由').not.toMatch(/@router\.(post|put|patch|delete)\(\s*"\/audit/)
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
