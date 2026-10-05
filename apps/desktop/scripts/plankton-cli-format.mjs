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
// STRUCTURAL COMPLETENESS (batch-2 third review, P3-1)
// ----------------------------------------------------
// A magic-byte-only check is still a false green: an arm64 Mach-O truncated to 8
// bytes (magic + cputype, no load commands) and a 12-byte fat Mach-O (header, no
// complete arch slice) both carried a readable cputype and shipped GREEN. So the
// detector now reads the WHOLE structural header each format needs and treats a
// file whose declared structures fall off the end of the file as UNREADABLE
// (empty `archs`), which the assertion turns RED:
//   - thin Mach-O: the mach_header(_64) itself (32/28 bytes) AND the declared
//     load-command block (`sizeofcmds`) must fit inside the file;
//   - fat Mach-O: the full arch table (8 + nfat*20) plus every slice's
//     [offset, offset+size) must lie inside the file, and each slice size > 0;
//   - ELF: the full ehdr (52/64) plus the program- and section-header tables;
//   - PE: the COFF header + optional header + the section table.
//
// SUPPORTED ARCHES / UNIVERSAL (low-item)
// ---------------------------------------
// `arch: 'universal'` used to normalize to null and SILENTLY skip the arch check
// (a wrong thin binary under a `-universal/` directory read green). It is now an
// explicit target: darwin-only, and the binary MUST be a fat Mach-O.
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

const MACHO_MAGIC_64 = 0xfeedfacf
const MACHO_MAGIC_32 = 0xfeedface
const FAT_MAGIC_BE = 0xcafebabe
const FAT_MAGIC_LE = 0xbebafeca

/** A Mach-O cputype → canonical arch, or a readable marker for an unknown one. */
function machoCpu(cputype) {
  return MACHO_CPU.get(cputype) ?? `cputype:0x${cputype.toString(16)}`
}

/** Thin Mach-O: read the header AND prove the load-command block is present. */
function detectThinMachO(buffer, bigEndian) {
  const magic = bigEndian ? buffer.readUInt32BE(0) : buffer.readUInt32LE(0)
  const is64 = magic === MACHO_MAGIC_64
  const headerSize = is64 ? 32 : 28
  if (buffer.length < headerSize) {
    return { format: 'macho', archs: [] }
  }

  const cputype = bigEndian ? buffer.readUInt32BE(4) : buffer.readUInt32LE(4)
  const ncmds = bigEndian ? buffer.readUInt32BE(16) : buffer.readUInt32LE(16)
  const sizeofcmds = bigEndian ? buffer.readUInt32BE(20) : buffer.readUInt32LE(20)
  // The load-command block the header declares must fit inside the file: a
  // truncated stub keeps a readable cputype but has nothing to run.
  if (headerSize + sizeofcmds > buffer.length || (ncmds === 0 && sizeofcmds > 0)) {
    return { format: 'macho', archs: [] }
  }

  return { format: 'macho', archs: [machoCpu(cputype)] }
}

/** Universal (fat) Mach-O: prove the arch table and every slice are complete. */
function detectFatMachO(buffer) {
  if (buffer.length < 8) {
    return { format: 'macho-fat', archs: [] }
  }

  const bigEndian = buffer.readUInt32BE(0) === FAT_MAGIC_BE
  const nfat = bigEndian ? buffer.readUInt32BE(4) : buffer.readUInt32LE(4)
  const tableEnd = 8 + nfat * 20
  if (nfat < 1 || tableEnd > buffer.length) {
    return { format: 'macho-fat', archs: [] }
  }

  const read32 = offset => (bigEndian ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset))
  const archs = []
  for (let i = 0; i < nfat; i += 1) {
    const off = 8 + i * 20
    const sliceOffset = read32(off + 8)
    const sliceSize = read32(off + 12)
    // Every arch slice must be a non-empty range inside the file.
    if (sliceSize === 0 || sliceOffset + sliceSize > buffer.length) {
      return { format: 'macho-fat', archs: [] }
    }
    archs.push(machoCpu(read32(off)))
  }

  return { format: 'macho-fat', archs }
}

/** ELF: read the class-correct ehdr and the program/section header tables. */
function detectElf(buffer) {
  const eiClass = buffer[4]
  const eiData = buffer[5] ?? 1
  const bigEndian = eiData === 2
  const is64 = eiClass === 2
  const headerSize = is64 ? 64 : 52
  if (buffer.length < headerSize) {
    return { format: 'elf', archs: [] }
  }

  const read16 = offset => (bigEndian ? buffer.readUInt16BE(offset) : buffer.readUInt16LE(offset))
  const read32 = offset => (bigEndian ? buffer.readUInt32BE(offset) : buffer.readUInt32LE(offset))
  const readWord = offset => (bigEndian ? buffer.readBigUInt64BE(offset) : buffer.readBigUInt64LE(offset))

  const machine = read16(18)
  const phoff = is64 ? Number(readWord(0x20)) : read32(0x1c)
  const phentsize = read16(is64 ? 0x36 : 0x2a)
  const phnum = read16(is64 ? 0x38 : 0x2c)
  const shoff = is64 ? Number(readWord(0x28)) : read32(0x20)
  const shentsize = read16(is64 ? 0x3a : 0x2e)
  const shnum = read16(is64 ? 0x3c : 0x30)

  // Declared tables must fit inside the file (a truncated ELF keeps a readable
  // e_machine at 18 but has no program/section data).
  if (phnum > 0 && (phentsize === 0 || phoff + phnum * phentsize > buffer.length)) {
    return { format: 'elf', archs: [] }
  }
  if (shnum > 0 && (shentsize === 0 || shoff + shnum * shentsize > buffer.length)) {
    return { format: 'elf', archs: [] }
  }

  return { format: 'elf', archs: [ELF_MACHINE.get(machine) ?? `machine:0x${machine.toString(16)}`] }
}

/** PE/COFF: 'MZ' stub + 'PE\0\0' + the COFF/optional/section tables in bounds. */
function detectPe(buffer) {
  if (buffer.length < 0x40) {
    return { format: 'pe', archs: [] }
  }

  const peOffset = buffer.readUInt32LE(0x3c)
  if (peOffset + 24 > buffer.length || buffer.toString('latin1', peOffset, peOffset + 4) !== 'PE\u0000\u0000') {
    return { format: 'pe', archs: [] }
  }

  const machine = buffer.readUInt16LE(peOffset + 4)
  const nSections = buffer.readUInt16LE(peOffset + 6)
  const sizeOfOptional = buffer.readUInt16LE(peOffset + 20)
  // COFF header (24) + optional header + the section table must all be present.
  if (peOffset + 24 + sizeOfOptional + nSections * 40 > buffer.length) {
    return { format: 'pe', archs: [] }
  }

  return { format: 'pe', archs: [PE_MACHINE.get(machine) ?? `machine:0x${machine.toString(16)}`] }
}

/**
 * Identify an executable's container format and the architecture(s) it carries.
 * @param {Buffer} buffer leading bytes of the file (whole file is fine)
 * @returns {{ format: 'macho' | 'macho-fat' | 'elf' | 'pe' | 'unknown', archs: string[] }}
 *   `archs` holds canonical arch names, or `cputype:0x…` / `machine:0x…` markers
 *   for an unrecognized CPU. EMPTY when the header/structures are too short to
 *   read — i.e. a truncated file — which the assertion treats as unreadable.
 */
export function detectBinaryFormat(buffer) {
  if (buffer.length >= 4) {
    // ELF.
    if (buffer[0] === 0x7f && buffer[1] === 0x45 && buffer[2] === 0x4c && buffer[3] === 0x46) {
      return detectElf(buffer)
    }

    // Thin Mach-O, both byte orders.
    const magicLE = buffer.readUInt32LE(0)
    const magicBE = buffer.readUInt32BE(0)
    if (magicLE === MACHO_MAGIC_64 || magicLE === MACHO_MAGIC_32) {
      return detectThinMachO(buffer, false)
    }
    if (magicBE === MACHO_MAGIC_64 || magicBE === MACHO_MAGIC_32) {
      return detectThinMachO(buffer, true)
    }

    // Universal (fat) Mach-O, either byte order.
    if (magicBE === FAT_MAGIC_BE || magicBE === FAT_MAGIC_LE) {
      return detectFatMachO(buffer)
    }

    // PE/COFF (Windows): 'MZ' DOS stub + 'PE\0\0' at e_lfanew.
    if (buffer[0] === 0x4d && buffer[1] === 0x5a) {
      return detectPe(buffer)
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

  if (!wantFormats.has(format)) {
    throw new Error(
      `${label}: ${file} is not a ${platform} executable (detected ${format}; expected ${[...wantFormats].join('/')}). ` +
        'A wrong-OS binary, a text placeholder, or a directory/non-binary seed would ship an unrunnable CLI.'
    )
  }

  // Empty `archs` on a format that HAS an arch field means the header (or the
  // fat arch table / slices) is truncated — the magic was present but the
  // structure was not. Never green.
  if (archs.length === 0) {
    throw new Error(
      `${label}: ${file} has a ${format} magic but a TRUNCATED ${format} header ` +
        '(load commands / arch slices / header tables fall off the end of the file). ' +
        'A truncated seed would ship an unrunnable CLI.'
    )
  }

  const archLabel = arch === undefined || arch === null ? null : String(arch).toLowerCase()
  if (archLabel === 'universal') {
    // A universal target is a real macOS target, not a reason to skip the check:
    // it must be a fat Mach-O carrying at least one recognized slice.
    if (platform !== 'darwin') {
      throw new Error(`${label}: arch 'universal' is only valid for darwin, not ${platform}.`)
    }
    if (format !== 'macho-fat') {
      throw new Error(
        `${label}: ${file} targets arch 'universal' but is a thin ${format} — a universal target needs a fat Mach-O.`
      )
    }
    return { format, archs }
  }

  const wantArch = normalizeArch(arch)
  if (wantArch && !archs.includes(wantArch)) {
    throw new Error(
      `${label}: ${file} carries architecture ${archs.join(',')}, ` +
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
