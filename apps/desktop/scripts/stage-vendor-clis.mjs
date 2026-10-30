// Pinned official native releases. Downloads occur only on the build machine;
// launch-time provisioning never needs brew, npm, credentials, or a network.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { assertCliBinaryFormat } from './plankton-cli-format.mjs'

export const VENDOR_RELEASES = {
  arm64: [
    { command: 'aliyun', version: '3.5.2', url: 'https://github.com/aliyun/aliyun-cli/releases/download/v3.5.2/aliyun-cli-macosx-3.5.2-arm64.tgz', sha256: '076e14de5450e4d61c59a54957e72529a644e8e4309b6ff5118d01db2c4aca6f' },
    { command: 'lark-cli', version: '1.0.98', url: 'https://github.com/larksuite/cli/releases/download/v1.0.98/lark-cli-1.0.98-darwin-arm64.tar.gz', sha256: 'ee4a3209bbf8b74ea5c00a07d0da89b79f5e7f6abfd518a8b2d78a7a4f7e3f40' }
  ],
  x64: [
    { command: 'aliyun', version: '3.5.2', url: 'https://github.com/aliyun/aliyun-cli/releases/download/v3.5.2/aliyun-cli-macosx-3.5.2-amd64.tgz', sha256: '5f03795a4a4dc5febeed8bc508090649f9d877afea894cacef96197a8e5b6788' },
    { command: 'lark-cli', version: '1.0.98', url: 'https://github.com/larksuite/cli/releases/download/v1.0.98/lark-cli-1.0.98-darwin-amd64.tar.gz', sha256: '44a4ff98e969385fc4bb4d701735ba319307e50560fa6c4c956178d70ccc3525' }
  ]
}

export function verifyArchive(file, sha256) {
  const actual = createHash('sha256').update(fs.readFileSync(file)).digest('hex')
  if (actual !== sha256) throw new Error(`archive-sha256-mismatch:${path.basename(file)} expected=${sha256} actual=${actual}`)
}

export function assertVendorCliResources({ resourcesPath, platform, arch }) {
  if (platform !== 'darwin' || !VENDOR_RELEASES[arch]) return []
  return VENDOR_RELEASES[arch].map(spec => {
    const file = path.join(resourcesPath, 'enterprise', 'cli', `${platform}-${arch}`, spec.command)
    if (!fs.statSync(file).isFile() || fs.statSync(file).size === 0) throw new Error(`invalid-vendor-cli:${file}`)
    fs.accessSync(file, fs.constants.X_OK)
    assertCliBinaryFormat({ file, platform, arch })
    return file
  })
}

export function stageVendorClis({ platform = process.platform, arch = process.arch, desktopRoot = path.resolve(import.meta.dirname, '..'), download = (url, file) => execFileSync('curl', ['--fail', '--location', '--retry', '2', '--connect-timeout', '20', '--max-time', '180', '--output', file, url], { stdio: 'inherit' }) } = {}) {
  if (platform !== 'darwin' || !VENDOR_RELEASES[arch]) {
    console.log(JSON.stringify({ step: 'vendor-cli-stage', status: 'unsupported', platform, arch }))
    return []
  }
  const cache = path.join(desktopRoot, 'build', 'enterprise', 'cli-archives')
  const output = path.join(desktopRoot, 'build', 'enterprise', 'cli', `${platform}-${arch}`)
  fs.mkdirSync(cache, { recursive: true })
  fs.mkdirSync(output, { recursive: true })
  const files = []
  for (const spec of VENDOR_RELEASES[arch]) {
    const archive = path.join(cache, path.basename(spec.url))
    const pending = `${archive}.${randomUUID()}.tmp`
    const dest = path.join(output, spec.command)
    const tmp = `${dest}.${randomUUID()}.tmp`
    try {
      if (!fs.existsSync(archive)) {
        download(spec.url, pending)
        verifyArchive(pending, spec.sha256)
        fs.renameSync(pending, archive)
      }
      // Cached archives are never implicitly trusted, even when output exists.
      verifyArchive(archive, spec.sha256)
      // Extract only the root-level binary to stdout: no archive-controlled paths.
      const bytes = execFileSync('tar', ['-xOzf', archive, spec.command], { maxBuffer: 256 * 1024 * 1024 })
      fs.writeFileSync(tmp, bytes, { mode: 0o755, flag: 'wx' })
      assertCliBinaryFormat({ file: tmp, platform, arch })
      if (platform === process.platform && arch === process.arch) {
        const args = spec.command === 'aliyun' ? ['version'] : ['--version']
        const version = execFileSync(tmp, args, { encoding: 'utf8', timeout: 10000 }).trim()
        if (!version.includes(spec.version)) throw new Error(`version-mismatch:${spec.command}:${version}`)
      }
      fs.renameSync(tmp, dest)
      files.push(dest)
      console.log(JSON.stringify({ step: 'vendor-cli-stage', status: 'ready', command: spec.command, version: spec.version, arch, sha256: spec.sha256, file: dest }))
    } finally {
      for (const file of [pending, tmp]) if (fs.existsSync(file)) fs.unlinkSync(file)
    }
  }
  return files
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { stageVendorClis({ arch: process.argv[2] ?? process.arch }) }
  catch (error) { console.error(JSON.stringify({ step: 'vendor-cli-stage', status: 'failed', reason: error.message })); process.exitCode = 1 }
}
