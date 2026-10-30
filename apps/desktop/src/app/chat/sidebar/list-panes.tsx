import { useStore } from '@nanostores/react'
import { useLocation, useNavigate } from 'react-router'

import { ListPane } from '@/components/list-pane'
import { $workspaceMode } from '@/components/pane-shell/workspace-scope'
import { Codicon } from '@/components/ui/codicon'
import { ContribBoundary, ContribRender } from '@/contrib/react/boundary'
import { useContributions } from '@/contrib/react/use-contributions'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $cronJobs } from '@/store/cron'

import { MessagingPlatformsPane } from '../../messaging/platforms-pane'
import { appViewForPath, contributedRoutes, CRON_ROUTE, MESSAGING_ROUTE, ROUTES_AREA } from '../../routes'

/** One standing list pane owns the column. Routes change its content, never
 * the layout tree: registering each list as a pane lets automatic adoption
 * create extra columns, and renaming those panes duplicates the session list. */
const LIST_FOR_ROUTE: Record<string, React.ComponentType> = {
  [CRON_ROUTE]: CronJobsPane,
  [MESSAGING_ROUTE]: MessagingPlatformsPane
}

/** The VIEWS whose column carries a list of its own — derived from the map
 *  above, so "a route swaps a list in" and "this view has a list pane" cannot
 *  drift apart. The shell reads it to show the column when you switch to such a
 *  view (`sidebar-route-step.ts`): the list is the way INTO the tool. */
export const LIST_PANE_VIEWS: ReadonlySet<string> = new Set(
  Object.keys(LIST_FOR_ROUTE).map(route => appViewForPath(route))
)

export function WorkspaceListPane({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  const List = LIST_FOR_ROUTE[pathname]
  const workspaceMode = useStore($workspaceMode)
  const routes = contributedRoutes(useContributions(ROUTES_AREA))

  const routeList = routes.find(route => route.list && route.path === pathname)
    ?? (appViewForPath(pathname) === 'chat'
      ? routes.find(route => route.list?.workspaceMode === workspaceMode)
      : undefined)

  // The column's pad and its surface live HERE — on the standing wrapper — so the
  // chat route (which renders `children`, the real session list) and a swapped-in
  // list (channels / cron jobs) are the same column: same colour, same rounded
  // corner. On either of the two content components it would be lost on the other.
  return (
    <div
      // No radius of its own: the CONTENT AREA is the card (renderer/index.tsx,
      // `data-slot="content-card"`), and it clips this column into its corner.
      // A radius here flipped to a square corner the moment the column folded
      // and the chat took the full width.
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-(--ui-sidebar-panel-background)"
      data-slot="list-column"
    >
      {routeList?.list ? (
        <ContribBoundary id={`${routeList.key}:list`}>
          <ContribRender render={routeList.list.render} />
        </ContribBoundary>
      ) : List ? <List /> : children}
    </div>
  )
}

/** 定时任务: the job roster. One row per job — schedule, next run, last error —
 *  and the row opens the job's surface (the cron page owns the editors and the
 *  run history), so this column stays a roster rather than a second console. */
export function CronJobsPane() {
  const { t } = useI18n()
  const navigate = useNavigate()
  const jobs = useStore($cronJobs)

  return (
    <ListPane title={t.sidebar.cronJobs}>
      {jobs.length === 0 ? null : (
        <ul className="flex flex-col gap-px">
          {jobs.map(job => (
            <li key={job.id}>
              <button
                className={cn(
                  'flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-xs',
                  'hover:bg-(--ui-control-hover-background)'
                )}
                onClick={() => navigate(CRON_ROUTE)}
                type="button"
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    'size-1.5 shrink-0 rounded-full',
                    job.enabled ? 'bg-(--ui-green)' : 'bg-(--ui-text-quaternary)'
                  )}
                />
                <span className="min-w-0 flex-1 truncate text-(--ui-text-primary)">
                  {job.name ?? job.prompt ?? job.id}
                </span>
                <span className="shrink-0 text-2xs text-(--ui-text-quaternary)">{job.schedule_display ?? ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        className="mt-1 flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs text-(--ui-text-tertiary) hover:bg-(--ui-control-hover-background) hover:text-(--ui-text-primary)"
        onClick={() => navigate(CRON_ROUTE)}
        type="button"
      >
        <Codicon name="chevron-right" size="0.75rem" />
        {t.sidebar.cronJobs}
      </button>
    </ListPane>
  )
}
