import { Blocks, Bot, FolderOpen, MessagesSquare, SquareKanban, Timer } from 'lucide-react'
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
 * conversations. As bare icons in a 44px strip they stay one click away without
 * taking part in the reading order. The session list keeps exactly one row of its
 * own (new session).
 *
 * No labels, no hover tooltips: the rail sits inside the sidebar's quiet region,
 * and every button carries an `aria-label`, so screen readers still name them.
 * Keyboard shortcuts are unchanged — the rail calls the same `onNavigate`.
 *
 * ONE geometry for both states (RAIL_SHELL below): the rail outlives the list,
 * so collapsing the sidebar must not move an icon.
 */

/** The rail draws the app's own icon family (lucide SVGs), not the codicon FONT
 *  its nav models name. Keyed by the codicon name an item carries, so a
 *  contributed page (kanban, bots) comes along without the rail knowing plugin
 *  ids; no entry → the item keeps the icon it was given, so an unknown codicon
 *  still renders instead of leaving a hole. */
const RAIL_ICONS: Record<string, SidebarNavItem['icon']> = {
  'symbol-misc': Blocks, // 技能与工具
  comment: MessagesSquare, // 消息平台
  files: FolderOpen, // 产物
  watch: Timer, // 定时任务
  project: SquareKanban, // 看板（插件）
  hubot: Bot // 机器人（插件）
}

/** A rail glyph: lucide where the item's codicon name has an equivalent (the
 *  usual case), the item's own icon otherwise. `svg` says which — a stroke weight
 *  must reach an SVG only, or it lands on a Codicon's `<i>` as a stray attribute. */
function railIcon(item: SidebarNavItem) {
  const lucide = item.codicon ? RAIL_ICONS[item.codicon] : undefined

  return { Icon: lucide ?? item.icon, svg: Boolean(lucide) }
}

/** The rail's shell: a fixed 52px column, padded UP UNDER the titlebar by the
 *  same expression the sidebar uses, one hairline on the list's side. Shared by
 *  the expanded rail and the collapsed strip's copy so the two cannot drift —
 *  and its WIDTH is restated in two core places that must move with it:
 *  `tree-group.tsx` (the collapsed strip's `w-*`) and `track-model.ts`
 *  (`MINIMIZED_RAIL_TRACK`). */
const RAIL_SHELL =
  'flex w-13 shrink-0 flex-col items-center gap-1.5 border-r border-(--sidebar-edge-border) px-2 pb-2 pt-[calc(var(--titlebar-height)+0.375rem)]'

/** One nav button — a 20px icon in a 32px box, 9.5px of air on both sides once
 *  the rail's width and hairline are counted. The rail is icon-only, so the icon
 *  IS the label, and it is deliberately larger than a titled row's. */
const RAIL_BUTTON =
  'grid size-8 shrink-0 place-items-center rounded-md border border-transparent text-(--ui-text-tertiary) transition-colors duration-100 ease-out [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background) hover:text-foreground hover:transition-none'

const RAIL_BUTTON_ACTIVE =
  'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) text-foreground shadow-none'

/** The icon's box AND its size. A lucide icon is an SVG: `size` sets its
 *  width/height, and the `size-*` class keeps the box (and the collapsed copy)
 *  identical. Do not size a Codicon this way — a codicon glyph is a FONT and
 *  only `font-size` moves it (see `Codicon`'s `size` prop). */
const RAIL_GLYPH = 'size-5 shrink-0'
const RAIL_GLYPH_PX = 20

/** Line weight, in the icon's own 24-unit viewBox. lucide's default (2) renders
 *  ≈1.7 CSS px at 20px and reads heavy on an icon-only surface; 1.5 lands at
 *  ≈1.25 px — the weight the app's hand-drawn SVGs already use. */
const RAIL_STROKE = 1.5

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
        const { Icon, svg } = railIcon(item)

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
            <Icon className={RAIL_GLYPH} size={RAIL_GLYPH_PX} {...(svg ? { strokeWidth: RAIL_STROKE } : {})} />
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
        const { Icon, svg } = railIcon(item)

        return (
          <button
            aria-current={active ? 'page' : undefined}
            aria-label={t.sidebar.nav[item.id] ?? item.label}
            className={cn(RAIL_BUTTON, active && RAIL_BUTTON_ACTIVE)}
            key={item.id}
            onClick={event => {
              // The strip's own click restores the pane; an icon must navigate
              // instead of just reopening the list.
              event.stopPropagation()

              if (item.route) {
                navigateToWorkspacePage(navigate, item.route)
              }
            }}
            type="button"
          >
            <Icon className={RAIL_GLYPH} size={RAIL_GLYPH_PX} {...(svg ? { strokeWidth: RAIL_STROKE } : {})} />
          </button>
        )
      })}
    </nav>
  )
}
