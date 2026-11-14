import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, expect, it } from 'vitest'

import { probeVendorCli, seedEnterpriseVendorClis, vendorCliCandidates } from './enterprise-vendor-clis'

let root: string
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-cli-'))
})
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

function executable(file: string, version = '1.2.3') {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    `#!/bin/sh\ncase "$1" in version|--version) echo '${version}';; *) printf '%s' "$*";; esac\n`,
    { mode: 0o755 }
  )
}

function options() {
  return {
    hermesHome: path.join(root, 'home'),
    // The seeder accepts a resource platform as data; do not inherit the
    // Linux CI host for a fixture exercising the macOS enterprise bundle.
    platform: 'darwin' as const,
    arch: 'arm64',
    resourcesPath: path.join(root, 'resources'),
    pathValue: path.join(root, 'system'),
    userHome: root,
    probe: (file: string, args: readonly string[]) => (file.startsWith(root) ? probeVendorCli(file, args) : undefined)
  }
}

it('prefers probed system CLIs, exposes them on agent PATH, and never writes through old home symlinks', () => {
  const opts = options()

  for (const command of ['aliyun', 'lark-cli']) {
    const system = path.join(root, 'system', command)
    executable(system)
    const old = path.join(root, 'old', command)
    executable(old, '0.1.0')
    fs.mkdirSync(path.join(opts.hermesHome, 'bin'), { recursive: true })
    fs.symlinkSync(old, path.join(opts.hermesHome, 'bin', command))
    const bytes = fs.readFileSync(system)
    const oldBytes = fs.readFileSync(old)
    const rows = seedEnterpriseVendorClis(opts)
    const row = rows.find(row => row.command === command)!
    expect(row).toMatchObject({ status: 'ready', source: 'system', version: '1.2.3' })
    expect(fs.readFileSync(system)).toEqual(bytes)
    expect(fs.readFileSync(old)).toEqual(oldBytes)

    const run = spawnSync('/bin/sh', ['-c', `exec ${command} 'space arg'`], {
      env: { ...process.env, PATH: `${opts.hermesHome}/bin:/usr/bin:/bin` },
      encoding: 'utf8'
    })

    expect(run.status).toBe(0)
    expect(run.stdout).toBe('space arg')
  }

  const dirs = vendorCliCandidates('aliyun', opts)
  expect(dirs).toContain('/opt/homebrew/bin/aliyun')
  expect(dirs).toContain('/usr/local/bin/aliyun')
  expect(dirs).toContain(path.join(root, '.local/bin/aliyun'))
})

it('falls back offline, preserves valid existing copies, and reports failed probes without publishing partial binaries', () => {
  const opts = options()

  for (const command of ['aliyun', 'lark-cli']) {
    executable(path.join(root, 'system', command), 'invalid')
    executable(path.join(opts.resourcesPath, 'enterprise/cli', `${opts.platform}-${opts.arch}`, command))
  }

  const logs: string[] = []
  expect(
    seedEnterpriseVendorClis({ ...opts, log: line => logs.push(line) }).every(
      row => row.source === 'bundled' && row.status === 'ready'
    )
  ).toBe(true)
  expect(logs.every(line => JSON.parse(line.replace('[enterprise-cli] ', '')).status === 'ready')).toBe(true)
  expect(seedEnterpriseVendorClis(opts).every(row => row.source === 'existing')).toBe(true)
  const dest = path.join(opts.hermesHome, 'bin/aliyun')
  fs.writeFileSync(dest, 'old-broken')
  executable(
    path.join(opts.resourcesPath, 'enterprise/cli', `${opts.platform}-${opts.arch}`, 'aliyun'),
    'invalid'
  )
  expect(seedEnterpriseVendorClis(opts)[0]).toMatchObject({ status: 'failed', reason: 'bundled-version-probe-failed' })
  expect(fs.readFileSync(dest, 'utf8')).toBe('old-broken')
  expect(fs.readdirSync(path.dirname(dest)).some(name => name.endsWith('.tmp'))).toBe(false)
  const bin = path.join(opts.hermesHome, 'bin')
  fs.rmSync(bin, { recursive: true })
  const external = path.join(root, 'external-bin')
  fs.mkdirSync(external)
  fs.symlinkSync(external, bin)
  expect(seedEnterpriseVendorClis(opts).every(row => row.status === 'failed' && row.reason === 'home-bin-symlink-refused')).toBe(true)
  expect(fs.readdirSync(external)).toEqual([])
  expect(seedEnterpriseVendorClis({ ...opts, platform: 'linux' }).every(row => row.status === 'unsupported')).toBe(true)
})
