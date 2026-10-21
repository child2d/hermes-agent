import { describe, expect, it } from 'vitest'

import { allPaneIds, findGroupOfPane, type LayoutNode, migratePersistedTree, normalize } from './model'

function repair(tree: LayoutNode) {
  return normalize(migratePersistedTree(tree))!
}

describe('saved route-list columns', () => {
  it('consolidates repeated lists while preserving the original zone, siblings and relative widths', () => {
    const tree: LayoutNode = {
      type: 'split',
      id: 'root',
      orientation: 'row',
      weights: [4, 1, 1, 1, 1, 12],
      children: [
        {
          type: 'group',
          id: 'original',
          panes: ['sessions', 'sessions', 'bots'],
          active: 'bots',
          minimized: true,
          tabStrip: 'never'
        },
        { type: 'group', id: 'duplicate', panes: ['sessions'], active: 'sessions' },
        { type: 'group', id: 'channels', panes: ['channels'], active: 'channels' },
        { type: 'group', id: 'jobs', panes: ['cron-jobs'], active: 'cron-jobs' },
        { type: 'group', id: 'mixed', panes: ['sessions', 'terminal'], active: 'sessions' },
        { type: 'group', id: 'main', panes: ['workspace', 'session-tile:history'], active: 'session-tile:history' }
      ]
    }

    const migrated = repair(tree)
    expect(allPaneIds(migrated)).toEqual(['sessions', 'bots', 'terminal', 'workspace', 'session-tile:history'])
    expect(findGroupOfPane(migrated, 'sessions')).toEqual({ ...tree.children[0], panes: ['sessions', 'bots'] })
    expect(findGroupOfPane(migrated, 'terminal')?.active).toBe('terminal')
    expect(migrated.type === 'split' && migrated.weights).toEqual([4, 1, 12])
    expect(repair(migrated)).toEqual(migrated)
    expect(allPaneIds(tree)).toContain('channels')
  })

  it('recovers an alias-only saved list on reload without resetting the rest of the layout', () => {
    const tree: LayoutNode = {
      type: 'split',
      id: 'root',
      orientation: 'row',
      weights: [2, 7],
      children: [
        { type: 'group', id: 'list', panes: ['cron-jobs'], active: 'cron-jobs', minimized: true },
        { type: 'group', id: 'main', panes: ['workspace'], active: 'workspace' }
      ]
    }

    expect(repair(tree)).toEqual({
      ...tree,
      children: [{ ...tree.children[0], panes: ['sessions'], active: 'sessions' }, tree.children[1]]
    })
  })
})
