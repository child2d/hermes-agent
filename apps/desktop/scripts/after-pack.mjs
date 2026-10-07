/**
 * after-pack.mjs — electron-builder afterPack hook.
 *
 * Per-platform post-pack work on the unpacked app: payload relocation, nested
 * Chromium + wheel signing on macOS, PE signature sanitizing and batch signing
 * on Windows. The exe identity stamp lives in after-extract.mjs (#105629).
 *
 * electron-builder passes a context with:
 *   - electronPlatformName: 'win32' | 'darwin' | 'linux'
 *   - appOutDir:            the unpacked app directory for this target
 *   - packager.appInfo.productFilename: the exe basename (e.g. 'Hermes')
 */

import path from 'node:path'
import fs from 'node:fs'
import { copyFile, mkdir, readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { parseDocument } from 'yaml'
import { runPython } from '../../../scripts/build/python.mjs'

import { assertPackagedBackendReadyArtifact, resolvePackagedAsarPath } from './backend-ready-artifact.mjs'
import { assertCliBinaryFormat } from './plankton-cli-format.mjs'
import { batchSignAppTree } from './batch-sign-binaries.mjs'
import { rehashPayloadDigests } from './payload-digests.mjs'
import { resolveSigningIdentity, signNestedChromium } from './sign-nested-chromium.mjs'
import { signWheelZipMembers } from './sign-wheel-zips.mjs'
import { sanitizeTree } from './sanitize-pe-signatures.mjs'

/**
 * Put our full-resolution `assets/icon.icns` back as the bundle's legacy icon.
 * When `mac.icon` is the Icon Composer package, electron-builder replaces the
 * bundled `icon.icns` with actool's 256px fallback; macOS <= 15 shows that
 * file, so it must be the 16→1024 artwork the generator produced.
 *
 * The artwork base follows the build variant (product-identity `iconBase`):
 * `assets/icon` for upstream, `assets/plankton/icon` for the enterprise fork.
 * @param {{ appOutDir: string, packager: { appInfo: { productFilename: string } } }} context
 * @param {string} [appDir] the apps/desktop directory
 */
export async function restoreLegacyMacIcon({ appOutDir, packager }, appDir = path.resolve(import.meta.dirname, '..')) {
  const identity = createRequire(import.meta.url)(path.join(appDir, 'product-identity.cjs'))
  const iconBase = identity.iconBase || 'assets/icon'
  await copyFile(path.join(appDir, `${iconBase}.icns`), path.join(packager.getResourcesDir(appOutDir), 'icon.icns'))
}

/** electron-builder Arch enum → directory name (see before-pack.mjs). */
const ARCH_NAMES = Object.freeze({ 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' })

/**
 * R1 (PLANKTON-MIGRATION-BATCH2.md): FAIL-CLOSED when an enterprise
 * extraResource is missing — or present-but-broken — in the packed app.
 *
 * electron-builder SILENTLY skips an `extraResources` entry whose `from` does
 * not exist, so one typo'd path ships an artifact with no CLI / no plugin and a
 * completely green build (the KI-PLANKTON-0056 hazard class). This asserts each
 * expected resource is:
 *   - present and NON-EMPTY;
 *   - a REGULAR FILE (a directory at a file path is non-empty and 0755 — it must
 *     not read as a valid resource);
 *   - for the CLI: executable (POSIX) AND the right CONTAINER FORMAT +
 *     ARCHITECTURE for the target platform (Mach-O/ELF/PE magic + embedded CPU);
 *   - for `plugin.yaml` / `dashboard/manifest.json`: parseable as YAML / JSON.
 * A truncated seed, a lost mode, a directory, a wrong-arch CLI, a text
 * placeholder or an invalid manifest each turn the pack RED. Upstream variants
 * (`enterprise` false) assert nothing, so their Resources stay bit-for-bit
 * unchanged.
 *
 * @param {{ appOutDir: string, electronPlatformName: string, arch?: number|string, packager: { appInfo: { productFilename: string } } }} context
 * @param {string} [appDir] the apps/desktop directory
 * @returns {string[]} the verified resource-relative paths (empty for upstream)
 */
export function assertEnterpriseResourcesPresent(
  { appOutDir, electronPlatformName, arch, packager },
  appDir = path.resolve(import.meta.dirname, '..')
) {
  const identity = createRequire(import.meta.url)(path.join(appDir, 'product-identity.cjs'))
  if (!identity.enterprise) {
    return []
  }

  const resources = electronPlatformName === 'darwin'
    ? path.join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(appOutDir, 'resources')
  const archName = typeof arch === 'number' ? ARCH_NAMES[arch] : arch
  const exe = electronPlatformName === 'win32' ? 'shaoke-cli.exe' : 'shaoke-cli'
  const cliRelative = `enterprise/cli/${electronPlatformName}-${archName}/${exe}`
  const expected = [
    'LICENSE',
    'THIRD-PARTY-NOTICES.md',
    'enterprise/model-seed.json',
    'enterprise/plankton-enterprise/plugin.yaml',
    'enterprise/plankton-enterprise/__init__.py',
    // 批 3 · 新建草稿卡的提案入口：the agent's draft outbox + its ONE tool. A
    // missing proposals.py turns the proposal block unusable (it would degrade
    // to text) — enumerate it so the loss is RED at pack time, not a silent
    // capability loss at runtime.
    'enterprise/plankton-enterprise/proposals.py',
    // 批 4 · W1：会话级审计单元生产者（确定性幂等键 / 两方字段 / profile 稳定 ID 发号）。
    // 丢失它 ⇒ 审计单元无法组装（且 profileId 无处发号）——枚举出来让丢失在打包期变红。
    'enterprise/plankton-enterprise/audit_unit.py',
    // 批 4 · W5/W6：审计出口（断网缓冲 / 失败态 / 落点自检 / 边界护栏）——出口模块本身。
    // 丢失它 ⇒ 缓冲与自检皆无（审计主路径空转）——枚举出来让丢失在打包期变红。
    'enterprise/plankton-enterprise/audit_egress.py',
    // 批 4 · 客户端接线：把审计出口挂到引擎会话生命周期（会话入口准入 / 会话收尾 / 启动自检）
    // + 可配置的中心端点传输（默认关闭）。丢失任一个 ⇒ 审计仍空转（0 调用方，正是本批要修的病）。
    'enterprise/plankton-enterprise/audit_wiring.py',
    'enterprise/plankton-enterprise/audit_transport.py',
    'enterprise/plankton-enterprise/dashboard/manifest.json',
    'enterprise/plankton-enterprise/dashboard/plugin_api.py',
    'enterprise/plankton-enterprise/desktop/plugin.js',
    // The baymax pack's ONE skill — the agent-facing carrier of the domain
    // command surface / agent instructions / onboarding (W2, N2 §0.1). It is a
    // first-class enterprise carrier, not an optional extra: __init__.py's
    // register() is fail-closed on it, so a staged artifact without it loads
    // green and only dies at plugin load. Enumerated here so its loss turns the
    // pack RED instead.
    'enterprise/plankton-enterprise/skills/baymax/SKILL.md',
    cliRelative
  ]

  const missing = expected.filter(relative => !fs.existsSync(path.join(resources, relative)))
  if (missing.length > 0) {
    throw new Error(
      `[after-pack] enterprise extraResources missing from ${resources}: ${missing.join(', ')} ` +
        '— electron-builder skips a missing `from` silently, so the pack would ship without them ' +
        '(fix the extraResources path or the staging step; see scripts/plankton-pack.sh)'
    )
  }

  // Present but not a regular file (e.g. a DIRECTORY staged at the CLI path):
  // existsSync/statSync.size/statSync.mode all read green for a 0755 directory,
  // so every content check below would be meaningless. Fail first.
  const notFiles = expected.filter(relative => {
    try {
      return !fs.statSync(path.join(resources, relative)).isFile()
    } catch {
      return true
    }
  })
  if (notFiles.length > 0) {
    throw new Error(
      `[after-pack] enterprise extraResource is not a regular file in ${resources}: ${notFiles.join(', ')} ` +
        '— a directory (or other non-file) at a resource path is non-empty and 0755 and must not pass as a valid seed'
    )
  }

  const empty = expected.filter(relative => fs.statSync(path.join(resources, relative)).size === 0)
  if (empty.length > 0) {
    throw new Error(
      `[after-pack] enterprise extraResources are EMPTY in ${resources}: ${empty.join(', ')} ` +
        '— a zero-byte seed (truncated CLI / plugin payload) would ship a crippled artifact with a green build'
    )
  }

  const cliPath = path.join(resources, cliRelative)
  // A staged-but-chmod-stripped CLI is not runnable; POSIX only (Windows has no
  // exec bit and relies on the .exe extension).
  if (electronPlatformName !== 'win32' && (fs.statSync(cliPath).mode & 0o111) === 0) {
    throw new Error(
      `[after-pack] enterprise CLI is not executable: ${cliPath} ` +
        '— the staged shaoke-cli lost its exec bit (see scripts/plankton-pack.sh); a non-executable seed is unrunnable'
    )
  }

  // Format + architecture: a non-empty, executable file is still a crippled
  // artifact if it is a different OS/arch binary, a text placeholder, or a
  // truncated stub. Read the magic and prove it matches the target.
  assertCliBinaryFormat({
    file: cliPath,
    platform: electronPlatformName,
    arch: archName,
    label: '[after-pack] enterprise CLI'
  })

  // Content legality for the two structured payloads. Parseable is not enough
  // (batch-2 third review, P3-2): `plugin.yaml = [1,2,3]` and
  // `manifest.json = {}` / `[1,2,3]` are all VALID YAML/JSON yet the engine
  // cannot load the plugin from them (the dashboard backend never mounts, the
  // manifest schema rejects the shape). So require the SHAPE the engine loads:
  //   - plugin.yaml: a mapping carrying the engine's required fields
  //     (name, version, description — see hermes_cli/plugin_validate.py);
  //   - dashboard/manifest.json: a mapping with a non-empty `name` and an `api`
  //     entry that resolves to a real file inside dashboard/ — the field that
  //     actually mounts the plugin's backend (see
  //     hermes_cli/web_server_dashboard.py:_dashboard_plugin_entry).
  const pluginYaml = path.join(resources, 'enterprise/plankton-enterprise/plugin.yaml')
  try {
    const doc = parseDocument(fs.readFileSync(pluginYaml, 'utf8'))
    if (doc.errors.length > 0) {
      throw doc.errors[0]
    }
    const data = doc.toJS()
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('root is not a mapping')
    }
    const missing = ['name', 'version', 'description'].filter(
      field => typeof data[field] !== 'string' || data[field].trim() === ''
    )
    if (missing.length > 0) {
      throw new Error(`missing required field(s): ${missing.join(', ')}`)
    }
  } catch (error) {
    throw new Error(
      `[after-pack] enterprise plugin.yaml is not a valid plugin manifest (${pluginYaml}): ${error instanceof Error ? error.message : String(error)}`
    )
  }

  const manifest = path.join(resources, 'enterprise/plankton-enterprise/dashboard/manifest.json')
  try {
    const data = JSON.parse(fs.readFileSync(manifest, 'utf8'))
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('root is not a mapping')
    }
    if (typeof data.name !== 'string' || data.name.trim() === '') {
      throw new Error("missing required field 'name'")
    }
    if (typeof data.api !== 'string' || data.api.trim() === '') {
      throw new Error("missing required field 'api'")
    }
    // The api path is what the dashboard loader imports to mount the backend; if
    // it doesn't resolve to a real file the tab renders but its API is dead.
    const apiPath = path.join(path.dirname(manifest), data.api)
    if (!fs.existsSync(apiPath) || !fs.statSync(apiPath).isFile()) {
      throw new Error(`declared api file is missing: ${data.api}`)
    }
  } catch (error) {
    throw new Error(
      `[after-pack] enterprise dashboard/manifest.json is not a loadable dashboard manifest (${manifest}): ${error instanceof Error ? error.message : String(error)}`
    )
  }

  // W4 (N7 §8): the packaged plugin MUST still register the transcript-directive
  // carrier (指令式组件 + 引用式载荷). Dropping the carrier entry is a SILENT
  // capability loss — the cards simply never render — so fail the PACK here,
  // proven from the artifact's own bytes, not from a unit test.
  const packagedPlugin = path.join(resources, 'enterprise/plankton-enterprise/desktop/plugin.js')
  const pluginSource = fs.readFileSync(packagedPlugin, 'utf8')
  for (const marker of ["transcript.directives", 'carrierDirectiveContributions']) {
    if (!pluginSource.includes(marker)) {
      throw new Error(
        `[after-pack] packaged enterprise plugin.js lost the W4 carrier entry (missing "${marker}"): ${packagedPlugin}`
      )
    }
  }

  // 批 3 (新建草稿卡的提案入口): the packaged plugin MUST still carry the PROPOSAL
  // port (proposal blocks + the proposal loader) — dropping it silently makes
  // the new-draft card degrade to text. Proven from the artifact's own bytes.
  for (const marker of ['createProposalLoader', '/packs/proposal', 'isProposalBlock']) {
    if (!pluginSource.includes(marker)) {
      throw new Error(
        `[after-pack] packaged enterprise plugin.js lost the draft-proposal entry (missing "${marker}"): ${packagedPlugin}`
      )
    }
  }
  const packagedApi = fs.readFileSync(path.join(resources, 'enterprise/plankton-enterprise/dashboard/plugin_api.py'), 'utf8')
  if (!packagedApi.includes('@router.post("/packs/proposal")')) {
    throw new Error('[after-pack] packaged enterprise plugin_api.py lost the /packs/proposal route')
  }
  const packagedProposals = fs.readFileSync(path.join(resources, 'enterprise/plankton-enterprise/proposals.py'), 'utf8')
  for (const marker of ['field-tier-not-agent-draftable', 'AGENT_DRAFTABLE_FIELDS', 'plankton_propose_draft']) {
    if (!packagedProposals.includes(marker)) {
      throw new Error(`[after-pack] packaged enterprise proposals.py lost the human-field gate / tool (missing "${marker}")`)
    }
  }
  // 批 4 · W1：审计单元生产者必须**真的在产物字节里**（不是源码里）——确定性幂等键 + 人方空值闸 +
  // agent 侧 self-reported + profile 稳定 ID 台账。任一丢失 ⇒ 审计成立性受损，打包期即红。
  const packagedAudit = fs.readFileSync(path.join(resources, 'enterprise/plankton-enterprise/audit_unit.py'), 'utf8')
  for (const marker of ['derive_session_audit_id', 'audit_hygiene_problem', 'resolve_profile_id', 'self-reported']) {
    if (!packagedAudit.includes(marker)) {
      throw new Error(`[after-pack] packaged enterprise audit_unit.py lost the audit-unit producer (missing "${marker}")`)
    }
  }
  if (!packagedApi.includes('@router.get("/audit/profile-id")') || !packagedApi.includes('@router.get("/audit/unit")')) {
    throw new Error('[after-pack] packaged enterprise plugin_api.py lost the W1 audit routes')
  }

  return expected
}

/**
 * Restore the empty app-level localizations dropped during Electron extraction.
 * Runs after language filtering and before signing; the markers come from the
 * packaged framework, not the host's Electron (which may be another version).
 * Non-blocking: a failed restore leaves a usable package and says so.
 */
export async function restoreMacLocaleMarkers({ appOutDir, packager }) {
  try {
    const resources = packager.getResourcesDir(appOutDir)
    const framework = packager.getMacOsElectronFrameworkResourcesDir(appOutDir)
    const entries = await readdir(framework, { withFileTypes: true })
    // Chromium also ships grammatical-gender packs; these are not macOS locales.
    const locales = entries.filter(
      entry =>
        entry.isDirectory() && entry.name.endsWith('.lproj') && !/_(FEMININE|MASCULINE|NEUTER)\.lproj$/.test(entry.name)
    )
    await Promise.all(locales.map(entry => mkdir(path.join(resources, entry.name), { recursive: true })))
  } catch (error) {
    console.warn(
      `[after-pack] macOS locale markers were not restored: ${error instanceof Error ? error.message : String(error)}`
    )
  }
}

export default async function afterPack(context) {
  const platform = context.electronPlatformName
  // Artifact-skew guard (#60772): before any platform work, prove the packed
  // bundle's readiness parser still accepts both ready tokens. This runs for
  // every packed build — first install, `hermes desktop`, the installer's
  // --update rebuild — so a stale matcher fails the pack here instead of
  // killing healthy backends on user machines.
  const asarPath = resolvePackagedAsarPath(context)
  assertPackagedBackendReadyArtifact(asarPath)
  console.log(`[after-pack] verified backend readiness parser in ${asarPath}`)
  // R1: prove every enterprise extraResource actually landed. electron-builder
  // silently skips a missing `from`, so a typo'd path would otherwise ship a
  // crippled artifact with a green build (KI-PLANKTON-0056 hazard class).
  const verifiedResources = assertEnterpriseResourcesPresent(context)
  if (verifiedResources.length > 0) {
    console.log(`[after-pack] verified ${verifiedResources.length} enterprise resources present`)
  }
  const resources = platform === 'darwin'
    ? path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`, 'Contents', 'Resources')
    : path.join(context.appOutDir, 'resources')
  const payload = path.join(resources, 'agent-payload')
  if (platform !== 'win32' && fs.existsSync(path.join(payload, 'manifest.json'))) {
    runPython([
      path.resolve(import.meta.dirname, '../../../scripts/bundles/payload.py'), 'relocate', payload], { stdio: 'inherit' })
  }
  if (platform === 'darwin') {
    await restoreLegacyMacIcon(context)
    await restoreMacLocaleMarkers(context)
    if (fs.existsSync(payload)) {
      const entitlements = path.join(import.meta.dirname, '..', 'electron', 'entitlements.mac.inherit.plist')
      const { identity, keychain } = await resolveSigningIdentity(context.packager)
      const nested = signNestedChromium(payload, { entitlements, identity, keychain })
      console.log(
        `[after-pack] repaired ${nested.repaired} framework links; signed ${nested.signed} nested chromium targets` +
          (identity ? ` as ${identity}` : ' (no Developer ID in the builder keychain)')
      )
      // uv-cache wheel zips carry Mach-O members the notary validates but
      // electron-osx-sign cannot reach; sign them in place (see module doc).
      const wheels = signWheelZipMembers(payload, { identity, keychain })
      if (wheels.signed > 0) {
        console.log(
          `[after-pack] signed ${wheels.signed} Mach-O members across ${wheels.wheels} payload wheel zips` +
            (identity ? ` as ${identity}` : ' (no Developer ID in the builder keychain)'))
      }
      // The macOS signer refreshes this again before sealing the outer app.
      // Unsigned builds end here and still need final-byte facts.
      rehashPayloadDigests(payload)
    }
    return
  }
  if (platform === 'linux') {
    return
  }
  if (platform !== 'win32') {
    return
  }

  const productName = context.packager?.appInfo?.productFilename || 'Hermes'
  const exe = path.join(context.appOutDir, `${productName}.exe`)

  // Repair dangling PE certificate tables BEFORE electron-builder signs the
  // tree. A stripped-but-still-declared signature makes signtool reject the
  // file with 0x800700C1, and AppxSIP inspects every PE inside the MSIX, so
  // one bad payload DLL fails the whole package. Unlike the stamp below this
  // is NOT best-effort: shipping past it means shipping an unsignable bundle.
  // this is a hack until https://github.com/astral-sh/python-build-standalone/pull/1217 is merged.
  const { scanned, repaired } = sanitizeTree(context.appOutDir)
  console.log(`[after-pack] ${scanned} PEs scanned, ${repaired.length} dangling certificate tables cleared`)
  for (const file of repaired) {
    console.log(`  ${file}`)
  }

  // The identity stamp already ran from afterExtract on the pristine exe
  // (scripts/after-extract.mjs, #105629); rcedit cannot commit to the
  // ASAR-integrity-rewritten PE we hold here.

  // Batch-sign every payload binary AFTER sanitize (above) and the rcedit
  // stamp: a dangling certificate table or a subsequent resource edit would
  // invalidate the signature. The product exe is excluded here and signed
  // per-file by the customSign hook (scripts/batch-sign-binaries.mjs) after
  // electron-builder's own rcedit + fuses pass. No-op with a loud warning when
  // the AZURE_SIGN_* environment is absent (unsigned/fork/canary lanes).
  await batchSignAppTree(context.appOutDir, exe, {
    config: context.packager.config,
    resourcesDir: context.packager.buildResourcesDir,
  })
  rehashPayloadDigests(payload)
}
