#!/usr/bin/env node
/**
 * plankton-pack-windows.mjs — the Windows counterpart of `plankton-pack.sh`.
 *
 * WHY A SECOND ENTRY POINT AND NOT A FLAG. The engine payload is staged for the
 * HOST it runs on (`pm/store.py::current_target()` = `platform.machine()` +
 * `sys.platform`, with no override anywhere), and the electron-builder config
 * injects `build/enterprise/cli/${process.platform}-${process.arch}`. A Windows
 * artifact therefore has to be BUILT ON WINDOWS — `plankton-pack.sh` is the
 * macOS half and stays that way; this script is the Windows half, in Node so
 * the same file can run its `--preflight-only` half on any OS (that is how it
 * is tested from the mac checkout).
 *
 *   cd apps/desktop
 *   npm run pack:plankton:win            # PLANKTON_ENV=prod, MSIX, x64
 *   npm run pack:plankton:win:test       # PLANKTON_ENV=test
 *   node scripts/plankton-pack-windows.mjs --kind nsis --arch arm64
 *   node scripts/plankton-pack-windows.mjs --preflight-only
 *
 * Artifact: release/<env>/<name>-<version>-win-<arch>.msix  (or .exe with
 * `--kind nsis`). Non-prod environments land in their own dir, exactly like the
 * mac script, so one environment's build can never overwrite another's.
 *
 * Every guard `plankton-pack.sh` enforces is enforced here too, because each
 * one is a build that would otherwise ship green and die at someone else's
 * desk: the environment manifest, the first-launch seed, the SSO secret, the
 * bundled CLI (present AND the right OS/arch), the plugin payload, the dirty
 * tree, and — Windows-only, and the whole reason the mac script cannot be
 * reused — the payload's own target.
 */

import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { assertCliBinaryFormat } from './plankton-cli-format.mjs'

const require = createRequire(import.meta.url)
const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = path.resolve(APP_DIR, '..', '..')
const TAG = '[plankton-pack:win]'

const log = message => console.log(`${TAG} ${message}`)
const fail = message => {
  console.error(`${TAG} ERROR: ${message}`)
  process.exit(1)
}

// ─── arguments ───────────────────────────────────────────────────────────────
let kind = 'msix'
let arch = 'x64'
let preflightOnly = false

const argv = process.argv.slice(2)
for (let i = 0; i < argv.length; i++) {
  const arg = argv[i]
  if (arg === '--preflight-only') preflightOnly = true
  else if (arg === '--help' || arg === '-h') {
    console.log('usage: node scripts/plankton-pack-windows.mjs [--kind msix|nsis] [--arch x64|arm64] [--preflight-only]')
    process.exit(0)
  } else if (arg === '--kind' || arg === '--arch') {
    const value = argv[++i]
    if (!value) fail(`${arg} needs a value (msix|nsis, x64|arm64)`)
    if (arg === '--kind') kind = value
    else arch = value
  } else if (arg.startsWith('--kind=')) kind = arg.slice('--kind='.length)
  else if (arg.startsWith('--arch=')) arch = arg.slice('--arch='.length)
  else if (arg === '--msix' || arg === '--nsis') kind = arg.slice(2)
  else if (arg === '--x64' || arg === '--arm64') arch = arg.slice(2)
  else fail(`unknown argument '${arg}' (expected --kind msix|nsis, --arch x64|arm64, --preflight-only)`)
}

if (!['msix', 'nsis'].includes(kind)) fail(`unknown --kind '${kind}' (expected msix or nsis)`)
if (!['x64', 'arm64'].includes(arch)) fail(`unknown --arch '${arch}' (expected x64 or arm64)`)

// A Windows artifact is built BY a Windows host: the payload that goes inside
// it is staged from the running interpreter and its manifest records the
// target. Refuse early instead of shipping a macOS engine inside a Windows app.
if (process.platform !== 'win32' && !preflightOnly) {
  fail(
    `this script builds a WINDOWS artifact and must run on Windows (host is ${process.platform}-${process.arch}).\n` +
      `${TAG}        The engine payload is staged for the host (pm/store.py::current_target), so a mac/linux host can only stage its own.\n` +
      `${TAG}        Use --preflight-only here to validate the staged inputs without building.`
  )
}

process.chdir(APP_DIR)

// ─── environment selection (the one table) ───────────────────────────────────
const { planktonEnvByName } = require(path.join(APP_DIR, 'plankton-envs.cjs'))
const envName = (process.env.PLANKTON_ENV || 'prod').trim() || 'prod'
const spec = planktonEnvByName(envName)
if (!spec) fail(`PLANKTON_ENV must be dev, test or prod (got '${envName}')`)
const { variant, env } = spec
log(`env=${env} variant=${variant} kind=${kind} arch=${arch}${preflightOnly ? ' (preflight only)' : ''}`)

// ─── build-time pins (all overridable, exactly like the mac script) ──────────
// Exported into process.env (like the bash script's `export`), because the
// build's own config modules read them at require time — a copy would leave
// them resolving the wrong identity.
process.env.HERMES_PYTHON = process.env.HERMES_PYTHON || 'python'
process.env.ELECTRON_MIRROR = process.env.ELECTRON_MIRROR || 'https://registry.npmmirror.com/-/binary/electron/'
process.env.HERMES_DESKTOP_VARIANT = variant
// Signing is OFF by default: this repo's Windows packages are signed by Azure
// Trusted Signing (electron-builder.config.cjs::windowsSigning) and only when
// its AZURE_* variables are present; auto-discovery would otherwise fail the
// pack on a machine with no certificate. Export CSC_IDENTITY_AUTO_DISCOVERY=true
// (or the AZURE_SIGN_* set) to sign.
process.env.CSC_IDENTITY_AUTO_DISCOVERY = process.env.CSC_IDENTITY_AUTO_DISCOVERY || 'false'
log(`HERMES_PYTHON=${process.env.HERMES_PYTHON}`)
log(`ELECTRON_MIRROR=${process.env.ELECTRON_MIRROR}`)

// ─── per-environment manifest (non-secret) ───────────────────────────────────
const envManifest = path.join('enterprise', 'envs', `${env}.json`)
if (!fs.existsSync(envManifest) || fs.statSync(envManifest).size === 0) {
  fail(`missing per-environment manifest ${envManifest}`)
}
const manifest = JSON.parse(fs.readFileSync(envManifest, 'utf8'))
if (manifest.env !== env) fail(`${envManifest} declares env=${manifest.env}, expected ${env}`)
log(`manifest: ${envManifest} → Resources/enterprise/env.json`)

// ─── first-launch model seed resource ────────────────────────────────────────
const seedDir = path.join('build', 'enterprise')
const seed = path.join(seedDir, 'model-seed.json')
fs.mkdirSync(seedDir, { recursive: true })
if (!fs.existsSync(seed)) {
  fs.writeFileSync(
    seed,
    `${JSON.stringify({ provider: 'deepseek', model: 'deepseek-v4-flash', base_url: 'https://api.deepseek.com' }, null, 2)}\n`
  )
  log(`wrote keyless seed placeholder: ${seed}`)
}

// ─── SSO client secret (zero-config first login) ─────────────────────────────
// The artifact carries Resources/enterprise/sso-config.json so a colleague who
// installs the package can log in with no provisioning. The secret is a tenant
// credential: it lives OUTSIDE the repo (build/ is gitignored) and is staged
// here from this machine's local plankton-state file (the PROD app's paths —
// that is where a machine that has run Plankton keeps it), or from
// PLANKTON_SSO_SECRET_FILE. Shipping it means anyone holding the artifact can
// read it; that is the accepted trade for zero-config. The identity source
// (issuer / client id / redirect) is pinned in electron/plankton-sso.ts — any
// such key in this file is ignored.
const ssoDest = path.join('build', 'enterprise', 'sso-config.json')
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
// The PROD app's own paths — that is where a machine that has run Plankton keeps
// the file. The non-Windows pair is the same two locations the mac script
// checks, so `--preflight-only` can validate a build from the mac checkout (the
// build itself still refuses to run there).
const ssoCandidates =
  process.platform === 'win32'
    ? [
        path.join(appData, 'Plankton', 'plankton-state', 'sso-config.local.json'),
        path.join(localAppData, 'plankton', 'engine', 'home', 'plankton-state', 'sso-config.local.json')
      ]
    : [
        path.join(os.homedir(), 'Library', 'Application Support', 'Plankton', 'plankton-state', 'sso-config.local.json'),
        path.join(os.homedir(), '.plankton', 'engine', 'home', 'plankton-state', 'sso-config.local.json')
      ]
let ssoSrc = process.env.PLANKTON_SSO_SECRET_FILE || ''
if (!ssoSrc) {
  for (const candidate of ssoCandidates) {
    if (fs.existsSync(candidate)) {
      ssoSrc = candidate
      break
    }
  }
}
if (!ssoSrc || !fs.existsSync(ssoSrc)) {
  fs.rmSync(ssoDest, { force: true })
  fail(
    'no SSO client secret to bundle.\n' +
      `${TAG}        A plankton artifact without it installs but CANNOT log in, so this is a failed build, not a warning.\n` +
      `${TAG}        Put sso-config.local.json in the app's plankton-state dir, or set PLANKTON_SSO_SECRET_FILE=<path>.`
  )
}
fs.copyFileSync(ssoSrc, ssoDest)
log(`staged SSO secret: ${ssoSrc} -> ${ssoDest} (ships inside the artifact)`)
log('NOTE: this file must be readable back by the builder — verify it is complete, not truncated by a secret manager.')

// ─── bundled shaoke-cli (win32-<arch>) ───────────────────────────────────────
// First launch drops it into <HERMES_HOME>/bin (electron/enterprise-cli.ts).
// The binary must NOT live in git, so it is staged into the gitignored build/
// tree: from PLANKTON_SHAOKE_CLI_SRC, else from PATH. after-pack asserts again.
const cliDir = path.join('build', 'enterprise', 'cli', `win32-${arch}`)
const cliDest = path.join(cliDir, 'shaoke-cli.exe')
fs.mkdirSync(cliDir, { recursive: true })
let cliSrc = (process.env.PLANKTON_SHAOKE_CLI_SRC || '').trim()
if (!cliSrc) {
  const probe = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['shaoke-cli'], { encoding: 'utf8' })
  cliSrc = (probe.stdout || '').split(/\r?\n/).map(line => line.trim()).find(Boolean) || ''
}
if (!cliSrc || !fs.existsSync(cliSrc)) {
  fail(
    'no shaoke-cli to bundle (set PLANKTON_SHAOKE_CLI_SRC, or put the Windows shaoke-cli on PATH).\n' +
      `${TAG}        The artifact must carry the CLI; refusing to pack without it.`
  )
}
fs.copyFileSync(cliSrc, cliDest)
// Present is not enough: a CLI staged for another OS/arch (the mac checkout's
// darwin-arm64 binary is the easy mistake) is just as unrunnable, and it only
// fails on the user's machine. Prove the SOURCE's magic matches the target.
try {
  assertCliBinaryFormat({ file: cliDest, platform: 'win32', arch, label: '[plankton-pack:win] CLI' })
} catch (error) {
  fail(`${error.message}\n${TAG}        A wrong-OS or wrong-arch CLI ships an unrunnable artifact; refusing to pack.`)
}
log(`staged CLI: ${cliDest} (from ${cliSrc})`)

// ─── enterprise plugin payload ───────────────────────────────────────────────
// Committed in-repo; assert the files the plugin's __init__ is fail-closed on,
// so a packaging run cannot ship an artifact that dies at plugin load.
const pluginPayload = path.join('enterprise', 'plankton-enterprise')
for (const required of [
  'plugin.yaml',
  '__init__.py',
  'proposals.py',
  'audit_unit.py',
  'audit_egress.py',
  'audit_wiring.py',
  'audit_transport.py',
  'dashboard/manifest.json',
  'dashboard/plugin_api.py',
  'desktop/plugin.js',
  'skills/baymax/SKILL.md'
]) {
  const file = path.join(pluginPayload, required)
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    fail(`enterprise plugin payload incomplete under ${pluginPayload} (missing/empty: ${required})`)
  }
}

// ─── the engine payload ──────────────────────────────────────────────────────
// build/agent-payload is a `git archive HEAD` snapshot, so uncommitted source
// never reaches the packaged engine — and a snapshot taken from another branch
// would silently ship the wrong code. Two duties: (1) the tree must be clean,
// (2) the snapshot's source tree is refreshed from HEAD. A machine that has
// never staged a payload stages one here (HERMES_PYTHON + network); the refresh
// alone cannot create it (the manifest and the relocated venv come from the
// staging run).
const payload = path.join('build', 'agent-payload')
const payloadManifest = path.join(payload, 'manifest.json')
const payloadSource = path.join(payload, 'hermes-agent')
/** A machine that has never staged a payload stages one in the build phase. */
let needsPayloadStaging = false
const dirty = spawnSync('git', ['-C', REPO_ROOT, 'status', '--porcelain'], { encoding: 'utf8' })
if (dirty.status !== 0) fail(`git status failed in ${REPO_ROOT}: ${(dirty.stderr || '').trim()}`)
if ((dirty.stdout || '').trim()) {
  fail('working tree is dirty; the engine payload is a HEAD snapshot. Commit (or stash) your changes, then re-run.')
}

if (fs.existsSync(payloadManifest)) {
  const staged = JSON.parse(fs.readFileSync(payloadManifest, 'utf8'))
  const want = `win32-${arch}`
  if (staged.target !== want) {
    fail(
      `build/agent-payload was staged for '${staged.target}', but this is a ${want} build.\n` +
        `${TAG}        The payload is host-staged: delete build/agent-payload and re-run on a Windows ${arch} host (this script runs \`npm run payload\` for you).`
    )
  }
  log(`payload target ok: ${staged.target}`)
} else {
  needsPayloadStaging = true
  log('no staged payload: the build phase will run `npm run payload` (needs a working HERMES_PYTHON and network)')
}

if (fs.existsSync(payloadSource)) {
  log('refreshing payload source from HEAD')
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-pack-source-'))
  const archive = path.join(tmpDir, 'source.tar')
  // `--output` instead of a pipe: PowerShell's own pipeline is not byte-safe for
  // binary data, and this script is also used from PowerShell.
  const archived = spawnSync(
    'git',
    [
      '-C',
      REPO_ROOT,
      'archive',
      '--format=tar',
      `--output=${archive}`,
      'HEAD',
      '--',
      ':(exclude)tests',
      ':(exclude)tests-js',
      ':(exclude)website',
      ':(exclude)evals',
      ':(exclude).github',
      ':(exclude)nix',
      ':(exclude)docker',
      ':(exclude)apps',
      ':(exclude)ui-tui',
      ':(exclude)web',
      ':(exclude)scripts'
    ],
    { encoding: 'utf8' }
  )
  if (archived.status !== 0) fail(`git archive failed: ${(archived.stderr || '').trim()}`)
  const extracted = spawnSync('tar', ['-xf', archive, '-C', tmpDir], { encoding: 'utf8' })
  if (extracted.status !== 0) fail(`tar -xf failed: ${(extracted.stderr || '').trim()}`)
  // The archive itself lives in the extraction dir — drop it, or it lands
  // inside the shipped engine as a stray 100 MB tar.
  fs.rmSync(archive, { force: true })
  fs.rmSync(payloadSource, { recursive: true, force: true })
  fs.renameSync(tmpDir, payloadSource)
}

// ─── output land ─────────────────────────────────────────────────────────────
// Same rule as the mac script: a non-prod build gets its own directory so one
// environment's artifact can never overwrite another's, and PLANKTON_OUTPUT_DIR
// overrides entirely. The artifact path printed at the end is DERIVED from this.
const builderConfig = require(path.join(APP_DIR, 'electron-builder.config.cjs'))
let outputDir = String(builderConfig.directories?.output || 'release')
let redirect = false
if (process.env.PLANKTON_OUTPUT_DIR) {
  outputDir = process.env.PLANKTON_OUTPUT_DIR
  redirect = true
} else if (env !== 'prod') {
  outputDir = path.join('release', env)
  redirect = true
}
if (redirect) log(`output redirected to: ${outputDir}`)

// ─── build ───────────────────────────────────────────────────────────────────
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const builderArgs = ['run', 'builder', '--', '--win', kind, `--${arch}`, '--publish', 'never']
if (redirect) builderArgs.push(`-c.directories.output=${outputDir}`)

const plan = [
  // Only on a machine with no payload yet: this is the slow, networked step and
  // it is HOST-staged by construction, which is precisely why a Windows
  // artifact has to be packed on Windows.
  ...(needsPayloadStaging ? [{ label: 'payload', args: ['run', 'payload'] }] : []),
  { label: 'build', args: ['run', 'build'] },
  { label: 'package', args: builderArgs }
]

if (preflightOnly) {
  log('preflight OK — every staged input checked out. Would run:')
  for (const step of plan) console.log(`${TAG}   ${npm} ${step.args.join(' ')}`)
  process.exit(0)
}

const started = new Date().toISOString()
log(`start  ${started}`)
for (const step of plan) {
  const result = spawnSync(npm, step.args, { stdio: 'inherit' })
  if (result.error) fail(`${step.label} failed to start: ${result.error.message}`)
  if (result.status !== 0) fail(`${step.label} failed with exit code ${result.status}`)
}
log(`done   ${new Date().toISOString()}`)

// ─── report what actually landed ─────────────────────────────────────────────
// NEWEST by mtime, never `readdir` order: a version bump once reported the
// previous build's file.
const extensions = kind === 'nsis' ? ['.exe'] : ['.msix']
const candidates = []
const walk = dir => {
  if (!fs.existsSync(dir)) return
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(full)
    else if (extensions.includes(path.extname(entry.name).toLowerCase())) candidates.push(full)
  }
}
walk(path.resolve(outputDir))
const newest = candidates.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0]
if (newest) {
  const size = (fs.statSync(newest).size / (1024 * 1024)).toFixed(0)
  log(`artifact (env=${env} variant=${variant}): ${newest} (${size} MB)`)
} else {
  log(`artifact dir: ${path.resolve(outputDir)} (no ${extensions.join('/')} found)`)
}

if (kind === 'msix') {
  log('NOTE: Windows only installs a SIGNED .msix. Unsigned builds are for CI/dev sideloading')
  log('      (install with `Add-AppxPackage -AllowUnsigned`, Developer Mode on) — for a plain')
  log('      installer a colleague can double-click, use --kind nsis.')
}
