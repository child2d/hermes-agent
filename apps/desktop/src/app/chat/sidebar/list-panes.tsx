import { useStore } from '@nanostores/react'
import { useLocation, useNavigate } from 'react-router'

import { Codicon } from '@/components/ui/codicon'
import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'
import { $cronJobs } from '@/store/cron'

import { CRON_ROUTE, MESSAGING_ROUTE, SETTINGS_ROUTE } from '../../routes'

import { ConnectionSwitcher } from './connection-switcher'

/** One standing list pane owns the column. Routes change its content, never
 * the layout tree: registering each list as a pane lets automatic adoption
 * create extra columns, and renaming those panes duplicates the session list. */
const LIST_FOR_ROUTE: Record<string, React.ComponentType> = {
  [CRON_ROUTE]: CronJobsPane,
  [MESSAGING_ROUTE]: ChannelsPane
}

export function WorkspaceListPane({ children }: { children: React.ReactNode }) {
  const { pathname } = useLocation()
  const List = LIST_FOR_ROUTE[pathname]

  // The column's pad and its surface live HERE — on the standing wrapper — so the
  // chat route (which renders `children`, the real session list) and a swapped-in
  // list (channels / cron jobs) are the same column: same colour, same rounded
  // corner. On either of the two content components it would be lost on the other.
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden rounded-tl-2xl bg-(--ui-sidebar-panel-background)"
      data-slot="list-column"
    >
      {List ? <List /> : children}
    </div>
  )
}

/** A swapped-in list's own layout: header + scroll body. The colour and the
 *  rounded corner belong to the standing wrapper above (see `WorkspaceListPane`). */
export function ListPane({ children, title }: { children: React.ReactNode; title: string }) {
  return (
    <div
      className="flex h-full min-h-0 w-full flex-col overflow-hidden"
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
  const { t } = useI18n()
  const navigate = useNavigate()

  return (
    <ListPane title={t.sidebar.nav.messaging}>
      <ConnectionSwitcher compact onConnect={() => navigate(`${SETTINGS_ROUTE}?tab=connections`)} />
    </ListPane>
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
