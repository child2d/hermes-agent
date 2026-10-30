import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { expect, it } from 'vitest'
import { stageVendorClis, verifyArchive, VENDOR_RELEASES, assertVendorCliResources } from './stage-vendor-clis.mjs'

it('checks original archive bytes including cached downloads before extracting or changing staged binaries', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vendor-stage-'))
  try {
    const archive = path.join(root, 'archive')
    fs.writeFileSync(archive, 'archive bytes')
    const hash = createHash('sha256').update(fs.readFileSync(archive)).digest('hex')
    expect(() => verifyArchive(archive, hash)).not.toThrow()
    fs.appendFileSync(archive, 'tamper')
    expect(() => verifyArchive(archive, hash)).toThrow(/sha256-mismatch/)
    const cache = path.join(root, 'build/enterprise/cli-archives')
    fs.mkdirSync(cache, { recursive: true })
    fs.writeFileSync(path.join(cache, path.basename(VENDOR_RELEASES.arm64[0].url)), 'corrupt cached archive')
    let downloads = 0
    expect(() => stageVendorClis({ platform: 'darwin', arch: 'arm64', desktopRoot: root, download: () => { downloads++ } })).toThrow(/sha256-mismatch/)
    expect(downloads).toBe(0)
    expect(fs.readdirSync(path.join(root, 'build/enterprise/cli/darwin-arm64'))).toEqual([])
    expect(assertVendorCliResources({ resourcesPath: root, platform: 'linux', arch: 'arm64' })).toEqual([])
    expect(() => assertVendorCliResources({ resourcesPath: root, platform: 'darwin', arch: 'arm64' })).toThrow()
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
