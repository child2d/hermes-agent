/**
 * Enterprise (Plankton) tool-catalog acceptance — PACKAGED-ARTIFACT lane.
 *
 * Runs the REAL `Plankton.app` the pack produces (NOT the dev harness), proves
 * the artifact's IDENTITY from its own files, then boots it in an isolated
 * sandbox and asserts the real tool-catalog page renders the real bundled CLI's
 * catalog.
 *
 * WHY THIS SHAPE (batch-2 third review, P6-1 + P6-2)
 * --------------------------------------------------
 * The previous spec lived in the dev suite and gated itself on
 * HERMES_DESKTOP_VARIANT=plankton — which no CI lane sets (permanent skip = fake
 * green) and which it also passed straight through to the app, making its
 * `enterpriseEnabled === true` assertion a TAUTOLOGY: a dev bundle derives
 * PRODUCT_IDENTITY live from that very env var, so the assertion only proved the
 * var was set. It also could not really run in dev — the enterprise spawn gate
 * pins launcher discovery to `<HERMES_HOME>/bin`, which a dev checkout lacks.
 *
 * So:
 *   - the spec is OUT of the dev default set (root playwright.config.ts ignores
 *     `packaged/**`); see ./playwright.config.ts;
 *   - identity is proven from the ARTIFACT (install-stamp variant + the
 *     `enterprise/` Resources tree), never from an env var;
 *   - the app is launched with NO `HERMES_*` passthrough, so the identity it
 *     reports is baked into the artifact, not handed to it.
 *
 * Entry command (from apps/desktop):
 *   npm run pack:plankton        # build release/mac-arm64/Plankton.app
 *   npm run test:e2e:packaged
 * Point at another artifact with PLANKTON_APP=/path/to/Plankton.app.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import { _electron, expect, test } from '@playwright/test'

import { writeEnvFile, writeMockProviderConfig } from '../../../../tests-js/scripts/mock-provider-config'
import { startMockServer } from '../../../../tests-js/scripts/mock-server'
import { createSandbox, type Sandbox, waitForAppReady } from '../fixtures'

test.describe.configure({ timeout: 180_000 })

const DESKTOP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const REPO_ROOT = path.resolve(DESKTOP_ROOT, '..', '..')

/**
 * The ENGINE's own ``tools.skills_guard.content_hash``, run in a SEPARATE Python
 * process as an INDEPENDENT oracle for the hash the page displays.
 *
 * Deliberately NOT a JS re-implementation of the digest: the whole point of the
 * batch-2 step-2 hash parity check is that the page and the engine share ONE
 * implementation. A hand-copied JS hasher would defeat it.
 */
function engineContentHash(dir: string): string {
  const python =
    process.env.HERMES_TEST_PYTHON || path.join(REPO_ROOT, '.venv', 'bin', 'python3')
  const script =
    'import sys\nfrom pathlib import Path\nfrom tools.skills_guard import content_hash\nprint(content_hash(Path(sys.argv[1])))\n'
  return execFileSync(python, ['-c', script, dir], { cwd: REPO_ROOT, encoding: 'utf8' }).trim()
}


/**
 * A deterministic `skillhub` source for the market page — WITHOUT weakening the
 * tools-page evidence. The wrapper execs the SAME seeded CLI the artifact
 * dropped (so `tools list`, and therefore the whole tool catalog, still comes
 * from the artifact's binary byte-for-byte) and answers only `skillhub`
 * subcommands from a fixed catalog. `PLANKTON_SHAOKE_CLI` is the plugin's own
 * documented override, so GET /skills becomes reproducible — which is what makes
 * the version/manage/batch UI states (F-1) assertable at all; before this the
 * catalog came from a live network call and none of those states were checked.
 *
 * Placed in `<home>/bin` under a distinct name: the seeded `shaoke-cli` (and its
 * byte-equality assertion against the artifact) is left exactly as the app
 * dropped it. Returns the wrapper path.
 */
function writeDeterministicMarketCli(home: string, items: unknown[]): string {
  const realCli = path.join(home, 'bin', 'shaoke-cli')
  const wrapper = path.join(home, 'bin', 'enterprise-shaoke-cli')
  const envelope = JSON.stringify({ ok: true, data: { items, nextCursor: null } })
  if (envelope.includes("'")) {
    throw new Error('the fixed catalog must not contain a single quote (shell quoting)')
  }
  fs.writeFileSync(
    wrapper,
    '#!/bin/sh\n' +
      'if [ "$1" = "skillhub" ]; then\n' +
      `  printf '%s' '${envelope}'\n` +
      '  exit 0\n' +
      'fi\n' +
      `exec "${realCli}" "$@"\n`,
    'utf8'
  )
  fs.chmodSync(wrapper, 0o755)
  return wrapper
}

/**
 * Seed ONE locally-installed skill landing (the engine's lock record for it is
 * written by the caller into ``skills/.hub/lock.json``). Returns the landing so
 * the caller can hash it with the engine's own function.
 */
function seedInstalledSkill(home: string, name: string, body = '# e2e market skill\nbody\n'): string {
  const landing = path.join(home, 'skills', name)
  fs.mkdirSync(landing, { recursive: true })
  fs.writeFileSync(path.join(landing, 'SKILL.md'), body, 'utf8')
  return landing
}

/** Resolve the packaged Plankton.app, or fail loudly (never a silent skip). */
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
    path.join(DESKTOP_ROOT, 'release', 'mac', 'Plankton.app')
  ]

  const found = candidates.find(candidate => fs.existsSync(candidate))

  if (!found) {
    throw new Error(
      'No packaged Plankton.app found. This lane tests the ARTIFACT, not the dev checkout:\n' +
        '  cd apps/desktop && npm run pack:plankton && npm run test:e2e:packaged\n' +
        `(looked in: ${candidates.join(', ')}; override with PLANKTON_APP=/path/to/Plankton.app)`
    )
  }

  return found
}

/**
 * Proves the launched artifact IS the enterprise build from its own bytes:
 * the baked install stamp's `identityVariant`, plus the `enterprise/` Resources
 * tree (plugin payload + the per-os/arch bundled CLI). This is the non-tautological
 * identity check the review asked for — it cannot be satisfied by an env var.
 */
function assertEnterpriseArtifactIdentity(appPath: string): { cliPath: string } {
  const resources = path.join(appPath, 'Contents', 'Resources')

  const stampPath = path.join(resources, 'install-stamp.json')
  expect(fs.existsSync(stampPath), `install-stamp.json must be baked into the artifact (${stampPath})`).toBe(true)
  const stamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')) as { payload?: string; identityVariant?: string }
  expect(stamp.identityVariant, 'the artifact install stamp must name the plankton variant').toBe('plankton')
  expect(stamp.payload, 'the plankton variant rides the bundled payload').toBe('bundled')

  const pluginDir = path.join(resources, 'enterprise', 'plankton-enterprise')

  for (const relative of ['plugin.yaml', 'dashboard/manifest.json', 'dashboard/plugin_api.py', 'desktop/plugin.js']) {
    expect(fs.existsSync(path.join(pluginDir, relative)), `enterprise plugin payload missing: ${relative}`).toBe(true)
  }

  const cliRoot = path.join(resources, 'enterprise', 'cli')
  expect(fs.existsSync(cliRoot), `bundled enterprise CLI tree missing: ${cliRoot}`).toBe(true)
  const osPrefix = process.platform === 'darwin' ? 'darwin-' : `${process.platform}-`
  const cliDirName = fs.readdirSync(cliRoot).find(entry => entry.startsWith(osPrefix))
  expect(cliDirName, `no ${osPrefix}* CLI dir under ${cliRoot}`).toBeTruthy()
  const cliPath = path.join(cliRoot, cliDirName as string, process.platform === 'win32' ? 'shaoke-cli.exe' : 'shaoke-cli')
  expect(fs.existsSync(cliPath), `bundled enterprise CLI missing: ${cliPath}`).toBe(true)
  expect(fs.statSync(cliPath).size, `bundled enterprise CLI is empty: ${cliPath}`).toBeGreaterThan(0)

  if (process.platform !== 'win32') {
    expect(fs.statSync(cliPath).mode & 0o111, `bundled enterprise CLI is not executable: ${cliPath}`).not.toBe(0)
  }

  return { cliPath }
}

/**
 * The launched app's environment. Deliberately strips EVERY inherited
 * `HERMES_*` var (so `HERMES_DESKTOP_VARIANT` can never reach the app — the
 * variant must be baked into the artifact) and any credential-shaped var.
 */
function packagedEnv(sandbox: Sandbox): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [key, value] of Object.entries(process.env)) {
    if (!value) {
      continue
    }

    if (key.startsWith('HERMES_')) {
      continue
    }

    if (/_(API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS|ACCESS_KEY|PRIVATE_KEY)$/.test(key)) {
      continue
    }

    env[key] = value
  }

  // HOME → sandbox so Electron's appData (~/Library/Application Support) and the
  // enterprise home all live in the sandbox; nothing under the real user profile
  // is read or written.
  env.HOME = sandbox.root
  env.HERMES_HOME = sandbox.hermesHome
  env.HERMES_DESKTOP_USER_DATA_DIR = sandbox.userDataDir
  env.HERMES_DESKTOP_SKIP_QUIT_CONFIRM = '1'

  return env
}

test('the packaged Plankton artifact renders the REAL bundled shaoke-cli catalog', async () => {
  const appPath = resolvePackagedApp()
  const { cliPath } = assertEnterpriseArtifactIdentity(appPath)

  const executable = path.join(appPath, 'Contents', 'MacOS', path.basename(appPath, '.app'))
  expect(fs.existsSync(executable), `packaged executable missing: ${executable}`).toBe(true)

  const mock = await startMockServer()
  const sandbox = createSandbox('ent-catalog-packaged')
  const home = sandbox.hermesHome

  // Mock provider so the app boots past onboarding; the plugin allow-list lets
  // the backend mount the plugin's dashboard API.
  writeMockProviderConfig(home, mock.url, undefined, 'plugins:\n  enabled:\n    - plankton-enterprise\n')
  writeEnvFile(home)

  // Seed THREE locally-installed skills + their records in the ENGINE's OWN hub
  // lock file (``skills/.hub/lock.json``) — the page reads engine facts, not a
  // private ledger of ours. One recorded hash is deliberately bogus (the page
  // must surface "哈希不符"/local edits while still printing the current,
  // engine-computed hash for parity); the other two are the REAL engine hash, so
  // the version comparison (F-1) can actually be exercised:
  //   * e2e-consistent-skill: record version == catalog version → 已装 · 一致
  //   * e2e-outdated-skill:   record version != catalog version → 已装 · 与目录不一致
  //     …and it is the item the batch entry must appear for.
  const seededSkillDir = seedInstalledSkill(home, 'e2e-market-skill')
  const consistentDir = seedInstalledSkill(home, 'e2e-consistent-skill', '# consistent\n')
  const outdatedDir = seedInstalledSkill(home, 'e2e-outdated-skill', '# outdated\n')
  // F-2: content at a landing that NO engine record attests — the page must flag
  // it ("是否改动无法判定") and the dialog must be the path that can acknowledge it.
  seedInstalledSkill(home, 'e2e-occupied-skill', '# nobody recorded this\n')

  const marketCatalog = [
    { slug: 'e2e-market-skill', name: 'e2e-market-skill', category: '', version: '9.9.9',
      install: { reference: 'e2e/owner-e2e-market-skill' } },
    { slug: 'e2e-consistent-skill', name: 'e2e-consistent-skill', category: '', version: '1.0.0',
      install: { reference: 'e2e/owner-e2e-consistent-skill' } },
    { slug: 'e2e-outdated-skill', name: 'e2e-outdated-skill', category: '', version: '2.5.0',
      install: { reference: 'e2e/owner-e2e-outdated-skill' } },
    // Not installed anywhere: the plain 取用 path (nothing at the landing).
    { slug: 'e2e-new-skill', name: 'e2e-new-skill', category: '', version: '1.0.0' },
    // Content on disk, no record: "cannot confirm clean" (F-2). No record also
    // means it is NOT a manage-action row.
    { slug: 'e2e-occupied-skill', name: 'e2e-occupied-skill', category: '', version: '1.0.0' }
  ]

  const lockEntries = (): Record<string, unknown> => ({
    'e2e-market-skill': {
      source: 'shaoke-skillhub',
      identifier: 'e2e/owner-e2e-market-skill',
      trust_level: 'community',
      scan_verdict: 'safe',
      content_hash: 'sha256:0000000000000000',
      install_path: 'e2e-market-skill',
      files: ['SKILL.md'],
      metadata: { shaoke: { slug: 'e2e-market-skill', name: 'e2e-market-skill', category: '', version: '9.9.9' } },
      scan_provenance: {},
      installed_at: '2026-10-05T00:00:00Z',
      updated_at: '2026-10-05T00:00:00Z'
    },
    'e2e-consistent-skill': {
      source: 'shaoke-skillhub',
      identifier: 'e2e/owner-e2e-consistent-skill',
      trust_level: 'community',
      scan_verdict: 'safe',
      content_hash: engineContentHash(consistentDir),
      install_path: 'e2e-consistent-skill',
      files: ['SKILL.md'],
      metadata: { shaoke: { slug: 'e2e-consistent-skill', name: 'e2e-consistent-skill', category: '', version: '1.0.0' } },
      scan_provenance: {},
      installed_at: '2026-10-05T00:00:00Z',
      updated_at: '2026-10-05T00:00:00Z'
    },
    'e2e-outdated-skill': {
      source: 'shaoke-skillhub',
      identifier: 'e2e/owner-e2e-outdated-skill',
      trust_level: 'community',
      scan_verdict: 'safe',
      content_hash: engineContentHash(outdatedDir),
      install_path: 'e2e-outdated-skill',
      files: ['SKILL.md'],
      metadata: { shaoke: { slug: 'e2e-outdated-skill', name: 'e2e-outdated-skill', category: '', version: '1.0.0' } },
      scan_provenance: {},
      installed_at: '2026-10-05T00:00:00Z',
      updated_at: '2026-10-05T00:00:00Z'
    }
  })

  fs.mkdirSync(path.join(home, 'bin'), { recursive: true })
  fs.mkdirSync(path.join(home, 'skills', '.hub'), { recursive: true })
  fs.writeFileSync(
    path.join(home, 'skills', '.hub', 'lock.json'),
    JSON.stringify({ version: 1, installed: lockEntries() }, null, 2),
    'utf8'
  )


  // The enterprise build is fail-closed behind SSO: seed the app's OWN persisted
  // session shape (a local fact, no secret) so the gate opens for this run.
  const ssoDir = path.join(sandbox.userDataDir, 'plankton-state', 'sso')
  fs.mkdirSync(ssoDir, { recursive: true })
  fs.writeFileSync(
    path.join(ssoDir, 'session.json'),
    JSON.stringify({ whoami: { subject: 'e2e-tester', displayName: 'E2E Tester' }, refreshToken: null }, null, 2)
  )

  const env = packagedEnv(sandbox)
  expect('HERMES_DESKTOP_VARIANT' in env, 'the variant must NOT be handed to the app').toBe(false)
  // Deterministic skill catalog (see writeDeterministicMarketCli): the wrapper
  // still execs the artifact's own CLI for `tools`, so the tools-page evidence
  // above is unchanged — only `skillhub` is answered from a fixed list.
  const cliWrapper = writeDeterministicMarketCli(home, marketCatalog)
  env.PLANKTON_SHAOKE_CLI = cliWrapper

  const app = await _electron.launch({
    executablePath: executable,
    args: ['--disable-gpu', '--no-sandbox'],
    env,
    cwd: os.tmpdir()
  })

  try {
    const page = await app.firstWindow()
    await waitForAppReady({ page, app } as unknown as Parameters<typeof waitForAppReady>[0], 120_000)

    // Identity fact from the RUNNING app: with no HERMES_* passthrough this can
    // only be true because the artifact itself is the enterprise build.
    expect(
      await page.evaluate(
        () =>
          (window as unknown as { hermesDesktop?: { enterpriseEnabled?: boolean } }).hermesDesktop?.enterpriseEnabled ===
          true
      ),
      'the launched artifact must report enterprise identity'
    ).toBe(true)

    const nav = page.locator('[data-slot="sidebar"] button', { hasText: '企业工具' }).first()
    await nav.waitFor({ state: 'visible', timeout: 60_000 })
    await nav.click()

    await expect(page.getByText('企业工具目录', { exact: false }).first()).toBeVisible({ timeout: 30_000 })

    const text = await page.locator('body').innerText()

    // The catalog is the REAL bundled CLI's output: `data.services[].tools[]`.
    // `cc +whoami` and the `cc` system come straight from the artifact's
    // shaoke-cli — no machine CLI, no network, no token.
    expect(text).toContain('cc')
    expect(text).toContain('cc +whoami')

    // The source line must name the ENTERPRISE copy (the seeded
    // <HERMES_HOME>/bin/shaoke-cli), never a PATH binary.
    expect(text, 'catalog must read the enterprise copy').toContain('enterprise')
    // …and the CLI path the page reports is exactly the artifact-seeded copy.
    expect(text).toContain(path.join(home, 'bin'))

    // Sanity: the seeded CLI really is the artifact's CLI (content identity).
    expect(fs.readFileSync(path.join(home, 'bin', 'shaoke-cli')).equals(fs.readFileSync(cliPath))).toBe(true)

    // …and the deterministic-market wrapper (PLANKTON_SHAOKE_CLI) changes NOTHING
    // about that evidence: for `tools` it execs the very same binary, so its
    // output is byte-identical to the artifact CLI's own run.
    expect(
      execFileSync(cliWrapper, ['tools', 'list'], { encoding: 'utf8' }),
      'the market wrapper must not alter the tools catalog'
    ).toBe(execFileSync(path.join(home, 'bin', 'shaoke-cli'), ['tools', 'list'], { encoding: 'utf8' }))

    expect(text, 'must not render a minified React error').not.toContain('Minified React error')
    expect(text).not.toContain('#62')

    // ── 企业技能市场 (batch 2 step 2) ──────────────────────────────────────
    const skillsNav = page.locator('[data-slot="sidebar"] button', { hasText: '企业技能' }).first()
    await skillsNav.waitFor({ state: 'visible', timeout: 60_000 })
    await skillsNav.click()

    // Wait for POST-LOAD content, not the loading text (which itself contains
    // "企业技能市场" — matching it would read the page mid-load and see neither
    // the catalog banner nor the failure banner).
    await expect(
      page.getByText(/企业已审技能目录已就绪|这是「取不到目录」，不是「目录为空」|读取技能市场失败/).first()
    ).toBeVisible({ timeout: 60_000 })

    const marketText = await page.locator('body').innerText()
    expect(marketText, 'the skill market must not render a minified React error').not.toContain('Minified React error')
    expect(marketText).toContain('企业技能市场')

    // The catalog must be in one of exactly TWO valid states — never a silent
    // empty page (PLK-REQ-0018: "取不到" ≠ "没有") and never a collapsed REST
    // failure ("读取技能市场失败" would mean the plugin backend itself is broken,
    // which this lane must not accept).
    const catalogReady = marketText.includes('企业已审技能目录已就绪')
    const catalogFailed = marketText.includes('这是「取不到目录」，不是「目录为空」')
    expect(
      catalogReady || catalogFailed,
      'the catalog must be either READY or a TYPED "cannot fetch ≠ empty" failure'
    ).toBe(true)
    expect(marketText, 'the plugin backend must answer GET /skills (not a request failure)').not.toContain(
      '读取技能市场失败'
    )
    // From here on the catalog is DETERMINISTIC (a fixed skillhub list), so the
    // states below are asserted against the real packaged UI instead of being
    // skipped whenever the live registry was unreachable.
    expect(
      catalogReady,
      'with a fixed skillhub catalog the market must be READY — 取不到目录 here means the PLANKTON_SHAOKE_CLI override never reached the backend'
    ).toBe(true)
    expect(marketText, 'a ready catalog must report a numeric approved-skill count').toMatch(/已审技能\s*\d+\s*条/)

    // The seeded local install is visible with its engine-computed hash, and the
    // deliberately-bogus recorded hash shows the hash-mismatch class distinctly.
    expect(marketText).toContain('本机已取用（引擎台账）')
    expect(marketText).toContain('e2e-market-skill')
    expect(marketText).toContain('哈希不符')

    // HASH PARITY: the page's displayed hash must be byte-for-byte the engine's
    // own `tools.skills_guard.content_hash` (computed in a separate process).
    const hashMatch = marketText.match(/sha256:[0-9a-f]{16}/)
    expect(hashMatch, 'the page must display a local content hash').toBeTruthy()
    const pageHash = hashMatch![0]
    const oracleHash = engineContentHash(seededSkillDir)
    expect(pageHash, `page hash ${pageHash} must equal engine content_hash ${oracleHash}`).toBe(oracleHash)

    const dialog = page.getByRole('dialog')

    // ── F-1 acceptance, on the artifact's real DOM ─────────────────────────
    // The version comparison (recorded version vs catalog version) — the state
    // that was pinned at `version-unknown` for EVERY install, which is what
    // disabled the manage actions and the batch entry.
    expect(marketText, 'record version == catalog version').toContain('已装 · 一致')
    expect(marketText, 'record version != catalog version').toContain('已装 · 与目录不一致')
    expect(marketText, 'the recorded version must be shown for the differing entry').toContain('记录版本 1.0.0')

    // Uninstall must be ENABLED for every recorded, on-disk entry. Before F-1 it
    // was permanently disabled (the version state was always version-unknown),
    // and nothing asserted it.
    const uninstall = page.getByRole('button', { name: '卸载', exact: true })
    await expect(uninstall, 'one 卸载 per recorded, on-disk catalog entry').toHaveCount(3)
    for (let index = 0; index < 3; index++) {
      expect(await uninstall.nth(index).isEnabled(), `卸载 #${index} must not be permanently disabled`).toBe(true)
    }

    // The batch entry renders for the ONE confirmed-clean `version-differs` entry
    // (the other two are `version-unknown` / `consistent`, and the drifted one is
    // held out — a batch carries no per-item overwrite acknowledgement).
    const batch = page.getByRole('button', { name: '批量更新 1 条（需确认）' })
    await expect(batch, 'a confirmed-clean version-differs entry must offer the batch update').toBeVisible({
      timeout: 10_000
    })
    expect(await batch.isEnabled()).toBe(true)
    await batch.click()
    await expect(dialog).toContainText('批量更新 1 条技能？')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // F-2/F-3: a landing that no engine record attests ("cannot confirm clean")
    // must be STATED, and the acknowledgement must be reachable — the backend
    // refuses it with `local-edits` and the page can always answer.
    expect(
      marketText,
      'content at a landing no record attests must be flagged on the entry'
    ).toContain('是否改动无法判定')
    expect(
      marketText,
      'the engine-visible drift at a recorded landing must be flagged on the entry'
    ).toContain('本地已改动')

    // A plain first install (nothing at the landing): no loss warning.
    const pickup = page.getByRole('button', { name: '取用', exact: true })
    await expect(pickup, 'the not-installed catalog entry must offer 取用').toHaveCount(1)
    await pickup.nth(0).click()
    await expect(dialog).toContainText('取用技能「e2e-new-skill」？')
    expect(
      await dialog.innerText(),
      'a landing with nothing in it must not claim a local-edit risk'
    ).not.toContain('无法判定本地是否有改动')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // The occupied landing (content, no record) warns in plain language — that
    // dialog is the path that lets the acknowledgement be SENT, instead of the
    // backend's `local-edits` refusal being a dead end.
    await page.getByRole('button', { name: '更新', exact: true }).nth(3).click()
    await expect(dialog).toContainText('更新技能「e2e-occupied-skill」？')
    await expect(dialog).toContainText('无法判定本地是否有改动')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    // HUMAN CONFIRMATION for the drifted entry: the update dialog states the
    // loss plainly (F-3: the backend's `local-edits` refusal is answerable).
    await page.getByRole('button', { name: '更新', exact: true }).nth(0).click()
    await expect(dialog).toContainText('更新技能「e2e-market-skill」？')
    await expect(dialog).toContainText('本地已修改')
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)

    await page.screenshot({ path: test.info().outputPath('tool-catalog.png') })
  } finally {
    await app.close().catch(() => undefined)
    await mock.close().catch(() => undefined)
    sandbox.cleanup()
  }
})
