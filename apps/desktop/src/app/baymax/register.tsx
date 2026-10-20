/**
 * Baymax (个人工作台) — page + rail entry registration.
 *
 * A **contributed route**, not an `AppView`: core itself registers into the same
 * `routes` area plugins use, so the page mounts in the workspace pane behind the
 * contribution boundary and the shell treats it exactly like a built-in page
 * (tab strip stands down, titlebar clusters stay). That keeps every route/overlay
 * switch untouched — the page is one registration, not a new shell case.
 *
 * The rail row carries a `codicon` name like any contributed nav item; the rail
 * resolves its own icon family from that name (`nav-rail.tsx`).
 */

import { BAYMAX_ROUTE, BaymaxView } from '@/app/baymax'
import {
  type RouteContribution,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '@/app/routes'
import { registry } from '@/contrib/registry'

let registered = false

export function registerBaymaxPage(): void {
  if (registered) {
    return
  }

  registered = true

  registry.registerMany([
    {
      id: 'baymax.page',
      area: ROUTES_AREA,
      data: { path: BAYMAX_ROUTE } satisfies RouteContribution,
      render: () => <BaymaxView />
    },
    {
      id: 'baymax.nav',
      area: SIDEBAR_NAV_AREA,
      order: 45,
      data: { codicon: 'pulse', label: 'Baymax', path: BAYMAX_ROUTE } satisfies SidebarNavContribution
    }
  ])
}
