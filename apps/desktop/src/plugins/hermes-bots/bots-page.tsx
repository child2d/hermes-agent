/** Route-entry lifecycle for Bot Mode. The roster lives in the standing list
 * column and the main area stays a conversation. Keep this signal scoped to
 * the route, not the roster mount: an open chat keeps the roster alive, but
 * must not latch Bot Mode on after the user switches to an ordinary session. */

import { useEffect } from 'react'

import { $botsPageActive } from './bot-state'


export function BotsPage() {
  useEffect(() => {
    $botsPageActive.set(true)

    return () => $botsPageActive.set(false)
  }, [])

  // The standing list pane owns the roster; core keeps the conversation in
  // the main area. Only the route-entry lifecycle belongs here.
  return null
}
