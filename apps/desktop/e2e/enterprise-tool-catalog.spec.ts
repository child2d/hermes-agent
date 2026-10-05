/**
 * Batch-2 acceptance (④): the enterprise tool-catalog page renders a REAL list.
 *
 * Launches the dev desktop app in an isolated sandbox (out-of-repo temp root,
 * independent userData, HOME=sandbox; never touches a running user instance),
 * seeds the enterprise plugin + a stand-in shaoke-cli that prints a real
 * catalog, opens /plankton-tools from its sidebar nav row, and asserts the
 * rendered text. This is the regression guard for the React `style`-string bug
 * (React #62) in plasma-enterprise/desktop/plugin.js that crashed the page.
 *
 * Prerequisite: `npm run build` (dist/ present). Run with:
 *   npx playwright test e2e/enterprise-tool-catalog.spec.ts
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { expect, test } from '@playwright/test'

import { buildAppEnv, createSandbox, launchDesktop, waitForAppReady } from './fixtures'
import { writeEnvFile, writeMockProviderConfig } from '../../../tests-js/scripts/mock-provider-config'
import { startMockServer } from '../../../tests-js/scripts/mock-server'

test.describe.configure({ timeout: 180_000 })

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const ENTERPRISE = path.join(DESKTOP_ROOT, 'enterprise', 'plankton-enterprise')

// Variant gate: this spec exercises the ENTERPRISE (Plankton) build's tool page.
// Nothing here proves enterprise behavior on a non-enterprise build — the page
// and the SSO gate only exist for `HERMES_DESKTOP_VARIANT=plankton` — so running
// it against upstream (where the nav row is absent) is either a false pass or a
// flaky failure, i.e. a "fake guarantee". Skip unless the variant is plankton;
// `buildAppEnv` passes `HERMES_DESKTOP_VARIANT` through to the app, so the gate
// and the launched app agree on the variant. CI's enterprise lane sets it.
const ENTERPRISE_VARIANT = process.env.HERMES_DESKTOP_VARIANT === 'plankton'
test.skip(
  !ENTERPRISE_VARIANT,
  'enterprise-only UI: run with HERMES_DESKTOP_VARIANT=plankton (see scripts/plankton-pack.sh)'
)

const CATALOG = {
  ok: true,
  data: {
    services: [
      {
        name: 'code-repo',
        description: '代码仓库（只读查询）',
        tools: [
          { name: 'repo.list', full_name: 'code-repo repo.list', risk: 'read', description: '列出仓库' },
          { name: 'repo.archive', full_name: 'code-repo repo.archive', risk: 'write', description: '归档仓库' }
        ]
      },
      {
        name: 'knowledge',
        description: '企业知识库',
        tools: [{ name: 'kb.search', full_name: 'knowledge kb.search', risk: 'read', description: '检索知识库' }]
      }
    ]
  }
}

test('enterprise tool catalog renders the real shaoke-cli catalog', async () => {
  const mock = await startMockServer()
  const sandbox = createSandbox('ent-catalog')
  const home = sandbox.hermesHome

  // Mock provider so the app boots past onboarding; the plugin allow-list is
  // what lets the backend mount the plugin's dashboard API.
  writeMockProviderConfig(home, mock.url, undefined, 'plugins:\n  enabled:\n    - plankton-enterprise\n')
  writeEnvFile(home)

  // The enterprise build is fail-closed behind SSO: with no session it never
  // spawns the backend and refuses the plugin's REST. Seed the app's OWN
  // persisted session shape with a fake identity — a local fact, no secret —
  // so the gate opens for this isolated run.
  const ssoDir = path.join(sandbox.userDataDir, 'plankton-state', 'sso')
  fs.mkdirSync(ssoDir, { recursive: true })
  fs.writeFileSync(
    path.join(ssoDir, 'session.json'),
    JSON.stringify({ whoami: { subject: 'e2e-tester', displayName: 'E2E Tester' }, refreshToken: null }, null, 2)
  )

  const pluginDest = path.join(home, 'plugins', 'plankton-enterprise')
  const desktopDest = path.join(home, 'desktop-plugins', 'plankton-enterprise')
  fs.mkdirSync(path.join(pluginDest, 'dashboard'), { recursive: true })
  fs.mkdirSync(desktopDest, { recursive: true })
  for (const rel of ['plugin.yaml', '__init__.py', 'dashboard/manifest.json', 'dashboard/plugin_api.py']) {
    fs.copyFileSync(path.join(ENTERPRISE, rel), path.join(pluginDest, rel))
  }
  fs.copyFileSync(path.join(ENTERPRISE, 'desktop', 'plugin.js'), path.join(desktopDest, 'plugin.js'))

  // Stand-in enterprise CLI at the enterprise location the backend prefers.
  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  const cli = path.join(home, 'bin', 'shaoke-cli')
  fs.writeFileSync(cli, `#!/bin/sh\ncat <<'JSON'\n${JSON.stringify(CATALOG)}\nJSON\n`)
  fs.chmodSync(cli, 0o755)

  const { app, page } = await launchDesktop(buildAppEnv(sandbox))

  try {
    await waitForAppReady({ page, app } as unknown as Parameters<typeof waitForAppReady>[0], 90_000)

    // Make the variant gate a REAL guarantee: prove the launched artifact is the
    // enterprise build (the preload bridge flag the renderer gates on). If the
    // app were built without the variant, this fails loudly here rather than
    // letting the spec pass on an upstream artifact.
    expect(
      await page.evaluate(() => (window as unknown as { hermesDesktop?: { enterpriseEnabled?: boolean } }).hermesDesktop?.enterpriseEnabled === true),
      'the launched app must be the enterprise (plankton) variant for this spec to be meaningful'
    ).toBe(true)

    const nav = page.locator('[data-slot="sidebar"] button', { hasText: '企业工具' }).first()
    await nav.waitFor({ state: 'visible', timeout: 30_000 })
    await nav.click()

    await expect(page.getByText('企业工具目录', { exact: false }).first()).toBeVisible({ timeout: 30_000 })
    await expect(page.getByText('code-repo', { exact: false }).first()).toBeVisible({ timeout: 30_000 })

    const text = await page.locator('body').innerText()
    expect(text).toContain('knowledge')
    expect(text).toContain('repo.list')
    expect(text).toContain('kb.search')
    expect(text, 'the CLI source line should name the enterprise copy').toContain('enterprise')
    expect(text, 'must not render a minified React error').not.toContain('Minified React error')
    expect(text).not.toContain('#62')

    await page.screenshot({ path: test.info().outputPath('tool-catalog.png') })
  } finally {
    await app.close().catch(() => undefined)
    await mock.close().catch(() => undefined)
    sandbox.cleanup()
  }
})
