/**
 * Payload install / update / rollback — the mechanism that lets an AutoCode
 * logic change reach a colleague without a Plankton rebuild and without a
 * git checkout. Exercised against a real tar.gz built in-test (file:// source),
 * so a broken extractor or a bad rollback shows up here, not on first click.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, describe, expect, test } from 'vitest'

import {
  PayloadError,
  buildTarGz,
  decideInstall,
  extractTarGz,
  installPayload,
  parseManifest,
  readState,
  rollbackState,
  sha256,
  versionAtLeast,
  writeState,
  type PayloadManifest,
  type RuntimeState
} from './autocode-payload'
import { ensureVenv, ossSignedHeaders, scrubPythonEnv, syncRuntime, venvReady, venvPython } from './autocode-updater'

const tmpDirs: string[] = []

function tmpDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autocode-payload-'))
  tmpDirs.push(dir)

  return dir
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** Minimal but realistic payload layout. */
function payloadEntries(marker: string) {
  return [
    { path: 'backend/app/main.py', data: `# ${marker}\n` },
    { path: 'backend/requirements.lock', data: 'fastapi==0.115.0\n' },
    { path: 'frontend/dist/index.html', data: '<!doctype html><title>AutoCode</title>' }
  ]
}

function manifestFor(sha: string, archive: Buffer, requirementsHash = 'deps-1'): PayloadManifest {
  return {
    schema: 1,
    sha,
    version: '1.9.0',
    builtAt: '2026-11-10T00:00:00Z',
    requirementsHash,
    archive: `payload/${sha}.tar.gz`,
    archiveSha256: sha256(archive),
    archiveBytes: archive.length
  }
}

function fakeUpdaterDeps(runtimeRoot: string, sourceDir: string) {
  return {
    runtimeRoot,
    manifestUrl: sourceDir,
    planktonVersion: '0.1.2.0',
    log: () => {},
    // venv creation needs Python + network; the install/update mechanism under
    // test does not. Fake the interpreter so the flow can complete, and leave
    // pip a no-op.
    runCommand: async (_command: string, args: string[], cwd: string) => {
      if (args[0] === '-m' && args[1] === 'venv') {
        const target = process.platform === 'win32' ? path.join(cwd, 'venv', 'Scripts') : path.join(cwd, 'venv', 'bin')
        fs.mkdirSync(target, { recursive: true })
        fs.writeFileSync(process.platform === 'win32' ? path.join(target, 'python.exe') : path.join(target, 'python'), '')
      }
    },
    resolvePython: () => '/fake/python'
  }
}

// ─────────────────────────────────────────────────────────── tar

describe('tar handling', () => {
  test('round-trips entries and their bytes', () => {
    const buffer = buildTarGz([
      { path: 'a/b.txt', data: 'hello' },
      { path: 'a/c.bin', data: Buffer.from([0, 1, 2, 255]) }
    ])
    const entries = extractTarGz(buffer)
    expect(entries.map(entry => entry.path)).toEqual(['a/b.txt', 'a/c.bin'])
    expect(entries[0].data.toString()).toBe('hello')
    expect([...entries[1].data]).toEqual([0, 1, 2, 255])
  })

  test('handles a payload larger than one 512-byte block', () => {
    const big = 'x'.repeat(5000)
    const entries = extractTarGz(buildTarGz([{ path: 'big.txt', data: big }]))
    expect(entries[0].data.length).toBe(5000)
  })

  test('rejects a path traversal entry', () => {
    const buffer = buildTarGz([{ path: '../evil.txt', data: 'pwn' }])
    expect(() => extractTarGz(buffer)).toThrow(PayloadError)
  })

  test('rejects an absolute path entry', () => {
    const buffer = buildTarGz([{ path: '/etc/passwd', data: 'pwn' }])
    expect(() => extractTarGz(buffer)).toThrow(/绝对路径/)
  })

  test('rejects a truncated archive instead of writing partial files', () => {
    const buffer = buildTarGz([{ path: 'a.txt', data: 'x'.repeat(4096) }])
    // Cut inside the data block.
    const truncated = buffer.subarray(0, buffer.length - 2000)
    expect(() => extractTarGz(truncated)).toThrow()
  })
})

// ─────────────────────────────────────────────────────────── manifest

describe('manifest validation', () => {
  test('accepts a well-formed manifest', () => {
    const archive = buildTarGz(payloadEntries('x'))
    const parsed = parseManifest(JSON.parse(JSON.stringify(manifestFor('abcdef1', archive))))
    expect(parsed.sha).toBe('abcdef1')
    expect(parsed.schema).toBe(1)
  })

  test('rejects an unsupported schema', () => {
    const archive = buildTarGz(payloadEntries('x'))
    const raw = { ...manifestFor('abcdef1', archive), schema: 2 }
    expect(() => parseManifest(raw)).toThrow(/schema/)
  })

  test('rejects a non-sha256 archive digest', () => {
    const archive = buildTarGz(payloadEntries('x'))
    const raw = { ...manifestFor('abcdef1', archive), archiveSha256: 'deadbeef' }
    expect(() => parseManifest(raw)).toThrow(/sha256/)
  })

  test('rejects an archive path that escapes the base', () => {
    const archive = buildTarGz(payloadEntries('x'))
    const raw = { ...manifestFor('abcdef1', archive), archive: '../../evil.tar.gz' }
    expect(() => parseManifest(raw)).toThrow(/路径非法/)
  })

  test('compares dotted versions numerically, not lexically', () => {
    expect(versionAtLeast('0.1.10', '0.1.9')).toBe(true)
    expect(versionAtLeast('0.1.2.0', '0.1.2')).toBe(true)
    expect(versionAtLeast('0.1.1', '0.1.2')).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────── decisions

describe('decideInstall', () => {
  const archive = buildTarGz(payloadEntries('x'))
  const manifest = manifestFor('deadbee', archive)

  test('installs on first run', () => {
    expect(decideInstall(null, manifest, '0.1.2.0').install).toBe(true)
  })

  test('skips when already on that sha', () => {
    const state: RuntimeState = { sha: 'deadbee', requirementsHash: 'deps-1', badShas: [] }
    expect(decideInstall(state, manifest, '0.1.2.0')).toMatchObject({ install: false, reason: '已是最新' })
  })

  test('never re-installs a sha that failed to boot', () => {
    const state: RuntimeState = { sha: 'other', requirementsHash: 'deps-1', badShas: ['deadbee'] }
    const decision = decideInstall(state, manifest, '0.1.2.0')
    expect(decision.install).toBe(false)
    expect(decision.reason).toMatch(/启动失败过/)
  })

  test('honours minPlankton', () => {
    const gated = { ...manifest, minPlankton: '9.0.0' }
    expect(decideInstall(null, gated, '0.1.2.0').install).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────── install

describe('installPayload', () => {
  test('verifies, extracts to a sha dir and writes the manifest', () => {
    const runtimeRoot = tmpDir()
    const archive = buildTarGz(payloadEntries('first'))
    const manifest = manifestFor('aaa1111', archive)

    const home = installPayload({ runtimeRoot, manifest, archive })
    expect(home).toBe(path.join(runtimeRoot, 'runtime', 'aaa1111'))
    expect(fs.readFileSync(path.join(home, 'backend/app/main.py'), 'utf8')).toBe('# first\n')
    expect(JSON.parse(fs.readFileSync(path.join(home, 'manifest.json'), 'utf8')).sha).toBe('aaa1111')
  })

  test('refuses a corrupted archive and leaves the previous runtime untouched', () => {
    const runtimeRoot = tmpDir()
    const good = buildTarGz(payloadEntries('good'))
    installPayload({ runtimeRoot, manifest: manifestFor('aaa1111', good), archive: good })

    const bad = buildTarGz(payloadEntries('bad'))
    const manifest = manifestFor('bbb2222', bad)
    // Flip a byte so the digest no longer matches.
    bad[bad.length - 20] ^= 0xff

    expect(() => installPayload({ runtimeRoot, manifest, archive: bad })).toThrow(/校验失败/)
    expect(fs.existsSync(path.join(runtimeRoot, 'runtime', 'aaa1111', 'backend/app/main.py'))).toBe(true)
    expect(fs.existsSync(path.join(runtimeRoot, 'runtime', 'bbb2222'))).toBe(false)
  })

  test('rejects an archive missing required entries', () => {
    const runtimeRoot = tmpDir()
    const partial = buildTarGz([{ path: 'backend/app/main.py', data: 'x' }])
    const manifest = manifestFor('ccc3333', partial)
    expect(() => installPayload({ runtimeRoot, manifest, archive: partial })).toThrow(/缺少必需文件/)
  })

  test('rejects a wrong byte count before touching disk', () => {
    const runtimeRoot = tmpDir()
    const archive = buildTarGz(payloadEntries('x'))
    const manifest = { ...manifestFor('ddd4444', archive), archiveBytes: archive.length + 1 }
    expect(() => installPayload({ runtimeRoot, manifest, archive })).toThrow(/大小不符/)
  })
})

// ─────────────────────────────────────────────────────────── sync

describe('syncRuntime (file:// source)', () => {
  function publish(sourceDir: string, sha: string, marker: string, requirementsHash = 'deps-1') {
    const archive = buildTarGz(payloadEntries(marker))
    const manifest = manifestFor(sha, archive, requirementsHash)
    fs.mkdirSync(path.join(sourceDir, 'payload'), { recursive: true })
    fs.writeFileSync(path.join(sourceDir, 'payload', `${sha}.tar.gz`), archive)
    fs.writeFileSync(path.join(sourceDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

    return manifest
  }

  test('first run installs, second run is a no-op', async () => {
    const source = tmpDir()
    const runtimeRoot = tmpDir()
    publish(source, 'aaa1111', 'v1')

    const deps = fakeUpdaterDeps(runtimeRoot, source)
    const first = await syncRuntime(deps)
    expect(first.changed).toBe(true)
    expect(first.home).toBe(path.join(runtimeRoot, 'runtime', 'aaa1111'))
    expect(readState(runtimeRoot)?.sha).toBe('aaa1111')

    const second = await syncRuntime(deps)
    expect(second.changed).toBe(false)
    expect(second.home).toBe(first.home)
  })

  test('a new sha switches over and keeps the previous one for rollback', async () => {
    const source = tmpDir()
    const runtimeRoot = tmpDir()
    publish(source, 'aaa1111', 'v1')
    const deps = fakeUpdaterDeps(runtimeRoot, source)
    await syncRuntime(deps)

    publish(source, 'bbb2222', 'v2')
    const updated = await syncRuntime(deps)
    expect(updated.changed).toBe(true)
    expect(updated.state?.sha).toBe('bbb2222')
    expect(updated.state?.previousSha).toBe('aaa1111')
    expect(fs.readFileSync(path.join(updated.home!, 'backend/app/main.py'), 'utf8')).toBe('# v2\n')

    const rolled = rollbackState(runtimeRoot, 'bbb2222')
    expect(rolled?.sha).toBe('aaa1111')
    expect(rolled?.badShas).toContain('bbb2222')
  })

  test('after a rollback the same bad sha is not reinstalled', async () => {
    const source = tmpDir()
    const runtimeRoot = tmpDir()
    publish(source, 'aaa1111', 'v1')
    const deps = fakeUpdaterDeps(runtimeRoot, source)
    await syncRuntime(deps)
    publish(source, 'bbb2222', 'v2')
    await syncRuntime(deps)
    rollbackState(runtimeRoot, 'bbb2222')

    const again = await syncRuntime(deps)
    expect(again.changed).toBe(false)
    expect(readState(runtimeRoot)?.sha).toBe('aaa1111')
  })

  test('an unreachable manifest keeps the current version running', async () => {
    const runtimeRoot = tmpDir()
    writeState(runtimeRoot, { sha: 'aaa1111', requirementsHash: 'deps-1', badShas: [] } as RuntimeState)
    fs.mkdirSync(path.join(runtimeRoot, 'runtime', 'aaa1111', 'backend', 'app'), { recursive: true })
    fs.writeFileSync(path.join(runtimeRoot, 'runtime', 'aaa1111', 'backend', 'app', 'main.py'), 'x')

    const result = await syncRuntime({
      ...fakeUpdaterDeps(runtimeRoot, path.join(runtimeRoot, 'does-not-exist')),
      fetchText: async () => {
        throw new Error('ENOTFOUND oss.example.com')
      }
    })
    expect(result.changed).toBe(false)
    expect(result.home).toBe(path.join(runtimeRoot, 'runtime', 'aaa1111'))
    expect(result.detail).toMatch(/继续用当前版本/)
  })

  test('a corrupt manifest is reported, not thrown at the page', async () => {
    const runtimeRoot = tmpDir()
    const result = await syncRuntime({
      ...fakeUpdaterDeps(runtimeRoot, 'https://example.invalid/autocode'),
      fetchText: async () => '{ not json'
    })
    expect(result.changed).toBe(false)
    expect(result.detail).toMatch(/检查更新失败/)
  })
})

// ─────────────────────────────────────────────────────────── oss auth

describe('ossSignedHeaders', () => {
  test('matches an independently computed OSS V1 signature', () => {
    // Vector computed with python hmac/sha1 over the same canonical string:
    //   GET\n\n\n<Date>\n/auto-code/autocode/manifest.json
    const headers = ossSignedHeaders(
      'https://auto-code.oss-cn-shenzhen.aliyuncs.com/autocode/manifest.json',
      'AKID',
      'secret',
      'Tue, 10 Nov 2026 00:00:00 GMT'
    )
    expect(headers.Date).toBe('Tue, 10 Nov 2026 00:00:00 GMT')
    expect(headers.Authorization).toBe('OSS AKID:v5F04aVncKSNL8V2lCJkleb/U/Q=')
  })

  test('derives the bucket from the host and keeps the full object key', () => {
    const a = ossSignedHeaders('https://auto-code.oss-cn-shenzhen.aliyuncs.com/autocode/a/tar.gz', 'K', 's', 'D')
    const b = ossSignedHeaders('https://other-bucket.oss-cn-shenzhen.aliyuncs.com/autocode/a/tar.gz', 'K', 's', 'D')
    // Different buckets must not produce the same canonical resource.
    expect(a.Authorization).not.toBe(b.Authorization)
  })

  test('a different Date changes the signature (replay protection)', () => {
    const one = ossSignedHeaders('https://b.e.com/x', 'K', 's', 'Tue, 10 Nov 2026 00:00:00 GMT')
    const two = ossSignedHeaders('https://b.e.com/x', 'K', 's', 'Wed, 11 Nov 2026 00:00:00 GMT')
    expect(one.Authorization).not.toBe(two.Authorization)
  })
})

// ─────────────────────────────────────────────────────────── venv

describe('ensureVenv', () => {
  test('scrubs PYTHONPATH so pip installs instead of seeing the engine packages', () => {
    // Observed bug: with the engine's site-packages on PYTHONPATH, pip reported
    // fastapi/pydantic "already satisfied" and installed 11 of ~30 packages.
    const env = scrubPythonEnv({ PYTHONPATH: 'C:/engine/Lib/site-packages', PYTHONHOME: 'C:/engine', PATH: 'C:/bin' })
    expect(env.PYTHONPATH).toBeUndefined()
    expect(env.PYTHONHOME).toBeUndefined()
    expect(env.PATH).toBe('C:/bin')
    expect(env.PYTHONNOUSERSITE).toBe('1')
  })

  test('runs once per requirementsHash and records the marker', async () => {
    const home = tmpDir()
    fs.mkdirSync(path.join(home, 'backend'), { recursive: true })
    fs.writeFileSync(path.join(home, 'backend', 'requirements.lock'), 'fastapi==0.115.0\n')
    // The real `python -m venv` would create this; the runner below fakes it.
    const calls: string[][] = []
    const runCommand = async (command: string, args: string[]) => {
      calls.push([command, ...args])
      if (args[0] === '-m' && args[1] === 'venv') {
        fs.mkdirSync(path.dirname(venvPython(home)), { recursive: true })
        fs.writeFileSync(venvPython(home), '')
      }
    }

    await ensureVenv(home, 'deps-1', { log: () => {}, runCommand, resolvePython: () => '/fake/python' })
    expect(calls.length).toBe(2)
    expect(calls[0].slice(1)).toEqual(['-m', 'venv', path.join(home, 'venv')])
    expect(calls[1].slice(1)).toEqual([
      '-m',
      'pip',
      'install',
      '--disable-pip-version-check',
      '-r',
      path.join(home, 'backend', 'requirements.lock')
    ])
    expect(venvReady(home, 'deps-1')).toBe(true)
    expect(venvReady(home, 'deps-2')).toBe(false)

    // Second call with the same hash must not re-run pip.
    calls.length = 0
    await ensureVenv(home, 'deps-1', { log: () => {}, runCommand, resolvePython: () => '/fake/python' })
    expect(calls.length).toBe(0)
  })

  test('fails with an actionable message when no python is available', async () => {
    const home = tmpDir()
    fs.mkdirSync(path.join(home, 'backend'), { recursive: true })
    fs.writeFileSync(path.join(home, 'backend', 'requirements.lock'), 'x\n')
    await expect(
      ensureVenv(home, 'deps-1', { log: () => {}, runCommand: async () => {}, resolvePython: () => null })
    ).rejects.toThrow(/AUTOCODE_PYTHON/)
  })
})
