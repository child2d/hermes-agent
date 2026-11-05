import './workbench.css'

import type { ReactNode } from 'react'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardAction, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from '@/components/ui/card'
import { Separator } from '@/components/ui/separator'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useI18n } from '@/i18n'
import { ChevronLeft } from '@/lib/icons'

import { type BaymaxIssue, type BaymaxIssueDetail, daysLate, isOpen, isSuspended } from './api'

function DueLabel({ issue }: { issue: BaymaxIssue }) {
  const { t } = useI18n()
  const late = daysLate(issue)

  if (late === null) {
    return <span>{t.baymax.noDeadline}</span>
  }

  if (isOpen(issue) && !isSuspended(issue) && late > 0) {
    return <span className="baymax-late">{t.baymax.overdueDays(late)}</span>
  }

  if (isOpen(issue) && !isSuspended(issue) && late === 0) {
    return <span>{t.baymax.dueToday}</span>
  }

  return <time dateTime={issue.estimateEndDate}>{issue.estimateEndDate?.slice(0, 10)}</time>
}

export interface IssueSummaryCardProps {
  issue: BaymaxIssue
  selected?: boolean
  onSelect: (issue: BaymaxIssue) => void
}

/** Portable read-only presentation: no query, router, store or chat dependency. */
export function IssueSummaryCard({ issue, selected = false, onSelect }: IssueSummaryCardProps) {
  return (
    <button
      aria-controls="baymax-detail"
      aria-pressed={selected}
      className="baymax-summary"
      data-issue-id={issue.id}
      onClick={() => onSelect(issue)}
      type="button"
    >
      <span className="baymax-summary-meta">
        <span>{issue.issueKey}</span>
        <DueLabel issue={issue} />
      </span>
      <span className="baymax-summary-title">{issue.title}</span>
      <span className="baymax-summary-meta">
        <span className="truncate">{issue.assigneeName ?? '—'}</span>
        <span className="truncate">{issue.status?.name}</span>
      </span>
    </button>
  )
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children ?? '—'}</dd>
    </div>
  )
}

export interface IssueDetailCardProps {
  issue: BaymaxIssueDetail
  projectName?: string
  onBack?: () => void
}

export function IssueDetailCard({ issue, projectName, onBack }: IssueDetailCardProps) {
  const { t } = useI18n()
  const day = (value?: string) => value?.slice(0, 10) ?? '—'

  return (
    <Card className="baymax-ticket" data-testid="baymax-issue-detail-card">
      <CardHeader>
        <CardDescription>{issue.issueKey}</CardDescription>
        <CardTitle>
          <h1>{issue.title}</h1>
        </CardTitle>
        {onBack && (
          <CardAction>
            <Button onClick={onBack} size="sm" variant="ghost">
              <ChevronLeft aria-hidden="true" />
              {t.baymax.backToQueue}
            </Button>
          </CardAction>
        )}
      </CardHeader>
      <Separator />
      <CardContent>
        <div className="baymax-ticket-status">
          <div className="flex flex-wrap gap-2">
            {issue.status?.name && <Badge variant="secondary">{issue.status.name}</Badge>}
            {issue.priority?.name && <Badge variant="outline">{issue.priority.name}</Badge>}
          </div>
          <DueLabel issue={issue} />
        </div>
        <dl className="baymax-facts">
          <Fact label={t.baymax.project}>{projectName}</Fact>
          <Fact label={t.baymax.colOwner}>{issue.assigneeName}</Fact>
          <Fact label={t.baymax.planStart}>{day(issue.estimateStartDate)}</Fact>
          <Fact label={t.baymax.planEnd}>{day(issue.estimateEndDate)}</Fact>
          <Fact label={t.baymax.actualWorkload}>{issue.actualWorkload}</Fact>
          <Fact label={t.baymax.lastUpdated}>{day(issue.updatedAt)}</Fact>
        </dl>
        <Tabs className="baymax-ticket-tabs" defaultValue="details">
          <TabsList aria-label={t.baymax.details}>
            <TabsTrigger value="details">{t.baymax.details}</TabsTrigger>
            <TabsTrigger value="comments">
              {t.baymax.comments} <span className="baymax-comment-count">{issue.comments?.length ?? 0}</span>
            </TabsTrigger>
          </TabsList>
          <TabsContent value="details">
            <p className="baymax-description">{issue.description || t.baymax.noDescription}</p>
          </TabsContent>
          <TabsContent value="comments">
            {issue.comments?.length ? (
              <ol className="baymax-comments">
                {issue.comments.map(comment => (
                  <li key={comment.id}>
                    <div className="baymax-comment-author">
                      <strong>{comment.authorName ?? '—'}</strong>
                      <time dateTime={comment.createdAt}>{day(comment.createdAt)}</time>
                    </div>
                    <p>{comment.content}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="baymax-muted">{t.baymax.noComments}</p>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
      <CardFooter>
        <p className="baymax-muted">{t.baymax.detailHint}</p>
      </CardFooter>
    </Card>
  )
}
