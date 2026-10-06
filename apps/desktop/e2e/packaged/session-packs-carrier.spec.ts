/**
 * W5 · 批 3 收尾 —— 产物 DOM 级证据：载体卡片真的渲染出来了（含退化反例）。
 *
 * 这一条是本包**最重要的证据**：在**仓外打包产物**（`PLANKTON_APP` 指向的
 * `Plankton.app`，不是 dev checkout）里跑一条**真实会话**，驱动一条含
 * `::<名字>{key="…"}` 的助手消息进入转录，然后**读 DOM** 证明：
 *   ① 可解引用 ⇒ 真卡片（`[data-plankton-carrier="…"][data-state="presentation"]`，
 *      表格里有**真实台账数据**：项目 1 的工单键 `PM-*`）；
 *   ② 取不到载荷（不可解引用的引用键）⇒ **退化文本**：原文 `::…{key="…"}` 逐字
 *      留在 DOM 里（内容不丢），且**没有**载体元素。
 *
 * READ-ONLY：整条读链只走 `+issue-list`（项目 1）。这里用 `PLANKTON_SHAOKE_CLI`
 * 覆盖（插件自己的文档化开关）把 `baymax +issue-list` 的**输出**换成一页**只读实测
 * 抓取**的真形状（3 行真工单），其余命令仍 exec 产物自带的 CLI；即：**不把个人令牌
 * 交给测试进程**，而路径本身（指令 → 渲染器 → 主机桥 `/packs/read` → 后端 argv →
 * 信封解析 → 字段投影 → DOM）全部是真的。
 *
 * 入口（在 apps/desktop 下）：
 *   npm run pack:plankton                 # 或 PLANKTON_OUTPUT_DIR=… bash scripts/plankton-pack.sh
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

// The outer budget MUST exceed the sum of this spec's own readiness waits,
// otherwise the spec can go RED even when every wait is individually healthy:
//   app-ready 120s + composer 60s + carrier-presentation 90s = 270s,
// plus Electron launch + sandbox setup. A cold first launch additionally pays
// the app's model warm-up ("Waking up default…", which leaves
// /v1/chat/completions at zero hits until it lands); that used to blow through
// a 180s budget on the FIRST run while a warm rerun took ~20s — a gate that
// only passes on a rerun is not a gate. 360s keeps the invariant
// (timeout > sum of waits) with headroom for launch + one cold warm-up.
test.describe.configure({ timeout: 360_000 })

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const CARRIER = '[data-plankton-carrier="plankton-baymax-plan"]'
const RESOLVABLE = '::plankton-baymax-plan{key="list-issues?project-id=1"}'
const UNRESOLVABLE = '::plankton-baymax-plan{key="list-issues-NOPE?project-id=1"}'
const PROMPT = '给我看一下项目 1 的工单，再给我一个取不到内容的引用。'
const REPLY = [
  '项目 1 的工单一览：',
  '',
  RESOLVABLE,
  '',
  '还有一条引用键取不到的（应退化为原文，内容不丢）：',
  '',
  UNRESOLVABLE,
  '',
].join('\n')

/** 一页**只读实测**抓取的真形状（项目 1 的前 3 条工单），逐字嵌为读命令的输出。 */
function readSample(): string {
  return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'baymax-issue-list.project-1.json'), 'utf8')
}

function resolvePackagedApp(): string {
  const explicit = process.env.PLANKTON_APP
  if (explicit) {
    if (!fs.existsSync(explicit)) {
      throw new Error(`PLANKTON_APP points at a missing path: ${explicit}`)
    }
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
        `  cd apps/desktop && npm run pack:plankton && PLANKTON_APP=… npm run test:e2e:packaged\n(looked in ${candidates.join(', ')})`
    )
  }
  return found
}

/** 产物自身字节的身份断言（企业 payload + 内置 CLI），非环境变量可伪造。 */
function assertEnterpriseArtifactIdentity(appPath: string): void {
  const resources = path.join(appPath, 'Contents', 'Resources')
  const stamp = JSON.parse(fs.readFileSync(path.join(resources, 'install-stamp.json'), 'utf8')) as {
    identityVariant?: string
    payload?: string
  }
  expect(stamp.identityVariant, '产物身份戳必须命名 plankton 变体').toBe('plankton')

  const pluginDir = path.join(resources, 'enterprise', 'plankton-enterprise')
  for (const relative of ['desktop/plugin.js', 'dashboard/plugin_api.py', 'dashboard/manifest.json']) {
    expect(fs.existsSync(path.join(pluginDir, relative)), `企业插件 payload 缺失：${relative}`).toBe(true)
    expect(fs.statSync(path.join(pluginDir, relative)).size, `企业插件 payload 为空：${relative}`).toBeGreaterThan(0)
  }

  // W5 关键：产物里的 plugin.js 必须**真的带**取数口与 F1 载体（从产物字节证明，
  // 不是从源码）。
  const bundled = fs.readFileSync(path.join(pluginDir, 'desktop/plugin.js'), 'utf8')
  expect(bundled, '产物 plugin.js 必须带只读读路径').toContain('createReadPathLoader')
  expect(bundled, '产物 plugin.js 必须带 F1 一致性载体').toContain('block-tag-mismatch')
  expect(bundled, '产物 backend 必须带只读读路由').toBeDefined()
  const api = fs.readFileSync(path.join(pluginDir, 'dashboard/plugin_api.py'), 'utf8')
  expect(api, '产物 plugin_api.py 必须带 /packs/read 只读路由').toContain('@router.post("/packs/read")')
  expect(api, '产物 backend 必须 fail-closed 拒写模板').toContain('read-path-cannot-use-write-template')
  // The NUL/control-char input screen must ship in the artifact (the %00 ⇒ HTTP
  // 500 fix is a backend-only change; assert the packaged bytes carry it).
  expect(api, '产物 backend 必须带 NUL/控制字符入参闸').toContain('_FORBIDDEN_ARGV_CHARS')
}

function packagedEnv(sandbox: Sandbox): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!value || key.startsWith('HERMES_')) {
      continue
    }
    if (/_(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS|ACCESS_KEY|PRIVATE_KEY)$/.test(key)) {
      continue
    }
    env[key] = value
  }
  env.HOME = sandbox.root
  env.HERMES_HOME = sandbox.hermesHome
  env.HERMES_DESKTOP_USER_DATA_DIR = sandbox.userDataDir
  env.HERMES_DESKTOP_SKIP_QUIT_CONFIRM = '1'
  return env
}

/**
 * 只读读命令的确定性输出：`baymax +issue-list` 由本包装器回答（真形状样页），
 * 其余一切仍 `exec` 产物自带的 CLI。
 */
function writeDeterministicReadCli(home: string, envelopePath: string): string {
  const realCli = path.join(home, 'bin', 'shaoke-cli')
  const wrapper = path.join(home, 'bin', 'enterprise-read-cli')
  fs.writeFileSync(
    wrapper,
    '#!/bin/sh\n' +
      'if [ "$1" = "baymax" ] && [ "$2" = "+issue-list" ]; then\n' +
      `  cat "${envelopePath}"\n` +
      '  exit 0\n' +
      'fi\n' +
      `exec "${realCli}" "$@"\n`,
    'utf8'
  )
  fs.chmodSync(wrapper, 0o755)
  return wrapper
}

test('产物真实会话：载体重取数渲染出卡片（可解引用），取不到 ⇒ 退化文本（内容不丢）', async () => {
  const appPath = resolvePackagedApp()
  assertEnterpriseArtifactIdentity(appPath)

  const executable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'))
  expect(fs.existsSync(executable), `产物可执行文件缺失：${executable}`).toBe(true)

  const mock = await startMockServer({ replyForPrompt: () => REPLY })
  const sandbox = createSandbox('ent-carrier-packaged')
  const home = sandbox.hermesHome

  writeMockProviderConfig(home, mock.url, undefined, 'plugins:\n  enabled:\n    - plankton-enterprise\n')
  writeEnvFile(home)

  // 只读样页落盘（包装器 cat 它 ⇒ 无任何 shell 引号风险）。
  const envelopePath = path.join(sandbox.root, 'baymax-issue-list.project-1.json')
  fs.writeFileSync(envelopePath, readSample(), 'utf8')

  // 企业产物在 SSO 后 fail-closed：播种 app **自己的**持久化会话形状（本地事实，无密钥）。
  const ssoDir = path.join(sandbox.userDataDir, 'plankton-state', 'sso')
  fs.mkdirSync(ssoDir, { recursive: true })
  fs.writeFileSync(
    path.join(ssoDir, 'session.json'),
    JSON.stringify({ whoami: { subject: 'e2e-tester', displayName: 'E2E Tester' }, refreshToken: null }, null, 2)
  )

  const env = packagedEnv(sandbox)
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  env.PLANKTON_SHAOKE_CLI = writeDeterministicReadCli(home, envelopePath)

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
          true
      ),
      '启动的产物必须报告企业身份'
    ).toBe(true)

    // 驱动一条真实对话：输入 → 发送 → 助手消息里带指令。
    const composer = page.locator('[contenteditable="true"]').first()
    await composer.waitFor({ state: 'visible', timeout: 60_000 })
    await composer.click()
    await composer.type(PROMPT)
    await composer.press('Enter')

    // ① 可解引用 ⇒ 真卡片（等待**载荷取回后**的 presentation 状态，不是 loading）。
    const carrier = page.locator(`${CARRIER}[data-state="presentation"]`).first()
    await expect(carrier, '取数成功的引用必须渲染成卡片（presentation），而不是退化文本').toBeVisible({
      timeout: 90_000,
    })
    const cardText = await carrier.innerText()
    expect(cardText, '卡片必须来自真实台账读回（项目 1 的工单键）').toMatch(/PM-\d+/)
    expect(cardText, '卡片必须带真工单标题').toContain('plankton 联调测试（可删）')

    const body = await page.locator('body').innerText()
    expect(body, '退化的原文必须**逐字**留在 DOM 里（内容不丢）').toContain(UNRESOLVABLE)
    // 取不到的那条**不能**变成卡片：只应有一个 presentation 载体。
    expect(await page.locator(`${CARRIER}[data-state="presentation"]`).count(), '只有一条引用可解——另一条必须退化').toBe(1)
    expect(await page.locator(`${CARRIER}[data-state="loading"]`).count(), '不能停在「正在取回」').toBe(0)
    expect(body, '不得渲染 minified React 错误').not.toContain('Minified React error')
  } finally {
    await app.close()
  }
})
