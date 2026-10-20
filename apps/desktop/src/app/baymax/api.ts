/**
 * Baymax (个人工作台) data layer.
 *
 * Every read goes through the enterprise plugin's **read-only pack port**
 * (`POST /api/plugins/plankton-enterprise/packs/read`): it spawns the bundled
 * `shaoke-cli` with a fixed argv built from a declared template table, refuses
 * any template that is not a read, and answers `{kind, envelope}`. That door is
 * already the sanctioned way the desktop reads baymax (the `plankton-baymax-*`
 * session blocks use it), so this page adds no second backend and no writes.
 *
 * A plugin could not reach that namespace — `ctx.rest` is bound to the caller's
 * own `/api/plugins/<id>` — but this is core code, and `pluginRest` is core's
 * own namespace-scoped door.
 */

import { pluginRest } from '@/api/plugins'

const ENTERPRISE_PLUGIN = 'plankton-enterprise'
const BAYMAX_PACK = 'baymax'

/** The projection we ask `+issue-list` for. The CLI's default omits the plan
 *  dates, which are the whole point of a workbench (逾期 needs a deadline). */
const ISSUE_FIELDS = [
  'id',
  'issueKey',
  'title',
  'status',
  'priority',
  'typeId',
  'assigneeName',
  'createdAt',
  'updatedAt',
  'estimateStartDate',
  'estimateEndDate',
  'actualWorkload'
].join(',')

/** The four personal-workbench scenes the backend exposes. */
export type BaymaxScene = 'ALL_TODO' | 'DUE_SOON' | 'MY_CREATED' | 'MY_PROCESSING'

export interface BaymaxStatus {
  id?: string
  isClosed?: boolean
  name?: string
}

export interface BaymaxPriority {
  id?: string
  name?: string
}

export interface BaymaxLabel {
  id: string
  name: string
  color?: string
}

export interface BaymaxIssue {
  actualWorkload?: null | number | string
  assigneeName?: string
  createdAt?: string
  estimateEndDate?: string
  estimateStartDate?: string
  id: string
  issueKey: string
  labels?: BaymaxLabel[]
  priority?: BaymaxPriority
  status?: BaymaxStatus
  title: string
  typeId?: string
  updatedAt?: string
}

export interface BaymaxComment {
  authorName?: string
  content: string
  createdAt?: string
  id: string
}

export interface BaymaxIssueDetail extends BaymaxIssue {
  comments?: BaymaxComment[]
  description?: string
}

export interface BaymaxProject {
  id: string
  keyPrefix?: string
  projectName: string
}

export interface BaymaxIdentity {
  account?: string
  id: string
  name: string
}

/** What the read port answers for a template that could not run. `note` is the
 *  door's own diagnosis (`read-failed`, `cli-not-found`, `missing-param:…`). */
export class BaymaxReadError extends Error {
  constructor(
    readonly kind: string,
    readonly note: string
  ) {
    super(note || kind)
    this.name = 'BaymaxReadError'
  }
}

interface PackReadResult {
  envelope?: { data?: unknown; ok?: boolean }
  kind?: string
  note?: string
}

async function read<T>(templateId: string, params: Record<string, string>): Promise<T> {
  const result = await pluginRest<PackReadResult>(ENTERPRISE_PLUGIN, '/packs/read', {
    body: { packId: BAYMAX_PACK, templateId, params },
    method: 'POST',
    timeoutMs: 40_000
  })

  if (result?.kind !== 'ok' || result.envelope?.ok !== true) {
    throw new BaymaxReadError(result?.kind ?? 'read-failed', result?.note ?? '')
  }

  return result.envelope.data as T
}

export const fetchIdentity = () => read<BaymaxIdentity>('whoami', {})

export const fetchProjects = () =>
  read<{ data?: BaymaxProject[] }>('project-list', {}).then(data => data?.data ?? [])

export const issuesQueryKey = (project: string, scene: BaymaxScene) => ['baymax', 'issues', project, scene] as const

export const issueQueryKey = (project: string, id: string) => ['baymax', 'issue', project, id] as const

export const fetchIssues = async (project: string, scene: BaymaxScene, limit = 100) => {
  const data = await read<{ data?: BaymaxIssue[]; total?: number }>('list-issues', {
    fields: ISSUE_FIELDS,
    limit: String(limit),
    'project-id': project,
    scene
  })

  return { issues: data?.data ?? [], total: data?.total ?? 0 }
}

export const fetchIssue = (project: string, id: string) =>
  read<BaymaxIssueDetail>('get-issue', { id, 'project-id': project })

// ── Workbench arithmetic (pure, no React) ───────────────────────────────────

/** Local calendar day of an ISO timestamp — the day the user means by 截止. */
export function dayKey(iso?: string): null | string {
  if (!iso) {
    return null
  }

  const date = new Date(iso)

  if (Number.isNaN(date.getTime())) {
    return null
  }

  const month = `${date.getMonth() + 1}`.padStart(2, '0')
  const day = `${date.getDate()}`.padStart(2, '0')

  return `${date.getFullYear()}-${month}-${day}`
}

export function todayKey(now: Date = new Date()): string {
  return dayKey(now.toISOString()) as string
}

/** Whole days past the deadline (0 = due today, negative = still ahead). */
export function daysLate(issue: BaymaxIssue, now: Date = new Date()): null | number {
  const due = dayKey(issue.estimateEndDate)

  if (!due) {
    return null
  }

  const today = todayKey(now)
  const diff = (Date.parse(`${today}T00:00:00`) - Date.parse(`${due}T00:00:00`)) / 86_400_000

  return Math.round(diff)
}

export const isOpen = (issue: BaymaxIssue) => issue.status?.isClosed !== true

/** A suspended issue is open but deliberately parked — it must not be reported
 *  as 逾期 (the workbench counts what needs action today). Status names are the
 *  project's own, so the test is on the label, never on an id. */
export const isSuspended = (issue: BaymaxIssue) => (issue.status?.name ?? '').includes('挂起')

export interface BaymaxSummary {
  dueToday: number
  noDeadline: number
  overdue: number
  total: number
}

export function summarize(issues: readonly BaymaxIssue[], now: Date = new Date()): BaymaxSummary {
  let dueToday = 0
  let noDeadline = 0
  let overdue = 0

  for (const issue of issues) {
    if (!isOpen(issue)) {
      continue
    }

    const late = daysLate(issue, now)

    if (late === null) {
      noDeadline += 1
    } else if (late > 0 && !isSuspended(issue)) {
      overdue += 1
    } else if (late === 0) {
      dueToday += 1
    }
  }

  return { dueToday, noDeadline, overdue, total: issues.length }
}
