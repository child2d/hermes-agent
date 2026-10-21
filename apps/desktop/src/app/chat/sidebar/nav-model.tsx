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
  NEW_CHAT_ROUTE,
  SIDEBAR_NAV_AREA,
  type SidebarNavContribution
} from '../../routes'
import type { SidebarNavItem } from '../../types'

// A row's `tier` is the one mode it belongs to (Simple keeps the setup rows,
// Advanced adds the readouts); the list filters once, nothing is passed down.
export const SIDEBAR_NAV: SidebarNavItem[] = [
  // Home is the way BACK from a setup page to the conversation: the rail is the
  // only chrome that survives leaving chat, so chat needs its own glyph there.
  // Active state is the chat VIEW, not this route — see `isNavActive`.
  {
    id: 'home',
    label: '',
    icon: props => <Codicon name="home" {...props} />,
    codicon: 'home',
    route: NEW_CHAT_ROUTE
  },
  {
    id: 'new-session',
    label: '',
    icon: props => <Codicon name="robot" {...props} />,
    codicon: 'robot',
    action: 'new-session',
    keybindActionId: 'session.new'
  },
  {
    id: 'capabilities',
    label: '',
    icon: props => <Codicon name="symbol-misc" {...props} />,
    codicon: 'symbol-misc',
    route: CAPABILITIES_ROUTE,
    keybindActionId: 'nav.capabilities'
  },
  {
    id: 'messaging',
    label: '',
    icon: props => <Codicon name="comment" {...props} />,
    codicon: 'comment',
    route: MESSAGING_ROUTE,
    keybindActionId: 'nav.messaging'
  },
  // Artifacts and Scheduled jobs are outputs of running Hermes the developer
  // way; Capabilities and Messaging are how anyone sets it up.
  {
    id: 'artifacts',
    label: '',
    icon: props => <Codicon name="files" {...props} />,
    codicon: 'files',
    route: ARTIFACTS_ROUTE,
    keybindActionId: 'nav.artifacts',
    tier: 'advanced'
  },
  {
    id: 'cron',
    label: '',
    icon: props => <Codicon name="watch" {...props} />,
    codicon: 'watch',
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
            // The contribution names its glyph; the row draws the codicon, the
            // rail resolves its own family from `codicon`.
            icon: (props: { className?: string; size?: number | string }) => <Codicon name={codicon} {...props} />,
            codicon,
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
