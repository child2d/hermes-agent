import type { ReactNode } from 'react'

import type { Contribution } from '@/contrib/types'

/**
 * Plugin seam for the Capabilities page (侧边栏「技能与工具」): a contribution
 * registered in this area adds a TAB to the page's strip — after the core tabs
 * (`skills` / `toolsets` / `connectors` / `plugins`) — and its `render()`
 * becomes that tab's whole body.
 *
 * The host gives the body the pane's full height (`min-h-0 flex-1`) and nothing
 * else: no title, no search field, no padding. The tab owns its own chrome —
 * build it from the SDK's `PanelHeader` / `PanelList` / `SearchField` / `Button`
 * primitives and let it scroll itself, so a plugin tab sits in the page the way
 * a core tab does.
 *
 * The tab id IS the contribution id, so it is what lands in `?tab=`; keep it
 * stable (a re-registration under a new id is a new tab, and a deep link to the
 * old one falls back to `skills`).
 */
export const CAPABILITIES_TABS_AREA = 'capabilities.tabs'

/** Payload of a `capabilities.tabs` contribution's `data`. */
export interface CapabilitiesTabContribution {
  /** Tab label. Falls back to the contribution's `title`, then its id. */
  label: string
}

/** One resolved tab: what the page's strip renders and what its body mounts. */
export interface CapabilityTab {
  id: string
  label: string
  render: () => ReactNode
}

/** Resolve this area's contributions into tabs. Order comes from the registry
 *  (`order` ascending, ties keep insertion order), so the host adds no second
 *  sort — and `data.label` is what the strip shows. */
export function capabilityTabs(contributions: readonly Contribution[]): CapabilityTab[] {
  return contributions
    .filter(contribution => typeof contribution.render === 'function')
    .map(contribution => ({
      id: contribution.id,
      label: (contribution.data as CapabilitiesTabContribution | undefined)?.label || contribution.title || contribution.id,
      render: contribution.render as () => ReactNode
    }))
}
