// plankton-cli-format.mjs — the enterprise CLI's BINARY FORMAT + ARCHITECTURE
// check, shared by the pack-time staging step (scripts/plankton-pack.sh) and by
// after-pack.mjs.
//
// WHY THIS EXISTS
// ---------------
// The R1 after-pack assertion (see after-pack.mjs) proved a resource was
// present, NON-EMPTY and — on POSIX — executable. That is exactly the shape a
// WRONG binary has too: a directory (a directory is non-empty and 0755), a text
// placeholder, a CLI built for another OS/arch, or a truncated stub all passed
// the present+non-empty+exec test and shipped a green artifact that only failed
// at runtime. This module closes that gap: it reads the file's leading bytes and
// proves the magic matches the TARGET platform and the embedded CPU matches the
// TARGET arch, so a mismatched seed turns the build RED.
//
// `assert` when run directly:
//   node scripts/plankton-cli-format.mjs assert --platform darwin --arch arm64 --file <path>

import fs from 'node:fs'
import { pathToFileURL } from 'node:url'

/** Canonical arch names (electron-builder Arch → the names used in resource paths). */
const ARCH_ALIASES = new Map([
  ['x64', 'x64'],
  ['x86_64', 'x64'],
  ['amd64', 'x64'],
  ['arm64', 'arm64'],
  ['aarch64', 'arm64'],
  ['ia32', 'ia32'],
  ['x86', 'ia32'],
  ['i386', 'ia32'],
  ['i686', 'ia32'],
  ['armv7l', 'arm32'],
  ['arm', 'arm32']
])

/** Normalize an arch label; returns null when unrecognized. */
export function normalizeArch(arch) {
  if (arch === undefined || arch === null) {
    return null
  }

  return ARCH_ALIASES.get(String(arch).toLowerCase()) ?? null
}

// Mach-O cputype → canonical arch (see <mach/machine.h>).
const MACHO_CPU = new Map([
  [0x01000007, 'x64'], // CPU_TYPE_X86_64
  [0x0100000c, 'arm64'], // CPU_TYPE_ARM64
  [0x00000007, 'ia32'], // CPU_TYPE_X86
  [0x0000000c, 'arm32'] // CPU_TYPE_ARM
])

// ELF e_machine → canonical arch.
const ELF_MACHINE = new Map([
  [0x003e, 'x64'], // EM_X86_64
  [0x00b7, 'arm64'], // EM_AARCH64
  [0x0003, 'ia32'], // EM_386
  [0x0028, 'arm32'] // EM_ARM
])

// PE Machine → canonical arch.
const PE_MACHINE = new Map([
  [0x8664, 'x64'], // IMAGE_FILE_MACHINE_AMD64
  [0xaa64, 'arm64'], // IMAGE_FILE_MACHINE_ARM64
  [0x014c, 'ia32'], // IMAGE_FILE_MACHINE_I386
  [0x01c4, 'arm32'] // IMAGE_FILE_MACHINE_ARMNT
])

/**
 * Identify an executable's container format and the architecture(s) it carries.
 * @param {Buffer} buffer leading bytes of the file (whole file is fine)
 * @returns {{ format: 'macho' | 'macho-fat' | 'elf' | 'pe' | 'unknown', archs: string[] }}
 *   `archs` holds canonical arch names, or `cputype:0x…` / `machine:0x…` markers
 *   for an unrecognized CPU. Empty when the header is too short to read.
 */
export function detectBinaryFormat(buffer) {
  if (buffer.length >= 4) {
    // ELF.
    if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
      if (buffer.length < 20) {
        return { format: 'elf', archs: [] }
      }
      const machine = buffer.readUInt16LE(18) // e_machine (little-endian ELF class here)
      return { format: 'elf', archs: [ELF_MACHINE.get(machine) ?? `machine:0x${machine.toString(16)}`] }
    }

    // Thin Mach-O, both byte orders.
    const magicLE = buffer.readUInt32LE(0)
    const magicBE = buffer.readUInt32BE(0)
    if (magicLE === 0xfeedfacf || magicLE === 0xfeedface) {
      if (buffer.length < 8) {
        return { format: 'macho', archs: [] }
      }
      const cputype = buffer.readUInt32LE(4)
      return { format: 'macho', archs: [MACHO_CPU.get(cputype) ?? `cputype:0x${cputype.toString(16)}`] }
    }
    if (magicBE === 0xfeedfacf || magicBE === 0xfeedface) {
      if (buffer.length < 8) {
        return { format: 'macho', archs: [] }
      }
      const cputype = buffer.readUInt32BE(4)
      return { format: 'macho', archs: [MACHO_CPU.get(cputype) ?? `cputype:0x${cputype.toString(16)}`] }
    }

    // Universal (fat) Mach-O, either byte order.
    if (magicBE === 0xcafebabe || magicBE === 0xbebafeca) {
      const bigEndian = magicBE === 0xcafebabe
      const nfat = bigEndian ? buffer.readUInt32BE(4) : buffer.readUInt32LE(4)
      const archs = []
      for (let i = 0; i < nfat; i += 1) {
        const off = 8 + i * 20
        if (off + 4 > buffer.length) {
          break
        }
        const cputype = bigEndian ? buffer.readUInt32BE(off) : buffer.readUInt32LE(off)
        archs.push(MACHO_CPU.get(cputype) ?? `cputype:0x${cputype.toString(16)}`)
      }
      return { format: 'macho-fat', archs }
    }

    // PE/COFF (Windows): 'MZ' DOS stub + 'PE\0\0' at e_lfanew.
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
      if (buffer.length < 0x40) {
        return { format: 'pe', archs: [] }
      }
      const peOffset = buffer.readUInt32LE(0x3c)
      if (peOffset + 6 <= buffer.length && buffer.toString('latin1', peOffset, peOffset + 4) === 'PE\u0000\u0000') {
        const machine = buffer.readUInt16LE(peOffset + 4)
        return { format: 'pe', archs: [PE_MACHINE.get(machine) ?? `machine:0x${machine.toString(16)}`] }
      }
      return { format: 'pe', archs: [] }
    }
  }

  return { format: 'unknown', archs: [] }
}

/** The container format(s) a target platform's native executable may use. */
function expectedFormats(platform) {
  if (platform === 'darwin') {
    return new Set(['macho', 'macho-fat'])
  }
  if (platform === 'win32') {
    return new Set(['pe'])
  }

  return new Set(['elf'])
}

/**
 * Throw unless `file` is a regular executable of the target `platform`/`arch`.
 * @param {{ file: string, platform: string, arch?: string|number, label?: string }} options
 * @returns {{ format: string, archs: string[] }} the detected facts, for logging
 */
export function assertCliBinaryFormat({ file, platform, arch, label = '[plankton] CLI' }) {
  const buffer = fs.readFileSync(file)
  const { format, archs } = detectBinaryFormat(buffer)
  const wantFormats = expectedFormats(platform)
  const wantArch = normalizeArch(arch)

  if (!wantFormats.has(format)) {
    throw new Error(
      `${label}: ${file} is not a ${platform} executable (detected ${format}; expected ${[...wantFormats].join('/')}). ` +
        'A wrong-OS binary, a text placeholder, or a directory/non-binary seed would ship an unrunnable CLI.'
    )
  }

  if (wantArch && !archs.includes(wantArch)) {
    throw new Error(
      `${label}: ${file} carries architecture ${archs.length > 0 ? archs.join(',') : '(unreadable header)'}, ` +
        `but the target is ${wantArch}. A CLI staged for the wrong arch (e.g. a macOS x64 binary under darwin-arm64) ` +
        'would ship and only fail at runtime.'
    )
  }

  return { format, archs }
}

function parseArgs(argv) {
  const options = {}
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i].startsWith('--')) {
      options[argv[i].slice(2)] = argv[i + 1]
      i += 1
    }
  }

  return options
}

function main() {
  const [command, ...rest] = process.argv.slice(2)
  if (command !== 'assert') {
    console.error('usage: plankton-cli-format.mjs assert --platform <darwin|linux|win32> --arch <arm64|x64|...> --file <path>')
    process.exit(2)
  }

  const options = parseArgs(rest)
  try {
    const { format, archs } = assertCliBinaryFormat({
      file: options.file,
      platform: options.platform,
      arch: options.arch,
      label: '[plankton-pack] staged CLI'
    })
    console.log(`[plankton-pack] CLI format OK: ${format} ${archs.join(',')} <- ${options.file}`)
  } catch (error) {
    console.error(String(error instanceof Error ? error.message : error))
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
}
