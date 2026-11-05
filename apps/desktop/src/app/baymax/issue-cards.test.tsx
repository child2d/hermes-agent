import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { IssueDetailCard, IssueSummaryCard } from './issue-cards'

const issue = {
  id: 'test',
  issueKey: 'PM-42',
  title: 'A real ticket title',
  assigneeName: 'Owner',
  description: '<script>plain text only</script>',
  comments: [{ id: 'comment', authorName: 'Reviewer', createdAt: '2026-11-01', content: 'Verified progress' }]
}

afterEach(cleanup)

describe('portable issue cards without a router or query provider', () => {
  it('selects through a callback and reads data without offering unsupported actions', () => {
    const select = vi.fn()
    const back = vi.fn()
    render(
      <>
        <IssueSummaryCard issue={issue} onSelect={select} selected />
        <IssueDetailCard issue={issue} onBack={back} projectName="Project" />
      </>
    )
    fireEvent.click(screen.getByRole('button', { name: /PM-42/ }))
    expect(select).toHaveBeenCalledWith(issue)
    expect(screen.getByRole('heading', { name: issue.title })).toBeTruthy()
    expect(screen.getByText(issue.description)).toBeTruthy()
    const tab = screen.getByRole('tab', { name: /comments/i })
    fireEvent.mouseDown(tab)
    fireEvent.click(tab)
    expect(screen.getByText('Reviewer')).toBeTruthy()
    expect(screen.getByText('Verified progress')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /save|reply|delete|chat|attach/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /attach/i })).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Back to queue' }))
    expect(back).toHaveBeenCalledOnce()
  })

  it('handles absent description, dates, metadata and comments without fabricating content', () => {
    render(<IssueDetailCard issue={{ id: 'empty', issueKey: 'PM-0', title: 'Minimal ticket' }} />)
    expect(screen.getByText('No description provided.')).toBeTruthy()
    const tab = screen.getByRole('tab', { name: /comments/i })
    fireEvent.mouseDown(tab)
    fireEvent.click(tab)
    expect(screen.getByText(/No progress comments/i)).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })
})
