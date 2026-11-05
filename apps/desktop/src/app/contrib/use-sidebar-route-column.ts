import { useEffect } from 'react'
import { useLocation } from 'react-router'

import { findGroupOfPane } from '@/components/pane-shell/tree/model'
import { $layoutTree, setTreeGroupMinimized } from '@/components/pane-shell/tree/store'
import { useContributions } from '@/contrib/react/use-contributions'
import { revealPaneColumn } from '@/store/layout'

import { appViewForPath, contributedRoutes, ROUTES_AREA } from '../routes'

import { sidebarRouteStep } from './sidebar-route-step'

// Only undo folds made by navigation, not a user's explicit list collapse.
let foldedByRoute = false

/** Route lifecycle owns list reveal, independently of the mounted list content. */
export function useSidebarRouteColumn() {
  const { pathname } = useLocation()
  const routes = useContributions(ROUTES_AREA)
  const route = contributedRoutes(routes).find(item => item.path === pathname)
  const hasList = Boolean(route?.list)
  const view = route ? 'extension' : appViewForPath(pathname)
  useEffect(() => {
    const tree = $layoutTree.get()
    const group = tree ? findGroupOfPane(tree, 'sessions') : null

    if (!group) {
      return
    }

    const step = sidebarRouteStep(view, { foldedByRoute, minimized: group.minimized }, hasList)
    foldedByRoute = step.foldedByRoute

    if (step.action === 'fold') {
      setTreeGroupMinimized(group.id, true)
    } else if (step.action === 'reveal') {
      revealPaneColumn('sessions')
    } else if (step.action === 'unfold') {
      setTreeGroupMinimized(group.id, false)
    }
  }, [pathname, hasList, view])
}
