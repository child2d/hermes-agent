import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

import { assertCliBinaryFormat, detectBinaryFormat, normalizeArch } from './plankton-cli-format.mjs'

const temps = []
afterEach(async () => {
  for (const dir of temps.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempFile(bytes) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'plankton-cli-fmt-'))
  temps.push(dir)
  const file = path.join(dir, 'shaoke-cli')
  await writeFile(file, bytes)
  return file
}

function macho(arch) {
  const buffer = Buffer.alloc(32)
  buffer.writeUInt32LE(0xfeedfacf, 0)
  buffer.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4)
  buffer.writeUInt32LE(2, 12)
  return buffer
}

function elf(arch) {
  const buffer = Buffer.alloc(64)
  buffer.write('\u007fELF', 0, 'latin1')
  buffer[4] = 2 // 64-bit
  buffer[5] = 1 // little-endian
  buffer.writeUInt16LE(arch === 'x64' ? 0x3e : 0xb7, 18)
  return buffer
}

function pe(arch) {
  const buffer = Buffer.alloc(0x100)
  buffer.write('MZ', 0, 'latin1')
  buffer.writeUInt32LE(0x80, 0x3c) // e_lfanew
  buffer.write('PE\u0000\u0000', 0x80, 'latin1')
  buffer.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 0x84)
  return buffer
}

/** A COMPLETE fat Mach-O: arch table + a real [offset, size) slice per arch. */
function fatMachO(archs) {
  const tableSize = 8 + archs.length * 20
  const sliceStride = 16
  const buffer = Buffer.alloc(tableSize + archs.length * sliceStride)
  buffer.writeUInt32BE(0xcafebabe, 0)
  buffer.writeUInt32BE(archs.length, 4)
  archs.forEach((arch, i) => {
    const off = 8 + i * 20
    buffer.writeUInt32BE(arch === 'x64' ? 0x01000007 : 0x0100000c, off)
    buffer.writeUInt32BE(tableSize + i * sliceStride, off + 8) // slice offset
    buffer.writeUInt32BE(sliceStride, off + 12) // slice size
  })
  return buffer
}

describe('detectBinaryFormat', () => {
  it('reads thin Mach-O arch (both endiannesses)', () => {
    expect(detectBinaryFormat(macho('arm64'))).toEqual({ format: 'macho', archs: ['arm64'] })
    expect(detectBinaryFormat(macho('x64'))).toEqual({ format: 'macho', archs: ['x64'] })
  })

  it('lists every slice of a universal (fat) Mach-O', () => {
    expect(detectBinaryFormat(fatMachO(['x64', 'arm64']))).toEqual({ format: 'macho-fat', archs: ['x64', 'arm64'] })
  })

  it('reads ELF and PE machine fields', () => {
    expect(detectBinaryFormat(elf('x64'))).toEqual({ format: 'elf', archs: ['x64'] })
    expect(detectBinaryFormat(elf('arm64'))).toEqual({ format: 'elf', archs: ['arm64'] })
    expect(detectBinaryFormat(pe('arm64'))).toEqual({ format: 'pe', archs: ['arm64'] })
  })

  it('reports unknown for garbage / text', () => {
    expect(detectBinaryFormat(Buffer.from('a text placeholder'))).toEqual({ format: 'unknown', archs: [] })
    expect(detectBinaryFormat(Buffer.alloc(0))).toEqual({ format: 'unknown', archs: [] })
  })

  // ── P3-1: a magic-only check is a false green. A truncated-but-headed file
  // must read as UNREADABLE (empty archs), not as a valid binary.
  it('P3-1: reads a TRUNCATED thin Mach-O (8 bytes) as unreadable', () => {
    expect(detectBinaryFormat(macho('arm64').subarray(0, 8))).toEqual({ format: 'macho', archs: [] })
  })

  it('P3-1: reads a TRUNCATED fat Mach-O (12 bytes) as unreadable', () => {
    expect(detectBinaryFormat(fatMachO(['x64', 'arm64']).subarray(0, 12))).toEqual({ format: 'macho-fat', archs: [] })
  })

  it('P3-1: reads a fat Mach-O whose slice runs off the end as unreadable', () => {
    const fat = fatMachO(['arm64'])
    fat.writeUInt32BE(fat.length + 4096, 8 + 12) // slice size past EOF
    expect(detectBinaryFormat(fat)).toEqual({ format: 'macho-fat', archs: [] })
  })

  it('P3-1: reads a truncated ELF and PE header as unreadable', () => {
    expect(detectBinaryFormat(elf('x64').subarray(0, 20))).toEqual({ format: 'elf', archs: [] })
    expect(detectBinaryFormat(pe('x64').subarray(0, 0x40))).toEqual({ format: 'pe', archs: [] })
  })
})

describe('assertCliBinaryFormat', () => {
  it('accepts a matching platform/arch, including a universal binary containing the target', async () => {
    const arm64 = await tempFile(macho('arm64'))
    expect(assertCliBinaryFormat({ file: arm64, platform: 'darwin', arch: 'arm64' })).toEqual({ format: 'macho', archs: ['arm64'] })

    const universal = await tempFile(fatMachO(['x64', 'arm64']))
    expect(assertCliBinaryFormat({ file: universal, platform: 'darwin', arch: 'arm64' }).format).toBe('macho-fat')
  })

  // P3 counter-proof: a non-empty, executable file of the WRONG platform/arch
  // (what `PLANKTON_SHAOKE_CLI_SRC` pointing at another platform's build yields)
  // must be RED, not silently GREEN.
  it('rejects a binary built for another platform', async () => {
    const linuxBinary = await tempFile(elf('x64'))
    expect(() => assertCliBinaryFormat({ file: linuxBinary, platform: 'darwin', arch: 'arm64' })).toThrow(
      /not a darwin executable/
    )
  })

  it('rejects a same-platform binary of the wrong architecture', async () => {
    const x64 = await tempFile(macho('x64'))
    expect(() => assertCliBinaryFormat({ file: x64, platform: 'darwin', arch: 'arm64' })).toThrow(/architecture x64/)
  })

  it('rejects a text placeholder', async () => {
    const text = await tempFile(Buffer.from('not a binary'))
    expect(() => assertCliBinaryFormat({ file: text, platform: 'linux', arch: 'x64' })).toThrow(/not a linux executable/)
  })

  // ── P3-1 (third review): the MAGIC matched and the cputype was readable, but
  // the file was truncated. Both shipped GREEN before; both must be RED now.
  it('P3-1: rejects a truncated thin Mach-O even though its cputype matches', async () => {
    const file = await tempFile(macho('arm64').subarray(0, 8))
    expect(() => assertCliBinaryFormat({ file, platform: 'darwin', arch: 'arm64' })).toThrow(/TRUNCATED/)
  })

  it('P3-1: rejects a truncated fat Mach-O (12 bytes) for an arch target', async () => {
    const file = await tempFile(fatMachO(['x64', 'arm64']).subarray(0, 12))
    expect(() => assertCliBinaryFormat({ file, platform: 'darwin', arch: 'arm64' })).toThrow(/TRUNCATED/)
    // …and for a universal target too (format alone is not enough).
    expect(() => assertCliBinaryFormat({ file, platform: 'darwin', arch: 'universal' })).toThrow(/TRUNCATED/)
  })

  // ── Low-item: `arch: 'universal'` used to normalize to null and SILENTLY skip
  // the arch check. It is now an explicit target with a real requirement.
  it('treats arch universal as an explicit darwin fat-Mach-O requirement (never a silent skip)', async () => {
    const universal = await tempFile(fatMachO(['x64', 'arm64']))
    expect(assertCliBinaryFormat({ file: universal, platform: 'darwin', arch: 'universal' }).format).toBe('macho-fat')

    const thin = await tempFile(macho('arm64'))
    expect(() => assertCliBinaryFormat({ file: thin, platform: 'darwin', arch: 'universal' })).toThrow(/universal/)

    const linux = await tempFile(elf('x64'))
    expect(() => assertCliBinaryFormat({ file: linux, platform: 'linux', arch: 'universal' })).toThrow(/only valid for darwin/)
  })

  it('accepts a Windows PE for win32 and normalizes arch aliases', async () => {
    expect(normalizeArch('aarch64')).toBe('arm64')
    expect(normalizeArch('amd64')).toBe('x64')
    const winBinary = await tempFile(pe('x64'))
    expect(assertCliBinaryFormat({ file: winBinary, platform: 'win32', arch: 'x64' }).format).toBe('pe')
  })
})
