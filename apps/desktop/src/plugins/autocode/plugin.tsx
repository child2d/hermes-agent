/**
 * AutoCode — sidebar module that embeds the local AutoCode orchestration UI
 * (D:/codeup/autoCode, default http://127.0.0.1:5173) inside Hermes Desktop /
 * Plankton. Bundled discovery picks up `plugins/autocode/plugin.tsx` automatically.
 */

import {
  host,
  type HermesPlugin,
  PALETTE_AREA,
  type PaletteContribution,
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@hermes/plugin-sdk'

import { AUTOCODE_LOCALES } from './i18n'
import { AutoCodePage } from './page'
import { DEFAULT_URL, ID, PATH, URL_STORAGE_KEY } from './shared'

const plugin: HermesPlugin = {
  id: ID,
  name: 'AutoCode',
  description:
    'Embed the AutoCode PRD→Spec→coding orchestration UI in the sidebar. Requires the AutoCode frontend on localhost:5173.',
  // Core `registerAutocodePage` owns the rail entry; keep this plugin off to avoid a duplicate tab.
  defaultEnabled: false,
  register(ctx) {
    ctx.i18n.register(AUTOCODE_LOCALES)

    const resolveUrl = () => {
      const stored = ctx.storage.get<string>(URL_STORAGE_KEY, DEFAULT_URL)
      return (typeof stored === 'string' && stored.trim() ? stored.trim() : DEFAULT_URL).replace(/\/$/, '')
    }

    const open = () => host.navigate(PATH)

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        data: { path: PATH } satisfies RouteContribution,
        render: () => <AutoCodePage openExternal={url => ctx.os.openExternal(url)} url={resolveUrl()} />
      }
    ])

    const registerLabels = () =>
      ctx.registerMany([
        {
          id: 'nav',
          area: SIDEBAR_NAV_AREA,
          order: 40,
          data: {
            codicon: 'code',
            label: ctx.i18n.t('nav'),
            path: PATH
          } satisfies SidebarNavContribution
        },
        {
          id: 'open',
          area: PALETTE_AREA,
          data: {
            id: 'autocode.open',
            label: ctx.i18n.t('title'),
            keywords: ['autocode', 'prd', 'spec', 'coding', '编排'],
            run: open
          } satisfies PaletteContribution
        }
      ])

    let disposeLabels = registerLabels()
    ctx.i18n.onLocaleChange(() => {
      disposeLabels()
      disposeLabels = registerLabels()
    })
  }
}

export default plugin
