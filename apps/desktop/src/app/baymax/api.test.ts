import { describe, expect, it } from 'vitest'

import { daysLate, isSuspended, summarize, todayKey } from './api'

const NOW = new Date('2026-10-20T09:00:00+08:00')
const day = (offset: number) => new Date(NOW.getTime() + offset * 86_400_000).toISOString()

const issue = (over: Record<string, unknown> = {}) => ({
  id: '1',
  issueKey: 'PM-1',
  status: { isClosed: false, name: 'DEVELOPMENT/开发中' },
  title: 't',
  ...over
})

describe('baymax workbench arithmetic', () => {
  it('reads the deadline as the local calendar day', () => {
    expect(todayKey(NOW)).toBe('2026-10-20')
  })

  it('counts whole days past the deadline, and 0 for today', () => {
    expect(daysLate(issue({ estimateEndDate: day(-3) }) as never, NOW)).toBe(3)
    expect(daysLate(issue({ estimateEndDate: day(0) }) as never, NOW)).toBe(0)
    expect(daysLate(issue({ estimateEndDate: day(2) }) as never, NOW)).toBe(-2)
    expect(daysLate(issue() as never, NOW)).toBeNull()
  })

  it('splits the backlog into overdue / due today / no deadline', () => {
    const summary = summarize(
      [
        issue({ estimateEndDate: day(-5), id: 'a' }),
        issue({ estimateEndDate: day(0), id: 'b' }),
        issue({ id: 'c' }),
        issue({ estimateEndDate: day(-1), id: 'd', status: { isClosed: true, name: 'Done/已完成' } })
      ] as never,
      NOW
    )

    expect(summary).toEqual({ dueToday: 1, noDeadline: 1, overdue: 1, total: 4 })
  })

  it('does not report a suspended issue as overdue — parked is not late', () => {
    const parked = issue({ estimateEndDate: day(-30), status: { isClosed: false, name: '已挂起' } })

    expect(isSuspended(parked as never)).toBe(true)
    expect(summarize([parked] as never, NOW).overdue).toBe(0)
  })
})
