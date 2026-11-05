import './workbench.css'

import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'

import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ErrorState } from '@/components/ui/error-state'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { useI18n } from '@/i18n'
import { RefreshCw } from '@/lib/icons'
import { revealPaneColumn } from '@/store/layout'

import {
  type BaymaxIssue,
  type BaymaxReadError,
  daysLate,
  fetchIdentity,
  fetchIssue,
  fetchIssues,
  isOpen,
  issueQueryKey,
  issuesQueryKey,
  isSuspended,
  summarize,
  todayKey
} from './api'
import { IssueDetailCard, IssueSummaryCard } from './issue-cards'
import { type Focus, FOCUSES, SCENES, useBaymaxRoute } from './route-state'

function failureText(t: ReturnType<typeof useI18n>['t'], error: unknown) {
  const { kind, note } = (error as BaymaxReadError | undefined) ?? {}

  return [kind, note].filter(Boolean).join(': ') || t.baymax.failedDesc
}

function matchesFocus(issue: BaymaxIssue, focus: Focus) {
  if (focus === 'all') {
    return true
  }

  if (!isOpen(issue)) {
    return false
  }

  const late = daysLate(issue)

  if (focus === 'overdue') {
    return late !== null && late > 0 && !isSuspended(issue)
  }

  return focus === 'today' ? late === 0 && !isSuspended(issue) : late === null
}

function LoadingRows() {
  return (
    <div aria-busy="true" className="baymax-loading">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="flex flex-col gap-2" key={index}>
          <Skeleton className="h-3 w-1/3 motion-reduce:animate-none" />
          <Skeleton className="h-4 w-5/6 motion-reduce:animate-none" />
        </div>
      ))}
    </div>
  )
}

function ReadFailure({ error, fetching, retry }: { error: unknown; fetching: boolean; retry: () => void }) {
  const { t } = useI18n()

  return (
    <ErrorState description={failureText(t, error)} title={t.baymax.failedTitle}>
      <Button disabled={fetching} onClick={retry} variant="outline">
        {t.baymax.retry}
      </Button>
    </ErrorState>
  )
}

/** One deliberate navigation focus handoff, never a query-completion effect. */
function focusDetail() {
  const previous = globalThis.document.activeElement
  requestAnimationFrame(() => {
    if (globalThis.document.activeElement === previous) {
      globalThis.document.getElementById('baymax-detail')?.focus({ preventScroll: true })
    }
  })
}

export function BaymaxListPane() {
  const { t } = useI18n()
  const { projects, project, scene, focus, search, selectedId, change, pickProject } = useBaymaxRoute()
  const client = useQueryClient()
  const refreshing = useIsFetching({ queryKey: ['baymax'] }) > 0

  const identity = useQuery({
    queryFn: fetchIdentity,
    queryKey: ['baymax', 'whoami'],
    retry: false,
    staleTime: 300_000
  })

  const issues = useQuery({
    enabled: Boolean(project),
    queryKey: issuesQueryKey(project, scene),
    queryFn: () => fetchIssues(project, scene),
    retry: false
  })

  const rows = issues.data?.issues ?? []
  const summary = summarize(rows)

  const labels = {
    all: t.baymax.allLoaded,
    overdue: t.baymax.statOverdue,
    today: t.baymax.statDueToday,
    undated: t.baymax.statNoDeadline
  }

  const counts = {
    all: summary.total,
    overdue: summary.overdue,
    today: rows.filter(issue => matchesFocus(issue, 'today')).length,
    undated: summary.noDeadline
  }

  const sceneLabels = {
    ALL_TODO: t.baymax.tabAll,
    DUE_SOON: t.baymax.tabDueSoon,
    MY_CREATED: t.baymax.tabCreated,
    MY_PROCESSING: t.baymax.tabProcessing
  }

  const query = search.trim().toLocaleLowerCase()

  const visible = rows.filter(
    issue =>
      matchesFocus(issue, focus) &&
      [issue.title, issue.issueKey, issue.assigneeName, issue.status?.name].some(value =>
        value?.toLocaleLowerCase().includes(query)
      )
  )

  return (
    <section aria-label={t.baymax.queue} className="baymax-queue" data-testid="baymax-list-pane">
      <header className="baymax-queue-header">
        <h2>{t.baymax.title}</h2>
        <Button
          aria-label={t.baymax.refresh}
          disabled={refreshing}
          onClick={() => void client.invalidateQueries({ queryKey: ['baymax'] })}
          size="icon"
          variant="ghost"
        >
          <RefreshCw aria-hidden="true" />
        </Button>
      </header>
      <div className="baymax-queue-controls">
        {Boolean(projects.data?.length) && (
          <Select onValueChange={pickProject} value={project}>
            <SelectTrigger aria-label={t.baymax.project}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {projects.data?.map(item => (
                  <SelectItem key={item.id} value={item.id}>
                    {item.projectName}
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        )}
        <Select onValueChange={value => change({ scene: value, focus: null, q: null, issue: null })} value={scene}>
          <SelectTrigger aria-label={t.baymax.scenes}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {SCENES.map(value => (
                <SelectItem key={value} value={value}>
                  {sceneLabels[value]}
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
        <div aria-label={t.baymax.focus} className="baymax-focus" role="group">
          {FOCUSES.map(value => (
            <button
              aria-pressed={value === focus}
              className="baymax-focus-button"
              disabled={!issues.data || Boolean(issues.error)}
              key={value}
              onClick={() => change({ focus: value, issue: null })}
              type="button"
            >
              <span>{labels[value]}</span>
              <span>{issues.data && !issues.error ? counts[value] : '—'}</span>
            </button>
          ))}
        </div>
        {rows.length > 0 && (
          <SearchField
            aria-label={t.baymax.searchIssues}
            containerClassName="w-full"
            onChange={value => change({ q: value, issue: null }, true)}
            placeholder={t.baymax.searchIssues}
            value={search}
          />
        )}
        {issues.data && !issues.error && (
          <p className="baymax-coverage">{t.baymax.loadedScope(rows.length, issues.data.total)}</p>
        )}
      </div>
      <div aria-busy={projects.isLoading || issues.isLoading} className="baymax-list">
        {projects.error ? (
          <ReadFailure error={projects.error} fetching={projects.isFetching} retry={() => void projects.refetch()} />
        ) : projects.isLoading ? (
          <LoadingRows />
        ) : !project ? (
          <EmptyState description={t.baymax.noProjectDesc} title={t.baymax.noProjectTitle} />
        ) : issues.error ? (
          <ReadFailure error={issues.error} fetching={issues.isFetching} retry={() => void issues.refetch()} />
        ) : issues.isLoading ? (
          <LoadingRows />
        ) : visible.length ? (
          <ol
            onKeyDown={event => {
              if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
                return
              }

              const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[data-issue-id]'))
              const index = buttons.indexOf(event.target as HTMLButtonElement)

              if (index < 0) {
                return
              }

              event.preventDefault()

              const next =
                event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? buttons.length - 1
                    : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))

              buttons[next]?.focus()
            }}
          >
            {visible.map(issue => (
              <li key={issue.id}>
                <IssueSummaryCard
                  issue={issue}
                  onSelect={() => {
                    change({ issue: issue.id })
                    focusDetail()
                  }}
                  selected={selectedId === issue.id}
                />
              </li>
            ))}
          </ol>
        ) : (
          <EmptyState
            description={focus !== 'all' || search ? t.baymax.clearFocusHint : undefined}
            title={t.baymax.emptyTitle}
          />
        )}
      </div>
      {(identity.data || identity.error) && (
        <footer className="baymax-identity">{identity.data?.name ?? t.baymax.identityUnavailable}</footer>
      )}
    </section>
  )
}

/** Main owns only the selected detail read. The queue lives in the shell list. */
export function BaymaxView() {
  const { t } = useI18n()
  const { project, selectedId, projects, change } = useBaymaxRoute()

  const detail = useQuery({
    enabled: Boolean(project && selectedId),
    queryKey: issueQueryKey(project, selectedId ?? ''),
    queryFn: () => fetchIssue(project, selectedId!),
    retry: false
  })

  const back = () => {
    revealPaneColumn('sessions')
    change({ issue: null })
    requestAnimationFrame(() => {
      const row = Array.from(globalThis.document.querySelectorAll<HTMLButtonElement>('[data-issue-id]')).find(
        item => item.dataset.issueId === selectedId
      )

      row?.focus({ preventScroll: true })
    })
  }

  return (
    <section
      aria-busy={Boolean(selectedId) && detail.isLoading}
      aria-label={t.baymax.details}
      className="baymax-main"
      id="baymax-detail"
      tabIndex={-1}
    >
      {!selectedId ? (
        <EmptyState description={t.baymax.chooseIssueHint} title={t.baymax.chooseIssue} />
      ) : detail.error ? (
        <div className="baymax-detail-state">
          <Button onClick={back} size="sm" variant="ghost">
            {t.baymax.backToQueue}
          </Button>
          <ReadFailure error={detail.error} fetching={detail.isFetching} retry={() => void detail.refetch()} />
        </div>
      ) : detail.isLoading ? (
        <LoadingRows />
      ) : detail.data ? (
        <IssueDetailCard
          issue={detail.data}
          key={`${project}:${selectedId}`}
          onBack={back}
          projectName={projects.data?.find(item => item.id === project)?.projectName}
        />
      ) : null}
    </section>
  )
}

export const BAYMAX_ROUTE = '/baymax'
export const baymaxTodayKey = todayKey
