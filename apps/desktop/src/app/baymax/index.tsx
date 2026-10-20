import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'
import { AlertTriangle, Clock, RefreshCw } from '@/lib/icons'
import { cn } from '@/lib/utils'

import {
  type BaymaxIssue,
  type BaymaxIssueDetail,
  type BaymaxProject,
  type BaymaxReadError,
  type BaymaxScene,
  daysLate,
  fetchIdentity,
  fetchIssue,
  fetchIssues,
  fetchProjects,
  isOpen,
  issueQueryKey,
  issuesQueryKey,
  isSuspended,
  summarize,
  todayKey
} from './api'

/** The user's last project, so the workbench opens where they left it. */
const PROJECT_STORAGE_KEY = 'hermes.desktop.baymax.projectId'

const SCENES: BaymaxScene[] = ['ALL_TODO', 'DUE_SOON', 'MY_CREATED', 'MY_PROCESSING']

const sceneLabel = (t: ReturnType<typeof useI18n>['t'], scene: BaymaxScene) =>
  ({
    ALL_TODO: t.baymax.tabAll,
    DUE_SOON: t.baymax.tabDueSoon,
    MY_CREATED: t.baymax.tabCreated,
    MY_PROCESSING: t.baymax.tabProcessing
  })[scene]

/** A read-door failure in the user's words: the door names WHAT failed, and the
 *  page must not dress that up as "no data". */
function failureText(t: ReturnType<typeof useI18n>['t'], error: unknown): string {
  const kind = (error as BaymaxReadError | undefined)?.kind
  const note = (error as BaymaxReadError | undefined)?.note

  return [kind, note].filter(Boolean).join(' · ') || t.baymax.failedDesc
}

function StatCard({
  label,
  tone = 'default',
  value
}: {
  label: string
  tone?: 'danger' | 'default' | 'warn'
  value: number
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border border-(--ui-stroke-tertiary) bg-(--ui-surface-background) px-3 py-2">
      <span className="truncate text-xs text-(--ui-text-tertiary)">{label}</span>
      <span
        className={cn(
          'text-xl leading-tight font-semibold tabular-nums',
          tone === 'danger' && value > 0 && 'text-destructive',
          tone === 'warn' && value > 0 && 'text-amber-600 dark:text-amber-500'
        )}
      >
        {value}
      </span>
    </div>
  )
}

/** A due-date chip: the workbench's one hard signal. */
function DueChip({ issue }: { issue: BaymaxIssue }) {
  const { t } = useI18n()
  const late = daysLate(issue)

  if (late === null) {
    return <span className="text-xs text-(--ui-text-quaternary)">{t.baymax.noDeadline}</span>
  }

  if (late > 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-destructive tabular-nums">
        <AlertTriangle className="size-3.5 shrink-0" />
        {t.baymax.overdueDays(late)}
      </span>
    )
  }

  if (late === 0) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-600 tabular-nums dark:text-amber-500">
        <Clock className="size-3.5 shrink-0" />
        {t.baymax.dueToday}
      </span>
    )
  }

  return <span className="text-xs text-(--ui-text-tertiary) tabular-nums">{issue.estimateEndDate?.slice(0, 10)}</span>
}

function IssueRow({ issue, onOpen }: { issue: BaymaxIssue; onOpen: () => void }) {
  return (
    <button
      className={cn(
        'group flex w-full items-center gap-3 rounded-md border border-transparent px-2 py-1.5 text-left',
        'hover:border-(--ui-stroke-tertiary) hover:bg-(--ui-control-hover-background)'
      )}
      onClick={onOpen}
      type="button"
    >
      <span className="w-16 shrink-0 truncate text-xs text-(--ui-text-quaternary) tabular-nums">{issue.issueKey}</span>
      <span className={cn('min-w-0 flex-1 truncate text-sm', !isOpen(issue) && 'text-(--ui-text-tertiary)')}>
        {issue.title}
      </span>
      {isSuspended(issue) && (
        <Badge className="shrink-0" variant="secondary">
          {issue.status?.name}
        </Badge>
      )}
      <span className="w-28 shrink-0 text-right">
        <DueChip issue={issue} />
      </span>
      <span className="w-24 shrink-0 truncate text-right text-xs text-(--ui-text-tertiary)">
        {issue.assigneeName ?? '—'}
      </span>
    </button>
  )
}

function DetailRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 border-b border-(--ui-stroke-quaternary) py-1.5 last:border-b-0">
      <span className="shrink-0 text-xs text-(--ui-text-tertiary)">{label}</span>
      <span className="min-w-0 text-right text-sm">{value}</span>
    </div>
  )
}

function IssueDetail({ issue, loading }: { issue: BaymaxIssueDetail | undefined; loading: boolean }) {
  const { t } = useI18n()

  if (loading && !issue) {
    return (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-5 w-3/4" />
        <Skeleton className="h-4 w-1/2" />
        <Skeleton className="h-24 w-full" />
      </div>
    )
  }

  if (!issue) {
    return <EmptyState className="min-h-32" title={t.baymax.failedTitle} />
  }

  const day = (iso?: string) => (iso ? iso.slice(0, 10) : '—')

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-3 pb-4">
      <div className="flex flex-col gap-1">
        <SheetTitle className="text-base leading-snug">{issue.title}</SheetTitle>
        <SheetDescription className="flex flex-wrap items-center gap-1.5 text-xs">
          <span className="tabular-nums">{issue.issueKey}</span>
          {issue.status?.name && <Badge variant="secondary">{issue.status.name}</Badge>}
          {issue.priority?.name && <Badge variant="outline">{issue.priority.name}</Badge>}
        </SheetDescription>
      </div>

      <div className="flex flex-col">
        <DetailRow label={t.baymax.colOwner} value={issue.assigneeName ?? '—'} />
        <DetailRow label={t.baymax.planStart} value={day(issue.estimateStartDate)} />
        <DetailRow label={t.baymax.planEnd} value={day(issue.estimateEndDate)} />
        <DetailRow label={t.baymax.actualWorkload} value={issue.actualWorkload ?? '—'} />
        <DetailRow label={t.baymax.lastUpdated} value={day(issue.updatedAt)} />
      </div>

      {issue.description && (
        <p className="text-sm whitespace-pre-wrap text-(--ui-text-secondary)">{issue.description}</p>
      )}

      <div className="flex flex-col gap-1.5">
        <span className="text-xs font-medium text-(--ui-text-tertiary)">{t.baymax.comments}</span>
        {issue.comments?.length ? (
          <ol className="flex flex-col gap-2">
            {issue.comments.map(comment => (
              <li
                className="rounded-md border border-(--ui-stroke-quaternary) bg-(--ui-surface-background) px-2.5 py-1.5"
                key={comment.id}
              >
                <div className="flex items-baseline justify-between gap-2 text-xs text-(--ui-text-tertiary)">
                  <span className="truncate">{comment.authorName ?? '—'}</span>
                  <span className="shrink-0 tabular-nums">{day(comment.createdAt)}</span>
                </div>
                <p className="mt-1 text-sm whitespace-pre-wrap">{comment.content}</p>
              </li>
            ))}
          </ol>
        ) : (
          <span className="text-xs text-(--ui-text-quaternary)">{t.baymax.noComments}</span>
        )}
      </div>
    </div>
  )
}

export function BaymaxView() {
  const { t } = useI18n()
  const queryClient = useQueryClient()
  const [scene, setScene] = useState<BaymaxScene>('ALL_TODO')

  const [pickedProject, setPickedProject] = useState<string>(
    () => globalThis.localStorage?.getItem(PROJECT_STORAGE_KEY) ?? ''
  )

  const [openIssueId, setOpenIssueId] = useState<null | string>(null)

  const identity = useQuery({ queryFn: fetchIdentity, queryKey: ['baymax', 'whoami'], retry: false, staleTime: 300_000 })
  const projects = useQuery({ queryFn: fetchProjects, queryKey: ['baymax', 'projects'], retry: false, staleTime: 300_000 })

  const projectList: BaymaxProject[] = projects.data ?? []
  const project = projectList.some(item => item.id === pickedProject) ? pickedProject : (projectList[0]?.id ?? '')

  const pickProject = useCallback((id: string) => {
    setPickedProject(id)
    globalThis.localStorage?.setItem(PROJECT_STORAGE_KEY, id)
  }, [])

  // The page's list, and — separately — ALL_TODO for the counters: 逾期 and
  // 今日到期 describe the whole backlog, not whichever tab is showing.
  const issues = useQuery({
    enabled: Boolean(project),
    queryFn: () => fetchIssues(project, scene),
    queryKey: issuesQueryKey(project, scene),
    retry: false
  })

  const backlog = useQuery({
    enabled: Boolean(project),
    queryFn: () => fetchIssues(project, 'ALL_TODO'),
    queryKey: issuesQueryKey(project, 'ALL_TODO'),
    retry: false
  })

  const summary = useMemo(() => summarize(backlog.data?.issues ?? []), [backlog.data])

  const detail = useQuery({
    enabled: Boolean(project) && Boolean(openIssueId),
    queryFn: () => fetchIssue(project, openIssueId as string),
    queryKey: issueQueryKey(project, openIssueId ?? ''),
    retry: false
  })

  const refresh = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: ['baymax'] })
  }, [queryClient])

  const loadError = projects.error ?? issues.error ?? backlog.error
  const refreshing = issues.isFetching || backlog.isFetching || projects.isFetching

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-(--ui-surface-background)">
      <header className="flex shrink-0 flex-wrap items-center gap-2 border-b border-(--ui-stroke-tertiary) px-4 py-2.5">
        <h1 className="text-sm font-semibold">{t.baymax.title}</h1>
        {identity.data && (
          <span className="truncate text-xs text-(--ui-text-tertiary)">
            {identity.data.name} · {identity.data.account}
          </span>
        )}
        <span className="ml-auto flex items-center gap-2">
          {projectList.length > 1 && (
            <Select onValueChange={pickProject} value={project}>
              <SelectTrigger className="h-7 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {projectList.map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.projectName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          <Button
            aria-label={refreshing ? t.baymax.refreshing : t.baymax.refresh}
            disabled={refreshing}
            onClick={refresh}
            size="icon"
            variant="ghost"
          >
            <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
          </Button>
        </span>
      </header>

      <div className="flex shrink-0 gap-2 px-4 py-3">
        <StatCard label={t.baymax.statTodo} value={summary.total} />
        <StatCard label={t.baymax.statDueToday} tone="warn" value={summary.dueToday} />
        <StatCard label={t.baymax.statOverdue} tone="danger" value={summary.overdue} />
        <StatCard label={t.baymax.statNoDeadline} tone="warn" value={summary.noDeadline} />
      </div>

      <div className="flex shrink-0 items-center gap-2 px-4">
        <Tabs onValueChange={value => setScene(value as BaymaxScene)} value={scene}>
          <TabsList>
            {SCENES.map(item => (
              <TabsTrigger key={item} value={item}>
                {sceneLabel(t, item)}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        {issues.data && (
          <span className="text-xs text-(--ui-text-quaternary) tabular-nums">
            {t.baymax.showing(issues.data.issues.length, issues.data.total)}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 pt-2 pb-4">
        {loadError ? (
          <ErrorState description={failureText(t, loadError)} title={t.baymax.failedTitle} />
        ) : projects.isLoading || issues.isLoading ? (
          <div className="flex flex-col gap-1.5 px-1">
            {Array.from({ length: 8 }, (_, index) => (
              <Skeleton className="h-8 w-full" key={index} />
            ))}
          </div>
        ) : issues.data?.issues.length ? (
          <div className="flex flex-col gap-px">
            {issues.data.issues.map(issue => (
              <IssueRow issue={issue} key={issue.id} onOpen={() => setOpenIssueId(issue.id)} />
            ))}
          </div>
        ) : (
          <EmptyState
            description={project ? undefined : t.baymax.noProjectDesc}
            title={project ? t.baymax.emptyTitle : t.baymax.noProjectTitle}
          />
        )}
      </div>

      <Sheet onOpenChange={open => !open && setOpenIssueId(null)} open={Boolean(openIssueId)}>
        <SheetContent className="sm:max-w-md">
          <SheetHeader>
            <span className="text-xs text-(--ui-text-quaternary)">{t.baymax.detailHint}</span>
          </SheetHeader>
          <IssueDetail issue={detail.data} loading={detail.isLoading} />
        </SheetContent>
      </Sheet>
    </div>
  )
}

export const BAYMAX_ROUTE = '/baymax'

export const baymaxTodayKey = todayKey
