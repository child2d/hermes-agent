import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IssueDetailCard, IssueSummaryCard } from './issue-cards'

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString()

const issue = {
  actualWorkload: 2.5,
  assigneeName: 'Ada Chen',
  comments: [
    { authorName: 'Reviewer', content: 'Verified progress', createdAt: daysAgo(1), id: 'comment' },
    { authorName: 'Screener', content: 'Still screening the pile', createdAt: daysAgo(4), id: 'older' }
  ],
  description: '<script>plain text only</script>',
  estimateEndDate: daysAgo(3),
  estimateStartDate: daysAgo(9),
  id: 'test',
  issueKey: 'PM-42',
  priority: { name: 'P1' },
  status: { isClosed: false, name: 'In development' },
  title: 'A real ticket title',
  updatedAt: daysAgo(1)
}

afterEach(cleanup)

describe('portable issue cards without a router or query provider', () => {
  it('selects through a callback and reads one card without offering unsupported actions', () => {
    const select = vi.fn()

    render(<IssueSummaryCard issue={issue} onSelect={select} selected />)

    const card = screen.getByRole('button', { name: /PM-42/ })

    expect(card.getAttribute('aria-selected')).toBe('true')
    expect(card.textContent).toContain(issue.title)
    expect(card.textContent).toContain('In development')
    expect(card.textContent).toContain('Ada Chen owns')
    expect(card.textContent).toContain('3d late')
    fireEvent.click(card)
    expect(select).toHaveBeenCalledWith(issue)
    expect(screen.queryByRole('button', { name: /save|reply|delete|chat|attach/i })).toBeNull()
  })

  it('marks the unselected card and parks a suspended ticket instead of calling it late', () => {
    const { rerender } = render(<IssueSummaryCard issue={issue} onSelect={() => {}} />)

    expect(screen.getByRole('button', { name: /PM-42/ }).getAttribute('aria-selected')).toBe('false')

    rerender(<IssueSummaryCard issue={{ ...issue, status: { isClosed: false, name: '挂起' } }} onSelect={() => {}} />)

    const card = screen.getByRole('button', { name: /PM-42/ })

    expect(card.textContent).toContain('Suspended')
    expect(card.textContent).not.toContain('d late')
  })

  it('renders the ticket as one sheet: chips, a fact strip, description and dated comments', () => {
    render(<IssueDetailCard issue={issue} />)

    const sheet = screen.getByTestId('baymax-issue-detail-card')

    expect(screen.getByRole('heading', { name: issue.title })).toBeTruthy()
    expect(within(sheet).getByText('In development')).toBeTruthy()
    expect(within(sheet).getByText('P1')).toBeTruthy()
    expect(within(sheet).getByText('3d late')).toBeTruthy()
    expect(within(sheet).getByText('Ada Chen')).toBeTruthy()
    expect(within(sheet).getByText('2.5')).toBeTruthy()
    expect(within(sheet).getByText(issue.description)).toBeTruthy()
    expect(within(sheet).getByText('Reviewer')).toBeTruthy()
    expect(within(sheet).getByText('Verified progress')).toBeTruthy()
    expect(within(sheet).getByText('Latest')).toBeTruthy()
    expect(within(sheet).getByText('Progress · 2')).toBeTruthy()
    expect(within(sheet).getByText('Read-only · no writes')).toBeTruthy()

    // No card inside a card, and no write-back affordance.
    expect(sheet.querySelector('[data-slot="card"]')).toBeNull()
    expect(within(sheet).queryByRole('button', { name: /save|reply|delete|attach|send|edit/i })).toBeNull()
    expect(sheet.querySelectorAll('kbd')).toHaveLength(3)
  })

  it('handles absent description, dates, metadata and comments without fabricating content', () => {
    render(<IssueDetailCard issue={{ id: 'empty', issueKey: 'PM-0', title: 'Minimal ticket' }} />)

    expect(screen.getByText('No description on this issue.')).toBeTruthy()
    expect(screen.getByText('No progress comments on this issue yet.')).toBeTruthy()
    expect(screen.getByText('Progress · 0')).toBeTruthy()
    expect(screen.queryByText('Latest')).toBeNull()
    expect(screen.queryByText(/d late/)).toBeNull()
    expect(screen.getAllByText('—')).toHaveLength(4)
    expect(screen.queryByRole('button')).toBeNull()
  })
})
