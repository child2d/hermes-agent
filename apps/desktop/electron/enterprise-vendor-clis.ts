import { spawnSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
// Vendor CLIs share the enterprise offline resource tree, not shaoke-cli's
// mandatory-refresh policy. Reuse a probed system executable without changing
// it or its credentials; publish only inside the selected engine home's bin.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const VENDOR_CLIS = [
  { id: 'aliyun-cli', command: 'aliyun', args: ['version'] },
  { id: 'lark-cli', command: 'lark-cli', args: ['--version'] }
] as const

export interface VendorCliResult {
  id: string
  command: string
  status: 'ready' | 'failed' | 'unsupported'
  source?: 'system' | 'existing' | 'bundled'
  path?: string
  version?: string
  reason?: string
}

export interface VendorCliSeedOptions {
  hermesHome: string
  resourcesPath: string
  platform?: NodeJS.Platform
  arch?: string
  pathValue?: string
  userHome?: string
  probe?: (file: string, args: readonly string[]) => string | undefined
  log?: (line: string) => void
}

/** Exit success alone is insufficient: a CLI must also print a version. */
export function probeVendorCli(file: string, args: readonly string[]): string | undefined {
  const result = spawnSync(file, [...args], {
    encoding: 'utf8',
    timeout: 5000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    // Finder's PATH can omit Homebrew's Node needed by an existing npm CLI.
    env: { ...process.env, PATH: [...new Set([
      path.dirname(file), ...(process.env.PATH ?? '').split(path.delimiter),
      '/opt/homebrew/bin', '/usr/local/bin', path.join(os.homedir(), '.local', 'bin')
    ].filter(Boolean))].join(path.delimiter) }
  })

  if (result.error || result.status !== 0) {
    return undefined
  }

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim()

  return output.match(/\b\d+\.\d+\.\d+(?:[-+][\w.-]+)?\b/)?.[0]
}

export function vendorCliCandidates(command: string, options: VendorCliSeedOptions): string[] {
  const bin = path.resolve(options.hermesHome, 'bin')

  const dirs = [
    ...(options.pathValue ?? process.env.PATH ?? '').split(path.delimiter),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(options.userHome ?? os.homedir(), '.local', 'bin')
  ]

  return [...new Set(dirs.filter(Boolean).map(dir => path.resolve(dir)))]
    .filter(dir => dir !== bin)
    .map(dir => path.join(dir, command))
}

function isExecutable(file: string): boolean {
  try {
    return fs.statSync(file).isFile() && (fs.accessSync(file, fs.constants.X_OK), true)
  } catch {
    return false
  }
}

function provisionOne(spec: (typeof VENDOR_CLIS)[number], options: VendorCliSeedOptions): VendorCliResult {
  const base = { id: spec.id, command: spec.command }
  const platform = options.platform ?? process.platform
  const arch = options.arch ?? process.arch

  if (platform !== 'darwin' || !['arm64', 'x64'].includes(arch)) {
    return { ...base, status: 'unsupported', reason: `unsupported-host:${platform}-${arch}` }
  }

  const probe = options.probe ?? probeVendorCli
  const dest = path.join(options.hermesHome, 'bin', spec.command)
  let tmp: string | undefined

  try {
    // Never follow a home/bin link when writing: rename replaces the link,
    // leaving a user's brew install (including broken old links) untouched.
    let selected: { file: string; version: string } | undefined

    for (const file of vendorCliCandidates(spec.command, options)) {
      if (!isExecutable(file)) {
        continue
      }

      // A PATH alias back into this home is not a system installation.
      const real = fs.realpathSync(file)
      const relative = path.relative(path.resolve(options.hermesHome), real)

      if (
        relative === '' ||
        (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
      ) {
        continue
      }

      const version = probe(file, spec.args)

      if (version) {
        selected = { file, version }

        break
      }
    }

    if (!selected && isExecutable(dest)) {
      const version = probe(dest, spec.args)

      if (version) {
        return { ...base, status: 'ready', source: 'existing', path: dest, version }
      }
    }

    fs.mkdirSync(path.dirname(dest), { recursive: true })

    if (fs.realpathSync(path.dirname(dest)) !== path.join(fs.realpathSync(options.hermesHome), 'bin')) {
      throw new Error('home-bin-symlink-refused')
    }

    tmp = `${dest}.${randomUUID()}.tmp`
    let source: 'system' | 'bundled'

    if (selected) {
      fs.symlinkSync(selected.file, tmp)
      source = 'system'
    } else {
      const bundled = path.join(options.resourcesPath, 'enterprise', 'cli', `${platform}-${arch}`, spec.command)

      if (!fs.statSync(bundled).isFile()) {
        throw new Error('bundle-not-regular-file')
      }

      fs.copyFileSync(bundled, tmp, fs.constants.COPYFILE_EXCL)
      fs.chmodSync(tmp, 0o755)
      source = 'bundled'
    }

    const version = probe(tmp, spec.args)

    if (!version) {
      throw new Error(`${source}-version-probe-failed`)
    }

    fs.renameSync(tmp, dest)
    tmp = undefined
    const publishedVersion = probe(dest, spec.args)

    if (!publishedVersion) {
      throw new Error('published-version-probe-failed')
    }

    return { ...base, status: 'ready', source, path: dest, version: publishedVersion }
  } catch (error) {
    return {
      ...base,
      status: 'failed',
      reason: (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error))
    }
  } finally {
    if (tmp) {
      try {
        fs.unlinkSync(tmp)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          options.log?.(
            `[enterprise-cli] ${JSON.stringify({ ...base, status: 'failed', reason: 'temp-cleanup-failed', path: tmp })}`
          )
        }
      }
    }
  }
}

/** Non-fatal, per-CLI structured launch logs; no auth/config files are touched. */
export function seedEnterpriseVendorClis(options: VendorCliSeedOptions): VendorCliResult[] {
  return VENDOR_CLIS.map(spec => {
    const result = provisionOne(spec, options)
    options.log?.(`[enterprise-cli] ${JSON.stringify(result)}`)

    return result
  })
}
