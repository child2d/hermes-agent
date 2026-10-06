/**
 * 批 3 · 收尾 —— 产物 DOM 级证据：**新建草稿卡的提案入口**（agent 交提案 ⇒ 草稿卡真渲染）。
 *
 * 这一条在**仓外打包产物**（`PLANKTON_APP` 指向的 `Plankton.app`，不是 dev checkout）里跑
 * 一条**真实会话**，驱动一条含 `::plankton-baymax-new{key="baymax:<token>"}` 的助手消息进入
 * 转录，然后**读 DOM** 证明：
 *   ① 引用键可解（出件箱里有这条**提案**）⇒ 真**草稿卡**：`data-state="card"`，卡上有
 *      agent 起草的标题、有「还缺」的人类字段（**「（等你给）」**），以及确认动作入口；
 *   ② **不点确认 ⇒ 零写入**：整条链一个写命令都没跑（CLI 包装器把每次调用记进 spawn 日志，
 *      断言日志里**没有** `+issue-create`/`+issue-update`/`+issue-comment`）；
 *   ③ 反例：不可解引用的键 ⇒ **退化文本**（原文逐字留在 DOM，且没有载体元素）。
 *
 * 读链全真：指令 → 渲染器 → 主机桥 `/packs/proposal` → 后端从出件箱取回 → 字段投影 → DOM。
 * 出件箱是插件自己的**草稿出件箱**（不是台账）：测试在沙箱 `HERMES_HOME` 下落一条提案即可
 * ——这与 agent 调 `plankton_propose_draft` 工具落下的条目**同形同文件**。
 *
 * 入口（在 apps/desktop 下）：
 *   npm run pack:plankton
 *   PLANKTON_APP=/path/to/Plankton.app npm run test:e2e:packaged
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { _electron, expect, test } from '@playwright/test'

import { writeEnvFile, writeMockProviderConfig } from '../../../../tests-js/scripts/mock-provider-config'
import { startMockServer } from '../../../../tests-js/scripts/mock-server'
import { createSandbox, type Sandbox, waitForAppReady } from '../fixtures'

// 与载体 spec 同口径：外层预算 > 各段等待之和（app-ready 120s + composer 60s + card 90s）。
test.describe.configure({ timeout: 360_000 })

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const CARRIER = '[data-plankton-carrier="plankton-baymax-new"]'
const REF_TOKEN = 'deadbeef0001'
const RESOLVABLE = `::plankton-baymax-new{key="baymax:${REF_TOKEN}"}`
const UNRESOLVABLE = '::plankton-baymax-new{key="baymax:ffffffffffff"}'
const DRAFT_TITLE = '修复登录流程'
const PROMPT = '把「修复登录流程」起草成一条工单草稿，再给我一个取不到内容的引用。'
const REPLY = [
  '我先把草稿提出来（还没写台账，等你确认）：',
  '',
  RESOLVABLE,
  '',
  '还有一个取不到的引用键（应退化为原文，内容不丢）：',
  '',
  UNRESOLVABLE,
  '',
].join('\n')

function resolvePackagedApp(): string {
  const explicit = process.env.PLANKTON_APP
  if (explicit) {
    if (!fs.existsSync(explicit)) throw new Error(`PLANKTON_APP points at a missing path: ${explicit}`)
    return explicit
  }
  const candidates = [
    path.join(DESKTOP_ROOT, 'release', 'mac-arm64', 'Plankton.app'),
    path.join(DESKTOP_ROOT, 'release', 'mac', 'Plankton.app'),
  ]
  const found = candidates.find((candidate) => fs.existsSync(candidate))
  if (!found) {
    throw new Error(
      'No packaged Plankton.app found — this lane tests the ARTIFACT:\n' +
        `  cd apps/desktop && npm run pack:plankton && PLANKTON_APP=… npm run test:e2e:packaged\n(looked in ${candidates.join(', ')})`,
    )
  }
  return found
}

/** 产物自身字节的身份断言（企业 payload + 提案入口 + 内置 CLI），非环境变量可伪造。 */
function assertEnterpriseArtifactIdentity(appPath: string): void {
  const resources = path.join(appPath, 'Contents', 'Resources')
  const stamp = JSON.parse(fs.readFileSync(path.join(resources, 'install-stamp.json'), 'utf8')) as {
    identityVariant?: string
    payload?: string
  }
  expect(stamp.identityVariant, '产物身份戳必须命名 plankton 变体').toBe('plankton')

  const pluginDir = path.join(resources, 'enterprise', 'plankton-enterprise')
  for (const relative of ['desktop/plugin.js', 'dashboard/plugin_api.py', 'proposals.py', 'dashboard/manifest.json', '__init__.py']) {
    expect(fs.existsSync(path.join(pluginDir, relative)), `企业插件 payload 缺失：${relative}`).toBe(true)
    expect(fs.statSync(path.join(pluginDir, relative)).size, `企业插件 payload 为空：${relative}`).toBeGreaterThan(0)
  }

  // 提案入口必须**真的在产物字节里**（不是源码里）。
  const bundled = fs.readFileSync(path.join(pluginDir, 'desktop/plugin.js'), 'utf8')
  for (const marker of ['createProposalLoader', '/packs/proposal', 'isProposalBlock']) {
    expect(bundled, `产物 plugin.js 必须带提案口（缺 ${marker}）`).toContain(marker)
  }
  const api = fs.readFileSync(path.join(pluginDir, 'dashboard/plugin_api.py'), 'utf8')
  expect(api, '产物 backend 必须带只读提案路由').toContain('@router.post("/packs/proposal")')
  const proposals = fs.readFileSync(path.join(pluginDir, 'proposals.py'), 'utf8')
  expect(proposals, '产物 proposals.py 必须带人类字段硬约束').toContain('field-tier-not-agent-draftable')
  expect(proposals, '产物 proposals.py 必须带那一个提案工具').toContain('plankton_propose_draft')
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

/** 落一条**提案**到插件的草稿出件箱（与 agent 工具落下的条目同形同文件）。 */
function seedProposal(hermesHome: string, { ref, title }: { ref: string; title: string }): void {
  const now = Date.now()
  const dir = path.join(hermesHome, 'plankton-enterprise')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, 'proposals.json'),
    JSON.stringify(
      {
        version: 1,
        proposals: {
          [ref]: {
            ref,
            packId: 'baymax',
            block: 'plankton-baymax-new',
            record: { title },
            actions: ['confirm-create', 'discard'],
            createdAt: now,
            expiresAt: now + 30 * 60 * 1000,
          },
        },
      },
      null,
      2,
    ),
    'utf8',
  )
}

/**
 * 会把**每一次调用**记进 `logPath` 的 CLI 包装器；随后 `exec` 产物自带的真 CLI（本 spec 里
 * 提案口不 spawn，所以日志应当为空——任何写命令的出现都说明「不点确认也写了」）。
 */
function writeSpyCli(home: string, logPath: string): string {
  const realCli = path.join(home, 'bin', 'shaoke-cli')
  const wrapper = path.join(home, 'bin', 'enterprise-spy-cli')
  fs.writeFileSync(
    wrapper,
    '#!/bin/sh\n' +
      `echo "$@" >> "${logPath}"\n` +
      `exec "${realCli}" "$@"\n`,
    'utf8',
  )
  fs.chmodSync(wrapper, 0o755)
  return wrapper
}

test('产物真实会话：agent 的提案 ⇒ 草稿卡真渲染；不点确认 ⇒ 零写入；取不到 ⇒ 退化文本', async () => {
  const appPath = resolvePackagedApp()
  assertEnterpriseArtifactIdentity(appPath)

  const executable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'))
  expect(fs.existsSync(executable), `产物可执行文件缺失：${executable}`).toBe(true)

  const mock = await startMockServer({ replyForPrompt: () => REPLY })
  const sandbox = createSandbox('ent-proposal-packaged')
  const home = sandbox.hermesHome

  writeMockProviderConfig(home, mock.url, undefined, 'plugins:\n  enabled:\n    - plankton-enterprise\n')
  writeEnvFile(home)

  const ref = `baymax:${REF_TOKEN}`
  seedProposal(home, { ref, title: DRAFT_TITLE })

  // 企业产物在 SSO 后 fail-closed：播种 app 自己的持久化会话形状（本地事实，无密钥）。
  const ssoDir = path.join(sandbox.userDataDir, 'plankton-state', 'sso')
  fs.mkdirSync(ssoDir, { recursive: true })
  fs.writeFileSync(
    path.join(ssoDir, 'session.json'),
    JSON.stringify({ whoami: { subject: 'e2e-tester', displayName: 'E2E Tester' }, refreshToken: null }, null, 2),
  )

  const spawnLog = path.join(sandbox.root, 'cli-spawns.log')
  const env = packagedEnv(sandbox)
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  env.PLANKTON_SHAOKE_CLI = writeSpyCli(home, spawnLog)

  const app = await _electron.launch({
    executablePath: executable,
    args: ['--disable-gpu', '--no-sandbox'],
    env,
    cwd: os.tmpdir(),
  })

  try {
    const page = await app.firstWindow()
    await waitForAppReady({ page, app } as unknown as Parameters<typeof waitForAppReady>[0], 120_000)

    expect(
      await page.evaluate(
        () =>
          (window as unknown as { hermesDesktop?: { enterpriseEnabled?: boolean } }).hermesDesktop?.enterpriseEnabled ===
          true,
      ),
      '启动的产物必须报告企业身份',
    ).toBe(true)

    const composer = page.locator('[contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 60_000 })
    await composer.click()
    await composer.type(PROMPT)
    await composer.press('Enter')

    // ① 可解引用 ⇒ 真**草稿卡**（等取回提案**之后**的 card 状态，不是 loading）。
    const carrier = page.locator(`${CARRIER}[data-state="card"]`).first()
    await expect(carrier, '出件箱里的提案必须渲染成草稿卡，而不是退化文本').toBeVisible({ timeout: 90_000 })
    const cardText = await carrier.innerText()
    expect(cardText, '卡上必须有 agent 起草的标题').toContain(DRAFT_TITLE)
    expect(cardText, '人类字段必须由人给（卡片显示「（等你给）」），agent 不得代填').toContain('（等你给）')
    expect(cardText, '卡上必须有确认动作入口（人在环）').toContain('确认新建')

    // ③ 反例：不可解引用 ⇒ 退化文本（原文逐字留在 DOM，内容不丢）。
    const body = await page.locator('body').innerText()
    expect(body, '退化的原文必须**逐字**留在 DOM 里').toContain(UNRESOLVABLE)
    expect(await page.locator(`${CARRIER}[data-state="card"]`).count(), '只有一条引用可解——另一条必须退化').toBe(1)
    expect(await page.locator(`${CARRIER}[data-state="loading"]`).count(), '不能停在「正在取回」').toBe(0)
    expect(body, '不得渲染 minified React 错误').not.toContain('Minified React error')

    // ② 不点确认 ⇒ 零写入：spawn 日志里一个写命令都没有。
    const log = fs.existsSync(spawnLog) ? fs.readFileSync(spawnLog, 'utf8') : ''
    const writes = log.split('\n').filter((line) => /\+issue-(create|update|comment|link)|delet/i.test(line))
    expect(writes, `不点确认 ⇒ 台账零写入（实测 spawn: ${JSON.stringify(log)}）`).toEqual([])
  } finally {
    await app.close()
  }
})
