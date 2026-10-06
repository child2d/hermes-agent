/**
 * W2 · the baymax pack + the single assembly point — SEMANTICS (semantic
 * equivalence, carrier swapped; 裁定 5).
 *
 * Design: docs/plankton/N7-technical-design/N7-20261006-plankton-session-packs.md
 * §8 (W2 = the old `packs.js` + `packs/baymax/declaration.js`, merged into the
 * `plankton-enterprise` plugin) with §6 (measured command surface) and N2 §0.1
 * (concept convergence: the plugin owns "what can be drawn / clicked", ONE skill
 * owns "the domain command surface / agent instructions / onboarding").
 *
 * These assertions port the SEMANTICS of the old shell's `baymax-pack.test.mjs`
 * and `pack-boundary.test.mjs` (read-only baseline ~/Repository/shaoke/codeup/
 * plankton @ e305ce1) onto the new carriers — NOT the old fenced-block payload
 * form (that carrier is the one EXCLUDED by measurement, N7 §0/§9.0 #1).
 *
 * The measured command surface below is taken from the frozen evidence
 * `docs/plankton/audits/audit-20261006-plankton-baymax-command-drift-probe.md`
 * (15 commands, drift 0 against the old fixture) — the declaration must not
 * drift from it.
 *
 * Every fixture here is synthetic metadata (CLI --help shape). No enterprise
 * data is read or written; nothing here touches a network, a credential or a
 * real home directory.
 *
 * Run (file, not directory — `node --test <dir>` fails to resolve):
 *   node --test apps/desktop/enterprise/plankton-enterprise/tests/pack-baymax.test.mjs
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN = path.resolve(HERE, '..', 'desktop', 'plugin.js')
const SKILL_FILE = path.resolve(HERE, '..', 'skills', 'baymax', 'SKILL.md')

/** Load the REAL plugin.js with bare imports rewritten to stubs (no SDK/react). */
async function loadPlugin(source = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plankton-baymax-w2-'))
  const sdk = path.join(dir, 'sdk.mjs')
  const react = path.join(dir, 'react.mjs')
  const jsxrt = path.join(dir, 'jsx-runtime.mjs')
  fs.writeFileSync(sdk, 'export const Button=()=>null;export const ConfirmDialog=()=>null;export const GlyphSpinner=()=>null;export const SearchField=()=>null;export const icons={Info:()=>null};\n')
  fs.writeFileSync(react, 'export const useEffect=()=>{};export const useState=v=>[v,()=>{}];\n')
  fs.writeFileSync(jsxrt, 'export const jsx=()=>null;export const jsxs=()=>null;\n')
  const raw = source ?? fs.readFileSync(PLUGIN, 'utf8')
  const src = raw
    .replace("'@hermes/plugin-sdk'", JSON.stringify(pathToFileURL(sdk).href))
    .replace('"@hermes/plugin-sdk"', JSON.stringify(pathToFileURL(sdk).href))
    .replace("'react/jsx-runtime'", JSON.stringify(pathToFileURL(jsxrt).href))
    .replace("from 'react'", `from ${JSON.stringify(pathToFileURL(react).href)}`)
  const out = path.join(dir, 'plugin.mjs')
  fs.writeFileSync(out, src)
  return import(pathToFileURL(out).href)
}

const M = await loadPlugin()
const D = M.BAYMAX_DECLARATION

/**
 * The measured command surface (audit-20261006-plankton-baymax-command-drift-probe):
 * 15 commands = 10 read / 5 write. `required` = what the CLI itself enforces.
 */
const SURFACE = {
  '+issue-create': { risk: 'write', required: ['--project-id', '--title'], flags: ['--project-id', '--title', '--description', '--type-id', '--status-id', '--priority-id', '--assignee-id', '--estimate-start', '--estimate-end', '--estimate-workload', '--label-ids', '--parent-id'] },
  '+issue-update': { risk: 'write', required: ['--project-id', '--id'], flags: ['--project-id', '--id', '--title', '--description', '--status-id', '--type-id', '--priority-id', '--assignee-id', '--estimate-start', '--estimate-end', '--estimate-workload', '--actual-workload', '--label-ids', '--parent-id'] },
  '+issue-comment': { risk: 'write', required: ['--issue-id', '--content'], flags: ['--issue-id', '--content'] },
  '+issue-link': { risk: 'write', required: [], flags: ['--project-id', '--issue-id', '--parent-id', '--type-id', '--related-issue-ids'] },
  '+relation-remove': { risk: 'write', required: ['--id'], flags: ['--id'] },
  '+issue-list': { risk: 'read', required: ['--project-id'], flags: ['--project-id', '--scene', '--status', '--assignee', '--label-ids', '--fields', '--offset', '--limit'] },
  '+issue-get': { risk: 'read', required: ['--project-id', '--id'], flags: ['--project-id', '--id'] },
  '+issue-history': { risk: 'read', required: ['--project-id', '--id'], flags: ['--project-id', '--id'] },
  '+relation-list': { risk: 'read', required: ['--issue-id'], flags: ['--issue-id'] },
  '+project-list': { risk: 'read', required: [], flags: ['--offset', '--limit'] },
  '+project-get': { risk: 'read', required: ['--project-id'], flags: ['--project-id'] },
  '+status-list': { risk: 'read', required: ['--project-id'], flags: ['--project-id'] },
  '+type-list': { risk: 'read', required: [], flags: ['--project-id'], defaults: { '--project-id': '1' } },
  '+user-list': { risk: 'read', required: [], flags: [] },
  '+whoami': { risk: 'read', required: [], flags: [] }
}

/** Flags this declaration adds on top of the CLI's own required set (fail-closed). */
const STRICTER_THAN_CLI = { '+issue-create': ['--type-id'], '+type-list': ['--project-id'] }

const allTemplates = D.templates

// ── the declaration loads, and the assembly point is what loads it ───────────

test('声明本身可装载：装载契约齐备，装配点装出来能拿到', () => {
  const verdict = M.validateDeclaration(D)
  assert.equal(verdict.ok, true, `${verdict.missing.join(',')} / ${verdict.invalid.join(',')}`)
  const { registry, results } = M.assemblePacks()
  assert.deepEqual(results, [{ ok: true, id: 'baymax', errors: [] }])
  assert.equal(registry.hasAnyWritePath(), true)
  assert.equal(registry.get('baymax').displayName, 'Baymax 工单')
  assert.equal(registry.contractItemCount(), 15, '装载契约仍为 15 项（规则随载体搬入插件注册点）')
})

test('1 · 命令面 15 条被完整交代：要么在用（13），要么显式排除（2）—— 不留没说法的空档', () => {
  const measured = Object.keys(SURFACE)
  assert.equal(measured.length, 15)
  assert.equal(measured.filter((c) => SURFACE[c].risk === 'write').length, 5, '实测写命令应为 5 条')
  const accounted = new Set([...M.BAYMAX_USED_COMMANDS, ...Object.keys(M.BAYMAX_EXCLUDED_COMMANDS)])
  assert.deepEqual(measured.filter((c) => !accounted.has(c)), [], '这些命令既没在用也没排除')
  assert.deepEqual([...accounted].filter((c) => !measured.includes(c)), [], '声明了实测命令面里没有的命令')
  assert.equal(M.BAYMAX_USED_COMMANDS.length, 13, '本期用 13 条')
  assert.deepEqual(Object.keys(M.BAYMAX_EXCLUDED_COMMANDS).sort(), ['+issue-link', '+relation-remove'])
  for (const cmd of Object.keys(M.BAYMAX_EXCLUDED_COMMANDS)) {
    assert.equal(SURFACE[cmd].risk, 'write')
    assert.ok(String(M.BAYMAX_EXCLUDED_COMMANDS[cmd]).length > 10, `${cmd} 的排除理由必须写清（不留给使用者踩）`)
  }
})

test('2 · 模板引用的命令真实存在；写模板只覆盖写命令、读模板只覆盖读命令；方向随实测', () => {
  for (const template of allTemplates) {
    assert.ok(SURFACE[template.command], `模板 ${template.id} 引用了实测面之外的命令 ${template.command}`)
    assert.equal(template.module, 'baymax')
    const expected = M.BAYMAX_WRITE_TEMPLATES.includes(template) ? 'write' : 'read'
    assert.equal(template.kind, expected, `${template.id} 的 kind 与读写归属不符`)
    assert.equal(SURFACE[template.command].risk, expected, `${template.id} 的读写方向与实测不符`)
    // 声明的 `surface`（给规范的方向表）也必须与实测一致
    assert.equal(D.surface[template.command], SURFACE[template.command].risk, `${template.command} 的方向表与实测不符`)
  }
  // 实测 15 条的方向表一条不少（未使用的两条也要登记方向）
  for (const [cmd, meta] of Object.entries(SURFACE)) assert.equal(D.surface[cmd], meta.risk, `surface 缺/错 ${cmd}`)
})

test('3 · 模板用到的每个参数都在实测 flag 列表里（手写参数名漂移即红）', () => {
  for (const template of allTemplates) {
    const flags = SURFACE[template.command].flags
    const used = []
    const walk = (items) => {
      for (const arg of items ?? []) {
        if (typeof arg === 'string') {
          if (arg.startsWith('--')) used.push(arg)
        } else if (arg && arg.when) walk(arg.args)
      }
    }
    walk(template.args)
    for (const flag of used) assert.ok(flags.includes(flag), `${template.id} 用了实测面里没有的 ${flag}`)
  }
})

test('4 · 必填与实测 required 对齐；多出来的必须是显式登记过的「比 CLI 更严」（且真被用到）', () => {
  for (const template of allTemplates) {
    const required = SURFACE[template.command].required.map((f) => f.replace(/^--/, '')).sort()
    const declared = [...template.required].sort()
    for (const flag of required) assert.ok(declared.includes(flag), `${template.id} 漏了实测必填 ${flag}`)
    for (const flag of declared) {
      if (!required.includes(flag)) {
        const stricter = STRICTER_THAN_CLI[template.command] ?? []
        assert.ok(stricter.includes(`--${flag}`), `${template.id} 把 ${flag} 声明成必填，但实测并非必填`)
        assert.ok(
          (D.requiredBeyondCli[template.command] ?? []).some((e) => e.flag === `--${flag}`),
          `${template.command} 的「更严」必须在 requiredBeyondCli 里登记`,
        )
      }
    }
  }
  for (const entry of Object.values(D.requiredBeyondCli)) {
    for (const item of entry) assert.ok(item.why && item.why.length > 0, '更严必填必须写明为什么')
  }
  assert.ok(D.requiredBeyondCli['+issue-create'].some((e) => e.flag === '--type-id'), 'type-id 是最贵的一条更严必填')
})

test('5 · CLI 默认值陷阱：type-list 说不清项目就必须拒，不许按默认项目 1 出类型', () => {
  assert.equal(SURFACE['+type-list'].defaults['--project-id'], '1', '实测默认值确实存在（这就是陷阱本身）')
  const template = allTemplates.find((t) => t.id === 'type-list')
  assert.deepEqual(template.required, ['project-id'], '声明必须把它变成必填，缺值由执行器拒')
  assert.ok(D.valueLookup['type-id'].note.includes('静默错域'), '陷阱要写进取值出口的说明里')
})

test('6 · 读侧形状逐条声明（对象本体／数组／分页对象），与实测一致', () => {
  const expected = {
    'list-issues': { shape: 'paged', itemsPath: 'data.data', totalPath: 'data.total' },
    'project-list': { shape: 'paged', itemsPath: 'data.data', totalPath: 'data.total' },
    'get-issue': { shape: 'object' },
    'project-get': { shape: 'object' },
    whoami: { shape: 'object' },
    'issue-history': { shape: 'array' },
    'relation-list': { shape: 'array' },
    'status-list': { shape: 'array' },
    'type-list': { shape: 'array' },
    'user-list': { shape: 'array' }
  }
  for (const [id, want] of Object.entries(expected)) {
    const template = allTemplates.find((t) => t.id === id)
    assert.ok(template, `声明里找不到读模板 ${id}`)
    assert.equal(template.shape, want.shape, `${id} 的形状声明与实测不符`)
    if (want.shape === 'paged') {
      assert.equal(template.itemsPath, want.itemsPath)
      assert.equal(template.totalPath, want.totalPath)
    }
  }
  assert.ok(D.outputParsing.paging.includes('双层 data') || D.outputParsing.paging.includes('data.data'), '双层 data 的语义要写进声明')
})

test('7 · 破坏性参数逐条给出依据；label-ids 的全量替换语义有实测出处', () => {
  for (const item of D.destructiveParams) assert.ok(item.evidence && item.evidence.length > 0, `${item.name} 缺依据`)
  const names = D.destructiveParams.map((d) => d.name)
  assert.deepEqual(names, ['label-ids', 'parent-id', 'status-id'])
  assert.ok(/full replacement/.test(D.destructiveParams.find((d) => d.name === 'label-ids').evidence))
  for (const name of names) assert.ok(D.fieldTiers[name] || name === 'parent-id', `${name} 未在字段分级里声明`)
})

test('8 · 字段分级覆盖所有会被写入的字段，且人类字段不得被标成 agent 可代笔', () => {
  const tiers = D.fieldTiers
  for (const f of ['assignee-id', 'estimate-start', 'estimate-end', 'estimate-workload', 'actual-workload']) {
    assert.equal(tiers[f], 'user-fact', `${f} 必须是本人给的事实`)
  }
  for (const f of ['status-id', 'type-id', 'priority-id', 'label-ids', 'parent-id', 'project-id', 'id', 'issue-id']) {
    assert.equal(tiers[f], 'user-designated', `${f} 必须由本人指定`)
  }
  for (const f of ['title', 'description', 'content']) assert.equal(tiers[f], 'agent-drafted', `${f} 属可代笔的措辞类`)
  for (const template of M.BAYMAX_WRITE_TEMPLATES) {
    for (const f of [...template.required, ...template.optional]) assert.ok(tiers[f], `模板 ${template.id} 的字段 ${f} 没有分级`)
  }
})

test('9 · 取值出口四类齐备；无字典出口的如实标缺口（不得当成「没声明」）', () => {
  const outlet = (key) => {
    const entry = D.valueLookup[key]
    if (!entry) return 'undeclared'
    if (entry.template) return 'template'
    if (entry.readback) return 'readback'
    if (entry.gap) return 'gap'
    if (entry.derived) return 'derived'
    return 'undeclared'
  }
  for (const key of ['project-id', 'status-id', 'type-id', 'assignee-id']) assert.equal(outlet(key), 'template', `${key} 有字典出口`)
  for (const key of ['priority-id', 'label-ids']) assert.equal(outlet(key), 'gap', `${key} 无字典出口，须显式标缺口`)
  assert.equal(outlet('parent-id'), 'derived')
  assert.equal(outlet('id'), 'readback')
  assert.equal(outlet('issue-id'), 'readback', 'id 与 issue-id 必须各自成条')
  for (const key of ['project-id', 'status-id', 'type-id']) assert.ok(D.valueLookup[key].labelField && D.valueLookup[key].valueField, `${key} 的出口要机器可读（取哪条模板、哪个是标签、哪个是值）`)
})

test('10 · 落树步骤与中间态：父→回读→子，父子只用 parent-id', () => {
  const steps = D.steps
  assert.equal(steps.length, 1)
  assert.deepEqual(steps[0].templateSequence, ['create-item', 'get-issue', 'create-item', 'add-comment'])
  assert.ok(steps[0].intermediate.includes('半成状态'))
  assert.ok(steps[0].intermediate.includes('不得整棵回滚'))
  assert.ok(String(D.outputParsing.noDelete ?? '').length > 0, '命令面无删除命令这条实测事实要写进声明')
})

test('11 · 标准输出声明：两块单条 + 一块集合；字段键与写模板的字段集合逐项对齐（漂移即红）', () => {
  const blocks = D.outputs.blocks
  assert.deepEqual(blocks.map((b) => [b.tag, b.record]), [
    ['plankton-baymax-new', 'single'],
    ['plankton-baymax-update', 'single'],
    ['plankton-baymax-plan', 'collection']
  ])
  for (const block of blocks) {
    for (const key of block.fields) assert.ok(D.outputs.fields[key], `${block.tag} 的 ${key} 没有语义声明`)
    for (const id of block.actions) assert.ok(D.outputs.actions[id], `${block.tag} 的动作 ${id} 没有声明`)
  }
  const create = M.BAYMAX_WRITE_TEMPLATES.find((t) => t.id === 'create-item')
  const update = M.BAYMAX_WRITE_TEMPLATES.find((t) => t.id === 'update-item')
  assert.deepEqual([...blocks.find((b) => b.tag === 'plankton-baymax-new').fields].sort(), [...create.required, ...create.optional].sort())
  assert.deepEqual([...blocks.find((b) => b.tag === 'plankton-baymax-update').fields].sort(), [...update.required, ...update.optional].sort())
  // 语义角色（宿主据此取标题/算统计，不据此排版）
  assert.equal(D.outputs.fields.title.role, 'title')
  assert.equal(D.outputs.fields.estimateEnd.role, 'due-date')
  // 没有「包给的统计」这回事
  assert.equal(blocks.some((b) => String(b.tag).includes('stats')), false)
})

test('12 · 版式越界即不可装载：整份声明过宿主扫（PLK-REQ-0033 的机器载体）', () => {
  // 正面：本包声明零命中（宿主只给画法，包只给数据）
  assert.deepEqual(M.findLayoutTokens(D), [], '声明里不得出现版式词汇')
  // 反面（控制组）：往「结构位」塞一个版式词，必须命中 — 否则这条判据是摆设
  const inject = (mutant) => M.findLayoutTokens({ ...D, ...mutant }).length
  assert.ok(inject({ outputs: { ...D.outputs, blocks: [{ tag: 'x', record: 'single', fields: ['title'], columns: ['title'] }] } }) > 0, '块内的版式键必须被扫到')
  assert.ok(inject({ extra: { primitive: 'table' } }) > 0, '非文案位的版式值必须被扫到')
})

// ── the one skill: agents' side, byte-locked to the committed file ───────────

test('13 · 「一份 skill」是**一份**：声明里的技能正文与仓内 skills/baymax/SKILL.md 逐字节相同', () => {
  const onDisk = fs.readFileSync(SKILL_FILE, 'utf8')
  assert.equal(D.skillDoc.fileName, 'SKILL.md')
  assert.ok(!D.skillDoc.fileName.includes('/') && !D.skillDoc.fileName.includes('\\'), 'fileName 须是单层文件名')
  assert.equal(D.skillDoc.path, 'skills/baymax/SKILL.md')
  assert.equal(D.skillDoc.markdown, onDisk, '声明内联的正文必须与仓内技能文件逐字节相同（同值锁）')
  assert.ok(D.skillDoc.markdown.trim().length > 0)
  assert.ok(onDisk.startsWith('---\n'), '技能文件带 frontmatter（引擎技能形态）')
  assert.match(onDisk, /^---\nname: baymax\n/, 'frontmatter 必须自报技能名')
})

test('14 · 技能承载三件事：域命令面 / agent 指令 / 接入 —— 且不含被排除的旧围栏载体', () => {
  const skill = D.skillDoc.markdown
  // (a) agent 指令：三条指令名与「不指定画法」的口径
  for (const name of D.outputs.blocks.map((b) => b.tag)) assert.ok(skill.includes(name), `技能必须交代指令名 ${name}`)
  assert.ok(skill.includes('指令') && skill.includes('画法'), '技能要说明「画法不归 agent 管」')
  assert.equal(skill.includes('```plankton-baymax'), false, '旧围栏载体已被实测排除，技能不得再教它')
  for (const forbidden of ['plan-table', 'plan-stats', 'new-item-card', 'update-item-card', '"slots"', '"primitive"']) {
    assert.equal(skill.includes(forbidden), false, `技能里不该出现 ${forbidden}（形态归宿主）`)
  }
  // (b) 域命令面：取值出口的实命令 + 实测纪律
  for (const cmd of ['+project-list', '+type-list', '+status-list', '+user-list', '+issue-list', '+issue-get']) {
    assert.ok(skill.includes(cmd), `技能必须给出取值命令 ${cmd}`)
  }
  assert.ok(skill.includes('退出码'), '技能要写清「判别式是信封 ok、退出码只是旁证」')
  assert.ok(/参数错＝`?2`?/.test(skill) && skill.includes('＝`1`'), '退出码 2/1/0 的三分要写清')
  assert.ok(skill.includes('typeId'), '技能要写清「类型没有人类可读名，只有 typeId」')
  assert.ok(skill.includes('空数组'), '技能要写清 relation-list 无关联返回空数组')
  assert.ok(skill.includes('不校验取值'), '技能要写清写命令 --dry-run 不校验取值')
  assert.ok(skill.includes('删除'), '技能要写清命令面无删除命令，只能关闭')
  // (c) 接入：接一个新域怎么接
  assert.ok(skill.includes('接一个新域'), '技能要含「接入」一节')
  assert.ok(skill.includes('装配点'), '接入要交代装配点唯一')
})

// ── 两个载体一件包（概念收敛的机器载体） ─────────────────────────────────────

test('15 · 桥接表与 15 项契约逐项对齐；两个载体不重不漏；carrierOf 是唯一读取口', () => {
  const keys = M.PACK_CONTRACT_ITEMS.map((i) => i.key)
  assert.deepEqual(Object.keys(M.PACK_CARRIERS).sort(), [...keys].sort(), '桥接表必须覆盖 15 项契约，逐项对齐')
  assert.equal(keys.length, 15)
  for (const key of keys) {
    assert.ok(['plugin', 'skill', 'boundary'].includes(M.PACK_CARRIERS[key]), `${key} 的载体归属必须是三值之一`)
    assert.equal(M.carrierOf(key), M.PACK_CARRIERS[key])
    assert.ok(key in D, `契约项 ${key} 必须在声明里存在`)
  }
  assert.equal(M.carrierOf('not-a-contract-item'), null, '未知键一律 null，不猜')
  // 归属与 N2 §0.1 的映射一致（逐条点名，防止悄悄搬家）
  assert.deepEqual(
    ['discriminant', 'failureMap', 'fieldTiers', 'destructiveParams', 'broadcastPredicate', 'landing'].map((k) => M.carrierOf(k)),
    Array(6).fill('plugin'),
  )
  assert.deepEqual(
    ['requiredParams', 'valueLookup', 'steps', 'lookupFields', 'outputParsing', 'templates', 'skill', 'skillDoc'].map((k) => M.carrierOf(k)),
    Array(8).fill('skill'),
  )
  assert.equal(M.carrierOf('outputs'), 'boundary', 'outputs 是交界：呈现面归插件、指令名归技能')
})

test('16 · 指令名由标准输出派生（两者不可能打架），且各带记录形态/字段键/动作', () => {
  const blockTags = D.outputs.blocks.map((b) => b.tag)
  assert.deepEqual(M.BAYMAX_INSTRUCTIONS.map((i) => i.name), blockTags)
  for (const instruction of M.BAYMAX_INSTRUCTIONS) {
    const block = D.outputs.blocks.find((b) => b.tag === instruction.name)
    assert.equal(instruction.record, block.record)
    assert.deepEqual([...instruction.fields], [...block.fields])
    assert.deepEqual([...instruction.actions], [...block.actions])
  }
})

test('17 · 失败码地板：进程可能已经跑过的三种形态只能落 write-unknown（不许降成可重试的失败）', () => {
  for (const kind of ['unparsed', 'timeout', 'spawn-error']) assert.equal(D.failureMap[kind], 'write-unknown')
  assert.equal(D.failureMap.refused, 'blocked', '没触达执行的形态留原态')
  assert.equal(D.failureMap.ok, 'written')
  for (const kind of M.PACK_EXEC_SCOPE.EXEC_KINDS) assert.ok(kind in D.failureMap, `failureMap 未覆盖执行结果形态 ${kind}`)
})

test('18 · 播报谓词：口径在包内，空集静默，逾期按计划结束早于今天判定', () => {
  assert.equal(D.broadcastPredicate({ items: [] }).hasContent, false)
  const withOverdue = D.broadcastPredicate({
    todayIso: '2026-10-06',
    items: [{ dueEnd: '2026-10-01', dueSoon: false }, { dueEnd: '2026-10-06', dueSoon: true }, { dueEnd: '' }]
  })
  assert.equal(withOverdue.hasContent, true)
  assert.deepEqual(withOverdue.detail, { overdue: 1, dueSoon: 1, missingDue: 1 })
  assert.equal(D.broadcastPredicate({ items: [{ dueEnd: '2026-12-31' }], todayIso: '2026-10-06' }).hasContent, false)
})
