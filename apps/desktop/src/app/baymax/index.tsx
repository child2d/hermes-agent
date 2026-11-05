import './workbench.css'

import { useIsFetching, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'

import { Button } from '@/components/ui/button'
import { SearchField } from '@/components/ui/search-field'
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useI18n } from '@/i18n'
import { ChevronLeft, RefreshCw } from '@/lib/icons'
import { revealPaneColumn } from '@/store/layout'

import {
  type BaymaxIssue,
  type BaymaxReadError,
  daysLate,
  fetchIssue,
  fetchIssues,
  isOpen,
  issueQueryKey,
  issuesQueryKey,
  isSuspended,
  todayKey
} from './api'
import { IssueDetailCard, IssueSummaryCard } from './issue-cards'
import { type Focus, FOCUSES, SCENES, useBaymaxRoute } from './route-state'

type Copy = ReturnType<typeof useI18n>['t']

/** The four dispositions the workbench is read in, plus a plan date still ahead
 *  of us — an open ticket with a future deadline has to land somewhere honest. */
type GroupKey = 'overdue' | 'suspended' | 'today' | 'undated' | 'upcoming'

const GROUP_ORDER: GroupKey[] = ['overdue', 'today', 'upcoming', 'undated', 'suspended']

function failureText(t: Copy, error: unknown) {
  const { kind, note } = (error as BaymaxReadError | undefined) ?? {}

  return [kind, note].filter(Boolean).join(': ') || t.baymax.failedDesc
}

/** One ticket, one group: closed tickets leave the queue, suspended ones are
 *  parked (never overdue), and a deadline in the future is scheduled. */
function bucketOf(issue: BaymaxIssue): GroupKey | null {
  if (!isOpen(issue)) {
    return null
  }

  if (isSuspended(issue)) {
    return 'suspended'
  }

  const late = daysLate(issue)

  if (late === null) {
    return 'undated'
  }

  if (late > 0) {
    return 'overdue'
  }

  return late === 0 ? 'today' : 'upcoming'
}

function matchesQuery(issue: BaymaxIssue, query: string) {
  if (!query) {
    return true
  }

  return [issue.title, issue.issueKey, issue.assigneeName, issue.status?.name].some(value =>
    value?.toLocaleLowerCase().includes(query)
  )
}

function LoadingQueue() {
  return (
    <div aria-busy="true" className="baymax-skeletons">
      {Array.from({ length: 4 }, (_, index) => (
        <div className="baymax-skeleton-card" key={index}>
          <span className="baymax-skeleton-line is-title" />
          <span className="baymax-skeleton-line is-meta" />
        </div>
      ))}
    </div>
  )
}

function LoadingDetail() {
  return (
    <div aria-busy="true" className="baymax-dc is-skeleton">
      <span className="baymax-skeleton-line is-title" />
      <span className="baymax-skeleton-line is-meta" />
      <span className="baymax-skeleton-line is-body" />
      <span className="baymax-skeleton-line is-body" />
    </div>
  )
}

function ReadFailure({ error, fetching, retry }: { error: unknown; fetching: boolean; retry: () => void }) {
  const { t } = useI18n()

  return (
    <div className="baymax-state is-error">
      <p className="baymax-state-title">{t.baymax.failedTitle}</p>
      <p className="baymax-state-code">{failureText(t, error)}</p>
      <p className="baymax-state-desc">{t.baymax.failedDesc}</p>
      <Button disabled={fetching} onClick={retry} size="sm" variant="outline">
        {t.baymax.retry}
      </Button>
    </div>
  )
}

/** One deliberate navigation handoff, never a query-completion effect. */
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
  const searchRef = useRef<HTMLInputElement>(null)

  const issues = useQuery({
    enabled: Boolean(project),
    queryKey: issuesQueryKey(project, scene),
    queryFn: () => fetchIssues(project, scene),
    retry: false
  })

  const rows = issues.data?.issues ?? []
  const query = search.trim().toLocaleLowerCase()
  const bucketMatches = (issue: BaymaxIssue) => bucketOf(issue) !== null && matchesQuery(issue, query)
  // Counts describe what the search matched; the group filter only chooses what
  // is on screen — so the tabs never lie about the rest of the view.
  const matched = rows.filter(bucketMatches)
  const visible = focus === 'all' ? matched : matched.filter(issue => bucketOf(issue) === focus)

  const counts: Record<GroupKey | 'all', number> = {
    all: matched.length,
    overdue: 0,
    suspended: 0,
    today: 0,
    undated: 0,
    upcoming: 0
  }

  for (const issue of matched) {
    const key = bucketOf(issue)

    if (key) {
      counts[key] += 1
    }
  }

  const labels: Record<GroupKey, string> = {
    overdue: t.baymax.groupOverdue,
    suspended: t.baymax.groupSuspended,
    today: t.baymax.groupToday,
    undated: t.baymax.groupUndated,
    upcoming: t.baymax.groupUpcoming
  }

  const hints: Record<GroupKey, string> = {
    overdue: t.baymax.groupOverdueHint,
    suspended: t.baymax.groupSuspendedHint,
    today: t.baymax.groupTodayHint,
    undated: t.baymax.groupUndatedHint,
    upcoming: t.baymax.groupUpcomingHint
  }

  const sceneLabels = {
    ALL_TODO: t.baymax.tabAll,
    DUE_SOON: t.baymax.tabDueSoon,
    MY_CREATED: t.baymax.tabCreated,
    MY_PROCESSING: t.baymax.tabProcessing
  }

  const known = Boolean(issues.data) && !issues.error
  const focusedGroups: GroupKey[] = focus === 'all' ? GROUP_ORDER : [focus]

  /** Focus lands on the first row of the queue, or back in search when empty. */
  const focusFirstRow = () => {
    requestAnimationFrame(() => {
      const row = globalThis.document.querySelector<HTMLButtonElement>('.baymax-card[data-issue-id]')

      if (row) {
        row.focus()
      } else {
        searchRef.current?.focus()
      }
    })
  }

  const setFocus = (next: Focus) => {
    const scoped = (issue: BaymaxIssue) => next === 'all' || bucketOf(issue) === next
    const keep = selectedId && visible.some(issue => issue.id === selectedId && scoped(issue)) ? selectedId : null

    change({ focus: next === 'all' ? null : next, issue: keep })
    focusFirstRow()
  }

  /** The empty group offers the way out instead of dead-ending. */
  const showAll = () => {
    change({ focus: null })
    focusFirstRow()
  }

  const onSearch = (value: string) => {
    const next = value.trim().toLocaleLowerCase()

    const keep =
      selectedId &&
      rows.some(
        issue =>
          issue.id === selectedId &&
          bucketOf(issue) !== null &&
          (focus === 'all' || bucketOf(issue) === focus) &&
          matchesQuery(issue, next)
      )
        ? selectedId
        : null

    change({ issue: keep, q: value || null }, true)
  }

  // Arrows belong to the queue only: never steal them from a text field.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) {
        return
      }

      const target = event.target as HTMLElement | null
      const typing = Boolean(target?.closest('input, textarea, select, [contenteditable="true"]'))

      const inOverlay = Boolean(
        target?.closest(
          '[role="combobox"], [role="listbox"], [role="menu"], [role="dialog"], [data-radix-popper-content-wrapper]'
        )
      )

      if (event.key === '/' && !typing && !inOverlay) {
        event.preventDefault()
        searchRef.current?.focus()

        return
      }

      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
        return
      }

      if (typing || inOverlay) {
        return
      }

      const cards = Array.from(globalThis.document.querySelectorAll<HTMLButtonElement>('.baymax-card[data-issue-id]'))

      if (!cards.length) {
        return
      }

      event.preventDefault()

      const index = cards.findIndex(card => card.dataset.issueId === selectedId)
      const focused = cards.indexOf(globalThis.document.activeElement as HTMLButtonElement)
      const step = event.key === 'ArrowDown' ? 1 : -1
      // Nothing selected yet: start from the row that already has focus, else
      // from the first (ArrowDown) or last (ArrowUp) row.
      const from = index >= 0 ? index : focused
      const base = from >= 0 ? from : step > 0 ? -1 : cards.length
      const next = cards[Math.min(cards.length - 1, Math.max(0, base + step))]

      next.focus({ preventScroll: true })
      next.scrollIntoView({ block: 'nearest' })
      change({ issue: next.dataset.issueId ?? null })
    }

    globalThis.document.addEventListener('keydown', onKeyDown)

    return () => globalThis.document.removeEventListener('keydown', onKeyDown)
  }, [change, selectedId])

  return (
    <section aria-label={t.baymax.queue} className="baymax-queue" data-testid="baymax-list-pane">
      <header className="baymax-queue-header">
        <div className="baymax-queue-title">
          <h2>{t.baymax.queueHeading}</h2>
          <span className="baymax-queue-count">{known ? t.baymax.countLabel(matched.length) : '—'}</span>
          <button
            aria-label={t.baymax.refresh}
            className="baymax-refresh"
            disabled={refreshing}
            onClick={() => void client.invalidateQueries({ queryKey: ['baymax'] })}
            type="button"
          >
            <RefreshCw aria-hidden="true" />
          </button>
        </div>
        {Boolean(projects.data?.length) && (
          <div className="baymax-scopes">
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
          </div>
        )}
        {project && !projects.error && (
          <SearchField
            aria-label={t.baymax.searchIssues}
            containerClassName="baymax-queue-search"
            inputRef={searchRef}
            onChange={onSearch}
            placeholder={t.baymax.searchPlaceholder}
            value={search}
          />
        )}
        <div aria-label={t.baymax.focus} className="baymax-tabs" role="group">
          {FOCUSES.map(value => {
            const label = value === 'all' ? t.baymax.filterAll : labels[value]
            const count = known ? counts[value] : '—'

            return (
              <button
                aria-label={`${label} ${count}`}
                aria-pressed={value === focus}
                className="baymax-tab"
                disabled={!known}
                key={value}
                onClick={() => setFocus(value)}
                type="button"
              >
                {label}
                <b>{count}</b>
              </button>
            )
          })}
        </div>
      </header>
      <div aria-busy={projects.isLoading || issues.isLoading} className="baymax-list">
        {projects.error ? (
          <ReadFailure error={projects.error} fetching={projects.isFetching} retry={() => void projects.refetch()} />
        ) : projects.isLoading ? (
          <LoadingQueue />
        ) : !project ? (
          <div className="baymax-state">
            <p className="baymax-state-title">{t.baymax.noProjectTitle}</p>
            <p className="baymax-state-desc">{t.baymax.noProjectDesc}</p>
          </div>
        ) : issues.error ? (
          <ReadFailure error={issues.error} fetching={issues.isFetching} retry={() => void issues.refetch()} />
        ) : issues.isLoading ? (
          <LoadingQueue />
        ) : !matched.length && focus === 'all' ? (
          <p className="baymax-list-empty">{t.baymax.groupEmptyOther}</p>
        ) : (
          focusedGroups.map(key => {
            const group = visible.filter(issue => bucketOf(issue) === key)

            return (
              <div className="baymax-group-block" data-group={key} key={key}>
                <div className="baymax-group">
                  <b>{labels[key]}</b>
                  <span className="baymax-group-count">{group.length}</span>
                  <span aria-hidden="true" className="rule" />
                  <span className="baymax-group-hint">{hints[key]}</span>
                </div>
                {group.length ? (
                  group.map(issue => (
                    <IssueSummaryCard
                      issue={issue}
                      key={issue.id}
                      onSelect={item => {
                        change({ issue: item.id })
                        focusDetail()
                      }}
                      selected={selectedId === issue.id}
                    />
                  ))
                ) : (
                  <p className="baymax-group-empty">
                    {t.baymax.emptyTitle}
                    {focus !== 'all' && (
                      <button className="baymax-link" onClick={showAll} type="button">
                        {t.baymax.viewAll}
                      </button>
                    )}
                  </p>
                )}
              </div>
            )
          })
        )}
      </div>
      <footer className="baymax-queue-foot">
        <span>{t.baymax.readOnlyNote}</span>
        {known && <span>{t.baymax.loadedScope(rows.length, issues.data?.total ?? rows.length)}</span>}
        <span>{t.baymax.todayFooter(todayKey().slice(5))}</span>
      </footer>
    </section>
  )
}

/** Main owns only the selected detail read. The queue lives in the shell list. */
export function BaymaxView() {
  const { t } = useI18n()
  const { project, selectedId, projects, change } = useBaymaxRoute()
  const workRef = useRef<HTMLDivElement>(null)

  const detail = useQuery({
    enabled: Boolean(project && selectedId),
    queryKey: issueQueryKey(project, selectedId ?? ''),
    queryFn: () => fetchIssue(project, selectedId!),
    retry: false
  })

  // A different ticket starts at the top of its own page.
  useEffect(() => {
    if (workRef.current) {
      workRef.current.scrollTop = 0
    }
  }, [selectedId])

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

  const projectName = projects.data?.find(item => item.id === project)?.projectName

  return (
    <section
      aria-busy={Boolean(selectedId) && detail.isLoading}
      aria-label={t.baymax.details}
      className="baymax-main"
      id="baymax-detail"
      tabIndex={-1}
    >
      <div className="baymax-main-bar">
        <span className="baymax-main-key">{detail.data?.issueKey ?? '—'}</span>
        <span aria-hidden="true" className="baymax-main-sep">
          ·
        </span>
        <span className="baymax-main-project">{projectName ?? '—'}</span>
        <button className="baymax-main-back" onClick={back} type="button">
          <ChevronLeft aria-hidden="true" />
          {t.baymax.backToQueue}
        </button>
      </div>
      <div className="baymax-work" ref={workRef}>
        <div className="baymax-work-inner">
          {!selectedId ? (
            <article className="baymax-dc is-empty">
              <h2 className="baymax-dc-empty-title">{t.baymax.chooseIssue}</h2>
              <p className="baymax-prose is-muted">{t.baymax.chooseIssueHint}</p>
            </article>
          ) : detail.error ? (
            <ReadFailure error={detail.error} fetching={detail.isFetching} retry={() => void detail.refetch()} />
          ) : detail.isLoading ? (
            <LoadingDetail />
          ) : detail.data ? (
            <IssueDetailCard issue={detail.data} key={`${project}:${selectedId}`} />
          ) : null}
        </div>
      </div>
    </section>
  )
}

export const BAYMAX_ROUTE = '/baymax'
export const baymaxTodayKey = todayKey
