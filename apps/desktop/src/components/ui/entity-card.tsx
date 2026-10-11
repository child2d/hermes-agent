import type { ReactNode } from 'react'

import { Card, CardAction, CardContent, CardHeader } from '@/components/ui/card'
import { RowButton } from '@/components/ui/row-button'
import { cn } from '@/lib/utils'

/**
 * The CARD form of a browse-able collection: a responsive grid of `EntityCard`s.
 *
 * Same job as a `PanelList` / `CapRow` list, one step less dense — for surfaces
 * whose entries have a name, a state and a sentence worth reading before you
 * pick one (a skill catalog, an installed-skills shelf). Columns follow the
 * COLUMN's width, not the window's (`@container` + `@sm:`), so the same
 * component reads correctly in a wide editor pane and in a 40%-wide
 * master-detail column.
 */
export function CardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="@container">
      <div
        className={cn(
          'grid content-start gap-3 @sm:grid-cols-2 @3xl:grid-cols-3 @6xl:grid-cols-4',
          className
        )}
      >
        {children}
      </div>
    </div>
  )
}

export interface EntityCardProps {
  active?: boolean
  /** Control in the card's top-right corner (a switch, a verb). Omit for a
   *  plain card. */
  actions?: ReactNode
  /** Small chips beside the title (state, category). */
  badges?: ReactNode
  /** Card-level extra classes (e.g. dimming a disabled entry). */
  className?: string
  /** The one-to-two-line summary under the title. */
  description?: ReactNode
  /** A quiet fact at the card's foot (usage, versions, a path). */
  meta?: ReactNode
  onSelect: () => void
  /** Stable hook for tests/automation — lands on the card as `data-panel-row`,
   *  the same attribute `PanelListRow` uses, so a selector survives the
   *  list↔card switch. */
  rowKey?: string
  title: ReactNode
}

/**
 * One card, built on the STOCK shadcn `Card` (`CardHeader` / `CardAction` /
 * `CardContent`) — its padding, radius, shadow and type come from the registry,
 * not from here. Two deliberate deviations, both forced by the surrounding
 * master-detail surface: a selected card carries this app's row-active tokens
 * (stock `Card` has no selected state), and the summary is `line-clamp-2` so a
 * grid row keeps a uniform height.
 *
 * A container (never a `<button>`) so it can host its own control without
 * nesting interactive elements — the rule `PanelListRow` and `CapRow` follow.
 * The card's button selects; `actions` is the one place a control may live
 * inside it.
 */
export function EntityCard({
  actions,
  active = false,
  badges,
  className,
  description,
  meta,
  onSelect,
  rowKey,
  title
}: EntityCardProps) {
  return (
    <Card
      className={cn(active ? 'border-(--ui-stroke-secondary) bg-(--ui-row-active-background)' : '', className)}
      data-panel-row={rowKey}
    >
      <CardHeader>
        <RowButton className="flex min-w-0 flex-col items-start gap-2 text-left" onClick={onSelect}>
          <span className="w-full truncate leading-none font-semibold">{title}</span>
          {badges ? <span className="flex flex-wrap items-center gap-1">{badges}</span> : null}
          {description ? (
            <span className="line-clamp-2 w-full text-sm text-muted-foreground">{description}</span>
          ) : null}
        </RowButton>
        {actions ? <CardAction>{actions}</CardAction> : null}
      </CardHeader>
      {meta ? <CardContent className="text-2xs text-muted-foreground/60">{meta}</CardContent> : null}
    </Card>
  )
}
