// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'

import { LIST_PANE_VIEWS } from '../chat/sidebar/list-panes'

import { sidebarRouteStep } from './sidebar-route-step'

// The three states the column can be in when a view change lands.
const open = { foldedByRoute: false, minimized: false }
const handFolded = { foldedByRoute: false, minimized: true }
const foldedByRoute = { foldedByRoute: true, minimized: true }

describe('the left column on a view change', () => {
  it('folds it away for a view that paints nothing in it, and remembers it did', () => {
    expect(sidebarRouteStep('capabilities', open)).toEqual({ action: 'fold', foldedByRoute: true })
  })

  it('claims the fold only when it did the folding', () => {
    // Already folded by hand: leave that fold alone — claiming it would reopen
    // the column the moment the user left for chat again.
    expect(sidebarRouteStep('capabilities', handFolded)).toEqual({ action: 'none', foldedByRoute: false })
  })

  it('shows it for every view that brings a list of its own — even one folded by hand', () => {
    for (const view of LIST_PANE_VIEWS) {
      expect(sidebarRouteStep(view, open)).toEqual({ action: 'reveal', foldedByRoute: false })
      expect(sidebarRouteStep(view, handFolded)).toEqual({ action: 'reveal', foldedByRoute: false })
    }

    // The set is derived from the route→list map; name the two that exist, so a
    // dropped entry fails here instead of silently hiding a tool's list.
    expect([...LIST_PANE_VIEWS].sort()).toEqual(['cron', 'messaging'])
  })

  it('leaves chat alone unless this wiring folded the column', () => {
    expect(sidebarRouteStep('chat', open)).toEqual({ action: 'none', foldedByRoute: false })
    expect(sidebarRouteStep('chat', handFolded)).toEqual({ action: 'none', foldedByRoute: false })
    expect(sidebarRouteStep('chat', foldedByRoute)).toEqual({ action: 'unfold', foldedByRoute: false })
  })

  it('reveals the column for a contributed route with its own list', () => {
    expect(sidebarRouteStep('extension', handFolded, true)).toEqual({ action: 'reveal', foldedByRoute: false })
  })

  it('folds for a plugin page, which paints nothing in the column either', () => {
    expect(sidebarRouteStep('extension', open)).toEqual({ action: 'fold', foldedByRoute: true })
  })
})
