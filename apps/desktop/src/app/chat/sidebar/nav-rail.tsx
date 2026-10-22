import { Blocks, Bot, ClipboardList, FolderOpen, House, MessagesSquare, SquareKanban, Timer } from 'lucide-react'
import { useLocation, useNavigate } from 'react-router'

import type { SidebarNavItem } from '@/app/types'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { appViewForPath, navigateToWorkspacePage, NEW_CHAT_ROUTE } from '../../routes'

import { sidebarRailItems, useSidebarNavItems } from './nav-model'
import { SidebarUserMenu } from './user-menu'

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
 */

/** The rail draws the app's own icon family (lucide SVGs), not the codicon FONT
 *  its nav models name. Keyed by the codicon name an item carries, so a
 *  contributed page (kanban, bots) comes along without the rail knowing plugin
 *  ids; no entry → the item keeps the icon it was given, so an unknown codicon
 *  still renders instead of leaving a hole. */
const RAIL_ICONS: Record<string, SidebarNavItem['icon']> = {
  home: House, // 首页（回到对话）
  'symbol-misc': Blocks, // 技能与工具
  comment: MessagesSquare, // 消息平台
  files: FolderOpen, // 产物
  watch: Timer, // 定时任务
  project: SquareKanban, // 看板（插件）
  hubot: Bot, // 机器人（插件）
  pulse: ClipboardList // 个人工作台（baymax 页）
}

/** A rail glyph: lucide where the item's codicon name has an equivalent (the
 *  usual case), the item's own icon otherwise. `svg` says which — a stroke weight
 *  must reach an SVG only, or it lands on a Codicon's `<i>` as a stray attribute. */
function railIcon(item: SidebarNavItem) {
  const lucide = item.codicon ? RAIL_ICONS[item.codicon] : undefined

  return { Icon: lucide ?? item.icon, svg: Boolean(lucide) }
}

/** The rail itself: the window's chrome surface at full window height, with one
 *  hairline on the list's side. Two things make it read as a COLUMN instead of
 *  dissolving into the list beside it:
 *
 *  ① it spans the whole window — it starts at y=0 (beside the top band) and runs
 *     past the statusbar, which now lives in the column to its right
 *     (controller.tsx). Before, it began under the titlebar and ended above the
 *     statusbar, so an element inspection found chrome above and below it that
 *     belonged to nobody.
 *  ② it PAINTS. It wore `--ui-sidebar-surface-background`, which under
 *     `data-hermes-glass` is `transparent` (styles.css) — the exact value the
 *     session list beside it wears, so the two were literally the same pixels.
 *     The frame surface is the ramp's darkest rung (`raised > page > transcript >
 *     frame`), which is where Codex puts its activity bar.
 *
 * Its WIDTH is restated in two core places that must move with it:
 * `tree-group.tsx` (the collapsed strip's `w-*`) and `track-model.ts`
 * (`MINIMIZED_RAIL_TRACK`). */
const RAIL_COLUMN =
  'flex w-13 shrink-0 flex-col bg-(--ui-region-chrome) max-[47.5rem]:hidden'

/** The icon column's own rhythm, a child of RAIL_COLUMN so the paint can cover
 *  the full height while the glyphs still start below the top band. */
const RAIL_SHELL = 'flex flex-col items-center gap-1.5 px-2 pb-2'

/* The content area's left shade is not painted here: the card casts it from its
 * own box (renderer/index.tsx, `data-slot="content-card"`), which is what makes
 * it follow the rounded corner — a strip down this rail read as a hairline and
 * died at the corner. */

/** The rail's top offset: the window's top bar is a row of its OWN above this
 *  column (app-top-bar.tsx), so the rail starts under the chrome and only needs
 *  the icon rhythm's own gap — no titlebar offset to reproduce. */
const RAIL_TOP_PAD = 'pt-1.5'

/** One nav button — a 20px icon in a 32px box, 9.5px of air on both sides once
 *  the rail's width and hairline are counted. The rail is icon-only, so the icon
 *  IS the label, and it is deliberately larger than a titled row's. */
const RAIL_BUTTON =
  'grid size-8 shrink-0 place-items-center rounded-md border border-transparent text-(--ui-text-tertiary) transition-colors duration-100 ease-out [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background) hover:text-foreground hover:transition-none'

const RAIL_BUTTON_ACTIVE =
  'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) text-foreground shadow-none'

/** The icon's box AND its size. A lucide icon is an SVG: `size` sets its
 *  width/height, and the `size-*` class keeps the box identical. Do not size a
 *  Codicon this way — a codicon glyph is a FONT and only `font-size` moves it
 *  (see `Codicon`'s `size` prop). */
const RAIL_GLYPH = 'size-5 shrink-0'
const RAIL_GLYPH_PX = 20

/** Line weight, in the icon's own 24-unit viewBox. lucide's default (2) renders
 *  ≈1.7 CSS px at 20px and reads heavy on an icon-only surface; 1.5 lands at
 *  ≈1.25 px — the weight the app's hand-drawn SVGs already use. */
const RAIL_STROKE = 1.5

/**
 * The window-level toolbar: the rail, hoisted OUT of the pane tree.
 *
 * Inside the sidebar pane the same bar had two homes — the expanded rail, and a
 * copy re-painted inside a collapsed zone — so its geometry was computed twice
 * and drifted every time (4px off the track, then the whole titlebar offset,
 * then 10px). As a child of the app shell the window decides where it sits:
 * folding the session list cannot move an icon, and the column runs the full
 * window height.
 */
export function AppRail() {
  const { t } = useI18n()
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const items = sidebarRailItems(useSidebarNavItems())

  if (items.length === 0) {
    return null
  }

  return (
    <div className={cn(RAIL_COLUMN, 'relative')} data-slot="app-rail">
      <nav aria-label="Rail" className={cn(RAIL_SHELL, RAIL_TOP_PAD)} data-slot="sidebar-nav-rail">
        {items.map(item => {
          // Rail items are page-backed by construction (new session stays in the
          // list). Home is the exception: it stands for the CHAT view, which is a
          // route FAMILY (`/` plus `/session/:id`), not one path.
          const active =
            item.route === NEW_CHAT_ROUTE
              ? appViewForPath(pathname) === 'chat'
              : Boolean(item.route) && pathname === item.route

          const { Icon, svg } = railIcon(item)

          return (
            <button
              aria-current={active ? 'page' : undefined}
              aria-label={t.sidebar.nav[item.id] ?? item.label}
              className={cn(RAIL_BUTTON, active && RAIL_BUTTON_ACTIVE)}
              key={item.id}
              onClick={() => {
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

      {/* The account, at the rail's foot — the window's own corner, one avatar and
          nothing else (the panel behind it carries the name). Outside the nav: the
          nav is the tool list and scrolls nothing, while this is pinned down.
          Its bottom inset is the COMPOSER's gutter (`--composer-shell-pad-block-end`,
          the composer shell's own `pb`), minus the 4px the 24px avatar leaves inside
          its 32px box — so the circle's bottom lands on the card's bottom edge, at
          every window size and however many rows the composer has grown. */}
      <div className="mt-auto flex w-full justify-center pb-[max(0px,calc(var(--composer-shell-pad-block-end)-0.25rem))] pt-1">
        <SidebarUserMenu />
      </div>
    </div>
  )
}
