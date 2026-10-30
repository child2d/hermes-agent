// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it } from 'vitest'

import { ROUTES_AREA } from '@/app/routes'
import { $workspaceMode } from '@/components/pane-shell/workspace-scope'
import { registry } from '@/contrib/registry'

import { WorkspaceListPane } from './list-panes'

const disposers: (() => void)[] = []
afterEach(() => {
  cleanup()
  disposers.splice(0).forEach(dispose => dispose())
  $workspaceMode.set('sessions')
})

function registerList() {
  disposers.push(registry.register({
    id: 'test-bot-list',
    area: ROUTES_AREA,
    data: {
      path: '/bots',
      list: { render: () => <div>Robot roster</div>, workspaceMode: 'bots' }
    },
    render: () => null
  }))
}

function mount(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <WorkspaceListPane><div>Session roster</div></WorkspaceListPane>
    </MemoryRouter>
  )
}

describe('contributed tool lists in the standing list column', () => {
  it('places the robot roster in the list column instead of sessions', () => {
    registerList()
    const { container } = mount('/bots')
    expect(screen.getByText('Robot roster').closest('[data-slot="list-column"]')).not.toBeNull()
    expect(screen.queryByText('Session roster')).toBeNull()
    expect(container.querySelectorAll('[data-slot="list-column"]')).toHaveLength(1)
  })

  it('keeps the roster available while a bot conversation owns the chat', () => {
    registerList()
    $workspaceMode.set('bots')
    mount('/canonical-chat')
    expect(screen.getByText('Robot roster')).toBeTruthy()
    expect(screen.queryByText('Session roster')).toBeNull()
  })

  it('returns to sessions outside the bot workspace and does not leak onto other tools', () => {
    registerList()
    mount('/ordinary-session')
    expect(screen.getByText('Session roster')).toBeTruthy()
    expect(screen.queryByText('Robot roster')).toBeNull()
  })
})
