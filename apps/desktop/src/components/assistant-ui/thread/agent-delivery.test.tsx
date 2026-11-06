import { type ToolCallMessagePartProps } from '@assistant-ui/react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { CHARACTER_AVATARS, characterAvatarSources } from '@/lib/character-avatars'

import { AgentDeliveryNotice, deliveryTargetFromCommand, replyTextFromResult } from './agent-delivery'
import { agentAvatarCache } from './user-message'

afterEach(() => { cleanup(); agentAvatarCache.delete('scout') })

it('uses size-aware persisted catalog art in outgoing delivery and reply notices', () => {
  const image = CHARACTER_AVATARS[0].image
  agentAvatarCache.set('scout', { at: Date.now(), url: image })

  const { container } = render(<AgentDeliveryNotice {...({
    args: { command: 'hermes -p scout chat -q "Message from Hermes: hello"' },
    result: { output: 'reply' }
  } as ToolCallMessagePartProps)} />)

  const images = [...container.querySelectorAll('img')]
  expect(images).toHaveLength(2)

  for (const img of images) {
    expect(img.getAttribute('src')).toBe(characterAvatarSources('scout', image, 16).src)
    expect(img.getAttribute('sizes')).toBe('16px')
  }
})

// Sender-side inter-agent deliveries render as "Messaged X" / "Message from
// X" notices instead of terminal transcript rows. This pins the detection
// (the canonical Bot Mode command shape) and the reply extraction.
describe('delivery command detection', () => {
  it('matches the canonical delivery command', () => {
    const cmd = 'hermes -p turqoise chat --in ~ -c "Bot Chat" -Q -q "Message from 🤖 Hermes (@hermes): hi there"'

    expect(deliveryTargetFromCommand(cmd)).toBe('turqoise')
  })

  it('matches with a cd prefix and timeout wrapper', () => {
    const cmd = 'cd ~ && timeout 240 hermes -p mr-tester chat --in "~" -Q -q "Message from 🤖 Hermes: hello"'

    expect(deliveryTargetFromCommand(cmd)).toBe('mr-tester')
  })

  it('ignores ordinary terminal commands', () => {
    expect(deliveryTargetFromCommand('ls -la')).toBeNull()
    expect(deliveryTargetFromCommand('hermes -p turqoise chat -q "plain question"')).toBeNull()
    expect(deliveryTargetFromCommand('hermes sessions list')).toBeNull()
  })
})

describe('reply extraction', () => {
  it('strips session_id bookkeeping and keeps the reply', () => {
    const output = 'session_id: 20260813_220347_f69ac6\nHi Hermes! Good to hear from you.'

    expect(replyTextFromResult({ output })).toBe('Hi Hermes! Good to hear from you.')
  })

  it('unwraps JSON-shaped terminal results', () => {
    const result = JSON.stringify({ exit_code: 0, output: 'session_id: abc\nack' })

    expect(replyTextFromResult(result)).toBe('ack')
  })

  it('returns empty for empty results', () => {
    expect(replyTextFromResult(undefined)).toBe('')
    expect(replyTextFromResult({ output: '' })).toBe('')
  })
})
