import { LIST_PANE_VIEWS } from '../chat/sidebar/list-panes'

/** Views that paint a panel of their OWN in the left column: chat paints the
 *  session list (`SidebarSurface`), 消息平台 and 定时任务 swap their own list in
 *  through `WorkspaceListPane`. Derived from the route→list map, so a newly
 *  wired list joins the rule without anyone remembering to edit it. */
const VIEWS_WITH_COLUMN = new Set(['chat', ...LIST_PANE_VIEWS])

/** What a VIEW CHANGE does to the left column (the sidebar pane).
 *
 *  - `fold`   — the view paints nothing of its own in that column: fold it down
 *               to its rail. The rail stays, because it is the only way back to
 *               chat.
 *  - `reveal` — the view's column carries a list of its own (消息平台's platform
 *               roster, 定时任务's job roster): SHOW it. That list is the way
 *               INTO the tool — arriving behind a folded rail left the page
 *               looking empty.
 *  - `unfold` — chat, where the column is optional chrome around the
 *               conversation: undo a fold THIS wiring made, never one the user
 *               made by hand.
 *  - `none`   — leave the column exactly as it is.
 *
 *  The rule lives here, away from the effect that applies it, because it is a
 *  table over two sets rather than a layout operation — and a table is what a
 *  test can assert. */
export type SidebarRouteAction = 'fold' | 'none' | 'reveal' | 'unfold'

export interface SidebarRouteStep {
  action: SidebarRouteAction
  /** The remembered "we folded it" flag to carry out of this step. */
  foldedByRoute: boolean
}

export function sidebarRouteStep(
  view: string,
  // `minimized` is optional on a tree group (undefined = not minimized).
  column: { foldedByRoute: boolean; minimized: boolean | undefined },
  hasContributedList = false
): SidebarRouteStep {
  if (hasContributedList) {
    return { action: 'reveal', foldedByRoute: false }
  }

  // Nothing of this view's own lives in the column.
  if (!VIEWS_WITH_COLUMN.has(view)) {
    return column.minimized
      ? // Already folded (by the user, or by an earlier step): leave it — and
        // deliberately do NOT claim the fold, or leaving would reopen it.
        { action: 'none', foldedByRoute: column.foldedByRoute }
      : { action: 'fold', foldedByRoute: true }
  }

  if (LIST_PANE_VIEWS.has(view)) {
    return { action: 'reveal', foldedByRoute: false }
  }

  // Chat: only a fold this wiring made is undone.
  return column.foldedByRoute
    ? { action: 'unfold', foldedByRoute: false }
    : { action: 'none', foldedByRoute: false }
}
