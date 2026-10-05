/**
 * plankton-enterprise — the desktop half.
 *
 * Delivered through the STANDALONE desktop-plugin door
 * (`<HERMES_HOME>/desktop-plugins/plankton-enterprise/plugin.js`), NOT the
 * unified-package half (`<HERMES_HOME>/plugins/<name>/desktop/plugin.js`).
 *
 * WHY: the unified-agent-package half is materialized by Electron into the app
 * root WITH a `.hermes-package.json` marker, and the runtime loader caps a
 * marked entry at `defaultEnabled: false` — "installed but inert" (the same
 * posture `~/.hermes/plugins` keeps, GHSA-mcfc-hp25-cjv7). The enable decision
 * for such a plugin lives in the renderer's localStorage, which a first launch
 * cannot seed from the main process. The standalone door has no marker, so it
 * is default-ON and loads on the very first launch. See
 * PLANKTON-MIGRATION-BATCH2.md (card point 1) for the empirical check.
 *
 * READ-ONLY: it lists the local `shaoke-cli` catalog through its own backend
 * namespace (`ctx.rest('/tools')` → `/api/plugins/plankton-enterprise/tools`).
 * No per-tool action, no enable/disable switch, no credential access.
 *
 * Plain ESM + `jsx()` calls — exactly the shape the runtime loader evaluates.
 */

import { Button, GlyphSpinner, icons } from '@hermes/plugin-sdk'
import { useEffect, useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const ID = 'plankton-enterprise'
const TOOLS_PATH = '/plankton-tools'

const FAILURE_COPY = {
  'cli-missing': '未找到本机 shaoke-cli（企业副本应位于引擎数据目录的 bin 下）',
  'cli-failed': 'shaoke-cli 执行失败',
  'not-json': 'shaoke-cli 返回了非 JSON 输出',
  'shape-mismatch': 'shaoke-cli 输出结构不符预期（缺少 data.services）'
}

const S = {
  page: { display: 'flex', flexDirection: 'column', gap: '12px', padding: '16px 20px', overflowY: 'auto', height: '100%', fontSize: '13px' },
  title: { fontSize: '15px', fontWeight: 600, margin: 0 },
  meta: { color: 'var(--ui-text-tertiary)', fontSize: '11px', lineHeight: '16px' },
  card: { border: '1px solid var(--chrome-border, var(--ui-border))', borderRadius: '6px', padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: '8px' },
  systemName: { fontWeight: 600, fontSize: '12px' },
  systemDesc: { color: 'var(--ui-text-tertiary)', fontSize: '11px' },
  row: { display: 'flex', alignItems: 'baseline', gap: '8px', padding: '3px 0', borderTop: '1px solid var(--chrome-action-hover, transparent)' },
  toolName: { fontFamily: 'var(--font-mono, monospace)', fontSize: '11px', flexShrink: 0 },
  toolDesc: { color: 'var(--ui-text-secondary)', fontSize: '11px', minWidth: 0 },
  badge: { fontSize: '10px', padding: '0 5px', borderRadius: '999px', border: '1px solid currentColor', flexShrink: 0 },
  center: { display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: '10px', padding: '40px 20px', color: 'var(--ui-text-secondary)' },
  notice: { border: '1px solid var(--chrome-border, var(--ui-border))', borderRadius: '6px', padding: '10px 12px', color: 'var(--ui-text-secondary)', fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '6px' },
  pre: { fontFamily: 'var(--font-mono, monospace)', fontSize: '10px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', margin: 0, color: 'var(--ui-text-tertiary)', maxHeight: '140px', overflowY: 'auto' }
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

function FailureBox({ data, onRetry }) {
  const kind = data && data.kind
  return jsxs('div', { style: S.notice, children: [
    jsx('div', { children: `${FAILURE_COPY[kind] || '读取失败'}${kind ? ` — ${kind}` : ''}` }),
    data && data.cliPath ? jsx('div', { style: S.meta, children: `CLI: ${data.cliPath}（来源 ${data.cliSource}）` }) : null,
    data && data.note ? jsx('div', { style: S.meta, children: data.note }) : null,
    data && data.rawExcerpt ? jsx('pre', { style: S.pre, children: data.rawExcerpt }) : null,
    jsx('div', { children: jsx(Button, { size: 'sm', variant: 'secondary', onClick: onRetry, children: '重试' }) })
  ] })
}

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

  if (!data.ok) {
    return jsx(FailureBox, { data, onRetry: load })
  }

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

export default {
  id: ID,
  name: '企业工具',
  description: '本机 shaoke-cli 工具目录（只读）——无执行入口、无开关。',
  // Explicit: the standalone door has no marker, so this is the effective
  // default AND the value the user's toggle would override. Loads on first launch.
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
      }
    ])
  }
}
