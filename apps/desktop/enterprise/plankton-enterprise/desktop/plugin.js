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
 *   * No credential is read: the backend runs credential-free CLI commands and
 *     never touches ``~/.shaoke/tokens.json``.
 *
 * Plain ESM + `jsx()` calls — exactly the shape the runtime loader evaluates.
 */

import { Button, ConfirmDialog, GlyphSpinner, SearchField, icons } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

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
  'unsafe-path': '记录的落点不在技能目录内，已拒绝',
  'no-record': '台账里没有这条取用记录，本模块只管理自己取用过的技能',
  'unreadable-config': '引擎配置读取失败，启停开关已禁用',
  'engine-unavailable': '引擎技能配置模块不可用，无法改启停'
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

function SkillRow({ skill, onAction }) {
  const meta = stateMeta(skill.installState)
  const canPickup = Boolean(skill.installPath)
  const installed = skill.installState && skill.installState !== 'not-installed' && skill.installState !== 'name-missing'
  // Only skills this app installed (a record) get manage actions; the engine's
  // disabled flag must be known (not null) to offer a toggle.
  const manage = installed && skill.recordedVersion !== undefined && skill.installState !== 'version-unknown'
  const disabledKnown = typeof skill.disabled === 'boolean'

  return jsxs('div', { style: { ...S.card, gap: '4px' }, children: [
    jsxs('div', { style: { display: 'flex', alignItems: 'baseline', gap: '8px', flexWrap: 'wrap' }, children: [
      jsx('span', { style: { fontWeight: 600 }, children: skill.name || '(未命名)' }),
      skill.category ? jsx('span', { style: { ...S.badge, color: 'var(--ui-text-tertiary)' }, children: skill.category }) : null,
      jsx('span', { style: { ...S.badge, color: TONE_COLOR[meta.tone] }, children: meta.label }),
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

  const describeResult = (kind, result) => {
    if (result && result.ok) return null
    const k = (result && result.kind) || kind
    return `${SKILL_FAILURE_COPY[k] || '操作失败'} — ${k}`
  }

  // Every write funnels through here AFTER a confirmation dialog.
  const perform = (action, skill) => {
    const payload = {
      slug: skill.slug || '',
      reference: skill.reference || '',
      name: skill.name || '',
      category: skill.category || '',
      version: skill.version || '',
      confirm: true
    }
    const endpoint = action === 'install' ? '/skills/install' : action === 'update' ? '/skills/update' : null
    if (endpoint) {
      return call(endpoint, payload).then(result => {
        setBanner(result && result.ok
          ? { tone: 'ok', text: `${action === 'update' ? '已更新' : '已取用'}到企业侧技能目录：${result.target}（${result.files} 个文件）；内容哈希 ${result.localHash}。默认在下一个会话生效。` }
          : { tone: 'error', text: describeResult(action, result) })
        load()
      }, error => { setBanner({ tone: 'error', text: String((error && error.message) || error) }); load() })
    }
    if (action === 'uninstall') {
      return call('/skills/uninstall', { reference: skill.reference || '', installPath: skill.installPath || '', confirm: true }).then(result => {
        setBanner(result && result.ok
          ? { tone: 'ok', text: result.removed ? `已删掉落点：${result.target}。台账记录保留。` : '落点本来就不在了，记录已更新。' }
          : { tone: 'error', text: describeResult(action, result) })
        load()
      }, error => { setBanner({ tone: 'error', text: String((error && error.message) || error) }); load() })
    }
    // enable / disable → engine's own state
    const path = action === 'enable' ? '/skills/enable' : '/skills/disable'
    return call(path, { name: skill.name || '', enabled: action === 'enable' }).then(result => {
      setBanner(result && result.ok
        ? { tone: 'ok', text: `${action === 'enable' ? '已从引擎的停用清单里移出。' : '已写进引擎的停用清单（config.yaml）。'}默认在下一个会话生效。` }
        : { tone: 'error', text: describeResult(action, result) })
      load()
    }, error => { setBanner({ tone: 'error', text: String((error && error.message) || error) }); load() })
  }

  // Human confirmation is required for EVERY write; batch update is explicit.
  const requestAction = (action, skill) => {
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
        description: `将删除落点目录 ${skill.installPath}。台账记录保留（仍能看到谁在什么时候取用过）。此操作不可撤销。`,
        destructive: true,
        run: () => perform('uninstall', skill)
      })
      return
    }
    setConfirm({
      title: action === 'update' ? `更新技能「${skill.name}」？` : `取用技能「${skill.name}」？`,
      description: `将从平台重新下载并覆盖落点 ${skill.installPath}。企业侧技能目录之外的任何内容都不会被改动。`,
      destructive: false,
      run: () => perform(action, skill)
    })
  }

  const requestBatchUpdate = (skills) => {
    setConfirm({
      title: `批量更新 ${skills.length} 条技能？`,
      description: `将依次重新下载并覆盖以下落点：${skills.map(s => s.installPath || s.name).join('、')}。批量写入不会静默执行，需你在此确认。`,
      destructive: false,
      run: () =>
        // Sequential on purpose: one failure must not abort the rest silently —
        // each result is folded into a single, honest banner.
        skills.reduce(
          (chain, skill) => chain.then(() => call('/skills/update', {
            slug: skill.slug || '',
            reference: skill.reference || '',
            name: skill.name || '',
            category: skill.category || '',
            version: skill.version || '',
            confirm: true
          })),
          Promise.resolve()
        ).then(() => { setBanner({ tone: 'ok', text: `批量更新完成（${skills.length} 条）。默认在下一个会话生效。` }); load() })
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
  const q = query.trim().toLowerCase()
  const skills = q
    ? all.filter(s => `${s.name} ${s.slug} ${s.category} ${s.description} ${(s.tags || []).join(' ')}`.toLowerCase().includes(q))
    : all
  const updatable = all.filter(s => s.installState === 'version-differs')
  const when = data.fetchedAt ? new Date(data.fetchedAt).toLocaleString() : ''

  return jsxs('div', { style: S.page, children: [
    jsx('h1', { style: S.title, children: '企业技能市场' }),
    jsxs('div', { style: S.meta, children: [
      `来源：企业 SkillHub（经 shaoke-cli skillhub）· 已审技能 ${catalog.ok ? catalog.count : '—'} 条 · 本机台账 ${installedLedger.length} 条`,
      jsx('br', {}),
      `CLI: ${data.cliPath || '未知'}（来源 ${data.cliSource || '未知'}）· 技能落点 ${data.skillsPath || '未知'}${when ? ` · ${when}` : ''}`
    ] }),
    jsx(Banner, { banner }),

    // Catalog failure is INDEPENDENT of the local install facts: it is shown
    // here and never collapses the page into "no skills".
    catalog.ok
      ? jsx('div', { style: S.meta, children: '企业已审技能目录已就绪。' })
      : jsxs('div', { style: { ...S.notice, borderColor: 'var(--ui-warning, #d08a00)' }, children: [
          jsx('div', { children: `${SKILL_FAILURE_COPY[catalog.kind] || '目录读取失败'} — ${catalog.kind}` }),
          jsx('div', { style: S.meta, children: '这是「取不到目录」，不是「目录为空」。本机已装技能仍列在下方。' }),
          catalog.detail && catalog.detail.raw ? jsx('pre', { style: S.pre, children: catalog.detail.raw }) : null
        ] }),
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
          jsx('h2', { style: { ...S.title, fontSize: '13px' }, children: '本机已取用（台账）' }),
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
      ' 技能哈希与引擎同源（引擎 tools.skills_guard.content_hash）。「停用」写的是引擎自己的启用态（config.yaml 的 skills.disabled）。所有写动作都需人工确认；本应用不读取任何令牌。'
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
