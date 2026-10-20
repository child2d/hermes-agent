import { useStore } from '@nanostores/react'
import { useMemo } from 'react'

import { Codicon } from '@/components/ui/codicon'
import { useContributions } from '@/contrib/react/use-contributions'
import { $interfaceMode, shownInMode } from '@/store/interface-mode'
import { applySidebarNavPrefs, SIDEBAR_NAV_PREFS_AREA } from '@/store/sidebar-nav'

import {
  ARTIFACTS_ROUTE,
  CAPABILITIES_ROUTE,
  CRON_ROUTE,
  MESSAGING_ROUTE,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '../../routes'
import type { SidebarNavItem } from '../../types'

// A row's `tier` is the one mode it belongs to (Simple keeps the setup rows,
// Advanced adds the readouts); the list filters once, nothing is passed down.
export const SIDEBAR_NAV: SidebarNavItem[] = [
  {
    id: 'new-session',
    label: '',
    icon: props => <Codicon name="robot" {...props} />,
    action: 'new-session',
    keybindActionId: 'session.new'
  },
  {
    id: 'capabilities',
    label: '',
    icon: props => <Codicon name="symbol-misc" {...props} />,
    route: CAPABILITIES_ROUTE,
    keybindActionId: 'nav.capabilities'
  },
  {
    id: 'messaging',
    label: '',
    icon: props => <Codicon name="comment" {...props} />,
    route: MESSAGING_ROUTE,
    keybindActionId: 'nav.messaging'
  },
  // Artifacts and Scheduled jobs are outputs of running Hermes the developer
  // way; Capabilities and Messaging are how anyone sets it up.
  {
    id: 'artifacts',
    label: '',
    icon: props => <Codicon name="files" {...props} />,
    route: ARTIFACTS_ROUTE,
    keybindActionId: 'nav.artifacts',
    tier: 'advanced'
  },
  {
    id: 'cron',
    label: '',
    icon: props => <Codicon name="watch" {...props} />,
    route: CRON_ROUTE,
    keybindActionId: 'nav.cron',
    tier: 'advanced'
  }
]

/**
 * One nav model for both places a nav item renders: the session list's single
 * row, the expanded rail, and the rail that survives a collapsed sidebar.
 *
 * Contributed rows (plugins pairing a page with a nav entry) come below the
 * built-ins with the same chrome, active at their own route. Nav preferences
 * (`sidebarNav.prefs`) are merged at render, so a plugin's disable/reload
 * disposes its contribution and the rows come straight back.
 */
export function useSidebarNavItems(): SidebarNavItem[] {
  const navContributions = useContributions(SIDEBAR_NAV_AREA)

  const contributed = useMemo<SidebarNavItem[]>(
    () =>
      navContributions.flatMap(c => {
        const data = c.data as Partial<SidebarNavContribution> | undefined

        if (!data?.path?.startsWith('/') || !data.label) {
          return []
        }

        const codicon = data.codicon || 'plug'

        return [
          {
            id: c.id,
            label: data.label,
            icon: (props: { className?: string }) => <Codicon name={codicon} {...props} />,
            route: data.path,
            tier: data.tier
          }
        ]
      }),
    [navContributions]
  )

  const interfaceMode = useStore($interfaceMode)
  const navPrefs = useContributions(SIDEBAR_NAV_PREFS_AREA)

  return useMemo(
    () => applySidebarNavPrefs([...SIDEBAR_NAV, ...contributed].filter(shownInMode(interfaceMode)), navPrefs),
    [contributed, interfaceMode, navPrefs]
  )
}

/** The session list keeps exactly one nav row; the rail takes the rest. */
export function sidebarRowItems(items: SidebarNavItem[]): SidebarNavItem[] {
  return items.filter(item => item.id === 'new-session')
}

export function sidebarRailItems(items: SidebarNavItem[]): SidebarNavItem[] {
  return items.filter(item => item.id !== 'new-session')
}
