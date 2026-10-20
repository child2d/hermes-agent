import { useLocation, useNavigate } from 'react-router'

import type { SidebarNavItem } from '@/app/types'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { navigateToWorkspacePage } from '../../routes'

import { sidebarRailItems, useSidebarNavItems } from './nav-model'

/**
 * The left rail — the fork's take on Codex's activity bar.
 *
 * Setup surfaces (skills & tools, messaging, bots, contributed pages) used to be
 * rows in the session list, where they competed with the thing the list is for:
 * conversations. As bare glyphs in a 44px strip they stay one click away without
 * taking part in the reading order. The session list keeps exactly one row of its
 * own (new session).
 *
 * No labels, no hover tooltips: the rail sits inside the sidebar's quiet region,
 * and every button carries an `aria-label`, so screen readers still name them.
 * Keyboard shortcuts are unchanged — the rail calls the same `onNavigate`.
 *
 * ONE geometry for both states (RAIL_SHELL below): the rail outlives the list,
 * so collapsing the sidebar must not move a glyph.
 */

/** The rail's shell: a fixed 44px column, padded UP UNDER the titlebar by the
 *  same expression the sidebar uses, one hairline on the list's side. Shared by
 *  the expanded rail and the collapsed strip's copy so the two cannot drift. */
const RAIL_SHELL =
  'flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-(--sidebar-edge-border) px-1.5 pb-2 pt-[calc(var(--titlebar-height)+0.375rem)]'

/** One nav button — an 18px icon in a 28px box. The rail is icon-only, so the
 *  icon IS the label, and it is deliberately larger than a titled row's: a
 *  Codicon renders at `0.875em` of its inherited text, i.e. ≈12px in a 14px row. */
const RAIL_BUTTON =
  'grid size-7 shrink-0 place-items-center rounded-md border border-transparent text-(--ui-text-tertiary) transition-colors duration-100 ease-out [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background) hover:text-foreground hover:transition-none'

const RAIL_BUTTON_ACTIVE =
  'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) text-foreground shadow-none'

/** The icon's box AND its size. For a Codicon this is a FONT glyph whose size
 *  comes from `font-size` (`.codicon{font-size:.875em}`): a `size-*` class alone
 *  only sets width/height and leaves the glyph at its inherited size — which is
 *  why the rail passed `size` (→ inline font-size) as well. */
const RAIL_GLYPH = 'size-4.5 shrink-0'
const RAIL_GLYPH_PX = 18

export function SidebarNavRail({
  isActive,
  items,
  labelFor,
  onNavigate
}: {
  isActive: (item: SidebarNavItem) => boolean
  items: SidebarNavItem[]
  labelFor: (item: SidebarNavItem) => string
  onNavigate: (item: SidebarNavItem) => void
}) {
  if (items.length === 0) {
    return null
  }

  return (
    <nav aria-label="Rail" className={RAIL_SHELL} data-slot="sidebar-nav-rail">
      {items.map(item => {
        const active = isActive(item)
        const label = labelFor(item)

        return (
          <button
            aria-current={active ? 'page' : undefined}
            aria-label={label}
            // no-drag comes with RAIL_BUTTON: these sit under the titlebar's
            // drag strips, which win hit-testing on Linux/WSLg.
            className={cn(RAIL_BUTTON, active && cn(RAIL_BUTTON_ACTIVE, 'hover:border-(--ui-stroke-tertiary)!'))}
            key={item.id}
            onClick={() => onNavigate(item)}
            type="button"
          >
            <item.icon className={RAIL_GLYPH} size={RAIL_GLYPH_PX} />
          </button>
        )
      })}
    </nav>
  )
}

/**
 * The same rail, rendered where the sidebar goes when it collapses.
 *
 * Collapsing a pane swaps its body for a vertical restore strip, so the expanded
 * rail would leave with it — but the rail is the way INTO setup and the bots,
 * not part of the session list, so it has to outlive the list. This variant
 * subscribes to the same nav model, navigates the same way, and paints the SAME
 * shell (RAIL_SHELL) — so the toolbar is exactly where it was before the click:
 * same width, same top pad, same glyphs. Only the restore tab moves, and it moves
 * BELOW the rail (tree-group renders the rail first in the strip).
 */
export function CollapsedSidebarRail() {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const items = sidebarRailItems(useSidebarNavItems())

  if (items.length === 0) {
    return null
  }

  return (
    <nav aria-label="Rail" className={RAIL_SHELL} data-slot="sidebar-nav-rail-collapsed">
      {items.map(item => {
        // Rail items are page-backed by construction (new session stays in the
        // list), so the path IS the active state — no view lookup needed here.
        const active = Boolean(item.route) && pathname === item.route

        return (
          <button
            aria-current={active ? 'page' : undefined}
            aria-label={t.sidebar.nav[item.id] ?? item.label}
            className={cn(RAIL_BUTTON, active && RAIL_BUTTON_ACTIVE)}
            key={item.id}
            onClick={event => {
              // The strip's own click restores the pane; a glyph must navigate
              // instead of just reopening the list.
              event.stopPropagation()

              if (item.route) {
                navigateToWorkspacePage(navigate, item.route)
              }
            }}
            type="button"
          >
            <item.icon className={RAIL_GLYPH} size={RAIL_GLYPH_PX} />
          </button>
        )
      })}
    </nav>
  )
}
