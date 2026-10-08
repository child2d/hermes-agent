/**
 * The 机器人 PAGE — Bot Mode's roster as a full workspace page.
 *
 * Bot Mode used to be a sidebar PANE docked into the sessions zone, which grew
 * a 会话 | 机器人 tab strip at the top of the sidebar and made the roster and the
 * conversation list two tabs of one column. The roster is a nav-row surface now
 * — a peer of Skills & Tools and Messaging (see plugin.tsx) — so the sidebar is
 * always Sessions and this page carries the roster at workspace width.
 *
 * Mounting it is what puts Bot Mode on screen: `$botsPageActive` is the edge
 * plugin.tsx seats the workspace owner and arms the Scheduled jobs tile from.
 * A contributed route renders only while the router is on it, so the mount IS
 * the truth about "the user is looking at the roster".
 */

import { useEffect } from 'react'

import { $botsPageActive } from './bot-state'
import { BotsPane } from './roster-pane'

export function BotsPage() {
  useEffect(() => {
    $botsPageActive.set(true)

    return () => $botsPageActive.set(false)
  }, [])

  return (
    // The same full-page shell kanban's board uses: the workspace pane's own
    // chrome stands down while a page route shows, so the page paints itself.
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden bg-(--ui-surface-background)">
      {/* The roster was born 260px wide. Give it a readable measure instead of
          stretching avatars and titles across the whole window. */}
      <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
        <BotsPane />
      </div>
    </div>
  )
}
