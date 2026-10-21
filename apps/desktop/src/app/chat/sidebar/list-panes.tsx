import { useStore } from '@nanostores/react'
import { useEffect } from 'react'
import { useLocation, useNavigate } from 'react-router'

import { replacePaneInTree } from '@/components/pane-shell/tree/store'
import { Codicon } from '@/components/ui/codicon'
import { cn } from '@/lib/utils'
import { $cronJobs } from '@/store/cron'

import { CRON_ROUTE, MESSAGING_ROUTE, NEW_CHAT_ROUTE, SETTINGS_ROUTE } from '../../routes'

import { ConnectionSwitcher } from './connection-switcher'

/**
 * A zone's LIST slot — the column A zone shows on the left.
 *
 * The rail is A zone's top-level switch, and it switches BOTH halves: chat shows
 * the session list beside the conversation, 消息平台 shows the channels beside its
 * page, 定时任务 shows the jobs beside theirs. That is one slot swapping its pane,
 * not a second sidebar: the slot lives wherever the user dragged it, so the swap
 * replaces the pane IN PLACE (`replacePaneInTree`).
 *
 * A pane that declares itself here is a LIST, so it is `hideOnly` (no close
 * gesture — the rail is what shows and hides it) and takes the standard sidebar
 * width.
 */
export const LIST_PANES = ['sessions', 'channels', 'cron-jobs'] as const

/** Which list the window's current surface wants. Routes without an entry keep
 *  the session list: a tool page that owns its own list is a product decision
 *  (which pane becomes its list), not something to infer from the URL. */
const LIST_PANE_FOR_ROUTE: Record<string, string> = {
  [CRON_ROUTE]: 'cron-jobs',
  [MESSAGING_ROUTE]: 'channels'
}

/** Push the active route's list into the tree, when it is not the one showing. */
export function showListPane(paneId: string): boolean {
  const others = LIST_PANES.filter(candidate => candidate !== paneId)

  return replacePaneInTree(others, paneId)
}

/** Mounted once by the shell: keeps A zone's list slot in step with the rail. */
export function ListPaneSync() {
  const { pathname } = useLocation()
  const paneId = LIST_PANE_FOR_ROUTE[pathname] ?? (pathname === NEW_CHAT_ROUTE ? 'sessions' : undefined)

  useEffect(() => {
    if (paneId) {
      showListPane(paneId)
    }
  }, [paneId])

  return null
}

/** Shared shell for a list pane: the panel surface the session list wears, so a
 *  swapped-in list does not change the column's colour. */
function ListPane({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden bg-(--ui-sidebar-panel-background)"
      data-slot="list-pane"
    >
      <div className="flex h-9 shrink-0 items-center px-3.5 text-2xs font-medium tracking-wide text-(--ui-text-tertiary) uppercase">
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">{children}</div>
    </div>
  )
}

/** 消息平台: the channels the window is connected through, with the connect flow
 *  the statusbar's own switcher already owns. Clicking the tool's page is what
 *  opens a channel's settings — this column is the way in, not a second editor. */
export function ChannelsPane() {
  const navigate = useNavigate()

  return (
    <ListPane title="渠道">
      <ConnectionSwitcher compact onConnect={() => navigate(`${SETTINGS_ROUTE}?tab=connections`)} />
    </ListPane>
  )
}

/** 定时任务: the job roster. One row per job — schedule, next run, last error —
 *  and the row opens the job's surface (the cron page owns the editors and the
 *  run history), so this column stays a roster rather than a second console. */
export function CronJobsPane() {
  const navigate = useNavigate()
  const jobs = useStore($cronJobs)

  return (
    <ListPane title="定时任务">
      {jobs.length === 0 ? (
        <p className="px-2 py-1 text-xs text-(--ui-text-tertiary)">还没有定时任务</p>
      ) : (
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
                <span className="shrink-0 text-2xs text-(--ui-text-quaternary)">
                  {job.schedule_display ?? ''}
                </span>
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
        打开定时任务
      </button>
    </ListPane>
  )
}
