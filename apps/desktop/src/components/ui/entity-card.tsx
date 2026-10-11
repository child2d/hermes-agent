import type { ReactNode } from 'react'

import { RowButton } from '@/components/ui/row-button'
import { cn } from '@/lib/utils'

/**
 * The CARD form of a browse-able collection: a responsive grid of `EntityCard`s.
 *
 * Same job as a `PanelList` / `CapRow` list, one step less dense — for surfaces
 * whose entries have a name, a state and a sentence worth reading before you
 * pick one (a skill catalog, an installed-skills shelf). The grid fills as many
 * columns as the column can hold, so the same component reads correctly in a
 * wide editor pane and in a 40%-wide master-detail column.
 */
export function CardGrid({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cn('grid content-start grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-3', className)}>
      {children}
    </div>
  )
}

export interface EntityCardProps {
  active?: boolean
  /** Control row at the card's foot (a switch, verbs). Omit for a plain card. */
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
 * One card. A container (never a `<button>`) so it can host its own control row
 * without nesting interactive elements — exactly the rule `PanelListRow` and
 * `CapRow` follow. The whole card selects; `actions` is the one place a control
 * may live inside it.
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
    <div
      className={cn(
        'group/card relative flex min-w-0 flex-col rounded-lg border p-2.5 transition-colors',
        active
          ? 'border-(--ui-stroke-secondary) bg-(--ui-row-active-background)'
          : 'border-(--ui-stroke-tertiary) hover:bg-(--ui-row-hover-background)',
        className
      )}
      data-panel-row={rowKey}
    >
      <RowButton className="flex min-w-0 flex-col items-start gap-1 pb-0.5 text-left" onClick={onSelect}>
        <span className="w-full truncate text-sm font-medium text-foreground/85">{title}</span>
        {badges ? <span className="flex flex-wrap items-center gap-1">{badges}</span> : null}
        {description ? (
          <span className="line-clamp-2 w-full text-xs leading-relaxed text-muted-foreground/70">{description}</span>
        ) : null}
      </RowButton>
      {meta ? <div className="mt-1 truncate text-2xs text-muted-foreground/50">{meta}</div> : null}
      {actions ? <div className="mt-2 flex items-center gap-1.5">{actions}</div> : null}
    </div>
  )
}
