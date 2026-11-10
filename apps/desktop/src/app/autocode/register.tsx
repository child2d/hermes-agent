/**
 * AutoCode — page + rail entry (same contribution shape as Baymax).
 */

import { AutocodeView } from '@/app/autocode'
import {
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@/app/routes'
import { registry } from '@/contrib/registry'

import { AUTOCODE_ROUTE } from './shared'

let registered = false

export function registerAutocodePage(): void {
  if (registered) {
    return
  }

  registered = true

  registry.registerMany([
    {
      id: 'autocode.page',
      area: ROUTES_AREA,
      data: { path: AUTOCODE_ROUTE } satisfies RouteContribution,
      render: () => <AutocodeView />
    },
    {
      id: 'autocode.nav',
      area: SIDEBAR_NAV_AREA,
      order: 42,
      data: { codicon: 'code', label: 'AutoCode', path: AUTOCODE_ROUTE } satisfies SidebarNavContribution
    }
  ])
}
