import { type ThreadAssistantMessagePart, type ThreadMessage } from '@assistant-ui/react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stubThreadEnvironment, stubThreadViewportSize, ThreadRuntime } from '@/components/assistant-ui/test-utils'
import { Thread } from '@/components/assistant-ui/thread'
import { clearAllPrompts } from '@/store/prompts'
import { $activeSessionId } from '@/store/session'
import { $toolDisclosureStates } from '@/store/tool-view'

import { finalTextIndex } from './turn-process'

stubThreadEnvironment()
stubThreadViewportSize()

const createdAt = new Date('2026-06-03T00:00:00.000Z')

const message = (
  content: ThreadAssistantMessagePart[],
  status: ThreadMessage['status'],
  id = 'assistant-turn-process'
): ThreadMessage =>
  ({
    id,
    role: 'assistant',
    content,
    status,
    createdAt,
    metadata: {
      unstable_state: null,
      unstable_annotations: [],
      unstable_data: [],
      steps: [],
      custom: {}
    }
  }) as unknown as ThreadMessage

// Two activity calls in a row, so the run earns a summary line of its own.
const work = (): ThreadAssistantMessagePart[] =>
  [
    { type: 'reasoning', text: 'thinking it over' },
    {
      type: 'tool-call',
      toolCallId: 'read-1',
      toolName: 'read_file',
      args: { path: '/repo/a.ts' },
      argsText: JSON.stringify({ path: '/repo/a.ts' }),
      result: { content: 'export const a = 1' }
    },
    {
      type: 'tool-call',
      toolCallId: 'term-1',
      toolName: 'terminal',
      args: { command: 'ls' },
      argsText: JSON.stringify({ command: 'ls' }),
      result: { exit_code: 0, stdout: 'a.ts' }
    }
  ]

const answer: ThreadAssistantMessagePart = { type: 'text', text: 'the closing answer' }

function Harness({ content, status }: { content: ThreadAssistantMessagePart[]; status: ThreadMessage['status'] }) {
  return (
    <ThreadRuntime messages={[message(content, status)]}>
      <Thread />
    </ThreadRuntime>
  )
}

const userTurn = (): ThreadMessage =>
  ({
    id: 'u-turn',
    role: 'user',
    content: [{ type: 'text', text: 'do it' }],
    attachments: [],
    createdAt,
    metadata: { custom: {} }
  }) as unknown as ThreadMessage

function TranscriptHarness({ messages }: { messages: ThreadMessage[] }) {
  return (
    <ThreadRuntime messages={messages}>
      <Thread />
    </ThreadRuntime>
  )
}

const settled = { type: 'complete', reason: 'stop' } as ThreadMessage['status']

const foldRow = (container: HTMLElement) => container.querySelector('[data-slot="aui_turn-process"]')

beforeEach(() => {
  clearAllPrompts()
  $activeSessionId.set('sess-1')
  $toolDisclosureStates.set({})
})

afterEach(() => {
  cleanup()
  $activeSessionId.set(null)
})

describe('finalTextIndex', () => {
  it('names the closing reply, not the narration before it', () => {
    expect(
      finalTextIndex([{ type: 'reasoning' }, { type: 'tool-call' }, { type: 'text', text: 'first' }, { type: 'text', text: 'second' }])
    ).toBe(3)
  })

  it('ignores the empty continuation assistant-ui appends after a tool call', () => {
    expect(finalTextIndex([{ type: 'text', text: 'the answer' }, { type: 'text', text: '' }])).toBe(0)
    expect(finalTextIndex([{ type: 'text', text: 'the answer' }, { type: 'text', text: '  \n' }])).toBe(0)
  })

  it('reports no reply at all when the turn ended on work', () => {
    expect(finalTextIndex([{ type: 'reasoning' }, { type: 'tool-call' }, { type: 'text', text: '' }])).toBe(-1)
    expect(finalTextIndex([])).toBe(-1)
  })
})

describe('a settled turn', () => {
  it('folds the work behind one row and leaves the answer in place', async () => {
    const { container } = render(<Harness content={[...work(), answer]} status={settled} />)

    expect(await screen.findByText('the closing answer')).toBeTruthy()

    const row = foldRow(container)
    expect(row).not.toBeNull()
    expect(row?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    // Folded means gone from the DOM, not merely clipped: nothing for a reader —
    // or a text search — to trip over above the answer.
    expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(0)
    expect(container.querySelector('[data-slot="aui_thinking-disclosure"]')).toBeNull()
  })

  it('opens the whole work back up on click', async () => {
    const { container } = render(<Harness content={[...work(), answer]} status={settled} />)

    fireEvent.click(await screen.findByRole('button', { name: /Worked|已处理/ }))

    await waitFor(() => {
      expect(container.querySelector('[data-tool-summary]')).not.toBeNull()
    })
    expect(container.querySelector('[data-slot="aui_thinking-disclosure"]')).not.toBeNull()
  })

  it('folds work that never got a closing reply: one turn is several messages', async () => {
    const { container } = render(<Harness content={work()} status={settled} />)

    const row = foldRow(container)
    expect(row).not.toBeNull()
    expect(row?.querySelector('button')?.getAttribute('aria-expanded')).toBe('false')
    // Folded whole, so not even the run's own summary line survives outside it.
    expect(container.querySelector('[data-tool-summary]')).toBeNull()
  })

  it('leaves a lone step alone: one row is not worth a header over it', async () => {
    const { container } = render(
      <Harness content={[work()[1] as ThreadAssistantMessagePart]} status={settled} />
    )

    await waitFor(() => {
      expect(container.querySelectorAll('[data-tool-row]')).toHaveLength(1)
    })
    expect(foldRow(container)).toBeNull()
  })
})

describe('one question, several messages', () => {
  const twoAnswers = () =>
    [userTurn(), message(work(), settled, 'a-interim'), message([answer], settled, 'a-final')] as ThreadMessage[]

  it('folds every message but the reply behind ONE row', async () => {
    const { container } = render(<TranscriptHarness messages={twoAnswers()} />)

    expect(await screen.findByText('the closing answer')).toBeTruthy()

    // ONE header for the whole question, and the interim message is not on
    // screen at all — not its text, not its tool rows.
    expect(container.querySelectorAll('[data-slot="aui_turn-process"]')).toHaveLength(1)
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(1)
    expect(container.querySelector('[data-tool-summary]')).toBeNull()
    expect(container.querySelector('[data-slot="aui_thinking-disclosure"]')).toBeNull()
  })

  it('brings the interim work back when the one row is opened', async () => {
    const { container } = render(<TranscriptHarness messages={twoAnswers()} />)

    fireEvent.click(await screen.findByRole('button', { name: /Worked|已处理/ }))

    await waitFor(() => {
      expect(container.querySelector('[data-tool-summary]')).not.toBeNull()
    })
    expect(container.querySelectorAll('[data-role="assistant"]')).toHaveLength(2)
    expect(container.querySelector('[data-slot="aui_thinking-disclosure"]')).not.toBeNull()
  })
})

describe('a running turn', () => {
  it('shows the work while it works', async () => {
    const { container } = render(<Harness content={work()} status={{ type: 'running' } as ThreadMessage['status']} />)

    expect(foldRow(container)?.querySelector('button')?.getAttribute('aria-expanded')).toBe('true')

    await waitFor(() => {
      expect(container.querySelector('[data-tool-summary]')).not.toBeNull()
    })
  })
})
