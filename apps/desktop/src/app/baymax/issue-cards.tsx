import './workbench.css'

import type { ReactNode } from 'react'

import { useI18n } from '@/i18n'
import { cn } from '@/lib/utils'

import { type BaymaxIssue, type BaymaxIssueDetail, daysLate, isOpen, issueDay, isSuspended } from './api'

type BaymaxCopy = ReturnType<typeof useI18n>['t']['baymax']

/** The plan year is already on the ticket; a row reads the calendar day. */
function shortDay(iso?: string): string {
  const day = issueDay(iso)

  return day.length === 10 ? day.slice(5) : day
}

interface When {
  hot?: boolean
  text: string
  warm?: boolean
}

/** One relative fact per card: how long, or which disposition. Never a guess. */
function whenOf(issue: BaymaxIssue, t: BaymaxCopy): When {
  const late = daysLate(issue)

  if (!isOpen(issue)) {
    return { text: shortDay(issue.estimateEndDate) }
  }

  if (isSuspended(issue)) {
    return { text: t.groupSuspended }
  }

  if (late === null) {
    return { text: t.groupUndated }
  }

  if (late > 0) {
    return { hot: true, text: t.carriedOverDays(late) }
  }

  return late === 0 ? { text: t.dueToday, warm: true } : { text: shortDay(issue.estimateEndDate) }
}

function planSpan(issue: BaymaxIssue): string {
  const start = shortDay(issue.estimateStartDate)
  const end = shortDay(issue.estimateEndDate)

  if (start === '—' && end === '—') {
    return '—'
  }

  return start === '—' ? end : `${start} → ${end}`
}

export interface IssueSummaryCardProps {
  issue: BaymaxIssue
  onSelect: (issue: BaymaxIssue) => void
  selected?: boolean
}

/** Portable read-only presentation: no query, router, store or chat dependency. */
export function IssueSummaryCard({ issue, onSelect, selected = false }: IssueSummaryCardProps) {
  const { t } = useI18n()
  const when = whenOf(issue, t.baymax)

  return (
    <button
      aria-controls="baymax-detail"
      aria-selected={selected}
      className="baymax-card"
      data-issue-id={issue.id}
      onClick={() => onSelect(issue)}
      type="button"
    >
      <span className="baymax-card-title">{issue.title}</span>
      <span className={cn('baymax-card-when', when.hot && 'is-late', when.warm && 'is-today')}>{when.text}</span>
      <span className="baymax-card-meta">
        <span className="baymax-card-key">{issue.issueKey}</span>
        <span aria-hidden="true" className="baymax-card-dot">
          ·
        </span>
        <span className="baymax-card-status">{issue.status?.name ?? '—'}</span>
        <span className="baymax-card-owner">{t.baymax.ownerOf(issue.assigneeName ?? '—')}</span>
      </span>
    </button>
  )
}

function Fact({
  children,
  hot = false,
  label,
  mono = false
}: {
  children?: ReactNode
  hot?: boolean
  label: string
  mono?: boolean
}) {
  const empty = children === undefined || children === null || children === ''
  const value = empty ? '—' : children

  return (
    <div>
      <dt>{label}</dt>
      <dd className={cn(mono && 'is-mono', hot && 'is-hot')} title={typeof value === 'string' ? value : undefined}>
        {value}
      </dd>
    </div>
  )
}

export interface IssueDetailCardProps {
  issue: BaymaxIssueDetail
}

/** The ticket is ONE sheet: chips, a fact strip and rules — nothing nested. */
export function IssueDetailCard({ issue }: IssueDetailCardProps) {
  const { t } = useI18n()
  const late = daysLate(issue)
  const carried = isOpen(issue) && !isSuspended(issue) && late !== null && late > 0
  const comments = issue.comments ?? []

  return (
    <article className="baymax-dc" data-testid="baymax-issue-detail-card">
      <header className="baymax-dc-head">
        <h1 className="baymax-dc-title">{issue.title}</h1>
        <div className="baymax-chips">
          {issue.status?.name && <span className="baymax-chip is-state">{issue.status.name}</span>}
          {issue.priority?.name && <span className="baymax-chip">{issue.priority.name}</span>}
          {carried && <span className="baymax-chip is-late">{t.baymax.carriedOverDays(late)}</span>}
        </div>
      </header>
      <dl className="baymax-facts">
        <Fact label={t.baymax.colOwner}>{issue.assigneeName}</Fact>
        <Fact label={t.baymax.planSpan} mono>
          {planSpan(issue)}
        </Fact>
        <Fact label={t.baymax.lastUpdated} mono>
          {issue.updatedAt ? issueDay(issue.updatedAt) : undefined}
        </Fact>
        <Fact label={t.baymax.actualWorkload} mono>
          {issue.actualWorkload ?? undefined}
        </Fact>
      </dl>
      <div className="baymax-dc-body">
        <section className="baymax-sec">
          <h2>
            {t.baymax.sectionDescription}
            <span aria-hidden="true" className="rule" />
          </h2>
          <p className={cn('baymax-prose', !issue.description && 'is-muted')}>
            {issue.description || t.baymax.noDescription}
          </p>
        </section>
        <section className="baymax-sec">
          <h2>
            {`${t.baymax.sectionProgress} · ${comments.length}`}
            <span aria-hidden="true" className="rule" />
          </h2>
          {comments.length ? (
            <ul className="baymax-log">
              {comments.map((comment, index) => (
                <li key={comment.id}>
                  <time dateTime={comment.createdAt}>{shortDay(comment.createdAt)}</time>
                  <div>
                    <div className="baymax-log-who">
                      {comment.authorName ?? '—'}
                      {index === 0 && <span className="baymax-tag">{t.baymax.latestTag}</span>}
                    </div>
                    <p>{comment.content}</p>
                  </div>
                </li>
              ))}
            </ul>
          ) : (
            <p className="baymax-prose is-muted">{t.baymax.noComments}</p>
          )}
        </section>
      </div>
      <footer className="baymax-dc-foot">
        <span>{t.baymax.readOnlyNote}</span>
        <span className="sp" />
        <span className="baymax-keys">
          <kbd>↑</kbd>
          <kbd>↓</kbd>
          {t.baymax.keyboardSwitch}
        </span>
        <span className="baymax-keys">
          <kbd>/</kbd>
          {t.baymax.keyboardSearch}
        </span>
      </footer>
    </article>
  )
}
