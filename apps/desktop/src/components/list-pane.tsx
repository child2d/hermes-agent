import type { ReactNode } from 'react'

/** A route-swapped list column's own layout: title, an optional pinned toolbar
 *  (a filter field and its controls), and the scrolling body.
 *
 *  The colour and the rounded corner belong to the standing wrapper
 *  (`WorkspaceListPane`), never to this: on a swapped-in list they would be
 *  lost the moment the route changes back to the session list. */
export function ListPane({
  children,
  title,
  toolbar
}: {
  children: ReactNode
  title: string
  toolbar?: ReactNode
}) {
  return (
    <div className="flex h-full min-h-0 w-full flex-col overflow-hidden" data-slot="list-pane">
      <div className="flex h-9 shrink-0 items-center px-3.5 text-2xs font-medium tracking-wide text-(--ui-text-tertiary) uppercase">
        {title}
      </div>
      {toolbar ? <div className="flex shrink-0 flex-col px-2 pb-1.5">{toolbar}</div> : null}
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</div>
    </div>
  )
}
