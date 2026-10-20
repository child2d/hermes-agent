import type { SidebarNavItem } from '@/app/types'
import { cn } from '@/lib/utils'

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
 */
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
    <nav
      aria-label="Rail"
      className="flex w-11 shrink-0 flex-col items-center gap-0.5 border-r border-(--sidebar-edge-border) px-1.5 pb-2 pt-[calc(var(--titlebar-height)+0.375rem)]"
      data-slot="sidebar-nav-rail"
    >
      {items.map(item => {
        const active = isActive(item)
        const label = labelFor(item)

        return (
          <button
            aria-current={active ? 'page' : undefined}
            aria-label={label}
            className={cn(
              // no-drag, same as the rows: these sit under the titlebar's drag
              // strips, which win hit-testing on Linux/WSLg.
              'grid size-7 shrink-0 place-items-center rounded-md border border-transparent text-(--ui-text-tertiary) transition-colors duration-100 ease-out [-webkit-app-region:no-drag] hover:bg-(--ui-control-hover-background) hover:text-foreground hover:transition-none',
              active &&
                'border-(--ui-stroke-tertiary) bg-(--ui-control-active-background) text-foreground shadow-none hover:border-(--ui-stroke-tertiary)!'
            )}
            key={item.id}
            onClick={() => onNavigate(item)}
            type="button"
          >
            <item.icon className="size-4 shrink-0" />
          </button>
        )
      })}
    </nav>
  )
}
