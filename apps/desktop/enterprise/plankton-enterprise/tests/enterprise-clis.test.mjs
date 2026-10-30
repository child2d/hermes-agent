import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { jsx } from 'react/jsx-runtime'
import { renderToStaticMarkup } from 'react-dom/server'

// Compile the actual runtime module; never assert the shape of its source text.
async function loadPlugin(t) {
  const here = path.dirname(fileURLToPath(import.meta.url))
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'enterprise-cli-ui-'))
  t.after(() => fs.rm(dir, { recursive: true, force: true }))
  const file = path.join(dir, 'plugin.mjs')
  await build({
    entryPoints: [path.join(here, '../desktop/plugin.js')], outfile: file,
    bundle: true, platform: 'node', format: 'esm', logLevel: 'silent',
    plugins: [{ name: 'test-sdk', setup(builder) {
      builder.onResolve({ filter: /^@hermes\/plugin-sdk$/ }, () => ({ path: 'sdk', namespace: 'test-sdk' }))
      builder.onLoad({ filter: /.*/, namespace: 'test-sdk' }, () => ({ resolveDir: path.resolve(here, '../../..'), contents: `
        import { createElement as h } from 'react';
        const primitive = p => h('div', null, p.title, p.subtitle, p.actions, p.children);
        export const CAPABILITIES_TABS_AREA = 'capabilities.tabs';
        export const Button=primitive, CardGrid=primitive, ConfirmDialog=primitive, EntityCard=primitive,
          PanelAction=primitive, PanelBlock=primitive, PanelBody=primitive, PanelDetail=primitive,
          PanelEmpty=primitive, PanelHeader=primitive, PanelList=primitive, PanelListRow=primitive,
          PanelPill=primitive, PanelSectionLabel=primitive, SearchField=primitive;
        export const PanelMeta = p => h('dl', null, p.rows.map((r,i) => h('div',{key:i},r.label,': ',r.value)));
      ` }))
    } }]
  })
  return import(pathToFileURL(file).href)
}

test('CLI surface renders both identities, system/bundled status, versions and help without executing commands', async t => {
  const { EnterpriseCliStatus } = await loadPlugin(t)
  let retries = 0
  const state = { phase: 'ready', tools: [
    { id: 'aliyun-cli', available: true, source: 'system', version: 'cloud-test-version', path: '/system/aliyun', command: 'aliyun --help' },
    { id: 'lark-cli', available: true, source: 'app', version: 'lark-test-version', path: '/profile/bin/lark-cli', command: 'lark-cli --help' }
  ] }
  const markup = renderToStaticMarkup(jsx(EnterpriseCliStatus, { state, onRetry: () => { retries++ } }))
  for (const text of ['阿里云 CLI', '飞书 / Lark CLI', '复用系统安装', '使用随包安装', 'cloud-test-version', 'lark-test-version', 'aliyun --help', 'lark-cli --help']) assert.ok(markup.includes(text), text)
  assert.equal(retries, 0)
  const element = EnterpriseCliStatus({ state, onRetry: () => { retries++ } })
  element.props.children[0].props.actions.props.onClick()
  assert.equal(retries, 1)
})

test('missing CLI, request failure and loading remain visible, never rendered as an empty successful catalog', async t => {
  const { EnterpriseCliStatus } = await loadPlugin(t)
  const render = state => renderToStaticMarkup(jsx(EnterpriseCliStatus, { state, onRetry() {} }))
  const markup = render({ phase: 'ready', tools: [
    { id: 'aliyun-cli', available: false, error: '<probe failed>', command: 'aliyun --help' },
    { id: 'lark-cli', available: true, source: 'app', version: 'lark-ok', path: '/profile/bin/lark-cli', command: 'lark-cli --help' }
  ] })
  assert.match(markup, /不可用/)
  assert.match(markup, /&lt;probe failed&gt;/)
  assert.match(markup, /lark-ok/)
  assert.match(render({ phase: 'error', message: 'request failed' }), /role="alert"/)
  assert.match(render({ phase: 'error', message: 'request failed' }), /request failed/)
  assert.match(render({ phase: 'loading' }), /正在检测阿里云与飞书 CLI/)
})
