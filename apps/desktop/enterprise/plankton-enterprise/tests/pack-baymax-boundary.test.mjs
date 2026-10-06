/**
 * W2 · boundary guard for the single assembly point (PLK-REQ-0034's machine
 * carrier, ported from the old shell's `pack-boundary.test.mjs`).
 *
 * Nature of this file (do NOT over-trust it): like the old one, it is a static
 * source assertion, not a behavioural test. It catches the ACCIDENT of the host
 * core growing its own understanding of a specific pack — a rename or a
 * relocation can slip past it. Its worth is that "the host quietly learned
 * baymax" becomes a change that turns red.
 *
 * In the new base the host core is exactly the plugin file MINUS the W2 section
 * (the pack's own declaration + the assembly point), which is the same exclusion
 * set the old test declared (assembly-point file + the pack's own directory).
 *
 * Run:
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-baymax-boundary.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..', 'desktop', 'plugin.js')
const SOURCE = fs.readFileSync(PLUGIN, 'utf8')

/** The W2 section = the pack's own words + the one assembly point (excluded set). */
const W2_START = '// W2 · the SINGLE assembly point'
const W2_END = "const ID = 'plankton-enterprise'"
const start = SOURCE.indexOf(W2_START)
const end = SOURCE.indexOf(W2_END)
assert.ok(start > 0 && end > start, 'the W2 section markers must exist (the exclusion set is explicit)')
const PACK_SECTION = SOURCE.slice(start, end)

/**
 * Second (and last) exclusion: the module's EXPORT SURFACE. It names the pack on
 * purpose, exactly like the assembly point — it is how the pack leaves this
 * module. Kept narrow by the assertion below, which forbids the surface from
 * carrying anything but identifiers (no command prefixes, no wire field names).
 */
const exportIdx = SOURCE.lastIndexOf('\nexport {')
assert.ok(exportIdx > end, 'the export surface must follow the UI sections')
const EXPORT_SURFACE = SOURCE.slice(exportIdx)
const HOST_CORE = SOURCE.slice(0, start) + SOURCE.slice(end, exportIdx)

/** Concept blacklist: command prefixes + proprietary identifiers (NOT just the pack name). */
const BLACKLIST = [
  /baymax/i,
  /\+issue-/i,
  /issueKey/,
  /\bparentId\b/,
  /\bALL_TODO\b/,
  /\bDUE_SOON\b/,
  /\bestimateEnd\b/,
  /\btypeId\b/,
  /\bstatusId\b/,
  /\bpriorityId\b/,
]

/** Spec-path citations carry the pack's name but are references, not coupling. */
const SPEC_PATH_CITATION = /docs\/plankton\/[A-Za-z0-9._\-/]*baymax[A-Za-z0-9._\-/]*/g

/** Strip the citations, then scan every line — and again with quotes/space removed
 *  (a literal assembled across string concatenation re-forms under the squash). */
function scan(source) {
  const hits = []
  const stripped = source.replace(SPEC_PATH_CITATION, '«spec-path»')
  stripped.split('\n').forEach((line, index) => {
    const squashed = line.replace(/['"`]/g, '').replace(/\s+/g, '')
    for (const pattern of BLACKLIST) {
      if (pattern.test(line) || pattern.test(squashed)) hits.push({ line: index + 1, text: line.trim().slice(0, 90) })
    }
  })
  return hits
}

test('宿主核心零专有残留：包名与命令前缀一个字都不得出现（规范路径引用不算）', () => {
  assert.ok(PACK_SECTION.length > 1000, '排除集不能是空的：包自己那一段本来就该有专有字面')
  const hits = scan(HOST_CORE)
  assert.deepEqual(hits, [], `宿主核心出现专有字面（应移入包声明/技能）：${hits.map((h) => `L${h.line} ${h.text}`).join(' | ')}`)
  // 排除集非空转：包里**本来就该**有专有字面，否则这条排除就是空口白话
  assert.ok(BLACKLIST.filter((p) => p.test(PACK_SECTION)).length >= 3, '包侧居然没有专有字面 —— 排除集失去意义，检查是否切错了区间')
})

test('反向变异：往宿主核心塞一条专有字面，检查器必须变红（判据失效即在此暴露）', () => {
  const mutant = scan("console.log('+issue-create', 'baymax', ALL_TODO)")
  assert.ok(mutant.length >= 3, `检查器漏掉了专有字面（命中 ${mutant.length} 条）——判据已失效，先修检查器`)
  // 拼接绕过也要抓住（去引号去空白后重新连成被禁字面）
  assert.ok(scan("const cmd = '+' + 'issue-create'").length >= 1, '拼接绕过必须被 squashed 扫描抓住')
})

test('排除集是精确的：只摘除规范路径引用，代码里的包名一律照扫', () => {
  assert.equal('docs/plankton/N7-20260930-plankton-baymax-chat-native.md'.replace(SPEC_PATH_CITATION, '«spec-path»'), '«spec-path»')
  assert.equal("const id = 'baymax'".replace(SPEC_PATH_CITATION, '«spec-path»'), "const id = 'baymax'")
})

test('装配点唯一：宿主里只有一个地方把包绑到 load()，且只登记一个包', () => {
  const loaders = SOURCE.match(/load:\s*\(\)\s*=>/g) ?? []
  assert.equal(loaders.length, 1, `装配点只能有一处 load 绑定，实测 ${loaders.length} 处`)
  assert.ok(/function installedPacks\(\)/.test(SOURCE), '装配点入口必须是具名的（唯一可点名包的地方）')
  const declared = SOURCE.match(/id:\s*'baymax'/g) ?? []
  assert.equal(declared.length, 2, 'baymax 的 id 只该出现两次：声明自报身份 + 装配点登记（多一处即有人偷偷点名包）')
})

test('导出面这条排除集是窄的：只放行标识符，命令前缀与线字段名一律照扫', () => {
  const wide = BLACKLIST.filter((p) => p.test(EXPORT_SURFACE)).filter((p) => !/baymax/i.test(String(p)))
  assert.deepEqual(wide.map(String), [], `导出面除包名外不得携带专有字面：${wide.map(String).join(', ')}`)
})
