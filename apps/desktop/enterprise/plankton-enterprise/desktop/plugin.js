/**
 * plankton-enterprise — the desktop half.
 *
 * Two pages, both served entirely through this plugin's own backend namespace
 * (``ctx.rest(...)`` → ``/api/plugins/plankton-enterprise/*``):
 *   * ``/plankton-tools``   — the read-only local ``shaoke-cli`` tool catalog.
 *   * ``/plankton-skills``  — the enterprise skill market.
 *
 * Delivered through the STANDALONE desktop-plugin door
 * (`<HERMES_HOME>/desktop-plugins/plankton-enterprise/plugin.js`), NOT the
 * unified-package half (`<HERMES_HOME>/plugins/<name>/desktop/plugin.js`).
 *
 * WHY STANDALONE: the unified-agent-package half is materialized by Electron
 * into the app root WITH a `.hermes-package.json` marker, and the runtime loader
 * caps a marked entry at `defaultEnabled: false` — "installed but inert". The
 * standalone door has no marker, so it is default-ON and loads on the very first
 * launch. See PLANKTON-MIGRATION-BATCH2.md (card point 1).
 *
 * SKILL MARKET — what this page guarantees (batch 2 step 2):
 *   * The catalog source is the enterprise `shaoke-cli skillhub +list`; there is
 *     no direct platform call.
 *   * Five failure classes are INDEPENDENTLY visible — ``unauthorized`` /
 *     ``network-failed`` / ``not-json`` / ``shape-mismatch`` / ``hashState:
 *     mismatch`` — never silently rendered as "no skills".
 *   * EVERY write (install / update / uninstall / enable / disable / batch
 *     update) goes through an explicit human confirmation dialog; a batch update
 *     is never silent.
 *   * "停用" is the ENGINE's own enable state (``config.yaml`` →
 *     ``skills.disabled``) — this app keeps no second copy.
 *   * Storage belongs to the ENGINE: install / update / uninstall are handed to
 *     the engine's own skill-management entry points in-process. This app
 *     computes no landing, removes no directory and keeps no ledger; the
 *     install records the page shows are the engine's own ``skills/.hub/lock.json``.
 *   * No credential is read: the backend runs credential-free CLI commands and
 *     never touches ``~/.shaoke/tokens.json``.
 *
 * Plain ESM + `jsx()` calls — exactly the shape the runtime loader evaluates.
 */

import { Button, ConfirmDialog, GlyphSpinner, SearchField, icons } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

// ─────────────────────────────────────────────────────────────────────────────
// W1 · pure-logic layer (migrated verbatim from the old shell; carrier-neutral)
//
// Source of record (read-only baseline): ~/Repository/shaoke/codeup/plankton
// @ e305ce1 — electron/{render-protocol,presentation,read-side,plan-card,
// pack-registry,pack-session}.js.  Migration design: N7-20261006-plankton-
// session-packs §8 (W1) — "语义等价、换载体".
//
// WHY ONE FILE: the runtime plugin loader evaluates plugin.js as a blob
// (src/contrib/runtime-loader.ts:398) and a relative specifier "cannot resolve
// against the blob" (:335). So the six modules live here as six IIFE scopes —
// the same boundaries as the originals, minus one entry each. Nothing here has
// I/O, a subprocess or a credential read; every section is pure.
//
// ONE DELIBERATE OMISSION: render-protocol's `parseCarrierBlocks` (the fenced
// ```<tag>{json}``` adapter) is NOT carried. That carrier is the one the
// design already EXCLUDED by measurement (N7 §0 / §9.0 #1: fenced blocks are
// passthrough in the new host, and the old tag names fail the 16-char language
// limit). The carrier entry is W4's rewrite (directive components + reference
// payload, N7 §8) — this layer stays carrier-neutral and consumes a payload it
// has already been handed.
//
// SAME-VALUE LOCK · PRE-W3 REGISTRATION (recorded here and ONLY here):
// pack-exec itself is W3, so its EXEC_KINDS list is inlined below. Its value is
// byte-identical to the old shell's `desktop/electron/pack-exec.js:35`. BEFORE
// W3 lands this inline copy MUST be deleted and the constant MUST be sourced
// from the re-homed pack-exec module — never keep two copies drifting abreast.
// (Deliberately NOT restated in N7 §8: one registration, not two.)
// ─────────────────────────────────────────────────────────────────────────────

// 同值锁 · W3 前必须改为从模块取（口径源＝旧壳 desktop/electron/pack-exec.js:35；此处冻结同值）
const PACK_EXEC_SCOPE = Object.freeze({
  EXEC_KINDS: Object.freeze(['ok', 'rejected', 'unparsed', 'timeout', 'spawn-error', 'refused'])
})

// ── render-protocol.js ──────────────────────────────────────────────────────────────────
const renderProtocol = (function () {
// electron/render-protocol.js — **载荷校验协议**（宿主侧机制，载体中立）。
//
// 口径（2026-09-30 呈现归属修订，N7 §12／N2 PLK-REQ-0036 判定面 4）：**包给数据，宿主给画法**。
// 本模块只做三件事：
//   ① 把**载荷**按**包声明的标准输出**校验（块名认不认、记录形态对不对、字段键声不声明过）；
//   ② 产出一份**数据**（记录 + 声明过的字段键 + 该块可用的动作）—— **不含任何形态字段**；
//   ③ 解析**动作**（点确认＝人放行写路径／撤销＝丢草稿／推进＝改状态），动作必须绑定到包里真实存在的模板。
//
// 硬约束：
//   - **形态不在这里**：用哪个原语、排序分组、算什么统计 ⇒ `presentation.js`（宿主呈现规则）；
//     字段**集合**来自包声明（字段键白名单），本模块只做校验、不做取舍。
//     本模块的返回里没有「画成什么」这回事，宿主因此不可能从声明里读形态。
//   - **原语是封闭集合**（`RENDER_PRIMITIVES`）：载荷不能要求宿主渲染任意东西、更不能塞 HTML；
//     加一种原语必须显式改宿主并补边界用例。原语由宿主选择，**不由声明选择**。
//   - **校验不过一律退回原文显示**（fail-open 为文本是安全的：人还能看到内容，不会被静默吞掉），
//     绝不「猜着渲染」。
//   - **载体中立**：载荷经入口适配器变成对象后喂同一个 `resolveOutput`（新载体＝插件指令组件
//     + 引用式载荷，入口适配属 W4，本模块不含任何具体载体）。换载体只换入口，不改协议。
//
// 纯逻辑：无 I/O、无子进程、不渲染 HTML（单测：`tests/render-protocol.test.mjs`）。

/** 渲染原语：宿主能画的就这些（**宿主侧封闭集合，不由声明选择**）。加一种＝改宿主（并补边界用例）。 */
const RENDER_PRIMITIVES = Object.freeze(['card', 'key-value', 'table', 'stat-bar', 'timeline'])

/** 记录形态：宿主能校验的就这两种（声明里必须二选一）。 */
const OUTPUT_RECORD_KINDS = Object.freeze(['single', 'collection'])

/** 载荷的**顶层键**白名单：载荷只能给数据与动作 —— 多一个键就是不认识的东西，一律拒（宁缺勿猜）。 */
const PAYLOAD_KEYS = Object.freeze(['block', 'record', 'records', 'actions', 'key'])

/**
 * 记录里一个字段条目的**键**白名单（`{value, quote, lookup}`）：多一个键就拒。
 *
 * `label` **不在名单里**（2026-09-30 复核 F5）：字段标签（卡片上人看到的那行字、表头文案）
 * 只能来自**声明**的字段语义 —— 载荷说了不算，否则 agent 能把「计划结束」改写成「随便写写」。
 */
const ENTRY_KEYS = Object.freeze(['value', 'quote', 'lookup'])

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0
const asArray = (v) => (Array.isArray(v) ? v : [])

const refuseOutput = (reason, detail) =>
  Object.freeze({ ok: false, reason, detail: detail ?? null, fallback: 'raw-text' })

/** 标准输出声明：块（块名／记录形态／字段键／动作）+ 字段语义 + 动作 → 绑定的模板。 */
function readOutputs(declaration) {
  const outputs = isPlainObject(declaration?.outputs) ? declaration.outputs : {}
  return {
    blocks: asArray(outputs.blocks).filter(isPlainObject),
    fields: isPlainObject(outputs.fields) ? outputs.fields : {},
    actions: isPlainObject(outputs.actions) ? outputs.actions : {},
  }
}

/** 声明里的字段语义 → 呈现/下游用得上的最小形态（**不含版式**：只有标签、角色、必填）。 */
function declaredFieldList(keys, fields) {
  return keys.map((key) => {
    const meta = isPlainObject(fields[key]) ? fields[key] : {}
    return Object.freeze({
      key,
      label: String(meta.label ?? key),
      role: String(meta.role ?? ''),
      required: meta.required === true,
      meaning: String(meta.meaning ?? ''),
    })
  })
}

/** 值一律收口成**文本**：`null`/`undefined` ⇒ 空串，其余 `String(v)` */
const textOf = (v) => (v === null || v === undefined ? '' : String(v))

/**
 * 一个字段条目的值 → 统一的 `{value, quote, lookup, label}`（对象＝条目，其余＝裸值）。
 * **值出来一定是文本**（`textOf`）：数字/布尔在这里收口，对象/数组已在调用方拒掉。
 *
 * `label` **只取声明**（`meta.label`）：载荷侧已无 `label` 通路（`ENTRY_KEYS`），于是
 * 「卡片/表头上那行字」不可能被载荷改写（2026-09-30 复核 F5）。
 */
function normalizeEntry(key, raw, meta) {
  const label = String(meta?.label ?? key)
  if (!isPlainObject(raw)) return { key, label, value: textOf(raw), quote: '', lookup: null }
  return {
    key,
    label,
    value: textOf(raw.value),
    quote: typeof raw.quote === 'string' ? raw.quote : '',
    lookup: isPlainObject(raw.lookup) ? raw.lookup : null,
  }
}

/**
 * 取值的**可达形态**（2026-09-30 复核 F11 的收口 + R2-4／R3-P3-2 的显式取舍）。
 *
 * 判据是「收口成文本有没有损失」，**但损失是与载荷里的那个值比、不是与模型写下的字面比** ——
 * `JSON.parse` 已经把字面改掉了，所以对**字面**而言 `String()` 并不无损：
 * `1.10→"1.1"`、`-0→"0"`、`1e21→"1e+21"`、`12345678901234567890→"…67000"`、`1e400→"Infinity"`。
 * 于是数字只收**可精确表示**的那一档（复核 R3-P3-2 的建议闭合条件，可机械重算）：
 *   · `Number.isSafeInteger(v)` 且不是 `-0`：照收（`1`、`2`、`-3` —— 模型最可能吐出的 id 形态）；
 *   · 其余数字（小数、超 2^53 的整数、`±Infinity`、`NaN`、`-0`）：`String()` 与**字面**不同形
 *     或已在 `JSON.parse` 里被改值 ⇒ 拒（`field-value-malformed`，退回原文显示，内容不丢）；
 *   · `string`／`boolean`：无此问题（`String(true)==='true'`），照收；
 *   · `null`／`undefined`：空值，照收（留空＝还没有这个事实）；
 *   · **对象／数组**：进卡片与 argv 会变成 `[object Object]`／`a,b` —— 一律拒。
 * 三层（协议／会话／执行器）共用**本函数**作为唯一口径（执行器按正面白名单判，见 `pack-exec.js`）。
 * 于是 `presentation.js` 里「单元格一律 `String(value)`」与这里同口径：到达呈现层的值已是文本。
 */
const isLosslessValue = (v) =>
  v === null ||
  v === undefined ||
  typeof v === 'string' ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0))

/**
 * 把载荷校验成**数据**。
 *
 * 载荷形如：
 *   · 单条：`{ "record": { "<字段键>": 值 или {value,quote?,lookup?} }, "actions": [id, ...] }`
 *   · 集合：`{ "records": [ { "<字段键>": 值, ... }, ... ], "actions": [id, ...] }`
 * 它**只能**带来声明过的内容：块名、记录形态、字段键、动作，四层都不认就退回原文显示。
 * 返回值只有数据（记录 + 声明过的字段键 + 该块可用的动作），**没有形态字段**。
 */
function resolveOutput(pack, payload) {
  if (!pack) return refuseOutput('pack-not-loaded')
  const { blocks, fields, actions } = readOutputs(pack.declaration)
  if (!isPlainObject(payload)) return refuseOutput('malformed-payload')

  const extraKeys = Object.keys(payload).filter((key) => !PAYLOAD_KEYS.includes(key))
  if (extraKeys.length) return refuseOutput('payload-key-not-declared', extraKeys)

  const blockTag = String(payload.block ?? '')
  const block = blocks.find((entry) => String(entry.tag) === blockTag)
  if (!block) return refuseOutput('block-not-declared', blockTag)

  const record = String(block.record ?? '')
  if (!OUTPUT_RECORD_KINDS.includes(record)) return refuseOutput('record-kind-not-declared', record)

  const declaredKeys = asArray(block.fields).map(String)
  if (!declaredKeys.length) return refuseOutput('block-declares-no-fields', blockTag)

  // 记录形态与载荷要对得上：单条 ⇒ 给一条记录；集合 ⇒ 给记录数组。给错了就是两回事，不互相迁就。
  let rawRecords = []
  if (record === 'single') {
    if (!isPlainObject(payload.record)) return refuseOutput('record-shape-mismatch', payload.record === undefined ? 'record-missing' : 'not-an-object')
    if (payload.records !== undefined) return refuseOutput('record-shape-mismatch', 'records-not-allowed-for-single')
    rawRecords = [payload.record]
  } else {
    if (!Array.isArray(payload.records)) return refuseOutput('records-shape-mismatch', payload.records === undefined ? 'records-missing' : 'not-an-array')
    if (payload.record !== undefined) return refuseOutput('records-shape-mismatch', 'record-not-allowed-for-collection')
    rawRecords = payload.records
  }

  const declaredFields = declaredFieldList(declaredKeys, fields)
  const normalized = []
  for (const raw of rawRecords) {
    if (!isPlainObject(raw)) return refuseOutput('record-malformed')
    // 载荷里的字段键必须在声明里 —— 多一个不认识就整份不渲染（宁缺勿猜）
    const unknown = Object.keys(raw).filter((key) => !declaredKeys.includes(key))
    if (unknown.length) return refuseOutput('field-not-declared', unknown)
    const entries = []
    for (const key of declaredKeys) {
      if (!Object.hasOwn(raw, key)) continue
      const rawValue = raw[key]
      if (isPlainObject(rawValue)) {
        const unknownEntryKeys = Object.keys(rawValue).filter((k) => !ENTRY_KEYS.includes(k))
        if (unknownEntryKeys.length) return refuseOutput('entry-key-not-declared', unknownEntryKeys)
      }
      const value = isPlainObject(rawValue) ? rawValue.value : rawValue
      // 取值形态收口（复核 F11 的收口 + R2-4／R3-P3-2 的取舍）：对象／数组会变形 ⇒ 拒；
      // 数字只收可精确表示的那一档（安全整数、非 -0），其余数字与 `String()` 与字面不同形 ⇒ 拒；
      // 字符串／布尔无此问题 ⇒ 照收（`normalizeEntry` 那里收口成文本）
      if (!isLosslessValue(value)) return refuseOutput('field-value-malformed', { key, valueType: Array.isArray(value) ? 'array' : typeof value })
      entries.push(Object.freeze({ ...normalizeEntry(key, rawValue, fields[key]), role: declaredFields.find((f) => f.key === key)?.role ?? '', required: declaredFields.find((f) => f.key === key)?.required === true, declared: true }))
    }
    normalized.push(Object.freeze({ key: String(payload.key ?? ''), fields: Object.freeze(entries) }))
  }

  const declaredActions = asArray(block.actions).map(String)
  const requested = asArray(payload.actions).map(String)
  const unknownActions = requested.filter((id) => !declaredActions.includes(id))
  if (unknownActions.length) return refuseOutput('action-not-declared', unknownActions)

  return Object.freeze({
    ok: true,
    output: Object.freeze({
      block: blockTag,
      record,
      declaredFields: Object.freeze(declaredFields),
      records: Object.freeze(normalized),
      actions: Object.freeze(
        requested.map((id) => {
          const action = actions[id] ?? {}
          return Object.freeze({
            id,
            label: String(action.label ?? id),
            human: String(action.human ?? ''),
            writes: String(action.writes ?? ''),
            reads: String(action.reads ?? ''),
            destructive: action.destructive === true,
          })
        }),
      ),
    }),
  })
}

/**
 * 解析动作：动作必须绑定到**包声明里真实存在的模板**，且必须说明它是哪种「人在环」动作。
 * 不满足就拒绝执行 —— 点一个按钮就能写的前提，是这个按钮在声明里点过名。
 */
function resolveAction(pack, actionId) {
  if (!pack) return Object.freeze({ ok: false, reason: 'pack-not-loaded' })
  const { actions } = readOutputs(pack.declaration)
  const action = actions[String(actionId ?? '')]
  if (!isPlainObject(action)) return Object.freeze({ ok: false, reason: 'action-not-declared' })
  const human = String(action.human ?? '')
  if (!['confirm', 'discard', 'progress'].includes(human)) {
    return Object.freeze({ ok: false, reason: 'action-human-mode-invalid', detail: human })
  }
  if (human === 'confirm') {
    const templates = asArray(pack.declaration?.templates).map((t) => t?.id)
    if (!nonEmptyString(action.writes) || !templates.includes(String(action.writes))) {
      return Object.freeze({ ok: false, reason: 'action-write-template-missing', detail: String(action.writes ?? '') })
    }
  }
  // 「推进」类动作有两种：带写模板的（改状态，等同一次写）与只读的（刷新，必须声明读哪条模板）。
  // 两者都要求绑定存在 —— 声明里没写清「这个按钮到底做什么」的，一律不给按钮。
  if (human === 'progress') {
    const templates = asArray(pack.declaration?.templates).map((t) => t?.id)
    if (nonEmptyString(action.writes) && !templates.includes(String(action.writes))) {
      return Object.freeze({ ok: false, reason: 'action-write-template-missing', detail: String(action.writes) })
    }
    if (!nonEmptyString(action.writes) && !nonEmptyString(action.reads)) {
      return Object.freeze({ ok: false, reason: 'action-binds-nothing' })
    }
    if (nonEmptyString(action.reads) && !templates.includes(String(action.reads))) {
      return Object.freeze({ ok: false, reason: 'action-read-template-missing', detail: String(action.reads) })
    }
  }
  return Object.freeze({
    ok: true,
    action: Object.freeze({
      id: String(actionId),
      label: String(action.label ?? actionId),
      human,
      writes: String(action.writes ?? ''),
      reads: String(action.reads ?? ''),
      destructive: action.destructive === true,
    }),
  })
}

return Object.freeze({
  RENDER_PRIMITIVES,
  OUTPUT_RECORD_KINDS,
  PAYLOAD_KEYS,
  ENTRY_KEYS,
  readOutputs,
  isLosslessValue,
  resolveOutput,
  resolveAction,

})
})()

const {
  RENDER_PRIMITIVES,
  OUTPUT_RECORD_KINDS,
  PAYLOAD_KEYS,
  ENTRY_KEYS,
  readOutputs,
  isLosslessValue,
  resolveOutput,
  resolveAction
} = renderProtocol

// ── presentation.js ──────────────────────────────────────────────────────────────────
const presentation = (function () {
// electron/presentation.js — 宿主侧的**呈现规则**（纯逻辑、可单测、注入数据、无 I/O）。
//
// 分工（spec-library `docs/plankton/N7-20260930-plankton-baymax-chat-native.md` §12）：
//   **包给数据，宿主给画法**。包声明的是**标准输出**（块名、记录形态、记录本身、字段键、动作）
//   与**字段语义**（label／role／meaning）。分工按「实际边界」写清（2026-09-30 复核 R2-9，
//   此前的注释把**字段面**也划给了宿主，而实做只做到排序，字段集合仍随声明）：
//     · **字段集合＝数据构成**：由包声明的字段键白名单决定（本模块拿到的是已校验的 declaredFields）；
//     · **排序与分组＝宿主规则**：`hostFieldOrder` 按语义角色秩 + 字段键稳定序排，
//       **声明的数组顺序不作排序依据**；
//     · **用哪个原语、算什么统计、按什么口径**全部归本模块。
//
// 硬约束：
//   - **本模块没有声明可读**：入参只有已校验的**标准输出**（`render-protocol.js` 的产物）。
//     「宿主从包声明读形态」因此在结构上不可能 —— 声明里塞多少版式，这里的结果都一样。
//   - `RENDER_PRIMITIVES`（封闭原语集）仍归宿主；包的声明里出现原语名或版式槽位即判装载失败
//     （`findLayoutTokens`，由宿主装载校验在装载期调用）。
//   - 统计**只从同一份标准输出算**（不另起取数、不另立口径）。
//
// v1 规则（确定性、可单测）：
//   · `record: 'single'`     → 卡片（卡片的字段分级与佐证在 `pack-session.js`；这里只出标题）
//   - `record: 'collection'` → 表格 + **宿主自算**的统计条
//
// 统计口径（N7 §1）：待办＝记录条数；已逾期＝到期日早于今天；今日截止＝到期时刻落在
// `[now, now+24h)` 窗口内（服务端那个场景的语义是 24 小时窗口而非自然日 ⇒ 呈现**注明口径**）；
// 缺到期日的记录如实计入「无截止日期」，不静默丢弃。
// 边界如实声明：到期时刻**早于 now 但到期日仍是今天**的记录既不算逾期（口径是「早于今天」）
// 也不在 24 小时窗口内 —— 这是「早于今天」这条口径的固有边界，不在此处自行放宽。

const { RENDER_PRIMITIVES } = renderProtocol
/** 记录里字段的**语义角色**（包声明 → 宿主据此取数/取舍；角色不是版式，版式只由本模块选） */
const FIELD_ROLES = Object.freeze({
  /** 这条记录叫什么（卡片标题取它） */
  TITLE: 'title',
  /** 到期日（统计口径用；宿主不认识任何具体字段名，只认角色） */
  DUE_DATE: 'due-date',
})

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * **列的顺序归宿主**（N7 §12.1／N2 PLK-REQ-0037 第 14 项；2026-09-30 复核 F3／R2-9）。
 *
 * 口径按**实现边界**写清（复核 R2-9：此前的注释把字段面与排序都说成宿主的，
 * 而实做只有排序这一半）：
 *   · **字段集合＝数据构成**：由包声明的 `fields` 白名单决定（本模块拿到的是已校验的
 *     `declaredFields`，不自己挑列，也不自己补列）；
 *   · **排序与分组＝宿主规则**（本函数）：声明的 `fields` 数组顺序**不作排序依据**：
 *       ① 先按**角色秩**排 —— 标题（`role: 'title'`）第一列、到期日（`role: 'due-date'`）末列；
 *       ② 同秩内按**字段键的稳定序**（宿主自己的确定序，与声明的数组顺序无关）；
 *       ③ 无角色的字段照显示，但不会因为「声明里写在前面」就前移。
 *   · `label` 是**字段语义**（数据面）⇒ 拿它当表头文案，不是宿主另起一套文案。
 * 于是把声明的 `fields` 逆序，表头一字不变（`tests/round1-closure-regressions.test.mjs` 钉住了这条）。
 */
const ROLE_RANK = Object.freeze({ [FIELD_ROLES.TITLE]: 0, [FIELD_ROLES.DUE_DATE]: 2 })
const DEFAULT_ROLE_RANK = 1

function hostFieldOrder(declaredFields) {
  const rankOf = (field) => {
    const role = String(field?.role ?? '')
    return Object.hasOwn(ROLE_RANK, role) ? ROLE_RANK[role] : DEFAULT_ROLE_RANK
  }
  return declaredFields
    .map((field, index) => ({ field, index }))
    .sort((a, b) => {
      const byRank = rankOf(a.field) - rankOf(b.field)
      if (byRank !== 0) return byRank
      const left = String(a.field?.key ?? '')
      const right = String(b.field?.key ?? '')
      if (left !== right) return left < right ? -1 : 1
      return a.index - b.index
    })
    .map((entry) => entry.field)
}

/**
 * 归一化（2026-09-30 复核整改 F8；措辞按实做收口，复核 R3-P3-5）：
 * **小写 + 去掉空白、下划线、ASCII 连字符**（正则就是 `[\s_-]`）。
 * `Card`／`stat bar`／`stat_bar`／`stat-bar` 归一后是同一串 —— 大小写与这三种分隔符不构成逃逸口。
 *
 * **射程就此为止**（别再按「去一切分隔符」读这条判据）：**Unicode 破折号族不算分隔符** ——
 * `–`（U+2013 EN DASH）、`—`（U+2014 EM DASH）等不在字符类里，于是 `stat–bar` 整值比对不命中、
 * 整包可装载。方向是 fail-open（少判一次版式词，不误伤），如实记在案，不在这里擅自放宽或收紧。
 *
 * **比对用「相等」而不是「包含」**（复核 R2-5：这条是实测口径，不是 fail-closed 口号）：
 * 归一后**整值相等**才判红 —— `{layout:'请画成 stat bar'}`（多一个字）**不红**、装载通过。
 * 之所以不用包含：归一后 `discard` 里含 `card`，用包含判定会把 `{label:'discard'}`
 * 这类合法字样也判成版式（假阳）。**唯一的例外是形状 id**（见 `SHAPE_ID`）：它没有
 * `norms`，退回 `pattern` 正则，于是 `用 new-item-card 画` 这种长串里的形状 id 照样红。
 */
const normalizeToken = (text) => String(text).toLowerCase().replace(/[\s_-]+/g, '')

/**
 * 版式词汇表：**宿主原语名 + 版式槽位名 + 形状 id 词素**。
 *
 * 用途只有一个：判「包声明里有没有在指挥宿主怎么画」。声明里出现任一即判装载失败
 * （N7 §12.2 判据一／N2 PLK-REQ-0036 判定面 4）。
 *
 * **判据的实射程（复核 R2-5，与实做同射程，不是口号）**：值按**归一化后整值相等**比对 ——
 * 「在值里多写一个字」即可逃逸（`'请画成 stat bar'` ⇒ hits=0 ⇒ 装载通过）。这不是漏判，
 * 是这条判据的实际边界，写在这里以免下一轮再按注释里的「fail-closed」去高估它。
 *
 * 每条两个判法：
 *   · `pattern`：**源码行**上的正则（`pack-output-boundary.test.mjs` 的判据一文本扫用），
 *     也在归一化对不上的位置（如形状 id）当兜底判法。它只防误改，不是装载闸门；
 *   · `norms`：**对象形态**归一后的相等词（装载闸门用）。`shape-id` 没有 `norms` —— 形状 id 是
 *     「词素 + ASCII 分隔符（`.`／`_`／`-`） + 形状后缀」，归一掉这几个分隔符之后词素粘成一串，
 *     就认不出来了（与 `normalizeToken` 的字符类同射程：Unicode 破折号不算）。
 */
const SHAPE_SUFFIXES = Object.freeze(['card', 'table', 'stats', 'bar', 'timeline'])
const SHAPE_ID = Object.freeze({
  id: 'shape-id',
  // 形状 id（`new-item-card` / `plan-table` / `plan-stats` 这一族的写法）：
  // 必须有分隔符（`.`／`_`／`-`）把词素与形状后缀连起来 —— 于是 `toolbar` 不会被误判
  pattern: new RegExp(`[a-z0-9][a-z0-9._-]*[-_.](${SHAPE_SUFFIXES.join('|')})\\b`, 'i'),
})

/**
 * 版式词素清单：`RENDER_PRIMITIVES` 各原语名 + 各槽位名 + 形状 id。形状 id 一项**没有 `norms`**
 * （只按 `pattern` 判），故类型里两个字段都标可选 —— 两处消费点各自「先看 `norms`、否则回退 `pattern`」。
 *
 * @type {ReadonlyArray<{ id: string, pattern?: RegExp, norms?: readonly string[] }>}
 */
const LAYOUT_TOKENS = Object.freeze([
  ...RENDER_PRIMITIVES.map((name) =>
    Object.freeze({
      id: `primitive:${name}`,
      pattern: new RegExp(`\\b${name.replace(/-/g, '\\-')}\\b`, 'i'),
      norms: Object.freeze([normalizeToken(name)]),
    }),
  ),
  Object.freeze({ id: 'slot-key:primitive', pattern: /\bprimitive\b/i, norms: Object.freeze(['primitive']) }),
  Object.freeze({ id: 'slot-key:slots', pattern: /\bslots?\b/i, norms: Object.freeze(['slot', 'slots']) }),
  Object.freeze({ id: 'slot-key:views', pattern: /\bviews?\b/i, norms: Object.freeze(['view', 'views']) }),
  // 表格类版式的槽位名（旧声明里就是这么长的：列与行由包给）
  Object.freeze({ id: 'slot-key:columns', pattern: /\bcolumns\b/i, norms: Object.freeze(['columns']) }),
  Object.freeze({ id: 'slot-key:rows', pattern: /\brows\b/i, norms: Object.freeze(['rows']) }),
  SHAPE_ID,
])

/**
 * **人类可读的文案位**：这些键下面的字符串是人读的话术（字段标签、含义、注、技能正文、判别式），
 * 不当作结构位扫。
 *
 * 但**块声明里没有文案位**：契约里 `outputs.blocks[*]` 的键只有 `tag`/`record`/`fields`/`actions`，
 * 块里多出来的键就是结构位（复核件 a1 的逃逸写法正是往 `blocks[0].note` 里塞版式词）——
 * 因此块内的文案键照样扫。
 *
 * 为什么可以放（不构成放行口，写进注释以防被当成漏洞）：
 *   · 运行时对**未知块名**与**未声明载荷键**一律拒（`render-protocol.js`），文案层写什么都进不了载荷；
 *   · 呈现层入参里**根本没有声明**（`presentOutput` 只吃校验过的标准输出），文案层写什么宿主都不会照着画；
 *   · 判据一的正文本扫（`pack-output-boundary.test.mjs`）仍然扫包侧**全部源码行**，
 *     版式字样写在 markdown 里也照样红。
 * 反过来，不排除它们就会把一次无害的措辞（"the ledger card"）判成整包不可装载（复核 F7 的假阳面）。
 */
const PROSE_KEYS = Object.freeze(['label', 'meaning', 'note', 'markdown', 'discriminant'])
/**
 * 块声明的**路径段**：块里的文案键不算文案位（块只声明结构）。
 * 用路径段而不是拼接好的字符串，是为了让本文件里不出现「读声明」的样子。
 *
 * **源码级锁的实射程（round-5 复核后重述；判据落在 `tests/pack-source-locks.test.mjs`）**：
 *   · **柱一 · 导入面（按可达性，不按白名单枚举）**：解析本模块的依赖闭包（模块身份），链到的
 *     任何模块只要**能看到包声明**（声明本体、包注册表、`packs/` 整棵树…）即红；同仓**无害**模块与
 *     node 内置**允许**（旧版按白名单枚举会把无害重构误判成违规 —— 复核 round-5 P3-2）。
 *   · **柱二 · 可达通道免疫（承重）**：`presentOutput` 能看到的只有那份标准输出对象，往它上面注入
 *     **任意键名**的深层垃圾（版式词／随机名／中文键名／嵌套对象数组），输出必须逐字节不变；读了
 *     其中任何一个键就分叉变红。**正控**：把 `presentOutput` 改成读任一注入键，该用例必红（实测：
 *     读 `output.layout` → 2 红、读 `output.__junk` → 1 红、读中文键 → 1 红）。
 *   · **残余（刻意不追，Authority 2026-10-01 裁定）**：`eval`／`globalThis`／动态 `import()`／惰性
 *     `require`／别名 require 这类**存心绕过**不在射程内 —— 锁拦的是「无意引入」，不防恶意绕过；
 *     这些形态已登记为残余（KI-PLANKTON-0056），**不再**当缺陷追。
 *   · 明文不算违规：人类可读文案（`label`／`note`／技能正文）的**内容**不判（见上）；判据只认
 *     **结构性位置**。
 * 边界：射程是**呈现主路径**（`presentOutput`）。本文件另有 `findLayoutTokens` 要对包声明做版式词
 * 扫描 —— 读声明是那个函数的职责，不在锁内。
 */
const BLOCK_SEGMENTS = Object.freeze(['declaration', 'outputs', 'blocks'])
const insideBlocks = (segments) => BLOCK_SEGMENTS.every((segment, index) => segments[index] === segment)

/**
 * 扫一份包声明里的版式词汇（N7 §12.2 判据一／N2 PLK-REQ-0036 判定面 4）。
 *
 * 扫法（2026-09-30 复核整改 F7／F8）：
 *   · **深走**：所有键、所有值，含数组元素、嵌套对象；非字符串值按 `String(v)` 收口
 *     （于是 `{'画法': true}` 也进比对，而不是「只比字符串」）；
 *   · **归一化后整值相等**：`{primitive:'Card'}`／`{'表明':'TABLE'}`／`{'布局':'Stat-Bar'}` 都命中；
 *     **但含于长串不命中**（`'请画成 stat bar'` 逃逸 —— 这是实射程，见 `LAYOUT_TOKENS` 的注释；
 *     形状 id 例外，走 `pattern` 兜底）；
 *   · **只扫结构性位置**：**键名一律扫**（命中版式键即违规）；**值只在非文案位上扫**。
 *     文案位的清单就是 `PROSE_KEYS` 那五个键名（复核 P3-3：这是**键名白名单，不是结构位判定** ——
 *     别的散文键（下一个包写 `summary`／`hint`…）的**键名**照样一律扫，命中即整包失载；
 *     它的**值**也进扫描，但同样只按「归一化后整值相等」判（复核 R2-5：`summary: 'card'` 命中、
 *     `summary: '把结果显示成 card 那样'` 逃逸）—— 别把这里读成「出现版式词就失载」。
 *     方向的代价是运营面的一次**整值**措辞能打掉整个包（夹在句子里的不会）；清单在这里写全，便于核对）。
 * 函数（如播报谓词）不看源码：它就是包自己的流程口径，属数据面。
 */
function findLayoutTokens(declaration) {
  const hits = []
  const matchValue = (value) => {
    const text = String(value)
    const norm = normalizeToken(text)
    const found = []
    for (const token of LAYOUT_TOKENS) {
      if (token.norms && token.norms.includes(norm)) found.push(token.id)
      else if (!token.norms && token.pattern.test(text.toLowerCase())) found.push(token.id)
    }
    return found
  }
  const visit = (node, segments, inProse) => {
    const path = segments.join('.')
    if (typeof node === 'function') return
    if (Array.isArray(node)) {
      node.forEach((entry, index) => visit(entry, [...segments, `[${index}]`], inProse))
      return
    }
    if (node && typeof node === 'object') {
      for (const [key, value] of Object.entries(node)) {
        // 键名一律扫（含形状 id 写法）——「版式键叫什么都算」
        for (const token of LAYOUT_TOKENS) {
          if (token.norms ? token.norms.includes(normalizeToken(key)) : token.pattern.test(key)) {
            hits.push(Object.freeze({ path: `${path}.${key}`, token: token.id }))
          }
        }
        const nextSegments = [...segments, key]
        visit(value, nextSegments, PROSE_KEYS.includes(key) && !insideBlocks(nextSegments))
        continue
      }
      return
    }
    if (node === null || node === undefined) return
    // 叶子值：文案位不扫（见 PROSE_KEYS 的理由）
    if (inProse) return
    for (const token of matchValue(node)) hits.push(Object.freeze({ path, token }))
  }
  visit(declaration, ['declaration'], false)
  return hits
}

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== '')

/** 记录里的字段取值（界面一律当**文本**呈现，不当 HTML） */
function valueOf(record, key) {
  const fields = Array.isArray(record?.fields) ? record.fields : []
  const field = fields.find((entry) => String(entry?.key ?? '') === String(key))
  return field ? field.value : ''
}

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/

/** 本地日界（口径与 N7 §1 一致：日界取本机时区，呈现时注明） */
function localDay(date) {
  const pad = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/**
 * 到期信息：`{ day, at }`。
 *   - 只有日期（`YYYY-MM-DD`）⇒ 到期时刻取**当日末尾**（本地时区）—— 否则「今天到期」这件事
 *     会既不算逾期（口径是「早于今天」）也进不了 24 小时窗口，等于看不见；
 *   - 带时刻的值 ⇒ 就用那个时刻；
 *   - 空值／读不出来 ⇒ `{day:null, at:null}`（如实计入「无截止日期」）。
 */
function dueInfo(value) {
  const text = value === null || value === undefined ? '' : String(value).trim()
  if (!text) return { day: null, at: null }
  const dateOnly = DATE_ONLY.exec(text)
  if (dateOnly) {
    const start = new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]))
    if (Number.isNaN(start.getTime())) return { day: null, at: null }
    return { day: `${dateOnly[1]}-${dateOnly[2]}-${dateOnly[3]}`, at: start.getTime() + DAY_MS - 1 }
  }
  const at = Date.parse(text)
  if (!Number.isFinite(at)) return { day: null, at: null }
  return { day: localDay(new Date(at)), at }
}

/** 卡片标题：记录里角色为「标题」的那个字段的值；没有就是空串（界面自己兜底，不编一个） */
function recordTitle(record) {
  const fields = Array.isArray(record?.fields) ? record.fields : []
  const titled = fields.find((field) => String(field?.role ?? '') === FIELD_ROLES.TITLE && filled(field?.value))
  return titled ? String(titled.value) : ''
}

/**
 * 统计：**从同一份标准输出算**（不再由 agent 填数字，也不另起取数）。
 * `{ total, overdue, dueSoon, missingDue, items, note }` —— `items` 是呈现用的有序条目。
 */
function collectionStats(records, declaredFields, { nowMs }) {
  const dueField = (Array.isArray(declaredFields) ? declaredFields : []).find((field) => String(field?.role ?? '') === FIELD_ROLES.DUE_DATE)
  const todayDay = localDay(new Date(nowMs))
  let overdue = 0
  let dueSoon = 0
  let missingDue = 0
  for (const record of records) {
    const info = dueInfo(dueField ? valueOf(record, dueField.key) : '')
    if (info.day === null || info.at === null) {
      missingDue += 1
      continue
    }
    if (info.day < todayDay) overdue += 1
    else if (info.at >= nowMs && info.at < nowMs + DAY_MS) dueSoon += 1
  }
  const dueLabel = dueField ? String(dueField.label || dueField.key) : '到期日'
  const note =
    `统计口径：待办＝记录条数；已逾期＝${dueLabel}早于今天；` +
    `今日截止＝${dueLabel}落在未来 24 小时窗口内（服务端场景口径是 24 小时窗口而非自然日；日界取本机时区）。`
  return Object.freeze({
    total: records.length,
    overdue,
    dueSoon,
    missingDue,
    items: Object.freeze([
      Object.freeze({ label: '待办', value: records.length }),
      Object.freeze({ label: '已逾期', value: overdue }),
      Object.freeze({ label: '今日截止', value: dueSoon }),
      Object.freeze({ label: '无截止日期', value: missingDue }),
    ]),
    note,
  })
}

/**
 * 标准输出 → 宿主的**呈现模型**。
 *
 * 入参只有已校验的标准输出（**没有声明**），因此形态选择在本模块内是确定的：
 * 单条 → 卡片；集合 → 表格 + 统计条。返回里没有「声明说了画什么」这回事。
 */
function presentOutput(output, { nowMs = Date.now() } = {}) {
  const record = String(output?.record ?? '')
  const declaredFields = Array.isArray(output?.declaredFields) ? output.declaredFields : []
  const records = Array.isArray(output?.records) ? output.records : []

  if (record === 'single') {
    return Object.freeze({
      record: 'single',
      primitive: 'card',
      title: recordTitle(records[0] ?? { fields: [] }),
      components: Object.freeze([]),
      stats: null,
    })
  }

  if (record === 'collection') {
    // 列集合与顺序 = 宿主规则（`hostFieldOrder`）：字段键白名单与语义来自声明（label 当表头文案）
    const orderedFields = hostFieldOrder(declaredFields)
    const columns = Object.freeze(orderedFields.map((field) => String(field?.label || field?.key || '')))
    // 单元格一定是**文本**或空：记录取值在协议层已收口（`render-protocol.js`：只收能无损变串的
    // 形态 —— 字符串/布尔/可精确表示的数字，对象/数组与会变形的数字一律拒）—— 这里不再有
    // 「对象穿过去让界面自己处理」的分支，
    // 两层对「单元格能是什么」同口径（复核 R2-4：此前那条 `typeof value === 'object' ? value : …`
    // 是不可达分支，且与 `formatCell` 的口径相反）。
    const rows = Object.freeze(
      records.map((entry) =>
        Object.freeze(orderedFields.map((field) => {
          const value = valueOf(entry, field.key)
          return value === null || value === undefined ? '' : String(value)
        })),
      ),
    )
    const stats = collectionStats(records, declaredFields, { nowMs })
    return Object.freeze({
      record: 'collection',
      primitive: 'table',
      title: '',
      components: Object.freeze([
        Object.freeze({ primitive: 'table', title: '', columns, rows }),
        Object.freeze({ primitive: 'stat-bar', title: '统计', items: stats.items, note: stats.note }),
      ]),
      stats,
    })
  }

  // 记录形态未声明：这里不该发生（装载校验与载荷校验都拦在前面）—— 发生了也不猜，如实空手而回
  return Object.freeze({ record, primitive: '', title: '', components: Object.freeze([]), stats: null })
}

return Object.freeze({
  FIELD_ROLES,
  LAYOUT_TOKENS,
  findLayoutTokens,
  dueInfo,
  recordTitle,
  collectionStats,
  presentOutput,
})
})()

const {
  FIELD_ROLES,
  LAYOUT_TOKENS,
  findLayoutTokens,
  dueInfo,
  recordTitle,
  collectionStats,
  presentOutput
} = presentation

// ── read-side.js ──────────────────────────────────────────────────────────────────
const readSide = (function () {
// electron/read-side.js — 读侧的**形状消费点**（宿主侧唯二模块之一，另一处是写执行）。
//
// 为什么单独一个模块：声明里写了 `shape` / `itemsPath` / `totalPath`，但如果宿主从不读它们，
// 那这些声明就是装饰（实现层复核 P2-6/P2-11 的实证：`grep itemsPath electron/ src/` 零命中）。
// 这里把它们变成真正的消费点：
//   - `readPage(envelope, template)` → 按声明取出**条目与总数**，并明确回答「这一页取全了吗」；
//   - 三种形状各自怎么取（对象本体／数组／分页对象）只在这里判一次，别处不得再猜。
//
// 重要口径：`total` 只说明**这个作用域里有多少条**，不说明「作用域对不对」——
// 项目号写错与真的没有结果同形（实测 `--project-id 999999` → `ok:true` + `total:0`）。
// 所以本模块把「空」与「取全」如实报出来，**不替调用方判「不存在」**。
//
// 纯逻辑：无 I/O、无子进程（单测：`tests/read-side.test.mjs`）。

const SHAPES = Object.freeze(['object', 'array', 'paged'])

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)

/** 按点分路径取值（不存在的键返回 undefined —— 与「值为 null」区分开）。 */
function pick(node, path) {
  let cursor = node
  for (const segment of String(path).split('.')) {
    if (!isPlainObject(cursor) && !Array.isArray(cursor)) return undefined
    cursor = cursor[segment]
  }
  return cursor
}

/**
 * 按模板声明把信封读成 `{ shape, items, total, truncated, empty }`。
 *
 * - `shape: 'object'` → `items` 是 `[data]`（单条），`total` 为 1；根对象查询实测会把根对象平铺进 data。
 * - `shape: 'array'` → `items` 是 data 本身（实测 type-list／status-list／user-list／issue-history／relation-list）。
 * - `shape: 'paged'` → 按声明的 `itemsPath`／`totalPath` 取（实测列表是**双层 data**：`data.data` / `data.total`）。
 * - 声明缺形状 ⇒ `shape: null` 且 `items` 为空，**并且如实标 `undeclared: true`**（未声明就是未声明，
 *   不猜成空结果）。
 *
 * @returns {Readonly<{ ok: boolean, shape: string|null, items: readonly any[], total: number|null, undeclared: boolean, truncated?: boolean|null, empty?: boolean, reason?: string }>}
 */
function readPage(envelope, template) {
  if (!isPlainObject(envelope)) return Object.freeze({ ok: false, reason: 'not-an-envelope', shape: null, items: [], total: null, undeclared: false })
  const shape = SHAPES.includes(String(template?.shape ?? '')) ? String(template.shape) : null
  if (!shape) {
    return Object.freeze({ ok: true, shape: null, undeclared: true, items: Object.freeze([]), total: null, truncated: false, empty: true })
  }

  if (shape === 'object') {
    const data = envelope.data
    const items = isPlainObject(data) ? [data] : []
    return Object.freeze({ ok: true, shape, undeclared: false, items: Object.freeze(items), total: items.length, truncated: false, empty: items.length === 0 })
  }

  if (shape === 'array') {
    const items = Array.isArray(envelope.data) ? envelope.data : []
    return Object.freeze({ ok: true, shape, undeclared: false, items: Object.freeze(items), total: items.length, truncated: false, empty: items.length === 0 })
  }

  // paged：路径必须由声明给出（缺声明＝不猜）
  const itemsPath = String(template?.itemsPath ?? '')
  const totalPath = String(template?.totalPath ?? '')
  if (!itemsPath || !totalPath) {
    return Object.freeze({ ok: true, shape, undeclared: true, items: Object.freeze([]), total: null, truncated: false, empty: true, reason: 'paged-paths-missing' })
  }
  const raw = pick(envelope, itemsPath)
  const items = Array.isArray(raw) ? raw : []
  const totalRaw = pick(envelope, totalPath)
  const total = typeof totalRaw === 'number' ? totalRaw : null
  // 取全与否只能按 total 判：拿到的条数少于总数就是没取全（截断要能被看见，否则会被当成「就这么多」）
  const truncated = total === null ? null : items.length < total
  return Object.freeze({ ok: true, shape, undeclared: false, items: Object.freeze(items), total, truncated, empty: items.length === 0 })
}

/**
 * 从一次取数结果里取出**某字段的可选值**（标签 → 值）。
 *
 * 声明里标了缺口（`gap`）或需要先回读（`derived`）的字段一律**拒**：取值口径属包，
 * 宿主不替它猜；对「没出口」的字段，如实告诉调用方「这个值只能由人来给」。
 */
function listValueOptions(pack, fieldKey, envelope) {
  const lookup = pack?.declaration?.valueLookup
  const entry = lookup && typeof lookup === 'object' ? lookup[fieldKey] : null
  if (!entry || typeof entry !== 'object') return Object.freeze({ ok: false, reason: 'field-not-declared' })
  if (entry.gap) return Object.freeze({ ok: false, reason: 'no-dictionary-outlet', detail: String(entry.gap) })
  if (entry.derived) return Object.freeze({ ok: false, reason: 'derived-value', detail: String(entry.derived) })
  const template = (pack.declaration?.templates ?? []).find((t) => t.id === entry.template)
  if (!template) return Object.freeze({ ok: false, reason: 'lookup-template-missing' })
  const page = readPage(envelope, template)
  const labelField = String(entry.labelField ?? '')
  const valueField = String(entry.valueField ?? '')
  const options = page.items
    .map((item) => ({ label: String(item?.[labelField] ?? ''), value: item?.[valueField] }))
    .filter((option) => option.label !== '' && option.value !== undefined && option.value !== null)
  return Object.freeze({
    ok: true,
    template: template.id,
    requiredScope: Object.freeze(Array.isArray(entry.scope) ? entry.scope.map(String) : []),
    options: Object.freeze(options),
    truncated: page.truncated,
  })
}

/**
 * 「须本人指定」字段的**出口**（包声明 `valueLookup[字段]`）→ 该字段的佐证形态。
 *
 * 为什么要分出口而不是一刀切：上一轮为堵 P1-1（原话佐证可绕过「取值必须查表」）改成
 * 「指定类有值即必须取数佐证」，结果把**没有字典出口的字段一并打死**——优先级／标签（`gap`）、
 * 落树的父项 id（`derived`）、更新/评论的目标 id（`readback`）全部变成永久不可达，
 * 也就是「拿一个洞换了一次能力回退」（第二轮复核实测：整改前能真跑的命令，整改后一个字都发不出去）。
 *
 * 判据（按出口分四类）：
 *   `template`（有清单）  ⇒ 佐证须为取数 `lookup`（命中才写）
 *   `readback`（须回读）  ⇒ 佐证须为取数 `lookup`，或带来源的 `derived`
 *   `gap`（无字典出口）    ⇒ 佐证须为原话 `quote`（值由使用者给出，这是唯一可能的证据）
 *   `derived`（来自某一步）⇒ 佐证须为 `derived` 且写明 `from`
 *   未声明出口            ⇒ 判 `outlet-undeclared`（这是**声明**的问题，要吼出来，不静默放行）
 */
function outletOf(declaration, fieldKey) {
  const lookup = declaration && isPlainObject(declaration.valueLookup) ? declaration.valueLookup : {}
  const key = String(fieldKey ?? '')
  if (!Object.hasOwn(lookup, key)) return Object.freeze({ kind: 'undeclared', entry: null })
  const entry = lookup[key]
  if (!isPlainObject(entry)) return Object.freeze({ kind: 'undeclared', entry: null })
  if (entry.template) return Object.freeze({ kind: 'template', entry })
  if (entry.readback) return Object.freeze({ kind: 'readback', entry })
  if (entry.gap) return Object.freeze({ kind: 'gap', entry })
  if (entry.derived) return Object.freeze({ kind: 'derived', entry })
  return Object.freeze({ kind: 'undeclared', entry })
}

/**
 * 「须本人指定」字段的佐证**是否与它自己的出口相配** —— 三层闸门（造卡／确认／执行）共用的那一个判据。
 *
 * 为什么必须有这一个函数：同一道判据原先在三个模块里各写了一遍「有值即必须 `lookup`」，
 * 结果与声明里那张出口表（`template`/`readback`/`gap`/`derived`）**不一致** ——
 * 没有字典出口的字段（优先级／标签：`gap`）、按编号回读的字段（更新／评论的目标：`readback`）、
 * 落树的父项 id（`derived`）全部永久不可达（实测：这些字段给任何佐证都回 `designated-value-needs-lookup`）。
 * 判据只在这里判一次，三处闸门都调它 —— 别处不得再自写一套。
 *
 * 需要「来源」的出口（`readback`／`derived` 用 `derived` 佐证）会核对 `from` **指向本包声明过的一步**：
 * 不是随口写个来源就能过。
 *
 * @returns {Readonly<{ ok: boolean, reason?: any, field?: string }>}
 */
function evidenceOk(declaration, field) {
  const key = String(field?.key ?? '')
  const value = field?.value
  const hasValue = Array.isArray(value)
    ? value.length > 0
    : value !== null && value !== undefined && String(value).trim() !== ''
  if (!hasValue) return Object.freeze({ ok: true })

  const outlet = outletOf(declaration, key)
  const attestation = isPlainObject(field?.attestation) ? field.attestation : {}
  const kind = String(attestation.kind ?? '')
  const from = String(attestation.from ?? '').trim()
  const fail = (reason) => Object.freeze({ ok: false, reason, field: key })
  /** `from` 要指向本包声明过的**某一步**（模板 id）；写个别的名字不算来源 */
  const sourceOk = () => {
    if (!from) return fail('derived-source-missing')
    const templates = Array.isArray(declaration?.templates) ? declaration.templates : []
    if (!templates.some((t) => String(t?.id ?? '') === from)) return fail('derived-source-unknown')
    return Object.freeze({ ok: true })
  }

  switch (outlet.kind) {
    case 'template': // 有清单 ⇒ 值只能从清单里选
      return kind === 'lookup' ? Object.freeze({ ok: true }) : fail('designated-value-needs-lookup')
    case 'readback': // 须按编号回读 ⇒ 取数佐证，或写明来源的派生佐证
      if (kind === 'lookup') return Object.freeze({ ok: true })
      if (kind === 'derived') return sourceOk()
      return fail('designated-value-needs-readback')
    case 'gap': // 无字典出口 ⇒ 值由使用者给出，原话是唯一可能的证据
      return kind === 'quote' ? Object.freeze({ ok: true }) : fail('designated-value-needs-quote')
    case 'derived': // 值来自本会话某一步 ⇒ 必须写明来源
      return kind === 'derived' ? sourceOk() : fail('derived-value-needs-derived')
    default: // 没声明出口是**声明**的问题，要吼出来，不静默放行
      return fail('outlet-undeclared')
  }
}

return Object.freeze({
  outletOf,
  evidenceOk,
  SHAPES, readPage, pick, listValueOptions })
})()

const {
  outletOf,
  evidenceOk,
  SHAPES,
  readPage,
  pick,
  listValueOptions
} = readSide

// ── plan-card.js ──────────────────────────────────────────────────────────────────
const planCard = (function () {
// electron/plan-card.js — 会话内计划卡片的**状态机与呈现契约**（宿主骨架的一部分）。
//
// 边界（spec-library `docs/plankton/N7-20260930-plankton-baymax-chat-native.md` §3／§5）：
//   - 卡片是「将要写入的字段与取值」的可确认载体：先看字段，再确认，最后才写入。
//   - 状态机 `draft → confirmed → written | failed`；**处于 draft 的卡片一律不可写** ——
//     这是「未确认不得写」的机器载体（`assertWritable`），不是靠调用方自觉。
//   - 持久化范围（D-1 已定）：**仅会话内存**，不落盘。本模块不引入 fs／不读凭据目录，
//     进程结束草稿即消失（边界最干净：宿主不留工单副本）。
//   - 字段分级：`agent-drafted`（agent 可代笔）／`user-fact`（必须本人给的事实）／
//     `user-designated`（必须本人指定；**取值形态由该字段自己的出口决定**：有清单的须查表命中、
//     按编号回读的须取数或写明来源、无字典出口的用本人原话）。后两类留空时**卡片不可确认** ——
//     缺就留空提醒，不许 agent 推断补全。
//
// 纯逻辑：不可变数据 + 纯函数；无 I/O、无子进程（单测：`tests/plan-card.test.mjs`）。

// 状态集合（实现层复核 P1-5 整改，2026-09-30）：成功只有一种（`written`），**失败有三种** ——
// 「写没写进去还不确定」和「写成功了但只成功一半」不是同一种事，用同一个 failed 装起来，
// 界面就只能说一句「失败了」，而这三种的处置动作完全相反（前者**先核对存在性**、后者要补写、
// 重复风险要**先去重再决定**）。所以状态必须分开，不能靠文案区分。
const CARD_STATES = Object.freeze(['draft', 'confirmed', 'written', 'failed', 'write-unknown', 'partial', 'duplicate-risk', 'discarded'])

const FIELD_TIERS = Object.freeze([
  'agent-drafted', // 措辞类：标题、描述整理、评论、状态变更说明
  'user-fact', // 事实类：实际/预估工时、截止日期、计划开始、负责人、验收结论
  'user-designated', // 指定类：类型、状态、优先级、标签、上级项、项目（佐证按各自出口，见 read-side.evidenceOk）
])

/** 必须由本人提供的两类（agent 不得代填、不得推断） */
const HUMAN_TIERS = Object.freeze(['user-fact', 'user-designated'])

/** 字段分级的中文口径（界面直接用，不要在界面里另造词） */
const TIER_LABELS = Object.freeze({
  'agent-drafted': 'agent 起草',
  'user-fact': '须本人给',
  'user-designated': '须本人指定',
})

const STATE_LABELS = Object.freeze({
  draft: '待确认',
  confirmed: '已确认，待写入',
  written: '已写入',
  failed: '写入失败（确定没写进去）',
  'write-unknown': '写入结果未知（先核对，不要重写）',
  partial: '部分写入（有些项没写进去）',
  'duplicate-risk': '可能有重复（先去重，再决定）',
  discarded: '已撤销（草稿丢弃）',
})

/** 终态里「不能直接重试」的那些：重试前必须先核对台账（写不写进去还不确定／可能已经存在）。 */
const NEEDS_RECONCILE = Object.freeze(['write-unknown', 'partial', 'duplicate-risk'])

const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== '')

function freezeField(field) {
  return Object.freeze({
    key: String(field?.key ?? ''),
    label: String(field?.label ?? field?.key ?? ''),
    value: field?.value ?? '',
    tier: String(field?.tier ?? ''),
    /** 取值的查询路径（指定类字段用；无出口时由包显式标缺口，宿主只如实呈现） */
    lookup: field?.lookup ?? null,
    /**
     * 值的来源：`'human'`＝本人给的、`'agent'`＝agent 起草的、`null`＝还没有值。
     * 人类字段（事实类／指定类）**只能**是 `'human'` 或 `null` —— agent 代填一律拒收，
     * 这样「agent 推断工时/截止日期」在数据结构层就不可能存在，而不是靠事后检查。
     */
    source: field?.source === 'human' || field?.source === 'agent' ? field.source : null,
    /**
     * 人类字段的**佐证**（谁允许把这个值填进来）：
     * `{kind:'quote', quote}` ＝ 用户原话（宿主核对过它真的在会话里出现过）；
     * `{kind:'lookup', field}` ＝ 走该字段声明的取数路径（执行层核对取值确实在结果里）。
     * agent 起草的字段没有佐证 —— 这是「凭什么相信这个值」在数据结构里的差别。
     */
    attestation: field?.attestation && typeof field.attestation === 'object' ? Object.freeze({ ...field.attestation }) : null,
  })
}

/**
 * 造一张草稿卡片。`fields` 里每个字段都必须声明分级：未分级字段无法判断「agent 能不能代笔」，
 * 因此在这里就被拒绝（把「没人认领的字段」挡在卡片之外，而不是等到写入时才发现）。
 */
function createPlanCard(/** @type {{ id?: string, title?: string, fields?: any[] }} */ { id, title = '', fields = [] } = {}) {
  if (!String(id ?? '').trim()) return { ok: false, errors: ['missing-id'] }
  if (!Array.isArray(fields) || fields.length === 0) return { ok: false, errors: ['missing-fields'] }
  const errors = []
  const keyed = new Set()
  const normalized = fields.map((field) => {
    const f = freezeField(field)
    if (!f.key) errors.push('field-missing-key')
    else if (keyed.has(f.key)) errors.push(`duplicate-field:${f.key}`)
    else keyed.add(f.key)
    if (!FIELD_TIERS.includes(f.tier)) errors.push(`field-bad-tier:${f.key || '?'}`)
    // 人类字段有值却标成 agent 起草 ⇒ 拒收（自审自批在数据结构层就不成立）
    if (HUMAN_TIERS.includes(f.tier) && filled(f.value) && f.source !== 'human') {
      errors.push(`human-field-filled-by-agent:${f.key}`)
    }
    return f
  })
  if (errors.length) return { ok: false, errors }
  return {
    ok: true,
    card: Object.freeze({
      id: String(id).trim(),
      title: String(title ?? ''),
      state: 'draft',
      fields: Object.freeze(normalized),
      confirmedBy: null,
      ref: null,
      failure: null,
    }),
  }
}

/**
 * 「在等本人给」的字段（只报清单，不替使用者填）。
 *
 * 注意：**留空是可确认的**（未填＝没有这个事实，例如这件事没有预估工时）。
 * 闸门针对的不是「空」，而是「agent 替本人填了」—— 见 `assertNoAgentFilledHumanFields`。
 */
function awaitingHumanFields(card) {
  return card.fields.filter((f) => HUMAN_TIERS.includes(f.tier) && !filled(f.value)).map((f) => f.key)
}

/** 由本人提供的人类字段（有值且来源是本人） */
function providedHumanFields(card) {
  return card.fields.filter((f) => HUMAN_TIERS.includes(f.tier) && filled(f.value)).map((f) => f.key)
}

/** agent 代填了人类字段 —— 一律拒绝确认（防御性：正常路径在造卡片时就已被拒） */
function assertNoAgentFilledHumanFields(card) {
  const offending = card.fields
    .filter((f) => HUMAN_TIERS.includes(f.tier) && filled(f.value) && f.source !== 'human')
    .map((f) => f.key)
  if (offending.length) return offending
  return []
}

/**
 * 确认。仅 `draft` 可确认；人类字段有留空即拒绝，并把缺的字段名带回去。
 * 拒绝理由要能直接呈现给使用者（「缺什么」而不是「操作失败」）。
 */
function confirm(card, { by = '' } = {}) {
  if (!card || card.state !== 'draft') return { ok: false, reason: 'not-draft', card }
  if (!String(by ?? '').trim()) return { ok: false, reason: 'missing-confirmer', card }
  // 唯一闸门：不许 agent 替本人填事实类／指定类字段（留空是允许的）
  const offending = assertNoAgentFilledHumanFields(card)
  if (offending.length) return { ok: false, reason: 'human-field-filled-by-agent', fields: offending, card }
  return { ok: true, card: Object.freeze({ ...card, state: 'confirmed', confirmedBy: String(by).trim() }) }
}

/**
 * 写入前的硬闸门：**未确认即抛错**。
 * 这是状态机的机器载体 —— 写执行器必须先过这一关，绕过它就等于把「人确认」这一步删掉。
 */
function assertWritable(card) {
  if (!card || card.state !== 'confirmed') {
    const state = card?.state ?? 'none'
    throw new Error(`plan-card-not-writable: state=${state}`)
  }
  return true
}

/** 写入成功：必须带包侧回执（编号或引用）。缺回执照样判失败 —— 没有回执就等于不知道写没写进去。 */
function markWritten(card, { ref = '' } = {}) {
  assertWritable(card)
  if (!String(ref ?? '').trim()) return { ok: false, reason: 'missing-ref', card }
  return { ok: true, card: Object.freeze({ ...card, state: 'written', ref: String(ref).trim() }) }
}

/** 写入失败：失败原因如实保留（界面据此呈现，不得改写成成功或静默丢弃） */
function markFailed(card, { reason = '' } = {}) {
  assertWritable(card)
  if (!String(reason ?? '').trim()) return { ok: false, reason: 'missing-failure-reason', card }
  return { ok: true, card: Object.freeze({ ...card, state: 'failed', failure: String(reason).trim() }) }
}

/** 写入结果未知（超时／连接断了／回执读不懂）：**不是失败**，是「先核对再说」 */
function markWriteUnknown(card, { reason = '' } = {}) {
  assertWritable(card)
  if (!String(reason ?? '').trim()) return { ok: false, reason: 'missing-failure-reason', card }
  return { ok: true, card: Object.freeze({ ...card, state: 'write-unknown', failure: String(reason).trim() }) }
}

/** 部分写入：有回执（写进去了一部分），但还有没落地的 —— 须逐条交代缺了什么 */
function markPartial(card, { ref = '', pending = [] } = {}) {
  assertWritable(card)
  if (!String(ref ?? '').trim()) return { ok: false, reason: 'missing-ref', card }
  const missing = (Array.isArray(pending) ? pending : []).map(String).filter(Boolean)
  if (!missing.length) return { ok: false, reason: 'missing-pending-items', card }
  return { ok: true, card: Object.freeze({ ...card, state: 'partial', ref: String(ref).trim(), failure: missing.join(',') }) }
}

/** 可能有重复：查重命中（或查重本身做不了）⇒ 交给人决定，系统不替人合并、也不替人重写 */
function markDuplicateRisk(card, { reason = '' } = {}) {
  assertWritable(card)
  if (!String(reason ?? '').trim()) return { ok: false, reason: 'missing-failure-reason', card }
  return { ok: true, card: Object.freeze({ ...card, state: 'duplicate-risk', failure: String(reason).trim() }) }
}

/**
 * 重开一张「确定没写进去」的卡片。
 *
 * `failed` 与 `write-unknown` 处置相反：前者**确定没写**（改完可以再来一次），后者先核对。
 * 因此只有前者能重开；重开＝回到 `draft`（人得再确认一次，不能靠上一次的确认继续用）。
 */
function reopen(card) {
  if (!card || card.state !== 'failed') return { ok: false, reason: 'not-reopenable', state: card?.state ?? 'none' }
  return { ok: true, card: Object.freeze({ ...card, state: 'draft', failure: null }) }
}

/**
 * 撤销草稿：只在**未写入**时可用（`draft`／`confirmed`／`failed`）。写完的卡片不能「撤销」——
 * 台账里已经有这条了，回退只能靠更新或删除，那是另一回事（属包的业务口径）。
 */
function discard(card, { by = '' } = {}) {
  // `failed` 也算「没写进去」，所以丢得掉；`write-unknown`／`partial`／`duplicate-risk` 不行
  // —— 那几态可能台账里已经有东西了，丢草稿只会把线索藏起来。
  if (!card || !['draft', 'confirmed', 'failed'].includes(card.state)) return { ok: false, reason: 'not-discardable', state: card?.state ?? 'none' }
  if (!String(by ?? '').trim()) return { ok: false, reason: 'missing-operator' }
  return { ok: true, card: Object.freeze({ ...card, state: 'discarded', discardedBy: String(by).trim() }) }
}

/**
 * 卡片离开 `draft` 之后这一版进不了卡：按**当前状态**给出**真做得到**的下一步（复核 R2-2）。
 *
 * 为什么放在 `discard`/`reopen` 旁边：这句话指的动作必须与那两个函数的**允许态**同源。
 * 上一版只有一句「先把这张卡处理掉（丢弃，「确定没写进去」的可以重开）再重发一遍」，
 * 而实测（复核件 a5）`discard` 只允许 `draft`/`confirmed`/`failed`、`reopen` 只允许 `failed` ⇒
 * 在 `write-unknown`/`partial`/`duplicate-risk`/`discarded`/`written` 五态上，那句话指向一个
 * 必然被拒的动作（`discarded` 上更是死循环：丢不掉、重开不了，块的身份永久死掉）。
 *
 * `hostAction` 是这句话让人做的那一步，**机器可核对**（用例逐态真调一次宿主动作）：
 *   · `discard`：该状态下 `session.discard` 真的成功；
 *   · `resend-as-new-block`：该状态下丢/重开都做不到，但「换块名或补一个字段重发」真的能落新卡；
 *   · `another-block-kind`：改内容得走另一种块（包声明里存在「更新」类单条块）；
 *   · `reconcile`：该状态下丢/重开都做不到，所以文案只说「先去核对」，不许让人在这里丢或重开。
 */
const RECONCILE_ADVICE = '这一笔的结果还没弄清楚 —— 这一状态下不许丢草稿（丢草稿只会把线索藏起来）。先去台账按标题／编号核对清楚，这期间改内容不会落到卡片上。'

/**
 * 「要重新落卡」的那一步（复核 R3-P3-1）：卡片身份＝块 + **字段键集合**，与取值无关，
 * 所以丢弃之后**同一个块（同一组字段键）不会再进卡** —— 必须换一个块名、或补一个字段，
 * 才是一条新草稿。这段话在 `discarded`/`confirmed`/`failed` 三态**同源**：让「丢弃后重发」
 * 这条路真的走得通，而不是把人送进一条死循环（上一版 `confirmed` 只说「丢掉再重发一遍」，
 * 而丢弃后同块重发 `consumed=[]`、卡片还是旧标题 ⇒ 第二步落空）。
 */
const RESEND_AS_NEW_BLOCK_ADVICE =
  '同一个块（同一组字段键）不会再进卡。要重新落卡，请换一个块名、或在记录里多给一个字段，作为新的一条重发。'

const NOT_DRAFT_ADVICE = Object.freeze({
  confirmed: Object.freeze({
    hostAction: 'discard',
    text: '要改这条，先点「丢弃草稿」丢掉这张卡；丢完' + RESEND_AS_NEW_BLOCK_ADVICE,
  }),
  failed: Object.freeze({
    hostAction: 'discard',
    text: '要改这条，可以点「重开」把它放回「待确认」再改；或点「丢弃草稿」丢掉它 —— 丢完' + RESEND_AS_NEW_BLOCK_ADVICE,
  }),
  discarded: Object.freeze({
    hostAction: 'resend-as-new-block',
    text: '这一张已经丢了，' + RESEND_AS_NEW_BLOCK_ADVICE,
  }),
  written: Object.freeze({
    hostAction: 'another-block-kind',
    text: '这一条已经写进台账了，卡片不再接受新版本。要改内容，请让助手另发一个「更新」类块（改既有工单的那一种，不是新建）。',
  }),
  'write-unknown': Object.freeze({ hostAction: 'reconcile', text: RECONCILE_ADVICE }),
  partial: Object.freeze({ hostAction: 'reconcile', text: RECONCILE_ADVICE }),
  'duplicate-risk': Object.freeze({ hostAction: 'reconcile', text: RECONCILE_ADVICE }),
})

/** 「这一版没进卡片」该怎么说、下一步做什么 —— 状态不认识时按最保守的「先去核对」处理 */
function notDraftAdvice(state) {
  return NOT_DRAFT_ADVICE[String(state ?? '')] ?? Object.freeze({ hostAction: 'reconcile', text: RECONCILE_ADVICE })
}

/** 这一态能否直接重试：写没写进去还不确定／可能已存在 —— 都须先核对，重写会造重复 */
function needsReconcile(card) {
  return NEEDS_RECONCILE.includes(String(card?.state ?? ''))
}

/**
 * 把**已确认**的卡片翻成执行器的结构化参数：只取有值的字段（空字段不产生参数，
 * 于是可选参数自然不出现，不会拼出「半个参数对」）。未确认的卡片调它照样抛错。
 *
 * 取值在这里**按文本收口**（复核 R2-4）：值在上游三层已经过「无损才收」的取舍
 * （`render-protocol.js`／`pack-session.js`／`pack-exec.js` 共用 `isLosslessValue`），到这里的
 * 只可能是字符串/布尔/可精确表示的数字（`String()` 无损），交给 argv 前统一成串 —— 保证命令行上
 * 看到的与人看到的是同一个值（对象/数组与会变形的数字已在上游被拒，到不了这里；复核 R3-P3-2）。
 *
 * **收口是两道、不是一道**（复核 R3-P3-4）：这里的 `String()` 与 `pack-exec.js` argv 组装处的
 * `argv.push(String(params[arg.field]))` 等价 —— 去掉这里、第二道照旧兜住（所以本处的变异是
 * 「等价变异」，不代表这里没守卫；`tests/pack-exec.test.mjs` 钉的是 argv 里那个串）。
 */
function toParams(card) {
  assertWritable(card)
  const params = {}
  for (const field of card.fields) {
    if (!filled(field.value)) continue
    params[field.key] = typeof field.value === 'string' ? field.value : String(field.value)
  }
  return params
}

/**
 * 呈现视图：只读数据，供卡片渲染。
 * **不含任何可编辑控件语义**（判定不是「页 = 重」，是「表单 = 重」）：这里出来的是
 * 「字段名 → 取值 → 谁负责给」三列，编辑一律回到对话里。
 */
function toPresentation(card, { requiredFields = [] } = {}) {
  const required = (Array.isArray(requiredFields) ? requiredFields : []).map(String)
  const missingRequired = required.filter((key) => {
    const field = card.fields.find((f) => f.key === key)
    return !field || !filled(field.value)
  })
  return {
    id: card.id,
    title: card.title,
    state: card.state,
    stateLabel: STATE_LABELS[card.state] ?? card.state,
    ref: card.ref,
    failure: card.failure,
    // 写这张卡片**还缺哪些必填**：界面据此把「确认」先拦住（别等服务端拒了才说缺什么）
    requiredFields: Object.freeze(required),
    missingRequired: Object.freeze(missingRequired),
    fields: card.fields.map((f) => ({
      key: f.key,
      label: f.label,
      value: f.value,
      tier: f.tier,
      // 留空的人类字段在呈现上要能看出来「这是等你给的事实，不是 agent 忘了」
      awaitingHuman: HUMAN_TIERS.includes(f.tier) && !filled(f.value),
      // 值是谁给的：本人／agent／还没有 —— 界面据此显示来源，不必猜
      source: f.source,
      editable: false,
      lookup: f.lookup,
      required: required.includes(f.key),
      // 佐证一并呈现：本人能看见「这句话是我说的」／「这个取值是查出来的」
      evidence: f.attestation,
      tierLabel: TIER_LABELS[f.tier] ?? f.tier,
    })),
  }
}

return Object.freeze({
  CARD_STATES,
  FIELD_TIERS,
  HUMAN_TIERS,
  STATE_LABELS,
  TIER_LABELS,
  NEEDS_RECONCILE,
  needsReconcile,
  notDraftAdvice,
  NOT_DRAFT_ADVICE,
  RESEND_AS_NEW_BLOCK_ADVICE,
  discard,
  reopen,
  markWriteUnknown,
  markPartial,
  markDuplicateRisk,
  createPlanCard,
  awaitingHumanFields,
  providedHumanFields,
  assertNoAgentFilledHumanFields,
  confirm,
  assertWritable,
  markWritten,
  markFailed,
  toParams,
  toPresentation,
})
})()

const {
  CARD_STATES,
  FIELD_TIERS,
  HUMAN_TIERS,
  STATE_LABELS,
  TIER_LABELS,
  NEEDS_RECONCILE,
  needsReconcile,
  notDraftAdvice,
  NOT_DRAFT_ADVICE,
  RESEND_AS_NEW_BLOCK_ADVICE,
  discard,
  reopen,
  markWriteUnknown,
  markPartial,
  markDuplicateRisk,
  createPlanCard,
  awaitingHumanFields,
  providedHumanFields,
  assertNoAgentFilledHumanFields,
  confirm,
  assertWritable,
  markWritten,
  markFailed,
  toParams,
  toPresentation
} = planCard

// ── pack-registry.js ──────────────────────────────────────────────────────────────────
const packRegistry = (function () {
// electron/pack-registry.js — 宿主侧的**插件注册点**：只认「声明」，不认任何具体的包。
//
// 边界（spec-library `docs/plankton/N7-20260930-plankton-baymax-chat-native.md` §10）：
//   - 宿主只出两样东西：**注册点** + 会话内呈现骨架。命令清单、字段映射与分级、取值路径、
//     流程口径、技能条目全部由包随自身声明带进来。
//   - 拔掉包 ⇒ 注册表为空 ⇒ 写路径不可用（能力自然消失），宿主不留残留分支。
//   - 包必须声明的最小契约共 **15 项**（第 13/14/15 项＝模板 `templates`、**标准输出声明 `outputs`**、技能文档 `skillDoc`；**顺序以本数组为准**，与契约文档的名次一致）；**缺任一项即不可装载**，不给写路径 —— 宁可不写，
//     也不让「半懂的宿主」替包做主。（写模板曾在文档里被写成「超出最小契约的声明」，
//     实现层复核 P1-4 指出那是两套机制：缺模板时包照样能装载 ⇒ 写路径其实不可用却看着可用。
//     现在模板也是契约项 —— 只有一套机制。）
//   - 本模块不认识任何具体的包名或命令名（概念黑名单自查见 `tests/pack-boundary.test.mjs`）。
//
// 纯逻辑：无 I/O、无子进程、无网络；便于单测（`tests/pack-registry.test.mjs`）。

/** 装载契约的 15 项（以本数组为准，别在别处写死数字）。`kind` 是宿主侧唯一能替包做的判断 —— 类型与可调用性，不做语义解释。 */
const PACK_CONTRACT_ITEMS = Object.freeze([
  Object.freeze({ key: 'discriminant', kind: 'string', label: '成功／失败判别式（如何判成败）' }),
  Object.freeze({ key: 'failureMap', kind: 'object', label: '失败码 → 呈现态映射' }),
  Object.freeze({ key: 'requiredParams', kind: 'object', label: '每条命令的必填参数与依赖' }),
  Object.freeze({ key: 'destructiveParams', kind: 'array', label: '破坏性参数及其语义' }),
  Object.freeze({ key: 'valueLookup', kind: 'object', label: '取值查询路径（无出口须显式标缺口）' }),
  Object.freeze({ key: 'steps', kind: 'array', label: '多步流程的步骤组合与中间态语义' }),
  Object.freeze({ key: 'lookupFields', kind: 'object', label: '可查字段集与存在性核对算法' }),
  Object.freeze({ key: 'outputParsing', kind: 'object', label: '输出解析、信封与分页语义' }),
  Object.freeze({ key: 'fieldTiers', kind: 'object', label: '字段分级的机器可读声明' }),
  Object.freeze({ key: 'landing', kind: 'object', label: '包落点、装配点与排除集' }),
  Object.freeze({ key: 'skill', kind: 'array', label: '技能内容清单' }),
  Object.freeze({ key: 'broadcastPredicate', kind: 'function', label: '播报谓词（此刻有无可播报内容）' }),
  Object.freeze({ key: 'templates', kind: 'array', label: '写模板（模板 id、命令、必填字段、参数序列、回执路径）' }),
  Object.freeze({ key: 'outputs', kind: 'object', label: '标准输出声明（块名、记录形态、字段键、动作）' }),
  Object.freeze({ key: 'skillDoc', kind: 'object', label: '技能文档（用这个包要知道的事，逐字落成文件）' }),
])

const { EXEC_KINDS } = PACK_EXEC_SCOPE
// 版式词汇表归**宿主呈现规则**（`presentation.js`）：装载期用它判「声明里有没有在指挥宿主怎么画」。
const { findLayoutTokens } = presentation
const { OUTPUT_RECORD_KINDS } = renderProtocol
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const nonEmptyString = (v) => typeof v === 'string' && v.trim().length > 0
const nonEmptyArray = (v) => Array.isArray(v) && v.length > 0
const nonEmptyObject = (v) => isPlainObject(v) && Object.keys(v).length > 0

const KIND_CHECKS = Object.freeze({
  string: nonEmptyString,
  object: nonEmptyObject,
  array: nonEmptyArray,
  function: (v) => typeof v === 'function',
})

/**
 * 「空形态」＝提供了但没有信息量（空串／空对象／空数组）。
 * 这类和「键都没写」给使用者的提示是同一件事：**这项等于没声明**；
 * 而「写了个数、写了个字符串当谓词」是另一件事：**声明写错了**。分开报，处置才不同。
 */
const EMPTY_FORMS = Object.freeze({
  string: (v) => v === '',
  object: (v) => isPlainObject(v) && Object.keys(v).length === 0,
  array: (v) => Array.isArray(v) && v.length === 0,
  function: () => false,
})

/**
 * 校验一份包声明。
 *
 * 返回 `{ ok, missing, invalid }`：`missing` = 缺项或空形态（等于没声明），`invalid` = 声明写错（形状不对）。
 * **不抛异常**：装载失败是要呈现给使用者的事实，不是崩溃（能看见为什么不可装载，比静默降级好）。
 */
function validateDeclaration(declaration) {
  const missing = []
  const invalid = []
  if (!isPlainObject(declaration)) {
    return { ok: false, missing: PACK_CONTRACT_ITEMS.map((i) => i.key), invalid: ['declaration-not-object'] }
  }
  // 失败码映射得覆盖执行器会产出的**每一种**结果形态，否则映射只是装饰：
  // 真出现一个没映射的形态时，界面只能说一句「失败了」。
  // 只在「给了且非空」时判覆盖：空/缺/形状错由下面的契约项统一报（提示语不同，处置也不同）
  if (isPlainObject(declaration.failureMap) && Object.keys(declaration.failureMap).length > 0) {
    const uncovered = EXEC_KINDS.filter((kind) => !(kind in declaration.failureMap))
    if (uncovered.length) invalid.push(`failureMap: 未覆盖执行结果形态 ${uncovered.join(',')}`)
  }

  // 交叉引用也要在**装载时**查（运行期再发现有代价：一张写不出去的卡会被造出来、然后让人对着它干瞪眼）
  //   ① 模板的必填字段必须在 fieldTiers 里声明过（否则不知道它是谁给的、也就造不出那一行）
  //   ② 标准输出声明里的块（块名／记录形态／字段键／动作）必须自洽：字段键在 fields 里、动作在 actions 里
  const tiers = isPlainObject(declaration.fieldTiers) ? declaration.fieldTiers : null
  const templates = Array.isArray(declaration.templates) ? declaration.templates : null
  if (tiers && Object.keys(tiers).length > 0 && templates && templates.length > 0) {
    for (const template of templates) {
      if (!isPlainObject(template)) continue
      for (const key of Array.isArray(template.required) ? template.required : []) {
        if (!Object.hasOwn(tiers, String(key))) invalid.push(`templates: ${String(template.id ?? '?')} 的必填 ${String(key)} 未在 fieldTiers 声明`)
      }
    }
  }
  // **形态归宿主**（N7 §12／N2 PLK-REQ-0036 判定面 4）：声明里一旦出现原语名、版式槽位或形状 id，
  // 判装载失败 —— 包声明的是数据，画成什么是宿主的事，这条不许由包把它拿回去。
  // 不做「只在没声明 outputs 时才扫」这类放宽：扫的是整份声明，任何位置出现版式都红。
  const layout = findLayoutTokens(declaration)
  if (layout.length) {
    invalid.push(`声明里出现版式（形态归宿主，包只给数据）：${layout.map((hit) => `${hit.path}→${hit.token}`).join('、')}`)
  }
  if (isPlainObject(declaration.outputs)) {
    const outputs = declaration.outputs
    const declaredFields = isPlainObject(outputs.fields) ? outputs.fields : {}
    const declaredActions = isPlainObject(outputs.actions) ? outputs.actions : {}
    for (const block of Array.isArray(outputs.blocks) ? outputs.blocks : []) {
      if (!isPlainObject(block)) continue
      const tag = String(block.tag ?? '?')
      if (!nonEmptyString(block.tag)) invalid.push('outputs.blocks: 块必须有 tag')
      if (!OUTPUT_RECORD_KINDS.includes(String(block.record ?? ''))) {
        invalid.push(`outputs.blocks.${tag}: record 须是 ${OUTPUT_RECORD_KINDS.join('/')}，收到「${String(block.record)}」`)
      }
      if (!Array.isArray(block.fields) || block.fields.length === 0) {
        invalid.push(`outputs.blocks.${tag}: fields 必须是非空数组（记录携带哪些字段键）`)
      } else {
        for (const key of block.fields) {
          if (!Object.hasOwn(declaredFields, String(key))) invalid.push(`outputs.blocks.${tag}: 字段 ${String(key)} 未在 outputs.fields 声明`)
        }
      }
      for (const id of Array.isArray(block.actions) ? block.actions : []) {
        if (!Object.hasOwn(declaredActions, String(id))) invalid.push(`outputs.blocks.${tag}: 动作 ${String(id)} 未在 outputs.actions 声明`)
      }
    }
  }
  if (isPlainObject(declaration.failureMap) && Object.keys(declaration.failureMap).length > 0) {
    const allowed = new Set(['written', 'failed', 'write-unknown', 'partial', 'duplicate-risk', 'blocked'])
    // 这几种形态**进程可能已经跑过**（跑完说了什么不清楚／被杀／超时）⇒ 一律不许声明成「确定没写」。
    // 理由：`failed` 的卡片可以重试，把它判成确定没写＝重复写。这条是**装载期**的地板，
    // 不许由包的声明把它降下去（复核 P1-3 的同源教训）。
    const mayHaveRun = new Set(['unparsed', 'spawn-error', 'timeout'])
    for (const [kind, state] of Object.entries(declaration.failureMap)) {
      // 值形如 `failed（…）` 的散文字符串是**不可消费**的（复核 P2-1）⇒ 只收状态名
      if (!allowed.has(String(state))) {
        invalid.push(`failureMap.${kind}: 值须是状态名（${[...allowed].join('/')}），收到「${String(state)}」`)
        continue
      }
      if (mayHaveRun.has(String(kind)) && String(state) !== 'write-unknown') {
        invalid.push(`failureMap.${kind}: 该形态「进程可能已经跑过」⇒ 只能声明 write-unknown，不能是 ${String(state)}`)
      }
    }
  }
  if (isPlainObject(declaration.skillDoc) && Object.keys(declaration.skillDoc).length > 0) {
    const doc = declaration.skillDoc
    const fileName = typeof doc.fileName === 'string' ? doc.fileName.trim() : ''
    if (!fileName || fileName.includes('/') || fileName.includes('\\') || fileName.startsWith('.')) {
      invalid.push('skillDoc: fileName 必须是单层文件名')
    }
    if (typeof doc.markdown !== 'string' || doc.markdown.trim() === '') {
      invalid.push('skillDoc: markdown 不能为空')
    }
  }
  // 模板的 `kind`（read/write）是**读路径能不能跑**的唯一判据：必须逐条声明，不许靠
  // 「有没有被视图动作引用」来推断（复核 P1-2 实证：没绑动作的写模板因此被判成可读）。
  if (templates && templates.length > 0) {
    for (const template of templates) {
      if (!isPlainObject(template)) continue
      const kind = String(template.kind ?? '')
      if (kind !== 'read' && kind !== 'write') {
        invalid.push(`templates: ${String(template.id ?? '?')} 缺 kind（read/write 二选一）`)
      }
    }
    // 必填三集合不许互相打架：模板不得比 CLI 松；比 CLI 严的必须登记依据；登记了就必须真用到。
    // `requiredParams` 整体为空＝**没声明**（走 missing 通道），此时不做交叉校验（否则「没声明」
    // 会被报成「写错了」，两者的处置提示不同）。
    const cliRequired = isPlainObject(declaration.requiredParams) ? declaration.requiredParams : {}
    const stricter = isPlainObject(declaration.requiredBeyondCli) ? declaration.requiredBeyondCli : {}
    const crossCheck = Object.keys(cliRequired).length > 0
    for (const template of (crossCheck ? templates : [])) {
      if (!isPlainObject(template)) continue
      const command = String(template.command ?? '')
      const required = (Array.isArray(template.required) ? template.required : []).map(String)
      const fromCli = (Array.isArray(cliRequired[command]) ? cliRequired[command] : []).map((f) => String(f).replace(/^--/, ''))
      for (const flag of fromCli) {
        if (!required.includes(flag)) invalid.push(`templates: ${String(template.id ?? '?')} 比 CLI 更松——CLI 要求 ${flag} 却没声明必填`)
      }
      const declaredStricter = (Array.isArray(stricter[command]) ? stricter[command] : []).map((e) => String(e?.flag ?? '').replace(/^--/, ''))
      for (const flag of required) {
        if (!fromCli.includes(flag) && !declaredStricter.includes(flag)) {
          invalid.push(`templates: ${String(template.id ?? '?')} 把 ${flag} 声明成必填，但既不在 requiredParams 也不在 requiredBeyondCli`)
        }
      }
      for (const flag of declaredStricter) {
        if (!required.includes(flag)) invalid.push(`requiredBeyondCli: ${command} 登记了 ${flag}，但模板没把它当必填（过期登记）`)
      }
    }
  }
  // 标准输出里的动作指向的模板必须存在，且**方向要对**：写动作只能绑写模板、读动作只能绑读模板
  if (templates && templates.length > 0) {
    const ids = new Set(templates.filter(isPlainObject).map((t) => String(t.id)))
    const actions = isPlainObject(declaration.outputs?.actions) ? declaration.outputs.actions : {}
    const kindOf = new Map(templates.filter(isPlainObject).map((t) => [String(t.id), String(t.kind ?? '')]))
    for (const [id, action] of Object.entries(actions)) {
      const writes = isPlainObject(action) ? String(action.writes ?? '') : ''
      const reads = isPlainObject(action) ? String(action.reads ?? '') : ''
      if (writes && !ids.has(writes)) invalid.push(`outputs.actions.${id}: 指向不存在的写模板 ${writes}`)
      if (writes && ids.has(writes) && kindOf.get(writes) !== 'write') {
        invalid.push(`outputs.actions.${id}: ${writes} 不是写模板（kind=${kindOf.get(writes) || '缺失'}）`)
      }
      if (reads && ids.has(reads) && kindOf.get(reads) !== 'read') {
        invalid.push(`outputs.actions.${id}: ${reads} 不是读模板（kind=${kindOf.get(reads) || '缺失'}）`)
      }
    }
  }

  for (const item of PACK_CONTRACT_ITEMS) {
    if (!(item.key in declaration) || declaration[item.key] === undefined || declaration[item.key] === null) {
      missing.push(item.key)
      continue
    }
    if (EMPTY_FORMS[item.kind](declaration[item.key])) {
      missing.push(item.key)
      continue
    }
    if (!KIND_CHECKS[item.kind](declaration[item.key])) invalid.push(`${item.key}: expect ${item.kind}`)
  }
  return { ok: missing.length === 0 && invalid.length === 0, missing, invalid }
}

/** 包身份：id 非空且唯一；displayName 缺省回落 id。语义（这套东西是什么）一律由包自己说明。 */
function readIdentity(declaration) {
  const id = nonEmptyString(declaration?.id) ? declaration.id.trim() : ''
  // 包 id 会被用成**路径段**（技能落点 `<home>/skills/<id>/` 等）⇒ 只允许单层安全标识。
  // 复核 P2-4 实证：`packId='../../../../skills/evil'` 曾可以注册并把技能写到个人技能目录下。
  if (id && !/^[a-z0-9][a-z0-9._-]*$/i.test(id)) {
    return { id: '', displayName: id, invalidId: true }
  }
  const displayName = nonEmptyString(declaration?.displayName) ? declaration.displayName.trim() : id
  return { id, displayName }
}

/**
 * 注册点。**唯一装配点**：所有包都从这里进（装配点文件数 == 1 由边界护栏断言）。
 *
 * 装载是 fail-closed 的：校验不过的声明不进入注册表 —— 于是它既不出现在呈现层，
 * 也不会被写路径取到（「缺项即拒绝启用写路径」的机器载体）。
 */
function createPackRegistry() {
  const packs = new Map()

  function register(declaration) {
    const { id, displayName, invalidId } = readIdentity(declaration)
    if (invalidId) return { ok: false, id: '', errors: ['invalid-id（只允许单层安全标识，因为 id 会被当作路径段）'] }
    if (!id) return { ok: false, id: '', errors: ['missing-id'] }
    if (packs.has(id)) return { ok: false, id, errors: ['duplicate-id'] }
    const verdict = validateDeclaration(declaration)
    if (!verdict.ok) {
      return { ok: false, id, errors: [...verdict.missing.map((k) => `missing:${k}`), ...verdict.invalid] }
    }
    packs.set(id, Object.freeze({ id, displayName, declaration }))
    return { ok: true, id, errors: [] }
  }

  /** 装载失败的声明也要能看见（否则「为什么没有这个能力」变成谜）——但不进注册表、不给写路径。 */
  const failed = []
  function noteFailure(id, errors) {
    failed.push(Object.freeze({ id: String(id ?? ''), errors: Object.freeze([...errors]) }))
  }
  function registerOrRecord(declaration) {
    const result = register(declaration)
    if (!result.ok) noteFailure(result.id, result.errors)
    return result
  }

  return Object.freeze({
    register: registerOrRecord,
    noteFailure,
    list: () => [...packs.values()].map((p) => ({ id: p.id, displayName: p.displayName })),
    get: (id) => packs.get(id) ?? null,
    /** 写路径是否可用：装配点里没有任何可用的包 ⇒ false（拔包即消失，宿主无残留开关） */
    writeEnabled: (id) => packs.has(id),
    hasAnyWritePath: () => packs.size > 0,
    failures: () => [...failed],
    contractItemCount: () => PACK_CONTRACT_ITEMS.length,
  })
}

/**
 * 问包「此刻有没有可播报内容」。谓词属包（宿主不感知内容口径）；谓词抛错一律判「无可播报」
 * —— 播报是打扰，出错时宁可不打扰，也不发一条没根据的提醒。
 */
function askBroadcast(registry, id, context) {
  const pack = registry.get(id)
  if (!pack) return { ok: false, reason: 'pack-not-loaded', hasContent: false }
  try {
    const verdict = pack.declaration.broadcastPredicate(context)
    if (!isPlainObject(verdict) || typeof verdict.hasContent !== 'boolean') {
      return { ok: false, reason: 'predicate-bad-shape', hasContent: false }
    }
    return { ok: true, reason: '', hasContent: verdict.hasContent, detail: verdict.detail ?? null }
  } catch (error) {
    return { ok: false, reason: 'predicate-threw', hasContent: false, detail: String(error?.message ?? error) }
  }
}

return Object.freeze({
  PACK_CONTRACT_ITEMS,
  validateDeclaration,
  createPackRegistry,
  askBroadcast,
})
})()

const {
  PACK_CONTRACT_ITEMS,
  validateDeclaration,
  createPackRegistry,
  askBroadcast
} = packRegistry

// ── pack-session.js ──────────────────────────────────────────────────────────────────
const packSession = (function () {
// electron/pack-session.js — **会话内的卡片存储与草稿构建**（宿主骨架的一部分）。
//
// 边界（spec-library `docs/plankton/N7-20260930-plankton-baymax-chat-native.md` §3／§4／§5）：
//   - 草稿**只活在本会话内存**（D-1 已定，不落盘、进程结束即消失 —— 宿主不留工单副本）。
//   - 卡片**只能由会话存储发放**：执行器只收卡片、不收回调方自报的参数（实现层复核 P1-1/P1-2）。
//   - 字段分级以**包声明**的 `declaration.fieldTiers` 为准（未声明的字段连卡片都造不出来）。
//   - 人类字段（事实类／指定类）**有值就必须有佐证**：
//       · `quote`：用户原话片段，必须在**本会话的用户消息里真的出现过**（宿主当场核对）；
//       · `lookup`：走该字段声明的取数路径核对（在 `pack-actions.js` 里执行，需读命令）。
//     拿不出佐证 ⇒ 拒收。这样「agent 推断一个截止日期填进去」不是被事后检查，而是根本进不来。
//
// 纯逻辑：无 I/O、无子进程、不落盘（单测：`tests/pack-session.test.mjs`）。

const {
  HUMAN_TIERS,
  STATE_LABELS,
  createPlanCard,
  confirm: confirmCardState,
  discard: discardCardState,
  reopen: reopenCardState,
  toPresentation,
  needsReconcile,
  notDraftAdvice,
} = planCard
const { isLosslessValue } = renderProtocol
const { evidenceOk } = readSide
const isPlainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const filled = (v) => (Array.isArray(v) ? v.length > 0 : v !== null && v !== undefined && String(v).trim() !== '')

/** 稳定的短哈希：同一段内容得到同一个 id（同一份载荷重复扫到不会造出第二张卡片）。 */
function shortHash(text) {
  let h = 0x811c9dc5
  const source = String(text)
  for (let i = 0; i < source.length; i += 1) {
    h ^= source.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/**
 * 载荷里的字段条目 → 卡片字段。
 *
 * 条目形如 `{ key, value?, quote?, lookup? }`（`label` 由调用方从**声明**填入，载荷说了不算）；规则：
 *   - `agent-drafted`：值由 agent 起草 ⇒ 来源 `agent`；
 *   - `user-fact`／`user-designated`：**有值必须有佐证**，佐证成立才允许 `source: 'human'`；
 *   - 任何分级的字段都可以**留空**（留空＝还没有这个事实，卡片上标「等你给」，不是错误）；
 *   - 值一律**收口成文本**（复核 F11 的收口 + R2-4／R3-P3-2 的取舍）：判据与协议层**同一个函数**
 *     （`render-protocol.js` 的 `isLosslessValue`，不再是「非文本一律拒」）——`1` ⇒ `'1'`、
 *     `true` ⇒ `'true'` 照收；**对象/数组**、以及 `String()` 与载荷字面不同形的数字
 *     （小数／超 2^53 的整数／`±Infinity`／`NaN`／`-0`）一律拒（拒＝这张卡造不出来，退回原文显示）。
 */
function buildField(entry, tier, userMessages) {
  if (!isPlainObject(entry)) return { ok: false, reason: 'field-malformed' }
  const key = String(entry.key ?? '')
  if (!key) return { ok: false, reason: 'field-missing-key' }
  if (!tier) return { ok: false, reason: 'field-not-declared', key }
  const raw = entry.value ?? ''
  if (!isLosslessValue(raw)) {
    return { ok: false, reason: 'field-value-malformed', key, detail: Array.isArray(raw) ? 'array' : typeof raw }
  }
  // 值到这个模块时就已经是文本了：卡片、argv、呈现三处看到的是同一个串
  const value = raw === null || raw === undefined ? '' : String(raw)
  const label = String(entry.label ?? key)

  if (tier === 'agent-drafted') {
    return { ok: true, field: { key, label, value, tier, source: filled(value) ? 'agent' : null } }
  }

  // ── 人类字段：没有值就留空（可确认）；有值就必须拿得出佐证 ──────────────
  if (!filled(value)) return { ok: true, field: { key, label, value: '', tier, source: null } }
  const attested = attestation(entry, userMessages)
  if (!attested.ok) return { ok: false, reason: attested.reason, key, detail: attested.detail }
  return {
    ok: true,
    field: { key, label, value, tier, source: 'human', attestation: attested.attestation },
  }
}

/**
 * 佐证核对：原话（在会话里真的出现过）或取数（留给执行层按声明核对）。
 * 原话核对是**纯逻辑**：拿本会话的用户消息逐条比对，对不上就拒。
 */
function attestation(entry, userMessages) {
  const quote = typeof entry.quote === 'string' ? entry.quote.trim() : ''
  const lookup = isPlainObject(entry.lookup) ? entry.lookup : null
  if (quote) {
    if (quote.length < 2) return { ok: false, reason: 'quote-too-short', detail: quote }
    const spoken = (Array.isArray(userMessages) ? userMessages : []).some(
      (message) => typeof message === 'string' && message.includes(quote),
    )
    if (!spoken) return { ok: false, reason: 'quote-not-in-conversation', detail: quote }
    return { ok: true, attestation: { kind: 'quote', quote } }
  }
  if (lookup) {
    const field = String(lookup.field ?? '')
    if (!field) return { ok: false, reason: 'lookup-missing-field' }
    return { ok: true, attestation: { kind: 'lookup', field } }
  }
  return { ok: false, reason: 'human-value-needs-attestation' }
}

function createPackSession() {
  const cards = new Map()
  const order = []

  const put = (card, { updated }) => {
    if (!cards.has(card.id)) order.push(card.id)
    cards.set(card.id, card)
    return updated
  }

  /**
   * 由**记录**造（或刷新）一张草稿卡片。
   *
   * 入参是 `render-protocol.js` 校验过的**标准输出里的记录**（数据），本模块不认载荷格式、
   * 也不认任何形态 —— 画成什么由宿主呈现规则决定。
   *
   * 同一块、同一字段键集合重复扫到 ⇒ 同一张卡片（id 由「块 + 字段键集合」决定，**不含取值**）：
   * 会话里增量扫描不会造出重复卡片，agent 把措辞改好是刷新同一张。
   * 卡片一旦离开 `draft`（人已经确认过、或已经写过），后续扫描**不再覆盖**它。
   */
  function buildDraft(/** @type {{ pack?: any, block?: string, record?: any, title?: string, userMessages?: any[], requiredFields?: any[] }} */ { pack, block = '', record = null, title = '', userMessages = [], requiredFields = [] } = {}) {
    if (!pack?.id) return { ok: false, reason: 'pack-not-loaded' }
    if (!isPlainObject(record)) return { ok: false, reason: 'malformed-record' }
    const declaration = pack.declaration ?? {}
    const tiers = isPlainObject(declaration.fieldTiers) ? declaration.fieldTiers : {}
    // 字段的显示标签（卡片上那行字、表头文案、界面上的「还缺：类型」）**只来自声明**（复核 F5）：
    // 载荷或调用方写在条目里的 `label` 一律不采信 —— 否则 agent 能把「计划结束」改写成「随便写写」，
    // 而「人看懂卡片再点确认」正是这条链上唯一的人判点。载荷侧也没有这个键（`ENTRY_KEYS`）。
    const declaredFields = isPlainObject(declaration.outputs?.fields) ? declaration.outputs.fields : {}
    const labelOf = (key) => {
      const meta = declaredFields[key]
      return isPlainObject(meta) && meta.label ? String(meta.label) : String(key)
    }

    const entries = Array.isArray(record.fields) ? record.fields : []
    if (!entries.length) return { ok: false, reason: 'no-fields' }

    const fields = []
    for (const entry of entries) {
      const key = String(entry?.key ?? '')
      const built = buildField({ ...entry, label: labelOf(key) }, tiers[key], userMessages)
      if (!built.ok) return { ok: false, reason: built.reason, key: built.key ?? key, detail: built.detail ?? null }
      // 指定类字段的佐证必须与它**自己的出口**相配（判据只此一处：`read-side.evidenceOk`）：
      // `template` 要取数佐证、`readback` 要回读或带来源的派生、`gap` 要原话、`derived` 要写明来源。
      // （复核 P1-1 堵「拿原话绕过核对」；KI-PLANKTON-0048 修「一刀切把没有清单的字段全打死」）
      if (String(built.field.tier ?? '') === 'user-designated') {
        const verdict = evidenceOk(pack.declaration, built.field)
        if (!verdict.ok) return { ok: false, reason: verdict.reason, key }
      }
      fields.push(built.field)
    }

    // 卡片身份（决定「这是同一张草稿」还是「另一张」）：
    //   · 记录带 `key`（同块多张草稿时用）⇒ 按 key 认；
    //   · 否则按「块 + 字段键集合」认 —— **不含取值**，于是 agent 把措辞改好是刷新同一张卡片，
    //     而不是又冒出第二张让人不知道该确认哪张。两件不同的草稿请用 key 区分。
    const entriesKey = entries.map((entry) => String(entry?.key ?? '')).join(',')
    const explicitKey = String(record.key ?? '')
    const cardId = `${pack.id}:${String(block)}:${explicitKey || shortHash(entriesKey)}`
    const existing = cards.get(cardId)
    if (existing && existing.state !== 'draft') {
      // 卡片已离开 draft（人确认过／写过／丢过）：**这一版不落进卡片**，也**不算被消费**
      // （复核 F1：把块当已消费 ⇒ 正文被抹掉 + 卡片是旧的 ⇒ 新内容在人眼前彻底消失）。
      // 这里说清「为什么没进卡、这一步该怎么做」，由渲染层一并带出去（原文照显）。
      //
      // 文案按**当前状态**给，且必须与该状态下宿主真肯做的动作一致（复核 R2-2）：
      // `notDraftAdvice` 与 `discard`/`reopen` 的允许态同源，`hostAction` 可被用例逐态核对。
      // 说明里带上**这一版的标题**：它既是「说的是哪一版」的凭据，也让「换了版本」这件事
      // 在签名里真的可见（复核 R2-6：`changed` 不能对 notice 的变化视而不见）。
      const advice = notDraftAdvice(existing.state)
      const version = String(title ?? '').trim() || '未命名'
      return {
        ok: true,
        card: existing,
        updated: false,
        reason: 'card-not-draft',
        advice,
        note:
          `这一版（标题：${version}）没有落进卡片（卡片当前是「${STATE_LABELS[existing.state] ?? existing.state}」）：` +
          `正文里这一段照旧可见，卡片上还是它原来那一版。${advice.text}`,
      }
    }
    // 写这张卡片要用到的**必填字段**由载荷的调用方（渲染层）从声明里取来。
    // 载荷没提到某个必填项时**不是拒绝**，而是把它补成一行空值（显示「等你给」）——
    // 人要能一眼看见「还缺类型」，而不是卡片被藏起来、直到点了确认才发现写不成。
    // 补的行用**声明里的 label**（复核 F6）：界面上的「还缺：类型」要是人话，不是原始键。
    // 只有当这个键连字段分级都没声明过（包自己的模板与分级表对不上）时才拒：那种卡没法造。
    const required = (Array.isArray(requiredFields) ? requiredFields : []).map(String).filter(Boolean)
    for (const key of required) {
      if (fields.some((f) => f.key === key)) continue
      if (!tiers[key]) return { ok: false, reason: 'required-field-not-in-card', detail: key }
      const added = buildField({ key, value: '', label: labelOf(key) }, tiers[key], userMessages)
      if (!added.ok) return { ok: false, reason: added.reason, key: added.key ?? key, detail: added.detail ?? null }
      fields.push(added.field)
    }
    const heading = String(title ?? '')
    const created = existing
      ? { ok: true, card: Object.freeze({ ...existing, fields: Object.freeze(fields), title: heading }) }
      : createPlanCard({ id: cardId, title: heading, fields })
    if (!created.ok) return { ok: false, reason: 'card-invalid', errors: created.errors }
    const card = Object.freeze({ ...created.card, requiredFields: Object.freeze(required) })
    put(card, { updated: Boolean(existing) })
    return { ok: true, card, updated: Boolean(existing) }
  }

  return Object.freeze({
    buildDraft,
    get: (id) => cards.get(String(id ?? '')) ?? null,
    ids: () => Object.freeze([...order]),
    list: () => Object.freeze(order.map((id) => cards.get(id))),
    /** 卡片的只读呈现（界面照着画；不含任何可编辑语义） */
    presentations: () =>
      Object.freeze(
        order.map((id) => {
          const card = cards.get(id)
          return toPresentation(card, { requiredFields: card.requiredFields ?? [] })
        }),
      ),
    /** 人确认：确认人必须由宿主注入（会话主体身份），本模块不认「调用方自报」 */
    confirm: (id, { by = '' } = {}) => {
      const card = cards.get(String(id ?? ''))
      if (!card) return { ok: false, reason: 'card-not-found' }
      const result = confirmCardState(card, { by })
      if (!result.ok) return result
      cards.set(card.id, result.card)
      return result
    },
    /** 重开「确定没写进去」的卡片（回到 draft，人得再确认一次） */
    reopen: (id, { by = '' } = {}) => {
      const card = cards.get(String(id ?? ''))
      if (!card) return { ok: false, reason: 'card-not-found' }
      const result = reopenCardState(card)
      if (!result.ok) return result
      put(result.card, { updated: true })
      return { ok: true, card: result.card }
    },
    discard: (id, { by = '' } = {}) => {
      const card = cards.get(String(id ?? ''))
      if (!card) return { ok: false, reason: 'card-not-found' }
      const result = discardCardState(card, { by })
      if (!result.ok) return result
      cards.set(card.id, result.card)
      return result
    },
    /** 写入结果回填（执行器回来之后由编排层调用） */
    replace: (card) => {
      if (!card?.id || !cards.has(card.id)) return { ok: false, reason: 'card-not-found' }
      cards.set(card.id, card)
      return { ok: true, card }
    },
    needsReconcile: (id) => needsReconcile(cards.get(String(id ?? '')) ?? {}),
    clear: () => {
      cards.clear()
      order.length = 0
    },
  })
}

return Object.freeze({ createPackSession, shortHash, buildField, attestation })
})()

const {
  createPackSession,
  shortHash,
  buildField,
  attestation
} = packSession



const ID = 'plankton-enterprise'
const TOOLS_PATH = '/plankton-tools'
const SKILLS_PATH = '/plankton-skills'

const FAILURE_COPY = {
  'cli-missing': '未找到本机 shaoke-cli（企业副本应位于引擎数据目录的 bin 下）',
  'cli-failed': 'shaoke-cli 执行失败',
  'not-json': 'shaoke-cli 返回了非 JSON 输出',
  'shape-mismatch': 'shaoke-cli 输出结构不符预期（缺少 data.services）'
}

const SKILL_FAILURE_COPY = {
  'cli-missing': '未找到企业副本 shaoke-cli（应位于引擎数据目录的 bin 下）',
  'cli-failed': 'shaoke-cli 执行失败',
  unauthorized: '未授权：请先在 shaoke-cli 自己的终端里完成授权（本应用不代输口令）',
  'network-failed': '网络不可达：无法连接企业 SkillHub（或请求超时）',
  'not-json': 'CLI 输出不是 JSON（格式不符）',
  'shape-mismatch': 'CLI 输出结构不符预期（格式不符：缺少必需字段）',
  'no-bundle': '这条技能在平台上没有可下载的包',
  'download-failed': '下载技能包失败（网络或存储服务不可用）',
  'extract-failed': '技能包解不开或被判定含不安全路径，已拒绝落盘',
  'write-failed': '写入企业侧技能目录失败',
  'needs-confirm': '需要人工确认后才能继续',
  'bad-input': '目录缺少确定落点所需的信息（如技能名）',
  'blocked-personal-dir': '落点被判定为个人环境，已拒绝取用',
  'enterprise-home-unavailable': '企业侧引擎目录不可用，已拒绝取用',
  'hash-unavailable': '内容哈希取不到，判等无法成立',
  'remove-failed': '删除落点失败',
  'engine-refused': '引擎拒绝了这次写入（落点不符合引擎规则：链上有符号链接、与既有技能目录嵌套，或会覆盖分类目录）',
  'blocked-by-scan': '引擎的安装前安全扫描未放行这条技能，已拒绝安装',
  'essential-skill': '这是引擎的必备技能（essential），无法停用',
  'not-effective': '写入未生效：引擎持久化的状态未变成请求的状态',
  'request-failed': '请求失败（网络或后端异常）',
  'no-record': '引擎的取用记录里没有这条技能，本页只卸载引擎记录在案的技能（若记录文件损坏，请见页面顶部的读取失败提示）',
  'local-edits': '本地已修改：磁盘内容与引擎取用记录不一致。继续更新会覆盖并丢失这些改动，需你确认覆盖',
  'unreadable-config': '引擎配置读取失败，启停开关已禁用',
  'engine-unavailable': '引擎技能配置模块不可用，无法改启停',
  // The startup write-path self-check (fail-closed): the skill store's own
  // path chain contains a symbolic link, so a write would land OUTSIDE the store.
  'write-guard-failed': '技能写路径自检未通过（技能路径链含符号链接）：已按 fail-closed 拒绝这次写动作'
}

/** Display state for one catalog entry (semantic source: backend installState). */
const INSTALL_STATE = {
  consistent: { label: '已装 · 一致', tone: 'ok' },
  'version-differs': { label: '已装 · 与目录不一致', tone: 'warn' },
  'version-unknown': { label: '已装 · 版本不可判定', tone: 'info' },
  'record-without-files': { label: '曾取用，本地已不存在', tone: 'warn' },
  disabled: { label: '已装 · 引擎已停用', tone: 'warn' },
  'not-installed': { label: '未装', tone: 'muted' },
  'name-missing': { label: '不能用：目录未提供技能名', tone: 'warn' }
}

const TONE_COLOR = {
  ok: 'var(--ui-success, #3fa66a)',
  warn: 'var(--ui-warning, #d08a00)',
  info: 'var(--ui-text-secondary)',
  muted: 'var(--ui-text-tertiary)'
}

const S = {
  page: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px 20px', overflowY: 'auto', height: '100%', fontSize: '13px' },
  title: { fontSize: '15px', fontWeight: 600, margin: 0 },
  meta: { color: 'var(--ui-text-tertiary)', fontSize: '11px', lineHeight: '16px' },
  card: { border: '1px solid var(--chrome-border, var(--ui-border))', borderRadius: '6px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' },
  row: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '3px 0', borderTop: '1px solid var(--chrome-action-hover, transparent)' },
  toolName: { fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', flexShrink: 0 },
  toolDesc: { color: 'var(--ui-text-secondary)', fontSize: '11px', minWidth: 0 },
  systemName: { fontWeight: 600, fontSize: '12px' },
  systemDesc: { color: 'var(--ui-text-tertiary)', fontSize: '11px' },
  badge: { fontSize: '10px', padding: '0 5px', borderRadius: '999px', border: '1px solid currentColor', flexShrink: 0 },
  center: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '40px 20px', color: 'var(--ui-text-secondary)' },
  notice: { border: '1px solid var(--chrome-border, var(--ui-border))', borderRadius: '6px', padding: '10px 12px', color: 'var(--ui-text-secondary)', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '6px' },
  pre: { fontFamily: 'var(--font-mono, monospace)', fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, color: 'var(--ui-text-tertiary)', maxHeight: '140px', overflowY: 'auto' },
  banner: { borderRadius: '6px', padding: '8px 12px', fontSize: '12px', border: '1px solid' },
  actions: { display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '2px' },
  hash: { fontFamily: 'var(--font-mono, monospace)', fontSize: '10px', color: 'var(--ui-text-tertiary)' }
}

const BANNER_TONE = {
  ok: { color: 'var(--ui-success, #3fa66a)', borderColor: 'var(--ui-success, #3fa66a)' },
  warn: { color: 'var(--ui-warning, #d08a00)', borderColor: 'var(--ui-warning, #d08a00)' },
  error: { color: 'var(--ui-error, #d05a5a)', borderColor: 'var(--ui-error, #d05a5a)' }
}

function riskColor(risk) {
  return risk === 'write' ? 'var(--ui-warning, #d08a00)' : 'var(--ui-text-tertiary)'
}

function ToolRow({ tool }) {
  return jsxs('div', { style: S.row, children: [
    jsx('span', { style: S.toolName, children: tool.full_name || tool.name }),
    jsx('span', { style: { color: riskColor(tool.risk) }, children: jsx('span', { style: S.badge, children: tool.risk || '?' }) }),
    jsx('span', { style: S.toolDesc, children: tool.description || '' })
  ] })
}

function SystemCard({ system }) {
  const tools = Array.isArray(system.tools) ? system.tools : []
  return jsxs('div', { style: S.card, children: [
    jsxs('div', { children: [
      jsx('div', { style: S.systemName, children: system.name }),
      system.description ? jsx('div', { style: S.systemDesc, children: system.description }) : null
    ] }),
    tools.length === 0
      ? jsx('div', { style: S.systemDesc, children: '（该系统未声明工具）' })
      : jsx('div', { children: tools.map((tool, i) => jsx(ToolRow, { tool }, `${system.name}:${i}:${tool.full_name || tool.name}`)) })
  ] })
}

function FailureBox({ data, onRetry, copyMap }) {
  const kind = data && data.kind
  const copy = copyMap || FAILURE_COPY
  return jsxs('div', { style: S.notice, children: [
    jsx('div', { children: `${copy[kind] || '读取失败'}${kind ? ` — ${kind}` : ''}` }),
    data && data.cliPath ? jsx('div', { style: S.meta, children: `CLI: ${data.cliPath}（来源 ${data.cliSource}）` }) : null,
    data && data.note ? jsx('div', { style: S.meta, children: data.note }) : null,
    data && data.error ? jsx('div', { style: S.meta, children: data.error }) : null,
    data && data.detail && data.detail.message ? jsx('div', { style: S.meta, children: String(data.detail.message) }) : null,
    data && data.rawExcerpt ? jsx('pre', { style: S.pre, children: data.rawExcerpt }) : null,
    jsx('div', { children: jsx(Button, { size: 'sm', variant: 'secondary', onClick: onRetry, children: '重试' }) })
  ] })
}

function Banner({ banner }) {
  if (!banner) return null
  return jsx('div', { style: { ...S.banner, ...BANNER_TONE[banner.tone] }, children: banner.text })
}

// ── Tool catalog page ────────────────────────────────────────────────────────

function ToolCatalogPage({ ctx }) {
  const [state, setState] = useState({ phase: 'loading' })

  const load = () => {
    setState({ phase: 'loading' })
    ctx.rest('/tools').then(
      data => setState({ phase: 'ready', data: data || {} }),
      error => setState({ phase: 'error', message: String((error && error.message) || error) })
    )
  }

  useEffect(() => { load() }, [])

  if (state.phase === 'loading') {
    return jsxs('div', { style: S.center, children: [jsx(GlyphSpinner, { ariaLabel: '正在读取' }), jsx('span', { children: '正在读取本机工具目录…' })] })
  }
  if (state.phase === 'error') {
    return jsxs('div', { style: S.notice, children: [
      jsx('div', { children: '读取工具目录失败' }),
      jsx('div', { style: S.meta, children: state.message }),
      jsx('div', { children: jsx(Button, { size: 'sm', variant: 'secondary', onClick: load, children: '重试' }) })
    ] })
  }

  const data = state.data
  if (!data.ok) return jsx(FailureBox, { data, onRetry: load })

  const systems = Array.isArray(data.systems) ? data.systems : []
  const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : ''

  return jsxs('div', { style: S.page, children: [
    jsx('h1', { style: S.title, children: '企业工具目录' }),
    jsxs('div', { style: S.meta, children: [
      `只读 · 无执行入口、无开关 · 共 ${data.count != null ? data.count : systems.length} 个系统`,
      jsx('br', {}),
      `CLI: ${data.cliPath || '未知'}（来源 ${data.cliSource || '未知'}）${when ? ` · ${when}` : ''}`
    ] }),
    systems.length === 0
      ? jsx('div', { style: S.notice, children: 'shaoke-cli 可用，但当前没有声明任何工具系统（空清单是有效结果）。' })
      : jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' }, children: systems.map((system, i) => jsx(SystemCard, { system }, `${i}:${system.name}`)) }),
    jsxs('div', { style: S.meta, children: [
      jsx(icons.Info, { size: 11, style: { verticalAlign: '-1px' } }),
      ' 本页仅列出本机 CLI 的命令清单；授权与执行由 shaoke-cli 自己负责，本应用不读取任何令牌。'
    ] })
  ] })
}

// ── Skill market page ────────────────────────────────────────────────────────

function stateMeta(installState) {
  return INSTALL_STATE[installState] || { label: installState, tone: 'info' }
}

/**
 * Uninstall / enable / disable act on the ENGINE's RECORD (its name and its
 * layout), NOT on the version attestation `installState` displays. Gating them
 * on `installState !== 'version-unknown'` is what made them dead for every real
 * install (the state was pinned at version-unknown by a mis-read version field),
 * and it dead-locks a locally-edited skill too (its hash no longer matches → it
 * is `version-unknown` as well, yet the engine can uninstall it fine).
 * Exported so the gating is asserted by a test instead of by nobody.
 */
export function canManageSkill(skill) {
  const installed =
    Boolean(skill.installState) && skill.installState !== 'not-installed' && skill.installState !== 'name-missing'
  return installed && Boolean(skill.ownedByEngine)
}

/**
 * A BATCH update sends no per-item overwrite acknowledgement, so only skills
 * whose local-edit status is CONFIRMED clean may ride it: a confirmed edit
 * (`localEdits`) would deterministically fail, and a "cannot decide"
 * (`localEditsUnknown`) could silently replace the user's work. Those are
 * updated individually, where the dialog can ask and the answer travels.
 * Exported so the filter is asserted by a test instead of by nobody.
 */
export function canBatchUpdate(skill) {
  return skill.installState === 'version-differs' && !skill.localEdits && !skill.localEditsUnknown
}

/**
 * The read-page notice for the write-path self-check.
 *
 * `writeGuard` is the backend's fail-closed verdict on the skill store's path
 * chain. When it FAILS every write route is refused, so the page must SAY SO
 * loudly (and the action buttons must not pretend otherwise) instead of letting
 * each write fail one by one. Pure and exported so the wording — and the fact
 * that a failing check is VISIBLE, never silent — is asserted directly.
 *
 * Returns `null` when the check passed (or the backend did not report one).
 */
export function writeGuardNotice(writeGuard) {
  if (!writeGuard || writeGuard.ok !== false) return null
  const findings = Array.isArray(writeGuard.findings) ? writeGuard.findings : []
  const lines = findings.map(
    f => `· ${f.message || f.check || '自检未通过'}（${f.check || 'unknown'} @ ${f.layer || f.path || '?'}）`
  )
  return [
    '技能写路径自检未通过：已按 fail-closed 拒绝全部写动作（取用 / 卸载 / 启用 / 停用 / 更新）。',
    '本页的列表与状态仍可读，但在这条问题修好之前，任何写操作都不会被执行。',
    ...lines
  ].join('\n')
}

/**
 * The acknowledgement the confirmation dialog's confirm button SENDS: the write
 * is only allowed to replace a landing whose local-edit status is not confirmed
 * clean when this rides along. Exported (and used by `perform`) so "the page can
 * always answer the backend's `local-edits` refusal" is asserted, not assumed.
 */
export function overwriteLocalEditsFor(skill) {
  return Boolean(skill.localEdits || skill.hashState === 'mismatch' || skill.localEditsUnknown)
}

function SkillRow({ skill, onAction }) {
  const meta = stateMeta(skill.installState)
  const canPickup = Boolean(skill.installPath)
  const installed = skill.installState && skill.installState !== 'not-installed' && skill.installState !== 'name-missing'
  const manage = canManageSkill(skill)
  const disabledKnown = typeof skill.disabled === 'boolean'
  // A landing whose local-edit status is not CONFIRMED clean: the update also
  // needs the human's overwrite acknowledgement (backend: `local-edits`).
  const needsOverwriteAck = Boolean(skill.localEdits || skill.hashState === 'mismatch' || skill.localEditsUnknown)

  return jsxs('div', { style: { ...S.card, gap: '4px' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }, children: [
      jsx('span', { style: { fontWeight: 600 }, children: skill.name || '(未命名)' }),
      skill.category ? jsx('span', { style: { ...S.badge, color: 'var(--ui-text-tertiary)' }, children: skill.category }) : null,
      jsx('span', { style: { ...S.badge, color: TONE_COLOR[meta.tone] }, children: meta.label }),
      needsOverwriteAck ? jsx('span', { style: { ...S.badge, color: TONE_COLOR.warn }, children: skill.localEdits ? '本地已改动' : '是否改动无法判定' }) : null,
      skill.version ? jsx('span', { style: S.meta, children: `目录版本 ${skill.version}` }) : jsx('span', { style: S.meta, children: '目录未给版本' }),
      skill.recordedVersion ? jsx('span', { style: S.meta, children: `记录版本 ${skill.recordedVersion}` }) : null
    ] }),
    jsx('div', { style: { color: 'var(--ui-text-secondary)', fontSize: '11px' }, children: skill.description || '' }),
    jsxs('div', { style: S.meta, children: [
      `作者 ${skill.author || '未标注'}`,
      skill.tags && skill.tags.length ? ` · 标签 ${skill.tags.join('、')}` : '',
      skill.installPath ? ` · 落点 ${skill.installPath}` : ' · 目录未给技能名'
    ] }),
    skill.localHash ? jsx('div', { style: S.hash, children: `本地内容哈希 ${skill.localHash}` }) : null,
    jsx('div', { style: S.actions, children: [
      jsx(Button, { size: 'sm', variant: 'secondary', disabled: !canPickup, onClick: () => onAction(installed ? 'update' : 'install', skill), children: installed ? '更新' : '取用' }),
      installed
        ? jsx(Button, { size: 'sm', variant: 'secondary', disabled: !manage || !disabledKnown, onClick: () => onAction(skill.disabled ? 'enable' : 'disable', skill), children: skill.disabled ? '启用' : '停用' })
        : null,
      installed
        ? jsx(Button, { size: 'sm', variant: 'secondary', disabled: !manage, onClick: () => onAction('uninstall', skill), children: '卸载' })
        : null
    ] })
  ] })
}

function InstalledRow({ item }) {
  const hashLabel = item.hashState === 'mismatch' ? '本地内容哈希（与取用记录不一致）' : '本地内容哈希'
  return jsxs('div', { style: { ...S.card, gap: '4px' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }, children: [
      jsx('span', { style: { fontWeight: 600 }, children: item.name || item.reference || '(未命名)' }),
      item.version ? jsx('span', { style: S.meta, children: `记录版本 ${item.version}` }) : null,
      jsx('span', { style: { ...S.badge, color: item.onDisk ? TONE_COLOR.info : TONE_COLOR.warn }, children: item.onDisk ? '落点存在' : '落点已不在' }),
      item.hashState === 'mismatch' ? jsx('span', { style: { ...S.badge, color: TONE_COLOR.warn }, children: '哈希不符' }) : null
    ] }),
    jsx('div', { style: S.meta, children: `落点 ${item.installPath} · 取用时间 ${item.installedAt || '未知'}${item.uninstalledAt ? ` · 卸载时间 ${item.uninstalledAt}` : ''}` }),
    item.localHash ? jsx('div', { style: S.hash, children: `${hashLabel} ${item.localHash}` }) : null
  ] })
}

/**
 * Fold per-item batch-update outcomes into ONE honest banner (F3).
 *
 * Honest = a failure is never swallowed into "完成": each item's `result.ok` is
 * checked (a backend that answers HTTP 200 with `{ok:false}` still counts as a
 * failure), and a rejected request is recorded as a failure too. Exported so the
 * rejection paths can be exercised directly by a test.
 */
export function summarizeBatchUpdate(results) {
  const list = Array.isArray(results) ? results : []
  const failed = list.filter(entry => !(entry && entry.result && entry.result.ok))
  if (failed.length === 0) {
    return { ok: true, tone: 'ok', text: `批量更新完成（${list.length} 条）。默认在下一个会话生效。` }
  }
  const detail = failed
    .map(entry => {
      const skill = (entry && entry.skill) || {}
      const kind = (entry && entry.result && entry.result.kind) || 'request-failed'
      // Plain language first, machine token in parentheses (the same shape the
      // single-item banner uses). A bare `（local-edits）` left the user with no
      // idea that their own edits were about to be lost.
      const plain = SKILL_FAILURE_COPY[kind] || '操作失败'
      return `${skill.name || skill.installPath || skill.slug || '?'}：${plain}（${kind}）`
    })
    .join('、')
  return {
    ok: false,
    tone: 'error',
    text: `批量更新：成功 ${list.length - failed.length} 条、失败 ${failed.length} 条。失败项：${detail}`
  }
}

/**
 * The confirmation COPY for an install / update (F: a write never fires on the
 * first click; and when the landing holds local edits the dialog names the loss
 * in plain language, never just a hash marker). Exported so the wording — and
 * the destructive flag — can be asserted directly.
 *
 * `localEdits` is the backend's engine-derived fact; `hashState: 'mismatch'` is
 * the same signal computed on the page, so either one turns on the warning.
 */
export function writeConfirmCopy(action, skill) {
  const localEdits = Boolean(skill.localEdits || skill.hashState === 'mismatch')
  // The landing exists but the engine record cannot settle whether it was
  // edited (unreadable/corrupt record, or a record with no hash to compare).
  // Not the same statement as "已修改" — say what is actually known.
  const localEditsUnknown = Boolean(skill.localEditsUnknown) && !localEdits
  // The engine's criterion can answer about the landing its RECORD names, which
  // need not be the landing this write plans to use. When the two differ, say so
  // — otherwise the warning would talk about a directory the user cannot see.
  const recordElsewhere = Boolean(
    skill.recordInstallPath && skill.installPath && skill.recordInstallPath !== skill.installPath
  )
  return {
    localEdits,
    localEditsUnknown,
    title: action === 'update' ? `更新技能「${skill.name}」？` : `取用技能「${skill.name}」？`,
    description:
      (localEdits
        ? `⚠ 本地已修改：磁盘上的内容与引擎取用记录里的哈希不一致。继续会覆盖并丢失这些本地改动。`
        : localEditsUnknown
        ? `⚠ 无法判定本地是否有改动：引擎取用记录里没有这条技能、读不出（损坏或不可读），或记录里没有可比对的内容哈希，而该落点已存在内容。继续可能覆盖并丢失本地改动。`
        : '') +
      (recordElsewhere ? `（该技能在引擎取用记录里的落点是 ${skill.recordInstallPath}，与本次计划落点不同。）` : '') +
      `将从平台重新下载技能包，并交给引擎自己的安装入口落盘（引擎负责落点、安全扫描与文件语义）。落点：${skill.installPath}。` +
      (skill.onDisk && !skill.ownedByEngine
        ? `注意：该落点已被一个非引擎取用记录在案的目录占用，引擎会整体替换它。`
        : '') +
      `企业侧技能目录之外的任何内容都不会被改动。`,
    destructive: localEdits || localEditsUnknown
  }
}

function SkillMarketPage({ ctx }) {
  const [state, setState] = useState({ phase: 'loading' })
  const [query, setQuery] = useState('')
  const [banner, setBanner] = useState(null)
  const [confirm, setConfirm] = useState(null)

  const load = () => {
    setState({ phase: 'loading' })
    ctx.rest('/skills').then(
      data => setState({ phase: 'ready', data: data || {} }),
      error => setState({ phase: 'error', message: String((error && error.message) || error) })
    )
  }

  useEffect(() => { load() }, [])

  const call = (path, body) => ctx.rest(path, { method: 'POST', body })

  // A failed write reports its typed reason; when the engine's install record
  // could not be read, that note rides along so a "no-record" is never read as
  // "you never installed anything".
  const describeResult = (kind, result) => {
    if (result && result.ok) return null
    const k = (result && result.kind) || kind
    const note = result && result.detail && result.detail.lockNote
    return `${SKILL_FAILURE_COPY[k] || '操作失败'} — ${k}${note ? `（引擎取用记录读取失败：${note}）` : ''}`
  }

  // Every write funnels through here AFTER a confirmation dialog.
  const perform = (action, skill) => {
    const payload = {
      slug: skill.slug || '',
      reference: skill.reference || '',
      name: skill.name || '',
      category: skill.category || '',
      version: skill.version || '',
      confirm: true,
      // The dialog above warns in plain language when local edits exist (or when
      // the engine record cannot settle that); this is the explicit
      // acknowledgement the backend requires before it overwrites them (it
      // refuses with `local-edits` otherwise).
      overwriteLocalEdits: overwriteLocalEditsFor(skill)
    }
    const endpoint = action === 'install' ? '/skills/install' : action === 'update' ? '/skills/update' : null
    if (endpoint) {
      return call(endpoint, payload).then(result => {
        setBanner(result && result.ok
          ? { tone: 'ok', text: `${action === 'update' ? '已更新' : '已取用'}到企业侧技能目录：${result.target}（${result.files} 个文件）；内容哈希 ${result.localHash}。由引擎完成落盘（${result.engine}）。${result.replaced ? '已覆盖既有落点。' : ''}默认在下一个会话生效。` }
          : { tone: 'error', text: describeResult(action, result) })
        load()
      }, error => { setBanner({ tone: 'error', text: String((error && error.message) || error) }); load() })
    }
    if (action === 'uninstall') {
      return call('/skills/uninstall', { reference: skill.reference || '', installPath: skill.installPath || '', confirm: true }).then(result => {
        setBanner(result && result.ok
          ? { tone: 'ok', text: result.removed ? `已由引擎删除落点 ${result.installPath}（引擎取用记录一并移除）。` : '引擎里这条技能已不在落点上，取用记录已移除。' }
          : { tone: 'error', text: describeResult(action, result) })
        load()
      }, error => { setBanner({ tone: 'error', text: String((error && error.message) || error) }); load() })
    }
    // enable / disable → engine's own state
    const path = action === 'enable' ? '/skills/enable' : '/skills/disable'
    return call(path, { name: skill.name || '', enabled: action === 'enable', confirm: true }).then(result => {
      setBanner(result && result.ok
        ? { tone: 'ok', text: `${action === 'enable' ? '已从引擎的停用清单里移出。' : '已写进引擎的停用清单（config.yaml）。'}默认在下一个会话生效。` }
        : { tone: 'error', text: describeResult(action, result) })
      load()
    }, error => { setBanner({ tone: 'error', text: String((error && error.message) || error) }); load() })
  }

  // Human confirmation is required for EVERY write; batch update is explicit.
  const requestAction = (action, skill) => {
    // The write-path self-check refused the whole write surface: say so ONCE,
    // loudly, instead of opening a dialog that can only fail.
    const guard = state.data && state.data.writeGuard
    if (guard && guard.ok === false) {
      setBanner({ tone: 'error', text: writeGuardNotice(guard) })
      return
    }
    if (action === 'enable' || action === 'disable') {
      setConfirm({
        title: `${action === 'enable' ? '启用' : '停用'}技能「${skill.name}」？`,
        description: action === 'enable'
          ? '将从引擎的停用清单（config.yaml 的 skills.disabled）里移出这条技能，下次会话生效。'
          : '将把这条技能写进引擎的停用清单（config.yaml 的 skills.disabled），下次会话不再加载。',
        destructive: false,
        run: () => perform(action, skill)
      })
      return
    }
    if (action === 'uninstall') {
      setConfirm({
        title: `卸载技能「${skill.name}」？`,
        description: `将调用引擎自己的卸载入口删除落点目录 ${skill.installPath}，引擎的取用记录一并移除。此操作不可撤销。`,
        destructive: true,
        run: () => perform('uninstall', skill)
      })
      return
    }
    const copy = writeConfirmCopy(action, skill)
    setConfirm({
      title: copy.title,
      description: copy.description,
      destructive: copy.destructive,
      run: () => perform(action, skill)
    })
  }

  const requestBatchUpdate = (skills) => {
    setConfirm({
      title: `批量更新 ${skills.length} 条技能？`,
      description: `将依次重新下载并覆盖以下落点：${skills.map(s => s.installPath || s.name).join('、')}。批量写入不会静默执行，需你在此确认。`,
      destructive: false,
      run: () => {
        // Sequential on purpose. EACH item's outcome (a resolved `{ok:false}`
        // OR a rejected request) is recorded, so the aggregate banner is
        // honest: a partial failure is never reported as "完成" (F3).
        const results = []
        return skills
          .reduce(
            (chain, skill) =>
              chain.then(() =>
                call('/skills/update', {
                  slug: skill.slug || '',
                  reference: skill.reference || '',
                  name: skill.name || '',
                  category: skill.category || '',
                  version: skill.version || '',
                  confirm: true
                }).then(
                  result => { results.push({ skill, result }) },
                  error => {
                    results.push({
                      skill,
                      result: { ok: false, kind: 'request-failed', detail: { message: String((error && error.message) || error) } }
                    })
                  }
                )
              ),
            Promise.resolve()
          )
          .then(() => {
            setBanner(summarizeBatchUpdate(results))
            load()
          })
      }
    })
  }

  if (state.phase === 'loading') {
    return jsxs('div', { style: S.center, children: [jsx(GlyphSpinner, { ariaLabel: '正在读取' }), jsx('span', { children: '正在读取企业技能市场…' })] })
  }
  if (state.phase === 'error') {
    return jsxs('div', { style: S.notice, children: [
      jsx('div', { children: '读取技能市场失败' }),
      jsx('div', { style: S.meta, children: state.message }),
      jsx('div', { children: jsx(Button, { size: 'sm', variant: 'secondary', onClick: load, children: '重试' }) })
    ] })
  }

  const data = state.data
  if (!data.ok) return jsx(FailureBox, { data, onRetry: load, copyMap: SKILL_FAILURE_COPY })

  const all = Array.isArray(data.skills) ? data.skills : []
  const installedLedger = Array.isArray(data.installed) ? data.installed : []
  const catalog = data.catalog || { ok: false, kind: 'unknown' }
  const disabledNotice = data.disabled && data.disabled.ok === false ? data.disabled : null
  // The engine's own lock swallows a corrupt read into its empty shape, so the
  // backend PROBES the file and hands us a note. Rendered explicitly: without
  // it, a corrupt record would read as "0 条" = "you never installed anything".
  const lockNote = typeof data.lockNote === 'string' && data.lockNote ? data.lockNote : null
  // The fail-closed write-path self-check verdict. Rendered prominently: while it
  // fails, EVERY write action is refused by the backend (and gated here too), so
  // the page must show WHY instead of failing writes one click at a time.
  const guardNotice = writeGuardNotice(data.writeGuard)
  const q = query.trim().toLowerCase()
  const skills = q
    ? all.filter(s => `${s.name} ${s.slug} ${s.category} ${s.description} ${(s.tags || []).join(' ')}`.toLowerCase().includes(q))
    : all
  // A skill whose local-edit status is not CONFIRMED clean must never ride the
  // batch: the batch sends no per-item overwrite acknowledgement, so those are
  // exactly the items a batch would silently replace — or, when the drift is
  // already confirmed, deterministically fail on. They stay out until the user
  // opens them individually (the dialog is the one place that CAN ask, and whose
  // answer travels as `overwriteLocalEdits`).
  const batchNeedsAck = all.filter(s => s.installState === 'version-differs' && !canBatchUpdate(s))
  const updatable = all.filter(canBatchUpdate)
  const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : ''

  return jsxs('div', { style: S.page, children: [
    jsx('h1', { style: S.title, children: '企业技能市场' }),
    jsxs('div', { style: S.meta, children: [
      `来源：企业 SkillHub（经 shaoke-cli skillhub）· 已审技能 ${catalog.ok ? catalog.count : '—'} 条 · 引擎取用记录 ${lockNote ? '读取失败（见下方提示，非“从未装过”）' : `${installedLedger.length} 条`}`,
      jsx('br', {}),
      `CLI: ${data.cliPath || '未知'}（来源 ${data.cliSource || '未知'}）· 技能落点 ${data.skillsPath || '未知'}${when ? ` · ${when}` : ''}`
    ] }),
    jsx(Banner, { banner }),

    // The write-path self-check is INDEPENDENTLY visible (fail-closed): a
    // redirected store root or install record must never be a silent fact.
    guardNotice
      ? jsx('div', {
          style: { ...S.notice, borderColor: 'var(--ui-error, #d05a5a)', whiteSpace: 'pre-wrap' },
          children: guardNotice
        })
      : null,

    // A corrupt/unreadable engine record is INDEPENDENTLY visible and never
    // collapsed into the empty list ("0 条"). Uninstall also surfaces it.
    lockNote
      ? jsxs('div', { style: { ...S.notice, borderColor: 'var(--ui-error, #d05a5a)' }, children: [
          jsx('div', { children: '引擎取用记录读取失败/已损坏：下方「本机已取用」显示为 0 条，是「读不到记录」，不是「从未装过」；此时卸载会报“记录里没有”，更新也会按「无法判定本地是否有改动」处理，必须显式确认覆盖（不会静默替换），这类技能也不会进入批量更新。' }),
          jsx('div', { style: S.meta, children: lockNote })
        ] })
      : null,

    // Catalog failure is INDEPENDENT of the local install facts: it is shown
    // here and never collapses the page into "no skills".
    catalog.ok
      ? jsx('div', { style: S.meta, children: '企业已审技能目录已就绪。' })
      : jsxs('div', { style: { ...S.notice, borderColor: 'var(--ui-warning, #d08a00)' }, children: [
          jsx('div', { children: `${SKILL_FAILURE_COPY[catalog.kind] || '目录读取失败'} — ${catalog.kind}` }),
          jsx('div', { style: S.meta, children: '这是「取不到目录」，不是「目录为空」。本机已装技能仍列在下方。' }),
          catalog.detail && catalog.detail.raw ? jsx('pre', { style: S.pre, children: catalog.detail.raw }) : null
        ] }),

    // F6: a catalog capped at the page limit is SUCCESS but NOT the whole
    // catalog — say so instead of silently presenting a truncated list.
    catalog.ok && catalog.truncated
      ? jsx('div', { style: { ...S.notice, borderColor: 'var(--ui-warning, #d08a00)' }, children: `目录已达分页上限（${catalog.pages} 页 × 每页 ${catalog.pageSize} 条 = 共 ${catalog.count} 条），结果已截断——上面列出的不是全量已审技能。` })
      : null,
    data.personalCliPath ? jsx('div', { style: S.meta, children: `PATH 上存在同名 CLI（个人副本）${data.personalCliPath}，已按企业口径忽略。` }) : null,

    disabledNotice
      ? jsx('div', { style: { ...S.notice, borderColor: 'var(--ui-warning, #d08a00)' }, children: `引擎停用清单读取失败（${disabledNotice.kind || 'unknown'}），启停开关已禁用，改动不会被静默执行。` })
      : null,

    catalog.ok
      ? jsx('div', { children: jsx(SearchField, { placeholder: '检索技能名 / 分类 / 标签…', value: query, onChange: setQuery, ariaLabel: '检索技能' }) })
      : null,

    updatable.length > 0
      ? jsx('div', { children: jsx(Button, { size: 'sm', variant: 'secondary', onClick: () => requestBatchUpdate(updatable), children: `批量更新 ${updatable.length} 条（需确认）` }) })
      : null,

    // Skills kept out of the batch are named — a silently shrunken button would
    // read as "there was nothing else to update".
    batchNeedsAck.length > 0
      ? jsx('div', { style: { ...S.notice, borderColor: 'var(--ui-warning, #d08a00)' }, children: `以下技能不能进批量更新（批量不带逐项覆盖确认），请逐条更新并在确认框里明确是否覆盖：${batchNeedsAck.map(s => `${s.name || s.installPath || s.slug || '?'}（${s.localEdits ? '本地已改动' : '是否改动无法判定'}）`).join('、')}` })
      : null,

    catalog.ok && all.length === 0
      ? jsx('div', { style: S.notice, children: '企业 SkillHub 当前没有已审技能（空目录是有效结果）。' })
      : null,
    catalog.ok && all.length > 0 && skills.length === 0
      ? jsx('div', { style: S.notice, children: `没有匹配「${query}」的技能（共 ${all.length} 条）。` })
      : null,

    skills.length > 0
      ? jsx('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' }, children: skills.map((skill, i) => jsx(SkillRow, { skill, onAction: requestAction }, `${i}:${skill.reference || skill.slug}`)) })
      : null,

    installedLedger.length > 0
      ? jsxs('div', { style: { display: 'flex', flexDirection: 'column', gap: '10px' }, children: [
          jsx('h2', { style: { ...S.title, fontSize: '13px' }, children: '本机已取用（引擎台账）' }),
          installedLedger.map((item, i) => jsx(InstalledRow, { item }, `ledger:${i}:${item.reference || item.installPath}`))
        ] })
      : null,

    // The confirmation dialog. EVERY write is routed through it — a write never
    // fires on the first click. `onConfirm` runs the already-chosen action.
    confirm
      ? jsx(ConfirmDialog, {
          open: true,
          onClose: () => setConfirm(null),
          onConfirm: () => Promise.resolve(confirm.run()).then(() => setConfirm(null)),
          title: confirm.title,
          description: confirm.description,
          destructive: Boolean(confirm.destructive),
          confirmLabel: '确认',
          cancelLabel: '取消'
        })
      : null,

    jsxs('div', { style: S.meta, children: [
      jsx(icons.Info, { size: 11, style: { verticalAlign: '-1px' } }),
      ' 安装/卸载/更新全部交由引擎自己的技能管理入口执行，落点、扫描与文件语义由引擎负责；本页只做参数校验、人工确认与如实回显。技能哈希与引擎同源（引擎 tools.skills_guard.content_hash），取用记录就是引擎的 skills/.hub/lock.json。「停用」写的是引擎自己的启用态（config.yaml 的 skills.disabled）。所有写动作都需人工确认；本应用不读取任何令牌。'
    ] })
  ] })
}

export default {
  id: ID,
  name: '企业技能与工具',
  description: '企业已审技能市场（安装/卸载/启停/更新 + 版本对照 + 哈希）与本机工具目录（只读）。',
  defaultEnabled: true,
  register(ctx) {
    ctx.registerMany([
      {
        id: 'tools-page',
        area: 'routes',
        title: '企业工具',
        order: 40,
        data: { path: TOOLS_PATH },
        render: () => jsx(ToolCatalogPage, { ctx })
      },
      {
        id: 'tools-nav',
        area: 'sidebar.nav',
        order: 40,
        data: { codicon: 'tools', label: '企业工具', path: TOOLS_PATH }
      },
      {
        id: 'skills-page',
        area: 'routes',
        title: '企业技能',
        order: 41,
        data: { path: SKILLS_PATH },
        render: () => jsx(SkillMarketPage, { ctx })
      },
      {
        id: 'skills-nav',
        area: 'sidebar.nav',
        order: 41,
        data: { codicon: 'extensions', label: '企业技能', path: SKILLS_PATH }
      }
    ])
  }
}

export {
  RENDER_PRIMITIVES,
  OUTPUT_RECORD_KINDS,
  PAYLOAD_KEYS,
  ENTRY_KEYS,
  readOutputs,
  isLosslessValue,
  resolveOutput,
  resolveAction,
  FIELD_ROLES,
  LAYOUT_TOKENS,
  findLayoutTokens,
  dueInfo,
  recordTitle,
  collectionStats,
  presentOutput,
  outletOf,
  evidenceOk,
  SHAPES,
  readPage,
  pick,
  listValueOptions,
  CARD_STATES,
  FIELD_TIERS,
  HUMAN_TIERS,
  STATE_LABELS,
  TIER_LABELS,
  NEEDS_RECONCILE,
  needsReconcile,
  notDraftAdvice,
  NOT_DRAFT_ADVICE,
  RESEND_AS_NEW_BLOCK_ADVICE,
  discard,
  reopen,
  markWriteUnknown,
  markPartial,
  markDuplicateRisk,
  createPlanCard,
  awaitingHumanFields,
  providedHumanFields,
  assertNoAgentFilledHumanFields,
  confirm,
  assertWritable,
  markWritten,
  markFailed,
  toParams,
  toPresentation,
  PACK_CONTRACT_ITEMS,
  validateDeclaration,
  createPackRegistry,
  askBroadcast,
  createPackSession,
  shortHash,
  buildField,
  attestation,
  renderProtocol,
  presentation,
  readSide,
  planCard,
  packRegistry,
  packSession
}
